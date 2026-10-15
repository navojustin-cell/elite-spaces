'use strict';
// Read-only helper the sessions module exports on purpose (R8): the times a
// session had on a given date. Editing a session's times applies from the edit
// date forward, and schema/030_sessions.sql keeps the times each edit replaced
// in session_times, so a past occurrence is judged by the hours it really had.

// Every session's replaced times, oldest first: session id -> [{ until_date, start_time, end_time }].
function history(ctx) {
  const out = new Map();
  for (const r of ctx.db.prepare('SELECT session_id, until_date, start_time, end_time FROM session_times ORDER BY session_id, until_date').all()) {
    if (!out.has(r.session_id)) out.set(r.session_id, []);
    out.get(r.session_id).push(r);
  }
  return out;
}

// The { start_time, end_time } a session had on local date `date`: the first
// replaced set whose until_date is on or after it, else `current` (its times now).
function timesOn(hist, sessionId, date, current) {
  for (const r of hist.get(sessionId) || []) if (date <= r.until_date) return { start_time: r.start_time, end_time: r.end_time };
  return { start_time: current.start_time, end_time: current.end_time };
}

module.exports = { history, timesOn };
