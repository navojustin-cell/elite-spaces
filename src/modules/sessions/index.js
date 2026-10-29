'use strict';
// Module: sessions - PRD 2. Schedules, periods, closures and date changes (SC-1..SC-5, NF-4).
//
// Routes, mounted at /api/sessions:
//   GET    /               ?location_id=  periods, closures and active schedules with their counts
//                          (anyone whose home is that location; HQ any)
//   GET    /today          ?location_id=  schedules meeting today at the location, by its own date (staff+)
//   GET    /:id/dates      the schedule's whole calendar for its period (anyone who may read the location)
//   POST   /:id/dates      skip, add or move one date (D-46); enrolled families are told
//   DELETE /:id/dates/:date undo the change on that date (both halves of a move)
//   POST   /               create a schedule (director: own location; HQ: any)
//   PUT    /:id            edit name, times, seats; days only while nobody is enrolled or waiting (D-45);
//                          enrolled families are told; more seats fill from the waitlist (L36)
//   POST   /:id/cancel     cancel a schedule: its enrollments end, its waitlist clears, families are told
//   POST   /terms          create a period (term); periods at one location never overlap (D-56)
//   PUT    /terms/:id      edit a period; families whose dates it cuts are told (R7, D-33)
//   POST   /closures       close the location on a date inside a period, today or later (R3); families meeting that day are told
//   DELETE /closures/:id   reopen that date, today or later (R3); the same families are told
// No scheduled jobs: every change notifies at the moment it is made.
//
// A session is a schedule (D-41): fixed weekdays and one time for the whole of its
// term (its period). Enrollments and waitlist rows cover the whole schedule
// (weekday 0, D-42), capacity is seats per meeting date, and nobody is ever
// assigned a seat (SC-2). Which dates a schedule meets on comes only from
// dates.js (D-47). Times are 'HH:MM' in the location's own zone and are stored
// exactly as entered (NF-4). A schedule fits inside its location's opening hours
// (R4). A time edit applies from the edit date forward: the times it replaced
// are kept in session_times for the dates before it (R8), and times.js reads them back.

const express = require('express');
const { DateTime } = require('luxon');
const { tx } = require('../../db');
const auth = require('../../auth');
const notify = require('../../notify');
const audit = require('../../audit');
const time = require('../../time');
const dates = require('./dates');
const times = require('./times');
const { bad, forbidden, notFound, conflict } = require('../../errors');

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MIN_MINUTES = 120;   // schedules are 2-3 hour blocks (SC-1)
const MAX_MINUTES = 180;
const NAME_MAX = 80;
const REASON_MAX = 120;
const CAPACITY_MAX = 1000; // seats per date; keeps capacity far inside safe integers so every read works
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTIONS = ['skip', 'add', 'move'];

const DIRECTOR = auth.requireRole('director');

// ---------- small helpers ----------

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const hm = mins => [Math.floor(mins / 60) && Math.floor(mins / 60) + 'h', mins % 60 && (mins % 60) + 'm'].filter(Boolean).join(' ');
const fmtTime = hhmm => DateTime.fromFormat(hhmm, 'HH:mm', { zone: 'UTC' }).toFormat('h:mm a');
const fmtSpan = s => fmtTime(s.start_time) + '–' + fmtTime(s.end_time);
const fmtDate = iso => DateTime.fromISO(iso, { zone: 'UTC' }).toFormat('ccc, LLL d');
const fmtDay = iso => DateTime.fromISO(iso, { zone: 'UTC' }).toFormat('LLL d');
const parseDays = s => String(s).split(',').filter(Boolean).map(Number);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
const localToday = (ctx, loc) => time.localDate(loc, ctx.clock.now());

// Request fields are refused, never coerced, when they arrive in the wrong shape:
// String({}) is "[object Object]" and String({ toString: 1 }) throws (a 500).
function text(v, code, msg) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(code, msg);
  return v;
}
// A number or a numeric string; anything else is NaN, which the caller refuses.
const num = v => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN);

// ---------- scope (NF-1) ----------

// Ops staff reach their own location (HQ every location) through auth.js;
// parents and students may read their own home location's schedule.
function assertLocation(user, locationId) {
  const family = ['parent', 'student'].includes(user.role) && user.location_id === locationId;
  const ok = auth.canManageLocation(user, locationId) || family;
  if (!ok) throw forbidden('That schedule belongs to another location.');
}

function locationFor(ctx, user, raw) {
  const id = raw == null || raw === '' ? user.location_id : num(raw);
  if (!id) throw bad('location', 'Choose a location.');
  assertLocation(user, id);
  const loc = ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);
  if (!loc) throw notFound('That location does not exist.');
  return loc;
}

function sessionFor(ctx, user, rawId) {
  const s = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(rawId) || 0);
  if (!s) throw notFound('That schedule does not exist.');
  assertLocation(user, s.location_id);
  return s;
}

const locationRow = (ctx, id) => ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);

// The schedule with its period's dates, the shape dates.js reads (term_start, term_end).
const withTerm = (ctx, s) => ctx.db.prepare(`SELECT s.*, t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end
    FROM sessions s JOIN terms t ON t.id = s.term_id WHERE s.id = ?`).get(s.id);

// ---------- input checks ----------

function sessionInput(b) {
  const name = text(b.name, 'name', 'Type the schedule name as plain text.').trim();
  if (!name) throw bad('name', 'Give the schedule a name.');
  if (name.length > NAME_MAX) throw bad('name', `Keep the name to ${NAME_MAX} characters or fewer.`);
  const raw = Array.isArray(b.weekdays) ? b.weekdays : text(b.weekdays, 'weekdays', 'Days must be Monday through Sunday.').split(',').filter(Boolean);
  const weekdays = [...new Set(raw.map(num))].sort((x, y) => x - y);
  if (!weekdays.length) throw bad('weekdays', 'Pick at least one day.');
  if (weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) throw bad('weekdays', 'Days must be Monday through Sunday.');
  const start = text(b.start_time, 'time', 'Enter the start time like 13:00.'), end = text(b.end_time, 'time', 'Enter the end time like 16:00.');
  if (!HHMM.test(start) || !HHMM.test(end)) throw bad('time', 'Enter start and end times like 13:00.');
  const len = minutes(end) - minutes(start);
  if (len <= 0) throw bad('end_before_start', 'The end time must be after the start time.');
  if (len < MIN_MINUTES || len > MAX_MINUTES) throw bad('duration', `Schedules run 2 to 3 hours. This one is ${hm(len)}.`);
  const capacity = num(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > CAPACITY_MAX) {
    throw bad('capacity', `Seats must be a whole number from 1 to ${CAPACITY_MAX.toLocaleString('en-US')}.`);
  }
  return { name, weekdays, start_time: start, end_time: end, capacity };
}

function termInput(b) {
  const name = text(b.name, 'name', 'Type the period name as plain text.').trim();
  if (!name) throw bad('name', 'Give the period a name, like Fall 2026 or November 2026.');
  if (name.length > NAME_MAX) throw bad('name', `Keep the name to ${NAME_MAX} characters or fewer.`);
  const start = b.start_date, end = b.end_date;
  if (!isDate(start) || !isDate(end)) throw bad('dates', 'Choose a start date and an end date.');
  if (end < start) throw bad('end_before_start', 'The period has to end on or after its start date.');
  return { name, start_date: start, end_date: end };
}

// D-56: periods at one location never overlap (a.start <= b.end AND b.start <= a.end).
function assertNoOverlap(ctx, locationId, v, selfId) {
  const o = ctx.db.prepare(`SELECT name, start_date, end_date FROM terms
      WHERE location_id = ? AND id <> ? AND start_date <= ? AND ? <= end_date ORDER BY start_date, id LIMIT 1`)
    .get(locationId, selfId, v.end_date, v.start_date);
  if (!o) return;
  const from = o.start_date > v.start_date ? o.start_date : v.start_date;
  const to = o.end_date < v.end_date ? o.end_date : v.end_date;
  throw conflict('term_overlaps', `${o.name} already covers ${fmtDay(from)} - ${fmtDay(to)}. Periods at one location can't overlap. Use months or a semester for these dates, not both.`);
}

// R4: a schedule starts no earlier than its location opens and ends no later than it closes.
function assertWithinHours(ctx, locationId, v) {
  const loc = ctx.db.prepare('SELECT name, open_time, close_time FROM locations WHERE id = ?').get(locationId);
  if (v.start_time < loc.open_time || v.end_time > loc.close_time) {
    throw bad('outside_hours', `${loc.name} is open ${fmtTime(loc.open_time)}–${fmtTime(loc.close_time)}, so a schedule there has to start at ${fmtTime(loc.open_time)} or later and end by ${fmtTime(loc.close_time)}.`);
  }
}

// R3: closures are added or removed for today or later, by the location's own date.
function assertNotPast(ctx, loc, date, verb) {
  if (date < localToday(ctx, loc)) throw bad('past_date', `${fmtDate(date)} has already passed at ${loc.name}. Closures can only be ${verb} for today or a later date.`);
}

// ---------- counts (per schedule, D-42) ----------

// Whole-schedule rows only (weekday 0): `enrolled` holds seats; `paused` (D-16)
// doesn't, but a cancel ends those enrollments too (D-26), so the screen counts them.
function seatCounts(ctx, sessionId) {
  const c = { enrolled: 0, paused: 0, waiting: 0 };
  for (const r of ctx.db.prepare("SELECT status, COUNT(*) AS n FROM enrollments WHERE session_id = ? AND weekday = 0 AND status IN ('active','paused') GROUP BY status").all(sessionId)) {
    c[r.status === 'active' ? 'enrolled' : 'paused'] = r.n;
  }
  c.waiting = ctx.db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE session_id = ? AND weekday = 0 AND status = 'waiting'").get(sessionId).n;
  return c;
}

// D-45: once anyone holds or waits for the schedule (any row), its days are fixed.
const daysLocked = (ctx, sessionId) => !!ctx.db.prepare(`SELECT 1 FROM enrollments WHERE session_id = ? AND status IN ('active','paused')
    UNION ALL SELECT 1 FROM waitlist WHERE session_id = ? AND status = 'waiting' LIMIT 1`).get(sessionId, sessionId);

// The schedule's date changes from today on, inside its period.
const upcomingChanges = (ctx, st, today) => ctx.db.prepare(`SELECT date, kind, moved_from, reason FROM session_dates
    WHERE session_id = ? AND date >= ? AND date BETWEEN ? AND ? ORDER BY date`).all(st.id, today, st.term_start, st.term_end).map(r => ({ ...r }));

function shape(ctx, s) {
  const st = withTerm(ctx, s);
  const c = seatCounts(ctx, s.id);
  const today = localToday(ctx, locationRow(ctx, s.location_id));
  return {
    id: s.id, location_id: s.location_id, term_id: s.term_id, name: s.name, weekdays: parseDays(s.weekdays),
    start_time: s.start_time, end_time: s.end_time, capacity: s.capacity, status: s.status,
    enrolled: c.enrolled, paused: c.paused, waiting: c.waiting, seats_left: Math.max(0, s.capacity - c.enrolled),
    days_per_week: dates.daysPerWeek(s), days_locked: daysLocked(ctx, s.id), changes: upcomingChanges(ctx, st, today),
  };
}

// ---------- who to tell ----------

// Each student plus their active linked parents, each person once.
function familyOf(ctx, studentIds) {
  const out = new Set();
  for (const id of studentIds) {
    out.add(id);
    for (const p of notify.parentsOf(ctx, id)) out.add(p);
  }
  return [...out];
}

// Students with an active enrollment in a schedule that meets on `date` at the
// location (SC-3, D-19), by dates.js (D-47): added dates in, skipped dates out.
function studentsMeetingOn(ctx, locationId, date) {
  const rows = ctx.db.prepare(`SELECT e.student_id, e.weekday, s.id, s.weekdays, t.start_date AS term_start, t.end_date AS term_end
      FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
      WHERE s.location_id = ? AND s.status = 'active' AND e.status = 'active'`).all(locationId);
  const ov = dates.overrides(ctx, [...new Set(rows.map(r => r.id))]);
  return [...new Set(rows.filter(r => dates.meets(r, ov, date) && dates.counts(r, date)).map(r => r.student_id))];
}

// Students still holding (or paused in) the schedule.
const enrolledStudents = (ctx, sessionId) => ctx.db
  .prepare("SELECT DISTINCT student_id FROM enrollments WHERE session_id = ? AND status IN ('active','paused')")
  .all(sessionId).map(r => r.student_id);

// End the whole schedule: every live enrollment is dropped and every waiting spot
// removed, whatever its weekday (D-26 (4)). Returns the students affected.
function endAll(ctx, sessionId, now) {
  const affected = new Set();
  ctx.db.prepare("SELECT student_id FROM enrollments WHERE session_id = ? AND status <> 'dropped'")
    .all(sessionId).forEach(r => affected.add(r.student_id));
  ctx.db.prepare("SELECT student_id FROM waitlist WHERE session_id = ? AND status = 'waiting'")
    .all(sessionId).forEach(r => affected.add(r.student_id));
  ctx.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE session_id = ? AND status <> 'dropped'")
    .run(now, sessionId);
  ctx.db.prepare("UPDATE waitlist SET status = 'removed', resolved_at = ? WHERE session_id = ? AND status = 'waiting'")
    .run(now, sessionId);
  return [...affected];
}

// L36: run the enrollment module's own waitlist job (EN-5, D-44) through the module
// list, so the line is served by enrollment's rules (membership, cap, order) and this
// module never imports enrollment's code. Without enrollment loaded there is no job.
// Required lazily: the module list is still loading when this file is.
function promoteWaitlists(ctx) {
  for (const m of require('../index')) {
    for (const j of m.jobs || []) if (m.name === 'enrollment' && j.name === 'promote-waitlists') j.run(ctx);
  }
}

function termCovering(ctx, locationId, date) {
  return ctx.db.prepare('SELECT id FROM terms WHERE location_id = ? AND ? BETWEEN start_date AND end_date').get(locationId, date);
}

// R7, D-33: students whose schedules in the term lose a meeting date that hasn't
// passed when the term's dates go from `before` to `after`: an active or paused
// enrollment in one of its active schedules that counts on a cut date (dates.js).
function studentsCutByTerm(ctx, termId, before, after, today) {
  const sessions = ctx.db.prepare("SELECT id, weekdays FROM sessions WHERE term_id = ? AND status = 'active'").all(termId);
  const ov = dates.overrides(ctx, sessions.map(s => s.id));
  const from = before.start_date > today ? before.start_date : today;
  const out = new Set();
  for (const s of sessions) {
    const cut = dates.datesOf(Object.assign({}, s, { term_start: before.start_date, term_end: before.end_date }), ov, from, before.end_date)
      .filter(d => d < after.start_date || d > after.end_date);
    if (!cut.length) continue;
    for (const e of ctx.db.prepare("SELECT student_id, weekday FROM enrollments WHERE session_id = ? AND status IN ('active','paused')").all(s.id)) {
      if (cut.some(d => dates.counts(e, d))) out.add(e.student_id);
    }
  }
  return [...out];
}

// ---------- date changes (D-46) ----------

// A visit for this schedule on that date: one linked to it, or a staff check-in with no
// schedule (D-15a) by one of its students that overlaps its hours that day, so a date
// that stops meeting never leaves a visit behind (design section 6).
function hasVisits(ctx, s, date) {
  if (ctx.db.prepare('SELECT 1 FROM visits WHERE session_id = ? AND local_date = ? LIMIT 1').get(s.id, date)) return true;
  const loc = locationRow(ctx, s.location_id);
  const t = times.timesOn(times.history(ctx), s.id, date, s);
  return !!ctx.db.prepare(`SELECT 1 FROM visits WHERE session_id IS NULL AND location_id = ? AND local_date = ?
      AND check_in_at < ? AND (check_out_at IS NULL OR check_out_at > ?)
      AND student_id IN (SELECT student_id FROM enrollments WHERE session_id = ? AND status IN ('active','paused')) LIMIT 1`)
    .get(s.location_id, date, time.toMs(loc, date, t.end_time), time.toMs(loc, date, t.start_time), s.id);
}

// A closure at the location that day: it cancels the date for every schedule (D-47).
const closedOn = (ctx, locationId, date) => !!ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(locationId, date);

// Skip, add or move one date of one schedule. `b` = { action, date, to?, reason? }.
// Used by POST /:id/dates and by this module's demo seed. Returns { change, notified }.
function changeDate(ctx, user, s, b) {
  if (s.status !== 'active') throw conflict('cancelled', 'This schedule was cancelled, so its dates can no longer be changed.');
  const action = b.action;
  if (!ACTIONS.includes(action)) throw bad('action', 'Choose skip, add or move.');
  const date = b.date;
  if (!isDate(date)) throw bad('date', 'Choose a date.');
  const to = action === 'move' ? b.to : null;
  if (action === 'move' && !isDate(to)) throw bad('date', 'Choose the date it moves to.');
  const reason = text(b.reason, 'reason', 'Type the reason as plain text.').trim().slice(0, REASON_MAX) || null;
  const loc = locationRow(ctx, s.location_id);
  const st = withTerm(ctx, s);
  const today = localToday(ctx, loc);
  const ov = dates.overrides(ctx, [s.id]);
  const mine = ov.get(s.id) || new Map();
  const touched = action === 'move' ? [date, to] : [date];
  for (const d of touched) {
    if (d < today) throw bad('past_date', `${fmtDate(d)} has already passed at ${loc.name}. Only today or a later date can change.`);
  }
  for (const d of touched) {
    if (d < st.term_start || d > st.term_end) throw bad('outside_term', `${fmtDate(d)} isn't inside ${st.term_name} (${fmtDate(st.term_start)} – ${fmtDate(st.term_end)}).`);
  }
  const from = action === 'add' ? null : date;                 // the date that stops meeting
  const added = action === 'skip' ? null : (action === 'add' ? date : to); // the date that starts meeting
  if (from && !dates.meets(st, ov, from)) throw bad('not_a_meeting_date', `${s.name} doesn't meet on ${fmtDate(from)}.`);
  // A closed day isn't a meeting date (D-47), so there is nothing to skip or move away.
  if (from && closedOn(ctx, loc.id, from)) throw bad('not_a_meeting_date', `${loc.name} is closed on ${fmtDate(from)}, so ${s.name} doesn't meet then.`);
  // The closure is checked first: on a closed regular weekday the schedule doesn't meet either.
  if (added && ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(loc.id, added)) {
    throw bad('closed_that_day', `${loc.name} is closed on ${fmtDate(added)}, so ${s.name} can't meet then.`);
  }
  if (added && dates.meets(st, ov, added)) throw bad('already_meets', `${s.name} already meets on ${fmtDate(added)}.`);
  for (const d of [from, added]) {
    if (d && mine.has(d)) throw conflict('already_changed', `${s.name} already has a change on ${fmtDate(d)}. Undo that change first.`);
  }
  if (from && hasVisits(ctx, s, from)) {
    throw conflict('date_has_visits', `Students already checked in to ${s.name} on ${fmtDate(from)}, so that date can't be skipped or moved.`);
  }
  const now = ctx.clock.now();
  return tx(ctx.db, () => {
    const put = (d, kind, movedFrom) => ctx.db.prepare(`INSERT INTO session_dates (session_id, date, kind, moved_from, reason, created_by, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(s.id, d, kind, movedFrom, reason, user.id, now);
    if (from) put(from, 'skip', null);
    if (added) put(added, 'add', from);
    const msg = action === 'skip'
      ? { kind: 'schedule_date_skipped', title: `${s.name} doesn't meet ${fmtDate(date)}`, body: (reason ? reason + '. ' : '') + 'Your other dates go ahead as usual.' }
      : action === 'add'
        ? { kind: 'schedule_date_added', title: `${s.name} also meets ${fmtDate(date)}`, body: `${fmtSpan(s)} at ${loc.name}.` + (reason ? ' ' + reason : '') }
        : { kind: 'schedule_date_moved', title: `${s.name} moves from ${fmtDate(date)} to ${fmtDate(to)}`, body: `Same time, ${fmtSpan(s)}.` + (reason ? ' ' + reason : '') };
    const sent = notify.send(ctx, familyOf(ctx, enrolledStudents(ctx, s.id)), Object.assign(msg, { refType: 'session', refId: s.id }));
    audit.log(ctx, user, 'session.date_' + action, { targetType: 'session', targetId: s.id, locationId: s.location_id, detail: { date, to, reason } });
    return { change: { action, date, to, reason }, notified: sent.length };
  });
}

// Undo the change on `date` (and the other half of a move). Today or later only.
function undoDate(ctx, user, s, date) {
  if (s.status !== 'active') throw conflict('cancelled', 'This schedule was cancelled, so its dates can no longer be changed.');
  const row = isDate(date) && ctx.db.prepare('SELECT * FROM session_dates WHERE session_id = ? AND date = ?').get(s.id, date);
  if (!row) throw notFound(`${s.name} has no change on that date.`);
  const pair = row.kind === 'add'
    ? (row.moved_from ? ctx.db.prepare("SELECT * FROM session_dates WHERE session_id = ? AND date = ? AND kind = 'skip'").get(s.id, row.moved_from) : null)
    : ctx.db.prepare("SELECT * FROM session_dates WHERE session_id = ? AND kind = 'add' AND moved_from = ?").get(s.id, row.date);
  const rows = [row, pair].filter(Boolean);
  const skip = rows.find(r => r.kind === 'skip'), add = rows.find(r => r.kind === 'add');
  const loc = locationRow(ctx, s.location_id);
  const today = localToday(ctx, loc);
  for (const r of rows) {
    if (r.date < today) throw bad('past_date', `${fmtDate(r.date)} has already passed at ${loc.name}. Only today or a later date can change.`);
  }
  // Undoing a skip makes that date meet again, which a closure forbids (D-46, D-47): the closure wins.
  if (skip && closedOn(ctx, loc.id, skip.date)) {
    throw bad('closed_that_day', `${loc.name} is closed on ${fmtDate(skip.date)}, so ${s.name} can't meet then. Reopen that day first to undo this change.`);
  }
  // Undoing an added date cancels it, so it can't leave a visit pointing at a date that no longer meets.
  if (add && hasVisits(ctx, s, add.date)) {
    throw conflict('date_has_visits', `Students already checked in to ${s.name} on ${fmtDate(add.date)}, so that date can't be taken back.`);
  }
  return tx(ctx.db, () => {
    for (const r of rows) ctx.db.prepare('DELETE FROM session_dates WHERE id = ?').run(r.id);
    const msg = skip && add
      ? { title: `${s.name} meets ${fmtDate(skip.date)} after all`, body: `It no longer moves to ${fmtDate(add.date)}. Same time, ${fmtSpan(s)}.` }
      : skip
        ? { title: `${s.name} meets ${fmtDate(skip.date)} after all`, body: `Same time, ${fmtSpan(s)}.` }
        : { title: `${s.name} no longer meets ${fmtDate(add.date)}`, body: 'Your other dates go ahead as usual.' };
    const sent = notify.send(ctx, familyOf(ctx, enrolledStudents(ctx, s.id)),
      Object.assign(msg, { kind: 'schedule_date_restored', refType: 'session', refId: s.id }));
    audit.log(ctx, user, 'session.date_undo', { targetType: 'session', targetId: s.id, locationId: s.location_id,
      detail: { undone: rows.map(r => ({ date: r.date, kind: r.kind, moved_from: r.moved_from, reason: r.reason })) } });
    return { ok: true, notified: sent.length };
  });
}

// ---------- routes ----------

module.exports = {
  changeDate,
  router(ctx) {
    const r = express.Router();

    // The location's schedule: periods, closures and active schedules with their counts.
    r.get('/', auth.requireRole(), (req, res) => {
      const loc = locationFor(ctx, req.user, req.query.location_id);
      const terms = ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE location_id = ? ORDER BY start_date, id').all(loc.id);
      const closures = ctx.db.prepare('SELECT id, date, reason FROM closures WHERE location_id = ? ORDER BY date').all(loc.id);
      const sessions = ctx.db.prepare("SELECT * FROM sessions WHERE location_id = ? AND status = 'active' ORDER BY start_time, name, id")
        .all(loc.id).map(s => shape(ctx, s));
      res.json({ location: loc, today: localToday(ctx, loc), terms, closures, sessions });
    });

    // Schedules meeting today at the location, by its own date (NF-4) and dates.js (D-47).
    r.get('/today', auth.requireRole('staff'), (req, res) => {
      const loc = locationFor(ctx, req.user, req.query.location_id);
      const date = localToday(ctx, loc);
      const closure = ctx.db.prepare('SELECT id, date, reason FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date) || null;
      const rows = ctx.db.prepare(`SELECT s.*, t.start_date AS term_start, t.end_date AS term_end FROM sessions s JOIN terms t ON t.id = s.term_id
          WHERE s.location_id = ? AND s.status = 'active' ORDER BY s.start_time, s.name, s.id`).all(loc.id);
      const ov = dates.overrides(ctx, rows.map(s => s.id));
      const sessions = rows
        .filter(s => dates.meets(s, ov, date))
        .map(s => {
          const c = seatCounts(ctx, s.id);
          const change = ov.get(s.id) && ov.get(s.id).get(date);
          return {
            id: s.id, name: s.name, start_time: s.start_time, end_time: s.end_time,
            starts_at: time.toMs(loc, date, s.start_time), ends_at: time.toMs(loc, date, s.end_time),
            enrolled: c.enrolled, waiting: c.waiting, capacity: s.capacity, added: !!change && change.kind === 'add',
          };
        });
      res.json({ location: loc, date, weekday: time.weekdayOfDate(date), closure, sessions });
    });

    // ---- terms (periods, SC-3, D-56) ----
    r.post('/terms', DIRECTOR, (req, res) => {
      const b = req.body || {};
      const loc = locationFor(ctx, req.user, b.location_id);
      const v = termInput(b);
      assertNoOverlap(ctx, loc.id, v, 0);
      const id = Number(ctx.db.prepare('INSERT INTO terms (location_id, name, start_date, end_date) VALUES (?,?,?,?)')
        .run(loc.id, v.name, v.start_date, v.end_date).lastInsertRowid);
      audit.log(ctx, req.user, 'term.create', { targetType: 'term', targetId: id, locationId: loc.id, detail: v });
      res.status(201).json({ term: ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE id = ?').get(id) });
    });

    r.put('/terms/:id', DIRECTOR, (req, res) => {
      const term = ctx.db.prepare('SELECT * FROM terms WHERE id = ?').get(Number(req.params.id) || 0);
      if (!term) throw notFound('That period does not exist.');
      assertLocation(req.user, term.location_id);
      const v = termInput(Object.assign({ name: term.name, start_date: term.start_date, end_date: term.end_date }, req.body || {}));
      assertNoOverlap(ctx, term.location_id, v, term.id);
      const loc = locationRow(ctx, term.location_id);
      const notified = tx(ctx.db, () => {
        ctx.db.prepare('UPDATE terms SET name = ?, start_date = ?, end_date = ? WHERE id = ?').run(v.name, v.start_date, v.end_date, term.id);
        // A closure must always sit inside a term (SC-3).
        const stranded = ctx.db.prepare(`SELECT date FROM closures c WHERE c.location_id = ? AND NOT EXISTS
            (SELECT 1 FROM terms t WHERE t.location_id = c.location_id AND c.date BETWEEN t.start_date AND t.end_date) ORDER BY date LIMIT 1`)
          .get(term.location_id);
        if (stranded) throw conflict('closure_outside_term', `The closure on ${fmtDate(stranded.date)} would fall outside every period. Remove that closure first, or keep the period around it.`);
        audit.log(ctx, req.user, 'term.update', { targetType: 'term', targetId: term.id, locationId: term.location_id,
          detail: { before: { name: term.name, start_date: term.start_date, end_date: term.end_date }, after: v } });
        // R7, D-33: a shorter term drops meeting dates, so those families are told.
        const cut = studentsCutByTerm(ctx, term.id, term, v, localToday(ctx, loc));
        if (!cut.length) return 0;
        return notify.send(ctx, familyOf(ctx, cut), {
          kind: 'term_shortened', title: `${v.name} at ${loc.name} now runs ${fmtDate(v.start_date)} – ${fmtDate(v.end_date)}`,
          body: `${loc.name} changed ${term.name} from ${fmtDate(term.start_date)} – ${fmtDate(term.end_date)} to ${fmtDate(v.start_date)} – ${fmtDate(v.end_date)}. Your schedule in it doesn't meet outside those dates. You can pick another schedule in the app.`,
          refType: 'term', refId: term.id,
        }).length;
      });
      res.json({ term: ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE id = ?').get(term.id), notified });
    });

    // ---- closures (SC-3, D-19): that date is cancelled for every schedule; enrollments stay ----
    r.post('/closures', DIRECTOR, (req, res) => {
      const b = req.body || {};
      const loc = locationFor(ctx, req.user, b.location_id);
      const date = b.date;
      if (!isDate(date)) throw bad('date', 'Choose a date.');
      const reason = text(b.reason, 'reason', 'Type the reason as plain text.').trim().slice(0, REASON_MAX) || null;
      if (!termCovering(ctx, loc.id, date)) throw bad('outside_term', `${fmtDate(date)} isn't inside a period at ${loc.name}. Closures can only fall during a period.`);
      assertNotPast(ctx, loc, date, 'added');
      if (ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date)) {
        throw conflict('duplicate', `${loc.name} is already closed on ${fmtDate(date)}.`);
      }
      const out = tx(ctx.db, () => {
        const id = Number(ctx.db.prepare('INSERT INTO closures (location_id, date, reason, created_by) VALUES (?,?,?,?)')
          .run(loc.id, date, reason, req.user.id).lastInsertRowid);
        const sent = notify.send(ctx, familyOf(ctx, studentsMeetingOn(ctx, loc.id, date)), {
          kind: 'session_closure', title: `${loc.name} is closed ${fmtDate(date)}`,
          body: (reason ? reason + '. ' : '') + 'Schedules that day are cancelled. Your other dates go ahead as usual.',
          refType: 'closure', refId: id,
        });
        audit.log(ctx, req.user, 'closure.create', { targetType: 'closure', targetId: id, locationId: loc.id, detail: { date, reason } });
        return { id, notified: sent.length };
      });
      res.status(201).json({ closure: { id: out.id, date, reason }, notified: out.notified });
    });

    r.delete('/closures/:id', DIRECTOR, (req, res) => {
      const c = ctx.db.prepare('SELECT * FROM closures WHERE id = ?').get(Number(req.params.id) || 0);
      if (!c) throw notFound('That closure does not exist.');
      assertLocation(req.user, c.location_id);
      const loc = locationRow(ctx, c.location_id);
      assertNotPast(ctx, loc, c.date, 'removed');
      const notified = tx(ctx.db, () => {
        ctx.db.prepare('DELETE FROM closures WHERE id = ?').run(c.id);
        const sent = notify.send(ctx, familyOf(ctx, studentsMeetingOn(ctx, c.location_id, c.date)), {
          kind: 'session_reopened', title: `${loc.name} is open ${fmtDate(c.date)} after all`,
          body: 'The closure was removed, so schedules that day meet as usual.', refType: 'closure', refId: c.id,
        });
        audit.log(ctx, req.user, 'closure.delete', { targetType: 'closure', targetId: c.id, locationId: c.location_id, detail: { date: c.date, reason: c.reason } });
        return sent.length;
      });
      res.json({ ok: true, notified });
    });

    // ---- schedules (SC-1, SC-2, SC-4) ----
    r.post('/', DIRECTOR, (req, res) => {
      const b = req.body || {};
      const loc = locationFor(ctx, req.user, b.location_id);
      const term = ctx.db.prepare('SELECT * FROM terms WHERE id = ? AND location_id = ?').get(num(b.term_id) || 0, loc.id);
      if (!term) throw bad('term', 'Choose a period at this location.');
      const v = sessionInput(b);
      assertWithinHours(ctx, loc.id, v);
      const id = Number(ctx.db.prepare(`INSERT INTO sessions (location_id, term_id, name, weekdays, start_time, end_time, capacity, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(loc.id, term.id, v.name, v.weekdays.join(','), v.start_time, v.end_time, v.capacity, req.user.id, ctx.clock.now()).lastInsertRowid);
      audit.log(ctx, req.user, 'session.create', { targetType: 'session', targetId: id, locationId: loc.id, detail: v });
      res.status(201).json({ session: shape(ctx, ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)) });
    });

    r.put('/:id', DIRECTOR, (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      if (s.status !== 'active') throw conflict('cancelled', 'This schedule was cancelled, so it can no longer be changed.');
      const before = { name: s.name, weekdays: parseDays(s.weekdays), start_time: s.start_time, end_time: s.end_time, capacity: s.capacity };
      const next = sessionInput(Object.assign({}, before, req.body || {}));
      assertWithinHours(ctx, s.location_id, next);
      // D-45: days are fixed once anyone is enrolled or waiting.
      if (next.weekdays.join(',') !== before.weekdays.join(',') && daysLocked(ctx, s.id)) {
        throw conflict('days_locked', `Families are enrolled in ${s.name}, so its days are fixed. Use Move or Add date for single weeks, or cancel it and publish a new schedule.`);
      }
      // Seats are per meeting date (D-10a) and can't go below who already holds one.
      const n = seatCounts(ctx, s.id).enrolled;
      if (n > next.capacity) {
        throw conflict('capacity_below_enrolled', `${n} students are enrolled in ${s.name}, so seats can't go below ${n}.`);
      }
      const changed = ['name', 'start_time', 'end_time', 'capacity'].filter(k => next[k] !== before[k]);
      const loc = locationRow(ctx, s.location_id);
      const now = ctx.clock.now();
      const notified = tx(ctx.db, () => {
        ctx.db.prepare('UPDATE sessions SET name = ?, weekdays = ?, start_time = ?, end_time = ?, capacity = ? WHERE id = ?')
          .run(next.name, next.weekdays.join(','), next.start_time, next.end_time, next.capacity, s.id);
        // R8: new times apply from today (the location's date) on; every date before
        // keeps the times it had. A second edit the same day keeps the first one's record.
        if (next.start_time !== before.start_time || next.end_time !== before.end_time) {
          ctx.db.prepare('INSERT OR IGNORE INTO session_times (session_id, until_date, start_time, end_time, changed_at) VALUES (?,?,?,?,?)')
            .run(s.id, time.addDays(localToday(ctx, loc), -1), before.start_time, before.end_time, now);
        }
        let sent = [];
        if (changed.length) {
          const lines = [];
          if (next.name !== before.name) lines.push(`It's now called ${next.name}.`);
          if (next.start_time !== before.start_time || next.end_time !== before.end_time) lines.push(`New time: ${fmtSpan(next)} (was ${fmtSpan(before)}).`);
          if (next.capacity !== before.capacity) lines.push(`Seats per date: ${next.capacity} (was ${before.capacity}).`);
          sent = notify.send(ctx, familyOf(ctx, enrolledStudents(ctx, s.id)), {
            kind: 'session_changed', title: `${before.name} at ${loc.name} has changed`,
            body: lines.join(' ') + ' Your enrollment stays the same.', refType: 'session', refId: s.id,
          });
        }
        audit.log(ctx, req.user, 'session.update', { targetType: 'session', targetId: s.id, locationId: s.location_id,
          detail: { before, after: next } });
        return sent.length;
      });
      // L36: more seats fill from the waitlist now (EN-5, D-44), not at the next job run.
      if (next.capacity > before.capacity) promoteWaitlists(ctx);
      res.json({ session: shape(ctx, ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(s.id)), notified });
    });

    r.post('/:id/cancel', DIRECTOR, (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      if (s.status !== 'active') throw conflict('cancelled', 'This schedule is already cancelled.');
      const loc = locationRow(ctx, s.location_id);
      const now = ctx.clock.now();
      const out = tx(ctx.db, () => {
        ctx.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
        const ended = endAll(ctx, s.id, now);
        const sent = notify.send(ctx, familyOf(ctx, ended), {
          kind: 'session_cancelled', title: `${s.name} at ${loc.name} is cancelled`,
          body: `${loc.name} cancelled ${s.name} (${parseDays(s.weekdays).map(d => DAY[d]).join('/')} ${fmtSpan(s)}). Enrollments and waitlist spots for it have ended. You can pick another schedule in the app.`,
          refType: 'session', refId: s.id,
        });
        audit.log(ctx, req.user, 'session.cancel', { targetType: 'session', targetId: s.id, locationId: s.location_id, detail: { ended: ended.length } });
        return { ended: ended.length, notified: sent.length };
      });
      res.json({ ok: true, ended: out.ended, notified: out.notified });
    });

    // ---- date changes (SC-5, D-46) ----
    // The whole period's calendar: regular, added, skipped and closed dates.
    r.get('/:id/dates', auth.requireRole(), (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      const st = withTerm(ctx, s);
      const loc = locationRow(ctx, s.location_id);
      const today = localToday(ctx, loc);
      const ov = dates.overrides(ctx, [s.id]);
      const mine = ov.get(s.id) || new Map();
      const closed = new Map(ctx.db.prepare('SELECT date, reason FROM closures WHERE location_id = ? AND date BETWEEN ? AND ?')
        .all(loc.id, st.term_start, st.term_end).map(c => [c.date, c.reason]));
      const out = [];
      for (let d = st.term_start; d <= st.term_end; d = time.addDays(d, 1)) {
        const ch = mine.get(d);
        let kind = null;
        if (dates.meets(st, ov, d)) kind = closed.has(d) ? 'closed' : ch ? 'added' : 'regular';
        else if (ch && ch.kind === 'skip') kind = closed.has(d) ? 'closed' : 'skipped'; // the closure wins (D-47)
        if (!kind) continue;
        out.push({ date: d, kind, reason: kind === 'closed' ? closed.get(d) : ch ? ch.reason : null,
          moved_from: ch && ch.kind === 'add' ? ch.moved_from : null, past: d < today });
      }
      res.json({ session: shape(ctx, s), term: { id: s.term_id, name: st.term_name, start_date: st.term_start, end_date: st.term_end }, dates: out });
    });

    r.post('/:id/dates', DIRECTOR, (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      res.status(201).json(changeDate(ctx, req.user, s, req.body || {}));
    });

    r.delete('/:id/dates/:date', DIRECTOR, (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      res.json(undoDate(ctx, req.user, s, req.params.date));
    });

    return r;
  },
  jobs: [],
};
