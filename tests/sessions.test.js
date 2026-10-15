'use strict';
// Sessions and scheduling: SC-1..SC-4, scope on every route (NF-1), and
// per-location time zones (NF-4).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, at, ROOT } = require('./lib');

const MON = '2026-11-23'; // a Monday inside the default Fall 2026 term (Aug 17 - Dec 18)

// Two locations, each with the default Fall 2026 term, plus their staff.
async function world(opts) {
  const t = await makeApp(opts);
  const a = t.fx.location({ name: 'Irvine' });
  const b = t.fx.location({ name: 'Arcadia' });
  return {
    t, a, b, termA: t.fx.term(a), termB: t.fx.term(b),
    dirA: t.fx.director(a), dirB: t.fx.director(b), staffA: t.fx.staff(a), staffB: t.fx.staff(b), hq: t.fx.hq(),
  };
}
const block = over => Object.assign({ name: 'Afternoon Study', weekdays: [1, 3, 5], start_time: '13:00', end_time: '16:00', capacity: 10 }, over);
const row = (t, id) => t.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
const enrollment = (t, id) => t.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id);
const count = (t, sql, ...args) => t.db.prepare(sql).get(...args).n;
const sent = (t, user, kind) => t.fx.notifications(user, kind).length;
function waitlist(t, student, session, weekday) {
  const id = Number(t.db.prepare("INSERT INTO waitlist (student_id, session_id, weekday, status, created_at) VALUES (?,?,?,'waiting',?)")
    .run(student.id, session.id, weekday, t.clock.now()).lastInsertRowid);
  return id;
}
const waitRow = (t, id) => t.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);

// ---------------- SC-1: directors create 2-3 hour recurring blocks ----------------

test(['SC-1'], 'a director creates a Mon/Wed/Fri 1-4pm session at their own location', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termA.id }));
  assert.equal(r.status, 201);
  const s = row(w.t, r.body.session.id);
  assert.equal(s.location_id, w.a.id);
  assert.equal(s.term_id, w.termA.id);
  assert.equal(s.name, 'Afternoon Study');
  assert.equal(s.weekdays, '1,3,5');
  assert.equal(s.start_time, '13:00');
  assert.equal(s.end_time, '16:00');
  assert.equal(s.capacity, 10);
  assert.equal(s.status, 'active');
  assert.equal(s.created_by, w.dirA.id);
  assert.deepEqual(r.body.session.slots.map(x => x.weekday), [1, 3, 5]);
  const log = w.t.fx.audit('session.create');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, w.dirA.id);
  assert.equal(log[0].target_id, s.id);
  const list = await w.t.as(w.dirA).get('/api/sessions');
  assert.deepEqual(list.body.sessions.map(x => [x.name, x.weekdays, x.start_time, x.end_time]), [['Afternoon Study', [1, 3, 5], '13:00', '16:00']]);
});

test(['SC-1'], 'a session runs 2 to 3 hours on at least one real weekday and ends after it starts', async () => {
  const w = await world();
  const post = over => w.t.as(w.dirA).post('/api/sessions', block(Object.assign({ term_id: w.termA.id }, over)));
  const refused = [
    [{ end_time: '14:59' }, 'duration'],
    [{ end_time: '16:01' }, 'duration'],
    [{ start_time: '16:00', end_time: '13:00' }, 'end_before_start'],
    [{ end_time: '13:00' }, 'end_before_start'],
    [{ weekdays: [] }, 'weekdays'],
    [{ weekdays: [0, 3] }, 'weekdays'],
    [{ weekdays: [8] }, 'weekdays'],
    [{ start_time: '1pm' }, 'time'],
    [{ name: '   ' }, 'name'],
  ];
  for (const [over, code] of refused) {
    const r = await post(over);
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.body.error, code, JSON.stringify(over));
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal((await post({ end_time: '15:00' })).status, 201); // exactly 2 hours
  assert.equal((await post({ end_time: '16:00' })).status, 201); // exactly 3 hours
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 2);
});

test(['SC-1', 'SC-4'], 'edits follow the same rules as new sessions', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s, 1);
  for (const [body, code] of [[{ end_time: '17:30' }, 'duration'], [{ weekdays: [] }, 'weekdays'], [{ capacity: 0 }, 'capacity'], [{ start_time: '17:00' }, 'end_before_start']]) {
    const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, code);
  }
  const after = row(w.t, s.id);
  assert.deepEqual([after.weekdays, after.start_time, after.end_time, after.capacity], ['1,3', '13:00', '16:00', 10]);
  assert.equal(w.t.fx.notifications(fam.parent).length, 0);
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/99999', { capacity: 5 })).status, 404);
});

test(['SC-1', 'NF-1'], 'a session must belong to a term at its own location', async () => {
  const w = await world();
  const wrong = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termB.id }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'term');
  assert.equal((await w.t.as(w.dirA).post('/api/sessions', block())).body.error, 'term');
  const hqWrong = await w.t.as(w.hq).post('/api/sessions', block({ location_id: w.b.id, term_id: w.termA.id }));
  assert.equal(hqWrong.status, 400);
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  const noLoc = await w.t.as(w.hq).post('/api/sessions', block({ term_id: w.termB.id }));
  assert.equal(noLoc.status, 400);
  assert.equal(noLoc.body.error, 'location');
  const ok = await w.t.as(w.hq).post('/api/sessions', block({ location_id: w.b.id, term_id: w.termB.id }));
  assert.equal(ok.status, 201);
  assert.equal(row(w.t, ok.body.session.id).location_id, w.b.id);
});

// ---------------- SC-2: capacity per weekly slot, no seats ----------------

test(['SC-2'], 'capacity and counts are per weekly day, paused ones counted apart, and nobody is assigned a seat', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3', capacity: 3 });
  const kids = [1, 2, 3, 4, 5, 6].map(() => w.t.fx.family(w.a).student);
  w.t.fx.enroll(kids[0], s, 1);
  w.t.fx.enroll(kids[1], s, 1);
  w.t.fx.enroll(kids[2], s, 3);
  w.t.fx.enroll(kids[3], s, 3, { status: 'paused' });
  w.t.fx.enroll(kids[4], s, 1, { status: 'dropped' });
  waitlist(w.t, kids[5], s, 1);
  const r = await w.t.as(w.staffA).get('/api/sessions?location_id=' + w.a.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions.find(x => x.id === s.id).slots, [
    { weekday: 1, enrolled: 2, paused: 0, waiting: 1, capacity: 3, seats_left: 1 },
    { weekday: 3, enrolled: 1, paused: 1, waiting: 0, capacity: 3, seats_left: 2 },
  ]);
  // A paused enrollment holds no seat (D-16), but it is counted, because taking off its day ends it too (D-26).
  // Capacity can come down to the busiest day's count (2), not the whole session's (3).
  const e = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 2 });
  assert.equal(e.status, 200);
  assert.equal(row(w.t, s.id).capacity, 2);
});

test(['SC-2'], 'capacity is a whole number of at least 1', async () => {
  const w = await world();
  for (const capacity of [0, -1, 2.5, 'ten', '']) {
    const r = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termA.id, capacity }));
    assert.equal(r.status, 400, String(capacity));
    assert.equal(r.body.error, 'capacity');
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  const one = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termA.id, capacity: 1 }));
  assert.equal(one.status, 201);
  assert.equal(row(w.t, one.body.session.id).capacity, 1);
});

test(['SC-2'], 'seats per day top out at 1,000, so a runaway number never reaches the schedule', async () => {
  const w = await world(); // Wed 14 Oct 2026
  const s = w.t.fx.session(w.a, { name: 'Irvine Study', weekdays: '3', capacity: 10 });
  // 9999999999999999 is past Number.MAX_SAFE_INTEGER: once stored, every read of the row would throw.
  for (const capacity of [9999999999999999, 1e300, 1001]) {
    const post = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termA.id, capacity }));
    assert.equal(post.status, 400, 'POST ' + capacity);
    assert.equal(post.body.error, 'capacity', 'POST ' + capacity);
    const put = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity });
    assert.equal(put.status, 400, 'PUT ' + capacity);
    assert.equal(put.body.error, 'capacity', 'PUT ' + capacity);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 1);
  assert.equal(row(w.t, s.id).capacity, 10);
  // The location's schedule and today's list still load.
  const list = await w.t.as(w.staffA).get('/api/sessions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.sessions.map(x => [x.id, x.capacity]), [[s.id, 10]]);
  const today = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(today.status, 200);
  assert.deepEqual(today.body.sessions.map(x => [x.id, x.capacity]), [[s.id, 10]]);
  // 1,000 is allowed, on a new session and on an edit.
  const top = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termA.id, capacity: 1000 }));
  assert.equal(top.status, 201);
  assert.equal(row(w.t, top.body.session.id).capacity, 1000);
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 1000 })).status, 200);
  assert.equal(row(w.t, s.id).capacity, 1000);
});

// { toString: 1 } makes String() and Number() throw; { a: 1 } turns into "[object Object]".
const POISON = { toString: 1 };
const PLAIN = { a: 1 };

test(['SC-1', 'SC-2'], 'a session field sent as an object is refused with a 400, never stored or crashed on', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Irvine Study', weekdays: '1,3' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s, 1);
  const shared = [
    [{ name: POISON }, 'name'], [{ name: PLAIN }, 'name'], [{ name: 42 }, 'name'],
    [{ start_time: POISON }, 'time'], [{ end_time: POISON }, 'time'],
    [{ weekdays: POISON }, 'weekdays'], [{ weekdays: [1, POISON] }, 'weekdays'],
    [{ capacity: POISON }, 'capacity'], [{ capacity: true }, 'capacity'], [{ capacity: [12] }, 'capacity'],
  ];
  for (const [over, code] of [...shared, [{ term_id: POISON }, 'term'], [{ location_id: POISON }, 'location']]) {
    const r = await w.t.as(w.dirA).post('/api/sessions', block(Object.assign({ term_id: w.termA.id }, over)));
    assert.equal(r.status, 400, 'POST ' + JSON.stringify(over));
    assert.equal(r.body.error, code, 'POST ' + JSON.stringify(over));
  }
  for (const [over, code] of shared) {
    const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, over);
    assert.equal(r.status, 400, 'PUT ' + JSON.stringify(over));
    assert.equal(r.body.error, code, 'PUT ' + JSON.stringify(over));
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 1);
  const after = row(w.t, s.id);
  assert.deepEqual([after.name, after.weekdays, after.start_time, after.end_time, after.capacity], ['Irvine Study', '1,3', '13:00', '16:00', 10]);
  assert.equal(w.t.fx.notifications(fam.parent).length, 0);
  // Plain values in the same shape still work.
  const ok = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: String(w.termA.id), weekdays: '2,4', capacity: '12' }));
  assert.equal(ok.status, 201);
  assert.deepEqual([row(w.t, ok.body.session.id).weekdays, row(w.t, ok.body.session.id).capacity], ['2,4', 12]);
});

test(['SC-3'], 'a term name, closure reason or location sent as an object is refused with a 400', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s, 1);
  const spring = { name: 'Spring 2027', start_date: '2027-01-11', end_date: '2027-05-28' };
  for (const [over, code] of [[{ name: POISON }, 'name'], [{ name: PLAIN }, 'name'], [{ location_id: POISON }, 'location']]) {
    const r = await w.t.as(w.dirA).post('/api/sessions/terms', Object.assign({}, spring, over));
    assert.equal(r.status, 400, 'POST ' + JSON.stringify(over));
    assert.equal(r.body.error, code, 'POST ' + JSON.stringify(over));
  }
  for (const name of [POISON, PLAIN]) {
    const r = await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { name });
    assert.equal(r.status, 400, 'PUT ' + JSON.stringify(name));
    assert.equal(r.body.error, 'name');
  }
  assert.deepEqual(w.t.db.prepare('SELECT name FROM terms WHERE location_id = ?').all(w.a.id).map(x => x.name), ['Fall 2026']);
  for (const [over, code] of [[{ reason: POISON }, 'reason'], [{ reason: PLAIN }, 'reason'], [{ reason: 7 }, 'reason'], [{ location_id: POISON }, 'location']]) {
    const r = await w.t.as(w.dirA).post('/api/sessions/closures', Object.assign({ date: MON }, over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.body.error, code, JSON.stringify(over));
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);
  assert.equal(w.t.fx.notifications(fam.parent).length, 0);
  // A closure with no reason at all is still fine.
  const ok = await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON, reason: null });
  assert.equal(ok.status, 201);
  assert.equal(w.t.db.prepare('SELECT reason FROM closures WHERE id = ?').get(ok.body.closure.id).reason, null);
});

test(['SC-2', 'SC-4'], 'capacity cannot go below the students already enrolled on a day that stays', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3', capacity: 5 });
  for (let i = 0; i < 3; i++) w.t.fx.enroll(w.t.fx.family(w.a).student, s, 1);
  w.t.fx.enroll(w.t.fx.family(w.a).student, s, 3);
  for (let i = 0; i < 2; i++) w.t.fx.enroll(w.t.fx.family(w.a).student, s, 1, { status: 'paused' }); // paused students hold no seat
  const low = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 2 });
  assert.equal(low.status, 409);
  assert.equal(low.body.error, 'capacity_below_enrolled');
  assert.match(low.body.message, /3 students are already enrolled on Mondays/);
  assert.equal(row(w.t, s.id).capacity, 5);
  const exact = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 3 });
  assert.equal(exact.status, 200);
  assert.equal(row(w.t, s.id).capacity, 3);
  // Taking Monday off in the same edit ends Monday's enrollments, so only Wednesday's 1 counts.
  const both = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { weekdays: [3], capacity: 1 });
  assert.equal(both.status, 200);
  assert.deepEqual([row(w.t, s.id).weekdays, row(w.t, s.id).capacity], ['3', 1]);
});

// ---------------- SC-3: terms and holiday closures ----------------

test(['SC-3'], 'directors set terms with start and end dates', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post('/api/sessions/terms', { name: 'Spring 2027', start_date: '2027-01-11', end_date: '2027-05-28' });
  assert.equal(r.status, 201);
  const term = w.t.db.prepare('SELECT * FROM terms WHERE id = ?').get(r.body.term.id);
  assert.deepEqual([term.location_id, term.name, term.start_date, term.end_date], [w.a.id, 'Spring 2027', '2027-01-11', '2027-05-28']);
  for (const [body, code] of [
    [{ name: 'Bad', start_date: '2027-05-28', end_date: '2027-01-11' }, 'end_before_start'],
    [{ name: 'Bad', start_date: '2027-01-11' }, 'dates'],
    [{ name: 'Bad', start_date: '2027-02-30', end_date: '2027-05-28' }, 'dates'],
    [{ name: ' ', start_date: '2027-01-11', end_date: '2027-05-28' }, 'name'],
  ]) {
    const bad = await w.t.as(w.dirA).post('/api/sessions/terms', body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(bad.body.error, code);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM terms WHERE location_id = ?', w.a.id), 2);
  const e = await w.t.as(w.dirA).put('/api/sessions/terms/' + term.id, { end_date: '2027-06-04' });
  assert.equal(e.status, 200);
  assert.deepEqual({ ...w.t.db.prepare('SELECT name, end_date FROM terms WHERE id = ?').get(term.id) }, { name: 'Spring 2027', end_date: '2027-06-04' });
  const flip = await w.t.as(w.dirA).put('/api/sessions/terms/' + term.id, { start_date: '2027-07-01' });
  assert.equal(flip.status, 400);
  assert.equal(flip.body.error, 'end_before_start');
  const list = await w.t.as(w.staffA).get('/api/sessions');
  assert.deepEqual(list.body.terms.map(x => x.name), ['Fall 2026', 'Spring 2027']);
  assert.equal(w.t.fx.audit('term.create').length, 1);
  assert.equal(w.t.fx.audit('term.update').length, 1);
});

test(['SC-3'], 'a closure tells the students and active parents enrolled that weekday, and nobody else', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3,5' });
  const mon = w.t.fx.family(w.a);
  const guardian2 = w.t.fx.user('parent', { location: w.a });
  w.t.fx.link(guardian2, mon.student);
  const pendingParent = w.t.fx.user('parent', { location: w.a });
  w.t.fx.link(pendingParent, mon.student, 'pending');
  w.t.fx.enroll(mon.student, s, 1);
  const wed = w.t.fx.family(w.a);
  w.t.fx.enroll(wed.student, s, 3);
  const dropped = w.t.fx.family(w.a);
  w.t.fx.enroll(dropped.student, s, 1, { status: 'dropped' });
  const paused = w.t.fx.family(w.a);
  w.t.fx.enroll(paused.student, s, 1, { status: 'paused' });
  const spring = w.t.fx.term(w.a, { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' });
  const springFam = w.t.fx.family(w.a);
  w.t.fx.enroll(springFam.student, w.t.fx.session(w.a, { term: spring, weekdays: '1' }), 1);
  const other = w.t.fx.family(w.b);
  w.t.fx.enroll(other.student, w.t.fx.session(w.b, { weekdays: '1' }), 1);

  const r = await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON, reason: 'Staff training' });
  assert.equal(r.status, 201);
  assert.equal(r.body.notified, 3);
  const c = w.t.db.prepare('SELECT * FROM closures WHERE location_id = ?').all(w.a.id);
  assert.deepEqual(c.map(x => [x.date, x.reason, x.created_by]), [[MON, 'Staff training', w.dirA.id]]);
  for (const u of [mon.student, mon.parent, guardian2]) {
    const n = w.t.fx.notifications(u, 'session_closure');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Irvine is closed Mon, Nov 23');
    assert.match(n[0].body, /^Staff training\. Sessions that day are cancelled/);
  }
  for (const u of [pendingParent, wed.student, wed.parent, dropped.student, dropped.parent, paused.student, paused.parent,
    springFam.student, springFam.parent, other.student, other.parent]) {
    assert.equal(sent(w.t, u, 'session_closure'), 0, u.name);
  }
  // Enrollments stay (D-19): only that date's occurrence is cancelled.
  assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND status = 'active'", s.id), 2);
  assert.equal(w.t.fx.audit('closure.create').length, 1);
});

test(['SC-3'], 'closures must fall inside one of the location\'s own terms', async () => {
  const w = await world();
  w.t.fx.term(w.b, { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' }); // only Arcadia has a spring term
  for (const date of ['2027-01-18', '2026-08-10']) {
    const r = await w.t.as(w.dirA).post('/api/sessions/closures', { date, reason: 'Holiday' });
    assert.equal(r.status, 400, date);
    assert.equal(r.body.error, 'outside_term');
  }
  for (const date of ['2026-13-01', undefined]) {
    const r = await w.t.as(w.dirA).post('/api/sessions/closures', { date });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'date');
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON })).status, 201);
  const dup = await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON });
  assert.equal(dup.status, 409);
  const list = await w.t.as(w.staffA).get('/api/sessions');
  assert.deepEqual(list.body.closures.map(x => x.date), [MON]);
});

test(['SC-3'], 'removing a closure reopens the day and tells the same families', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3' });
  const mon = w.t.fx.family(w.a), wed = w.t.fx.family(w.a);
  w.t.fx.enroll(mon.student, s, 1);
  w.t.fx.enroll(wed.student, s, 3);
  const c = await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON, reason: 'Storm' });
  const r = await w.t.as(w.dirA).del('/api/sessions/closures/' + c.body.closure.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, 2);
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);
  for (const u of [mon.student, mon.parent]) {
    const n = w.t.fx.notifications(u, 'session_reopened');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Irvine is open Mon, Nov 23 after all');
  }
  assert.equal(sent(w.t, wed.parent, 'session_reopened'), 0);
  assert.equal(w.t.fx.audit('closure.delete').length, 1);
  assert.equal((await w.t.as(w.dirA).del('/api/sessions/closures/' + c.body.closure.id)).status, 404);
});

test(['SC-3'], 'a term can\'t be shortened past one of its closures', async () => {
  const w = await world();
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: '2026-12-14', reason: 'Winter break' })).status, 201);
  const r = await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-11' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'closure_outside_term');
  assert.equal(w.t.db.prepare('SELECT end_date FROM terms WHERE id = ?').get(w.termA.id).end_date, '2026-12-18');
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-14' })).status, 200);
});

test(['SC-2', 'SC-3'], 'today\'s sessions show enrolled against capacity, and a closure is flagged', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles
  const mwf = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5', capacity: 10 });
  w.t.fx.session(w.a, { name: 'Tue/Thu Study', weekdays: '2,4' });
  w.t.fx.session(w.a, { name: 'Morning Focus', weekdays: '3', start: '09:30', end: '12:00', capacity: 2 });
  const winter = w.t.fx.term(w.a, { name: 'Winter', start: '2027-01-04', end: '2027-03-26' });
  w.t.fx.session(w.a, { term: winter, name: 'Winter Study', weekdays: '3' });
  w.t.fx.enroll(w.t.fx.family(w.a).student, mwf, 3);
  w.t.fx.enroll(w.t.fx.family(w.a).student, mwf, 3);
  w.t.fx.enroll(w.t.fx.family(w.a).student, mwf, 1);
  waitlist(w.t, w.t.fx.family(w.a).student, mwf, 3);
  const r = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(r.status, 200);
  assert.equal(r.body.date, '2026-10-14');
  assert.equal(r.body.weekday, 3);
  assert.equal(r.body.closure, null);
  assert.deepEqual(r.body.sessions.map(s => s.name), ['Morning Focus', 'Afternoon Study']);
  const pm = r.body.sessions[1];
  assert.deepEqual([pm.enrolled, pm.waiting, pm.capacity], [2, 1, 10]);
  await w.t.as(w.dirA).post('/api/sessions/closures', { date: '2026-10-14', reason: 'Power outage' });
  const closed = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(closed.body.closure.reason, 'Power outage');
});

// ---------------- SC-4: edit and cancel, families told ----------------

test(['SC-4'], 'changing a session\'s name, time or capacity tells every enrolled family, paused ones included', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3', start: '13:00', end: '16:00', capacity: 10 });
  const act = w.t.fx.family(w.a);
  w.t.fx.enroll(act.student, s, 1);
  const pau = w.t.fx.family(w.a);
  w.t.fx.enroll(pau.student, s, 3, { status: 'paused' });
  const wait = w.t.fx.family(w.a);
  waitlist(w.t, wait.student, s, 1);
  const gone = w.t.fx.family(w.a);
  w.t.fx.enroll(gone.student, s, 1, { status: 'dropped' });
  const elsewhere = w.t.fx.family(w.a);
  w.t.fx.enroll(elsewhere.student, w.t.fx.session(w.a, { name: 'Morning', start: '09:00', end: '11:30' }), 1);

  const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Afternoon Focus', start_time: '13:30', end_time: '16:30' });
  assert.equal(r.status, 200);
  const after = row(w.t, s.id);
  assert.deepEqual([after.name, after.weekdays, after.start_time, after.end_time, after.capacity], ['Afternoon Focus', '1,3', '13:30', '16:30', 10]);
  for (const u of [act.student, act.parent, pau.student, pau.parent]) {
    const n = w.t.fx.notifications(u, 'session_changed');
    assert.equal(n.length, 1, u.name);
    assert.equal(n[0].title, 'Afternoon Study at Irvine has changed');
    assert.match(n[0].body, /It's now called Afternoon Focus\./);
    assert.match(n[0].body, /New time: 1:30 PM–4:30 PM \(was 1:00 PM–4:00 PM\)\./);
  }
  for (const u of [wait.student, wait.parent, gone.student, gone.parent, elsewhere.student, elsewhere.parent]) {
    assert.equal(sent(w.t, u, 'session_changed'), 0, u.name);
  }
  assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND status IN ('active','paused')", s.id), 2);
  const log = w.t.fx.audit('session.update');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, w.dirA.id);
  const detail = JSON.parse(log[0].detail);
  assert.deepEqual([detail.before.start_time, detail.after.start_time], ['13:00', '13:30']);

  // Adding a day changes nothing for current families.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { weekdays: [1, 3, 5] })).status, 200);
  assert.equal(row(w.t, s.id).weekdays, '1,3,5');
  assert.equal(sent(w.t, act.parent, 'session_changed'), 1);
  // A capacity change is news too.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 12 })).status, 200);
  const latest = w.t.fx.notifications(act.parent, 'session_changed');
  assert.equal(latest.length, 2);
  assert.match(latest[1].body, /Seats per day: 12 \(was 10\)\./);
});

test(['SC-4'], 'taking a day off a session ends that day\'s enrollments and waitlist and tells those families', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3,5' });
  const fri = w.t.fx.family(w.a);
  const eFri = w.t.fx.enroll(fri.student, s, 5);
  const friPaused = w.t.fx.family(w.a);
  const ePaused = w.t.fx.enroll(friPaused.student, s, 5, { status: 'paused' });
  const friWait = w.t.fx.family(w.a);
  const wFri = waitlist(w.t, friWait.student, s, 5);
  const mon = w.t.fx.family(w.a);
  const eMon = w.t.fx.enroll(mon.student, s, 1);
  const monWait = w.t.fx.family(w.a);
  const wMon = waitlist(w.t, monWait.student, s, 1);
  // Friday history from before the edit: a student who dropped in September and a waitlist
  // spot given up then. Their dates stay true (attendance and the schedule read ended_at),
  // and neither family hears about a day they already left.
  const sept = at('America/Los_Angeles', '2026-09-21', '15:00');
  const gone = w.t.fx.family(w.a);
  const eGone = w.t.fx.enroll(gone.student, s, 5, { status: 'dropped' });
  w.t.db.prepare('UPDATE enrollments SET ended_at = ? WHERE id = ?').run(sept, eGone.id);
  const leftWait = w.t.fx.family(w.a);
  const wLeft = waitlist(w.t, leftWait.student, s, 5);
  w.t.db.prepare("UPDATE waitlist SET status = 'removed', resolved_at = ? WHERE id = ?").run(sept, wLeft);
  const now = at('America/Los_Angeles', '2026-10-14', '11:00');
  w.t.clock.set(now);

  const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { weekdays: [1, 3] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ended, r.body.notified], [3, 6]);
  assert.equal(row(w.t, s.id).weekdays, '1,3');
  for (const id of [eFri.id, ePaused.id]) {
    assert.deepEqual([enrollment(w.t, id).status, enrollment(w.t, id).ended_at], ['dropped', now]);
  }
  assert.deepEqual([waitRow(w.t, wFri).status, waitRow(w.t, wFri).resolved_at], ['removed', now]);
  assert.deepEqual([enrollment(w.t, eGone.id).status, enrollment(w.t, eGone.id).ended_at], ['dropped', sept]);
  assert.deepEqual([waitRow(w.t, wLeft).status, waitRow(w.t, wLeft).resolved_at], ['removed', sept]);
  for (const u of [gone.student, gone.parent, leftWait.student, leftWait.parent]) {
    assert.equal(w.t.fx.notifications(u).length, 0, u.name);
  }
  assert.deepEqual([enrollment(w.t, eMon.id).status, enrollment(w.t, eMon.id).ended_at], ['active', null]);
  assert.equal(waitRow(w.t, wMon).status, 'waiting');
  for (const u of [fri.student, fri.parent, friPaused.student, friPaused.parent, friWait.student, friWait.parent]) {
    const n = w.t.fx.notifications(u, 'session_day_removed');
    assert.equal(n.length, 1, u.name);
    assert.equal(n[0].title, 'Afternoon Study no longer meets on Fridays');
  }
  for (const u of [mon.student, mon.parent, monWait.parent]) {
    assert.equal(sent(w.t, u, 'session_day_removed'), 0);
    assert.equal(sent(w.t, u, 'session_changed'), 0);
  }
  const list = await w.t.as(w.dirA).get('/api/sessions');
  assert.deepEqual(list.body.sessions[0].slots.map(x => x.weekday), [1, 3]);
});

test(['SC-4'], 'cancelling a session ends every enrollment and waitlist spot and tells every family', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3' });
  const keep = w.t.fx.session(w.a, { name: 'Morning Focus', start: '09:00', end: '11:30' });
  const fams = [w.t.fx.family(w.a), w.t.fx.family(w.a), w.t.fx.family(w.a), w.t.fx.family(w.a)];
  const live = [
    w.t.fx.enroll(fams[0].student, s, 1),
    w.t.fx.enroll(fams[1].student, s, 3),
    w.t.fx.enroll(fams[2].student, s, 1, { status: 'paused' }),
  ];
  const wl = waitlist(w.t, fams[3].student, s, 3);
  const other = w.t.fx.family(w.a);
  const eOther = w.t.fx.enroll(other.student, keep, 1);
  // History from before the cancel: a Monday student who dropped in September, and a
  // Wednesday waitlist spot that became an enrollment in September and was dropped later
  // that month. Their dates stay true (attendance and the schedule read ended_at), and
  // neither family hears about a session they already left.
  const sept = at('America/Los_Angeles', '2026-09-21', '15:00');
  const gone = w.t.fx.family(w.a);
  const eGone = w.t.fx.enroll(gone.student, s, 1, { status: 'dropped' });
  w.t.db.prepare('UPDATE enrollments SET ended_at = ? WHERE id = ?').run(sept, eGone.id);
  const promotedAt = at('America/Los_Angeles', '2026-09-08', '09:00');
  const promotedEnd = at('America/Los_Angeles', '2026-09-28', '17:00');
  const promoted = w.t.fx.family(w.a);
  const wPromoted = waitlist(w.t, promoted.student, s, 3);
  w.t.db.prepare("UPDATE waitlist SET status = 'enrolled', resolved_at = ? WHERE id = ?").run(promotedAt, wPromoted);
  const ePromoted = w.t.fx.enroll(promoted.student, s, 3, { status: 'dropped', source: 'waitlist' });
  w.t.db.prepare('UPDATE enrollments SET ended_at = ? WHERE id = ?').run(promotedEnd, ePromoted.id);
  const now = at('America/Los_Angeles', '2026-10-14', '12:00');
  w.t.clock.set(now);

  const r = await w.t.as(w.dirA).post('/api/sessions/' + s.id + '/cancel');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ended, r.body.notified], [4, 8]);
  assert.equal(row(w.t, s.id).status, 'cancelled');
  assert.deepEqual(w.t.db.prepare('SELECT id, status, ended_at FROM enrollments WHERE session_id = ? ORDER BY id').all(s.id).map(x => [x.id, x.status, x.ended_at]), [
    ...live.map(e => [e.id, 'dropped', now]),
    [eGone.id, 'dropped', sept],
    [ePromoted.id, 'dropped', promotedEnd],
  ]);
  assert.deepEqual([waitRow(w.t, wl).status, waitRow(w.t, wl).resolved_at], ['removed', now]);
  assert.deepEqual([waitRow(w.t, wPromoted).status, waitRow(w.t, wPromoted).resolved_at], ['enrolled', promotedAt]);
  assert.equal(enrollment(w.t, eOther.id).status, 'active');
  for (const f of fams) for (const u of [f.student, f.parent]) {
    const n = w.t.fx.notifications(u, 'session_cancelled');
    assert.equal(n.length, 1, u.name);
    assert.equal(n[0].title, 'Afternoon Study at Irvine is cancelled');
  }
  assert.equal(sent(w.t, other.parent, 'session_cancelled'), 0);
  for (const u of [gone.student, gone.parent, promoted.student, promoted.parent]) {
    assert.equal(w.t.fx.notifications(u).length, 0, u.name);
  }
  const list = await w.t.as(w.dirA).get('/api/sessions');
  assert.deepEqual(list.body.sessions.map(x => x.name), ['Morning Focus']);
  // Both sessions meet on Wednesdays; only the one still running is on today's list.
  const today = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(today.body.weekday, 3);
  assert.deepEqual(today.body.sessions.map(x => x.name), ['Morning Focus']);
  assert.equal(w.t.fx.audit('session.cancel').length, 1);
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/' + s.id + '/cancel')).status, 409);
  const edit = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Back again' });
  assert.equal(edit.status, 409);
  assert.equal(row(w.t, s.id).name, 'Afternoon Study');
});

// ---------------- NF-4: each location runs on its own time zone ----------------

test(['NF-4', 'SC-1'], 'a Toronto session keeps Toronto times, and "today" follows Toronto\'s calendar', async () => {
  const t = await makeApp({ now: at('America/Los_Angeles', '2026-10-14', '22:30') }); // already Thu 01:30 in Toronto
  const tor = t.fx.location({ name: 'Toronto', timezone: 'America/Toronto', lat: 43.6532, lng: -79.3832 });
  const la = t.fx.location({ name: 'Irvine' });
  const termT = t.fx.term(tor);
  t.fx.term(la);
  const dirT = t.fx.director(tor), staffT = t.fx.staff(tor), staffLA = t.fx.staff(la);
  const thu = await t.as(dirT).post('/api/sessions', { term_id: termT.id, name: 'Thursday Focus', weekdays: [4], start_time: '09:00', end_time: '11:30', capacity: 18 });
  assert.equal(thu.status, 201);
  await t.as(dirT).post('/api/sessions', { term_id: termT.id, name: 'Wednesday Focus', weekdays: [3], start_time: '09:00', end_time: '11:30', capacity: 18 });
  assert.deepEqual([row(t, thu.body.session.id).start_time, row(t, thu.body.session.id).end_time], ['09:00', '11:30']);

  const list = await t.as(staffT).get('/api/sessions');
  assert.equal(list.body.today, '2026-10-15');
  assert.equal(list.body.location.timezone, 'America/Toronto');
  assert.deepEqual(list.body.sessions.map(s => [s.name, s.start_time, s.end_time]),
    [['Thursday Focus', '09:00', '11:30'], ['Wednesday Focus', '09:00', '11:30']]);

  const today = await t.as(staffT).get('/api/sessions/today');
  assert.equal(today.body.date, '2026-10-15');
  assert.equal(today.body.weekday, 4);
  assert.deepEqual(today.body.sessions.map(s => s.name), ['Thursday Focus']);
  assert.equal(today.body.sessions[0].starts_at, at('America/Toronto', '2026-10-15', '09:00'));
  assert.equal(today.body.sessions[0].ends_at, at('America/Toronto', '2026-10-15', '11:30'));

  // The same instant is still Wednesday in Los Angeles.
  const laToday = await t.as(staffLA).get('/api/sessions/today');
  assert.deepEqual([laToday.body.date, laToday.body.weekday], ['2026-10-14', 3]);
});

// ---------------- NF-1: scope on every route ----------------

test(['NF-1'], 'reading a schedule: your own location only (families included), HQ any, signed in only', async () => {
  const w = await world();
  w.t.fx.session(w.a, { name: 'Irvine Study' });
  const famA = w.t.fx.family(w.a), famB = w.t.fx.family(w.b);
  const url = '/api/sessions?location_id=' + w.a.id;
  for (const u of [famB.parent, famB.student, w.staffB, w.dirB]) {
    const r = await w.t.as(u).get(url);
    assert.equal(r.status, 403, u.role);
    assert.equal(r.body.sessions, undefined);
  }
  assert.equal((await w.t.anon.get(url)).status, 401);
  for (const u of [famA.parent, famA.student, w.staffA, w.dirA, w.hq]) {
    const r = await w.t.as(u).get(url);
    assert.equal(r.status, 200, u.role);
    assert.deepEqual(r.body.sessions.map(s => s.name), ['Irvine Study']);
  }
  const own = await w.t.as(famB.parent).get('/api/sessions');
  assert.equal(own.status, 200);
  assert.equal(own.body.location.id, w.b.id);
  assert.equal((await w.t.as(w.hq).get('/api/sessions')).status, 400);
});

test(['NF-1'], 'today\'s sessions: staff and up, at their own location only', async () => {
  const w = await world();
  w.t.fx.session(w.a, { name: 'Irvine Study' });
  const famA = w.t.fx.family(w.a);
  const url = '/api/sessions/today?location_id=' + w.a.id;
  for (const u of [famA.parent, famA.student, w.staffB, w.dirB]) assert.equal((await w.t.as(u).get(url)).status, 403, u.role);
  for (const u of [w.staffA, w.dirA, w.hq]) {
    const r = await w.t.as(u).get(url);
    assert.equal(r.status, 200, u.role);
    assert.deepEqual(r.body.sessions.map(s => s.name), ['Irvine Study']);
  }
});

test(['NF-1'], 'a location\'s schedule, counts and closures never include another location\'s', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles (both locations)
  const sA = w.t.fx.session(w.a, { name: 'Irvine Study', weekdays: '1,3', capacity: 4 });
  const famA = w.t.fx.family(w.a);
  w.t.fx.enroll(famA.student, sA, 3);
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON, reason: 'Irvine staff training' })).status, 201);
  // Arcadia meets today too, with its own enrollments and waitlist, and is closed today.
  const sB = w.t.fx.session(w.b, { name: 'Arcadia Study', weekdays: '3', start: '09:30', end: '12:00', capacity: 6 });
  w.t.fx.enroll(w.t.fx.family(w.b).student, sB, 3);
  w.t.fx.enroll(w.t.fx.family(w.b).student, sB, 3);
  waitlist(w.t, w.t.fx.family(w.b).student, sB, 3);
  assert.equal((await w.t.as(w.dirB).post('/api/sessions/closures', { date: '2026-10-14', reason: 'Arcadia power outage' })).status, 201);

  const urlA = '/api/sessions?location_id=' + w.a.id;
  for (const u of [w.staffA, w.dirA, famA.parent, w.hq]) {
    const r = await w.t.as(u).get(urlA);
    assert.equal(r.status, 200, u.role);
    assert.equal(r.body.location.id, w.a.id, u.role);
    assert.deepEqual(r.body.terms.map(x => x.id), [w.termA.id], u.role);
    assert.deepEqual(r.body.closures.map(x => [x.date, x.reason]), [[MON, 'Irvine staff training']], u.role);
    assert.deepEqual(r.body.sessions.map(s => [s.id, s.name, s.slots]), [[sA.id, 'Irvine Study', [
      { weekday: 1, enrolled: 0, paused: 0, waiting: 0, capacity: 4, seats_left: 4 },
      { weekday: 3, enrolled: 1, paused: 0, waiting: 0, capacity: 4, seats_left: 3 },
    ]]], u.role);
  }
  // Families never get the staff "today" view (see above); staff, director and HQ get Irvine's day only.
  for (const u of [w.staffA, w.dirA, w.hq]) {
    const r = await w.t.as(u).get('/api/sessions/today?location_id=' + w.a.id);
    assert.equal(r.status, 200, u.role);
    assert.equal(r.body.date, '2026-10-14');
    assert.equal(r.body.closure, null, u.role);
    assert.deepEqual(r.body.sessions.map(s => [s.id, s.name, s.enrolled, s.waiting, s.capacity]), [[sA.id, 'Irvine Study', 1, 0, 4]], u.role);
  }
  // Arcadia's own rows are real and visible to Arcadia, so the checks above are not empty by accident.
  const b = await w.t.as(w.hq).get('/api/sessions?location_id=' + w.b.id);
  assert.deepEqual([b.body.terms.map(x => x.id), b.body.closures.map(x => x.reason), b.body.sessions.map(s => s.id)],
    [[w.termB.id], ['Arcadia power outage'], [sB.id]]);
  const bToday = await w.t.as(w.staffB).get('/api/sessions/today');
  assert.equal(bToday.body.closure.reason, 'Arcadia power outage');
  assert.deepEqual(bToday.body.sessions.map(s => [s.id, s.enrolled, s.waiting, s.capacity]), [[sB.id, 2, 1, 6]]);
});

test(['NF-1'], 'creating a session: the location\'s own director or HQ only', async () => {
  const w = await world();
  const famA = w.t.fx.family(w.a);
  for (const u of [w.staffA, famA.parent, famA.student, w.dirB]) {
    const r = await w.t.as(u).post('/api/sessions', block({ location_id: w.a.id, term_id: w.termA.id }));
    assert.equal(r.status, 403, u.role);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal((await w.t.as(w.hq).post('/api/sessions', block({ location_id: w.a.id, term_id: w.termA.id }))).status, 201);
});

test(['NF-1'], 'editing or cancelling a session: the location\'s own director or HQ only', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Irvine Study' });
  const famA = w.t.fx.family(w.a);
  w.t.fx.enroll(famA.student, s, 1);
  for (const u of [w.staffA, famA.parent, famA.student, w.dirB]) {
    assert.equal((await w.t.as(u).put('/api/sessions/' + s.id, { name: 'Hijacked', capacity: 50 })).status, 403, u.role);
    assert.equal((await w.t.as(u).post('/api/sessions/' + s.id + '/cancel')).status, 403, u.role);
  }
  assert.deepEqual([row(w.t, s.id).name, row(w.t, s.id).capacity, row(w.t, s.id).status], ['Irvine Study', 10, 'active']);
  assert.equal(w.t.fx.notifications(famA.parent).length, 0);
  assert.equal((await w.t.as(w.hq).put('/api/sessions/' + s.id, { name: 'Irvine Focus' })).status, 200);
  assert.equal((await w.t.as(w.hq).post('/api/sessions/' + s.id + '/cancel')).status, 200);
});

test(['NF-1'], 'terms: the location\'s own director or HQ only', async () => {
  const w = await world();
  const famA = w.t.fx.family(w.a);
  const spring = { location_id: w.a.id, name: 'Spring 2027', start_date: '2027-01-11', end_date: '2027-05-28' };
  for (const u of [w.staffA, famA.parent, w.dirB]) {
    assert.equal((await w.t.as(u).post('/api/sessions/terms', spring)).status, 403, u.role);
    assert.equal((await w.t.as(u).put('/api/sessions/terms/' + w.termA.id, { name: 'Renamed' })).status, 403, u.role);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM terms WHERE location_id = ?', w.a.id), 1);
  assert.equal(w.t.db.prepare('SELECT name FROM terms WHERE id = ?').get(w.termA.id).name, 'Fall 2026');
  assert.equal((await w.t.as(w.hq).put('/api/sessions/terms/' + w.termA.id, { name: 'Autumn 2026' })).status, 200);
  assert.equal((await w.t.as(w.hq).post('/api/sessions/terms', spring)).status, 201);
});

test(['NF-1'], 'closures: the location\'s own director or HQ only', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1' });
  const famA = w.t.fx.family(w.a);
  w.t.fx.enroll(famA.student, s, 1);
  for (const u of [w.staffA, famA.parent, w.dirB]) {
    assert.equal((await w.t.as(u).post('/api/sessions/closures', { location_id: w.a.id, date: MON })).status, 403, u.role);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);
  assert.equal(w.t.fx.notifications(famA.parent).length, 0);
  const c = await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON });
  for (const u of [w.staffA, famA.parent, w.dirB]) {
    assert.equal((await w.t.as(u).del('/api/sessions/closures/' + c.body.closure.id)).status, 403, u.role);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 1);
  assert.equal((await w.t.as(w.hq).del('/api/sessions/closures/' + c.body.closure.id)).status, 200);
});

// ---------------- Round-1 sweep rules (R3, R4, R7, R8) ----------------

test(['SC-3'], 'R3: closures are added and removed for today or later only, by the location\'s own date; a past date is refused and nobody is told', async () => {
  const w = await world({ now: at('America/Los_Angeles', '2026-10-14', '22:30') }); // Wed 10:30pm in Irvine, already Thu in Toronto
  const tor = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  w.t.fx.term(tor);
  const dirT = w.t.fx.director(tor);
  const s = w.t.fx.session(w.a, { weekdays: '1,3' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s, 1);
  w.t.fx.enroll(fam.student, s, 3);

  // Mon Oct 12 is over: no closure, and no "closed" notice for a day the family already had.
  const past = await w.t.as(w.dirA).post('/api/sessions/closures', { date: '2026-10-12', reason: 'Power outage' });
  assert.equal(past.status, 400);
  assert.equal(past.body.error, 'past_date');
  assert.equal(past.body.message, 'Mon, Oct 12 has already passed at Irvine. Closures can only be added for today or a later date.');
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);
  assert.equal(w.t.fx.notifications(fam.parent).length, 0);
  // Today, by each location's own date: still Wednesday in Irvine, already Thursday in Toronto.
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: '2026-10-14', reason: 'Storm' })).status, 201);
  assert.equal(sent(w.t, fam.parent, 'session_closure'), 1);
  const torWed = await w.t.as(dirT).post('/api/sessions/closures', { date: '2026-10-14' });
  assert.equal(torWed.status, 400);
  assert.equal(torWed.body.error, 'past_date');
  assert.equal((await w.t.as(dirT).post('/api/sessions/closures', { date: '2026-10-15' })).status, 201);

  // A past closure stays as it was: removing it is refused, and nobody is told it reopened.
  const old = Number(w.t.db.prepare("INSERT INTO closures (location_id, date, reason) VALUES (?, '2026-10-05', 'Heat')").run(w.a.id).lastInsertRowid);
  const reopen = await w.t.as(w.dirA).del('/api/sessions/closures/' + old);
  assert.equal(reopen.status, 400);
  assert.equal(reopen.body.error, 'past_date');
  assert.equal(reopen.body.message, 'Mon, Oct 5 has already passed at Irvine. Closures can only be removed for today or a later date.');
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures WHERE id = ?', old), 1);
  assert.equal(sent(w.t, fam.parent, 'session_reopened'), 0);
  // Today's own closure can still be taken back.
  const today = w.t.db.prepare("SELECT id FROM closures WHERE location_id = ? AND date = '2026-10-14'").get(w.a.id).id;
  assert.equal((await w.t.as(w.dirA).del('/api/sessions/closures/' + today)).status, 200);
  assert.equal(sent(w.t, fam.parent, 'session_reopened'), 1);
});

test(['SC-1', 'SC-4'], 'R4: a session starts no earlier than its location opens and ends no later than it closes, when created or edited', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine', open_time: '09:00', close_time: '18:00' });
  const term = t.fx.term(loc);
  const dir = t.fx.director(loc);
  const post = over => t.as(dir).post('/api/sessions', block(Object.assign({ term_id: term.id }, over)));
  const msg = 'Irvine is open 9:00 AM–6:00 PM, so a session there has to start at 9:00 AM or later and end by 6:00 PM.';
  for (const [start_time, end_time] of [['16:30', '18:30'], ['08:00', '10:00'], ['08:59', '11:00'], ['16:00', '18:01']]) {
    const r = await post({ start_time, end_time });
    assert.equal(r.status, 400, start_time + '-' + end_time);
    assert.deepEqual([r.body.error, r.body.message], ['outside_hours', msg]);
  }
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal((await post({ start_time: '09:00', end_time: '11:00' })).status, 201); // opens at 9
  const late = await post({ start_time: '16:00', end_time: '18:00' });             // closes at 6
  assert.equal(late.status, 201);
  // An edit can't push it past closing either; the session keeps its times.
  const e = await t.as(dir).put('/api/sessions/' + late.body.session.id, { end_time: '18:30' });
  assert.equal(e.status, 400);
  assert.equal(e.body.error, 'outside_hours');
  assert.deepEqual([row(t, late.body.session.id).start_time, row(t, late.body.session.id).end_time], ['16:00', '18:00']);
  assert.equal((await t.as(dir).put('/api/sessions/' + late.body.session.id, { start_time: '15:30' })).status, 200);
});

test(['SC-3', 'SC-4'], 'R7: shortening a term tells the families whose weekly sessions it cuts, like removing a day; nobody else', async () => {
  const w = await world(); // Wed 14 Oct 2026; Fall 2026 runs Mon Aug 17 - Fri Dec 18
  const mwf = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const tth = w.t.fx.session(w.a, { name: 'Tue/Thu Study', weekdays: '2,4' });
  const mon = w.t.fx.family(w.a), fri = w.t.fx.family(w.a), thu = w.t.fx.family(w.a), gone = w.t.fx.family(w.a);
  w.t.fx.enroll(mon.student, mwf, 1);
  w.t.fx.enroll(fri.student, mwf, 5);
  w.t.fx.enroll(thu.student, tth, 4, { status: 'paused' });
  w.t.fx.enroll(gone.student, mwf, 5, { status: 'dropped' });
  const spring = w.t.fx.term(w.a, { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' });
  const springFam = w.t.fx.family(w.a);
  w.t.fx.enroll(springFam.student, w.t.fx.session(w.a, { term: spring, weekdays: '1,5' }), 5);
  const kind = 'term_shortened';

  // Ending on Wed Dec 16 cuts Thu Dec 17 and Fri Dec 18.
  const r = await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-16' });
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, 4);
  for (const u of [fri.student, fri.parent, thu.student, thu.parent]) {
    const n = w.t.fx.notifications(u, kind);
    assert.equal(n.length, 1, u.name);
    assert.equal(n[0].title, 'Fall 2026 at Irvine now runs Mon, Aug 17 – Wed, Dec 16');
    assert.equal(n[0].body, 'Irvine changed Fall 2026 from Mon, Aug 17 – Fri, Dec 18 to Mon, Aug 17 – Wed, Dec 16. ' +
      'Your weekly sessions in it don\'t meet outside those dates. You can pick another session in the app.');
  }
  for (const u of [mon.student, mon.parent, gone.student, gone.parent, springFam.student, springFam.parent]) assert.equal(sent(w.t, u, kind), 0, u.name);
  // Lengthening it again, or moving a start date that has already passed, cuts nothing ahead.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-18' })).body.notified, 0);
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { start_date: '2026-08-24' })).body.notified, 0);
  // A later start for a term ahead cuts its first weeks: Fri Jan 15 is gone for the spring family.
  const sp = await w.t.as(w.dirA).put('/api/sessions/terms/' + spring.id, { start_date: '2027-01-18' });
  assert.equal(sp.body.notified, 2);
  assert.equal(sent(w.t, springFam.parent, kind), 1);
  // Ending the term yesterday cuts every weekday from today on, Mondays included.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-10-13' })).body.notified, 6);
  assert.equal(sent(w.t, mon.parent, kind), 1);
  assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE status = 'active'"), 3); // enrollments are left as they are
});

test(['SC-4'], 'R8: a time edit applies from the edit date on; the times it replaced are kept for every date before it', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles
  const s = w.t.fx.session(w.a, { weekdays: '1,3,5', start: '13:00', end: '16:00' });
  const hist = id => w.t.db.prepare('SELECT until_date, start_time, end_time FROM session_times WHERE session_id = ? ORDER BY until_date').all(id).map(r => ({ ...r }));
  const put = body => w.t.as(w.dirA).put('/api/sessions/' + s.id, body);
  // Name, days or seats alone don't touch the times.
  assert.equal((await put({ name: 'Afternoon Focus', capacity: 12 })).status, 200);
  assert.deepEqual(hist(s.id), []);
  assert.equal((await put({ start_time: '15:00', end_time: '18:00' })).status, 200);
  assert.deepEqual(hist(s.id), [{ until_date: '2026-10-13', start_time: '13:00', end_time: '16:00' }]);
  // A second edit the same day: the days before today still had 1-4pm.
  assert.equal((await put({ start_time: '14:00', end_time: '17:00' })).status, 200);
  assert.deepEqual(hist(s.id), [{ until_date: '2026-10-13', start_time: '13:00', end_time: '16:00' }]);
  w.t.clock.set(at('America/Los_Angeles', '2026-10-20', '09:00'));
  assert.equal((await put({ start_time: '13:00', end_time: '16:00' })).status, 200);
  assert.deepEqual(hist(s.id), [{ until_date: '2026-10-13', start_time: '13:00', end_time: '16:00' },
    { until_date: '2026-10-19', start_time: '14:00', end_time: '17:00' }]);
  // The edit date is the location's own: 10:30pm Tuesday in Irvine is already Wednesday in Toronto.
  const tor = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  w.t.fx.term(tor);
  const ts = w.t.fx.session(tor, { weekdays: '1,3,5', start: '09:00', end: '11:30' });
  w.t.clock.set(at('America/Los_Angeles', '2026-10-20', '22:30'));
  assert.equal((await w.t.as(w.hq).put('/api/sessions/' + ts.id, { start_time: '09:30', end_time: '12:00' })).status, 200);
  assert.deepEqual(hist(ts.id), [{ until_date: '2026-10-20', start_time: '09:00', end_time: '11:30' }]);
});

// ---------------- The Sessions screen in a browser tab (S6, S7) ----------------

// Just enough DOM for public/js/app.js and the sessions view: one tree under
// <html>, focus, bubbling events, input values and checkboxes.
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  get id() { return this.getAttribute('id') || ''; }
  get cls() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  get value() { return this.typed ?? this.getAttribute('value') ?? ''; }
  set value(v) { this.typed = String(v); }
  get checked() { return this.ticked ?? this.attrs.has('checked'); }
  set checked(v) { this.ticked = !!v; }
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
  // Only the shape the view asks for: '[attr] tag, [attr] tag'.
  querySelector(sel) {
    for (const part of sel.split(',').map(x => x.trim().match(/^\[([\w-]+)\] (\w+)$/))) {
      for (const host of this.findAll(n => n.attrs.has(part[1]))) { const f = host.find(n => n.tag === part[2]); if (f) return f; }
    }
    return null;
  }
}

// One browser tab running the real shell and sessions view (read from ROOT, so the
// mutation runner's copy is the one exercised) against the test server.
function sessionsTab(t, user) {
  const pending = new Set(), requests = [];
  const token = crypto.randomBytes(16).toString('hex');
  t.ctx.sessions.set(token, user.id);
  const doc = { title: '', hidden: false, addEventListener() {} };
  const el = tag => new El(doc, tag);
  doc.documentElement = el('html');
  doc.head = el('head');
  doc.body = el('body');
  doc.documentElement.append(doc.head, doc.body);
  const main = el('main');
  main.setAttribute('id', 'main');
  const toasts = el('div');
  toasts.setAttribute('id', 'toasts');
  doc.body.append(toasts, main);
  Object.assign(doc, {
    createElement: tag => new El(doc, tag), createTextNode: s => new El(doc, null, String(s)),
    getElementById: id => doc.documentElement.find(n => n.id === id) || null,
  });
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused && doc.focused.isConnected ? doc.focused : doc.body) });
  const fetchAs = (url, opts = {}) => {
    const p = fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie: 'sid=' + token }) }))
      .then(async r => { requests.push(`${opts.method || 'GET'} ${url} ${r.status}`); return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers }); });
    pending.add(p);
    const done = () => pending.delete(p);
    p.then(done, done);
    return p;
  };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator: {}, location: { hash: '' },
    history: { replaceState() {} }, addEventListener() {}, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/sessions.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  win.App.me = { user: { id: user.id, role: user.role, name: user.name, location_id: user.location_id } };
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    doc, main, requests, settle,
    async open() { const view = el('div'); main.replaceChildren(view); await win.App.views.find(v => v.id === 'sessions').render(view, []); await settle(); return view; },
  };
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const btn = (root, label) => root.find(n => n.tag === 'button' && n.textContent === label);
const dialog = root => root.find(n => n.getAttribute('role') === 'alertdialog');
const labels = box => box.findAll(n => n.tag === 'button').map(b => b.textContent);

test(['SC-3', 'SC-4', 'NF-7'], 'Sessions screen: every confirm puts the safe button first and focused, Escape keeps things as they were, and paused enrollments are counted in what a change ends', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const act = w.t.fx.family(w.a), pau = w.t.fx.family(w.a);
  w.t.fx.enroll(act.student, s, 1);
  w.t.fx.enroll(pau.student, s, 1, { status: 'paused' });
  waitlist(w.t, w.t.fx.family(w.a).student, s, 1);
  const tab = sessionsTab(w.t, w.dirA);
  let view = await tab.open();
  const openSession = () => view.find(n => n.tag === 'button' && n.cls.includes('sx-slot')).click();

  // Cancel this session: the box says what ends, the paused enrollment included.
  openSession();
  const kill = btn(view, 'Cancel this session');
  kill.focus();
  kill.click();
  let box = dialog(view);
  assert.equal(words(box), 'Cancel Afternoon Study? This ends 2 enrollments and 1 waitlist spot, and those families are told. This can\'t be undone. Keep session Cancel session');
  assert.deepEqual(labels(box), ['Keep session', 'Cancel session']);
  assert.equal(tab.doc.activeElement, btn(box, 'Keep session'), 'focus starts on the safe button');
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(dialog(view), undefined);
  assert.equal(tab.doc.activeElement, kill, 'focus goes back to Cancel this session');
  assert.equal(row(w.t, s.id).status, 'active');
  assert.ok(!tab.requests.some(r => r.startsWith('POST')), tab.requests.join('\n'));

  // Taking Monday off: the warning and the confirm count the paused enrollment too.
  const monday = view.find(n => n.tag === 'input' && n.getAttribute('type') === 'checkbox' && n.value === '1');
  monday.checked = false;
  monday.dispatch('change');
  assert.match(words(view), /Taking off Monday ends 2 enrollments and 1 waitlist spot for that day\. Those families will be told\./);
  view.find(n => n.tag === 'form').dispatch('submit');
  box = dialog(view);
  assert.deepEqual(labels(box), ['Keep that day', 'End that day and save']);
  assert.equal(tab.doc.activeElement, btn(box, 'Keep that day'));
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(row(w.t, s.id).weekdays, '1,3,5');
  assert.ok(!tab.requests.some(r => r.startsWith('PUT')), tab.requests.join('\n'));
  view.find(n => n.tag === 'form').dispatch('submit');
  btn(dialog(view), 'End that day and save').click();
  await tab.settle();
  assert.equal(row(w.t, s.id).weekdays, '3,5');
  assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND status = 'dropped'", s.id), 2);

  // A closure: today or later only (R3), and its confirm starts on the safe button too.
  view = await tab.open();
  btn(view, 'Add a closure').click();
  const date = view.find(n => n.getAttribute('id') === 'sx-cdate');
  assert.equal(date.getAttribute('min'), '2026-10-14');
  date.value = '2026-10-16';
  view.find(n => n.tag === 'form').dispatch('submit');
  box = dialog(view);
  assert.deepEqual(labels(box), ['Keep it open', 'Close and tell families']);
  assert.equal(tab.doc.activeElement, btn(box, 'Keep it open'));
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);
  view.find(n => n.tag === 'form').dispatch('submit');
  btn(dialog(view), 'Close and tell families').click();
  await tab.settle();
  assert.deepEqual(w.t.db.prepare('SELECT date FROM closures').all().map(c => c.date), ['2026-10-16']);

  // Reopen: the safe button keeps the day closed.
  view = await tab.open();
  view.find(n => n.tag === 'button' && n.textContent === 'Reopen').click();
  box = dialog(view);
  assert.deepEqual(labels(box), ['Keep closed', 'Reopen this day']);
  assert.equal(tab.doc.activeElement, btn(box, 'Keep closed'));
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 1);

  // And Cancel session goes through when it is chosen.
  openSession();
  btn(view, 'Cancel this session').click();
  btn(dialog(view), 'Cancel session').click();
  await tab.settle();
  assert.equal(row(w.t, s.id).status, 'cancelled');
});
