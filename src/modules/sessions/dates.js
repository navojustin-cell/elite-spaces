'use strict';
// Read-only helper the sessions module exports on purpose (D-47, D-26 (6)): which
// dates a schedule meets on. Every module decides "does this schedule meet on d"
// here, never with its own weekday check. It needs only the database and
// src/time.js, so it loads as a plain file whether or not the sessions module
// is mounted (scoped test runs).
//
// A schedule meets on date d when d is inside its term and either (d's weekday is
// one of its weekdays and d isn't skipped) or d is added (session_dates,
// schema/030_sessions.sql). A change outside the term is ignored. Closures are NOT
// applied here: callers apply them, and a closure cancels d for every schedule.

const { weekdayOfDate, addDays } = require('../../time');

// Every schedule's date changes: session id -> Map(date -> { kind, moved_from, reason }).
// `sessionIds` limits it to those schedules.
function overrides(ctx, sessionIds = null) {
  const out = new Map();
  const where = sessionIds ? ` WHERE session_id IN (${sessionIds.map(() => '?').join(',')})` : '';
  for (const r of ctx.db.prepare(`SELECT session_id, date, kind, moved_from, reason FROM session_dates${where} ORDER BY session_id, date`)
    .all(...(sessionIds || []))) {
    if (!out.has(r.session_id)) out.set(r.session_id, new Map());
    out.get(r.session_id).set(r.date, { kind: r.kind, moved_from: r.moved_from, reason: r.reason });
  }
  return out;
}

// The schedule's weekdays (ISO, 1 = Monday) from '1,3,5' or [1, 3, 5].
const days = s => String(s.weekdays).split(',').map(Number);

// Does the schedule meet on `date`? `s` needs id, weekdays, term_start, term_end; `ov` is from overrides().
function meets(s, ov, date) {
  if (date < s.term_start || date > s.term_end) return false;
  const change = ov && ov.get(s.id) && ov.get(s.id).get(date);
  if (change) return change.kind === 'add';
  return days(s).includes(weekdayOfDate(date));
}

// Its meeting dates in [from, to] (inclusive), oldest first, closures not removed.
function datesOf(s, ov, from, to) {
  const out = [];
  const end = to < s.term_end ? to : s.term_end;
  for (let d = from > s.term_start ? from : s.term_start; d <= end; d = addDays(d, 1)) {
    if (meets(s, ov, d)) out.push(d);
  }
  return out;
}

// Does this enrollment (or waitlist row) count on `date`? weekday 0 = the whole
// schedule, every meeting date (D-42); 1-7 = a v1 row, that weekday only (history).
function counts(e, date) {
  const wd = Number(e.weekday);
  return wd === 0 || wd === weekdayOfDate(date);
}

// How many days a week the schedule meets: its weekday count. Date changes don't change it.
function daysPerWeek(s) {
  return new Set(days(s)).size;
}

module.exports = { overrides, meets, datesOf, counts, daysPerWeek };
