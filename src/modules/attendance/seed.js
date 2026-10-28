'use strict';
// Demo missed-day notices (D-53, docs/v1.1-design.md 5.3).
// 1. Leo Garcia's most recent past Afternoons MWF date has no visit (the core seed
//    forces it). The missed-day check runs for that date with the clock at its end
//    plus 30 minutes, so Maria Garcia has a real `missed_day` notice (notified = 1)
//    in her Inbox that opens Leo's week in Hours.
// 2. So the job's first run after `npm start` sends nothing else, every seeded
//    student with a meeting date on each location's today and yesterday (by the
//    seed clock) gets a placeholder row (notified = 0, no notification), visit or
//    not. Leo's row is written first, so a placeholder never replaces it.
// A demo database started on a later calendar day than it was seeded sends real
// notices for that day, as production would; reseed for a quiet demo.

const time = require('../../time');
const dates = require('../sessions/dates');
const svc = require('./service');

module.exports = function seed(ctx, demo) {
  const db = ctx.db;
  const { irvine } = demo.locations;
  const leo = demo.families.flatMap(f => f.students).find(s => s.name === 'Leo Garcia');
  const pm = demo.sessions.afternoonsMWF;
  const withTerm = id => db.prepare(`SELECT s.*, t.start_date AS term_start, t.end_date AS term_end
    FROM sessions s JOIN terms t ON t.id = s.term_id WHERE s.id = ?`).get(id);
  const closed = (l, d) => !!db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(l.id, d);
  const today = l => time.localDate(l, demo.NOW);
  const wasFixed = ctx.clock.isFixed(), was = ctx.clock.now();

  // 1. Leo's forced miss: his most recent past Afternoons MWF date with no visit.
  const ov = dates.overrides(ctx);
  let missed = null;
  for (let back = 1; back <= 21 && !missed; back++) {
    const d = time.addDays(today(irvine), -back);
    if (dates.meets(withTerm(pm.id), ov, d) && !closed(irvine, d)
      && !db.prepare('SELECT 1 FROM visits WHERE student_id = ? AND local_date = ?').get(leo.id, d)) missed = d;
  }
  if (missed) {
    const s = withTerm(pm.id);
    ctx.clock.set(time.toMs(irvine, missed, s.end_time) + 30 * 60000);
    const m = svc.missedDays(ctx, irvine, missed, ctx.clock.now()).find(x => x.student_id === leo.id);
    if (m) svc.recordMissed(ctx, irvine, m, time.localDate(irvine, ctx.clock.now()));
  }
  ctx.clock.set(wasFixed ? was : null);

  // 2. Placeholders for every seeded student scheduled on each location's today and yesterday.
  const placeholder = db.prepare(`INSERT OR IGNORE INTO missed_day_notices (student_id, location_id, local_date, sessions, sent_at, notified)
    VALUES (?,?,?,?,?,0)`);
  const held = db.prepare(`SELECT e.student_id, e.weekday, s.id, s.name, s.weekdays, s.start_time, s.end_time,
      t.start_date AS term_start, t.end_date AS term_end
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE s.location_id = ? AND e.status IN ('active','paused') AND s.status = 'active' ORDER BY e.student_id, s.start_time`);
  const all = dates.overrides(ctx); // the sessions seed's date changes are in by now
  for (const l of db.prepare('SELECT * FROM locations ORDER BY id').all()) {
    const rows = held.all(l.id);
    for (const d of [time.addDays(today(l), -1), today(l)]) {
      if (closed(l, d)) continue;
      const byStudent = new Map();
      for (const r of rows) {
        if (!dates.meets(r, all, d) || !dates.counts(r, d)) continue;
        if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []);
        byStudent.get(r.student_id).push({ session_id: r.id, name: r.name, start_time: r.start_time, end_time: r.end_time });
      }
      for (const [studentId, sessions] of byStudent) placeholder.run(studentId, l.id, d, JSON.stringify(sessions), demo.NOW);
    }
  }
};
