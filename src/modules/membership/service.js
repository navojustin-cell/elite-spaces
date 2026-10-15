'use strict';
// Membership rules shared by the routes and the daily job (MB-1, MB-4, MB-5, D-16).
//
// A membership is "valid" while its status is active and the location-local
// date is from start_date through expires_on (the last valid day, inclusive;
// D-32: before its start date it is not active yet). When it stops
// being valid the student's active enrollments are paused, never deleted. When
// it becomes valid again each paused enrollment comes back if its slot still
// has a free seat; otherwise it is marked dropped and the student goes to the
// front of that slot's waitlist (priority 1).

const { DateTime } = require('luxon');
const { tx } = require('../../db');
const time = require('../../time');
const notify = require('../../notify');

const SOON_DAYS = 14;  // "ending soon" on screens, and the first reminder (MB-4)
const LAST_CALL = 3;   // the second reminder
const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const firstName = name => String(name || '').split(' ')[0];
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const isoDay = d => DateTime.fromISO(d, { zone: 'utc' });
const daysUntil = (today, date) => Math.round(isoDay(date).diff(isoDay(today), 'days').days);
const fmtDate = d => isoDay(d).setLocale('en-US').toFormat('ccc, LLL d, yyyy');
const fmtClock = hhmm => { const [h, m] = hhmm.split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };
const slotLabel = e => `${e.name} (${WEEKDAYS[e.weekday]} ${fmtClock(e.start_time)})`;

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

// Weekly slots held and paused in current and upcoming terms (`today` is location-local).
function slotCounts(ctx, studentId, today) {
  const r = ctx.db.prepare(`SELECT SUM(e.status = 'active') AS active, SUM(e.status = 'paused') AS paused
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND t.end_date >= ?`).get(studentId, today);
  return { active_slots: Number(r.active || 0), paused_slots: Number(r.paused || 0) };
}

// Weekly slots the student holds against the cap, counted the way enrollment
// counts them (D-3, EN-4): active enrollments in active sessions of the current
// and every upcoming term, as of the location-local `today`.
function heldSlots(ctx, studentId, today) {
  return Number(ctx.db.prepare(`SELECT COUNT(*) AS n FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status = 'active' AND s.status = 'active' AND t.end_date >= ?`).get(studentId, today).n);
}

// MB-5: active enrollments in current and upcoming terms become paused (`today`
// is location-local). A slot whose term has ended has no weeks left to pause, so
// it is left alone and never counted in the family's notice. Waitlist entries are left alone.
function pause(ctx, studentId, today) {
  return Number(ctx.db.prepare(`UPDATE enrollments SET status = 'paused' WHERE student_id = ? AND status = 'active'
    AND session_id IN (SELECT s.id FROM sessions s JOIN terms t ON t.id = s.term_id WHERE t.end_date >= ?)`).run(studentId, today).changes);
}

// MB-5 / D-16: bring paused enrollments back, or put the student first in line.
// The weekly cap still holds (D-3, EN-4): slots are counted the way enrollment
// counts them (active enrollments in active sessions of the current and every
// upcoming term, as of the location-local `today`), and a slot that would go
// over the saved membership's cap stays paused and saved (kept). Slots whose
// term has ended are left as they are.
function restore(ctx, m, today, actorId) {
  const db = ctx.db, now = ctx.clock.now(), studentId = m.student_id;
  const rows = db.prepare(`SELECT e.id, e.session_id, e.weekday, s.name, s.start_time, s.capacity
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status = 'paused' AND t.end_date >= ? ORDER BY e.id`).all(studentId, today);
  const used = db.prepare(`SELECT COUNT(*) AS n FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status = 'active' AND s.status = 'active' AND t.end_date >= ?`);
  const back = [], waitlisted = [], kept = [];
  for (const e of rows) {
    if (used.get(studentId, today).n >= m.weekly_cap) {
      kept.push(e);
      continue;
    }
    const taken = db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND weekday = ? AND status = 'active'")
      .get(e.session_id, e.weekday).n;
    if (taken < e.capacity) {
      db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(e.id);
      back.push(e);
      continue;
    }
    db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(now, e.id);
    const waiting = db.prepare("SELECT id FROM waitlist WHERE student_id = ? AND session_id = ? AND weekday = ? AND status = 'waiting'")
      .get(studentId, e.session_id, e.weekday);
    if (waiting) db.prepare('UPDATE waitlist SET priority = 1 WHERE id = ?').run(waiting.id);
    else db.prepare("INSERT INTO waitlist (student_id, session_id, weekday, status, priority, created_by, created_at) VALUES (?,?,?,'waiting',1,?,?)")
      .run(studentId, e.session_id, e.weekday, actorId ?? null, now);
    waitlisted.push(e);
  }
  return { back, waitlisted, kept };
}

// Parents and the student themselves.
const familyOf = (ctx, studentId) => [...notify.parentsOf(ctx, studentId), studentId];

function notifyPaused(ctx, student, m, count, today) {
  const first = firstName(student.name);
  const held = plural(count, 'weekly session is', 'weekly sessions are');
  notify.send(ctx, familyOf(ctx, student.id), {
    kind: 'membership_paused', refType: 'membership', refId: m.id,
    title: `${first}'s weekly sessions are paused`,
    // D-32: a membership that starts later holds its sessions until that day, and the family hears again when they come back.
    body: notStarted(m, today)
      ? `${first}'s membership starts ${fmtDate(m.start_date)}, so ${held} on hold until then. ` +
        "They are saved, and you'll get a notification on that day when they come back."
      : `${first}'s membership isn't active right now, so ${held} on hold. ` +
        'They are saved and come back when the membership is renewed with the front desk.',
  });
}

function notifyRestored(ctx, student, m, { back, waitlisted, kept }) {
  if (!back.length && !waitlisted.length) return;
  const first = firstName(student.name);
  const parts = [];
  if (back.length) parts.push(`Back on the schedule: ${back.map(slotLabel).join(', ')}.`);
  if (waitlisted.length) parts.push(`Full right now, so ${first} is first on the waitlist for: ${waitlisted.map(slotLabel).join(', ')}.`);
  if (kept.length) {
    parts.push(`Still paused, because ${first}'s membership allows ${plural(m.weekly_cap, 'weekly session', 'weekly sessions')}: ` +
      `${kept.map(slotLabel).join(', ')}. ${kept.length === 1 ? 'It stays' : 'They stay'} saved, and the front desk can bring ` +
      `${kept.length === 1 ? 'it' : 'them'} back if the weekly limit goes up.`);
  }
  notify.send(ctx, familyOf(ctx, student.id), {
    kind: 'membership_restored', refType: 'membership', refId: m.id,
    title: waitlisted.length ? `${first}'s membership is active again` : `${first}'s sessions are back on`,
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
          body: `It ended on ${fmtDate(m.expires_on)}. ` + (paused
            ? `${plural(paused, 'weekly session is', 'weekly sessions are')} paused and saved until it's renewed with the front desk at ${m.loc_name}.`
            : `Renew with the front desk at ${m.loc_name} to enroll in sessions again.`),
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
      body: `That's ${when}. Renew with the front desk at ${m.loc_name} to keep ${first}'s weekly sessions.`,
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
// sessions paused until then come back up to the weekly cap (a full slot puts
// the student first on its waitlist), and the family is told then. Once only:
// the mark is taken in the same transaction.
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
  SOON_DAYS, describe, isValid, slotCounts, heldSlots, pause, restore, notifyPaused, notifyRestored, runExpiry,
  markStart, runStarts, studentLocation, todayAt,
};
