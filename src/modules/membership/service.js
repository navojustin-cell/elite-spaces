'use strict';
// Membership rules shared by the routes and the daily job (MB-1, MB-4, MB-5, D-16, D-16a).
//
// A membership is "valid" while its status is active and the location-local
// date is from start_date through expires_on (the last valid day, inclusive;
// D-32: before its start date it is not active yet). When it stops being valid
// the student's held schedules (whole enrollments, any `weekday`) are paused,
// never deleted. When it becomes valid again each paused schedule comes back if
// its days a week fit the weekly cap (D-43, D-16a) and it has a free seat; a
// schedule over the cap stays paused and saved (kept), and one whose seat was
// taken is marked dropped and the student goes to the front of its waitlist
// (priority 1). Days a week come from sessions/dates.js (D-26 (6)).

const { DateTime } = require('luxon');
const { tx } = require('../../db');
const time = require('../../time');
const notify = require('../../notify');
const dates = require('../sessions/dates');

const SOON_DAYS = 14;  // "ending soon" on screens, and the first reminder (MB-4)
const LAST_CALL = 3;   // the second reminder

const firstName = name => String(name || '').split(' ')[0];
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const perWeek = n => plural(n, 'day', 'days') + ' a week';
// "A", "A and B", "A, B and C": the schedules named in a notice.
const listOf = xs => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
const names = xs => listOf(xs.map(x => x.name));
const isoDay = d => DateTime.fromISO(d, { zone: 'utc' });
const daysUntil = (today, date) => Math.round(isoDay(date).diff(isoDay(today), 'days').days);
const fmtDate = d => isoDay(d).setLocale('en-US').toFormat('ccc, LLL d, yyyy');

// The student's home location, for "today" in that location's zone.
function studentLocation(ctx, studentId) {
  return ctx.db.prepare('SELECT l.id, l.name, l.timezone FROM locations l JOIN users u ON u.location_id = l.id WHERE u.id = ?').get(studentId);
}
const todayAt = (ctx, loc) => time.localDate(loc, ctx.clock.now());

// What families and staff see: the record plus its state on `today`.
// state: active | upcoming (before start_date, R6) | ending (within 14 days) | expired | inactive.
function describe(m, today) {
  if (!m) return null;
  const days_left = daysUntil(today, m.expires_on);
  const state = m.status !== 'active' ? 'inactive' : today < m.start_date ? 'upcoming'
    : days_left < 0 ? 'expired' : days_left <= SOON_DAYS ? 'ending' : 'active';
  return {
    id: m.id, status: m.status, weekly_cap: m.weekly_cap, start_date: m.start_date, expires_on: m.expires_on,
    days_left, state, renewal_needed: state !== 'active' && state !== 'upcoming',
  };
}

const isValid = (m, today) => !!m && m.status === 'active' && m.start_date <= today && today <= m.expires_on;
// D-32: active and saved, but its start date is still ahead.
const notStarted = (m, today) => !!m && m.status === 'active' && today < m.start_date;

// The schedules the student holds (active) or has paused in current and upcoming
// periods (`today` is location-local): one entry per schedule, oldest period first.
function schedules(ctx, studentId, today) {
  return ctx.db.prepare(`SELECT e.session_id, e.status, s.name, s.weekdays, s.start_time, s.end_time, t.name AS term_name
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status IN ('active', 'paused') AND t.end_date >= ?
    GROUP BY e.session_id, e.status ORDER BY t.start_date, s.name, e.session_id`).all(studentId, today)
    .map(r => Object.assign(r, { days_per_week: dates.daysPerWeek(r) }));
}

// The held schedule with the most days a week, counted the way enrollment counts
// the cap (D-43, D-27): an active whole-schedule enrollment (weekday 0) in an
// active schedule of a current or upcoming period, as of the location-local `today`.
// Returns { days, name }, or { days: 0, name: null } when nothing is held.
function heldDays(ctx, studentId, today) {
  let top = { days: 0, name: null };
  for (const s of ctx.db.prepare(`SELECT s.name, s.weekdays FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.weekday = 0 AND e.status = 'active' AND s.status = 'active' AND t.end_date >= ? ORDER BY t.start_date, e.id`)
    .all(studentId, today)) {
    const days = dates.daysPerWeek(s);
    if (days > top.days) top = { days, name: s.name };
  }
  return top;
}

// What every membership screen shows beside the record: schedules held and paused,
// the most days a week of any held schedule, and the schedules themselves.
function scheduleCounts(ctx, studentId, today) {
  const list = schedules(ctx, studentId, today);
  return {
    active_schedules: list.filter(s => s.status === 'active').length,
    paused_schedules: list.filter(s => s.status === 'paused').length,
    held_days: heldDays(ctx, studentId, today).days,
    schedules: list,
  };
}

// MB-5: active enrollments (any weekday) in current and upcoming periods become
// paused (`today` is location-local). A schedule whose period has ended has no
// dates left to pause, so it is left alone and never named in the family's notice.
// Waitlist entries are left alone. Returns the schedules paused, one entry each.
function pause(ctx, studentId, today) {
  const rows = ctx.db.prepare(`SELECT e.id, e.session_id, s.name FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status = 'active' AND t.end_date >= ? ORDER BY t.start_date, e.id`).all(studentId, today);
  const out = [];
  for (const e of rows) {
    ctx.db.prepare("UPDATE enrollments SET status = 'paused' WHERE id = ?").run(e.id);
    if (!out.some(x => x.session_id === e.session_id)) out.push(e);
  }
  return out;
}

// MB-5 / D-16 / D-16a: bring paused schedules back, or put the student first in line.
// The weekly cap holds (D-43): a schedule that meets more days a week than the
// saved membership's cap stays paused and saved (kept). Seats count whole-schedule
// enrollments (weekday 0). Schedules whose period has ended are left as they are.
function restore(ctx, m, today, actorId) {
  const db = ctx.db, now = ctx.clock.now(), studentId = m.student_id;
  const rows = db.prepare(`SELECT e.id, e.session_id, e.weekday, s.name, s.weekdays, s.capacity
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status = 'paused' AND t.end_date >= ? ORDER BY t.start_date, e.id`).all(studentId, today);
  const back = [], waitlisted = [], kept = [];
  for (const e of rows) {
    e.days = dates.daysPerWeek(e);
    if (e.days > m.weekly_cap) {
      kept.push(e);
      continue;
    }
    const taken = db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND weekday = 0 AND status = 'active'").get(e.session_id).n;
    if (taken < e.capacity) {
      db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(e.id);
      back.push(e);
      continue;
    }
    db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(now, e.id);
    const waiting = db.prepare("SELECT id FROM waitlist WHERE student_id = ? AND session_id = ? AND weekday = 0 AND status = 'waiting'")
      .get(studentId, e.session_id);
    if (waiting) db.prepare('UPDATE waitlist SET priority = 1 WHERE id = ?').run(waiting.id);
    else db.prepare("INSERT INTO waitlist (student_id, session_id, weekday, status, priority, created_by, created_at) VALUES (?,?,0,'waiting',1,?,?)")
      .run(studentId, e.session_id, actorId ?? null, now);
    waitlisted.push(e);
  }
  return { back, waitlisted, kept };
}

// Parents and the student themselves.
const familyOf = (ctx, studentId) => [...notify.parentsOf(ctx, studentId), studentId];

// `paused` is the list pause() returned.
function notifyPaused(ctx, student, m, paused, today) {
  const first = firstName(student.name), one = paused.length === 1;
  const held = names(paused) + (one ? ' is' : ' are');
  notify.send(ctx, familyOf(ctx, student.id), {
    kind: 'membership_paused', refType: 'membership', refId: m.id,
    title: `${first}'s ${one ? 'schedule is' : 'schedules are'} paused`,
    // D-32: a membership that starts later holds its schedule until that day, and the family hears again when it comes back.
    body: notStarted(m, today)
      ? `${first}'s membership starts ${fmtDate(m.start_date)}, so ${held} on hold until then. ` +
        `${one ? 'It is' : 'They are'} saved, and you'll get a notification on that day when ${one ? 'it comes' : 'they come'} back.`
      : `${first}'s membership isn't active right now, so ${held} on hold. ` +
        `${one ? 'It is' : 'They are'} saved and ${one ? 'comes' : 'come'} back when the membership is renewed with the front desk.`,
  });
}

function notifyRestored(ctx, student, m, { back, waitlisted, kept }) {
  if (!back.length && !waitlisted.length) return;
  const first = firstName(student.name);
  const parts = [];
  if (back.length) parts.push(`Back on: ${names(back)}.`);
  if (waitlisted.length) parts.push(`Full right now, so ${first} is first on the waitlist for: ${names(waitlisted)}.`);
  if (kept.length === 1) {
    parts.push(`Still paused, because ${kept[0].name} meets ${perWeek(kept[0].days)} and ${first}'s membership allows ${m.weekly_cap}. ` +
      'It stays saved, and the front desk can bring it back if the weekly limit goes up.');
  } else if (kept.length) {
    parts.push(`Still paused, because ${first}'s membership allows ${perWeek(m.weekly_cap)}: ` +
      `${listOf(kept.map(e => `${e.name} (${perWeek(e.days)})`))}. They stay saved, and the front desk can bring them back if the weekly limit goes up.`);
  }
  notify.send(ctx, familyOf(ctx, student.id), {
    kind: 'membership_restored', refType: 'membership', refId: m.id,
    title: waitlisted.length ? `${first}'s membership is active again` : `${first}'s ${back.length === 1 ? 'schedule is' : 'schedules are'} back on`,
    body: parts.join(' '),
  });
}

// One row per notice per expiry date, so reruns never send twice (MB-4).
function claim(ctx, m, kind) {
  return Number(ctx.db.prepare('INSERT OR IGNORE INTO membership_notices (student_id, expires_on, kind, sent_at) VALUES (?,?,?,?)')
    .run(m.student_id, m.expires_on, kind, ctx.clock.now()).changes) === 1;
}

// Daily job: reminders 14 and 3 days ahead (parents), and expiry (MB-4, MB-5).
function runExpiry(ctx) {
  const rows = ctx.db.prepare(`SELECT m.*, u.name AS student_name, l.name AS loc_name, l.timezone
    FROM memberships m JOIN users u ON u.id = m.student_id JOIN locations l ON l.id = u.location_id
    WHERE m.status = 'active' ORDER BY m.id`).all();
  for (const m of rows) {
    const today = todayAt(ctx, { timezone: m.timezone });
    const days = daysUntil(today, m.expires_on);
    const first = firstName(m.student_name);
    if (days < 0) {
      tx(ctx.db, () => {
        const paused = pause(ctx, m.student_id, today);
        if (!claim(ctx, m, 'expired')) return;
        notify.send(ctx, familyOf(ctx, m.student_id), {
          kind: 'membership_expired', refType: 'membership', refId: m.id,
          title: `${first}'s membership has ended`,
          body: `It ended on ${fmtDate(m.expires_on)}. ` + (paused.length
            ? `${names(paused)} ${paused.length === 1 ? 'is' : 'are'} paused and saved until it's renewed with the front desk at ${m.loc_name}.`
            : `Renew with the front desk at ${m.loc_name} to enroll in a schedule again.`),
        });
      });
      continue;
    }
    const kind = days <= LAST_CALL ? 'remind3' : days <= SOON_DAYS ? 'remind14' : null;
    if (!kind || !claim(ctx, m, kind)) continue;
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    notify.send(ctx, notify.parentsOf(ctx, m.student_id), {
      kind: 'membership_reminder', refType: 'membership', refId: m.id,
      title: `${first}'s membership ends ${fmtDate(m.expires_on)}`,
      body: `That's ${when}. Renew with the front desk at ${m.loc_name} to keep ${first}'s schedule.`,
    });
  }
}

// D-32: a save that leaves the membership not started yet marks its start date
// for the daily job; any other save clears it, having paused or restored already.
function markStart(ctx, m, today) {
  if (notStarted(m, today)) {
    ctx.db.prepare(`INSERT INTO membership_starts (student_id, start_date, set_at) VALUES (?,?,?)
      ON CONFLICT(student_id) DO UPDATE SET start_date = excluded.start_date, set_at = excluded.set_at`).run(m.student_id, m.start_date, ctx.clock.now());
  } else {
    ctx.db.prepare('DELETE FROM membership_starts WHERE student_id = ?').run(m.student_id);
  }
}

// Daily job (D-32, D-16a): on the start date, by the location's date, the
// schedules paused until then come back if their days fit the weekly cap (a full
// one puts the student first on its waitlist), and the family is told then. Once
// only: the mark is taken in the same transaction.
function runStarts(ctx) {
  const rows = ctx.db.prepare(`SELECT m.*, u.name AS student_name, l.timezone
    FROM membership_starts ms JOIN memberships m ON m.student_id = ms.student_id
    JOIN users u ON u.id = m.student_id JOIN locations l ON l.id = u.location_id ORDER BY m.id`).all();
  for (const m of rows) {
    const today = todayAt(ctx, { timezone: m.timezone });
    if (!isValid(m, today)) continue;
    tx(ctx.db, () => {
      if (!Number(ctx.db.prepare('DELETE FROM membership_starts WHERE student_id = ?').run(m.student_id).changes)) return;
      notifyRestored(ctx, { id: m.student_id, name: m.student_name }, m, restore(ctx, m, today, null));
    });
  }
}

module.exports = {
  SOON_DAYS, describe, isValid, scheduleCounts, heldDays, pause, restore, notifyPaused, notifyRestored, claim, runExpiry,
  markStart, runStarts, studentLocation, todayAt,
};
