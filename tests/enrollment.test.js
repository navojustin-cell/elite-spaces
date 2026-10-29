'use strict';
// Enrollment and waitlists (PRD 3, v1.1 fixed schedules): EN-1, EN-2, EN-4..EN-8, SC-5, NF-1, NF-3.
// Default clock: Wed 14 Oct 2026 10:00 in Los Angeles. The default schedule
// ("Afternoon Study") meets Mon/Wed/Fri 13:00-16:00 in the Fall 2026 term (Aug 17 - Dec 18).
// Every enrollment and waitlist row is one whole schedule (weekday = 0, D-42).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, at, load, ROOT } = require('./lib');

const LA = 'America/Los_Angeles';

async function world({ capacity = 10, weekdays = '1,3,5' } = {}) {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const sess = t.fx.session(loc, { capacity, weekdays });
  return { t, loc, sess };
}
const enroll = (t, parent, student, session) =>
  t.as(parent).post('/api/enrollment/enroll', { studentId: student.id, sessionId: session.id });
const joinLine = (t, parent, student, session) =>
  t.as(parent).post('/api/enrollment/waitlist', { studentId: student.id, sessionId: session.id });
const drop = (t, parent, enrollmentId) => t.as(parent).post(`/api/enrollment/enrollments/${enrollmentId}/drop`);
const active = (t, student) => t.db.prepare("SELECT * FROM enrollments WHERE student_id = ? AND status = 'active' ORDER BY id").all(student.id);
const seats = (t, session) => t.db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND status = 'active'").get(session.id).n;
const lineRow = (t, student, session) => t.db.prepare('SELECT * FROM waitlist WHERE student_id = ? AND session_id = ? ORDER BY id DESC').get(student.id, session.id);
const fill = (t, loc, session, n) => Array.from({ length: n }, () => { const f = t.fx.family(loc); t.fx.enroll(f.student, session); return f; });
const snapshot = t => JSON.stringify(['enrollments', 'waitlist', 'enrollment_requests'].map(tb => t.db.prepare(`SELECT * FROM ${tb} ORDER BY id`).all()));
const catalogOf = (t, f, student = f.student) => t.as(f.parent).get(`/api/enrollment/students/${student.id}/catalog`);
const rowOf = (cat, session) => cat.body.schedules.find(s => s.session_id === session.id);
const dates = async (t, u, student, from, to) => (await t.as(u).get(`/api/enrollment/students/${student.id}/schedule?from=${from}&to=${to}`)).body.occurrences;
const named = (t, f, student, parent) => {
  t.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(student, f.student.id);
  f.student.name = student;
  if (parent) { t.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(parent, f.parent.id); f.parent.name = parent; }
  return f;
};

// ---------------------------------------------------------------- EN-1, EN-2

test(['EN-1', 'EN-2'], 'a parent enrolls a student in one whole schedule: one row covers every meeting date of its period', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  // A weekday in the body is ignored: the family picks the schedule, never a day (D-42).
  const r = await t.as(f.parent).post('/api/enrollment/enroll', { studentId: f.student.id, sessionId: sess.id, weekday: 3 });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.outcome, r.body.switched_from, r.body.waitlists_left], ['enrolled', null, []]);
  const rows = active(t, f.student);
  assert.deepEqual(rows.map(e => [e.session_id, e.weekday, e.source, e.created_by]), [[sess.id, 0, 'parent', f.parent.id]]);
  assert.equal(r.body.enrollment.id, rows[0].id);
  // Every Mon, Wed and Fri from today through the end of the period (Dec 18), nothing before or after.
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-10-12', '2026-10-25')).map(o => `${o.date} ${o.status}`),
    ['2026-10-14 upcoming', '2026-10-16 upcoming', '2026-10-19 upcoming', '2026-10-21 upcoming', '2026-10-23 upcoming']);
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-12-14', '2026-12-31')).map(o => o.date), ['2026-12-14', '2026-12-16', '2026-12-18']);
  // The family overview shows the schedule, its days a week and the membership's cap in days.
  const fam = (await t.as(f.parent).get('/api/enrollment/students')).body.students;
  assert.deepEqual(fam.map(x => x.id), [f.student.id]);
  assert.deepEqual(fam[0].enrollments.map(e => [e.session_id, e.name, e.weekdays, e.days_per_week, e.status, e.term_name, e.term_start, e.term_end]),
    [[sess.id, 'Afternoon Study', '1,3,5', 3, 'active', 'Fall 2026', '2026-08-17', '2026-12-18']]);
  const m = fam[0].membership;
  assert.deepEqual([m.weekly_cap, m.held_days, m.can_add, m.code, m.message], [3, 3, true, 'ok', null]);
  assert.ok(!('used' in m), 'the v1 slot count is gone');
});

test(['EN-2'], 'the whole family gets one notice naming the days, times and dates of the schedule', async () => {
  const { t, loc, sess } = await world();
  const f = named(t, t.fx.family(loc), 'Leo Garcia');
  const guardian = t.fx.user('parent', { location: loc });
  t.fx.link(guardian, f.student);
  const r = await enroll(t, f.parent, f.student, sess);
  assert.equal(r.status, 201);
  for (const u of [f.parent, guardian, f.student]) {
    assert.deepEqual(t.fx.notifications(u).map(n => [n.kind, n.title, n.body, n.ref_type, n.ref_id]), [['enrollment_confirmed',
      'Leo is enrolled in Afternoon Study at Irvine', 'Mon, Wed, Fri 1:00-4:00 PM, Oct 14 - Dec 18.', 'enrollment', r.body.enrollment.id]], u.role);
  }
});

test(['EN-2', 'NF-1'], 'only a linked parent can enroll: not another family, a pending link, the student or staff', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc), other = t.fx.family(loc);
  const pending = t.fx.user('parent', { location: loc });
  t.fx.link(pending, f.student, 'pending');
  assert.equal((await enroll(t, other.parent, f.student, sess)).status, 403);
  assert.equal((await enroll(t, pending, f.student, sess)).status, 403);
  assert.equal((await enroll(t, f.student, f.student, sess)).status, 403);
  assert.equal((await enroll(t, t.fx.staff(loc), f.student, sess)).status, 403);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
});

test(['EN-2', 'NF-1'], 'students no longer request schedules: the request routes answer 404 for everyone (D-48)', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const before = snapshot(t);
  for (const u of [f.parent, f.student, t.fx.hq()]) {
    assert.equal((await t.as(u).get('/api/enrollment/requests')).status, 404, u.role);
    assert.equal((await t.as(u).post('/api/enrollment/requests', { sessionId: sess.id })).status, 404, u.role);
    assert.equal((await t.as(u).post('/api/enrollment/requests/1/approve')).status, 404, u.role);
    assert.equal((await t.as(u).post('/api/enrollment/requests/1/decline')).status, 404, u.role);
  }
  assert.equal(snapshot(t), before);
  assert.ok(!t.jobs().includes('enrollment.close-gone-requests'), 'the request job is gone');
});

test(['EN-1'], 'clear refusals: a cancelled schedule, one with no dates left (closures and skips count), or one already held', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-07' });
  const old = t.fx.session(loc, { term: summer, name: 'Summer Study' });
  const gone = t.fx.session(loc, { name: 'Evening Study' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(gone.id);
  const a = await enroll(t, f.parent, f.student, old);
  assert.deepEqual([a.status, a.body.error, a.body.message], [409, 'no_dates_left', 'Summer Study has no dates left in Summer 2026.']);
  const b = await enroll(t, f.parent, f.student, gone);
  assert.deepEqual([b.status, b.body.error], [409, 'session_cancelled']);
  // A short period whose last dates are a closure (Wed) and a skipped date (Fri) has nothing left either.
  const week = t.fx.term(loc, { name: 'Last Week', start: '2026-10-12', end: '2026-10-16' });
  const last = t.fx.session(loc, { term: week, name: 'Last Days', weekdays: '3,5' });
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(loc.id, '2026-10-14', 'Power work');
  const skip = t.fx.sessionDate(last, '2026-10-16', 'skip');
  const c = await enroll(t, f.parent, f.student, last);
  assert.deepEqual([c.status, c.body.error], [409, 'no_dates_left']);
  const w = await joinLine(t, f.parent, f.student, last);
  assert.deepEqual([w.status, w.body.error], [409, 'no_dates_left']);
  let cat = await catalogOf(t, f);
  assert.deepEqual(cat.body.schedules.map(s => s.name), ['Afternoon Study'], 'the catalog lists only schedules with a date left');
  // Undo the skip: Friday is its one date left, and the notice starts from it.
  t.db.prepare('DELETE FROM session_dates WHERE id = ?').run(skip.id);
  cat = await catalogOf(t, f);
  assert.deepEqual(rowOf(cat, last) && [rowOf(cat, last).first_date, rowOf(cat, last).dates_left, rowOf(cat, last).dates_total], ['2026-10-16', 1, 1], 'the closure is not one of its dates');
  const ok = await enroll(t, f.parent, f.student, last);
  assert.equal(ok.status, 201);
  assert.equal(t.fx.notifications(f.parent, 'enrollment_confirmed')[0].body, 'Wed, Fri 1:00-4:00 PM, Oct 16 - Oct 16.');
  const again = await enroll(t, f.parent, f.student, last);
  assert.deepEqual([again.status, again.body.error], [409, 'already_enrolled']);
  assert.equal(active(t, f.student).length, 1);
});

// ---------------------------------------------------------------- EN-4

test(['EN-4'], 'blocked when the membership is missing, inactive or already over, with the reason spelled out', async () => {
  const { t, loc, sess } = await world();
  const off = named(t, t.fx.family(loc, { status: 'inactive' }), 'Leo Garcia');
  const r = await enroll(t, off.parent, off.student, sess);
  assert.deepEqual([r.status, r.body.error, r.body.code, r.body.outcome, r.body.message],
    [409, 'membership_inactive', 'membership_inactive', 'blocked', "Leo's membership isn't active. Ask the front desk."]);
  const none = named(t, t.fx.family(loc), 'Ana Diaz');
  t.db.prepare('DELETE FROM memberships WHERE student_id = ?').run(none.student.id);
  const r2 = await enroll(t, none.parent, none.student, sess);
  assert.deepEqual([r2.status, r2.body.error, r2.body.message], [409, 'no_membership', 'Ana has no membership yet. Ask the front desk.']);
  const over = named(t, t.fx.family(loc, { expires: '2026-09-30' }), 'Cy Park');
  const r3 = await enroll(t, over.parent, over.student, sess);
  assert.deepEqual([r3.status, r3.body.error, r3.body.message], [409, 'membership_expired', "Cy's membership ended Sep 30. Renew it first."]);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  // The family overview says the same before the server is asked.
  const fam = (await t.as(over.parent).get('/api/enrollment/students')).body.students[0].membership;
  assert.deepEqual([fam.can_add, fam.code, fam.message], [false, 'membership_expired', "Cy's membership ended Sep 30. Renew it first."]);
});

test(['EN-4'], "expiry is judged by the location's local date, and the last day still counts", async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '23:30') }); // already Oct 15 in UTC and in Toronto
  const la = t.fx.location({ name: 'Irvine' });
  const to = t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  const sLA = t.fx.session(la), sTO = t.fx.session(to);
  const a = t.fx.family(la, { expires: '2026-10-14' });
  const b = t.fx.family(to, { expires: '2026-10-14' });
  const ok = await enroll(t, a.parent, a.student, sLA);
  assert.equal(ok.status, 201, 'Oct 14 is still the last valid day in Los Angeles');
  const no = await enroll(t, b.parent, b.student, sTO);
  assert.deepEqual([no.status, no.body.error], [409, 'membership_expired']);
  assert.match(no.body.message, /ended Oct 14\. Renew it first\.$/);
  assert.equal(active(t, b.student).length, 0);
});

// D-43: the membership must be valid on the schedule's first meeting date on or after today (F).
test(['EN-4'], "the membership is checked against the schedule's first date, not today: enrolling ahead works, a period after it ends doesn't", async () => {
  const t = await makeApp({ now: at(LA, '2026-10-28', '10:00') }); // Wed Oct 28
  const loc = t.fx.location({ name: 'Irvine' });
  const fall = t.fx.session(loc); // Afternoon Study MWF, next date today
  const novTerm = t.fx.term(loc, { name: 'November 2026', start: '2026-11-02', end: '2026-11-30' });
  const nov = t.fx.session(loc, { term: novTerm, name: 'November Afternoons', weekdays: '1,3,5' }); // first date Mon Nov 2
  const janTerm = t.fx.term(loc, { name: 'January 2027', start: '2027-01-04', end: '2027-01-29' });
  const jan = t.fx.session(loc, { term: janTerm, name: 'January Mornings MWF', weekdays: '1,3,5', start: '09:00', end: '12:00' });
  // A renewal that starts Nov 1 can't join the running Fall schedule, but can enroll now in November.
  const renew = named(t, t.fx.family(loc, { start: '2026-11-01' }), 'Leo Garcia');
  const r = await enroll(t, renew.parent, renew.student, fall);
  assert.deepEqual([r.status, r.body.error, r.body.message], [409, 'membership_not_started',
    "Leo's membership starts Nov 1, after this schedule's next date (Oct 28). Choose a schedule that starts on or after Nov 1."]);
  const cat = await catalogOf(t, renew);
  assert.deepEqual(cat.body.schedules.map(s => [s.name, s.first_date, s.block && s.block.code, s.can_add]), [
    ['Afternoon Study', '2026-10-28', 'membership_not_started', false],
    ['November Afternoons', '2026-11-02', null, true],
    ['January Mornings MWF', '2027-01-04', null, true],
  ]);
  assert.equal(cat.body.membership.can_add, true, 'the membership itself is fine; each schedule carries its own block');
  assert.equal((await enroll(t, renew.parent, renew.student, nov)).status, 201);
  // Starting on the first date itself is fine.
  const onTheDay = t.fx.family(loc, { start: '2026-11-02' });
  assert.equal((await enroll(t, onTheDay.parent, onTheDay.student, nov)).status, 201);
  // A membership ending Dec 31 can't enroll in January, but may end partway through the period it joins (MB-5 pauses it then).
  const ending = named(t, t.fx.family(loc, { expires: '2026-12-31' }), 'Sofia Garcia');
  const j = await enroll(t, ending.parent, ending.student, jan);
  assert.deepEqual([j.status, j.body.error, j.body.message], [409, 'membership_ends_first',
    "Sofia's membership ends Dec 31, before January Mornings MWF starts (Jan 4). Renew it first."]);
  assert.equal((await enroll(t, ending.parent, ending.student, fall)).status, 201);
  const lastDay = t.fx.family(loc, { expires: '2027-01-04' });
  assert.equal((await enroll(t, lastDay.parent, lastDay.student, jan)).status, 201, 'valid on its first date');
});

test(['EN-4'], 'the weekly cap is days a week: a schedule meeting more days than the cap is blocked, one that fits is not', async () => {
  const { t, loc, sess } = await world();
  const tth = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const two = named(t, t.fx.family(loc, { cap: 2 }), 'Anh Nguyen');
  const r = await enroll(t, two.parent, two.student, sess);
  assert.deepEqual([r.status, r.body.error, r.body.message], [409, 'weekly_cap', 'Afternoon Study meets 3 days a week. Anh\'s membership allows 2.']);
  assert.equal((await enroll(t, two.parent, two.student, tth)).status, 201);
  const three = t.fx.family(loc, { cap: 3 });
  assert.equal((await enroll(t, three.parent, three.student, sess)).status, 201, '3 days fit a cap of 3');
  // Holding a schedule in another period uses up nothing: the cap is one comparison per schedule.
  const jan = t.fx.session(loc, { term: t.fx.term(loc, { name: 'January 2027', start: '2027-01-04', end: '2027-01-29' }), name: 'January Study' });
  assert.equal((await enroll(t, three.parent, three.student, jan)).status, 201);
  assert.deepEqual(active(t, three.student).map(e => e.session_id), [sess.id, jan.id]);
  assert.equal((await t.as(three.parent).get('/api/enrollment/students')).body.students[0].membership.held_days, 3, 'the most days of any one schedule held');
  const one = t.fx.family(loc, { cap: 1 });
  const solo = t.fx.session(loc, { name: 'Friday Lab', weekdays: '5', start: '16:00', end: '18:00' });
  assert.equal((await enroll(t, one.parent, one.student, solo)).status, 201);
  assert.equal((await t.as(one.parent).get('/api/enrollment/students')).body.students[0].membership.held_days, 1);
});

test(['EN-4', 'EN-5'], 'joining the waitlist runs the same membership, date and cap checks', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  fill(t, loc, sess, 1);
  const inactive = t.fx.family(loc, { status: 'inactive' });
  const r = await joinLine(t, inactive.parent, inactive.student, sess);
  assert.deepEqual([r.status, r.body.error], [409, 'membership_inactive']);
  const capped = t.fx.family(loc, { cap: 2 });
  const r2 = await joinLine(t, capped.parent, capped.student, sess);
  assert.deepEqual([r2.status, r2.body.error], [409, 'weekly_cap']);
  const later = t.fx.family(loc, { start: '2026-11-01' });
  const r3 = await joinLine(t, later.parent, later.student, sess);
  assert.deepEqual([r3.status, r3.body.error], [409, 'membership_not_started']);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n, 0);
});

test(['EN-4'], 'every catalog block is exactly what the server answers, schedule by schedule', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const tth = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const janTerm = t.fx.term(loc, { name: 'January 2027', start: '2027-01-04', end: '2027-01-29' });
  t.fx.session(loc, { term: janTerm, name: 'January Study', weekdays: '2' });
  fill(t, loc, sess, 1);
  const f = t.fx.family(loc, { cap: 2, expires: '2026-12-31' });
  const cat = (await catalogOf(t, f)).body.schedules;
  assert.deepEqual(cat.map(s => [s.name, s.block && s.block.code, s.can_add]), [
    ['Morning Focus', null, true], ['Afternoon Study', 'weekly_cap', false], ['January Study', 'membership_ends_first', false],
  ]);
  for (const s of cat.filter(x => x.block)) {
    for (const call of [enroll, joinLine]) {
      const r = await call(t, f.parent, f.student, { id: s.session_id });
      assert.deepEqual([r.status, r.body.error, r.body.message], [409, s.block.code, s.block.message], s.name);
    }
  }
  assert.equal((await enroll(t, f.parent, f.student, tth)).status, 201);
});

// ---------------------------------------------------------------- EN-5, EN-6

test(['EN-5'], 'a full schedule offers the waitlist, and places are first come, first served', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  fill(t, loc, sess, 1);
  const a = t.fx.family(loc), b = t.fx.family(loc), c = t.fx.family(loc);
  const full = await enroll(t, a.parent, a.student, sess);
  assert.deepEqual([full.status, full.body.error, full.body.outcome, full.body.waiting], [409, 'full', 'full', 0]);
  assert.match(full.body.message, /^Afternoon Study is full\. Join the waitlist and \S+ will be enrolled automatically when a seat opens\.$/);
  assert.equal(active(t, a.student).length, 0);
  const ja = await joinLine(t, a.parent, a.student, sess);
  assert.deepEqual([ja.status, ja.body.outcome, ja.body.position, ja.body.keeps, ja.body.waitlist.weekday], [201, 'waitlisted', 1, null, 0]);
  assert.equal((await joinLine(t, b.parent, b.student, sess)).body.position, 2);
  assert.equal((await joinLine(t, c.parent, c.student, sess)).body.position, 3);
  const again = await joinLine(t, b.parent, b.student, sess);
  assert.deepEqual([again.status, again.body.error], [409, 'already_waiting']);
  const still = await enroll(t, b.parent, b.student, sess);
  assert.match(still.body.message, /^Afternoon Study is still full\. \S+ is number 2 on the waitlist\.$/);
  // b's catalog shows where they stand.
  const row = rowOf(await catalogOf(t, b), sess);
  assert.deepEqual([row.mine, row.position, row.waiting, row.seats_left, row.can_add], ['waiting', 2, 3, 0, false]);
  const fam = (await t.as(b.parent).get('/api/enrollment/students')).body.students[0];
  assert.deepEqual(fam.waitlist.map(w => [w.session_id, w.name, w.weekdays, w.position, w.in_line, w.keeps]), [[sess.id, 'Afternoon Study', '1,3,5', 2, 3, null]]);
  // Leaving the line moves everyone behind up.
  assert.equal((await t.as(a.parent).post(`/api/enrollment/waitlist/${ja.body.waitlist.id}/leave`)).status, 200);
  assert.equal(lineRow(t, a.student, sess).status, 'removed');
  assert.equal(rowOf(await catalogOf(t, b), sess).position, 1);
});

test(['EN-5', 'EN-6'], 'dropping frees the seat, and the first family in line is enrolled at once and notified', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const holder = t.fx.family(loc);
  const e = t.fx.enroll(holder.student, sess);
  const a = named(t, t.fx.family(loc), 'Isha Patel'), b = t.fx.family(loc);
  assert.equal((await joinLine(t, a.parent, a.student, sess)).status, 201);
  t.clock.advance(60000);
  assert.equal((await joinLine(t, b.parent, b.student, sess)).status, 201);
  t.clock.advance(60000);
  const r = await drop(t, holder.parent, e.id);
  assert.equal(r.status, 200);
  const dropped = t.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e.id);
  assert.deepEqual([dropped.status, dropped.ended_at], ['dropped', t.clock.now()]);
  assert.deepEqual(active(t, a.student).map(x => [x.session_id, x.weekday, x.source]), [[sess.id, 0, 'waitlist']]);
  assert.deepEqual([lineRow(t, a.student, sess).status, lineRow(t, a.student, sess).resolved_at], ['enrolled', t.clock.now()]);
  assert.equal(lineRow(t, b.student, sess).status, 'waiting');
  assert.equal(seats(t, sess), 1);
  for (const u of [a.parent, a.student]) {
    assert.deepEqual(t.fx.notifications(u).map(n => [n.kind, n.title, n.body, n.ref_type]), [['waitlist_promoted',
      'A seat opened: Isha is now enrolled in Afternoon Study', 'Mon, Wed, Fri 1:00-4:00 PM through Dec 18.', 'enrollment']]);
  }
  assert.equal(t.fx.notifications(b.parent).length, 0);
  assert.equal(t.fx.notifications(holder.parent).length, 0);
});

test(['EN-5'], 'anyone ahead who fails a check is skipped but keeps their place: lapsed, over the cap, or not valid on the first date', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const holder = t.fx.family(loc);
  const e = t.fx.enroll(holder.student, sess);
  const lapsed = t.fx.family(loc), capped = t.fx.family(loc), early = t.fx.family(loc), ok = t.fx.family(loc);
  for (const f of [lapsed, capped, early, ok]) { await joinLine(t, f.parent, f.student, sess); t.clock.advance(60000); }
  t.fx.membership(lapsed.student, { status: 'inactive' }); // lapsed while waiting
  t.fx.membership(capped.student, { cap: 2 }); // limit lowered while waiting
  t.fx.membership(early.student, { start: '2026-10-20' }); // renewed to start after the next date (today)
  assert.equal((await drop(t, holder.parent, e.id)).status, 200);
  assert.deepEqual([lapsed, capped, early, ok].map(f => active(t, f.student).length), [0, 0, 0, 1]);
  assert.deepEqual([lapsed, capped, early].map(f => lineRow(t, f.student, sess).status), ['waiting', 'waiting', 'waiting']);
  assert.equal(rowOf(await catalogOf(t, lapsed), sess).position, 1);
  // Renewed, and the next free seat is theirs.
  t.fx.membership(lapsed.student, { status: 'active' });
  t.db.prepare('UPDATE sessions SET capacity = 2 WHERE id = ?').run(sess.id);
  t.jobs();
  assert.equal(active(t, lapsed.student).length, 1);
  assert.equal(active(t, early.student).length, 0);
});

test(['EN-5'], 'a renewal waiting at the front goes first, and its paused schedule comes back as the same row', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const holder = t.fx.family(loc);
  const e = t.fx.enroll(holder.student, sess);
  const early = t.fx.family(loc), renewed = t.fx.family(loc);
  await joinLine(t, early.parent, early.student, sess);
  t.clock.advance(60000);
  // D-16: the renewed student's paused schedule is at the front of the line.
  const paused = t.fx.enroll(renewed.student, sess, 0, { status: 'paused' });
  t.fx.waitlist(renewed.student, sess, { priority: 1 });
  await drop(t, holder.parent, e.id);
  const rows = t.db.prepare('SELECT * FROM enrollments WHERE student_id = ? ORDER BY id').all(renewed.student.id);
  assert.deepEqual(rows.map(r => [r.id, r.status]), [[paused.id, 'active']]);
  assert.equal(active(t, early.student).length, 0);
  assert.equal(lineRow(t, early.student, sess).status, 'waiting');
});

test(['EN-5', 'NF-3'], 'the scheduled job fills seats freed by a capacity raise or a lapsed membership, never past capacity', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const [holder] = fill(t, loc, sess, 1);
  const fams = [t.fx.family(loc), t.fx.family(loc), t.fx.family(loc)];
  for (const f of fams) { await joinLine(t, f.parent, f.student, sess); t.clock.advance(60000); }
  t.db.prepare('UPDATE sessions SET capacity = 3 WHERE id = ?').run(sess.id);
  const ran = t.jobs();
  assert.ok(ran.includes('enrollment.promote-waitlists'));
  assert.deepEqual(fams.map(f => active(t, f.student).length), [1, 1, 0]);
  assert.equal(seats(t, sess), 3);
  // The holder's membership lapses: the schedule is paused and no longer holds a seat (MB-5).
  t.fx.membership(holder.student, { status: 'inactive' });
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE student_id = ?").run(holder.student.id);
  t.jobs();
  assert.deepEqual(fams.map(f => active(t, f.student).length), [1, 1, 1]);
  assert.equal(seats(t, sess), 3);
  assert.equal(t.fx.notifications(fams[2].parent, 'waitlist_promoted').length, 1);
});

test(['EN-5'], 'direct enrollment serves the waitlist first, so nobody jumps the line', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  fill(t, loc, sess, 1);
  const waiting = t.fx.family(loc), late = t.fx.family(loc);
  await joinLine(t, waiting.parent, waiting.student, sess);
  t.db.prepare('UPDATE sessions SET capacity = 2 WHERE id = ?').run(sess.id); // job has not run yet
  const r = await enroll(t, late.parent, late.student, sess);
  assert.deepEqual([r.status, r.body.error], [409, 'full']);
  assert.equal(active(t, waiting.student).length, 1);
  assert.equal(active(t, late.student).length, 0);
  // Someone already in line who enrolls as a seat opens simply takes it.
  const next = t.fx.family(loc);
  await joinLine(t, next.parent, next.student, sess);
  t.db.prepare('UPDATE sessions SET capacity = 3 WHERE id = ?').run(sess.id);
  const mine = await enroll(t, next.parent, next.student, sess);
  assert.deepEqual([mine.status, mine.body.outcome, mine.body.enrollment.source], [201, 'enrolled', 'waitlist']);
  // Joining the line of a schedule with a free seat enrolls at once.
  t.db.prepare('UPDATE sessions SET capacity = 4 WHERE id = ?').run(sess.id);
  const free = t.fx.family(loc);
  const j = await joinLine(t, free.parent, free.student, sess);
  assert.deepEqual([j.status, j.body.outcome, j.body.enrollment.session_id, j.body.switched_from], [201, 'enrolled', sess.id, null]);
  assert.equal(t.fx.notifications(free.parent, 'waitlist_promoted').length, 1);
});

test(['EN-5', 'EN-6'], 'a paused schedule holds no seat and is shown as paused', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const lapsed = t.fx.family(loc, { status: 'inactive' });
  t.fx.enroll(lapsed.student, sess, 0, { status: 'paused' });
  const f = t.fx.family(loc);
  assert.equal((await enroll(t, f.parent, f.student, sess)).status, 201);
  assert.equal(seats(t, sess), 1);
  assert.equal(rowOf(await catalogOf(t, lapsed), sess).mine, 'paused');
  const fam = await t.as(lapsed.student).get('/api/enrollment/students');
  assert.deepEqual(fam.body.students[0].enrollments.map(e => e.status), ['paused']);
  const again = await enroll(t, lapsed.parent, lapsed.student, sess);
  assert.deepEqual([again.status, again.body.error], [409, 'already_enrolled']);
  assert.match(again.body.message, /paused until the membership is renewed\.$/);
});

// D-42 / D-54: a live v1 per-day row is history; it takes no seat, no place in line and no part in D-43.
test(['EN-5', 'EN-8'], 'live v1 per-day rows count for nothing: no seat, no place in line, no switch', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const v1 = t.fx.family(loc);
  t.fx.enroll(v1.student, sess, 1); // a v1 Monday row still marked active
  const w1 = t.fx.family(loc);
  t.fx.waitlist(w1.student, sess, { weekday: 3 }); // a v1 Wednesday waiting row
  const f = t.fx.family(loc);
  const r = await enroll(t, f.parent, f.student, sess);
  assert.equal(r.status, 201, 'the v1 row holds no seat');
  assert.deepEqual([rowOf(await catalogOf(t, w1), sess).waiting, rowOf(await catalogOf(t, w1), sess).mine], [0, null]);
  // The v1 student enrolling in another Fall schedule is not a switch, and holds no days.
  const tth = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const s = await enroll(t, v1.parent, v1.student, tth);
  assert.deepEqual([s.status, s.body.switched_from], [201, null]);
  assert.deepEqual(active(t, v1.student).map(e => [e.session_id, e.weekday]), [[sess.id, 1], [tth.id, 0]]);
  assert.equal((await t.as(v1.parent).get('/api/enrollment/students')).body.students[0].membership.held_days, 2, 'Morning Focus only');
  assert.deepEqual((await t.as(w1.parent).get('/api/enrollment/students')).body.students[0].waitlist, []);
});

// ---------------------------------------------------------------- NF-3

test(['NF-3'], 'families racing for the last seats: exactly as many enroll as there are seats', async () => {
  const { t, loc, sess } = await world({ capacity: 3 });
  fill(t, loc, sess, 1);
  const fams = Array.from({ length: 6 }, () => t.fx.family(loc));
  const res = await Promise.all(fams.map(f => enroll(t, f.parent, f.student, sess)));
  assert.deepEqual(res.map(r => r.status).sort(), [201, 201, 409, 409, 409, 409]);
  assert.ok(res.filter(r => r.status === 409).every(r => r.body.error === 'full'));
  assert.equal(seats(t, sess), 3);
  // The last seat, two families at once.
  t.db.prepare('UPDATE sessions SET capacity = 4 WHERE id = ?').run(sess.id);
  const two = [t.fx.family(loc), t.fx.family(loc)];
  const r2 = await Promise.all(two.map(f => enroll(t, f.parent, f.student, sess)));
  assert.deepEqual(r2.map(r => r.status).sort(), [201, 409]);
  assert.equal(seats(t, sess), 4);
});

// ---------------------------------------------------------------- EN-8: one schedule per period (D-43, D-44)

test(['EN-8', 'EN-5'], 'enrolling in an overlapping schedule switches: the old one ends, its seat goes to its line, and one notice says both', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const f = named(t, t.fx.family(loc), 'Leo Garcia');
  const first = await enroll(t, f.parent, f.student, sess);
  assert.equal(first.status, 201);
  const next = named(t, t.fx.family(loc), 'Isha Patel');
  assert.equal((await joinLine(t, next.parent, next.student, sess)).body.position, 1);
  t.clock.advance(60000);
  const r = await enroll(t, f.parent, f.student, morning);
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.switched_from, r.body.waitlists_left], [{ id: first.body.enrollment.id, name: 'Afternoon Study' }, []]);
  const old = t.db.prepare('SELECT status, ended_at FROM enrollments WHERE id = ?').get(first.body.enrollment.id);
  assert.deepEqual([old.status, old.ended_at], ['dropped', t.clock.now()]);
  assert.deepEqual(active(t, f.student).map(e => [e.session_id, e.weekday]), [[morning.id, 0]]);
  // The seat it freed went to the line in the same request.
  assert.deepEqual(active(t, next.student).map(e => e.session_id), [sess.id]);
  assert.equal(t.fx.notifications(next.parent, 'waitlist_promoted').length, 1);
  // One notice per person for the switch, naming what ended.
  for (const u of [f.parent, f.student]) {
    const n = t.fx.notifications(u);
    assert.deepEqual(n.map(x => x.kind), ['enrollment_confirmed', 'enrollment_confirmed'], u.role);
    assert.deepEqual([n[1].title, n[1].body, n[1].ref_id], ['Leo is enrolled in Morning Focus at Irvine',
      'Tue, Thu 9:30 AM-12:00 PM, Oct 15 - Dec 18. Afternoon Study has ended for Leo.', r.body.enrollment.id]);
  }
});

test(['EN-8'], 'schedules in periods that do not overlap are held together; overlap is by the terms\' real dates', async () => {
  const { t, loc, sess } = await world();
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const jan = t.fx.session(loc, { term: t.fx.term(loc, { name: 'January 2027', start: '2027-01-04', end: '2027-01-29' }), name: 'January Study' });
  const breakTerm = t.fx.term(loc, { name: 'Winter Break', start: '2026-12-18', end: '2026-12-31' });
  const camp = t.fx.session(loc, { term: breakTerm, name: 'Winter Camp', weekdays: '5' }); // Dec 18 and 25: overlaps Fall on Dec 18
  const f = t.fx.family(loc);
  const fall = await enroll(t, f.parent, f.student, sess);
  // The catalog says which choices are switches, and from what.
  let cat = await catalogOf(t, f);
  assert.deepEqual(cat.body.schedules.map(s => [s.name, s.mine, s.switch_from && s.switch_from.name, s.can_add]), [
    ['Morning Focus', null, 'Afternoon Study', true], ['Afternoon Study', 'enrolled', null, false],
    ['Winter Camp', null, 'Afternoon Study', true], ['January Study', null, null, true],
  ]);
  assert.equal(rowOf(cat, morning).switch_from.enrollment_id, fall.body.enrollment.id);
  const j = await enroll(t, f.parent, f.student, jan);
  assert.deepEqual([j.status, j.body.switched_from], [201, null]);
  assert.deepEqual(active(t, f.student).map(e => e.session_id), [sess.id, jan.id], 'Fall and January together');
  // Winter Camp shares Dec 18 with Fall, so it is a switch from Fall but not from January.
  const c = await enroll(t, f.parent, f.student, camp);
  assert.equal(c.body.switched_from.name, 'Afternoon Study');
  assert.deepEqual(active(t, f.student).map(e => e.session_id), [jan.id, camp.id]);
  // And the other way: holding Winter Camp, Fall (ending Dec 18) is a switch too.
  const g = t.fx.family(loc);
  t.fx.enroll(g.student, camp);
  const back = await enroll(t, g.parent, g.student, morning);
  assert.equal(back.body.switched_from.name, 'Winter Camp');
  // A paused schedule in the period is replaced the same way.
  const h = t.fx.family(loc);
  const paused = t.fx.enroll(h.student, sess, 0, { status: 'paused' });
  assert.equal((await enroll(t, h.parent, h.student, morning)).body.switched_from.id, paused.id);
  assert.equal(t.db.prepare('SELECT status FROM enrollments WHERE id = ?').get(paused.id).status, 'dropped');
  cat = await catalogOf(t, h);
  assert.equal(rowOf(cat, morning).switch_from, null, 'nothing to switch from in a schedule already held');
});

test(['EN-8', 'EN-5'], 'a drop that promotes a switch cascades through every line it frees, in the same request', async () => {
  const { t, loc } = await world();
  const quiet = (name, weekdays) => t.fx.session(loc, { name, weekdays, start: '16:30', end: '18:30', capacity: 1 });
  const s1 = quiet('Quiet A', '2'), s2 = quiet('Quiet B', '4'), s3 = quiet('Quiet C', '5');
  const holder = t.fx.family(loc);
  const h = t.fx.enroll(holder.student, s1);
  const ana = named(t, t.fx.family(loc), 'Ana Diaz'), ben = named(t, t.fx.family(loc), 'Ben Ito'), cy = named(t, t.fx.family(loc), 'Cy Park');
  t.fx.enroll(ana.student, s2); t.fx.waitlist(ana.student, s1);
  t.fx.enroll(ben.student, s3); t.fx.waitlist(ben.student, s2);
  t.fx.waitlist(cy.student, s3);
  assert.equal((await drop(t, holder.parent, h.id)).status, 200);
  assert.deepEqual([ana, ben, cy].map(f => active(t, f.student).map(e => e.session_id)), [[s1.id], [s2.id], [s3.id]]);
  assert.deepEqual([s1, s2, s3].map(s => seats(t, s)), [1, 1, 1]);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE status = 'waiting'").get().n, 0);
  const told = f => t.fx.notifications(f.parent).map(n => [n.kind, n.title, n.body]);
  assert.deepEqual(told(ana), [['waitlist_promoted', 'A seat opened: Ana moved to Quiet A', 'Tue 4:30-6:30 PM through Dec 18. Quiet B has ended for Ana.']]);
  assert.deepEqual(told(ben), [['waitlist_promoted', 'A seat opened: Ben moved to Quiet B', 'Thu 4:30-6:30 PM through Dec 18. Quiet C has ended for Ben.']]);
  assert.deepEqual(told(cy), [['waitlist_promoted', 'A seat opened: Cy is now enrolled in Quiet C', 'Fri 4:30-6:30 PM through Dec 18.']]);
});

test(['EN-8', 'EN-5'], 'taking a seat removes the other waiting spots in overlapping periods, keeps the rest, and the notice says so', async () => {
  const { t, loc, sess } = await world();
  const quiet = (name, weekdays, term) => t.fx.session(loc, { term, name, weekdays, start: '16:30', end: '18:30', capacity: 1 });
  const jan = t.fx.term(loc, { name: 'January 2027', start: '2027-01-04', end: '2027-01-29' });
  const qa = quiet('Quiet A', '2'), qb = quiet('Quiet B', '4'), qj = quiet('Quiet January', '2', jan);
  for (const s of [qa, qb, qj]) fill(t, loc, s, 1);
  const f = named(t, t.fx.family(loc), 'Leo Garcia');
  for (const s of [qa, qb, qj]) assert.equal((await joinLine(t, f.parent, f.student, s)).body.outcome, 'waitlisted', 'waiting for two in one period is allowed');
  const r = await enroll(t, f.parent, f.student, sess);
  assert.deepEqual(r.body.waitlists_left, ['Quiet A', 'Quiet B']);
  assert.deepEqual([qa, qb, qj].map(s => lineRow(t, f.student, s).status), ['removed', 'removed', 'waiting']);
  assert.equal(lineRow(t, f.student, qa).resolved_at, t.clock.now());
  assert.equal(t.fx.notifications(f.parent, 'enrollment_confirmed')[0].body,
    'Mon, Wed, Fri 1:00-4:00 PM, Oct 14 - Dec 18. Leo left the waitlist for Quiet A, Quiet B.');
  // By promotion too: Sofia waits for Quiet A and Quiet B; a Quiet B seat opens.
  const s = named(t, t.fx.family(loc), 'Sofia Garcia');
  await joinLine(t, s.parent, s.student, qa);
  await joinLine(t, s.parent, s.student, qb);
  const holder = t.db.prepare("SELECT * FROM enrollments WHERE session_id = ? AND status = 'active'").get(qb.id);
  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(t.clock.now(), holder.id);
  t.jobs();
  assert.deepEqual(active(t, s.student).map(e => e.session_id), [qb.id]);
  assert.equal(lineRow(t, s.student, qa).status, 'removed');
  assert.equal(t.fx.notifications(s.parent, 'waitlist_promoted')[0].body, 'Thu 4:30-6:30 PM through Dec 18. Sofia left the waitlist for Quiet A.');
});

test(['EN-8', 'EN-5'], 'a family waits for a full schedule while keeping its own, and a seat moves the student over', async () => {
  const { t, loc } = await world();
  const tth = t.fx.session(loc, { name: 'Afternoons TTh', weekdays: '2,4', capacity: 1 });
  const quietTTh = t.fx.session(loc, { name: 'Quiet Room TTh', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  const [isha] = fill(t, loc, quietTTh, 1);
  const anh = named(t, t.fx.family(loc, { cap: 2 }), 'Anh Nguyen');
  const held = await enroll(t, anh.parent, anh.student, tth);
  const w = await joinLine(t, anh.parent, anh.student, quietTTh);
  assert.deepEqual([w.status, w.body.outcome, w.body.keeps], [201, 'waitlisted', { name: 'Afternoons TTh' }]);
  const fam = (await t.as(anh.parent).get('/api/enrollment/students')).body.students[0];
  assert.deepEqual(fam.waitlist.map(x => [x.name, x.keeps]), [['Quiet Room TTh', { enrollment_id: held.body.enrollment.id, name: 'Afternoons TTh' }]]);
  assert.deepEqual(active(t, anh.student).map(e => e.session_id), [tth.id], 'still holds Afternoons TTh while waiting');
  const bo = t.fx.family(loc);
  await joinLine(t, bo.parent, bo.student, tth);
  const seat = t.db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status = 'active'").get(isha.student.id);
  assert.equal((await drop(t, isha.parent, seat.id)).status, 200);
  assert.deepEqual(active(t, anh.student).map(e => e.session_id), [quietTTh.id]);
  assert.deepEqual(active(t, bo.student).map(e => e.session_id), [tth.id], 'the seat she left went to the next in line');
  assert.deepEqual(t.fx.notifications(anh.parent, 'waitlist_promoted').map(n => [n.title, n.body]), [['A seat opened: Anh moved to Quiet Room TTh',
    'Tue, Thu 4:30-6:30 PM through Dec 18. Afternoons TTh has ended for Anh.']]);
});

// ---------------------------------------------------------------- EN-6, EN-7

test(['EN-6', 'EN-7'], 'parents drop any time, even minutes before a date, with no penalty; the dates before stay on record', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const e = t.fx.enroll(f.student, sess);
  t.clock.set(at(LA, '2026-10-14', '12:55')); // five minutes before Wednesday's date
  assert.equal((await drop(t, f.student, e.id)).status, 403);
  const r = await drop(t, f.parent, e.id);
  assert.deepEqual([r.status, r.body.enrollment.status], [200, 'dropped']);
  const row = t.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e.id);
  assert.deepEqual([row.status, row.ended_at], ['dropped', at(LA, '2026-10-14', '12:55')]);
  const again = await drop(t, f.parent, e.id);
  assert.deepEqual([again.status, again.body.error], [409, 'not_enrolled']);
  // History stays; nothing from the drop on is expected, and no penalty is recorded.
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-10-05', '2026-10-25')).map(o => `${o.date} ${o.status}`),
    ['2026-10-05 absent', '2026-10-07 absent', '2026-10-09 absent', '2026-10-12 absent']);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test(['EN-7'], 'the schedule shows attended, absent, closed, paused and upcoming, computed and never stored', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2', start: '09:30', end: '12:00' });
  const evening = t.fx.session(loc, { name: 'Evening Study', weekdays: '4', start: '17:00', end: '19:00' });
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess);
  t.fx.enroll(f.student, evening, 0, { status: 'paused' });
  t.clock.set(at(LA, '2026-10-07', '12:30')); // enrolled in Tuesdays after the Oct 6 one
  t.fx.enroll(f.student, morning);
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-09-28', check_in_at: at(LA, '2026-09-28', '13:02'), check_out_at: at(LA, '2026-09-28', '15:58'), checkout_method: 'scan' });
  // Staff check-in with no linked schedule, during the date's hours: still attended.
  t.fx.visit(f.student, loc, { local_date: '2026-09-30', check_in_at: at(LA, '2026-09-30', '13:20'), check_out_at: at(LA, '2026-09-30', '15:00'), checkin_method: 'staff', checkout_method: 'staff' });
  // A visit that day but outside the date's hours does not count.
  t.fx.visit(f.student, loc, { local_date: '2026-10-07', check_in_at: at(LA, '2026-10-07', '09:00'), check_out_at: at(LA, '2026-10-07', '10:00'), checkin_method: 'staff', checkout_method: 'staff' });
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-10-12', check_in_at: at(LA, '2026-10-12', '13:00'), check_out_at: at(LA, '2026-10-12', '16:00'), checkout_method: 'auto' });
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(loc.id, '2026-10-02', 'Staff training');
  const before = snapshot(t);
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-28&to=2026-10-18`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.name} ${o.status}`), [
    '2026-09-28 Afternoon Study attended',
    '2026-09-30 Afternoon Study attended',
    '2026-10-01 Evening Study paused',
    '2026-10-02 Afternoon Study closed',
    '2026-10-05 Afternoon Study absent',
    '2026-10-07 Afternoon Study absent',
    '2026-10-08 Evening Study paused',
    '2026-10-09 Afternoon Study absent',
    '2026-10-12 Afternoon Study attended',
    '2026-10-13 Morning Focus absent',
    '2026-10-14 Afternoon Study upcoming',
    '2026-10-15 Evening Study paused',
    '2026-10-16 Afternoon Study upcoming',
  ]);
  assert.equal(s.body.occurrences.find(o => o.date === '2026-10-02').closure_reason, 'Staff training');
  assert.deepEqual([s.body.occurrences[0].start_at, s.body.occurrences[0].weekday, s.body.occurrences[0].change], [at(LA, '2026-09-28', '13:00'), 1, null]);
  assert.equal(snapshot(t), before, 'reading the schedule writes nothing');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  // Outside the term there is nothing; a bad range is refused.
  const after = await t.as(f.student).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-12-19&to=2027-01-10`);
  assert.deepEqual(after.body.occurrences, []);
  assert.equal((await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-10-18&to=2026-10-01`)).status, 400);
  assert.equal((await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=yesterday`)).status, 400);
  // Default range is this week, Monday to Sunday.
  const week = await t.as(f.student).get(`/api/enrollment/students/${f.student.id}/schedule`);
  assert.deepEqual([week.body.from, week.body.to], ['2026-10-12', '2026-10-18']);
});

// SC-5 / D-46 / D-47: the schedule follows the schedule's own date changes.
test(['SC-5', 'EN-7'], 'moved and added dates show on the schedule, skipped and moved-away ones never do and are never absent', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess);
  t.fx.sessionDate(sess, '2026-10-05', 'skip', { reason: 'Staff training day' });
  t.fx.sessionDate(sess, '2026-10-06', 'add', { moved_from: '2026-10-05', reason: 'Staff training day' });
  t.fx.sessionDate(sess, '2026-10-08', 'add');
  t.fx.sessionDate(sess, '2026-10-09', 'skip');
  t.fx.sessionDate(sess, '2026-10-21', 'skip');
  t.fx.sessionDate(sess, '2026-10-22', 'add', { moved_from: '2026-10-21' });
  t.fx.sessionDate(sess, '2026-12-21', 'add'); // after the term ends: ignored
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.fx.visit(f.student, loc, { session: sess, local_date: '2026-10-06', check_in_at: at(LA, '2026-10-06', '13:00'), check_out_at: at(LA, '2026-10-06', '16:00'), checkout_method: 'scan' });
  const s = await dates(t, f.parent, f.student, '2026-10-05', '2026-12-31');
  assert.deepEqual(s.slice(0, 6).map(o => [o.date, o.status, o.change, o.moved_from]), [
    ['2026-10-06', 'attended', 'moved', '2026-10-05'],
    ['2026-10-07', 'absent', null, null],
    ['2026-10-08', 'absent', 'added', null],
    ['2026-10-12', 'absent', null, null],
    ['2026-10-14', 'upcoming', null, null],
    ['2026-10-16', 'upcoming', null, null],
  ]);
  assert.ok(!s.some(o => ['2026-10-05', '2026-10-09', '2026-10-21', '2026-12-21'].includes(o.date)));
  assert.deepEqual(s.filter(o => o.date >= '2026-10-19' && o.date <= '2026-10-23').map(o => o.date), ['2026-10-19', '2026-10-22', '2026-10-23']);
  // The family overview lists the upcoming changes with the schedule (today or later only).
  const e = (await t.as(f.parent).get('/api/enrollment/students')).body.students[0].enrollments[0];
  assert.deepEqual(e.changes.map(c => [c.date, c.kind, c.moved_from]), [['2026-10-21', 'skip', null], ['2026-10-22', 'add', '2026-10-21']]);
});

test(['EN-7'], 'a v1 per-day row in history counts only on its own weekday', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const v1 = t.fx.enroll(f.student, sess, 1); // Mondays only (v1)
  t.clock.set(at(LA, '2026-09-30', '20:00'));
  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(t.clock.now(), v1.id); // the v1.1 move
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-09-21', '2026-10-04')).map(o => `${o.date} ${o.weekday} ${o.status}`),
    ['2026-09-21 1 absent', '2026-09-28 1 absent']);
});

test(['EN-7'], 'a schedule range over a year is refused at once, even 0001-01-01 to 9999-12-31, without stepping through the days', async () => {
  const { t, loc, sess } = await world({ weekdays: '1' });
  const f = t.fx.family(loc);
  t.fx.enroll(f.student, sess); // Mondays, from next week to the end of the term (Dec 18)
  const range = (from, to) => t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=${from}&to=${to}`);
  // A full year is fine (Aug 17 2026 through Aug 17 2027, 366 days counting both ends); one day more is not.
  const year = await range('2026-08-17', '2027-08-17');
  assert.equal(year.status, 200);
  assert.deepEqual(year.body.occurrences.map(o => o.date), [
    '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14',
  ]);
  const over = await range('2026-08-17', '2027-08-18');
  assert.equal(over.status, 400);
  assert.deepEqual(over.body, { error: 'bad_range', message: 'Pick a range of a year or less.' });
  // Huge ranges are refused straight away. Stepping through every day took seconds for the first and
  // never finished for the second (past 9999-12-31 the walk keeps going), so the whole server hung.
  for (const [from, to] of [['1000-01-01', '2026-10-14'], ['0001-01-01', '9999-12-31']]) {
    const started = Date.now();
    const r = await range(from, to);
    const ms = Date.now() - started;
    assert.equal(r.status, 400, `${from} to ${to}`);
    assert.deepEqual(r.body, { error: 'bad_range', message: 'Pick a range of a year or less.' });
    assert.ok(ms < 2000, `${from} to ${to} took ${ms}ms`);
  }
  assert.equal((await range('2026-10-12', '2026-10-18')).status, 200, 'the server still answers');
});

test(['EN-7'], 'a schedule dropped and taken again shows each date once, and a recorded visit always counts as attended', async () => {
  const { t, loc, sess } = await world({ weekdays: '1,3' });
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const first = t.fx.enroll(f.student, sess);
  t.clock.set(at(LA, '2026-10-01', '09:00'));
  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(t.clock.now(), first.id);
  t.clock.set(at(LA, '2026-10-08', '09:00'));
  t.fx.enroll(f.student, sess); // taken again from Oct 8, but they came on Oct 7 (staff linked the visit)
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-09-28', check_in_at: at(LA, '2026-09-28', '13:00'), check_out_at: at(LA, '2026-09-28', '16:00'), checkout_method: 'scan' });
  t.fx.visit(f.student, loc, { session: sess, weekday: 3, local_date: '2026-10-07', check_in_at: at(LA, '2026-10-07', '13:10'), check_out_at: at(LA, '2026-10-07', '16:00'), checkin_method: 'staff', checkout_method: 'staff' });
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-09-21', '2026-10-18')).map(o => `${o.date} ${o.status}`), [
    '2026-09-21 absent', '2026-09-23 absent', '2026-09-28 attended', '2026-09-30 absent', '2026-10-07 attended', '2026-10-12 absent', '2026-10-14 upcoming',
  ]);
});

test(['EN-7'], "each date is judged by the enrollment's status that day: a date missed before a pause stays absent, dates on hold stay paused after renewal", async () => {
  const { t, loc, sess } = await world({ weekdays: '1' });
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const r = await enroll(t, f.parent, f.student, sess); // Mondays
  assert.equal(r.status, 201);
  const id = r.body.enrollment.id;
  for (const d of ['2026-09-07', '2026-09-21']) {
    t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: d, check_in_at: at(LA, d, '13:00'), check_out_at: at(LA, d, '16:00'), checkout_method: 'scan' });
  }
  // Sep 14 is missed. Fri Sep 25: the membership lapses and the membership module pauses the schedule (MB-5).
  t.clock.set(at(LA, '2026-09-25', '09:00'));
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE student_id = ? AND status = 'active'").run(f.student.id);
  const weeks = async to => (await dates(t, f.parent, f.student, '2026-09-07', to)).map(o => `${o.date} ${o.status}`);
  // While it is paused, the missed date before the pause is still an absence.
  t.clock.set(at(LA, '2026-10-01', '10:00'));
  assert.deepEqual(await weeks('2026-10-19'), [
    '2026-09-07 attended', '2026-09-14 absent', '2026-09-21 attended',
    '2026-09-28 paused', '2026-10-05 paused', '2026-10-12 paused', '2026-10-19 paused',
  ]);
  // Wed Oct 14: renewed, and the schedule comes back (D-16). The dates on hold are never absences.
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(id);
  assert.deepEqual(await weeks('2026-10-26'), [
    '2026-09-07 attended', '2026-09-14 absent', '2026-09-21 attended',
    '2026-09-28 paused', '2026-10-05 paused', '2026-10-12 paused',
    '2026-10-19 upcoming', '2026-10-26 upcoming',
  ]);
  // When the pause began and ended is on record, by the app's clock.
  assert.deepEqual(t.db.prepare('SELECT from_status, to_status, at FROM enrollment_status_log WHERE enrollment_id = ? ORDER BY id').all(id)
    .map(c => [c.from_status, c.to_status, c.at]), [
    ['active', 'paused', at(LA, '2026-09-25', '09:00')],
    ['paused', 'active', at(LA, '2026-10-14', '10:00')],
  ]);
});

test(['EN-7'], 'a cancelled schedule keeps the dates before the cancellation on the schedule and drops the ones after', async () => {
  const { t, loc, sess } = await world({ weekdays: '1' });
  const f = t.fx.family(loc);
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  t.clock.set(at(LA, '2026-09-01', '08:00'));
  t.fx.enroll(f.student, sess);
  t.fx.enroll(f.student, morning);
  t.fx.visit(f.student, loc, { session: morning, weekday: 2, local_date: '2026-09-29', check_in_at: at(LA, '2026-09-29', '09:30'), check_out_at: at(LA, '2026-09-29', '12:00'), checkout_method: 'scan' });
  // Thu Oct 8, 8:00: the director cancels Morning Focus, and the sessions module ends its enrollments then (SC-4).
  t.clock.set(at(LA, '2026-10-08', '08:00'));
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(morning.id);
  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE session_id = ? AND status <> 'dropped'").run(t.clock.now(), morning.id);
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-28&to=2026-10-20`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.name} ${o.status}`), [
    '2026-09-28 Afternoon Study absent',
    '2026-09-29 Morning Focus attended',
    '2026-10-01 Morning Focus absent',
    '2026-10-05 Afternoon Study absent',
    '2026-10-06 Morning Focus absent',
    '2026-10-12 Afternoon Study absent',
    '2026-10-19 Afternoon Study upcoming',
  ]);
});

// ---------------------------------------------------------------- catalog

test(['EN-1', 'EN-2'], 'the catalog lists home-location schedules with a date left, grouped by period, with seats, the line and the dates left', async () => {
  const { t, loc, sess } = await world({ capacity: 3 });
  const other = t.fx.location({ name: 'Arcadia' });
  t.fx.session(other, { name: 'Arcadia Study' });
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-07' });
  t.fx.session(loc, { term: summer, name: 'Summer Study' });
  const winter = t.fx.term(loc, { name: 'Winter 2027', start: '2027-01-11', end: '2027-03-19' });
  const next = t.fx.session(loc, { term: winter, name: 'Winter Study', weekdays: '2', start: '15:00', end: '17:00', capacity: 3 });
  const gone = t.fx.session(loc, { name: 'Cancelled Study' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(gone.id);
  const lab = t.fx.session(loc, { name: 'Lab', weekdays: '2,4', start: '09:30', end: '12:00', capacity: 1 });
  fill(t, loc, lab, 1);
  const w = t.fx.family(loc);
  await joinLine(t, w.parent, w.student, lab);
  const f = t.fx.family(loc);
  t.fx.enroll(f.student, sess);
  fill(t, loc, sess, 1);
  const c = await catalogOf(t, f);
  assert.equal(c.status, 200);
  assert.equal(c.body.location.timezone, LA);
  assert.deepEqual(c.body.schedules.map(s => [s.name, s.term_name, s.days_per_week, s.seats_left, s.waiting, s.mine]), [
    ['Lab', 'Fall 2026', 2, 0, 1, null],
    ['Afternoon Study', 'Fall 2026', 3, 1, 0, 'enrolled'],
    ['Winter Study', 'Winter 2027', 1, 3, 0, null],
  ]);
  // Fall has 54 Mon/Wed/Fri dates (Aug 17 - Dec 18); 29 are left from today. Winter has not begun.
  const mine = rowOf(c, sess);
  assert.deepEqual([mine.dates_total, mine.dates_left, mine.first_date, mine.enrollment_id], [54, 29, '2026-10-14', active(t, f.student)[0].id]);
  const win = rowOf(c, next);
  assert.deepEqual([win.session_id, win.dates_total, win.dates_left, win.first_date, win.term_start, win.weekdays, win.capacity], [next.id, 10, 10, '2027-01-12', '2027-01-11', '2', 3]);
  // The student sees the same catalog for themselves.
  const self = await t.as(f.student).get(`/api/enrollment/students/${f.student.id}/catalog`);
  assert.equal(self.body.schedules.length, 3);
});

// ---------------------------------------------------------------- NF-1

test(['NF-1'], 'every enrollment route refuses other families, other locations and lower roles', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const locB = t.fx.location({ name: 'Arcadia' });
  const sessB = t.fx.session(locB);
  const a = t.fx.family(loc), b = t.fx.family(loc), far = t.fx.family(locB);
  const staffA = t.fx.staff(loc), staffB = t.fx.staff(locB), dirB = t.fx.director(locB), hq = t.fx.hq();
  const e = t.fx.enroll(a.student, sess);
  const lab = t.fx.session(loc, { name: 'Lab', weekdays: '2,4', capacity: 1 });
  fill(t, loc, lab, 1);
  const w = await joinLine(t, a.parent, a.student, lab);
  assert.equal(w.status, 201);
  const sid = a.student.id;
  const before = snapshot(t);

  // Reads of one student: the family, staff at that location, and HQ only.
  for (const path of [`/api/enrollment/students/${sid}/catalog`, `/api/enrollment/students/${sid}/schedule`]) {
    for (const u of [b.parent, b.student, far.parent, staffB, dirB]) assert.equal((await t.as(u).get(path)).status, 403, path + ' as ' + u.role);
    for (const u of [a.parent, a.student, staffA, hq]) assert.equal((await t.as(u).get(path)).status, 200, path + ' as ' + u.role);
    assert.equal((await t.anon.get(path)).status, 401);
  }
  // Family lists hold only the caller's own students.
  assert.deepEqual((await t.as(b.parent).get('/api/enrollment/students')).body.students.map(s => s.id), [b.student.id]);
  assert.deepEqual((await t.as(a.student).get('/api/enrollment/students')).body.students.map(s => s.id), [sid]);
  for (const u of [staffA, hq]) assert.equal((await t.as(u).get('/api/enrollment/students')).status, 403);
  // Writes: only a linked parent.
  const writes = [
    ['/api/enrollment/enroll', { studentId: sid, sessionId: lab.id }],
    ['/api/enrollment/waitlist', { studentId: sid, sessionId: sess.id }],
    [`/api/enrollment/waitlist/${w.body.waitlist.id}/leave`, {}],
    [`/api/enrollment/enrollments/${e.id}/drop`, {}],
  ];
  for (const [path, payload] of writes) {
    for (const u of [b.parent, far.parent, a.student, staffA, dirB, hq]) {
      assert.equal((await t.as(u).post(path, payload)).status, 403, path + ' as ' + u.role + ' ' + u.id);
    }
    assert.equal((await t.anon.post(path, payload)).status, 401);
  }
  assert.equal(snapshot(t), before, 'refused calls change nothing');
  // Another location's schedule is out of reach even for the student's own parent.
  const away = await enroll(t, a.parent, a.student, sessB);
  assert.deepEqual([away.status, away.body.error], [409, 'not_home_location']);
  const awayLine = await joinLine(t, a.parent, a.student, sessB);
  assert.equal(awayLine.status, 409);
  assert.deepEqual((await catalogOf(t, a)).body.schedules.map(s => s.name), ['Afternoon Study', 'Lab'], "no other location's schedules");
  assert.equal(snapshot(t), before);
});

test(['NF-1', 'EN-7'], "a schedule never borrows another student's visit or another location's closure", async () => {
  const { t, loc, sess } = await world({ weekdays: '1' });
  const f = t.fx.family(loc), other = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess); // Mondays 13:00-16:00
  t.fx.enroll(other.student, sess);
  // Another family's student came to the same date on Mon Oct 5 ...
  t.fx.visit(other.student, loc, { session: sess, weekday: 1, local_date: '2026-10-05', check_in_at: at(LA, '2026-10-05', '13:00'),
    check_out_at: at(LA, '2026-10-05', '16:00'), checkout_method: 'scan' });
  // ... and a different location closed on Mon Oct 12.
  const arcadia = t.fx.location({ name: 'Arcadia' });
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(arcadia.id, '2026-10-12', 'Arcadia staff training');
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-10-05', '2026-10-12')).map(o => [o.date, o.status, o.check_in_at, o.closure_reason]),
    [['2026-10-05', 'absent', null, null], ['2026-10-12', 'absent', null, null]]);
  assert.deepEqual((await dates(t, other.parent, other.student, '2026-10-05', '2026-10-12')).map(o => [o.date, o.status]),
    [['2026-10-05', 'attended'], ['2026-10-12', 'absent']]);
});

test(['EN-4', 'EN-7'], 'a schedule kept paused because its days are over the weekly limit says so, instead of asking for a renewal (D-16a)', async () => {
  const { t, loc, sess } = await world();
  const f = named(t, t.fx.family(loc, { cap: 2 }), 'Leo Garcia');
  t.fx.enroll(f.student, sess, 0, { status: 'paused' }); // kept paused when the membership came back with a limit of 2
  const r = await enroll(t, f.parent, f.student, sess);
  assert.deepEqual([r.status, r.body.error, r.body.message], [409, 'already_enrolled',
    "Leo's place in Afternoon Study is paused because its days don't fit the membership's weekly limit. It stays saved, and the front desk can bring it back if the limit goes up."]);
  // The same schedule with the membership lapsed waits for a renewal; so does one past its last day.
  t.fx.membership(f.student, { cap: 2, expires: '2026-10-13' });
  assert.equal((await enroll(t, f.parent, f.student, sess)).body.message, "Leo's place in Afternoon Study is paused until the membership is renewed.");
  t.fx.membership(f.student, { cap: 2, status: 'inactive' });
  assert.match((await joinLine(t, f.parent, f.student, sess)).body.message, /is paused until the membership is renewed\.$/);
  // Before a renewal starts, it says when.
  t.fx.membership(f.student, { cap: 3, start: '2026-11-02' });
  assert.equal((await enroll(t, f.parent, f.student, sess)).body.message, "Leo's place in Afternoon Study is paused because the membership doesn't start until Nov 2, 2026.");
  assert.equal(active(t, f.student).length, 0);
});

// ---------------------------------------------------------------- the demo data (src/modules/enrollment/seed.js)

test(['EN-5', 'EN-8', 'EN-4'], "the demo: Anh waits for Quiet Room TTh while keeping Afternoons TTh, no requests, and Daniel's pause is on record", async () => {
  const { t, loc } = await world();
  const fall = t.db.prepare('SELECT * FROM terms WHERE location_id = ?').get(loc.id);
  const s = (name, weekdays, start, end, capacity) => t.fx.session(loc, { term: fall, name, weekdays, start, end, capacity });
  const sessions = {
    morningsMWF: s('Mornings MWF', '1,3,5', '09:00', '12:00', 24), afternoonsMWF: s('Afternoons MWF', '1,3,5', '13:00', '16:00', 30),
    afternoonsTTh: s('Afternoons TTh', '2,4', '13:00', '16:00', 20), quietTTh: s('Quiet Room TTh', '2,4', '16:30', '18:30', 2),
  };
  const garcia = t.fx.family(loc, { students: 2 }), nguyen = named(t, t.fx.family(loc, { cap: 2 }), 'Anh Nguyen');
  const kim = t.fx.family(loc, { status: 'inactive' });
  t.fx.enroll(nguyen.student, sessions.afternoonsTTh);
  fill(t, loc, sessions.quietTTh, 2);
  const daniel = t.fx.enroll(kim.student, sessions.afternoonsMWF, 0, { status: 'paused' });
  const demo = { NOW: t.clock.now(), families: [garcia, nguyen, kim], sessions };
  load('src/modules/enrollment/seed.js')(t.ctx, demo);
  assert.deepEqual(t.db.prepare('SELECT student_id, session_id, weekday, status, created_by, created_at FROM waitlist').all().map(r => ({ ...r })),
    [{ student_id: nguyen.student.id, session_id: sessions.quietTTh.id, weekday: 0, status: 'waiting', created_by: nguyen.parent.id, created_at: demo.NOW - 26 * 3600e3 }]);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollment_requests').get().n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  assert.deepEqual(t.db.prepare('SELECT from_status, to_status, at FROM enrollment_status_log WHERE enrollment_id = ?').all(daniel.id).map(r => ({ ...r })),
    [{ from_status: 'active', to_status: 'paused', at: demo.NOW - 13 * 864e5 }]);
  const anh = (await t.as(nguyen.parent).get('/api/enrollment/students')).body.students[0];
  assert.deepEqual(anh.waitlist.map(w => [w.name, w.position, w.keeps && w.keeps.name]), [['Quiet Room TTh', 1, 'Afternoons TTh']]);
  const block = rowOf(await catalogOf(t, nguyen), sessions.morningsMWF).block;
  assert.deepEqual(block, { code: 'weekly_cap', message: "Mornings MWF meets 3 days a week. Anh's membership allows 2." });
});

// ---------------------------------------------------------------- the Schedule screen and Inbox in a browser tab

// Just enough DOM for public/js/app.js and this module's view, as in core.test.js:
// one tree under <html>; focus, bubbling events and isConnected work as in a browser.
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  get id() { return this.getAttribute('id') || ''; }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get cls() { return this.className.split(/\s+/).filter(Boolean); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.doc.documentElement; }
  addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
  dispatch(type, props) {
    const ev = Object.assign({ type, target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } }, props);
    for (let n = this; n && !ev.stopped; n = n.parentNode) { ev.currentTarget = n; for (const fn of n.on[type] || []) fn(ev); }
  }
  click() { this.dispatch('click'); }
  focus() { this.doc.focused = this; }
  adopt(kids) { return kids.map(k => { const n = k instanceof El ? k : new El(this.doc, null, String(k)); n.remove(); n.parentNode = this; return n; }); }
  append(...kids) { this.childNodes.push(...this.adopt(kids)); }
  appendChild(k) { this.append(k); return k; }
  prepend(...kids) { this.childNodes.unshift(...this.adopt(kids)); }
  after(...kids) { const p = this.parentNode, ns = p.adopt(kids); p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, ...ns); }
  replaceChildren(...kids) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  all() { return this.childNodes.flatMap(c => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
}

// One tab running the real shell and enrollment view (read from ROOT, so the
// mutation runner's copy is the one exercised) against the test server.
// window.confirm only counts its calls: the view must never use it.
function shellTab(t) {
  let cookie = '';
  const pending = new Set();
  const track = p => { pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };
  const doc = { title: '', hidden: false, on: {}, addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); } };
  const el = (tag, attrs = {}) => { const n = new El(doc, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  doc.documentElement = el('html');
  doc.head = el('head');
  doc.body = el('body');
  doc.documentElement.append(doc.head, doc.body);
  const shell = el('div', { id: 'shell' });
  shell.append(el('nav', { id: 'nav', hidden: '' }), el('main', { id: 'main', tabindex: '-1' }));
  doc.body.append(el('div', { id: 'devbar', hidden: '' }), el('header', { id: 'topbar', hidden: '' }), el('div', { id: 'toasts' }), shell);
  Object.assign(doc, {
    createElement: tag => new El(doc, tag), createTextNode: s => new El(doc, null, String(s)),
    getElementById: id => doc.documentElement.find(n => n.id === id) || null,
  });
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused && doc.focused.isConnected ? doc.focused : doc.body) });
  const winOn = {};
  const location = {
    _hash: '',
    get hash() { return this._hash; },
    set hash(v) {
      this._hash = v ? (String(v).startsWith('#') ? String(v) : '#' + v) : '';
      track(new Promise(r => setImmediate(() => { (winOn.hashchange || []).forEach(fn => fn({ type: 'hashchange' })); r(); })));
    },
  };
  class EventSource { close() {} }
  const fetchAs = (url, opts = {}) => track(fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
    .then(async r => new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers })));
  const tab = { confirms: 0 };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator: {}, location, EventSource,
    history: { replaceState(_s, _t, url) { location._hash = String(url).replace(/^[^#]*/, ''); } },
    addEventListener(type, fn) { (winOn[type] = winOn[type] || []).push(fn); },
    confirm: () => { tab.confirms++; return true; },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/enrollment.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return Object.assign(tab, {
    doc, settle, main: () => doc.getElementById('main'), toasts: () => doc.getElementById('toasts').childNodes.map(n => n.textContent),
    async open(user, hash) {
      const token = crypto.randomBytes(16).toString('hex');
      t.ctx.sessions.set(token, user.id);
      cookie = 'sid=' + token;
      location._hash = hash;
      win.App.start();
      await settle();
    },
    async go(hash) { location.hash = hash; await settle(); },
  });
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const byTag = (root, tag) => root.findAll(n => n.tag === tag);
const rename = (t, u, name) => { t.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id); return Object.assign(u, { name }); };

test(['EN-6'], 'Drop asks inline in place of the row: "Keep Afternoon Study" comes first and has focus, Escape keeps it, "Drop Afternoon Study" drops it', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  rename(t, f.student, 'Leo Garcia');
  const e = t.fx.enroll(f.student, sess);
  const tab = shellTab(t);
  await tab.open(f.parent, '#/schedule');
  const dropButton = () => byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Drop Afternoon Study');
  const status = () => t.db.prepare('SELECT status FROM enrollments WHERE id = ?').get(e.id).status;

  const btn = dropButton();
  const row = btn.parentNode, before = row.childNodes.slice();
  btn.click();
  const box = row.childNodes[0];
  assert.equal(row.childNodes.length, 1, 'the question takes the place of the row');
  assert.equal(box.getAttribute('role'), 'alertdialog');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Drop Leo from Afternoon Study?');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-describedby')).textContent,
    'This ends all of its dates. The seat goes to the next family on the waitlist.');
  const choices = byTag(box, 'button');
  assert.deepEqual(choices.map(b => b.textContent), ['Keep Afternoon Study', 'Drop Afternoon Study'], 'the safe answer comes first, and each names the schedule');
  assert.ok(choices[1].cls.includes('btn-danger'));
  assert.equal(tab.doc.activeElement, choices[0], 'focus starts on the safe answer');
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(status(), 'active', 'Escape keeps the schedule');
  assert.ok(row.childNodes.length === before.length && row.childNodes.every((n, i) => n === before[i]), 'the row comes back');
  assert.equal(tab.doc.activeElement, btn, 'focus goes back to Drop');

  btn.click();
  byTag(row, 'button').find(b => b.textContent === 'Drop Afternoon Study').click();
  await tab.settle();
  assert.equal(status(), 'dropped');
  assert.deepEqual(tab.toasts(), ['Dropped Afternoon Study.']);
  assert.equal(dropButton(), undefined, 'the page is drawn again without the schedule');
  assert.equal(tab.confirms, 0, 'window.confirm is never used');
});

test(['EN-8'], '"Switch to this" asks first and names the schedule that ends; keeping it changes nothing, switching moves the student', async () => {
  const { t, loc, sess } = await world();
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const f = t.fx.family(loc);
  rename(t, f.student, 'Leo Garcia');
  const e = t.fx.enroll(f.student, sess);
  const tab = shellTab(t);
  await tab.open(f.parent, '#/schedule');
  const sw = () => byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Switch Leo to Morning Focus');
  const btn = sw();
  assert.equal(btn.textContent, 'Switch to this');
  const row = btn.parentNode;
  btn.click();
  const box = row.childNodes[0];
  assert.equal(box.getAttribute('role'), 'alertdialog');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Switch Leo to Morning Focus?');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-describedby')).textContent,
    'Afternoon Study ends for Leo now, and its seat goes to the next family on the waitlist.');
  assert.deepEqual(byTag(box, 'button').map(b => b.textContent), ['Keep Afternoon Study', 'Switch to Morning Focus']);
  assert.equal(tab.doc.activeElement, byTag(box, 'button')[0]);
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.deepEqual(active(t, f.student).map(x => x.id), [e.id], 'keeping it changes nothing');
  btn.click();
  byTag(row, 'button').find(b => b.textContent === 'Switch to Morning Focus').click();
  await tab.settle();
  assert.deepEqual(active(t, f.student).map(x => x.session_id), [morning.id]);
  assert.deepEqual(tab.toasts(), ['Leo moved from Afternoon Study to Morning Focus.']);
  assert.equal(sw(), undefined);
  assert.equal(tab.confirms, 0, 'window.confirm is never used');
});

test(['EN-1', 'EN-4', 'EN-5'], '"Choose a schedule" groups schedules by period with days, seats and dates left, and one button each; a blocked one says why', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const quiet = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  const jan = t.fx.session(loc, { term: t.fx.term(loc, { name: 'January 2027', start: '2027-01-04', end: '2027-01-29' }), name: 'January Study', weekdays: '2', start: '15:00', end: '17:00' });
  fill(t, loc, sess, 1);
  for (const w of [t.fx.family(loc), t.fx.family(loc)]) t.fx.waitlist(w.student, sess);
  fill(t, loc, quiet, 1);
  const f = t.fx.family(loc, { cap: 2 });
  rename(t, f.student, 'Leo Garcia');
  const tab = shellTab(t);
  await tab.open(f.parent, '#/schedule');
  const card = () => tab.main().find(n => n.getAttribute('aria-labelledby') === 'en-add-h');
  assert.deepEqual(byTag(card(), 'h3').map(words), ['Fall 2026 · Aug 17 – Dec 18', 'January 2027 · Jan 4 – Jan 29'], 'grouped by period, not by weekday');
  assert.deepEqual(byTag(card(), 'li').map(words), [
    'Morning Focus Tue, Thu · 9:30am–12pm · 2 days a week 10 seats left · 19 of 36 dates left Enroll',
    "Afternoon Study Mon, Wed, Fri · 1pm–4pm · 3 days a week Full · 2 waiting · 29 of 54 dates left Join waitlist Afternoon Study meets 3 days a week. Leo's membership allows 2.",
    'Quiet Room Tue, Thu · 4:30pm–6:30pm · 2 days a week Full · 19 of 36 dates left Join waitlist',
    'January Study Tue · 3pm–5pm · 1 day a week 10 seats left · Starts Jan 5 Enroll',
  ]);
  const button = label => byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === label);
  const blocked = button('Join the waitlist for Afternoon Study');
  assert.notEqual(blocked.getAttribute('disabled'), null, 'a blocked row cannot be tapped');
  assert.equal(tab.doc.getElementById(blocked.getAttribute('aria-describedby')).textContent, "Afternoon Study meets 3 days a week. Leo's membership allows 2.");
  assert.equal(button('Enroll Leo in Morning Focus').getAttribute('disabled'), null);
  assert.equal(button('Enroll Leo in Morning Focus').getAttribute('aria-describedby'), null);
  // Join a full one, then enroll in another period.
  button('Join the waitlist for Quiet Room').click();
  await tab.settle();
  assert.deepEqual(tab.toasts(), ["Leo is 1st in line. We'll enroll Leo automatically when a seat opens."]);
  button('Enroll Leo in January Study').click();
  await tab.settle();
  assert.equal(tab.toasts()[1], 'Leo is enrolled in January Study.');
  assert.deepEqual(byTag(card(), 'li').map(words).filter(w => /^(Quiet|January)/.test(w)), [
    'Quiet Room Tue, Thu · 4:30pm–6:30pm · 2 days a week Full · 1 waiting · 19 of 36 dates left 1st in line',
    'January Study Tue · 3pm–5pm · 1 day a week 9 seats left · Starts Jan 5 Enrolled',
  ]);
  assert.deepEqual(active(t, f.student).map(e => e.session_id), [jan.id]);
  // January doesn't overlap Fall, so Morning Focus is still a plain Enroll, not a switch.
  assert.equal(button('Enroll Leo in Morning Focus').textContent, 'Enroll');
  assert.equal(rowOf(await catalogOf(t, f), morning).switch_from, null);
});

test(['EN-5', 'EN-8'], 'the waitlist card says the student keeps their schedule until a seat opens, then moves over', async () => {
  const { t, loc } = await world();
  const tth = t.fx.session(loc, { name: 'Afternoons TTh', weekdays: '2,4' });
  const quiet = t.fx.session(loc, { name: 'Quiet Room TTh', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  fill(t, loc, quiet, 1);
  const f = t.fx.family(loc, { cap: 2 });
  rename(t, f.student, 'Anh Nguyen');
  t.fx.enroll(f.student, tth);
  const tab = shellTab(t);
  await tab.open(f.parent, '#/schedule');
  byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Join the waitlist for Quiet Room TTh').click();
  await tab.settle();
  assert.deepEqual(tab.toasts(), ['Anh is 1st in line. Anh keeps Afternoons TTh until a seat opens, then moves over automatically.']);
  const wait = tab.main().find(n => n.getAttribute('aria-labelledby') === 'en-wait-h');
  assert.deepEqual(byTag(wait, 'li').map(words), [
    'Quiet Room TTh 1st in line of 1 · Tue, Thu · 4:30pm–6:30pm Anh keeps Afternoons TTh until a seat opens, then moves over automatically. Leave',
  ]);
  assert.ok(byTag(wait, 'button').some(b => b.getAttribute('aria-label') === 'Leave the waitlist for Quiet Room TTh'));
  // The student sees the same, read-only.
  const student = shellTab(t);
  await student.open(f.student, '#/schedule');
  assert.ok(words(student.main()).includes("1st in line Quiet Room TTh. You'll move over automatically when a seat opens."));
});

test(['EN-4'], 'the membership line on Schedule says the cap in days a week, expired past the last day and "starts" before the first, for parents and students alike', async () => {
  const { t, loc, sess } = await world();
  const expired = t.fx.family(loc, { expires: '2026-10-13' });
  t.fx.enroll(expired.student, sess, 0, { status: 'paused' });
  const early = t.fx.family(loc, { cap: 3, start: '2026-11-02' });
  t.fx.enroll(early.student, sess, 0, { status: 'paused' });
  const fine = t.fx.family(loc);
  const off = t.fx.family(loc, { cap: 2, status: 'inactive' });
  const lines = tab => tab.main().findAll(n => n.tag === 'p' && /^(Membership|No membership)/.test(words(n))).map(words);
  for (const [who, want] of [
    [expired, 'Membership expired · up to 3 days a week · last day was Oct 13, 2026'],
    [early, 'Membership starts Nov 2, 2026 · up to 3 days a week · valid through Jun 30, 2027'],
    [fine, 'Membership active · up to 3 days a week · valid through Jun 30, 2027'],
    [off, 'Membership inactive · up to 2 days a week · valid through Jun 30, 2027']]) {
    for (const u of [who.parent, who.student]) {
      const tab = shellTab(t);
      await tab.open(u, '#/schedule');
      assert.deepEqual(lines(tab), [want], u.role);
    }
  }
  // Before the start, nobody is told to renew, and paused dates name the start date.
  const tab = shellTab(t);
  await tab.open(early.student, '#/schedule');
  assert.ok(!/renew/i.test(words(tab.main())), 'nothing asks to renew a membership that has not started');
  for (let i = 0; i < 3; i++) {
    byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Next week').click();
    await tab.settle();
  }
  const nov4 = tab.main().findAll(n => n.tag === 'li').map(words).filter(w => /Nov 4/.test(w));
  assert.deepEqual(nov4, ['Wed Nov 4 Afternoon Study 1pm–4pm · Membership starts Nov 2, 2026 Paused']);
  const parent = shellTab(t);
  await parent.open(early.parent, '#/schedule');
  assert.ok(words(parent.main()).includes("A paused schedule doesn't hold a seat. " + early.student.name.split(' ')[0] + "'s membership starts on Nov 2, 2026."));
  assert.ok(!/renew/i.test(words(parent.main())));
  const other = shellTab(t);
  await other.open(expired.parent, '#/schedule');
  assert.ok(words(other.main()).includes("A paused schedule doesn't hold a seat. It comes back once the membership is renewed and its days fit the weekly limit, if the seat is still free."));
});

test(['EN-4'], "a student whose membership lapsed hears one message on Schedule: it isn't active, the schedule is paused, and who renews it", async () => {
  const { t, loc, sess } = await world();
  const lapsed = t.fx.family(loc, { status: 'inactive' });
  t.fx.enroll(lapsed.student, sess, 0, { status: 'paused' });
  const expired = t.fx.family(loc, { expires: '2026-10-13' });
  t.fx.enroll(expired.student, sess, 0, { status: 'paused' });
  const never = t.fx.family(loc, { status: 'inactive' });
  const fine = t.fx.family(loc);
  const notes = tab => tab.main().findAll(n => n.getAttribute('role') === 'note').map(words);
  const paused = "Your membership isn't active, so your schedule is paused. Ask a parent or the front desk at Irvine to renew it.";
  for (const [who, want] of [[lapsed, [paused]], [expired, [paused]],
    [never, ["Your membership isn't active. Ask a parent or the front desk at Irvine to renew it."]], [fine, []]]) {
    const tab = shellTab(t);
    await tab.open(who.student, '#/schedule');
    assert.deepEqual(notes(tab), want);
  }
});

// L52: with no way to add a schedule (no membership, or one that isn't active), Schedule and Home don't
// point the parent at "Choose a schedule"; the notice there says why.
test(['EN-4'], 'a family that cannot add a schedule is not told to choose one on Schedule or Home', async () => {
  const { t, loc } = await world();
  const none = t.fx.family(loc);
  t.db.prepare('DELETE FROM memberships WHERE student_id = ?').run(none.student.id);
  const off = t.fx.family(loc, { status: 'inactive' });
  const fine = t.fx.family(loc);
  const empty = tab => tab.main().findAll(n => n.tag === 'p' && /^No (schedule|dates)/.test(words(n))).map(words);
  for (const [who, schedule, home] of [
    [none, 'No schedule yet.', 'No dates this week.'],
    [off, 'No schedule yet.', 'No dates this week.'],
    [fine, 'No schedule yet. Choose one under "Choose a schedule" below.', 'No dates this week. Choose a schedule in Schedule.']]) {
    const tab = shellTab(t);
    await tab.open(who.parent, '#/schedule');
    assert.deepEqual(empty(tab).filter(w => /^No schedule/.test(w)), [schedule]);
    const enrolls = byTag(tab.main(), 'button').filter(b => /^Enroll /.test(b.getAttribute('aria-label') || ''));
    assert.ok(enrolls.length > 0 && enrolls.every(b => (b.getAttribute('disabled') !== null) === (who !== fine)));
    await tab.go('#/home');
    assert.deepEqual(empty(tab), [home]);
  }
  // A student is pointed at a parent, on Home and Schedule.
  const tab = shellTab(t);
  await tab.open(none.student, '#/home');
  assert.deepEqual(empty(tab), ['No dates this week. Ask a parent to pick your schedule.']);
  await tab.go('#/schedule');
  assert.deepEqual(tab.main().findAll(n => n.tag === 'p' && n.cls.includes('empty')).map(words), ['No dates this week.', 'Ask a parent to pick your schedule.']);
});

test(['EN-1', 'EN-2'], "a student's My schedule is read-only: their schedule and this week, nothing to ask for", async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.fx.enroll(f.student, sess);
  const tab = shellTab(t);
  await tab.open(f.student, '#/schedule');
  assert.equal(byTag(tab.main(), 'h1')[0].textContent, 'My schedule');
  const mine = tab.main().find(n => n.getAttribute('aria-labelledby') === 'en-mine-h');
  assert.deepEqual(byTag(mine, 'li').map(words), ['Afternoon Study Mon, Wed, Fri · 1pm–4pm · Fall 2026 · Aug 17 – Dec 18']);
  assert.deepEqual(byTag(tab.main(), 'button').map(b => b.getAttribute('aria-label')), ['Previous week', 'Next week'], 'no Ask, Enroll or Drop');
  assert.ok(!/request|Ask to join/i.test(words(tab.main())));
  assert.equal(tab.main().find(n => n.getAttribute('data-card') === 'enrollment-requests'), undefined);
  await tab.go('#/home');
  assert.equal(tab.main().find(n => n.getAttribute('data-card') === 'enrollment-requests'), undefined, 'the requests Home card is gone');
  assert.ok(tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week'));
});

// SC-5: the schedule follows date changes on Schedule and Home.
test(['SC-5', 'EN-7'], 'a held schedule names its upcoming date changes, and the week shows added and moved dates', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess);
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.fx.sessionDate(sess, '2026-10-15', 'add');
  t.fx.sessionDate(sess, '2026-11-20', 'skip');
  t.fx.sessionDate(sess, '2026-11-23', 'skip', { reason: 'Staff training day' });
  t.fx.sessionDate(sess, '2026-11-24', 'add', { moved_from: '2026-11-23', reason: 'Staff training day' });
  const tab = shellTab(t);
  await tab.open(f.parent, '#/schedule');
  const mine = tab.main().find(n => n.getAttribute('aria-labelledby') === 'en-mine-h');
  assert.deepEqual(byTag(mine, 'li').map(words), [
    'Afternoon Study Mon, Wed, Fri · 1pm–4pm · Fall 2026 · Aug 17 – Dec 18 Extra date Thu Oct 15 No meeting Fri Nov 20 Moves Mon Nov 23 → Tue Nov 24 (Staff training day) Drop',
  ]);
  const week = () => tab.main().find(n => n.id === 'en-week-h').parentNode.findAll(n => n.tag === 'li').map(words);
  assert.ok(week().includes('Thu Oct 15 Afternoon Study 1pm–4pm · Added date Upcoming'), JSON.stringify(week()));
  await tab.go(`#/schedule/${f.student.id}/2026-11-23`);
  assert.deepEqual(week(), [
    'Tue Nov 24 Afternoon Study 1pm–4pm · Moved from Mon Upcoming',
    'Wed Nov 25 Afternoon Study 1pm–4pm Upcoming',
    'Fri Nov 27 Afternoon Study 1pm–4pm Upcoming',
  ]);
  await tab.go('#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), [
    'Mon 1pm–4pm Afternoon Study Absent', 'Today 1pm–4pm Afternoon Study Upcoming', 'Thu 1pm–4pm Afternoon Study · Added date Upcoming', 'Fri 1pm–4pm Afternoon Study Upcoming',
  ]);
});

// L35: enrollment notices open Schedule on the student they are about.
test(['EN-2', 'EN-5'], 'enrollment and waitlist notices in the Inbox open Schedule on the student they are about; old request items open Schedule', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { students: 2 });
  const leo = rename(t, f.students[0], 'Leo Garcia'), sofia = rename(t, f.students[1], 'Sofia Garcia');
  const en = await enroll(t, f.parent, sofia, sess); // Sofia is the second tab
  assert.equal(en.status, 201);
  // A v1 request item (D-48: no longer sent) still opens Schedule.
  t.db.prepare("INSERT INTO notifications (user_id, kind, title, body, ref_type, ref_id, created_at) VALUES (?, 'enrollment_request', 'Sofia asked to join Afternoon Study', '', 'enrollment_request', 99, ?)")
    .run(f.parent.id, t.clock.now() - 1000);
  const links = tab => tab.main().findAll(n => n.tag === 'li').map(li => li.childNodes[0])
    .map(item => [words(item).replace(/^New /, '').split(' ').slice(0, 2).join(' '), item.tag === 'a' ? item.getAttribute('href') : null]);
  const parent = shellTab(t);
  await parent.open(f.parent, '#/inbox');
  const toEnrollment = '#/schedule/enrollment/' + en.body.enrollment.id;
  assert.deepEqual(links(parent).sort(), [['Sofia asked', '#/schedule'], ['Sofia is', toEnrollment]]);
  const shown = tab => [byTag(tab.main(), 'button').filter(b => b.getAttribute('role') === 'tab' && b.getAttribute('aria-selected') === 'true').map(b => b.textContent),
    words(tab.main().find(n => n.id === 'en-mine-h'))];
  await parent.go(toEnrollment);
  assert.deepEqual(shown(parent), [['Sofia'], "Sofia's schedule"]);
  assert.ok(parent.main().find(n => n.id === 'en-week-h'), 'this week is shown');
  await parent.go('#/schedule');
  assert.deepEqual(shown(parent), [['Leo'], "Leo's schedule"]);
  // A schedule notice (a date change, ref_type 'session') opens the tab of the student who holds that schedule.
  await parent.go('#/schedule/session/' + sess.id);
  assert.deepEqual(shown(parent), [['Sofia'], "Sofia's schedule"]);
  await parent.go('#/schedule/session/99999');
  assert.deepEqual(shown(parent), [['Leo'], "Leo's schedule"]);
  // The student's own notice opens their schedule, with this week shown.
  const student = shellTab(t);
  await student.open(sofia, '#/inbox');
  assert.deepEqual(links(student), [['Sofia is', toEnrollment]]);
  await student.go(toEnrollment);
  assert.equal(byTag(student.main(), 'h1')[0].textContent, 'My schedule');
  assert.ok(student.main().find(n => n.id === 'en-week-h'), 'this week is shown');
  // A waitlist promotion carries the same kind of link.
  const small = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2', start: '16:30', end: '18:30', capacity: 1 });
  const [holder] = fill(t, loc, small, 1);
  assert.equal((await joinLine(t, f.parent, leo, small)).body.outcome, 'waitlisted');
  const seat = t.db.prepare('SELECT id FROM enrollments WHERE student_id = ? AND session_id = ?').get(holder.student.id, small.id);
  assert.equal((await drop(t, holder.parent, seat.id)).status, 200);
  const promoted = t.db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND session_id = ? AND status = 'active'").get(leo.id, small.id);
  const later = shellTab(t);
  await later.open(f.parent, '#/inbox');
  assert.ok(links(later).some(([text, href]) => text === 'A seat' && href === '#/schedule/enrollment/' + promoted.id), JSON.stringify(links(later)));
  await later.go('#/schedule/enrollment/' + promoted.id);
  assert.deepEqual(shown(later), [['Leo'], "Leo's schedule"]);
});

// ---------------------------------------------------------------- D-28, D-34, D-32 on the Schedule

// D-28: one visit through back-to-back schedules counts for every one it overlaps at that
// location, on the Schedule and the Home "This week" card, the rule attendance uses.
test(['EN-7'], 'one visit through back-to-back schedules marks every one it overlaps attended, never absent', async () => {
  const { t, loc } = await world();
  const f = t.fx.family(loc);
  const early = t.fx.session(loc, { name: 'Early', weekdays: '3,5', start: '13:00', end: '16:00' });
  const late = t.fx.session(loc, { name: 'Late', weekdays: '3,5', start: '16:00', end: '19:00' });
  const night = t.fx.session(loc, { name: 'Night', weekdays: '5', start: '19:00', end: '20:00' });
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const away = t.fx.session(arcadia, { name: 'Arcadia Study', weekdays: '3', start: '16:00', end: '19:00' });
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, early);
  t.fx.enroll(f.student, late);
  t.clock.set(at(LA, '2026-10-10', '09:00'));
  t.fx.enroll(f.student, night); // Night only from Sat Oct 10
  const stay = (d, from, to, session = early, place = loc) => t.fx.visit(f.student, place, { session, local_date: d,
    check_in_at: at(LA, d, from), check_out_at: at(LA, d, to), checkout_method: 'scan' });
  stay('2026-09-30', '12:55', '16:00'); // out when Early ended: Late is not covered
  stay('2026-09-30', '16:30', '18:00', away, arcadia); // another location's visit never counts here
  stay('2026-10-09', '12:55', '19:55'); // through Night's hours, but before Night was theirs
  stay('2026-10-14', '12:55', '18:55'); // one visit, Early then Late
  t.clock.set(at(LA, '2026-10-14', '19:30'));
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-28&to=2026-10-18`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.name} ${o.status}`), [
    '2026-09-30 Early attended', '2026-09-30 Late absent',
    '2026-10-02 Early absent', '2026-10-02 Late absent',
    '2026-10-07 Early absent', '2026-10-07 Late absent',
    '2026-10-09 Early attended', '2026-10-09 Late attended',
    '2026-10-14 Early attended', '2026-10-14 Late attended',
    '2026-10-16 Early upcoming', '2026-10-16 Late upcoming', '2026-10-16 Night upcoming',
  ]);
  const both = s.body.occurrences.filter(o => o.date === '2026-10-14').map(o => [o.check_in_at, o.check_out_at]);
  const stayed = [at(LA, '2026-10-14', '12:55'), at(LA, '2026-10-14', '18:55')];
  assert.deepEqual(both, [stayed, stayed]);
  // Home "This week" shows both as attended too.
  const tab = shellTab(t);
  await tab.open(f.parent, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), [
    'Today 1pm–4pm Early Attended', 'Today 4pm–7pm Late Attended', 'Fri 1pm–4pm Early Upcoming', 'Fri 4pm–7pm Late Upcoming', 'Fri 7pm–8pm Night Upcoming',
  ]);
});

// Fix list Oct 21, item 1: a visit still open (no check-out yet) has lasted only until now, and never
// past the time auto-checkout will close it (D-14). It never makes a later schedule that day read
// "Attended" before that schedule has begun; a back-to-back stay (D-28) covers each one once it begins.
test(['EN-7'], 'an open visit counts only for schedules already under way, never for a later one that has not started', async () => {
  const { t, loc, sess } = await world(); // Afternoon Study Mon/Wed/Fri 13:00-16:00
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '3', start: '09:30', end: '12:00' });
  const midday = t.fx.session(loc, { name: 'Midday Lab', weekdays: '3', start: '12:00', end: '13:00' });
  const ana = t.fx.family(loc), ben = t.fx.family(loc), cy = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  for (const f of [ana, cy]) { t.fx.enroll(f.student, morning); t.fx.enroll(f.student, sess); }
  t.fx.enroll(ben.student, morning); // Ben stays on through Midday Lab, back to back
  t.fx.enroll(ben.student, midday);
  const d = '2026-10-14';
  // Ana scanned in for Morning Focus at 9:55, Ben too; staff checked Cy in at 9:55 with no schedule.
  t.fx.visit(ana.student, loc, { session: morning, local_date: d, check_in_at: at(LA, d, '09:55') });
  t.fx.visit(ben.student, loc, { session: morning, local_date: d, check_in_at: at(LA, d, '09:55') });
  t.fx.visit(cy.student, loc, { local_date: d, check_in_at: at(LA, d, '09:55'), checkin_method: 'staff' });
  const today = async f => (await dates(t, f.parent, f.student, d, d)).map(o => `${o.name} ${o.status}`);
  t.clock.set(at(LA, d, '09:55'));
  assert.deepEqual(await today(ana), ['Morning Focus attended', 'Afternoon Study upcoming']);
  assert.deepEqual(await today(cy), ['Morning Focus attended', 'Afternoon Study upcoming']);
  assert.deepEqual(await today(ben), ['Morning Focus attended', 'Midday Lab upcoming']);
  // Home "This week" says the same.
  const tab = shellTab(t);
  await tab.open(ana.parent, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words).filter(x => x.startsWith('Today')),
    ['Today 9:30am–12pm Morning Focus Attended', 'Today 1pm–4pm Afternoon Study Upcoming']);
  // 12:10: Ben's stay runs on into Midday Lab, which has begun, so both count (D-28).
  t.clock.set(at(LA, d, '12:10'));
  assert.deepEqual(await today(ben), ['Morning Focus attended', 'Midday Lab attended']);
  // 1:30pm, auto-checkout not yet run: Ana's visit closes at 12:00 (Afternoon Study's check-in window
  // opened only at 12:30), so it still never covers Afternoon Study.
  t.clock.set(at(LA, d, '13:30'));
  assert.deepEqual(await today(ana), ['Morning Focus attended', 'Afternoon Study upcoming']);
});

// D-34: a schedule's time edit applies from the edit date on. Past dates keep the hours they had, so
// their status and times on the Schedule do not change.
test(['EN-7'], "editing a schedule's times leaves past dates on the Schedule with the hours they had and the same status", async () => {
  const { t, loc, sess } = await world({ weekdays: '1,3' }); // Mon/Wed 13:00-16:00
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess);
  // A staff check-in with no schedule on Wed Oct 7, 13:05-14:50; a linked visit on Mon Oct 12.
  t.fx.visit(f.student, loc, { local_date: '2026-10-07', check_in_at: at(LA, '2026-10-07', '13:05'), check_out_at: at(LA, '2026-10-07', '14:50'),
    checkin_method: 'staff', checkout_method: 'staff' });
  t.fx.visit(f.student, loc, { session: sess, local_date: '2026-10-12', check_in_at: at(LA, '2026-10-12', '13:00'),
    check_out_at: at(LA, '2026-10-12', '16:00'), checkout_method: 'scan' });
  t.clock.set(at(LA, '2026-10-13', '10:00'));
  const weeks = async () => (await dates(t, f.parent, f.student, '2026-09-28', '2026-10-19')).map(o => `${o.date} ${o.start_time}-${o.end_time} ${o.status}`);
  const before = [
    '2026-09-28 13:00-16:00 absent', '2026-09-30 13:00-16:00 absent', '2026-10-05 13:00-16:00 absent',
    '2026-10-07 13:00-16:00 attended', '2026-10-12 13:00-16:00 attended',
  ];
  assert.deepEqual(await weeks(), [...before, '2026-10-14 13:00-16:00 upcoming', '2026-10-19 13:00-16:00 upcoming']);
  // Tue Oct 13: the director moves it to 15:00-18:00; the sessions module keeps the old times through Oct 12 (R8).
  t.db.prepare("UPDATE sessions SET start_time = '15:00', end_time = '18:00' WHERE id = ?").run(sess.id);
  t.db.prepare("INSERT INTO session_times (session_id, until_date, start_time, end_time, changed_at) VALUES (?, '2026-10-12', '13:00', '16:00', ?)")
    .run(sess.id, t.clock.now());
  assert.deepEqual(await weeks(), [...before, '2026-10-14 15:00-18:00 upcoming', '2026-10-19 15:00-18:00 upcoming']);
  const s = await dates(t, f.parent, f.student, '2026-09-30', '2026-09-30');
  assert.deepEqual([s[0].start_at, s[0].end_at], [at(LA, '2026-09-30', '13:00'), at(LA, '2026-09-30', '16:00')]);
});

// D-32: before the membership's start date nothing is absent. The start date is the one in force
// that date, so moving it forward leaves the dates before the change as they were.
test(['EN-7'], 'dates before the membership starts show as not started, never absent, on the Schedule and Home', async () => {
  const { t, loc, sess } = await world({ weekdays: '1' });
  const f = t.fx.family(loc); // membership from Aug 1
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess); // Mondays
  const m = t.db.prepare('SELECT * FROM memberships WHERE student_id = ?').get(f.student.id);
  // Wed Oct 14: staff move the start to Mon Nov 2, written to the audit log as D-26 says.
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  const pick = r => ({ status: r.status, weekly_cap: r.weekly_cap, start_date: r.start_date, expires_on: r.expires_on });
  t.db.prepare("UPDATE memberships SET start_date = '2026-11-02' WHERE id = ?").run(m.id);
  t.db.prepare("INSERT INTO audit_log (action, target_type, target_id, location_id, detail, at) VALUES ('membership.update', 'membership', ?, ?, ?, ?)")
    .run(m.id, loc.id, JSON.stringify({ student_id: f.student.id, before: pick(m), after: Object.assign(pick(m), { start_date: '2026-11-02' }) }), t.clock.now());
  // A staff check-in with no schedule on Mon Oct 19: they came, so it is attended.
  t.fx.visit(f.student, loc, { local_date: '2026-10-19', check_in_at: at(LA, '2026-10-19', '13:10'), check_out_at: at(LA, '2026-10-19', '15:00'),
    checkin_method: 'staff', checkout_method: 'staff' });
  t.clock.set(at(LA, '2026-11-04', '10:00'));
  assert.deepEqual((await dates(t, f.parent, f.student, '2026-10-05', '2026-11-09')).map(o => `${o.date} ${o.status} ${o.membership_starts}`), [
    '2026-10-05 absent null', '2026-10-12 absent null', // missed under the membership in force then
    '2026-10-19 attended null', '2026-10-26 not_started 2026-11-02',
    '2026-11-02 absent null', '2026-11-09 upcoming null',
  ]);
  // Late October the family sees the date before the start as not started, never absent.
  t.clock.set(at(LA, '2026-10-28', '10:00'));
  const tab = shellTab(t);
  await tab.open(f.parent, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), ['Mon 1pm–4pm Afternoon Study Not started']);
  await tab.go('#/schedule');
  const rows = tab.main().findAll(n => n.tag === 'li').map(words).filter(w => /Oct 26/.test(w));
  assert.deepEqual(rows, ['Mon Oct 26 Afternoon Study 1pm–4pm · Membership starts Nov 2, 2026 Not started']);
});

// L33: a renewal while today's date is running brings today's date back; it is not "Paused"
// while the student can check in. If it ends unattended it stays paused, never absent.
test(['EN-7'], "a schedule restored while today's date is running shows today as upcoming, and as paused if it ends unattended", async () => {
  const { t, loc, sess } = await world({ weekdays: '1' }); // Mondays 13:00-16:00
  const f = t.fx.family(loc), g = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const e = t.fx.enroll(f.student, sess);
  t.fx.enroll(g.student, sess);
  t.clock.set(at(LA, '2026-10-24', '08:00')); // both memberships lapse and the schedules pause (MB-5)
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE session_id = ?").run(sess.id);
  t.clock.set(at(LA, '2026-10-26', '13:05')); // Mon: f's membership is renewed five minutes into the date
  t.db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(e.id);
  const today = async (who, clock) => {
    t.clock.set(at(LA, '2026-10-26', clock));
    return (await dates(t, who.parent, who.student, '2026-10-26', '2026-11-02')).map(o => `${o.date} ${o.status}`);
  };
  assert.deepEqual(await today(f, '13:10'), ['2026-10-26 upcoming', '2026-11-02 upcoming']);
  assert.deepEqual(await today(g, '13:10'), ['2026-10-26 paused', '2026-11-02 paused'], 'a schedule still paused stays paused');
  const tab = shellTab(t);
  await tab.open(f.student, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), ['Today 1pm–4pm Afternoon Study Upcoming']);
  // It ended and she never came: on hold when it began, so paused, not absent.
  assert.deepEqual(await today(f, '16:30'), ['2026-10-26 paused', '2026-11-02 upcoming']);
  // Had she checked in, it is attended.
  t.fx.visit(f.student, loc, { session: sess, local_date: '2026-10-26', check_in_at: at(LA, '2026-10-26', '13:15'), check_out_at: at(LA, '2026-10-26', '16:00'), checkout_method: 'scan' });
  assert.deepEqual(await today(f, '16:30'), ['2026-10-26 attended', '2026-11-02 upcoming']);
});
