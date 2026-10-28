'use strict';
// Attendance and hours (PRD 7): visit history, computed absences (D-15),
// totals, and the week / month / term ranges the parent Hours view pages
// through. Read-only over the core tables, except the missed-day notices
// (D-53, schema/080_attendance.sql): one per student and date, written once.

const { DateTime } = require('luxon');
const time = require('../../time');
const notify = require('../../notify');
const { tx } = require('../../db');
const { bad, notFound } = require('../../errors');
// R8: the times a session had on each date (the sessions module's read-only helper).
const sessionTimes = require('../sessions/times');
// D-47: which dates a schedule meets on, with its skipped, added and moved dates (read-only helper).
const dates = require('../sessions/dates');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = s => ISO_DATE.test(String(s || '')) && DateTime.fromISO(s).isValid;

// A from/to pair: both real dates, in order, at most a year apart.
function checkRange(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) throw bad('bad_date', 'Choose a start date and an end date.');
  if (from > to) throw bad('bad_range', 'The start date needs to be on or before the end date.');
  if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > 366) throw bad('range_too_long', 'Choose a range of one year or less.');
  return { from, to };
}

// "Oct 1 – Oct 31, 2026", or "Dec 28, 2026 – Jan 3, 2027" across a year end.
function rangeLabel(from, to) {
  const a = DateTime.fromISO(from), b = DateTime.fromISO(to);
  if (from === to) return b.toFormat('LLL d, yyyy');
  return (a.year === b.year ? a.toFormat('LLL d') : a.toFormat('LLL d, yyyy')) + ' – ' + b.toFormat('LLL d, yyyy');
}

// A student with their home location and today's date there.
function student(ctx, id) {
  const s = ctx.db.prepare(`SELECT u.id, u.name, l.id AS lid, l.name AS lname, l.timezone, l.address
    FROM users u JOIN locations l ON l.id = u.location_id WHERE u.id = ? AND u.role = 'student'`).get(id);
  if (!s) return null;
  const location = { id: s.lid, name: s.lname, timezone: s.timezone, address: s.address };
  return { id: s.id, name: s.name, location, today: time.localDate(location, ctx.clock.now()) };
}

const termsAt = (ctx, locationId) =>
  ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE location_id = ? ORDER BY start_date, id').all(locationId);

// The term holding `date`; failing that the latest one already started; failing that the first.
function termIndex(terms, date) {
  const i = terms.findIndex(t => t.start_date <= date && date <= t.end_date);
  if (i >= 0) return i;
  const started = terms.filter(t => t.start_date <= date).length;
  return started ? started - 1 : 0;
}

// The week (Mon-Sun), calendar month or term around `date`, with anchors for
// the previous and next one. `next` is null once it would start after today.
function period(ctx, loc, kind, date, today) {
  if (!isIsoDate(date)) throw bad('bad_date', 'Choose a date.');
  let from, to, prev, next, label;
  if (kind === 'week') {
    from = time.weekStart(date);
    to = time.addDays(from, 6);
    prev = time.addDays(from, -7);
    next = time.addDays(from, 7);
    label = rangeLabel(from, to);
  } else if (kind === 'month') {
    const m = DateTime.fromISO(date).startOf('month');
    from = m.toISODate();
    to = m.endOf('month').toISODate();
    prev = m.minus({ months: 1 }).toISODate();
    next = m.plus({ months: 1 }).toISODate();
    label = m.toFormat('LLLL yyyy');
  } else if (kind === 'term') {
    const terms = termsAt(ctx, loc.id);
    if (!terms.length) throw notFound(`${loc.name} hasn't set up a term yet.`);
    const i = termIndex(terms, date);
    ({ start_date: from, end_date: to, name: label } = terms[i]);
    prev = terms[i - 1] ? terms[i - 1].start_date : null;
    next = terms[i + 1] ? terms[i + 1].start_date : null;
  } else {
    throw bad('bad_period', 'Choose week, month or term.');
  }
  if (next && next > today) next = null;
  return { kind, from, to, label, dates: rangeLabel(from, to), prev, next };
}

// Range shortcuts for exports and reports: this week, this month, last month, and the current term.
function presets(ctx, loc, today) {
  const week = period(ctx, loc, 'week', today, today);
  const month = period(ctx, loc, 'month', today, today);
  const last = period(ctx, loc, 'month', month.prev, today);
  const out = [
    { id: 'this_week', label: 'This week', from: week.from, to: week.to },
    { id: 'this_month', label: 'This month', from: month.from, to: month.to },
    { id: 'last_month', label: 'Last month', from: last.from, to: last.to },
  ];
  const terms = termsAt(ctx, loc.id);
  if (terms.length) {
    const t = terms[termIndex(terms, today)];
    out.push({ id: 'this_term', label: t.name, from: t.start_date, to: t.end_date });
  }
  return out;
}

// AT-1: one visit as every screen and file shows it, with local times in the
// zone of the location where it happened.
function shapeVisit(v) {
  const zone = { timezone: v.timezone };
  return {
    id: v.id,
    date: v.local_date,
    student_id: v.student_id,
    student_name: v.student_name,
    location_id: v.location_id,
    location_name: v.location_name,
    timezone: v.timezone,
    session_id: v.session_id,
    session_name: v.session_name,
    check_in_at: v.check_in_at,
    check_out_at: v.check_out_at,
    check_in_local: time.localTime(zone, v.check_in_at),
    check_out_local: v.check_out_at == null ? null : time.localTime(zone, v.check_out_at),
    minutes: v.check_out_at == null ? null : Math.round((v.check_out_at - v.check_in_at) / 60000),
    checkin_method: v.checkin_method,
    checkout_method: v.checkout_method,
    needs_review: !!v.flagged && v.reviewed_by == null,
    flag_reason: v.flag_reason,
    checked_in_by_name: v.checked_in_by_name,
    checked_out_by_name: v.checked_out_by_name,
  };
}

// How long a visit has lasted as of `now`: its check-out, or for one still open
// (no check-out yet) only up to now, and never past the time auto-checkout will
// close it (CI-5, D-14): its schedule's end that day, run on through each
// back-to-back schedule the student holds that meets that day (D-47) and whose
// check-in window has opened by then (R2, D-28), capped by closing time; with no
// schedule, closing time. So an open visit never overlaps a session that hasn't
// started yet, and covers each back-to-back one once it has begun.
function visitEnd(ctx, hist, now) {
  const cutoffs = new Map();
  let ov = null; // every schedule's date changes, read once when first needed
  const cutoff = v => {
    const loc = ctx.db.prepare('SELECT timezone, close_time FROM locations WHERE id = ?').get(v.location_id);
    const d = v.local_date;
    const close = time.toMs(loc, d, loc.close_time);
    const s = v.session_id == null ? null : ctx.db.prepare('SELECT id, start_time, end_time FROM sessions WHERE id = ?').get(v.session_id);
    if (!s) return Math.max(close, v.check_in_at);
    let end = time.toMs(loc, d, sessionTimes.timesOn(hist, s.id, d, s).end_time);
    ov = ov || dates.overrides(ctx);
    const slots = ctx.db.prepare(`SELECT s.id, s.weekdays, s.start_time, s.end_time, e.weekday, t.start_date AS term_start, t.end_date AS term_end
        FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
      WHERE e.student_id = ? AND e.status = 'active' AND s.status = 'active' AND s.location_id = ?
        AND t.start_date <= ? AND t.end_date >= ?`).all(v.student_id, v.location_id, d, d)
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

// A visit overlaps a session's hours [start, end) when it began before the end
// and lasted (visitEnd) past the start.
const overlaps = (v, start, end, lastUntil) => v.check_in_at < end && lastUntil(v) > start;

// Does a visit at the session's location that isn't its own cover one of its
// meeting dates? The rule absences() uses for attended (EN-7, R2): a date it meets
// on (D-47: inside its term, on one of its days or added, not skipped or moved
// away), not a closure, and overlapping the hours it had that day (R8). A visit
// with no session (a staff override check-in) covers it for anyone; a visit for
// another session only for a student enrolled in it for that date at the time:
// made before that date's session ended and not ended before it began
// (back-to-back sessions are one visit, R2).
function coversSession(ctx, sess) {
  const zone = { timezone: sess.timezone };
  const ov = dates.overrides(ctx, [sess.id]);
  const closed = new Set(ctx.db.prepare('SELECT date FROM closures WHERE location_id = ?').all(sess.location_id).map(c => c.date));
  const hist = sessionTimes.history(ctx);
  const held = new Map(); // student id -> their enrollments in this schedule
  for (const e of ctx.db.prepare('SELECT student_id, weekday, created_at, ended_at FROM enrollments WHERE session_id = ?').all(sess.id)) {
    if (!held.has(e.student_id)) held.set(e.student_id, []);
    held.get(e.student_id).push(e);
  }
  const enrolledFor = (v, d, start, end) => (held.get(v.student_id) || [])
    .some(e => dates.counts(e, d) && e.created_at < end && (e.ended_at == null || e.ended_at > start));
  const lastUntil = visitEnd(ctx, hist, ctx.clock.now());
  return v => {
    const d = v.local_date;
    if (!dates.meets(sess, ov, d)) return false; // not one of its meeting dates (D-47)
    if (closed.has(d)) return false; // a closure cancels the day (SC-3)
    const hours = sessionTimes.timesOn(hist, sess.id, d, sess);
    const start = time.toMs(zone, d, hours.start_time), end = time.toMs(zone, d, hours.end_time);
    if (v.session_id != null && !enrolledFor(v, d, start, end)) return false; // another session's visit, not enrolled here then
    return overlaps(v, start, end, lastUntil);
  };
}

// Visits matching the filters, oldest first. Filtered to one session, that is
// the session's own visits plus the other visits at its location that cover it (AT-4, R2).
function visits(ctx, { studentId = null, locationId = null, sessionId = null, from, to }) {
  const where = ['v.local_date BETWEEN ? AND ?'], args = [from, to];
  if (studentId != null) { where.push('v.student_id = ?'); args.push(studentId); }
  if (locationId != null) { where.push('v.location_id = ?'); args.push(locationId); }
  let covers = null;
  if (sessionId != null) {
    const sess = ctx.db.prepare(`SELECT s.*, t.start_date AS term_start, t.end_date AS term_end, l.timezone
      FROM sessions s JOIN terms t ON t.id = s.term_id JOIN locations l ON l.id = s.location_id WHERE s.id = ?`).get(sessionId);
    where.push('(v.session_id = ? OR v.location_id = ?)'); args.push(sess.id, sess.location_id);
    covers = coversSession(ctx, sess);
  }
  return ctx.db.prepare(`SELECT v.*, s.name AS session_name, u.name AS student_name, l.name AS location_name, l.timezone,
      cin.name AS checked_in_by_name, cout.name AS checked_out_by_name
    FROM visits v JOIN users u ON u.id = v.student_id JOIN locations l ON l.id = v.location_id
    LEFT JOIN sessions s ON s.id = v.session_id
    LEFT JOIN users cin ON cin.id = v.checked_in_by LEFT JOIN users cout ON cout.id = v.checked_out_by
    WHERE ${where.join(' AND ')} ORDER BY v.local_date, v.check_in_at, v.id`).all(...args)
    .filter(v => !covers || v.session_id === Number(sessionId) || covers(v)).map(shapeVisit);
}

// D-16 / MB-5: while a membership isn't valid its slots are paused, and a paused
// week is never an absence. Returns the stretches of time [from, to) when the
// student's membership wasn't valid, oldest first, rebuilt from the core tables:
// the current record and, before it, each staff change, which the audit log keeps
// with the record before and after (MB-2, NF-2). Valid means status active and
// the date from start_date through expires_on (the last valid day, inclusive),
// so a start at midnight on start_date (D-32: nothing before it is missed) and an
// expiry at midnight after expires_on need no log entry. `zone` is the student's
// home location (D-1). No membership on file: nothing to go on.
function pausedStretches(ctx, studentId, zone) {
  const m = ctx.db.prepare('SELECT id, status, start_date, expires_on FROM memberships WHERE student_id = ?').get(studentId);
  if (!m) return [];
  const changes = ctx.db.prepare("SELECT at, detail FROM audit_log WHERE target_type = 'membership' AND target_id = ? ORDER BY at, id")
    .all(m.id).map(r => Object.assign({ at: r.at }, JSON.parse(r.detail || '{}'))).filter(c => 'before' in c);
  const records = []; // [from, to, the record in force]
  let start = -Infinity;
  for (const c of changes) { records.push([start, c.at, c.before]); start = c.at; }
  records.push([start, Infinity, m]);
  const out = [];
  for (const [a, b, rec] of records) {
    if (!rec || rec.status !== 'active') { if (a < b) out.push([a, b]); continue; }
    const on = rec.start_date ? Math.min(b, time.toMs(zone, rec.start_date, '00:00')) : a; // not started yet (D-32)
    if (a < on) out.push([a, on]);
    const off = Math.max(a, time.toMs(zone, time.addDays(rec.expires_on, 1), '00:00'));
    if (off < b) out.push([off, b]);
  }
  return out;
}

// A slot that is still paused was paused when the membership last stopped being valid.
const pausedSince = (stretches, now) => stretches.reduce((since, [a]) => (a <= now ? a : since), null);

// D-26: every change to an enrollment's status is in enrollment_status_log
// (oldest first). Was the slot on hold at instant t? Before its first logged
// change it had that change's old status. With nothing logged there is nothing
// to go on, and the membership stretches above decide alone. This catches a
// slot kept paused at renewal because it would go over the weekly limit
// (D-16a): the membership is valid again, but that slot's weeks are not missed.
function pausedAt(log, t) {
  if (!log || !log.length) return false;
  let s = log[0].from_status;
  for (const c of log) if (c.at <= t) s = c.to_status;
  return s === 'paused';
}

// D-15: every meeting date an enrollment owed in [from, to], over or still to
// come. A date is owed when its schedule meets on it (D-47: skipped and
// moved-away dates never, added dates too), a v1 per-weekday row counts on it
// (D-42), it isn't a closure, and it began after the student enrolled. An
// enrollment owes dates only while it was live: from when it was made while still
// active, until it ended (dropped), or until it was paused, and never while the
// membership wasn't valid (a paused stretch it came back from). A pause is judged
// at each date's start, so one already under way when the schedule was paused is
// still owed. One whose session was cancelled with no end time recorded owes none.
// Each date is judged by the hours the session had that day (R8), and says
// whether it is `over` by `now` and whether a visit `attended` it.
function owed(ctx, { studentId = null, locationId = null, sessionId = null, from, to }, now) {
  const where = ['t.end_date >= ? AND t.start_date <= ?'], args = [from, to];
  if (studentId != null) { where.push('e.student_id = ?'); args.push(studentId); }
  if (locationId != null) { where.push('s.location_id = ?'); args.push(locationId); }
  if (sessionId != null) { where.push('e.session_id = ?'); args.push(sessionId); }
  const rows = ctx.db.prepare(`SELECT e.id, e.student_id, e.session_id, e.weekday, e.status, e.created_at, e.ended_at,
      s.name AS session_name, s.weekdays, s.start_time, s.end_time, s.status AS session_status, s.location_id,
      t.start_date AS term_start, t.end_date AS term_end, u.name AS student_name, l.name AS location_name, l.timezone
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    JOIN users u ON u.id = e.student_id JOIN locations l ON l.id = s.location_id
    WHERE ${where.join(' AND ')}`).all(...args);
  if (!rows.length) return [];
  const statusLog = new Map(); // enrollment id -> its status changes, oldest first (D-26)
  for (const c of ctx.db.prepare(`SELECT l.enrollment_id, l.from_status, l.to_status, l.at FROM enrollment_status_log l
    JOIN enrollments e ON e.id = l.enrollment_id JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE ${where.join(' AND ')} ORDER BY l.at, l.id`).all(...args)) {
    if (!statusLog.has(c.enrollment_id)) statusLog.set(c.enrollment_id, []);
    statusLog.get(c.enrollment_id).push(c);
  }
  const ov = dates.overrides(ctx, [...new Set(rows.map(e => e.session_id))]); // skipped, added and moved dates (D-46)

  const closed = new Set(ctx.db.prepare('SELECT location_id, date FROM closures WHERE date BETWEEN ? AND ?')
    .all(from, to).map(c => c.location_id + '|' + c.date));
  const dayVisits = new Map(); // student id|date -> that day's visits
  for (const v of ctx.db.prepare(`SELECT id, student_id, location_id, session_id, local_date, check_in_at, check_out_at FROM visits
    WHERE local_date BETWEEN ? AND ? AND (? IS NULL OR student_id = ?)`).all(from, to, studentId, studentId)) {
    const k = v.student_id + '|' + v.local_date;
    if (!dayVisits.has(k)) dayVisits.set(k, []);
    dayVisits.get(k).push(v);
  }
  // Attended (EN-7, R2): a visit that day at that location for this session, or
  // any other visit there whose time overlaps the session's: a staff check-in with
  // no session, or one visit that runs on through back-to-back sessions.
  const attended = (e, d, start, end) => (dayVisits.get(e.student_id + '|' + d) || []).some(v => v.location_id === e.location_id
    && (v.session_id === e.session_id || overlaps(v, start, end, lastUntil)));
  const hist = sessionTimes.history(ctx); // R8: each date keeps the session times it had

  const lastUntil = visitEnd(ctx, hist, now);
  const stretches = new Map(); // student id -> when their membership wasn't valid
  const out = [];
  for (const e of rows) {
    const zone = { timezone: e.timezone };
    if (!stretches.has(e.student_id)) stretches.set(e.student_id, pausedStretches(ctx, e.student_id, zone));
    const off = stretches.get(e.student_id);
    const live = e.status === 'active' && e.session_status === 'active';
    const paused = e.status === 'paused' && e.session_status === 'active';
    const until = live ? Infinity : paused ? pausedSince(off, now)
      : e.ended_at == null ? null : Math.min(e.ended_at, now);
    if (until == null) continue;
    const sched = { id: e.session_id, weekdays: e.weekdays, term_start: e.term_start, term_end: e.term_end };
    for (const d of dates.datesOf(sched, ov, from, to)) {
      if (!dates.counts(e, d)) continue; // a v1 per-weekday row owes only its own weekday (D-42)
      if (closed.has(e.location_id + '|' + d)) continue; // closure (SC-3)
      const hours = sessionTimes.timesOn(hist, e.session_id, d, e);
      const start = time.toMs(zone, d, hours.start_time), end = time.toMs(zone, d, hours.end_time);
      if (start < e.created_at) continue; // before they enrolled
      // Each date is judged by the enrollment's state when it began, as the
      // enrollment schedule judges it (D-26): one that began before a pause is owed
      // even if the pause came partway through, while a drop takes the date it ends in.
      if (paused ? start >= until : end > until) continue; // began once paused, or not over before the enrollment ended
      if (off.some(([a, b]) => a <= start && start < b)) continue; // paused: the membership wasn't valid when it began
      if (pausedAt(statusLog.get(e.id), start)) continue; // paused: the enrollment itself was on hold then
      out.push({
        date: d, student_id: e.student_id, student_name: e.student_name, session_id: e.session_id,
        session_name: e.session_name, start_time: hours.start_time, end_time: hours.end_time,
        location_id: e.location_id, location_name: e.location_name, timezone: e.timezone,
        start, end, over: end <= now, attended: attended(e, d, start, end),
      });
    }
  }
  return out;
}

// D-15: an owed date that is over with no visit for it is an absence. Computed
// on every read, never stored, and carries no penalty (EN-7).
function absences(ctx, filter) {
  return owed(ctx, filter, ctx.clock.now())
    .filter(o => o.over && !o.attended)
    .map(({ start, end, over, attended, ...a }) => a)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time)
      || a.student_name.localeCompare(b.student_name));
}

// ---------------------------------------------------------------- D-53: the missed-day notice (S-12, AT-5)

const GRACE_MS = 30 * 60000; // time for staff to fix a forgotten check-in

// The students at `location` whose day `date` was missed as of `now`: at least
// one date owed that day (D-47, D-15), no visit at all that day at the location,
// and the last of those dates over for at least 30 minutes. Each with the
// schedules missed, earliest first. A day attended in part is not missed: it
// shows as Absent in Hours with no notice.
function missedDays(ctx, location, date, now) {
  const byStudent = new Map();
  for (const o of owed(ctx, { locationId: location.id, from: date, to: date }, now)) {
    if (!byStudent.has(o.student_id)) byStudent.set(o.student_id, []);
    byStudent.get(o.student_id).push(o);
  }
  const came = new Set(ctx.db.prepare('SELECT student_id FROM visits WHERE location_id = ? AND local_date = ?')
    .all(location.id, date).map(v => v.student_id));
  const out = [];
  for (const [studentId, list] of byStudent) {
    if (came.has(studentId)) continue; // a visit at all that day
    if (Math.max(...list.map(o => o.end)) + GRACE_MS > now) continue; // the last date isn't 30 minutes over yet
    list.sort((a, b) => a.start - b.start);
    out.push({ student_id: studentId, student_name: list[0].student_name, location_id: location.id, local_date: date,
      sessions: list.map(o => ({ session_id: o.session_id, name: o.session_name, start_time: o.start_time, end_time: o.end_time })) });
  }
  return out.sort((a, b) => a.student_name.localeCompare(b.student_name) || a.student_id - b.student_id);
}

// "1:00-4:00 PM", or "11:00 AM-1:00 PM" across noon.
function timeRange(from, to) {
  const part = hhmm => { const [h, m] = hhmm.split(':').map(Number); return [`${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')}`, h < 12 ? 'AM' : 'PM']; };
  const [a, am] = part(from), [b, bm] = part(to);
  return am === bm ? `${a}-${b} ${bm}` : `${a} ${am}-${b} ${bm}`;
}
const dayLabel = d => DateTime.fromISO(d).toFormat('ccc, LLL d');

// One missed day: its notice row, then, only when that row is new, one
// `missed_day` notification to each active parent (D-53). The unique (student,
// date) key makes it once only; a seed placeholder (notified = 0) blocks it too.
// Returns the notice id, or null when the day already had a row.
function recordMissed(ctx, location, m, today) {
  return tx(ctx.db, () => {
    const r = ctx.db.prepare(`INSERT OR IGNORE INTO missed_day_notices (student_id, location_id, local_date, sessions, sent_at, notified)
      VALUES (?,?,?,?,?,1)`).run(m.student_id, location.id, m.local_date, JSON.stringify(m.sessions), ctx.clock.now());
    if (!r.changes) return null;
    const id = Number(r.lastInsertRowid);
    const first = m.student_name.split(' ')[0];
    const when = m.local_date === today ? 'today' : m.local_date === time.addDays(today, -1) ? 'yesterday' : 'on ' + dayLabel(m.local_date);
    const what = m.sessions.length === 1
      ? `${m.sessions[0].name}, ${dayLabel(m.local_date)}, ${timeRange(m.sessions[0].start_time, m.sessions[0].end_time)}`
      : `${m.sessions.map(s => `${s.name} ${timeRange(s.start_time, s.end_time)}`).join(' and ')}, ${dayLabel(m.local_date)}`;
    notify.send(ctx, notify.parentsOf(ctx, m.student_id), {
      kind: 'missed_day', refType: 'missed_day', refId: id,
      title: `${first} didn't check in ${when}`,
      body: `${what} at ${location.name}. No check-in was recorded. If ${first} was there, the front desk can add the visit.`,
    });
    return id;
  });
}

// The `missed-day` job: each active location's today and yesterday, by its own
// date (NF-4). Older days are never looked at, so a server that was down, the
// feature being turned on or seeded data never sends notices for old days.
function runMissedDays(ctx) {
  const now = ctx.clock.now();
  const sent = [];
  for (const loc of ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE active = 1 ORDER BY id').all()) {
    const today = time.localDate(loc, now);
    for (const date of [time.addDays(today, -1), today]) {
      for (const m of missedDays(ctx, loc, date, now)) {
        const id = recordMissed(ctx, loc, m, today);
        if (id != null) sent.push(id);
      }
    }
  }
  return sent;
}

// A notice parents were really sent (notified = 1), or null. A seed placeholder isn't one.
function missedNotice(ctx, id) {
  const n = ctx.db.prepare('SELECT * FROM missed_day_notices WHERE id = ? AND notified = 1').get(id);
  return n ? Object.assign(n, { sessions: JSON.parse(n.sessions) }) : null;
}

// The dates in [from, to] a student's parents were told were missed (notified = 1).
const notifiedDates = (ctx, studentId, from, to) => new Set(ctx.db.prepare(`SELECT local_date FROM missed_day_notices
  WHERE student_id = ? AND notified = 1 AND local_date BETWEEN ? AND ?`).all(studentId, from, to).map(r => r.local_date));

// Decimal hours are rounded to hundredths once, per visit; every hours total is
// the sum of the visit hours it covers, so a column of hours adds up to its total
// in every file and screen (L61). Minutes stay exact. Counted in whole hundredths.
const hundredths = minutes => (minutes == null ? 0 : Math.round((minutes / 60) * 100));

function totals(vs, abs) {
  const minutes = vs.reduce((sum, v) => sum + (v.minutes || 0), 0);
  return {
    visits: vs.length,
    minutes,
    hours: vs.reduce((sum, v) => sum + hundredths(v.minutes), 0) / 100,
    absences: abs.length,
    // Everyone the log covers, as by_student lists them: absences only counts too.
    students: new Set([...vs, ...abs].map(r => r.student_id)).size,
    needs_review: vs.filter(v => v.needs_review).length,
  };
}

// Visits, absences and totals for one filter set.
function log(ctx, filter) {
  const vs = visits(ctx, filter), abs = absences(ctx, filter);
  return { visits: vs, absences: abs, totals: totals(vs, abs) };
}

// Per-student totals for the director/HQ report, by name. `location_name`: where
// those visits and absences were, every location by name ("Arcadia, Irvine").
function byStudent(vs, abs) {
  const rows = new Map();
  const row = (id, name, location) => {
    if (!rows.has(id)) rows.set(id, { student_id: id, student_name: name, locations: new Set(), visits: 0, minutes: 0, hundredths: 0, absences: 0 });
    const r = rows.get(id);
    r.locations.add(location);
    return r;
  };
  for (const v of vs) { const r = row(v.student_id, v.student_name, v.location_name); r.visits++; r.minutes += v.minutes || 0; r.hundredths += hundredths(v.minutes); }
  for (const a of abs) row(a.student_id, a.student_name, a.location_name).absences++;
  return [...rows.values()].map(({ locations, hundredths: cents, ...r }) => Object.assign(r, {
    location_name: [...locations].sort((a, b) => a.localeCompare(b)).join(', '), hours: cents / 100 }))
    .sort((a, b) => a.student_name.localeCompare(b.student_name) || a.student_id - b.student_id);
}

module.exports = { hundredths, checkRange, rangeLabel, student, termsAt, period, presets, visits, absences, totals, log, byStudent,
  missedDays, recordMissed, runMissedDays, missedNotice, notifiedDates };
