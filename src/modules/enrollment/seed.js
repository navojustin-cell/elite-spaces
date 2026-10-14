'use strict';
// Demo rows for enrollment (runs after scripts/seed.js core data).
//  - Anh Nguyen waits for the full Tuesday Quiet Room. Anh is at the weekly cap,
//    so a freed seat skips Anh (keeping the place) until a session is dropped (D-18).
//  - Sofia Garcia has asked for Friday afternoons; her parent hasn't decided.
//  - Leo Garcia's earlier request for Monday mornings was declined.
const notify = require('../../notify');

module.exports = (ctx, demo) => {
  const db = ctx.db;
  const [garcia, nguyen] = demo.families;
  const [leo, sofia] = garcia.students;
  const anh = nguyen.students[0];
  const { small, pmMWF, morning } = demo.sessions;
  const H = 3600000;
  db.prepare('INSERT INTO waitlist (student_id, session_id, weekday, created_by, created_at) VALUES (?,?,?,?,?)')
    .run(anh.id, small.id, 2, nguyen.parent.id, demo.NOW - 26 * H);
  const asked = demo.NOW - 3 * H;
  const id = Number(db.prepare('INSERT INTO enrollment_requests (student_id, session_id, weekday, created_at) VALUES (?,?,?,?)')
    .run(sofia.id, pmMWF.id, 5, asked).lastInsertRowid);
  // The parents heard when Sofia asked, so Home ("asked ...") and the Inbox show the same time.
  const clock = ctx.clock.isFixed() ? ctx.clock.now() : null;
  ctx.clock.set(asked);
  notify.send(ctx, notify.parentsOf(ctx, sofia.id), {
    kind: 'enrollment_request', title: 'Sofia asked to join Afternoon Study',
    body: 'Fridays 1pm–4pm at Irvine. Approve or decline it in Schedule.', refType: 'enrollment_request', refId: id,
  });
  ctx.clock.set(clock);
  db.prepare("INSERT INTO enrollment_requests (student_id, session_id, weekday, status, decided_by, decided_at, created_at) VALUES (?,?,?,'declined',?,?,?)")
    .run(leo.id, morning.id, 1, garcia.parent.id, demo.NOW - 40 * H, demo.NOW - 50 * H);
  // Seeded slots that start out paused (Daniel Kim's) were paused when staff set the
  // membership inactive 13 days ago (the membership seed's audit row). Stamp that
  // in the status log so Schedule and Hours agree on which weeks were on hold (D-26).
  for (const e of db.prepare(`SELECT id FROM enrollments e WHERE status = 'paused'
    AND NOT EXISTS (SELECT 1 FROM enrollment_status_log l WHERE l.enrollment_id = e.id)`).all()) {
    db.prepare("INSERT INTO enrollment_status_log (enrollment_id, from_status, to_status, at) VALUES (?, 'active', 'paused', ?)")
      .run(e.id, demo.NOW - 13 * 24 * H);
  }
};
