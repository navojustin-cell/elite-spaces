'use strict';
// Module: sessions - PRD 2. Sessions and scheduling (SC-1..SC-4, NF-4).
//
// Routes, mounted at /api/sessions:
//   GET    /               ?location_id=  terms, closures and active sessions with per-day counts
//                          (anyone whose home is that location; HQ any)
//   GET    /today          ?location_id=  today's sessions at the location, in its own time zone (staff+)
//   POST   /               create a session (director: own location; HQ: any)
//   PUT    /:id            edit name, days, times, capacity; enrolled families are told
//   POST   /:id/cancel     cancel a session: its enrollments end, its waitlist clears, families are told
//   POST   /terms          create a term
//   PUT    /terms/:id      edit a term
//   POST   /closures       close the location on a date inside a term; families enrolled that day are told
//   DELETE /closures/:id   reopen that date; the same families are told
// No scheduled jobs: every change notifies at the moment it is made.
//
// A slot is (session, weekday) (D-10): capacity, enrollment and waitlist counts
// are per slot, and nobody is ever assigned a seat (SC-2). Times are 'HH:MM' in
// the location's own zone and are stored exactly as entered (NF-4).

const express = require('express');
const { DateTime } = require('luxon');
const { tx } = require('../../db');
const auth = require('../../auth');
const notify = require('../../notify');
const audit = require('../../audit');
const time = require('../../time');
const { bad, forbidden, notFound, conflict } = require('../../errors');

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MIN_MINUTES = 120;   // sessions are 2-3 hour blocks (SC-1)
const MAX_MINUTES = 180;
const NAME_MAX = 80;
const REASON_MAX = 120;
const CAPACITY_MAX = 1000; // seats per day; keeps capacity far inside safe integers so every read works
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const DIRECTOR = auth.requireRole('director');

// ---------- small helpers ----------

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const hm = mins => [Math.floor(mins / 60) && Math.floor(mins / 60) + 'h', mins % 60 && (mins % 60) + 'm'].filter(Boolean).join(' ');
const fmtTime = hhmm => DateTime.fromFormat(hhmm, 'HH:mm', { zone: 'UTC' }).toFormat('h:mm a');
const fmtSpan = s => fmtTime(s.start_time) + '–' + fmtTime(s.end_time);
const fmtDate = iso => DateTime.fromISO(iso, { zone: 'UTC' }).toFormat('ccc, LLL d');
const parseDays = s => String(s).split(',').filter(Boolean).map(Number);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
const listLong = days => days.map(d => DAY_LONG[d] + 's').join(' and ');
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
  if (!s) throw notFound('That session does not exist.');
  assertLocation(user, s.location_id);
  return s;
}

const locationRow = (ctx, id) => ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);

// ---------- input checks ----------

function sessionInput(b) {
  const name = text(b.name, 'name', 'Type the session name as plain text.').trim();
  if (!name) throw bad('name', 'Give the session a name.');
  if (name.length > NAME_MAX) throw bad('name', `Keep the name to ${NAME_MAX} characters or fewer.`);
  const raw = Array.isArray(b.weekdays) ? b.weekdays : text(b.weekdays, 'weekdays', 'Days must be Monday through Sunday.').split(',').filter(Boolean);
  const weekdays = [...new Set(raw.map(num))].sort((x, y) => x - y);
  if (!weekdays.length) throw bad('weekdays', 'Pick at least one day.');
  if (weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) throw bad('weekdays', 'Days must be Monday through Sunday.');
  const start = text(b.start_time, 'time', 'Enter the start time like 13:00.'), end = text(b.end_time, 'time', 'Enter the end time like 16:00.');
  if (!HHMM.test(start) || !HHMM.test(end)) throw bad('time', 'Enter start and end times like 13:00.');
  const len = minutes(end) - minutes(start);
  if (len <= 0) throw bad('end_before_start', 'The end time must be after the start time.');
  if (len < MIN_MINUTES || len > MAX_MINUTES) throw bad('duration', `Sessions run 2 to 3 hours. This one is ${hm(len)}.`);
  const capacity = num(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > CAPACITY_MAX) {
    throw bad('capacity', `Seats per day must be a whole number from 1 to ${CAPACITY_MAX.toLocaleString('en-US')}.`);
  }
  return { name, weekdays, start_time: start, end_time: end, capacity };
}

function termInput(b) {
  const name = text(b.name, 'name', 'Type the term name as plain text.').trim();
  if (!name) throw bad('name', 'Give the term a name, like Fall 2026.');
  if (name.length > NAME_MAX) throw bad('name', `Keep the name to ${NAME_MAX} characters or fewer.`);
  const start = b.start_date, end = b.end_date;
  if (!isDate(start) || !isDate(end)) throw bad('dates', 'Choose a start date and an end date.');
  if (end < start) throw bad('end_before_start', 'The term has to end on or after its start date.');
  return { name, start_date: start, end_date: end };
}

// ---------- counts (per slot, D-10) ----------

function slotCounts(ctx, sessionId) {
  const out = {};
  const at = d => (out[d] = out[d] || { enrolled: 0, waiting: 0 });
  for (const r of ctx.db.prepare("SELECT weekday, COUNT(*) AS n FROM enrollments WHERE session_id = ? AND status = 'active' GROUP BY weekday").all(sessionId)) at(r.weekday).enrolled = r.n;
  for (const r of ctx.db.prepare("SELECT weekday, COUNT(*) AS n FROM waitlist WHERE session_id = ? AND status = 'waiting' GROUP BY weekday").all(sessionId)) at(r.weekday).waiting = r.n;
  return out;
}

function shape(ctx, s) {
  const counts = slotCounts(ctx, s.id);
  const weekdays = parseDays(s.weekdays);
  return {
    id: s.id, location_id: s.location_id, term_id: s.term_id, name: s.name, weekdays,
    start_time: s.start_time, end_time: s.end_time, capacity: s.capacity, status: s.status,
    slots: weekdays.map(d => {
      const c = counts[d] || { enrolled: 0, waiting: 0 };
      return { weekday: d, enrolled: c.enrolled, waiting: c.waiting, capacity: s.capacity, seats_left: Math.max(0, s.capacity - c.enrolled) };
    }),
  };
}

// ---------- who to tell ----------

// Each student plus their active linked parents.
function familyOf(ctx, studentIds) {
  const out = new Set();
  for (const id of studentIds) {
    out.add(id);
    for (const p of notify.parentsOf(ctx, id)) out.add(p);
  }
  return [...out];
}

// Students with an active enrollment in a slot that meets on `date` at the location (SC-3, D-19).
function studentsMeetingOn(ctx, locationId, date) {
  return ctx.db.prepare(`SELECT DISTINCT e.student_id FROM enrollments e
      JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
      WHERE s.location_id = ? AND s.status = 'active' AND e.status = 'active' AND e.weekday = ?
        AND ? BETWEEN t.start_date AND t.end_date`)
    .all(locationId, time.weekdayOfDate(date), date).map(r => r.student_id);
}

// Students still holding (or paused in) any slot of the session.
const enrolledStudents = (ctx, sessionId) => ctx.db
  .prepare("SELECT DISTINCT student_id FROM enrollments WHERE session_id = ? AND status IN ('active','paused')")
  .all(sessionId).map(r => r.student_id);

// End the given slots: their enrollments are dropped and their waitlist cleared.
// Returns the students affected.
function endSlots(ctx, sessionId, weekdays, now) {
  const affected = new Set();
  for (const d of weekdays) {
    ctx.db.prepare("SELECT student_id FROM enrollments WHERE session_id = ? AND weekday = ? AND status <> 'dropped'")
      .all(sessionId, d).forEach(r => affected.add(r.student_id));
    ctx.db.prepare("SELECT student_id FROM waitlist WHERE session_id = ? AND weekday = ? AND status = 'waiting'")
      .all(sessionId, d).forEach(r => affected.add(r.student_id));
    ctx.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE session_id = ? AND weekday = ? AND status <> 'dropped'")
      .run(now, sessionId, d);
    ctx.db.prepare("UPDATE waitlist SET status = 'removed', resolved_at = ? WHERE session_id = ? AND weekday = ? AND status = 'waiting'")
      .run(now, sessionId, d);
  }
  return [...affected];
}

function termCovering(ctx, locationId, date) {
  return ctx.db.prepare('SELECT id FROM terms WHERE location_id = ? AND ? BETWEEN start_date AND end_date').get(locationId, date);
}

// ---------- routes ----------

module.exports = {
  router(ctx) {
    const r = express.Router();

    // The location's schedule: terms, closures and active sessions with per-day counts.
    r.get('/', auth.requireRole(), (req, res) => {
      const loc = locationFor(ctx, req.user, req.query.location_id);
      const terms = ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE location_id = ? ORDER BY start_date, id').all(loc.id);
      const closures = ctx.db.prepare('SELECT id, date, reason FROM closures WHERE location_id = ? ORDER BY date').all(loc.id);
      const sessions = ctx.db.prepare("SELECT * FROM sessions WHERE location_id = ? AND status = 'active' ORDER BY start_time, name, id")
        .all(loc.id).map(s => shape(ctx, s));
      res.json({ location: loc, today: localToday(ctx, loc), terms, closures, sessions });
    });

    // Today's sessions at the location, by the location's own date and weekday (NF-4).
    r.get('/today', auth.requireRole('staff'), (req, res) => {
      const loc = locationFor(ctx, req.user, req.query.location_id);
      const date = localToday(ctx, loc);
      const wd = time.weekdayOfDate(date);
      const closure = ctx.db.prepare('SELECT id, date, reason FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date) || null;
      const sessions = ctx.db.prepare(`SELECT s.* FROM sessions s JOIN terms t ON t.id = s.term_id
          WHERE s.location_id = ? AND s.status = 'active' AND t.start_date <= ? AND t.end_date >= ? ORDER BY s.start_time, s.name, s.id`)
        .all(loc.id, date, date)
        .filter(s => parseDays(s.weekdays).includes(wd))
        .map(s => {
          const c = slotCounts(ctx, s.id)[wd] || { enrolled: 0, waiting: 0 };
          return {
            id: s.id, name: s.name, start_time: s.start_time, end_time: s.end_time,
            starts_at: time.toMs(loc, date, s.start_time), ends_at: time.toMs(loc, date, s.end_time),
            enrolled: c.enrolled, waiting: c.waiting, capacity: s.capacity,
          };
        });
      res.json({ location: loc, date, weekday: wd, closure, sessions });
    });

    // ---- terms (SC-3) ----
    r.post('/terms', DIRECTOR, (req, res) => {
      const b = req.body || {};
      const loc = locationFor(ctx, req.user, b.location_id);
      const v = termInput(b);
      const id = Number(ctx.db.prepare('INSERT INTO terms (location_id, name, start_date, end_date) VALUES (?,?,?,?)')
        .run(loc.id, v.name, v.start_date, v.end_date).lastInsertRowid);
      audit.log(ctx, req.user, 'term.create', { targetType: 'term', targetId: id, locationId: loc.id, detail: v });
      res.status(201).json({ term: ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE id = ?').get(id) });
    });

    r.put('/terms/:id', DIRECTOR, (req, res) => {
      const term = ctx.db.prepare('SELECT * FROM terms WHERE id = ?').get(Number(req.params.id) || 0);
      if (!term) throw notFound('That term does not exist.');
      assertLocation(req.user, term.location_id);
      const v = termInput(Object.assign({ name: term.name, start_date: term.start_date, end_date: term.end_date }, req.body || {}));
      tx(ctx.db, () => {
        ctx.db.prepare('UPDATE terms SET name = ?, start_date = ?, end_date = ? WHERE id = ?').run(v.name, v.start_date, v.end_date, term.id);
        // A closure must always sit inside a term (SC-3).
        const stranded = ctx.db.prepare(`SELECT date FROM closures c WHERE c.location_id = ? AND NOT EXISTS
            (SELECT 1 FROM terms t WHERE t.location_id = c.location_id AND c.date BETWEEN t.start_date AND t.end_date) ORDER BY date LIMIT 1`)
          .get(term.location_id);
        if (stranded) throw conflict('closure_outside_term', `The closure on ${fmtDate(stranded.date)} would fall outside every term. Remove that closure first, or keep the term around it.`);
        audit.log(ctx, req.user, 'term.update', { targetType: 'term', targetId: term.id, locationId: term.location_id,
          detail: { before: { name: term.name, start_date: term.start_date, end_date: term.end_date }, after: v } });
      });
      res.json({ term: ctx.db.prepare('SELECT id, name, start_date, end_date FROM terms WHERE id = ?').get(term.id) });
    });

    // ---- closures (SC-3, D-19): that date's occurrences are cancelled; enrollments stay ----
    r.post('/closures', DIRECTOR, (req, res) => {
      const b = req.body || {};
      const loc = locationFor(ctx, req.user, b.location_id);
      const date = b.date;
      if (!isDate(date)) throw bad('date', 'Choose a date.');
      const reason = text(b.reason, 'reason', 'Type the reason as plain text.').trim().slice(0, REASON_MAX) || null;
      if (!termCovering(ctx, loc.id, date)) throw bad('outside_term', `${fmtDate(date)} isn't inside a term at ${loc.name}. Closures can only fall during a term.`);
      if (ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date)) {
        throw conflict('duplicate', `${loc.name} is already closed on ${fmtDate(date)}.`);
      }
      const out = tx(ctx.db, () => {
        const id = Number(ctx.db.prepare('INSERT INTO closures (location_id, date, reason, created_by) VALUES (?,?,?,?)')
          .run(loc.id, date, reason, req.user.id).lastInsertRowid);
        const sent = notify.send(ctx, familyOf(ctx, studentsMeetingOn(ctx, loc.id, date)), {
          kind: 'session_closure', title: `${loc.name} is closed ${fmtDate(date)}`,
          body: (reason ? reason + '. ' : '') + 'Sessions that day are cancelled. Your other sessions go ahead as usual.',
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
      const notified = tx(ctx.db, () => {
        ctx.db.prepare('DELETE FROM closures WHERE id = ?').run(c.id);
        const sent = notify.send(ctx, familyOf(ctx, studentsMeetingOn(ctx, c.location_id, c.date)), {
          kind: 'session_reopened', title: `${loc.name} is open ${fmtDate(c.date)} after all`,
          body: 'The closure was removed, so sessions that day meet as usual.', refType: 'closure', refId: c.id,
        });
        audit.log(ctx, req.user, 'closure.delete', { targetType: 'closure', targetId: c.id, locationId: c.location_id, detail: { date: c.date, reason: c.reason } });
        return sent.length;
      });
      res.json({ ok: true, notified });
    });

    // ---- sessions (SC-1, SC-2, SC-4) ----
    r.post('/', DIRECTOR, (req, res) => {
      const b = req.body || {};
      const loc = locationFor(ctx, req.user, b.location_id);
      const term = ctx.db.prepare('SELECT * FROM terms WHERE id = ? AND location_id = ?').get(num(b.term_id) || 0, loc.id);
      if (!term) throw bad('term', 'Choose a term at this location.');
      const v = sessionInput(b);
      const id = Number(ctx.db.prepare(`INSERT INTO sessions (location_id, term_id, name, weekdays, start_time, end_time, capacity, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(loc.id, term.id, v.name, v.weekdays.join(','), v.start_time, v.end_time, v.capacity, req.user.id, ctx.clock.now()).lastInsertRowid);
      audit.log(ctx, req.user, 'session.create', { targetType: 'session', targetId: id, locationId: loc.id, detail: v });
      res.status(201).json({ session: shape(ctx, ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)) });
    });

    r.put('/:id', DIRECTOR, (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      if (s.status !== 'active') throw conflict('cancelled', 'This session was cancelled, so it can no longer be changed.');
      const before = { name: s.name, weekdays: parseDays(s.weekdays), start_time: s.start_time, end_time: s.end_time, capacity: s.capacity };
      const next = sessionInput(Object.assign({}, before, req.body || {}));
      // Capacity is per day (D-10) and can't go below who already holds a seat on a day that stays.
      const counts = slotCounts(ctx, s.id);
      for (const d of next.weekdays) {
        const n = (counts[d] || { enrolled: 0 }).enrolled;
        if (n > next.capacity) {
          throw conflict('capacity_below_enrolled', `${n} students are already enrolled on ${DAY_LONG[d]}s, so capacity can't go below ${n}.`);
        }
      }
      const removed = before.weekdays.filter(d => !next.weekdays.includes(d));
      const changed = ['name', 'start_time', 'end_time', 'capacity'].filter(k => next[k] !== before[k]);
      const loc = locationRow(ctx, s.location_id);
      const now = ctx.clock.now();
      const out = tx(ctx.db, () => {
        ctx.db.prepare('UPDATE sessions SET name = ?, weekdays = ?, start_time = ?, end_time = ?, capacity = ? WHERE id = ?')
          .run(next.name, next.weekdays.join(','), next.start_time, next.end_time, next.capacity, s.id);
        let notified = 0;
        const ended = removed.length ? endSlots(ctx, s.id, removed, now) : [];
        if (ended.length) {
          notified += notify.send(ctx, familyOf(ctx, ended), {
            kind: 'session_day_removed', title: `${next.name} no longer meets on ${listLong(removed)}`,
            body: `${loc.name} took ${removed.map(d => DAY_LONG[d]).join(' and ')} off ${before.name} (${fmtSpan(before)}). Enrollments and waitlist spots for that day have ended. You can pick another session in the app.`,
            refType: 'session', refId: s.id,
          }).length;
        }
        if (changed.length) {
          const lines = [];
          if (next.name !== before.name) lines.push(`It's now called ${next.name}.`);
          if (next.start_time !== before.start_time || next.end_time !== before.end_time) lines.push(`New time: ${fmtSpan(next)} (was ${fmtSpan(before)}).`);
          if (next.capacity !== before.capacity) lines.push(`Seats per day: ${next.capacity} (was ${before.capacity}).`);
          notified += notify.send(ctx, familyOf(ctx, enrolledStudents(ctx, s.id)), {
            kind: 'session_changed', title: `${before.name} at ${loc.name} has changed`,
            body: lines.join(' ') + ' Your enrollment stays the same.', refType: 'session', refId: s.id,
          }).length;
        }
        audit.log(ctx, req.user, 'session.update', { targetType: 'session', targetId: s.id, locationId: s.location_id,
          detail: { before, after: next, removed_days: removed, ended: ended.length } });
        return { ended: ended.length, notified };
      });
      res.json({ session: shape(ctx, ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(s.id)), ended: out.ended, notified: out.notified });
    });

    r.post('/:id/cancel', DIRECTOR, (req, res) => {
      const s = sessionFor(ctx, req.user, req.params.id);
      if (s.status !== 'active') throw conflict('cancelled', 'This session is already cancelled.');
      const loc = locationRow(ctx, s.location_id);
      const now = ctx.clock.now();
      const out = tx(ctx.db, () => {
        ctx.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
        const ended = endSlots(ctx, s.id, parseDays(s.weekdays), now);
        const sent = notify.send(ctx, familyOf(ctx, ended), {
          kind: 'session_cancelled', title: `${s.name} at ${loc.name} is cancelled`,
          body: `${loc.name} cancelled ${s.name} (${parseDays(s.weekdays).map(d => DAY[d]).join('/')} ${fmtSpan(s)}). Enrollments and waitlist spots for it have ended. You can pick another session in the app.`,
          refType: 'session', refId: s.id,
        });
        audit.log(ctx, req.user, 'session.cancel', { targetType: 'session', targetId: s.id, locationId: s.location_id, detail: { ended: ended.length } });
        return { ended: ended.length, notified: sent.length };
      });
      res.json({ ok: true, ended: out.ended, notified: out.notified });
    });

    return r;
  },
  jobs: [],
};
