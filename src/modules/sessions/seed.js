'use strict';
// Demo rows for sessions (runs after scripts/seed.js core data; docs/v1.1-design.md 5.3).
//  - Mornings MWF moves from the first Monday at least 3 days ahead to that Tuesday,
//    "Staff training day", through the same service code as the screen (D-46), so
//    Sofia Garcia and her parent get schedule_date_moved. If the period has no such
//    Monday left, the first Monday in the period is used, with the clock set to three
//    days before it for the change (only today or later can change).
const time = require('../../time');
const dates = require('./dates');
const { changeDate } = require('./index');

module.exports = (ctx, demo) => {
  const db = ctx.db;
  const irvine = demo.locations.irvine;
  const s = db.prepare(`SELECT s.*, t.start_date AS term_start, t.end_date AS term_end
    FROM sessions s JOIN terms t ON t.id = s.term_id WHERE s.id = ?`).get(demo.sessions.morningsMWF.id);
  const ov = dates.overrides(ctx, [s.id]);
  const closed = d => !!db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(irvine.id, d);
  // A Monday the schedule meets on, whose Tuesday is inside the period, not closed and not a meeting date.
  const fits = mon => time.weekdayOfDate(mon) === 1 && dates.meets(s, ov, mon) && !closed(time.addDays(mon, 1))
    && !dates.meets(s, ov, time.addDays(mon, 1)) && time.addDays(mon, 1) <= s.term_end;
  const first = from => dates.datesOf(s, ov, from, s.term_end).find(fits) || null;
  const today = time.localDate(irvine, demo.NOW);
  let mon = first(time.addDays(today, 3));
  let at = null;
  if (!mon) {
    mon = first(s.term_start);
    if (!mon) return;
    at = time.toMs(irvine, time.addDays(mon, -3), '09:00');
  }
  const before = ctx.clock.isFixed() ? ctx.clock.now() : null;
  if (at != null) ctx.clock.set(at);
  try {
    changeDate(ctx, demo.dirIrvine, s, { action: 'move', date: mon, to: time.addDays(mon, 1), reason: 'Staff training day' });
  } finally {
    ctx.clock.set(before);
  }
};
