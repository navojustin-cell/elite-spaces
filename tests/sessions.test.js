'use strict';
// Schedules and periods: SC-1..SC-5, scope on every route (NF-1), and
// per-location time zones (NF-4). A session is a schedule (D-41) in a term (its
// period); enrollments and waitlist rows cover the whole schedule (weekday 0, D-42).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, at, ROOT, load } = require('./lib');

const LA = 'America/Los_Angeles';
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
const waitRow = (t, id) => t.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
const dateRows = (t, s) => t.db.prepare('SELECT date, kind, moved_from, reason, created_by FROM session_dates WHERE session_id = ? ORDER BY date')
  .all(s.id).map(r => ({ ...r }));
const datesUrl = s => '/api/sessions/' + s.id + '/dates';

// { toString: 1 } makes String() and Number() throw; { a: 1 } turns into "[object Object]".
const POISON = { toString: 1 };
const PLAIN = { a: 1 };

// ---------------- SC-1: directors publish 2-3 hour schedules ----------------

test(['SC-1'], 'a director publishes a Mon/Wed/Fri 1-4pm schedule at their own location', async () => {
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
  const x = r.body.session;
  assert.equal(x.slots, undefined, 'no per-day slots any more');
  assert.deepEqual([x.weekdays, x.enrolled, x.paused, x.waiting, x.seats_left, x.days_per_week, x.days_locked, x.changes],
    [[1, 3, 5], 0, 0, 0, 10, 3, false, []]);
  const log = w.t.fx.audit('session.create');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, w.dirA.id);
  assert.equal(log[0].target_id, s.id);
  const list = await w.t.as(w.dirA).get('/api/sessions');
  assert.deepEqual(list.body.sessions.map(x => [x.name, x.weekdays, x.start_time, x.end_time]), [['Afternoon Study', [1, 3, 5], '13:00', '16:00']]);
});

test(['SC-1'], 'a schedule runs 2 to 3 hours on at least one real weekday and ends after it starts', async () => {
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

test(['SC-1', 'SC-4'], 'edits follow the same rules as new schedules', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);
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

test(['SC-1', 'NF-1'], 'a schedule must belong to a period at its own location', async () => {
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

// ---------------- SC-2: seats per schedule (per meeting date), no assigned seats ----------------

test(['SC-2'], 'counts are per schedule from whole-schedule rows, paused ones apart, and nobody is assigned a seat', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3', capacity: 3 });
  const kids = [1, 2, 3, 4, 5, 6, 7].map(() => w.t.fx.family(w.a).student);
  w.t.fx.enroll(kids[0], s);
  w.t.fx.enroll(kids[1], s);
  w.t.fx.enroll(kids[2], s, 0, { status: 'paused' });
  w.t.fx.enroll(kids[3], s, 0, { status: 'dropped' });
  w.t.fx.waitlist(kids[4], s);
  // v1 per-weekday rows are history (D-42): they hold no seat and wait in no line.
  w.t.fx.enroll(kids[5], s, 1);
  w.t.fx.waitlist(kids[6], s, { weekday: 3 });
  const r = await w.t.as(w.staffA).get('/api/sessions?location_id=' + w.a.id);
  assert.equal(r.status, 200);
  const x = r.body.sessions.find(y => y.id === s.id);
  assert.deepEqual([x.capacity, x.enrolled, x.paused, x.waiting, x.seats_left, x.days_per_week], [3, 2, 1, 1, 1, 2]);
  // An overfull schedule (seats set below the enrolled count by hand, say) shows no seats left, never a negative.
  const full = w.t.fx.session(w.a, { name: 'Full', weekdays: '2', capacity: 1 });
  w.t.fx.enroll(kids[0], full);
  w.t.fx.enroll(kids[1], full);
  const f = (await w.t.as(w.staffA).get('/api/sessions')).body.sessions.find(y => y.id === full.id);
  assert.deepEqual([f.enrolled, f.seats_left, f.days_per_week], [2, 0, 1]);
  // A paused enrollment holds no seat (D-16): seats can come down to the active count (2).
  const e = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 2 });
  assert.equal(e.status, 200);
  assert.equal(row(w.t, s.id).capacity, 2);
  assert.equal(e.body.session.seats_left, 0);
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

test(['SC-2'], 'seats top out at 1,000, so a runaway number never reaches the schedule', async () => {
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
  // The location's schedules and today's list still load.
  const list = await w.t.as(w.staffA).get('/api/sessions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.sessions.map(x => [x.id, x.capacity]), [[s.id, 10]]);
  const today = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(today.status, 200);
  assert.deepEqual(today.body.sessions.map(x => [x.id, x.capacity]), [[s.id, 10]]);
  // 1,000 is allowed, on a new schedule and on an edit.
  const top = await w.t.as(w.dirA).post('/api/sessions', block({ term_id: w.termA.id, capacity: 1000 }));
  assert.equal(top.status, 201);
  assert.equal(row(w.t, top.body.session.id).capacity, 1000);
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 1000 })).status, 200);
  assert.equal(row(w.t, s.id).capacity, 1000);
});

test(['SC-1', 'SC-2'], 'a schedule field sent as an object is refused with a 400, never stored or crashed on', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Irvine Study', weekdays: '1,3' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);
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

test(['SC-3'], 'a period name, closure reason or location sent as an object is refused with a 400', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);
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

test(['SC-2', 'SC-4'], 'seats cannot go below the students already enrolled in the schedule', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3', capacity: 5 });
  for (let i = 0; i < 3; i++) w.t.fx.enroll(w.t.fx.family(w.a).student, s);
  for (let i = 0; i < 2; i++) w.t.fx.enroll(w.t.fx.family(w.a).student, s, 0, { status: 'paused' }); // paused students hold no seat
  w.t.fx.enroll(w.t.fx.family(w.a).student, s, 1); // a live v1 Monday row holds no seat either (D-42)
  const low = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 2 });
  assert.equal(low.status, 409);
  assert.equal(low.body.error, 'capacity_below_enrolled');
  assert.equal(low.body.message, '3 students are enrolled in Afternoon Study, so seats can\'t go below 3.');
  assert.equal(row(w.t, s.id).capacity, 5);
  const exact = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 3 });
  assert.equal(exact.status, 200);
  assert.equal(row(w.t, s.id).capacity, 3);
});

// ---------------- SC-3: periods and holiday closures ----------------

test(['SC-3'], 'directors set periods with start and end dates', async () => {
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

test(['SC-3'], 'D-56: periods at one location never overlap, on create or edit; other locations and touching edges are fine', async () => {
  const w = await world(); // Fall 2026: Aug 17 - Dec 18 at both locations
  const post = body => w.t.as(w.dirA).post('/api/sessions/terms', body);
  const msg = 'Fall 2026 already covers Nov 1 - Nov 30. Periods at one location can\'t overlap. Use months or a semester for these dates, not both.';
  const nov = await post({ name: 'November 2026', start_date: '2026-11-01', end_date: '2026-11-30' });
  assert.equal(nov.status, 409);
  assert.deepEqual([nov.body.error, nov.body.message], ['term_overlaps', msg]);
  // The overlapping stretch is named, whichever side it is on.
  for (const [start_date, end_date, covers] of [['2026-08-01', '2026-08-17', 'Aug 17 - Aug 17'], ['2026-12-18', '2027-01-08', 'Dec 18 - Dec 18'], ['2026-07-01', '2027-01-31', 'Aug 17 - Dec 18']]) {
    const r = await post({ name: 'X', start_date, end_date });
    assert.equal(r.status, 409, start_date);
    assert.equal(r.body.message.split('.')[0], 'Fall 2026 already covers ' + covers);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM terms WHERE location_id = ?', w.a.id), 1);
  // The day after and the day before are free; Arcadia's own Fall term doesn't block Irvine.
  const jan = await post({ name: 'January 2027', start_date: '2026-12-19', end_date: '2027-01-29' });
  assert.equal(jan.status, 201);
  assert.equal((await post({ name: 'Summer 2026', start_date: '2026-06-01', end_date: '2026-08-16' })).status, 201);
  assert.equal((await w.t.as(w.dirB).post('/api/sessions/terms', { name: 'Late fall', start_date: '2026-12-19', end_date: '2026-12-31' })).status, 201);
  // Editing: a period never overlaps itself, but can't be stretched over a neighbour.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-17' })).status, 200);
  const stretch = await w.t.as(w.dirA).put('/api/sessions/terms/' + jan.body.term.id, { start_date: '2026-12-01' });
  assert.equal(stretch.status, 409);
  assert.equal(stretch.body.message, 'Fall 2026 already covers Dec 1 - Dec 17. Periods at one location can\'t overlap. Use months or a semester for these dates, not both.');
  assert.equal(w.t.db.prepare('SELECT start_date FROM terms WHERE id = ?').get(jan.body.term.id).start_date, '2026-12-19');
  // v1 periods that already overlap are left alone, and must be fixed before either is edited.
  const old = w.t.fx.term(w.b, { name: 'Autumn block', start: '2026-10-01', end: '2026-10-31' });
  const rename = await w.t.as(w.dirB).put('/api/sessions/terms/' + old.id, { name: 'Autumn' });
  assert.equal(rename.status, 409);
  assert.equal(rename.body.error, 'term_overlaps');
  assert.equal((await w.t.as(w.dirB).put('/api/sessions/terms/' + w.termB.id, { name: 'Fall' })).status, 409);
  const fixed = await w.t.as(w.dirB).put('/api/sessions/terms/' + old.id, { start_date: '2026-12-01', end_date: '2026-12-18' });
  assert.equal(fixed.status, 409, 'still inside Fall 2026');
  assert.equal((await w.t.as(w.dirB).put('/api/sessions/terms/' + w.termB.id, { end_date: '2026-09-30' })).status, 200);
  assert.equal((await w.t.as(w.dirB).put('/api/sessions/terms/' + old.id, { name: 'Autumn' })).status, 200);
});

test(['SC-3'], 'a closure tells the students and active parents meeting that day by dates.js, and nobody else', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const mon = w.t.fx.family(w.a);
  const guardian2 = w.t.fx.user('parent', { location: w.a });
  w.t.fx.link(guardian2, mon.student);
  const pendingParent = w.t.fx.user('parent', { location: w.a });
  w.t.fx.link(pendingParent, mon.student, 'pending');
  w.t.fx.enroll(mon.student, s);
  // A Tue/Thu schedule doesn't meet Monday; one with Monday added does; one with Monday skipped doesn't.
  const tth = w.t.fx.family(w.a);
  w.t.fx.enroll(tth.student, w.t.fx.session(w.a, { name: 'Tue/Thu Study', weekdays: '2,4' }));
  const extra = w.t.fx.family(w.a);
  const extraS = w.t.fx.session(w.a, { name: 'Extra TTh', weekdays: '2,4', start: '16:30', end: '18:30' });
  w.t.fx.enroll(extra.student, extraS);
  w.t.fx.sessionDate(extraS, MON, 'add');
  const moved = w.t.fx.family(w.a);
  const movedS = w.t.fx.session(w.a, { name: 'Mornings MWF', start: '09:00', end: '11:30' });
  w.t.fx.enroll(moved.student, movedS);
  w.t.fx.sessionDate(movedS, MON, 'skip');
  // v1 rows count only on their own weekday.
  const v1Mon = w.t.fx.family(w.a);
  w.t.fx.enroll(v1Mon.student, s, 1);
  const v1Wed = w.t.fx.family(w.a);
  w.t.fx.enroll(v1Wed.student, s, 3);
  const dropped = w.t.fx.family(w.a);
  w.t.fx.enroll(dropped.student, s, 0, { status: 'dropped' });
  const paused = w.t.fx.family(w.a);
  w.t.fx.enroll(paused.student, s, 0, { status: 'paused' });
  const spring = w.t.fx.term(w.a, { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' });
  const springFam = w.t.fx.family(w.a);
  w.t.fx.enroll(springFam.student, w.t.fx.session(w.a, { term: spring, weekdays: '1' }));
  const other = w.t.fx.family(w.b);
  w.t.fx.enroll(other.student, w.t.fx.session(w.b, { weekdays: '1' }));

  const r = await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON, reason: 'Staff training' });
  assert.equal(r.status, 201);
  assert.equal(r.body.notified, 7);
  const c = w.t.db.prepare('SELECT * FROM closures WHERE location_id = ?').all(w.a.id);
  assert.deepEqual(c.map(x => [x.date, x.reason, x.created_by]), [[MON, 'Staff training', w.dirA.id]]);
  for (const u of [mon.student, mon.parent, guardian2, extra.student, extra.parent, v1Mon.student, v1Mon.parent]) {
    const n = w.t.fx.notifications(u, 'session_closure');
    assert.equal(n.length, 1, u.name);
    assert.equal(n[0].title, 'Irvine is closed Mon, Nov 23');
    assert.equal(n[0].body, 'Staff training. Schedules that day are cancelled. Your other dates go ahead as usual.');
  }
  for (const u of [pendingParent, tth.student, tth.parent, moved.student, moved.parent, v1Wed.student, v1Wed.parent,
    dropped.student, dropped.parent, paused.student, paused.parent, springFam.student, springFam.parent, other.student, other.parent]) {
    assert.equal(sent(w.t, u, 'session_closure'), 0, u.name);
  }
  // Enrollments stay (D-19): only that date is cancelled.
  assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND status = 'active'", s.id), 3);
  assert.equal(w.t.fx.audit('closure.create').length, 1);
});

test(['SC-3'], 'closures must fall inside one of the location\'s own periods', async () => {
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
  const mon = w.t.fx.family(w.a), tth = w.t.fx.family(w.a);
  w.t.fx.enroll(mon.student, w.t.fx.session(w.a, { weekdays: '1,3' }));
  w.t.fx.enroll(tth.student, w.t.fx.session(w.a, { name: 'Tue/Thu', weekdays: '2,4' }));
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
  assert.equal(sent(w.t, tth.parent, 'session_reopened'), 0);
  assert.equal(w.t.fx.audit('closure.delete').length, 1);
  assert.equal((await w.t.as(w.dirA).del('/api/sessions/closures/' + c.body.closure.id)).status, 404);
});

test(['SC-3'], 'a period can\'t be shortened past one of its closures', async () => {
  const w = await world();
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: '2026-12-14', reason: 'Winter break' })).status, 201);
  const r = await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-11' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'closure_outside_term');
  assert.equal(w.t.db.prepare('SELECT end_date FROM terms WHERE id = ?').get(w.termA.id).end_date, '2026-12-18');
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-14' })).status, 200);
});

test(['SC-2', 'SC-3', 'SC-5'], 'today\'s schedules follow dates.js (added in, skipped out), show seats and the line, and a closure is flagged', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles
  const mwf = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5', capacity: 10 });
  const tth = w.t.fx.session(w.a, { name: 'Tue/Thu Study', weekdays: '2,4' });
  w.t.fx.sessionDate(tth, '2026-10-14', 'add', { reason: 'Exam week' });
  const skipped = w.t.fx.session(w.a, { name: 'Morning Focus', weekdays: '3', start: '09:30', end: '12:00', capacity: 2 });
  w.t.fx.sessionDate(skipped, '2026-10-14', 'skip');
  w.t.fx.session(w.a, { name: 'Early Focus', weekdays: '3', start: '09:00', end: '11:30' });
  const winter = w.t.fx.term(w.a, { name: 'Winter', start: '2027-01-04', end: '2027-03-26' });
  w.t.fx.session(w.a, { term: winter, name: 'Winter Study', weekdays: '3' });
  w.t.fx.enroll(w.t.fx.family(w.a).student, mwf);
  w.t.fx.enroll(w.t.fx.family(w.a).student, mwf);
  w.t.fx.enroll(w.t.fx.family(w.a).student, mwf, 3); // a v1 Wednesday row holds no seat
  w.t.fx.waitlist(w.t.fx.family(w.a).student, mwf);
  const r = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(r.status, 200);
  assert.equal(r.body.date, '2026-10-14');
  assert.equal(r.body.weekday, 3);
  assert.equal(r.body.closure, null);
  assert.deepEqual(r.body.sessions.map(s => [s.name, s.added]), [['Early Focus', false], ['Afternoon Study', false], ['Tue/Thu Study', true]]);
  const pm = r.body.sessions[1];
  assert.deepEqual([pm.enrolled, pm.waiting, pm.capacity], [2, 1, 10]);
  assert.equal(r.body.sessions[2].starts_at, at(LA, '2026-10-14', '13:00'));
  await w.t.as(w.dirA).post('/api/sessions/closures', { date: '2026-10-14', reason: 'Power outage' });
  const closed = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(closed.body.closure.reason, 'Power outage');
});

// ---------------- SC-4: edit and cancel, families told; days fixed once families commit ----------------

test(['SC-4'], 'changing a schedule\'s name, time or seats tells every enrolled family, paused ones included', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3', start: '13:00', end: '16:00', capacity: 10 });
  const act = w.t.fx.family(w.a);
  w.t.fx.enroll(act.student, s);
  const pau = w.t.fx.family(w.a);
  w.t.fx.enroll(pau.student, s, 0, { status: 'paused' });
  const wait = w.t.fx.family(w.a);
  w.t.fx.waitlist(wait.student, s);
  const gone = w.t.fx.family(w.a);
  w.t.fx.enroll(gone.student, s, 0, { status: 'dropped' });
  const elsewhere = w.t.fx.family(w.a);
  w.t.fx.enroll(elsewhere.student, w.t.fx.session(w.a, { name: 'Morning', start: '09:00', end: '11:30' }));

  const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Afternoon Focus', start_time: '13:30', end_time: '16:30' });
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, 4);
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
  // Seats are news too.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 12 })).status, 200);
  const latest = w.t.fx.notifications(act.parent, 'session_changed');
  assert.equal(latest.length, 2);
  assert.match(latest[1].body, /Seats per date: 12 \(was 10\)\./);
  // An edit that changes nothing families see tells nobody.
  const same = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 12 });
  assert.deepEqual([same.status, same.body.notified], [200, 0]);
  assert.equal(sent(w.t, act.parent, 'session_changed'), 2);
});

test(['SC-4'], 'D-45: a schedule\'s days are fixed once anyone is enrolled or waiting; name, times and seats still change', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Mornings MWF', weekdays: '1,3,5', start: '09:00', end: '12:00' });
  const put = body => w.t.as(w.dirA).put('/api/sessions/' + s.id, body);
  const msg = 'Families are enrolled in Mornings MWF, so its days are fixed. Use Move or Add date for single weeks, or cancel it and publish a new schedule.';
  const locked = async weekdays => {
    const r = await put({ weekdays });
    assert.equal(r.status, 409, JSON.stringify(weekdays));
    assert.deepEqual([r.body.error, r.body.message], ['days_locked', msg]);
  };
  // Nobody yet: the days can change.
  assert.equal((await put({ weekdays: [1, 3] })).status, 200);
  assert.equal(row(w.t, s.id).weekdays, '1,3');
  assert.equal((await w.t.as(w.staffA).get('/api/sessions')).body.sessions[0].days_locked, false);
  // A dropped enrollment and a settled waiting spot are history: still free.
  w.t.fx.enroll(w.t.fx.family(w.a).student, s, 0, { status: 'dropped' });
  w.t.fx.waitlist(w.t.fx.family(w.a).student, s, { status: 'removed' });
  assert.equal((await put({ weekdays: [1, 3, 5] })).status, 200);
  // One family waiting fixes the days. (Its membership is inactive, so the seat raise below
  // can't promote it when the enrollment module is loaded too: it stays a waiting spot.)
  const waiter = w.t.fx.waitlist(w.t.fx.family(w.a, { status: 'inactive' }).student, s);
  await locked([2, 4]);
  assert.equal(row(w.t, s.id).weekdays, '1,3,5');
  assert.equal((await w.t.as(w.staffA).get('/api/sessions')).body.sessions[0].days_locked, true);
  // The same days in any order, plus a new name, times and seats, are still fine.
  const ok = await put({ weekdays: [5, 3, 1], name: 'Mornings M/W/F', start_time: '09:30', end_time: '12:00', capacity: 12 });
  assert.equal(ok.status, 200);
  assert.deepEqual([row(w.t, s.id).weekdays, row(w.t, s.id).name, row(w.t, s.id).capacity], ['1,3,5', 'Mornings M/W/F', 12]);
  assert.equal(ok.body.session.days_locked, true);
  // A paused enrollment fixes them too, and so does a live v1 row.
  w.t.db.prepare("UPDATE waitlist SET status = 'removed' WHERE id = ?").run(waiter.id);
  const e = w.t.fx.enroll(w.t.fx.family(w.a).student, s, 0, { status: 'paused' });
  const msg2 = msg.replace('Mornings MWF', 'Mornings M/W/F');
  const r2 = await put({ weekdays: [1] });
  assert.deepEqual([r2.status, r2.body.message], [409, msg2]);
  w.t.db.prepare("UPDATE enrollments SET status = 'dropped' WHERE id = ?").run(e.id);
  const v1 = w.t.fx.enroll(w.t.fx.family(w.a).student, s, 1);
  assert.equal((await put({ weekdays: [1] })).status, 409);
  w.t.db.prepare("UPDATE enrollments SET status = 'dropped' WHERE id = ?").run(v1.id);
  assert.equal((await put({ weekdays: [1] })).status, 200);
  assert.equal(row(w.t, s.id).weekdays, '1');
});

test(['SC-4'], 'cancelling a schedule ends every live enrollment and waiting spot, whatever its weekday, and tells every family', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3' });
  const keep = w.t.fx.session(w.a, { name: 'Morning Focus', start: '09:00', end: '11:30' });
  const fams = [w.t.fx.family(w.a), w.t.fx.family(w.a), w.t.fx.family(w.a), w.t.fx.family(w.a), w.t.fx.family(w.a)];
  const live = [
    w.t.fx.enroll(fams[0].student, s),
    w.t.fx.enroll(fams[1].student, s, 0, { status: 'paused' }),
    w.t.fx.enroll(fams[2].student, s, 3), // a live v1 Wednesday row ends too (D-26)
  ];
  const wl = w.t.fx.waitlist(fams[3].student, s);
  const wlV1 = w.t.fx.waitlist(fams[4].student, s, { weekday: 1 });
  const other = w.t.fx.family(w.a);
  const eOther = w.t.fx.enroll(other.student, keep);
  // History from before the cancel: a student who dropped in September, and a waitlist spot
  // that became an enrollment in September and was dropped later that month. Their dates
  // stay true (attendance and the schedule read ended_at), and neither family is told again.
  const sept = at(LA, '2026-09-21', '15:00');
  const gone = w.t.fx.family(w.a);
  const eGone = w.t.fx.enroll(gone.student, s, 0, { status: 'dropped' });
  w.t.db.prepare('UPDATE enrollments SET ended_at = ? WHERE id = ?').run(sept, eGone.id);
  const promotedAt = at(LA, '2026-09-08', '09:00');
  const promotedEnd = at(LA, '2026-09-28', '17:00');
  const promoted = w.t.fx.family(w.a);
  const wPromoted = w.t.fx.waitlist(promoted.student, s);
  w.t.db.prepare("UPDATE waitlist SET status = 'enrolled', resolved_at = ? WHERE id = ?").run(promotedAt, wPromoted.id);
  const ePromoted = w.t.fx.enroll(promoted.student, s, 0, { status: 'dropped', source: 'waitlist' });
  w.t.db.prepare('UPDATE enrollments SET ended_at = ? WHERE id = ?').run(promotedEnd, ePromoted.id);
  const now = at(LA, '2026-10-14', '12:00');
  w.t.clock.set(now);

  const r = await w.t.as(w.dirA).post('/api/sessions/' + s.id + '/cancel');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ended, r.body.notified], [5, 10]);
  assert.equal(row(w.t, s.id).status, 'cancelled');
  assert.deepEqual(w.t.db.prepare('SELECT id, status, ended_at FROM enrollments WHERE session_id = ? ORDER BY id').all(s.id).map(x => [x.id, x.status, x.ended_at]), [
    ...live.map(e => [e.id, 'dropped', now]),
    [eGone.id, 'dropped', sept],
    [ePromoted.id, 'dropped', promotedEnd],
  ]);
  for (const x of [wl, wlV1]) assert.deepEqual([waitRow(w.t, x.id).status, waitRow(w.t, x.id).resolved_at], ['removed', now]);
  assert.deepEqual([waitRow(w.t, wPromoted.id).status, waitRow(w.t, wPromoted.id).resolved_at], ['enrolled', promotedAt]);
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
  // Both schedules meet on Wednesdays; only the one still running is on today's list.
  const today = await w.t.as(w.staffA).get('/api/sessions/today');
  assert.equal(today.body.weekday, 3);
  assert.deepEqual(today.body.sessions.map(x => x.name), ['Morning Focus']);
  assert.equal(w.t.fx.audit('session.cancel').length, 1);
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/' + s.id + '/cancel')).status, 409);
  const edit = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Back again' });
  assert.equal(edit.status, 409);
  assert.equal(row(w.t, s.id).name, 'Afternoon Study');
});

// ---------------- SC-5: skip, add or move one date (D-46) ----------------

test(['SC-5'], 'a director skips, adds and moves one date; enrolled families (paused too) are told once, nobody else', async () => {
  const w = await world(); // Wed 14 Oct 2026
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const act = w.t.fx.family(w.a);
  w.t.fx.enroll(act.student, s);
  const guardian2 = w.t.fx.user('parent', { location: w.a });
  w.t.fx.link(guardian2, act.student);
  const pau = w.t.fx.family(w.a);
  w.t.fx.enroll(pau.student, s, 0, { status: 'paused' });
  const wait = w.t.fx.family(w.a);
  w.t.fx.waitlist(wait.student, s);
  const gone = w.t.fx.family(w.a);
  w.t.fx.enroll(gone.student, s, 0, { status: 'dropped' });
  const other = w.t.fx.family(w.a);
  w.t.fx.enroll(other.student, w.t.fx.session(w.a, { name: 'Mornings MWF', start: '09:00', end: '11:30' }));
  const told = [act.student, act.parent, guardian2, pau.student, pau.parent];
  const post = body => w.t.as(w.dirA).post(datesUrl(s), body);
  const only = (kind, title, body) => {
    for (const u of told) {
      const n = w.t.fx.notifications(u, kind);
      assert.equal(n.length, 1, kind + ' ' + u.name);
      assert.deepEqual([n[0].title, n[0].body, n[0].ref_type, n[0].ref_id], [title, body, 'session', s.id]);
    }
  };

  const skip = await post({ action: 'skip', date: MON, reason: '  Staff training day  ' });
  assert.equal(skip.status, 201);
  assert.deepEqual(skip.body, { change: { action: 'skip', date: MON, to: null, reason: 'Staff training day' }, notified: 5 });
  only('schedule_date_skipped', 'Afternoon Study doesn\'t meet Mon, Nov 23', 'Staff training day. Your other dates go ahead as usual.');

  const add = await post({ action: 'add', date: '2026-11-24', reason: 'Exam prep' });
  assert.deepEqual([add.status, add.body.notified], [201, 5]);
  only('schedule_date_added', 'Afternoon Study also meets Tue, Nov 24', '1:00 PM–4:00 PM at Irvine. Exam prep');

  const move = await post({ action: 'move', date: '2026-11-30', to: '2026-12-01', reason: 'Staff training day' });
  assert.deepEqual([move.status, move.body.notified], [201, 5]);
  assert.deepEqual(move.body.change, { action: 'move', date: '2026-11-30', to: '2026-12-01', reason: 'Staff training day' });
  // A move is one notice, not a skip and an add.
  only('schedule_date_moved', 'Afternoon Study moves from Mon, Nov 30 to Tue, Dec 1', 'Same time, 1:00 PM–4:00 PM. Staff training day');
  only('schedule_date_skipped', 'Afternoon Study doesn\'t meet Mon, Nov 23', 'Staff training day. Your other dates go ahead as usual.');
  only('schedule_date_added', 'Afternoon Study also meets Tue, Nov 24', '1:00 PM–4:00 PM at Irvine. Exam prep');

  // No reason is fine; a long one is cut to 120 characters.
  assert.equal((await post({ action: 'skip', date: '2026-12-02' })).status, 201);
  assert.equal(w.t.fx.notifications(act.parent, 'schedule_date_skipped')[1].body, 'Your other dates go ahead as usual.');
  assert.equal((await post({ action: 'add', date: '2026-12-05', reason: 'x'.repeat(130) })).status, 201);
  for (const u of [wait.student, wait.parent, gone.student, gone.parent, other.student, other.parent]) {
    assert.equal(w.t.fx.notifications(u).length, 0, u.name);
  }
  const by = w.dirA.id;
  assert.deepEqual(dateRows(w.t, s), [
    { date: MON, kind: 'skip', moved_from: null, reason: 'Staff training day', created_by: by },
    { date: '2026-11-24', kind: 'add', moved_from: null, reason: 'Exam prep', created_by: by },
    { date: '2026-11-30', kind: 'skip', moved_from: null, reason: 'Staff training day', created_by: by },
    { date: '2026-12-01', kind: 'add', moved_from: '2026-11-30', reason: 'Staff training day', created_by: by },
    { date: '2026-12-02', kind: 'skip', moved_from: null, reason: null, created_by: by },
    { date: '2026-12-05', kind: 'add', moved_from: null, reason: 'x'.repeat(120), created_by: by },
  ]);
  assert.deepEqual(['session.date_skip', 'session.date_add', 'session.date_move'].map(a => w.t.fx.audit(a).length), [2, 2, 1]);
  const log = w.t.fx.audit('session.date_move')[0];
  assert.deepEqual([log.actor_id, log.target_id, log.location_id, JSON.parse(log.detail)],
    [by, s.id, w.a.id, { date: '2026-11-30', to: '2026-12-01', reason: 'Staff training day' }]);
  // The schedule list carries the upcoming changes.
  const list = await w.t.as(w.staffA).get('/api/sessions');
  assert.deepEqual(list.body.sessions.find(x => x.id === s.id).changes.map(c => [c.date, c.kind, c.moved_from]), [
    [MON, 'skip', null], ['2026-11-24', 'add', null], ['2026-11-30', 'skip', null], ['2026-12-01', 'add', '2026-11-30'],
    ['2026-12-02', 'skip', null], ['2026-12-05', 'add', null],
  ]);
  // HQ can change any location's schedule.
  assert.equal((await w.t.as(w.hq).post(datesUrl(s), { action: 'skip', date: '2026-12-04' })).status, 201);
});

test(['SC-5'], 'a date change is refused, and nobody told, for past dates, dates outside the period, non-meeting dates, closures, changed dates and dates with visits', async () => {
  const w = await world({ now: at(LA, '2026-10-14', '22:30') }); // Wed 10:30pm in Irvine, already Thu in UTC and Toronto
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);
  w.t.db.prepare("INSERT INTO closures (location_id, date, reason) VALUES (?, '2026-11-24', 'Inservice')").run(w.a.id);
  w.t.fx.sessionDate(s, '2026-12-07', 'skip');
  w.t.fx.sessionDate(s, '2026-12-08', 'add');
  w.t.fx.visit(fam.student, w.a, { session: s, local_date: '2026-10-14' });
  const refused = [
    [{ action: 'skip', date: '2026-10-12' }, 400, 'past_date'],
    [{ action: 'move', date: MON, to: '2026-10-13' }, 400, 'past_date'],
    [{ action: 'add', date: '2026-12-19' }, 400, 'outside_term'],
    [{ action: 'move', date: '2026-12-18', to: '2026-12-21' }, 400, 'outside_term'],
    [{ action: 'add', date: '2026-08-15' }, 400, 'past_date'],
    [{ action: 'skip', date: '2026-11-25T00:00' }, 400, 'date'],
    [{ action: 'skip', date: '2026-11-26' }, 400, 'not_a_meeting_date'],
    [{ action: 'skip', date: '2026-12-07' }, 400, 'not_a_meeting_date'],
    [{ action: 'move', date: '2026-11-26', to: '2026-11-28' }, 400, 'not_a_meeting_date'],
    [{ action: 'add', date: '2026-11-25' }, 400, 'already_meets'],
    [{ action: 'add', date: '2026-12-08' }, 400, 'already_meets'],
    [{ action: 'move', date: MON, to: '2026-11-25' }, 400, 'already_meets'],
    [{ action: 'move', date: MON, to: MON }, 400, 'already_meets'],
    [{ action: 'add', date: '2026-11-24' }, 400, 'closed_that_day'],
    [{ action: 'move', date: MON, to: '2026-11-24' }, 400, 'closed_that_day'],
    [{ action: 'skip', date: '2026-12-08' }, 409, 'already_changed'],
    [{ action: 'add', date: '2026-12-07' }, 409, 'already_changed'],
    [{ action: 'move', date: '2026-12-08', to: '2026-12-10' }, 409, 'already_changed'],
    [{ action: 'move', date: MON, to: '2026-12-07' }, 409, 'already_changed'],
    [{ action: 'skip', date: '2026-10-14' }, 409, 'date_has_visits'],
    [{ action: 'move', date: '2026-10-14', to: '2026-10-15' }, 409, 'date_has_visits'],
    [{ action: 'cancel', date: MON }, 400, 'action'],
    [{ date: MON }, 400, 'action'],
    [{ action: 'skip', date: '2026-02-30' }, 400, 'date'],
    [{ action: 'skip' }, 400, 'date'],
    [{ action: 'move', date: MON }, 400, 'date'],
    [{ action: 'move', date: MON, to: POISON }, 400, 'date'],
    [{ action: 'skip', date: MON, reason: POISON }, 400, 'reason'],
    [{ action: 'skip', date: MON, reason: 7 }, 400, 'reason'],
  ];
  for (const [body, status, code] of refused) {
    const r = await w.t.as(w.dirA).post(datesUrl(s), body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error, code, JSON.stringify(body));
  }
  const msg = async (body, text) => assert.equal((await w.t.as(w.dirA).post(datesUrl(s), body)).body.message, text);
  await msg({ action: 'skip', date: '2026-10-12' }, 'Mon, Oct 12 has already passed at Irvine. Only today or a later date can change.');
  await msg({ action: 'add', date: '2026-12-19' }, 'Sat, Dec 19 isn\'t inside Fall 2026 (Mon, Aug 17 – Fri, Dec 18).');
  await msg({ action: 'skip', date: '2026-11-26' }, 'Afternoon Study doesn\'t meet on Thu, Nov 26.');
  await msg({ action: 'add', date: '2026-11-25' }, 'Afternoon Study already meets on Wed, Nov 25.');
  await msg({ action: 'add', date: '2026-11-24' }, 'Irvine is closed on Tue, Nov 24, so Afternoon Study can\'t meet then.');
  await msg({ action: 'skip', date: '2026-12-08' }, 'Afternoon Study already has a change on Tue, Dec 8. Undo that change first.');
  await msg({ action: 'skip', date: '2026-10-14' }, 'Students already checked in to Afternoon Study on Wed, Oct 14, so that date can\'t be skipped or moved.');
  assert.deepEqual(dateRows(w.t, s).map(r => [r.date, r.kind]), [['2026-12-07', 'skip'], ['2026-12-08', 'add']]);
  assert.equal(w.t.fx.notifications(fam.parent).length, 0);
  assert.equal(w.t.fx.audit().filter(a => a.action.startsWith('session.date')).length, 0);

  // Today is still today by the location's date (Wed in Irvine), and a visit to another schedule doesn't block it.
  const wed = w.t.fx.session(w.a, { name: 'Wednesday Focus', weekdays: '3', start: '09:00', end: '11:30' });
  assert.equal((await w.t.as(w.dirA).post(datesUrl(wed), { action: 'skip', date: '2026-10-14' })).status, 201);
  // Toronto is already on Thursday: its Wednesday has passed, its Thursday is today.
  const tor = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  w.t.fx.term(tor);
  const torS = w.t.fx.session(tor, { name: 'Toronto Study', weekdays: '1,3,5', start: '09:00', end: '11:30' });
  const dirT = w.t.fx.director(tor);
  assert.equal((await w.t.as(dirT).post(datesUrl(torS), { action: 'add', date: '2026-10-14' })).body.error, 'past_date');
  assert.equal((await w.t.as(dirT).post(datesUrl(torS), { action: 'add', date: '2026-10-15' })).status, 201);
  // A cancelled schedule's dates are settled.
  w.t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
  const gone = await w.t.as(w.dirA).post(datesUrl(s), { action: 'skip', date: MON });
  assert.deepEqual([gone.status, gone.body.error], [409, 'cancelled']);
});

test(['SC-5'], 'undo takes a change back (both halves of a move), today or later only, and tells the same families once', async () => {
  const w = await world(); // Wed 14 Oct 2026
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const act = w.t.fx.family(w.a), pau = w.t.fx.family(w.a), wait = w.t.fx.family(w.a);
  w.t.fx.enroll(act.student, s);
  w.t.fx.enroll(pau.student, s, 0, { status: 'paused' });
  w.t.fx.waitlist(wait.student, s);
  const post = body => w.t.as(w.dirA).post(datesUrl(s), body);
  const undo = date => w.t.as(w.dirA).del(datesUrl(s) + '/' + date);
  const last = () => { const n = w.t.fx.notifications(act.parent, 'schedule_date_restored'); return n.length && [n.length, n[n.length - 1].title, n[n.length - 1].body]; };
  await post({ action: 'skip', date: MON, reason: 'Staff training day' });
  await post({ action: 'add', date: '2026-12-05' });
  await post({ action: 'move', date: '2026-11-30', to: '2026-12-01' });

  const r1 = await undo(MON);
  assert.deepEqual([r1.status, r1.body], [200, { ok: true, notified: 4 }]);
  assert.deepEqual(last(), [1, 'Afternoon Study meets Mon, Nov 23 after all', 'Same time, 1:00 PM–4:00 PM.']);
  const r2 = await undo('2026-12-05');
  assert.equal(r2.status, 200);
  assert.deepEqual(last(), [2, 'Afternoon Study no longer meets Sat, Dec 5', 'Your other dates go ahead as usual.']);
  // Undoing the Tuesday of a move takes back its Monday too, with one notice.
  const r3 = await undo('2026-12-01');
  assert.deepEqual([r3.status, r3.body.notified], [200, 4]);
  assert.deepEqual(last(), [3, 'Afternoon Study meets Mon, Nov 30 after all', 'It no longer moves to Tue, Dec 1. Same time, 1:00 PM–4:00 PM.']);
  assert.deepEqual(dateRows(w.t, s), []);
  // And undoing the Monday of a move takes back its Tuesday.
  await post({ action: 'move', date: '2026-11-30', to: '2026-12-01' });
  assert.equal((await undo('2026-11-30')).status, 200);
  assert.deepEqual(dateRows(w.t, s), []);
  assert.equal(last()[0], 4);
  for (const u of [act.student, pau.student, pau.parent]) assert.equal(sent(w.t, u, 'schedule_date_restored'), 4, u.name);
  assert.equal(w.t.fx.notifications(wait.parent).length, 0);
  const undone = w.t.fx.audit('session.date_undo');
  assert.equal(undone.length, 4);
  assert.deepEqual(JSON.parse(undone[2].detail).undone.map(x => [x.date, x.kind, x.moved_from]).sort(),
    [['2026-11-30', 'skip', null], ['2026-12-01', 'add', '2026-11-30']]);
  // Nothing to undo.
  for (const d of ['2026-11-30', '2026-02-30', 'banana']) assert.equal((await undo(d)).status, 404, d);
  // Past dates never change: a past skip stays, and so does a move whose Monday has passed.
  w.t.fx.sessionDate(s, '2026-10-12', 'skip');
  w.t.fx.sessionDate(s, '2026-10-05', 'skip');
  w.t.fx.sessionDate(s, '2026-10-20', 'add', { moved_from: '2026-10-05' });
  for (const d of ['2026-10-12', '2026-10-20']) {
    const r = await undo(d);
    assert.deepEqual([r.status, r.body.error], [400, 'past_date'], d);
  }
  assert.equal(dateRows(w.t, s).length, 3);
  // Taking back an added date someone already came to would leave a visit on a date that doesn't meet.
  const tth = w.t.fx.session(w.a, { name: 'Tue/Thu', weekdays: '2,4' });
  w.t.fx.sessionDate(tth, '2026-10-14', 'add');
  const visit = w.t.fx.visit(act.student, w.a, { session: tth, local_date: '2026-10-14' });
  const blocked = await w.t.as(w.dirA).del(datesUrl(tth) + '/2026-10-14');
  assert.deepEqual([blocked.status, blocked.body.error], [409, 'date_has_visits']);
  w.t.db.prepare('DELETE FROM visits WHERE id = ?').run(visit.id);
  assert.equal((await w.t.as(w.dirA).del(datesUrl(tth) + '/2026-10-14')).status, 200);
  // A cancelled schedule keeps its history.
  w.t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(s.id);
  assert.equal((await undo('2026-10-12')).body.error, 'cancelled');
});

test(['SC-5', 'SC-3'], 'a closure wins over date changes (D-47): a skipped day that closes lists as closed and its skip can\'t be undone onto it, and a closed day can\'t be skipped, moved from, added or moved to', async () => {
  const w = await world(); // Wed 14 Oct 2026
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);
  const post = body => w.t.as(w.dirA).post(datesUrl(s), body);
  const undo = date => w.t.as(w.dirA).del(datesUrl(s) + '/' + date);
  const told = () => w.t.fx.notifications(fam.parent).filter(n => n.kind.startsWith('schedule_date_')).length;
  assert.equal((await post({ action: 'skip', date: '2026-11-25' })).status, 201);
  assert.equal((await post({ action: 'move', date: '2026-11-30', to: '2026-12-01' })).status, 201);
  for (const [date, reason] of [['2026-11-25', 'Thanksgiving eve'], ['2026-11-27', 'Thanksgiving'], ['2026-11-30', 'Inservice']]) {
    assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date, reason })).status, 201);
  }
  assert.equal(told(), 2);
  const on = async date => (await w.t.as(fam.parent).get(datesUrl(s))).body.dates.find(d => d.date === date);
  assert.deepEqual(await on('2026-11-25'), { date: '2026-11-25', kind: 'closed', reason: 'Thanksgiving eve', moved_from: null, past: false });
  assert.deepEqual(await on('2026-11-30'), { date: '2026-11-30', kind: 'closed', reason: 'Inservice', moved_from: null, past: false });
  // Undoing would tell families the schedule meets on a closed day: refused, for a skip and for either half of a move.
  for (const d of ['2026-11-25', '2026-12-01', '2026-11-30']) {
    const r = await undo(d);
    assert.deepEqual([r.status, r.body.error], [400, 'closed_that_day'], d);
  }
  assert.equal((await undo('2026-11-25')).body.message, 'Irvine is closed on Wed, Nov 25, so Afternoon Study can\'t meet then. Reopen that day first to undo this change.');
  assert.equal(dateRows(w.t, s).length, 3);
  // A closed regular day isn't a meeting date: nothing to skip or move away, and nothing to add.
  const refused = [
    [{ action: 'skip', date: '2026-11-27' }, 'not_a_meeting_date', 'Irvine is closed on Fri, Nov 27, so Afternoon Study doesn\'t meet then.'],
    [{ action: 'move', date: '2026-11-27', to: '2026-11-28' }, 'not_a_meeting_date', 'Irvine is closed on Fri, Nov 27, so Afternoon Study doesn\'t meet then.'],
    [{ action: 'add', date: '2026-11-27' }, 'closed_that_day', 'Irvine is closed on Fri, Nov 27, so Afternoon Study can\'t meet then.'],
    [{ action: 'move', date: '2026-11-23', to: '2026-11-27' }, 'closed_that_day', 'Irvine is closed on Fri, Nov 27, so Afternoon Study can\'t meet then.'],
  ];
  for (const [body, code, message] of refused) {
    const r = await post(body);
    assert.deepEqual([r.status, r.body.error, r.body.message], [400, code, message], JSON.stringify(body));
  }
  assert.equal(dateRows(w.t, s).length, 3);
  assert.equal(told(), 2, 'nobody was told anything more');
  // Once the day reopens, the skip can be undone as usual.
  const c = w.t.db.prepare("SELECT id FROM closures WHERE date = '2026-11-25'").get();
  assert.equal((await w.t.as(w.dirA).del('/api/sessions/closures/' + c.id)).status, 200);
  assert.equal((await undo('2026-11-25')).status, 200);
  assert.equal(told(), 3);
});

test(['SC-5', 'CI-7'], 'a staff check-in with no schedule (D-15a) counts as a visit for the date: today\'s date can\'t then be skipped, moved or taken back', async () => {
  const w = await world({ now: at(LA, '2026-11-10', '08:00') }); // Tue Nov 10, 8:00 AM
  const s = w.t.fx.session(w.a, { name: 'Mornings MWF', weekdays: '1,3,5', start: '09:00', end: '12:00' });
  const fam = w.t.fx.family(w.a), other = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);
  assert.equal((await w.t.as(w.dirA).post(datesUrl(s), { action: 'add', date: '2026-11-10' })).status, 201);
  const visit = (student, o) => w.t.fx.visit(student, w.a, Object.assign({ local_date: '2026-11-10', checkin_method: 'staff', checked_in_by: w.staffA.id }, o));
  // A student not in the schedule, and one who left before it started, don't hold the date.
  const early = visit(fam.student, { check_in_at: at(LA, '2026-11-10', '07:30'), check_out_at: at(LA, '2026-11-10', '08:00') });
  const stranger = visit(other.student, { check_in_at: at(LA, '2026-11-10', '08:00') });
  const notAfter = await w.t.as(w.dirA).del(datesUrl(s) + '/2026-11-10');
  assert.equal(notAfter.status, 200);
  assert.equal((await w.t.as(w.dirA).post(datesUrl(s), { action: 'add', date: '2026-11-10' })).status, 201);
  w.t.db.prepare('DELETE FROM visits WHERE id IN (?, ?)').run(early.id, stranger.id);
  // Sofia's staff check-in at 8:00 is still open, so it runs into the 9:00 date.
  const here = visit(fam.student, { check_in_at: at(LA, '2026-11-10', '08:00') });
  const r = await w.t.as(w.dirA).del(datesUrl(s) + '/2026-11-10');
  assert.deepEqual([r.status, r.body.error], [409, 'date_has_visits']);
  assert.equal(dateRows(w.t, s).length, 1);
  // The same on a regular date: Wednesday's can't be skipped or moved once she is in for it.
  w.t.clock.set(at(LA, '2026-11-11', '08:45'));
  w.t.db.prepare('DELETE FROM visits WHERE id = ?').run(here.id);
  visit(fam.student, { local_date: '2026-11-11', check_in_at: at(LA, '2026-11-11', '08:40') });
  for (const body of [{ action: 'skip', date: '2026-11-11' }, { action: 'move', date: '2026-11-11', to: '2026-11-12' }]) {
    const x = await w.t.as(w.dirA).post(datesUrl(s), body);
    assert.deepEqual([x.status, x.body.error], [409, 'date_has_visits'], body.action);
  }
});

test(['SC-5'], 'the dates route lists the whole period: regular, added, skipped and closed dates, with reasons and what has passed', async () => {
  const w = await world(); // Wed 14 Oct 2026
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const other = w.t.fx.session(w.a, { name: 'Mornings MWF', start: '09:00', end: '11:30' });
  w.t.fx.sessionDate(s, MON, 'skip', { reason: 'Staff training day' });
  w.t.fx.sessionDate(s, '2026-11-24', 'add', { moved_from: MON, reason: 'Staff training day' });
  w.t.fx.sessionDate(s, '2026-12-05', 'add', { reason: 'Exam prep' });
  w.t.fx.sessionDate(s, '2026-10-12', 'skip');
  w.t.fx.sessionDate(s, '2026-12-21', 'add'); // outside the period: ignored
  w.t.fx.sessionDate(other, '2026-11-25', 'skip'); // another schedule's change
  const close = (loc, date, reason) => w.t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(loc.id, date, reason);
  close(w.a, '2026-11-26', 'Thanksgiving');
  close(w.a, '2026-11-27', 'Thanksgiving');
  close(w.a, '2026-12-05', 'Snow day'); // the closure wins over an added date (D-47)
  close(w.b, '2026-11-30', 'Arcadia only');
  const fam = w.t.fx.family(w.a);
  const r = await w.t.as(fam.parent).get(datesUrl(s));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.term, { id: w.termA.id, name: 'Fall 2026', start_date: '2026-08-17', end_date: '2026-12-18' });
  assert.deepEqual([r.body.session.id, r.body.session.name, r.body.session.changes.map(c => c.date)], [s.id, 'Afternoon Study', [MON, '2026-11-24', '2026-12-05']]);
  const ds = r.body.dates;
  // 18 weeks of Mon/Wed/Fri (two of them skipped, one closed), plus the Tuesday and the closed Saturday.
  assert.equal(ds.length, 18 * 3 + 2);
  assert.deepEqual(ds.map(d => d.date), [...ds.map(d => d.date)].sort());
  const on = date => ds.find(d => d.date === date);
  assert.deepEqual(on('2026-08-17'), { date: '2026-08-17', kind: 'regular', reason: null, moved_from: null, past: true });
  assert.deepEqual(on('2026-10-12'), { date: '2026-10-12', kind: 'skipped', reason: null, moved_from: null, past: true });
  assert.deepEqual(on('2026-10-14'), { date: '2026-10-14', kind: 'regular', reason: null, moved_from: null, past: false });
  assert.deepEqual(on(MON), { date: MON, kind: 'skipped', reason: 'Staff training day', moved_from: null, past: false });
  assert.deepEqual(on('2026-11-24'), { date: '2026-11-24', kind: 'added', reason: 'Staff training day', moved_from: MON, past: false });
  assert.deepEqual(on('2026-11-25'), { date: '2026-11-25', kind: 'regular', reason: null, moved_from: null, past: false });
  assert.equal(on('2026-11-26'), undefined);
  assert.deepEqual(on('2026-11-27'), { date: '2026-11-27', kind: 'closed', reason: 'Thanksgiving', moved_from: null, past: false });
  assert.deepEqual(on('2026-11-30'), { date: '2026-11-30', kind: 'regular', reason: null, moved_from: null, past: false });
  assert.deepEqual(on('2026-12-05'), { date: '2026-12-05', kind: 'closed', reason: 'Snow day', moved_from: null, past: false });
  assert.equal(on('2026-12-21'), undefined);
  // GET / shows only the changes from today on, inside the period.
  const list = await w.t.as(fam.parent).get('/api/sessions');
  assert.deepEqual(list.body.sessions.find(x => x.id === s.id).changes, [
    { date: MON, kind: 'skip', moved_from: null, reason: 'Staff training day' },
    { date: '2026-11-24', kind: 'add', moved_from: MON, reason: 'Staff training day' },
    { date: '2026-12-05', kind: 'add', moved_from: null, reason: 'Exam prep' },
  ]);
  assert.equal((await w.t.as(w.dirA).get('/api/sessions/99999/dates')).status, 404);
});

test(['SC-5'], 'the demo seed moves Mornings MWF from the first Monday at least 3 days ahead to its Tuesday, through the same service, and tells the family', async () => {
  const run = async (now, closures = []) => {
    const t = await makeApp({ now });
    const irvine = t.fx.location({ name: 'Irvine' });
    t.fx.term(irvine);
    for (const d of closures) t.db.prepare('INSERT INTO closures (location_id, date) VALUES (?,?)').run(irvine.id, d);
    const dir = t.fx.director(irvine);
    const mornings = t.fx.session(irvine, { name: 'Mornings MWF', start: '09:00', end: '12:00', capacity: 24 });
    const fam = t.fx.family(irvine);
    t.fx.enroll(fam.student, mornings);
    load('src/modules/sessions/seed.js')(t.ctx, { NOW: now, locations: { irvine }, dirIrvine: dir, sessions: { morningsMWF: mornings } });
    assert.equal(t.clock.now(), now, 'the clock is left where it was');
    return { t, dir, fam, rows: dateRows(t, mornings).map(r => [r.date, r.kind, r.moved_from, r.reason, r.created_by]) };
  };
  // Fri Oct 16: Mon Oct 19 is 3 days ahead.
  const fri = await run(at(LA, '2026-10-16', '10:00'));
  assert.deepEqual(fri.rows, [['2026-10-19', 'skip', null, 'Staff training day', fri.dir.id], ['2026-10-20', 'add', '2026-10-19', 'Staff training day', fri.dir.id]]);
  for (const u of [fri.fam.student, fri.fam.parent]) {
    const n = fri.t.fx.notifications(u, 'schedule_date_moved');
    assert.deepEqual(n.map(x => [x.title, x.body]), [['Mornings MWF moves from Mon, Oct 19 to Tue, Oct 20', 'Same time, 9:00 AM–12:00 PM. Staff training day']]);
  }
  assert.equal(fri.t.fx.audit('session.date_move')[0].actor_id, fri.dir.id);
  // Sat Oct 17: Oct 19 is only 2 days ahead, and Tue Oct 27 is closed, so Mon Nov 2 moves.
  const sat = await run(at(LA, '2026-10-17', '10:00'), ['2026-10-27']);
  assert.deepEqual(sat.rows.map(r => r.slice(0, 3)), [['2026-11-02', 'skip', null], ['2026-11-03', 'add', '2026-11-02']]);
  // After the period: the first Monday in it, changed as if three days before it.
  const late = await run(at(LA, '2026-12-20', '10:00'));
  assert.deepEqual(late.rows.map(r => r.slice(0, 3)), [['2026-08-17', 'skip', null], ['2026-08-18', 'add', '2026-08-17']]);
  assert.equal(late.t.fx.notifications(late.fam.parent, 'schedule_date_moved')[0].created_at, at(LA, '2026-08-14', '09:00'));
});

// ---------------- NF-4: each location runs on its own time zone ----------------

test(['NF-4', 'SC-1'], 'a Toronto schedule keeps Toronto times, and "today" follows Toronto\'s calendar', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '22:30') }); // already Thu 01:30 in Toronto
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
  // A change dated Thursday shows in Toronto's upcoming changes, a Wednesday one doesn't.
  const s = list.body.sessions[0];
  t.db.prepare("INSERT INTO session_dates (session_id, date, kind, created_at) VALUES (?, '2026-10-14', 'add', 0), (?, '2026-10-15', 'skip', 0)").run(s.id, s.id);
  assert.deepEqual((await t.as(staffT).get('/api/sessions')).body.sessions[0].changes.map(c => c.date), ['2026-10-15']);
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

test(['NF-1'], 'today\'s schedules: staff and up, at their own location only', async () => {
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

test(['NF-1'], 'a location\'s schedules, counts and closures never include another location\'s', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles (both locations)
  const sA = w.t.fx.session(w.a, { name: 'Irvine Study', weekdays: '1,3', capacity: 4 });
  const famA = w.t.fx.family(w.a);
  w.t.fx.enroll(famA.student, sA);
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON, reason: 'Irvine staff training' })).status, 201);
  // Arcadia meets today too, with its own enrollments and waitlist, and is closed today.
  const sB = w.t.fx.session(w.b, { name: 'Arcadia Study', weekdays: '3', start: '09:30', end: '12:00', capacity: 6 });
  w.t.fx.enroll(w.t.fx.family(w.b).student, sB);
  w.t.fx.enroll(w.t.fx.family(w.b).student, sB);
  w.t.fx.waitlist(w.t.fx.family(w.b).student, sB);
  assert.equal((await w.t.as(w.dirB).post('/api/sessions/closures', { date: '2026-10-14', reason: 'Arcadia power outage' })).status, 201);

  const urlA = '/api/sessions?location_id=' + w.a.id;
  for (const u of [w.staffA, w.dirA, famA.parent, w.hq]) {
    const r = await w.t.as(u).get(urlA);
    assert.equal(r.status, 200, u.role);
    assert.equal(r.body.location.id, w.a.id, u.role);
    assert.deepEqual(r.body.terms.map(x => x.id), [w.termA.id], u.role);
    assert.deepEqual(r.body.closures.map(x => [x.date, x.reason]), [[MON, 'Irvine staff training']], u.role);
    assert.deepEqual(r.body.sessions.map(s => [s.id, s.name, s.enrolled, s.paused, s.waiting, s.seats_left]),
      [[sA.id, 'Irvine Study', 1, 0, 0, 3]], u.role);
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

test(['NF-1'], 'creating a schedule: the location\'s own director or HQ only', async () => {
  const w = await world();
  const famA = w.t.fx.family(w.a);
  for (const u of [w.staffA, famA.parent, famA.student, w.dirB]) {
    const r = await w.t.as(u).post('/api/sessions', block({ location_id: w.a.id, term_id: w.termA.id }));
    assert.equal(r.status, 403, u.role);
  }
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal((await w.t.as(w.hq).post('/api/sessions', block({ location_id: w.a.id, term_id: w.termA.id }))).status, 201);
});

test(['NF-1'], 'editing or cancelling a schedule: the location\'s own director or HQ only', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Irvine Study' });
  const famA = w.t.fx.family(w.a);
  w.t.fx.enroll(famA.student, s);
  for (const u of [w.staffA, famA.parent, famA.student, w.dirB]) {
    assert.equal((await w.t.as(u).put('/api/sessions/' + s.id, { name: 'Hijacked', capacity: 50 })).status, 403, u.role);
    assert.equal((await w.t.as(u).post('/api/sessions/' + s.id + '/cancel')).status, 403, u.role);
  }
  assert.deepEqual([row(w.t, s.id).name, row(w.t, s.id).capacity, row(w.t, s.id).status], ['Irvine Study', 10, 'active']);
  assert.equal(w.t.fx.notifications(famA.parent).length, 0);
  assert.equal((await w.t.as(w.hq).put('/api/sessions/' + s.id, { name: 'Irvine Focus' })).status, 200);
  assert.equal((await w.t.as(w.hq).post('/api/sessions/' + s.id + '/cancel')).status, 200);
});

test(['NF-1'], 'periods: the location\'s own director or HQ only', async () => {
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
  w.t.fx.enroll(famA.student, s);
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

test(['NF-1', 'SC-5'], 'a schedule\'s dates: read at your own location (families included); changed by its own director or HQ only', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Irvine Study' });
  const famA = w.t.fx.family(w.a), famB = w.t.fx.family(w.b);
  w.t.fx.enroll(famA.student, s);
  const url = datesUrl(s);
  for (const u of [famB.parent, famB.student, w.staffB, w.dirB]) {
    const r = await w.t.as(u).get(url);
    assert.equal(r.status, 403, u.role);
    assert.equal(r.body.dates, undefined);
  }
  assert.equal((await w.t.anon.get(url)).status, 401);
  for (const u of [famA.parent, famA.student, w.staffA, w.dirA, w.hq]) {
    const r = await w.t.as(u).get(url);
    assert.equal(r.status, 200, u.role);
    assert.equal(r.body.session.id, s.id);
  }
  for (const u of [w.staffA, famA.parent, famA.student, w.dirB]) {
    assert.equal((await w.t.as(u).post(url, { action: 'skip', date: MON })).status, 403, u.role);
  }
  assert.equal((await w.t.anon.post(url, { action: 'skip', date: MON })).status, 401);
  assert.deepEqual(dateRows(w.t, s), []);
  assert.equal(w.t.fx.notifications(famA.parent).length, 0);
  assert.equal((await w.t.as(w.dirA).post(url, { action: 'skip', date: MON })).status, 201);
  assert.equal((await w.t.as(w.hq).post(url, { action: 'add', date: '2026-11-24' })).status, 201);
  for (const u of [w.staffA, famA.parent, w.dirB]) {
    assert.equal((await w.t.as(u).del(url + '/' + MON)).status, 403, u.role);
  }
  assert.equal(dateRows(w.t, s).length, 2);
  assert.equal((await w.t.as(w.hq).del(url + '/' + MON)).status, 200);
  assert.equal((await w.t.as(w.dirA).del(url + '/2026-11-24')).status, 200);
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/99999/dates', { action: 'skip', date: MON })).status, 404);
});

// ---------------- Round-1 sweep rules (R3, R4, R7, R8) ----------------

test(['SC-3'], 'R3: closures are added and removed for today or later only, by the location\'s own date; a past date is refused and nobody is told', async () => {
  const w = await world({ now: at(LA, '2026-10-14', '22:30') }); // Wed 10:30pm in Irvine, already Thu in Toronto
  const tor = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  w.t.fx.term(tor);
  const dirT = w.t.fx.director(tor);
  const s = w.t.fx.session(w.a, { weekdays: '1,3' });
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);

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

test(['SC-1', 'SC-4'], 'R4: a schedule starts no earlier than its location opens and ends no later than it closes, when created or edited', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine', open_time: '09:00', close_time: '18:00' });
  const term = t.fx.term(loc);
  const dir = t.fx.director(loc);
  const post = over => t.as(dir).post('/api/sessions', block(Object.assign({ term_id: term.id }, over)));
  const msg = 'Irvine is open 9:00 AM–6:00 PM, so a schedule there has to start at 9:00 AM or later and end by 6:00 PM.';
  for (const [start_time, end_time] of [['16:30', '18:30'], ['08:00', '10:00'], ['08:59', '11:00'], ['16:00', '18:01']]) {
    const r = await post({ start_time, end_time });
    assert.equal(r.status, 400, start_time + '-' + end_time);
    assert.deepEqual([r.body.error, r.body.message], ['outside_hours', msg]);
  }
  assert.equal(count(t, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal((await post({ start_time: '09:00', end_time: '11:00' })).status, 201); // opens at 9
  const late = await post({ start_time: '16:00', end_time: '18:00' });             // closes at 6
  assert.equal(late.status, 201);
  // An edit can't push it past closing either; the schedule keeps its times.
  const e = await t.as(dir).put('/api/sessions/' + late.body.session.id, { end_time: '18:30' });
  assert.equal(e.status, 400);
  assert.equal(e.body.error, 'outside_hours');
  assert.deepEqual([row(t, late.body.session.id).start_time, row(t, late.body.session.id).end_time], ['16:00', '18:00']);
  assert.equal((await t.as(dir).put('/api/sessions/' + late.body.session.id, { start_time: '15:30' })).status, 200);
});

test(['SC-3', 'SC-4', 'SC-5'], 'R7: shortening a period tells the families whose schedules lose a meeting date (by dates.js); nobody else', async () => {
  const w = await world(); // Wed 14 Oct 2026; Fall 2026 runs Mon Aug 17 - Fri Dec 18
  const mwf = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const tth = w.t.fx.session(w.a, { name: 'Tue/Thu Study', weekdays: '2,4' });
  const monAdd = w.t.fx.session(w.a, { name: 'Mondays plus', weekdays: '1', start: '09:00', end: '11:30' });
  w.t.fx.sessionDate(monAdd, '2026-12-17', 'add'); // an extra Thursday in the cut
  const monOnly = w.t.fx.session(w.a, { name: 'Mondays', weekdays: '1', start: '16:30', end: '18:30' });
  const friSkip = w.t.fx.session(w.a, { name: 'Fridays', weekdays: '5', start: '16:30', end: '18:30' });
  w.t.fx.sessionDate(friSkip, '2026-12-18', 'skip'); // its last Friday was already skipped
  const fri = w.t.fx.family(w.a), thu = w.t.fx.family(w.a), plus = w.t.fx.family(w.a), mons = w.t.fx.family(w.a),
    fris = w.t.fx.family(w.a), v1 = w.t.fx.family(w.a), gone = w.t.fx.family(w.a);
  w.t.fx.enroll(fri.student, mwf);
  w.t.fx.enroll(thu.student, tth, 0, { status: 'paused' });
  w.t.fx.enroll(plus.student, monAdd);
  w.t.fx.enroll(mons.student, monOnly);
  w.t.fx.enroll(fris.student, friSkip);
  w.t.fx.enroll(v1.student, mwf, 1); // a v1 Monday row counts only on Mondays
  w.t.fx.enroll(gone.student, mwf, 0, { status: 'dropped' });
  const spring = w.t.fx.term(w.a, { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' });
  const springFam = w.t.fx.family(w.a);
  w.t.fx.enroll(springFam.student, w.t.fx.session(w.a, { term: spring, weekdays: '1,5' }));
  const kind = 'term_shortened';

  // Ending on Wed Dec 16 cuts Thu Dec 17 and Fri Dec 18.
  const r = await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-16' });
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, 6);
  for (const u of [fri.student, fri.parent, thu.student, thu.parent, plus.student, plus.parent]) {
    const n = w.t.fx.notifications(u, kind);
    assert.equal(n.length, 1, u.name);
    assert.equal(n[0].title, 'Fall 2026 at Irvine now runs Mon, Aug 17 – Wed, Dec 16');
    assert.equal(n[0].body, 'Irvine changed Fall 2026 from Mon, Aug 17 – Fri, Dec 18 to Mon, Aug 17 – Wed, Dec 16. ' +
      'Your schedule in it doesn\'t meet outside those dates. You can pick another schedule in the app.');
  }
  for (const u of [mons.student, mons.parent, fris.parent, v1.parent, gone.student, gone.parent, springFam.student, springFam.parent]) assert.equal(sent(w.t, u, kind), 0, u.name);
  // Lengthening it again, or moving a start date that has already passed, cuts nothing ahead.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-12-18' })).body.notified, 0);
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { start_date: '2026-08-24' })).body.notified, 0);
  // A later start for a period ahead cuts its first weeks: Mon Jan 11 and Fri Jan 15 are gone for the spring family.
  const sp = await w.t.as(w.dirA).put('/api/sessions/terms/' + spring.id, { start_date: '2027-01-18' });
  assert.equal(sp.body.notified, 2);
  assert.equal(sent(w.t, springFam.parent, kind), 1);
  // Ending the period yesterday cuts every date from today on: every live enrollment hears.
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/terms/' + w.termA.id, { end_date: '2026-10-13' })).body.notified, 12);
  for (const u of [mons.parent, fris.parent, v1.parent]) assert.equal(sent(w.t, u, kind), 1, u.name);
  assert.equal(sent(w.t, gone.parent, kind), 0);
  assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE status = 'active'"), 6); // enrollments are left as they are
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
  w.t.clock.set(at(LA, '2026-10-20', '09:00'));
  assert.equal((await put({ start_time: '13:00', end_time: '16:00' })).status, 200);
  assert.deepEqual(hist(s.id), [{ until_date: '2026-10-13', start_time: '13:00', end_time: '16:00' },
    { until_date: '2026-10-19', start_time: '14:00', end_time: '17:00' }]);
  // The edit date is the location's own: 10:30pm Tuesday in Irvine is already Wednesday in Toronto.
  const tor = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  w.t.fx.term(tor);
  const ts = w.t.fx.session(tor, { weekdays: '1,3,5', start: '09:00', end: '11:30' });
  w.t.clock.set(at(LA, '2026-10-20', '22:30'));
  assert.equal((await w.t.as(w.hq).put('/api/sessions/' + ts.id, { start_time: '09:30', end_time: '12:00' })).status, 200);
  assert.deepEqual(hist(ts.id), [{ until_date: '2026-10-20', start_time: '09:00', end_time: '11:30' }]);
});

// ---------------- Sweep fixes: L36, L38 (server) ----------------

// L36 runs the enrollment module's waitlist job. A run scoped to sessions alone
// does not load that module, so there a stand-in job proves the hand-off; the
// full run and any run that includes integration load it and check the fill.
const enrollmentLoaded = !process.env.ELITE_MODULES || process.env.ELITE_MODULES.split(',').includes('enrollment');

test(['SC-2', 'SC-4'], 'raising seats fills them from the waitlist at once, through the enrollment module\'s own job (L36)', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { weekdays: '1,3', capacity: 1 });
  const held = w.t.fx.family(w.a);
  w.t.fx.enroll(held.student, s);
  const first = w.t.fx.family(w.a), second = w.t.fx.family(w.a), third = w.t.fx.family(w.a);
  const lines = [first, second, third].map(f => w.t.fx.waitlist(f.student, s).id);
  const mods = load('src/modules/index.js');
  const calls = [];
  const stand = !enrollmentLoaded && [
    { name: 'enrollment', jobs: [{ name: 'other-job', run: () => calls.push('other') }, { name: 'promote-waitlists', run: c => calls.push(c === w.t.ctx ? 'promote' : 'wrong ctx') }] },
    { name: 'attendance', jobs: [{ name: 'promote-waitlists', run: () => calls.push('wrong module') }] },
  ];
  if (stand) mods.push(...stand);
  try {
    const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.body.notified, 2, 'the edit itself tells the family already enrolled');
    if (stand) {
      assert.deepEqual(calls, ['promote']);
      // A rename, or fewer seats, runs nothing.
      assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Renamed' })).status, 200);
      assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { capacity: 2 })).status, 200);
      assert.deepEqual(calls, ['promote']);
      assert.deepEqual(lines.map(id => waitRow(w.t, id).status), ['waiting', 'waiting', 'waiting']);
      return;
    }
    // No job run: the Save itself served the line, and the reply shows it.
    assert.deepEqual(lines.map(id => waitRow(w.t, id).status), ['enrolled', 'enrolled', 'waiting']);
    assert.deepEqual([r.body.session.enrolled, r.body.session.waiting, r.body.session.seats_left], [3, 1, 0]);
    for (const f of [first, second]) {
      assert.equal(count(w.t, "SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ? AND session_id = ? AND weekday = 0 AND status = 'active'", f.student.id, s.id), 1);
      assert.equal(sent(w.t, f.parent, 'waitlist_promoted'), 1);
    }
    assert.equal(sent(w.t, third.parent, 'waitlist_promoted'), 0);
  } finally {
    if (stand) for (const m of stand) mods.splice(mods.indexOf(m), 1);
  }
});

test(['SC-4', 'SC-5'], 'a parent of two students in one schedule is told once, and "notified" counts people (L38)', async () => {
  const w = await world();
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const fam = w.t.fx.family(w.a, { students: 2 });
  for (const kid of fam.students) w.t.fx.enroll(kid, s);
  const r = await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Afternoon Study MWF' });
  assert.equal(r.body.notified, 3, 'two students and their parent');
  assert.equal(sent(w.t, fam.parent, 'session_changed'), 1);
  const d = await w.t.as(w.dirA).post(datesUrl(s), { action: 'skip', date: MON });
  assert.equal(d.body.notified, 3);
  assert.equal(sent(w.t, fam.parent, 'schedule_date_skipped'), 1);
  for (const kid of fam.students) assert.equal(sent(w.t, kid, 'schedule_date_skipped'), 1);
});

// ---------------- The Schedules screen in a browser tab ----------------

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
function sessionsTab(t, user, extraViews = []) {
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
  for (const f of ['public/js/app.js', 'public/js/views/sessions.js', ...extraViews]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  win.App.me = { user: { id: user.id, role: user.role, name: user.name, location_id: user.location_id } };
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    doc, main, requests, settle, toasts,
    async open() { const view = el('div'); main.replaceChildren(view); await win.App.views.find(v => v.id === 'sessions').render(view, []); await settle(); return view; },
    async inbox() { const view = el('div'); main.replaceChildren(view); await win.App.views.find(v => v.id === 'inbox').render(view, []); await settle(); return view; },
    async card(id) { const box = el('div'); main.replaceChildren(box); await win.App.cards.find(c => c.id === id).render(box); await settle(); return box; },
    title: () => win.App.views.find(v => v.id === 'sessions').title,
  };
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const btn = (root, label) => root.find(n => n.tag === 'button' && n.textContent === label);
const dialog = root => root.find(n => n.getAttribute('role') === 'alertdialog');
const labels = box => box.findAll(n => n.tag === 'button').map(b => b.textContent);
const dateLi = (view, label) => view.findAll(n => n.tag === 'li' && n.cls.includes('sx-date')).find(li => words(li).startsWith(label));

test(['SC-4', 'SC-5', 'NF-7'], 'Schedules screen: each row shows days, seats, waiting and the next change; days lock once families are in; every date change asks first, safe button focused', async () => {
  const w = await world(); // Wed 14 Oct 2026, 10:00 in Los Angeles
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  w.t.fx.session(w.a, { name: 'Quiet Room TTh', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 2 });
  w.t.fx.enroll(w.t.fx.family(w.a).student, s);
  w.t.fx.enroll(w.t.fx.family(w.a).student, s, 0, { status: 'paused' });
  w.t.fx.waitlist(w.t.fx.family(w.a).student, s);
  w.t.fx.sessionDate(s, MON, 'skip', { reason: 'Staff training day' });
  w.t.fx.sessionDate(s, '2026-11-24', 'add', { moved_from: MON, reason: 'Staff training day' });
  const tab = sessionsTab(w.t, w.dirA);
  assert.equal(tab.title(), 'Schedules');
  let view = await tab.open();
  const rows = () => view.findAll(n => n.tag === 'button' && n.cls.includes('sx-slot'));
  assert.deepEqual(rows().map(words), [
    'Afternoon Study Mon Wed Fri 1pm – 4pm 1 of 10 seats 1 waiting 3 days a week Moves Mon Nov 23 → Tue Nov 24',
    'Quiet Room TTh Tue Thu 4:30pm – 6:30pm 0 of 2 seats 2 days a week',
  ]);
  const boxes = () => view.findAll(n => n.tag === 'input' && n.getAttribute('type') === 'checkbox');

  // Nobody in Quiet Room yet: its days can change.
  rows()[1].click();
  assert.equal(boxes().filter(b => b.attrs.has('disabled')).length, 0);
  assert.ok(!/days are fixed/.test(words(view)));
  boxes().find(b => b.value === '4').checked = false;
  view.find(n => n.tag === 'form').dispatch('submit');
  await tab.settle();
  assert.equal(w.t.db.prepare("SELECT weekdays FROM sessions WHERE name = 'Quiet Room TTh'").get().weekdays, '2');

  // Afternoon Study has families: its days are fixed, and the note says why.
  rows()[0].click();
  assert.equal(boxes().length, 7);
  assert.ok(boxes().every(b => b.attrs.has('disabled') && b.getAttribute('aria-describedby') === 'sx-days-locked'));
  assert.match(words(view), /Families are enrolled or waiting, so the days are fixed\./);
  await tab.settle();

  // Its dates: moved ones are labelled, past ones can't change.
  assert.equal(words(dateLi(view, 'Mon, Nov 23')), 'Mon, Nov 23 Moved to Tue Nov 24 Staff training day Undo');
  assert.equal(words(dateLi(view, 'Tue, Nov 24')), 'Tue, Nov 24 Moved here from Mon Nov 23 Staff training day Undo');
  assert.equal(words(dateLi(view, 'Mon, Oct 12')), 'Mon, Oct 12 Past');
  assert.deepEqual(labels(dateLi(view, 'Wed, Oct 14')), ['Skip', 'Move…']);
  assert.equal(btn(dateLi(view, 'Wed, Oct 14'), 'Skip').getAttribute('aria-label'), 'Skip Wed, Oct 14');
  assert.ok(view.find(n => n.tag === 'h4' && n.textContent === 'November 2026'));

  // Skip: the safe button comes first and has focus; Escape keeps the date.
  let skip = btn(dateLi(view, 'Mon, Nov 30'), 'Skip');
  skip.focus();
  skip.click();
  let box = dialog(view);
  assert.equal(words(box), 'Skip Afternoon Study on Mon, Nov 30? 2 families are told now. Their other dates go ahead as usual. Keep this date Skip this date');
  assert.equal(tab.doc.activeElement, btn(box, 'Keep this date'));
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(dialog(view), undefined);
  assert.equal(tab.doc.activeElement, skip, 'focus goes back to Skip');
  assert.equal(view.find(n => n.id === 'sx-skip-reason'), undefined, 'the reason goes with the question');
  assert.ok(!tab.requests.some(r => r.startsWith('POST')), tab.requests.join('\n'));
  // An optional reason sits right above the question, and families see it (3.1).
  skip.click();
  const why = dateLi(view, 'Mon, Nov 30').find(n => n.id === 'sx-skip-reason');
  assert.equal(why.getAttribute('maxlength'), '120');
  assert.ok(dateLi(view, 'Mon, Nov 30').find(n => n.tag === 'label' && words(n).startsWith('Reason (optional)')));
  why.value = 'Staff training day';
  btn(dialog(view), 'Skip this date').click();
  await tab.settle();
  assert.deepEqual(dateRows(w.t, s).map(r => [r.date, r.kind]), [[MON, 'skip'], ['2026-11-24', 'add'], ['2026-11-30', 'skip']]);
  assert.equal(dateRows(w.t, s)[2].reason, 'Staff training day');
  // The panel stays open on the same schedule, with fresh dates.
  assert.match(words(dateLi(view, 'Mon, Nov 30')), /Skipped/);

  // Move…: a date input, then a confirm.
  btn(dateLi(view, 'Wed, Dec 2'), 'Move…').click();
  const moveForm = view.find(n => n.tag === 'form' && n.getAttribute('data-date') === 'move');
  const to = moveForm.find(n => n.id === 'sx-move-date');
  assert.equal(tab.doc.activeElement, to);
  assert.deepEqual([to.getAttribute('min'), to.getAttribute('max')], ['2026-10-14', '2026-12-18']);
  to.value = '2026-12-03';
  moveForm.dispatch('submit');
  box = dialog(view);
  assert.equal(words(box), 'Move Afternoon Study to Thu, Dec 3? It no longer meets Wed, Dec 2. 2 families are told now. Keep the date Move and tell families');
  assert.equal(tab.doc.activeElement, btn(box, 'Keep the date'));
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(dateRows(w.t, s).length, 3);
  moveForm.dispatch('submit');
  btn(dialog(view), 'Move and tell families').click();
  await tab.settle();
  assert.deepEqual(dateRows(w.t, s).slice(3).map(r => [r.date, r.kind, r.moved_from]), [['2026-12-02', 'skip', null], ['2026-12-03', 'add', '2026-12-02']]);

  // Undo the Thursday: both halves of the move go.
  btn(dateLi(view, 'Thu, Dec 3'), 'Undo').click();
  box = dialog(view);
  assert.equal(words(box), 'Undo the change on Thu, Dec 3? This also undoes Wed, Dec 2. 2 families are told now. Keep change Undo change');
  assert.equal(tab.doc.activeElement, btn(box, 'Keep change'));
  btn(box, 'Undo change').click();
  await tab.settle();
  assert.equal(dateRows(w.t, s).length, 3);

  // Add a date.
  btn(view, 'Add a date').click();
  const addForm = view.find(n => n.tag === 'form' && n.getAttribute('data-date') === 'add');
  addForm.find(n => n.id === 'sx-add-date').value = '2026-12-05';
  addForm.find(n => n.id === 'sx-add-reason').value = 'Exam prep';
  addForm.dispatch('submit');
  box = dialog(view);
  assert.equal(words(box), 'Add Sat, Dec 5 to Afternoon Study? 1pm – 4pm, the schedule\'s usual time. 2 families are told now. Don\'t add Add and tell families');
  btn(box, 'Add and tell families').click();
  await tab.settle();
  assert.deepEqual(dateRows(w.t, s).pop(), { date: '2026-12-05', kind: 'add', moved_from: null, reason: 'Exam prep', created_by: w.dirA.id });

  // Cancel this schedule: what ends counts the paused enrollment too.
  const kill = btn(view, 'Cancel this schedule');
  kill.focus();
  kill.click();
  box = dialog(view);
  assert.equal(words(box), 'Cancel Afternoon Study? This ends 2 enrollments and 1 waitlist spot, and those families are told. This can\'t be undone. Keep schedule Cancel schedule');
  assert.equal(tab.doc.activeElement, btn(box, 'Keep schedule'));
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(row(w.t, s.id).status, 'active');
  btn(view, 'Cancel this schedule').click();
  btn(dialog(view), 'Cancel schedule').click();
  await tab.settle();
  assert.equal(row(w.t, s.id).status, 'cancelled');
  view = await tab.open();
  assert.deepEqual(rows().map(b => b.find(n => n.tag === 'strong').textContent), ['Quiet Room TTh']);
});

test(['SC-3', 'NF-7'], 'Schedules screen: closures and periods ask first; the period form fills this or next month, and an overlap is refused with its reason', async () => {
  const w = await world(); // Wed 14 Oct 2026
  w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const tab = sessionsTab(w.t, w.dirA);
  let view = await tab.open();

  // A closure: today or later only (R3), and its confirm starts on the safe button too.
  btn(view, 'Add a closure').click();
  const date = view.find(n => n.getAttribute('id') === 'sx-cdate');
  assert.equal(date.getAttribute('min'), '2026-10-14');
  date.value = '2026-10-16';
  view.find(n => n.tag === 'form').dispatch('submit');
  let box = dialog(view);
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

  // Periods: "This month" and "Next month" fill the dates.
  assert.ok(btn(view, 'Edit period'));
  btn(view, 'Add a period').click();
  const form = view.find(n => n.getAttribute('data-panel') === 'term');
  const start = form.find(n => n.id === 'sx-tstart'), end = form.find(n => n.id === 'sx-tend');
  btn(form, 'This month').click();
  assert.deepEqual([start.value, end.value], ['2026-10-01', '2026-10-31']);
  btn(form, 'Next month').click();
  assert.deepEqual([start.value, end.value], ['2026-11-01', '2026-11-30']);
  form.find(n => n.id === 'sx-tname').value = 'November 2026';
  form.find(n => n.tag === 'form').dispatch('submit');
  await tab.settle();
  assert.match(words(tab.toasts), /Fall 2026 already covers Nov 1 - Nov 30\. Periods at one location can't overlap\./);
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM terms WHERE location_id = ?', w.a.id), 1);
  start.value = '2027-01-04';
  end.value = '2027-01-29';
  form.find(n => n.id === 'sx-tname').value = 'January 2027';
  form.find(n => n.tag === 'form').dispatch('submit');
  await tab.settle();
  assert.deepEqual(w.t.db.prepare('SELECT name, start_date, end_date FROM terms WHERE location_id = ? ORDER BY start_date').all(w.a.id).map(x => x.name), ['Fall 2026', 'January 2027']);

  // A schedule's panel belongs to its period: showing another period closes it.
  view = await tab.open();
  view.find(n => n.tag === 'button' && n.cls.includes('sx-slot')).click();
  assert.equal(view.find(n => n.getAttribute('data-panel')).getAttribute('data-panel'), 'session');
  const pick = view.find(n => n.id === 'sx-term');
  pick.value = String(w.t.db.prepare("SELECT id FROM terms WHERE name = 'January 2027'").get().id);
  pick.dispatch('change');
  assert.equal(view.find(n => n.getAttribute('data-panel')), undefined);
  assert.match(words(view), /No schedules in January 2027 yet/);
});

test(['SC-3', 'SC-4', 'SC-5'], 'Schedules screen: staff read only, the closure form is dismissed with Cancel, notices open a screen from the Inbox, and Home shows added dates (L35, L39)', async () => {
  const w = await world(); // Wed 14 Oct 2026
  const s = w.t.fx.session(w.a, { name: 'Afternoon Study', weekdays: '1,3,5' });
  const tth = w.t.fx.session(w.a, { name: 'Tue/Thu Study', weekdays: '2,4' });
  w.t.fx.sessionDate(tth, '2026-10-14', 'add');
  const fam = w.t.fx.family(w.a);
  w.t.fx.enroll(fam.student, s);

  // Staff see the list but no buttons to change it.
  const staffView = await sessionsTab(w.t, w.staffA).open();
  assert.equal(staffView.findAll(n => n.tag === 'button' && n.cls.includes('sx-slot')).length, 0);
  assert.equal(staffView.findAll(n => n.tag === 'div' && n.cls.includes('sx-slot')).length, 2);
  assert.equal(btn(staffView, '+ New schedule'), undefined);
  assert.equal(btn(staffView, 'Add a closure'), undefined);

  const tab = sessionsTab(w.t, w.dirA);
  const view = await tab.open();
  // L39: the closure form's dismiss button doesn't start with "Close" too.
  btn(view, 'Add a closure').click();
  const form = view.find(n => n.getAttribute('data-panel') === 'closure');
  assert.deepEqual(labels(form), ['Close this day', 'Cancel']);
  btn(form, 'Cancel').click();
  assert.equal(view.find(n => n.getAttribute('data-panel') === 'closure'), undefined);
  assert.equal(count(w.t, 'SELECT COUNT(*) AS n FROM closures'), 0);

  // Home: today's schedules, with the added date marked.
  const card = await tab.card('sessions-today');
  assert.match(words(card), /^Today's schedules All schedules Afternoon Study/);
  const items = card.findAll(n => n.tag === 'li').map(li => words(li).split(' 1:00')[0]);
  assert.deepEqual(items, ['Afternoon Study', 'Tue/Thu Study Added today']);

  // L35: a closure, a schedule change and a date change reach the family; all open the Schedule.
  assert.equal((await w.t.as(w.dirA).post('/api/sessions/closures', { date: MON })).status, 201);
  assert.equal((await w.t.as(w.dirA).put('/api/sessions/' + s.id, { name: 'Afternoon Study+' })).status, 200);
  assert.equal((await w.t.as(w.dirA).post(datesUrl(s), { action: 'move', date: '2026-11-30', to: '2026-12-01' })).status, 201);
  const hrefs = async user => {
    const box = await sessionsTab(w.t, user, ['public/js/views/enrollment.js']).inbox();
    return box.findAll(n => n.tag === 'li').map(li => {
      const a = li.find(n => n.tag === 'a');
      return [li.find(n => n.tag === 'strong').textContent, a ? a.getAttribute('href') : null];
    });
  };
  // A schedule notice opens the tab of the student holding that schedule; a closure is the whole center's.
  assert.deepEqual(await hrefs(fam.parent), [
    ['Afternoon Study+ moves from Mon, Nov 30 to Tue, Dec 1', '#/schedule/session/' + s.id],
    ['Afternoon Study at Irvine has changed', '#/schedule/session/' + s.id],
    ['Irvine is closed Mon, Nov 23', '#/schedule'],
  ]);
  // Staff open the Schedules screen instead.
  const ins = w.t.db.prepare('INSERT INTO notifications (user_id, kind, title, ref_type, ref_id, priority, created_at) VALUES (?,?,?,?,?,?,?)');
  ins.run(w.dirA.id, 'session_closure', 'Closure notice', 'closure', 1, 'normal', w.t.clock.now() - 1000);
  ins.run(w.dirA.id, 'session_changed', 'Session notice', 'session', s.id, 'normal', w.t.clock.now() - 2000);
  assert.deepEqual(await hrefs(w.dirA), [
    ['Closure notice', '#/sessions'],
    ['Session notice', '#/sessions'],
  ]);
});

// ---------------- SC-5: meeting dates (src/modules/sessions/dates.js, D-47) ----------------

const dates = () => load('src/modules/sessions/dates.js');
// A Mon/Wed/Fri schedule in the default Fall 2026 term (Mon Aug 17 - Fri Dec 18), read with its term dates,
// and a second Mon/Wed/Fri schedule at the same location.
async function schedules() {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  t.fx.term(loc);
  const withTerm = s => t.db.prepare(`SELECT s.*, t.start_date AS term_start, t.end_date AS term_end
    FROM sessions s JOIN terms t ON t.id = s.term_id WHERE s.id = ?`).get(s.id);
  return { t, loc, s: withTerm(t.fx.session(loc, { name: 'Mornings MWF' })), other: withTerm(t.fx.session(loc, { name: 'Afternoons MWF' })) };
}
// Mon Nov 23 moves to Tue Nov 24, and Sat Dec 5 is an extra date.
function moveAndAdd(t, s) {
  t.fx.sessionDate(s, '2026-11-23', 'skip', { reason: 'Staff training day' });
  t.fx.sessionDate(s, '2026-11-24', 'add', { moved_from: '2026-11-23', reason: 'Staff training day' });
  t.fx.sessionDate(s, '2026-12-05', 'add', { reason: 'Exam prep' });
}

test(['SC-5'], 'a schedule meets on its weekdays inside its term, and on no other date', async () => {
  const { t, s } = await schedules();
  const { overrides, meets } = dates();
  const ov = overrides(t.ctx);
  assert.equal(ov.size, 0);
  const on = d => meets(s, ov, d);
  assert.deepEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'].map(on),
    [false, true, false, true, false, true, false]); // Sun..Sat
  // The term's first and last days count; the days just outside don't.
  assert.deepEqual(['2026-08-14', '2026-08-17', '2026-12-18', '2026-12-21'].map(on), [false, true, true, false]);
  // Weekdays read the same from the row ('1,3,5') or a shaped session ([1, 3, 5]).
  assert.deepEqual(['2026-11-23', '2026-11-24'].map(d => meets(Object.assign({}, s, { weekdays: [1, 3, 5] }), ov, d)), [true, false]);
  // No overrides map at all means no date changes.
  assert.equal(meets(s, null, '2026-11-23'), true);
});

test(['SC-5'], 'a skipped date doesn\'t meet, an added date does, a move is both, and only for that schedule', async () => {
  const { t, s, other } = await schedules();
  moveAndAdd(t, s);
  const { overrides, meets } = dates();
  const ov = overrides(t.ctx);
  assert.equal(meets(s, ov, '2026-11-23'), false); // skipped (moved away)
  assert.equal(meets(s, ov, '2026-11-24'), true); // moved here
  assert.equal(meets(s, ov, '2026-12-05'), true); // added Saturday
  assert.equal(meets(s, ov, '2026-11-25'), true); // the rest of the week goes ahead
  // Another schedule at the location keeps its own calendar.
  assert.deepEqual(['2026-11-23', '2026-11-24', '2026-12-05'].map(d => meets(other, ov, d)), [true, false, false]);
  // A change outside the term is ignored: shortening the term to Nov 20 drops the move and the extra date.
  const shortened = Object.assign({}, s, { term_end: '2026-11-20' });
  assert.deepEqual(['2026-11-20', '2026-11-23', '2026-11-24', '2026-12-05'].map(d => meets(shortened, ov, d)), [true, false, false, false]);
  const late = Object.assign({}, s, { term_start: '2026-12-01' });
  assert.equal(meets(late, ov, '2026-11-24'), false);

  // overrides(): every change, per schedule and date, with its kind, moved_from and reason.
  assert.deepEqual([...ov.keys()], [s.id]);
  assert.deepEqual(Object.fromEntries(ov.get(s.id)), {
    '2026-11-23': { kind: 'skip', moved_from: null, reason: 'Staff training day' },
    '2026-11-24': { kind: 'add', moved_from: '2026-11-23', reason: 'Staff training day' },
    '2026-12-05': { kind: 'add', moved_from: null, reason: 'Exam prep' },
  });
  // Limited to some schedules.
  assert.deepEqual([...overrides(t.ctx, [s.id]).keys()], [s.id]);
  assert.equal(overrides(t.ctx, [other.id]).size, 0);
  assert.equal(overrides(t.ctx, []).size, 0);
  t.fx.sessionDate(other, '2026-11-30', 'skip');
  assert.deepEqual([...overrides(t.ctx, [other.id]).keys()], [other.id]);
  assert.deepEqual([...overrides(t.ctx).keys()].sort(), [s.id, other.id].sort());
});

test(['SC-5'], 'datesOf lists a schedule\'s meeting dates in a range, oldest first, inside its term', async () => {
  const { t, s, other } = await schedules();
  moveAndAdd(t, s);
  const { overrides, datesOf } = dates();
  const ov = overrides(t.ctx);
  assert.deepEqual(datesOf(s, ov, '2026-11-16', '2026-11-29'),
    ['2026-11-16', '2026-11-18', '2026-11-20', '2026-11-24', '2026-11-25', '2026-11-27']);
  assert.deepEqual(datesOf(other, ov, '2026-11-16', '2026-11-29'),
    ['2026-11-16', '2026-11-18', '2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27']);
  // Both ends of the range are included.
  assert.deepEqual(datesOf(s, ov, '2026-11-18', '2026-11-20'), ['2026-11-18', '2026-11-20']);
  assert.deepEqual(datesOf(s, ov, '2026-12-05', '2026-12-05'), ['2026-12-05']);
  // Only dates inside the term.
  assert.deepEqual(datesOf(s, ov, '2026-12-14', '2027-01-10'), ['2026-12-14', '2026-12-16', '2026-12-18']);
  assert.deepEqual(datesOf(s, ov, '2026-08-10', '2026-08-19'), ['2026-08-17', '2026-08-19']);
  assert.deepEqual(datesOf(s, ov, '2026-11-21', '2026-11-22'), []); // a weekend
  assert.deepEqual(datesOf(s, ov, '2026-11-25', '2026-11-18'), []); // from after to
  // The whole term: 18 weeks of Mon/Wed/Fri, less the moved Monday, plus its Tuesday and the extra Saturday.
  const all = datesOf(s, ov, s.term_start, s.term_end);
  assert.equal(all.length, 18 * 3 - 1 + 2);
  assert.deepEqual(all, [...all].sort());
});

test(['SC-5'], 'a whole-schedule enrollment counts on every meeting date; a v1 weekday row only on its weekday', async () => {
  const { t, loc, s } = await schedules();
  moveAndAdd(t, s);
  const { overrides, datesOf, counts } = dates();
  const ov = overrides(t.ctx);
  const week = datesOf(s, ov, '2026-11-16', '2026-11-29');
  const whole = t.fx.enroll(t.fx.family(loc).student, s);
  const v1Mon = t.fx.enroll(t.fx.family(loc).student, s, 1);
  const v1Wed = t.fx.enroll(t.fx.family(loc).student, s, 3, { status: 'dropped' });
  const waiting = t.fx.waitlist(t.fx.family(loc).student, s);
  assert.deepEqual(week.filter(d => counts(whole, d)), week); // the moved-to Tuesday included
  assert.deepEqual(week.filter(d => counts(waiting, d)), week);
  // The v1 Monday row: Nov 16 only. Nov 23 moved away, and the Tuesday it moved to isn't a Monday.
  assert.deepEqual(week.filter(d => counts(v1Mon, d)), ['2026-11-16']);
  assert.deepEqual(week.filter(d => counts(v1Wed, d)), ['2026-11-18', '2026-11-25']);
});

test(['SC-5'], 'days a week is the schedule\'s weekday count, whatever its date changes', async () => {
  const { t, s } = await schedules();
  moveAndAdd(t, s);
  const { daysPerWeek } = dates();
  assert.equal(daysPerWeek(s), 3);
  assert.equal(daysPerWeek({ weekdays: '2,4' }), 2);
  assert.equal(daysPerWeek({ weekdays: '6' }), 1);
  assert.equal(daysPerWeek({ weekdays: [1, 2, 3, 4, 5] }), 5);
});
