'use strict';
// Demo rows for enrollment (runs after scripts/seed.js core data).
//  - Anh Nguyen (cap 2) waits for the full Quiet Room TTh while keeping
//    Afternoons TTh (D-44): a seat there would move her over (a switch, D-43).
//    The catalog shows Mornings MWF blocked for her: 3 days a week, her cap is 2.
//  - Daniel Kim's paused schedule gets its D-26 status-log stamp.
// Students no longer request schedules (D-48), so there are no request rows.

module.exports = (ctx, demo) => {
  const db = ctx.db;
  const nguyen = demo.families[1];
  const anh = nguyen.students[0];
  const H = 3600000;
  db.prepare('INSERT INTO waitlist (student_id, session_id, weekday, created_by, created_at) VALUES (?,?,0,?,?)')
    .run(anh.id, demo.sessions.quietTTh.id, nguyen.parent.id, demo.NOW - 26 * H);
  // Seeded schedules that start out paused (Daniel Kim's) were paused when staff set the
  // membership inactive 13 days ago (the membership seed's audit row). Stamp that
  // in the status log so Schedule and Hours agree on which dates were on hold (D-26).
  for (const e of db.prepare(`SELECT id FROM enrollments e WHERE status = 'paused'
    AND NOT EXISTS (SELECT 1 FROM enrollment_status_log l WHERE l.enrollment_id = e.id)`).all()) {
    db.prepare("INSERT INTO enrollment_status_log (enrollment_id, from_status, to_status, at) VALUES (?, 'active', 'paused', ?)")
      .run(e.id, demo.NOW - 13 * 24 * H);
  }
};
