'use strict';
// Enrollment rules (PRD 3, v1.1 fixed schedules: D-41..D-44, D-47, D-48):
//   a parent picks one whole schedule for a student (weekday = 0, D-42)
//   -> the membership is checked against the schedule's first meeting date on or
//      after today, and its days a week against the weekly cap (D-43) -> fail = blocked
//   -> seat open? yes = enrolled (every meeting date of its period, family notified);
//      full = offer the waitlist (D-44).
// A student holds one schedule per period: enrolling in (or being promoted into)
// a schedule whose term overlaps one held is a switch (D-43). The old enrollment
// ends, its seat goes to its waitlist in the same transaction (which can cascade),
// and the family gets one notice. Students no longer request schedules (D-48).
// Every write runs synchronously inside one transaction (src/db.js tx), so two
// families racing for the last seat cannot both pass the seat check (NF-3).
// Meeting dates come only from sessions/dates.js (D-47, D-26 (6)).

const { DateTime } = require('luxon');
const { tx } = require('../../db');
const time = require('../../time');
const auth = require('../../auth');
const notify = require('../../notify');
const sessionTimes = require('../sessions/times');
const dates = require('../sessions/dates');
const { bad, forbidden, notFound, conflict } = require('../../errors');

const DAY3 = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const firstName = u => String(u.name).split(' ')[0];
const shortDate = d => DateTime.fromISO(d).toFormat('LLL d');
const longDate = d => DateTime.fromISO(d).toFormat('LLL d, yyyy');
const daysText = s => String(s.weekdays).split(',').map(Number).sort((a, b) => a - b).map(n => DAY3[n]).join(', ');
const clock = t => { const [h, m] = t.split(':').map(Number); return { t: ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0'), ap: h < 12 ? 'AM' : 'PM' }; };
function timeRange(s) {
  const a = clock(s.start_time), b = clock(s.end_time);
  return a.ap === b.ap ? `${a.t}-${b.t} ${b.ap}` : `${a.t} ${a.ap}-${b.t} ${b.ap}`;
}
const LINE_ORDER = 'ORDER BY priority DESC, created_at, id'; // D-44: first come, first served; renewals at the front

const getLocation = (ctx, id) => ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);
const today = (ctx, loc) => time.localDate(loc, ctx.clock.now());

function getStudent(ctx, id) {
  const s = ctx.db.prepare('SELECT id, role, name, location_id, active FROM users WHERE id = ?').get(Number(id));
  if (!s || s.role !== 'student') throw notFound('No such student.');
  return s;
}

// Only an active linked parent acts for a student (EN-2, EN-6, NF-1).
function assertParentOf(ctx, user, studentId) {
  if (!auth.linkedStudentIds(ctx, user.id).includes(Number(studentId))) throw forbidden();
}

// ---------- schedules, their dates, seats and the line ----------

const SCHEDULE = `SELECT s.*, t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end
  FROM sessions s JOIN terms t ON t.id = s.term_id`;
const scheduleRow = (ctx, id) => ctx.db.prepare(`${SCHEDULE} WHERE s.id = ?`).get(Number(id));

// A schedule's meeting dates for its whole term (D-47), with the location's closures removed.
function meetingDates(ctx, s, ov) {
  const closed = new Set(ctx.db.prepare('SELECT date FROM closures WHERE location_id = ? AND date BETWEEN ? AND ?')
    .all(s.location_id, s.term_start, s.term_end).map(c => c.date));
  return dates.datesOf(s, ov || dates.overrides(ctx, [s.id]), s.term_start, s.term_end).filter(d => !closed.has(d));
}

// F (D-43): the schedule's first meeting date on or after `from`, or null when none is left.
const firstDate = (ctx, s, from) => meetingDates(ctx, s).find(d => d >= from) || null;

// Loads a schedule for this student and refuses ones they cannot take: another
// location (D-1), a cancelled schedule, or one with no meeting date left.
function loadSchedule(ctx, student, sessionId) {
  const s = scheduleRow(ctx, sessionId);
  if (!s) throw notFound('That schedule no longer exists.');
  if (s.location_id !== student.location_id) {
    throw conflict('not_home_location', `${firstName(student)} can only enroll in schedules at their home location.`);
  }
  if (s.status !== 'active') throw conflict('session_cancelled', `The center cancelled ${s.name}.`);
  const loc = getLocation(ctx, s.location_id);
  const d = today(ctx, loc);
  const F = firstDate(ctx, s, d);
  if (!F) throw conflict('no_dates_left', `${s.name} has no dates left in ${s.term_name}.`);
  return { s, loc, F, d };
}

// Seats are whole-schedule rows only (D-42): a live v1 row counts for nothing.
const seatsTaken = (ctx, sessionId) => ctx.db.prepare(
  "SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND weekday = 0 AND status = 'active'").get(sessionId).n;

const liveEnrollment = (ctx, studentId, sessionId) => ctx.db.prepare(
  "SELECT * FROM enrollments WHERE student_id = ? AND session_id = ? AND weekday = 0 AND status IN ('active','paused')").get(studentId, sessionId);

const waitingRow = (ctx, studentId, sessionId) => ctx.db.prepare(
  "SELECT * FROM waitlist WHERE student_id = ? AND session_id = ? AND weekday = 0 AND status = 'waiting'").get(studentId, sessionId);

const line = (ctx, sessionId) => ctx.db.prepare(
  `SELECT * FROM waitlist WHERE session_id = ? AND weekday = 0 AND status = 'waiting' ${LINE_ORDER}`).all(sessionId);

const position = (ctx, w) => line(ctx, w.session_id).findIndex(x => x.id === w.id) + 1;

// D-43: the student's live schedules whose term overlaps `s`'s (a.start <= b.end AND b.start <= a.end).
const overlapping = (ctx, studentId, s) => ctx.db.prepare(`SELECT e.*, s.name FROM enrollments e
    JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
  WHERE e.student_id = ? AND e.weekday = 0 AND e.status IN ('active','paused') AND e.session_id <> ?
    AND t.start_date <= ? AND ? <= t.end_date ORDER BY e.id`).all(studentId, s.id, s.term_end, s.term_start);

// D-44: the student's other waiting spots in periods that overlap `s`'s.
const otherWaits = (ctx, studentId, s) => ctx.db.prepare(`SELECT w.id, s.name FROM waitlist w
    JOIN sessions s ON s.id = w.session_id JOIN terms t ON t.id = s.term_id
  WHERE w.student_id = ? AND w.status = 'waiting' AND w.session_id <> ?
    AND t.start_date <= ? AND ? <= t.end_date ORDER BY w.id`).all(studentId, s.id, s.term_end, s.term_start);

// ---------- the membership check (EN-4, D-43) ----------

const membershipOf = (ctx, studentId) => ctx.db.prepare('SELECT status, weekly_cap, start_date, expires_on FROM memberships WHERE student_id = ?').get(studentId);

// The part of the check that is the same for every schedule: on file, active, not already past.
function membershipBlock(student, m, d) {
  const name = firstName(student);
  if (!m) return { code: 'no_membership', message: `${name} has no membership yet. Ask the front desk.` };
  if (m.status !== 'active') return { code: 'membership_inactive', message: `${name}'s membership isn't active. Ask the front desk.` };
  if (m.expires_on < d) return { code: 'membership_expired', message: `${name}'s membership ended ${shortDate(m.expires_on)}. Renew it first.` };
  return null;
}

// D-43: the membership must be valid on F, the schedule's first meeting date on or
// after today (`d`), and the schedule's days a week must fit the weekly cap.
function scheduleBlock(ctx, student, s, F, d) {
  const m = membershipOf(ctx, student.id);
  const b = membershipBlock(student, m, d);
  if (b) return b;
  const name = firstName(student);
  if (m.start_date > F) {
    return { code: 'membership_not_started', message: `${name}'s membership starts ${shortDate(m.start_date)}, after this schedule's next date (${shortDate(F)}). Choose a schedule that starts on or after ${shortDate(m.start_date)}.` };
  }
  if (m.expires_on < F) return { code: 'membership_ends_first', message: `${name}'s membership ends ${shortDate(m.expires_on)}, before ${s.name} starts (${shortDate(F)}). Renew it first.` };
  const n = dates.daysPerWeek(s);
  if (n > m.weekly_cap) return { code: 'weekly_cap', message: `${s.name} meets ${n} day${n === 1 ? '' : 's'} a week. ${name}'s membership allows ${m.weekly_cap}.` };
  return null;
}

// ---------- taking a seat ----------

const family = (ctx, studentId) => notify.parentsOf(ctx, studentId).concat(studentId);

// Seats the student in `s`. A switch (D-43) ends every overlapping live schedule
// they hold; taking the seat settles their spot in this line and removes their
// other waiting spots in overlapping periods (D-44). The seats the switch freed
// go to those schedules' lines now, in the same transaction (the cascade ends
// because every promotion uses up a waiting row).
function seat(ctx, student, s, source, actor) {
  const now = ctx.clock.now();
  const ended = overlapping(ctx, student.id, s);
  for (const e of ended) ctx.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(now, e.id);
  const paused = liveEnrollment(ctx, student.id, s.id);
  let id;
  if (paused) { // a paused schedule (D-16) comes back instead of a second row
    ctx.db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(paused.id);
    id = paused.id;
  } else {
    id = Number(ctx.db.prepare('INSERT INTO enrollments (student_id, session_id, weekday, status, source, created_by, created_at) VALUES (?,?,0,?,?,?,?)')
      .run(student.id, s.id, 'active', source, actor ? actor.id : null, now).lastInsertRowid);
  }
  ctx.db.prepare("UPDATE waitlist SET status = 'enrolled', resolved_at = ? WHERE student_id = ? AND session_id = ? AND status = 'waiting'")
    .run(now, student.id, s.id);
  const left = otherWaits(ctx, student.id, s);
  for (const w of left) ctx.db.prepare("UPDATE waitlist SET status = 'removed', resolved_at = ? WHERE id = ?").run(now, w.id);
  const out = {
    enrollment: ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id),
    switched_from: ended.length ? { id: ended[0].id, name: ended[0].name } : null,
    waitlists_left: left.map(w => w.name),
  };
  for (const e of ended) promoteSchedule(ctx, e.session_id);
  return out;
}

// The tail both notices share: what ended and which waiting spots were left.
function changeText(student, out) {
  const name = firstName(student);
  return (out.switched_from ? ` ${out.switched_from.name} has ended for ${name}.` : '') +
    (out.waitlists_left.length ? ` ${name} left the waitlist for ${out.waitlists_left.join(', ')}.` : '');
}

function notifyEnrolled(ctx, student, s, loc, F, out) {
  notify.send(ctx, family(ctx, student.id), {
    kind: 'enrollment_confirmed',
    title: `${firstName(student)} is enrolled in ${s.name} at ${loc.name}`,
    body: `${daysText(s)} ${timeRange(s)}, ${shortDate(F)} - ${shortDate(s.term_end)}.` + changeText(student, out),
    refType: 'enrollment', refId: out.enrollment.id,
  });
}

// EN-5 / D-44: fill free seats from the line, earliest eligible first. Anyone
// ahead who fails a check is skipped but keeps their place. Runs on every drop,
// every switch, and as a scheduled job over every schedule with a line. The line
// is read again before each seat, since a cascade may have changed it.
function promoteSchedule(ctx, sessionId) {
  const s = scheduleRow(ctx, sessionId);
  if (!s || s.status !== 'active') return [];
  const loc = getLocation(ctx, s.location_id);
  const d = today(ctx, loc);
  const F = firstDate(ctx, s, d);
  if (!F) return [];
  const promoted = [], skipped = new Set();
  for (;;) {
    if (seatsTaken(ctx, s.id) >= s.capacity) break;
    const w = line(ctx, s.id).find(x => !skipped.has(x.id));
    if (!w) break;
    const student = ctx.db.prepare('SELECT id, role, name, location_id, active FROM users WHERE id = ?').get(w.student_id);
    if (!student.active || student.location_id !== s.location_id || scheduleBlock(ctx, student, s, F, d)) { skipped.add(w.id); continue; }
    const out = seat(ctx, student, s, 'waitlist', null);
    const name = firstName(student);
    notify.send(ctx, family(ctx, student.id), {
      kind: 'waitlist_promoted',
      title: out.switched_from ? `A seat opened: ${name} moved to ${s.name}` : `A seat opened: ${name} is now enrolled in ${s.name}`,
      body: `${daysText(s)} ${timeRange(s)} through ${shortDate(s.term_end)}.` + changeText(student, out),
      refType: 'enrollment', refId: out.enrollment.id,
    });
    promoted.push(Object.assign({ student_id: student.id }, out));
  }
  return promoted;
}

function promoteAll(ctx) {
  const ids = ctx.db.prepare("SELECT DISTINCT session_id FROM waitlist WHERE weekday = 0 AND status = 'waiting'").all();
  let n = 0;
  for (const r of ids) n += tx(ctx.db, () => promoteSchedule(ctx, r.session_id)).length;
  return n;
}

// Why a schedule is paused (MB-5). With the membership lapsed it waits for a
// renewal; with the membership valid it was kept paused at renewal because its
// days don't fit the weekly limit (D-16a), and comes back if the limit goes up.
function pausedMessage(ctx, student, s, d) {
  const m = membershipOf(ctx, student.id);
  if (m && m.status === 'active' && m.start_date > d) { // R6: not started yet, so not over any limit
    return `${firstName(student)}'s place in ${s.name} is paused because the membership doesn't start until ${longDate(m.start_date)}.`;
  }
  const valid = !!m && m.status === 'active' && m.expires_on >= d;
  return valid
    ? `${firstName(student)}'s place in ${s.name} is paused because its days don't fit the membership's weekly limit. It stays saved, and the front desk can bring it back if the limit goes up.`
    : `${firstName(student)}'s place in ${s.name} is paused until the membership is renewed.`;
}

function alreadyEnrolled(ctx, student, s, live, d) {
  return conflict('already_enrolled', live.status === 'paused' ? pausedMessage(ctx, student, s, d)
    : `${firstName(student)} is already enrolled in ${s.name}.`);
}

const enrolled = out => ({ outcome: 'enrolled', enrollment: out.enrollment, switched_from: out.switched_from, waitlists_left: out.waitlists_left });

// ---------- parent actions ----------

// EN-1 / EN-2 / EN-8: a parent enrolls a linked student in one whole schedule.
function enroll(ctx, actor, body) {
  assertParentOf(ctx, actor, body.studentId);
  const student = getStudent(ctx, body.studentId);
  return tx(ctx.db, () => {
    const { s, loc, F, d } = loadSchedule(ctx, student, body.sessionId);
    const live = liveEnrollment(ctx, student.id, s.id);
    if (live) throw alreadyEnrolled(ctx, student, s, live, d);
    const block = scheduleBlock(ctx, student, s, F, d);
    if (block) return { outcome: 'blocked', code: block.code, message: block.message };
    // The line is served before anyone new; the student may have been in it.
    const served = promoteSchedule(ctx, s.id).find(p => p.student_id === student.id);
    if (served) return enrolled(served);
    if (seatsTaken(ctx, s.id) >= s.capacity) {
      const w = waitingRow(ctx, student.id, s.id);
      return {
        outcome: 'full', code: 'full', waiting: line(ctx, s.id).length,
        message: w
          ? `${s.name} is still full. ${firstName(student)} is number ${position(ctx, w)} on the waitlist.`
          : `${s.name} is full. Join the waitlist and ${firstName(student)} will be enrolled automatically when a seat opens.`,
      };
    }
    const out = seat(ctx, student, s, 'parent', actor);
    notifyEnrolled(ctx, student, s, loc, F, out);
    return enrolled(out);
  });
}

// EN-5 / D-44: join a schedule's line. The same checks as enrolling apply. A
// family can wait while keeping its current schedule (`keeps`).
function joinWaitlist(ctx, actor, body) {
  assertParentOf(ctx, actor, body.studentId);
  const student = getStudent(ctx, body.studentId);
  return tx(ctx.db, () => {
    const { s, F, d } = loadSchedule(ctx, student, body.sessionId);
    const live = liveEnrollment(ctx, student.id, s.id);
    if (live) throw alreadyEnrolled(ctx, student, s, live, d);
    const w = waitingRow(ctx, student.id, s.id);
    if (w) throw conflict('already_waiting', `${firstName(student)} is already number ${position(ctx, w)} on this waitlist.`);
    const block = scheduleBlock(ctx, student, s, F, d);
    if (block) return { outcome: 'blocked', code: block.code, message: block.message };
    const id = Number(ctx.db.prepare('INSERT INTO waitlist (student_id, session_id, weekday, created_by, created_at) VALUES (?,?,0,?,?)')
      .run(student.id, s.id, actor.id, ctx.clock.now()).lastInsertRowid);
    const served = promoteSchedule(ctx, s.id).find(p => p.student_id === student.id); // a seat may already be free
    if (served) return enrolled(served);
    const row = ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
    const keeps = overlapping(ctx, student.id, s)[0];
    return { outcome: 'waitlisted', waitlist: row, position: position(ctx, row), keeps: keeps ? { name: keeps.name } : null };
  });
}

function leaveWaitlist(ctx, actor, id) {
  const w = ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(id));
  if (!w) throw notFound('That waitlist spot no longer exists.');
  assertParentOf(ctx, actor, w.student_id);
  if (w.status !== 'waiting') throw conflict('not_waiting', 'That student is no longer on this waitlist.');
  ctx.db.prepare("UPDATE waitlist SET status = 'removed', resolved_at = ? WHERE id = ?").run(ctx.clock.now(), w.id);
  return ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(w.id);
}

// EN-6 / EN-7: drop any time, no cutoff or penalty. The seat goes to the line at once.
function drop(ctx, actor, id) {
  const e0 = ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(id));
  if (!e0) throw notFound('That enrollment no longer exists.');
  assertParentOf(ctx, actor, e0.student_id);
  return tx(ctx.db, () => {
    const e = ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e0.id);
    if (e.status === 'dropped') throw conflict('not_enrolled', 'That schedule was already dropped.');
    ctx.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(ctx.clock.now(), e.id);
    promoteSchedule(ctx, e.session_id);
    return ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e.id);
  });
}

// ---------- reads ----------

// The days a week of the biggest schedule the student holds (active, in a
// current or upcoming period, whole-schedule rows only).
const heldDays = (ctx, studentId, d) => ctx.db.prepare(`SELECT s.weekdays FROM enrollments e
    JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
  WHERE e.student_id = ? AND e.weekday = 0 AND e.status = 'active' AND s.status = 'active' AND t.end_date >= ?`).all(studentId, d)
  .reduce((n, s) => Math.max(n, dates.daysPerWeek(s)), 0);

// Membership summary for display (MB-3 is the membership module's). can_add is
// the part of the check that is the same for every schedule; each catalog row
// carries its own block (dates and the cap).
function membershipSummary(ctx, student, loc) {
  const d = today(ctx, loc);
  const m = membershipOf(ctx, student.id);
  const b = membershipBlock(student, m, d);
  return {
    status: m ? m.status : null, weekly_cap: m ? m.weekly_cap : 0,
    start_date: m ? m.start_date : null, expires_on: m ? m.expires_on : null,
    held_days: heldDays(ctx, student.id, d), can_add: !b, code: b ? b.code : 'ok', message: b ? b.message : null,
  };
}

const schedCols = `s.name, s.weekdays, s.start_time, s.end_time, s.status AS session_status, s.location_id,
  t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end`;

// A schedule's date changes from `d` on, inside its term (D-46; outside it they don't apply).
const upcomingChanges = (ctx, sessionId, d, termEnd) => ctx.db.prepare(
  'SELECT date, kind, moved_from, reason FROM session_dates WHERE session_id = ? AND date >= ? AND date <= ? ORDER BY date').all(sessionId, d, termEnd);

// One student's schedules and waiting spots in current and upcoming periods.
function studentDetail(ctx, student) {
  const loc = getLocation(ctx, student.location_id);
  const d = today(ctx, loc);
  const enrollments = ctx.db.prepare(`SELECT e.id, e.session_id, e.status, e.source, e.created_at, ${schedCols}
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.weekday = 0 AND e.status IN ('active','paused') AND t.end_date >= ?
    ORDER BY t.start_date, s.start_time, s.name`).all(student.id, d)
    .map(e => Object.assign(e, { days_per_week: dates.daysPerWeek(e), changes: upcomingChanges(ctx, e.session_id, d, e.term_end) }));
  const waitlist = ctx.db.prepare(`SELECT w.id, w.session_id, w.priority, w.created_at, ${schedCols}
    FROM waitlist w JOIN sessions s ON s.id = w.session_id JOIN terms t ON t.id = s.term_id
    WHERE w.student_id = ? AND w.weekday = 0 AND w.status = 'waiting' AND t.end_date >= ?
    ORDER BY t.start_date, s.start_time`).all(student.id, d)
    .map(w => {
      const keeps = overlapping(ctx, student.id, { id: w.session_id, term_start: w.term_start, term_end: w.term_end })[0];
      return Object.assign(w, { days_per_week: dates.daysPerWeek(w), position: position(ctx, w), in_line: line(ctx, w.session_id).length,
        keeps: keeps ? { enrollment_id: keeps.id, name: keeps.name } : null });
    });
  return {
    id: student.id, name: student.name, location: loc,
    membership: membershipSummary(ctx, student, loc), enrollments, waitlist,
  };
}

function familyStudents(ctx, user) {
  const ids = user.role === 'parent' ? auth.linkedStudentIds(ctx, user.id) : [user.id];
  return ids.map(id => studentDetail(ctx, getStudent(ctx, id))).sort((a, b) => a.name.localeCompare(b.name));
}

// The catalog: every active schedule at the student's home location (D-1) with a
// meeting date today or later, with seats left, the line, where this student
// stands, its own block (D-43, judged on its first date) and whether enrolling
// is a switch. can_add says exactly whether Enroll / Join waitlist will get past
// the checks the server runs.
function catalog(ctx, student) {
  const loc = getLocation(ctx, student.location_id);
  const d = today(ctx, loc);
  const rows = ctx.db.prepare(`${SCHEDULE} WHERE s.location_id = ? AND s.status = 'active'
    ORDER BY t.start_date, s.start_time, s.name, s.id`).all(loc.id);
  const ov = dates.overrides(ctx, rows.map(s => s.id));
  const schedules = [];
  for (const s of rows) {
    const all = meetingDates(ctx, s, ov);
    const left = all.filter(x => x >= d);
    if (!left.length) continue;
    const F = left[0];
    const live = liveEnrollment(ctx, student.id, s.id);
    const w = !live && waitingRow(ctx, student.id, s.id);
    const block = scheduleBlock(ctx, student, s, F, d);
    const sw = live ? null : overlapping(ctx, student.id, s)[0];
    schedules.push({
      session_id: s.id, name: s.name, weekdays: s.weekdays, days_per_week: dates.daysPerWeek(s),
      start_time: s.start_time, end_time: s.end_time, term_name: s.term_name, term_start: s.term_start, term_end: s.term_end,
      capacity: s.capacity, seats_left: Math.max(0, s.capacity - seatsTaken(ctx, s.id)), waiting: line(ctx, s.id).length,
      first_date: F, dates_left: left.length, dates_total: all.length,
      mine: live ? live.status === 'active' ? 'enrolled' : 'paused' : w ? 'waiting' : null,
      enrollment_id: live ? live.id : null, position: w ? position(ctx, w) : null,
      can_add: !block && !live && !w, block,
      switch_from: sw ? { enrollment_id: sw.id, name: sw.name } : null,
    });
  }
  return { student: { id: student.id, name: student.name }, location: loc, membership: membershipSummary(ctx, student, loc), schedules };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Pauses begin and end in the membership module (D-16). Every status change is
// logged as it happens by the trigger in schema/040_enrollment.sql (D-26).
// The status an enrollment had at instant t, from its logged changes (oldest
// first). Before the first change it had that change's old status; with none
// logged it has had its current one all along.
function statusAt(e, changes, t) {
  let s = changes.length ? changes[0].from_status : e.status;
  for (const c of changes) if (c.at <= t) s = c.to_status;
  return s;
}

// D-32: the membership record in force at instant t, rebuilt from its audit rows
// (D-26) the way attendance rebuilds validity: before a change, the record it
// replaced. null before the record existed, or with none on file.
function membershipAt(ctx, studentId) {
  const m = ctx.db.prepare('SELECT id, status, start_date, expires_on FROM memberships WHERE student_id = ?').get(studentId);
  if (!m) return () => null;
  const changes = ctx.db.prepare("SELECT at, detail FROM audit_log WHERE target_type = 'membership' AND target_id = ? ORDER BY at, id")
    .all(m.id).map(r => Object.assign({ at: r.at }, JSON.parse(r.detail || '{}'))).filter(c => 'before' in c);
  return t => { for (const c of changes) if (t < c.at) return c.before; return m; };
}

// How long a visit has lasted as of `now`: its check-out, or for one still open
// (no check-out yet) only up to now, and never past the time auto-checkout will
// close it (CI-5, D-14): its schedule's end, run on through each back-to-back
// schedule meeting that day (D-47) whose check-in window has opened by then
// (D-28), capped by closing time; with no schedule, closing time. So an open
// visit never overlaps a schedule that hasn't started yet, and covers each
// back-to-back one once it has begun.
function visitEnd(ctx, hist, ov, now) {
  const cutoffs = new Map();
  const cutoff = v => {
    const loc = ctx.db.prepare('SELECT timezone, close_time FROM locations WHERE id = ?').get(v.location_id);
    const d = v.local_date;
    const close = time.toMs(loc, d, loc.close_time);
    const s = v.session_id == null ? null : ctx.db.prepare('SELECT id, start_time, end_time FROM sessions WHERE id = ?').get(v.session_id);
    if (!s) return Math.max(close, v.check_in_at);
    let end = time.toMs(loc, d, sessionTimes.timesOn(hist, s.id, d, s).end_time);
    const slots = ctx.db.prepare(`SELECT e.weekday, s.id, s.weekdays, s.start_time, s.end_time, t.start_date AS term_start, t.end_date AS term_end
        FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
      WHERE e.student_id = ? AND e.status = 'active' AND s.status = 'active' AND s.location_id = ?`).all(v.student_id, v.location_id)
      .filter(x => dates.meets(x, ov, d) && dates.counts(x, d))
      .map(x => { const h = sessionTimes.timesOn(hist, x.id, d, x); return [time.toMs(loc, d, h.start_time), time.toMs(loc, d, h.end_time)]; })
      .sort((a, b) => a[0] - b[0]);
    for (const [a, b] of slots) if (a - 30 * 60000 <= end && b > end) end = b;
    return Math.max(Math.min(end, close), v.check_in_at);
  };
  return v => {
    if (v.check_out_at != null) return v.check_out_at;
    if (!cutoffs.has(v.id)) cutoffs.set(v.id, cutoff(v));
    return Math.min(now, cutoffs.get(v.id));
  };
}

// EN-7: every meeting date in [from, to] with its status. Dates come from
// sessions/dates.js (D-47): added and moved dates show, skipped ones don't. A
// whole-schedule row counts on every meeting date; a v1 row only on its weekday
// (dates.counts). Absent is computed here (D-15), never stored, and carries no
// penalty. Each date is judged by the enrollment's status when it started:
// paused then is paused (even if the membership has since been renewed), active
// then and missed is absent (even if the schedule is paused now). Each date uses
// the times the schedule had that day (D-34), and a date before the
// membership's start date is not_started, never absent (D-32).
function schedule(ctx, student, q) {
  const loc = getLocation(ctx, student.location_id);
  const from = q.from || time.weekStart(today(ctx, loc));
  const to = q.to || time.addDays(from, 6);
  if (!ISO.test(from) || !ISO.test(to) || !DateTime.fromISO(from).isValid || !DateTime.fromISO(to).isValid || from > to) {
    throw bad('bad_range', 'Pick a start date on or before the end date.');
  }
  // A year at most (366 days counting both ends), measured without stepping
  // through the days, so 0001-01-01 to 9999-12-31 is refused at once.
  if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > 365) throw bad('bad_range', 'Pick a range of a year or less.');
  const now = ctx.clock.now();
  const enrollments = ctx.db.prepare(`SELECT e.*, ${schedCols} FROM enrollments e JOIN sessions s ON s.id = e.session_id
    JOIN terms t ON t.id = s.term_id WHERE e.student_id = ? ORDER BY e.id`).all(student.id);
  const closures = new Map(ctx.db.prepare('SELECT date, reason FROM closures WHERE location_id = ? AND date BETWEEN ? AND ?')
    .all(loc.id, from, to).map(c => [c.date, c.reason]));
  const visits = ctx.db.prepare('SELECT * FROM visits WHERE student_id = ? AND local_date BETWEEN ? AND ?').all(student.id, from, to);
  const changes = new Map(enrollments.map(e => [e.id, []]));
  for (const c of ctx.db.prepare(`SELECT l.enrollment_id, l.from_status, l.to_status, l.at FROM enrollment_status_log l
    JOIN enrollments e ON e.id = l.enrollment_id WHERE e.student_id = ? ORDER BY l.at, l.id`).all(student.id)) changes.get(c.enrollment_id).push(c);
  const hist = sessionTimes.history(ctx);
  const ov = dates.overrides(ctx);
  const membership = membershipAt(ctx, student.id);
  const lastUntil = visitEnd(ctx, hist, ov, now);
  const out = [], seen = new Set();
  for (const e of enrollments) {
    const sched = { id: e.session_id, weekdays: e.weekdays, term_start: e.term_start, term_end: e.term_end };
    for (const d of dates.datesOf(sched, ov, from, to)) {
      if (!dates.counts(e, d)) continue;
      const hours = sessionTimes.timesOn(hist, e.session_id, d, e);
      const start = time.toMs(loc, d, hours.start_time), end = time.toMs(loc, d, hours.end_time);
      const during = x => x.check_in_at < end && lastUntil(x) > start;
      const own = visits.find(x => x.local_date === d && (x.session_id === e.session_id
        || (x.session_id == null && during(x))));
      // It counts if they came, or were enrolled from its start to its end.
      const began = e.created_at <= start || !!own;
      const lasted = e.ended_at == null || e.ended_at >= end || (!!own && e.ended_at > start);
      if (!began || !lasted) continue;
      // D-28: one visit through back-to-back schedules counts for every one it
      // overlaps there, as attendance counts it.
      const v = own || visits.find(x => x.local_date === d && x.session_id != null && x.location_id === e.location_id && during(x));
      // Cancelling a schedule ends its enrollments then (ended_at), so `lasted` stops
      // the dates after it and the ones before stand. With no end on record there
      // is nothing to go on, so only dates they came to are shown.
      if (e.session_status !== 'active' && e.ended_at == null && !v) continue;
      if (seen.has(d + ':' + e.session_id)) continue; // a schedule dropped and taken again
      seen.add(d + ':' + e.session_id);
      const m = membership(start);
      // L33: a schedule paused when this date began but restored before it ends
      // (a renewal mid-session) is on again: upcoming while it runs, check-in
      // works. Once it has ended unattended it stays paused, never absent.
      const ch = changes.get(e.id);
      const held = statusAt(e, ch, start) === 'paused' && (now >= end || statusAt(e, ch, now) === 'paused');
      const status = v ? 'attended' : closures.has(d) ? 'closed' : m && d < m.start_date ? 'not_started'
        : held ? 'paused' : now < end ? 'upcoming' : 'absent';
      const change = (ov.get(e.session_id) || new Map()).get(d);
      out.push({
        date: d, weekday: time.weekdayOfDate(d), session_id: e.session_id, enrollment_id: e.id, name: e.name,
        start_time: hours.start_time, end_time: hours.end_time, start_at: start, end_at: end, status,
        change: change ? change.moved_from ? 'moved' : 'added' : null, moved_from: change ? change.moved_from : null,
        membership_starts: status === 'not_started' ? m.start_date : null,
        closure_reason: closures.get(d) || null,
        check_in_at: v ? v.check_in_at : null, check_out_at: v ? v.check_out_at : null,
      });
    }
  }
  out.sort((a, b) => a.start_at - b.start_at || a.name.localeCompare(b.name));
  return { student: { id: student.id, name: student.name }, location: loc, from, to, occurrences: out };
}

module.exports = {
  getStudent, enroll, joinWaitlist, leaveWaitlist, drop, familyStudents, catalog, schedule, promoteAll,
};
