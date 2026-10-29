'use strict';
// Membership: records (MB-1), staff edits with an audit trail and no payment
// data (MB-2, NF-2, D-22), family read access (MB-3), expiry reminders (MB-4),
// pausing and restoring whole schedules (MB-5, D-16, D-16a), the weekly limit in days a
// week (D-27, D-43), and scope on every route (NF-1). Enrollments are whole-schedule rows
// (weekday 0, D-42) unless a test says it is a v1 per-day row.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, at, ROOT } = require('./lib');

const LA = 'America/Los_Angeles', TOR = 'America/Toronto';

// A full membership body; override what a test cares about.
const body = (o = {}) => Object.assign({ status: 'active', weekly_cap: 3, start_date: '2026-08-17', expires_on: '2027-06-30' }, o);
const url = s => `/api/membership/student/${s.id}`;
const row = (t, s) => t.db.prepare('SELECT * FROM memberships WHERE student_id = ?').get(s.id);
const enr = (t, e) => t.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e.id);
const kinds = (t, u, kind) => t.fx.notifications(u, kind);

// A parent and a named student, linked, with a membership (unless membership: false).
function fam(t, loc, { name = 'Leo Garcia', membership = {} } = {}) {
  const parent = t.fx.user('parent', { location: loc });
  const student = t.fx.user('student', { location: loc, name });
  t.fx.link(parent, student);
  if (membership) t.fx.membership(student, membership);
  return { parent, student };
}
// A whole-schedule waiting spot (weekday 0), and a schedule's line in order.
function wait(t, student, session, { priority = 0, created_at = t.clock.now() } = {}) {
  const id = Number(t.db.prepare("INSERT INTO waitlist (student_id, session_id, weekday, status, priority, created_at) VALUES (?,?,0,'waiting',?,?)")
    .run(student.id, session.id, priority, created_at).lastInsertRowid);
  return t.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
}
const line = (t, session) => t.db.prepare(`SELECT * FROM waitlist WHERE session_id = ? AND status = 'waiting'
  ORDER BY priority DESC, created_at ASC, id ASC`).all(session.id);
// Periods next to the fixtures' Fall 2026 (Aug 17 - Dec 18). None overlaps another.
const spring27 = { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' };
const summer27 = { name: 'Summer 2027', start: '2027-06-14', end: '2027-08-13' };
const summer26 = { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' }; // over by Oct 14

// ---------------- MB-1 / MB-2 / NF-2: staff keep the record ----------------

test(['MB-1', 'MB-2', 'NF-2'], 'staff at the student\'s location create a membership, and the change is logged with before and after', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = fam(t, loc, { membership: false });
  const staff = t.fx.staff(loc);
  const r = await t.as(staff).put(url(student), body({ weekly_cap: 4, expires_on: '2027-01-31' }));
  assert.equal(r.status, 200);
  const m = row(t, student);
  assert.deepEqual(r.body.membership, { id: m.id, status: 'active', weekly_cap: 4, start_date: '2026-08-17', expires_on: '2027-01-31',
    days_left: 109, state: 'active', renewal_needed: false });
  assert.equal(m.status, 'active');
  assert.equal(m.weekly_cap, 4);
  assert.equal(m.start_date, '2026-08-17');
  assert.equal(m.expires_on, '2027-01-31');
  assert.equal(m.updated_by, staff.id);
  assert.equal(m.updated_at, t.clock.now());
  const log = t.fx.audit('membership.create');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, staff.id);
  assert.equal(log[0].target_type, 'membership');
  assert.equal(log[0].target_id, m.id);
  assert.equal(log[0].location_id, loc.id);
  assert.deepEqual(JSON.parse(log[0].detail), { student_id: student.id, before: null,
    after: { status: 'active', weekly_cap: 4, start_date: '2026-08-17', expires_on: '2027-01-31' } });
});

test(['MB-2', 'NF-2'], 'directors and HQ update a membership; each change is logged with the old and new values and shows in the history', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = fam(t, loc, { membership: { cap: 3, start: '2026-08-01', expires: '2027-06-30' } });
  const dir = t.fx.director(loc), staff = t.fx.staff(loc), hq = t.fx.hq({ name: 'Morgan Lee' });
  const r = await t.as(dir).put(url(student), body({ weekly_cap: 4, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  let log = t.fx.audit('membership.update');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, dir.id);
  assert.deepEqual(JSON.parse(log[0].detail), { student_id: student.id,
    before: { status: 'active', weekly_cap: 3, start_date: '2026-08-01', expires_on: '2027-06-30' },
    after: { status: 'active', weekly_cap: 4, start_date: '2026-08-01', expires_on: '2027-08-31' } });

  // Saving the same values again is not a change and is not logged.
  const same = await t.as(dir).put(url(student), body({ weekly_cap: 4, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  assert.equal(same.status, 200);
  assert.equal(same.body.changed, false);
  assert.equal(t.fx.audit('membership.update').length, 1);

  const h = await t.as(hq).put(url(student), body({ weekly_cap: 2, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  assert.equal(h.status, 200);
  assert.equal(row(t, student).weekly_cap, 2);
  assert.equal(row(t, student).updated_by, hq.id);
  log = t.fx.audit('membership.update');
  assert.equal(log.length, 2);
  assert.equal(log[1].actor_id, hq.id);

  const g = await t.as(staff).get(url(student));
  assert.equal(g.status, 200);
  assert.equal(g.body.history.length, 2);
  assert.equal(g.body.history[0].actor, 'Morgan Lee');
  assert.equal(g.body.history[0].before.weekly_cap, 4);
  assert.equal(g.body.history[0].after.weekly_cap, 2);
  assert.equal(g.body.history[1].actor, dir.name);
});

test('MB-1', 'a membership needs a valid status, a whole-number weekly limit and a last day on or after the start', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const before = row(t, student);
  const cases = [
    [{ status: 'paused' }, 'status'],
    [{ status: undefined }, 'status'],
    [{ weekly_cap: 0 }, 'weekly_cap'],
    [{ weekly_cap: 15 }, 'weekly_cap'],
    [{ weekly_cap: 2.5 }, 'weekly_cap'],
    [{ weekly_cap: 'three' }, 'weekly_cap'],
    [{ start_date: '2026-13-01' }, 'start_date'],
    [{ expires_on: '' }, 'expires_on'],
    [{ expires_on: '2026-08-16' }, 'expires_on'],
    // Not real dates, though each sorts after the start date as text.
    [{ expires_on: '2027-02-30' }, 'expires_on'],
    [{ expires_on: 'never' }, 'expires_on'],
    [{ expires_on: '2027-6-30' }, 'expires_on'],
  ];
  for (const [o, code] of cases) {
    const r = await t.as(staff).put(url(student), body(o));
    assert.equal(r.status, 400, JSON.stringify(o));
    assert.equal(r.body.error, code, JSON.stringify(o));
  }
  assert.deepEqual(row(t, student), before);
  assert.equal(t.fx.audit().length, 0);
  // Edges that are fine: a one-day membership, and the top weekly limit.
  const ok = await t.as(staff).put(url(student), body({ weekly_cap: 14, start_date: '2026-10-14', expires_on: '2026-10-14' }));
  assert.equal(ok.status, 200);
  assert.equal(row(t, student).weekly_cap, 14);
  assert.equal(row(t, student).expires_on, '2026-10-14');
});

test('MB-2', 'payment details are refused and never stored anywhere (D-22)', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const before = row(t, student);
  for (const extra of [{ card_number: '4242424242424242' }, { payment: { card: '4242424242424242', cvc: '123' } }, { amount_paid: 4242 }]) {
    const r = await t.as(staff).put(url(student), Object.assign(body({ weekly_cap: 4 }), extra));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'unknown_field');
    assert.match(r.body.message, /Payment details stay in your billing system/);
  }
  assert.deepEqual(row(t, student), before);
  const everything = ['memberships', 'audit_log', 'notifications', 'membership_notices']
    .map(tb => JSON.stringify(t.db.prepare(`SELECT * FROM ${tb}`).all())).join('');
  assert.ok(!everything.includes('4242'));
  assert.equal(t.fx.audit().length, 0);
});

test(['NF-1', 'MB-2'], 'only staff at the student\'s location (or HQ) can change a membership', async () => {
  const t = await makeApp();
  const a = t.fx.location(), b = t.fx.location();
  const fa = fam(t, a), fb = fam(t, b);
  const staffA = t.fx.staff(a), staffB = t.fx.staff(b), dirB = t.fx.director(b), hq = t.fx.hq();
  const before = row(t, fa.student);
  for (const u of [fa.parent, fa.student, fb.parent, fb.student, staffB, dirB]) {
    const r = await t.as(u).put(url(fa.student), body({ weekly_cap: 5 }));
    assert.equal(r.status, 403, u.role);
  }
  assert.equal((await t.anon.put(url(fa.student), body({ weekly_cap: 5 }))).status, 401);
  assert.deepEqual(row(t, fa.student), before);
  assert.equal(t.fx.audit().length, 0);

  assert.equal((await t.as(staffA).put(url(fa.student), body({ weekly_cap: 5 }))).status, 200);
  assert.equal(row(t, fa.student).weekly_cap, 5);
  assert.equal((await t.as(hq).put(url(fa.student), body({ weekly_cap: 6 }))).status, 200);
  assert.equal(row(t, fa.student).weekly_cap, 6);
  assert.equal((await t.as(hq).put(url(staffA), body())).status, 404);
  assert.equal((await t.as(hq).put('/api/membership/student/99999', body())).status, 404);
  assert.equal((await t.as(staffA).put('/api/membership/student/99999', body())).status, 403);
});

test('MB-1', 'a weekly limit sent as an object, a list or anything but a number or digits is refused, never a server error (L56)', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const before = row(t, student);
  // {toString: 1} made String() throw (a 500); [3] read as "3" and was saved.
  for (const weekly_cap of [{ toString: 1 }, { valueOf: 3 }, [3], ['3'], true, null]) {
    const r = await t.as(staff).put(url(student), body({ weekly_cap }));
    assert.equal(r.status, 400, JSON.stringify(weekly_cap));
    assert.equal(r.body.error, 'weekly_cap', JSON.stringify(weekly_cap));
  }
  assert.deepEqual(row(t, student), before);
  assert.equal(t.fx.audit().length, 0);
  // A number and a string of digits both still work.
  assert.equal((await t.as(staff).put(url(student), body({ weekly_cap: '5' }))).status, 200);
  assert.equal(row(t, student).weekly_cap, 5);
});

test(['NF-1', 'MB-2'], 'a retired student account (a cancelled invite) can\'t be given or changed a membership, even by id (L65)', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc), hq = t.fx.hq();
  const retired = t.fx.user('student', { location: loc, name: 'Retired Kid', active: 0 });
  for (const u of [staff, hq]) {
    const r = await t.as(u).put(url(retired), body());
    assert.equal(r.status, 404, u.role);
    assert.equal(r.body.message, 'No such student.');
  }
  assert.equal(row(t, retired), undefined);
  // One retired after it got a membership: the record stays as it was.
  const { student } = fam(t, loc);
  t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(student.id);
  const before = row(t, student);
  assert.equal((await t.as(staff).put(url(student), body({ weekly_cap: 5 }))).status, 404);
  assert.deepEqual(row(t, student), before);
  assert.equal(t.fx.audit().length, 0);
});

// ---------------- MB-3: families can see it ----------------

test('MB-3', 'parents see status, weekly limit and dates for each linked student; students see their own', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const { parent, student: leo } = fam(t, loc, { name: 'Leo Garcia', membership: { cap: 4, start: '2026-08-01', expires: '2027-06-30' } });
  const sofia = t.fx.user('student', { location: loc, name: 'Sofia Garcia' });
  t.fx.link(parent, sofia);
  t.fx.membership(sofia, { status: 'inactive', cap: 3, start: '2026-08-01', expires: '2026-09-30' });
  const pending = t.fx.user('student', { location: loc, name: 'Ava Garcia' });
  t.fx.link(parent, pending, 'pending');
  t.fx.membership(pending);
  fam(t, loc, { name: 'Other Kid' });

  const r = await t.as(parent).get('/api/membership/mine');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.members.map(m => m.student.name), ['Leo Garcia', 'Sofia Garcia']);
  const [l, s] = r.body.members;
  assert.equal(l.location.name, 'Irvine');
  assert.equal(l.location.timezone, LA);
  assert.deepEqual(l.membership, { id: row(t, leo).id, status: 'active', weekly_cap: 4, start_date: '2026-08-01', expires_on: '2027-06-30',
    days_left: 259, state: 'active', renewal_needed: false });
  assert.equal(s.membership.status, 'inactive');
  assert.equal(s.membership.weekly_cap, 3);
  assert.equal(s.membership.expires_on, '2026-09-30');
  assert.equal(s.membership.state, 'inactive');
  assert.equal(s.membership.renewal_needed, true);

  const me = await t.as(leo).get('/api/membership/mine');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.members.map(m => m.student.id), [leo.id]);
  assert.equal(me.body.members[0].membership.weekly_cap, 4);

  for (const u of [parent, leo]) {
    const one = await t.as(u).get(url(leo));
    assert.equal(one.status, 200);
    assert.equal(one.body.membership.status, 'active');
    assert.equal(one.body.membership.weekly_cap, 4);
    assert.equal(one.body.membership.expires_on, '2027-06-30');
    assert.equal('history' in one.body, false); // the staff change log is not for families
  }
});

test(['NF-1', 'NF-2'], 'reading one student\'s membership: other families, other locations\' staff and strangers are refused', async () => {
  const t = await makeApp();
  const a = t.fx.location(), b = t.fx.location();
  const fa = fam(t, a), fa2 = fam(t, a, { name: 'Ana Ruiz' }), fb = fam(t, b);
  const staffA = t.fx.staff(a), staffB = t.fx.staff(b), dirB = t.fx.director(b), hq = t.fx.hq();
  for (const u of [fa2.parent, fa2.student, fb.parent, staffB, dirB]) {
    const r = await t.as(u).get(url(fa.student));
    assert.equal(r.status, 403, u.role);
    assert.equal(r.body.membership, undefined);
  }
  assert.equal((await t.anon.get(url(fa.student))).status, 401);
  for (const u of [staffA, hq]) {
    const r = await t.as(u).get(url(fa.student));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.history));
  }
});

test('NF-1', 'the family membership list is for parents and students only, and holds only their own', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const f1 = fam(t, loc), f2 = fam(t, loc, { name: 'Ana Ruiz' });
  for (const u of [t.fx.staff(loc), t.fx.director(loc), t.fx.hq()]) assert.equal((await t.as(u).get('/api/membership/mine')).status, 403);
  assert.equal((await t.anon.get('/api/membership/mine')).status, 401);
  const r = await t.as(f2.parent).get('/api/membership/mine');
  assert.deepEqual(r.body.members.map(m => m.student.id), [f2.student.id]);
  const s = await t.as(f1.student).get('/api/membership/mine');
  assert.deepEqual(s.body.members.map(m => m.student.id), [f1.student.id]);
});

test('NF-1', 'the Members roster shows staff only their own location; HQ picks any; families are refused', async () => {
  const t = await makeApp();
  const a = t.fx.location({ name: 'Irvine' }), b = t.fx.location({ name: 'Arcadia' });
  const fa = fam(t, a), fa2 = fam(t, a, { name: 'Ana Ruiz' }), fb = fam(t, b, { name: 'Noah Roy' });
  const staffA = t.fx.staff(a), dirA = t.fx.director(a), hq = t.fx.hq();
  const own = await t.as(staffA).get('/api/membership/roster');
  assert.equal(own.status, 200);
  assert.equal(own.body.location.id, a.id);
  assert.deepEqual(own.body.students.map(s => s.id), [fa2.student.id, fa.student.id]);
  assert.equal((await t.as(staffA).get('/api/membership/roster?location_id=' + a.id)).status, 200);
  for (const u of [staffA, dirA]) {
    const r = await t.as(u).get('/api/membership/roster?location_id=' + b.id);
    assert.equal(r.status, 403);
    assert.equal(r.body.students, undefined);
  }
  for (const u of [fa.parent, fa.student]) assert.equal((await t.as(u).get('/api/membership/roster')).status, 403);
  assert.equal((await t.anon.get('/api/membership/roster')).status, 401);
  const h = await t.as(hq).get('/api/membership/roster?location_id=' + b.id);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.students.map(s => s.id), [fb.student.id]);
  assert.equal((await t.as(hq).get('/api/membership/roster')).status, 400);
  assert.equal((await t.as(hq).get('/api/membership/roster?location_id=99999')).status, 404);
});
test('MB-1', 'the roster gives each student\'s state on the location\'s date: active, ending soon, expired, inactive or none', async () => {
  const t = await makeApp(); // Wed 2026-10-14 in Los Angeles
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const mk = (name, membership) => fam(t, loc, { name, membership }).student;
  const s15 = mk('A Fifteen', { expires: '2026-10-29' });
  mk('B Fourteen', { expires: '2026-10-28' });
  mk('C Today', { expires: '2026-10-14' });
  mk('D Yesterday', { expires: '2026-10-13' });
  mk('E Inactive', { status: 'inactive', expires: '2027-06-30' });
  mk('F None', false);
  const gone = mk('G Left', {});
  t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone.id);
  const unapproved = t.fx.user('student', { location: loc, name: 'H Pending' });
  t.fx.link(t.fx.user('parent', { location: loc }), unapproved, 'pending');
  const p2 = t.fx.user('parent', { location: loc, name: 'Aaron Garcia' });
  t.fx.link(p2, s15);
  // A Fifteen holds Mornings MWF this fall, has Spring Study TTh paused, and dropped another schedule.
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27);
  t.fx.enroll(s15, t.fx.session(loc, { term: fall, name: 'Mornings MWF', weekdays: '1,3,5' }));
  t.fx.enroll(s15, t.fx.session(loc, { term: spring, name: 'Spring Study TTh', weekdays: '2,4' }), 0, { status: 'paused' });
  t.fx.enroll(s15, t.fx.session(loc, { term: fall, name: 'Quiet Room', weekdays: '2,4' }), 0, { status: 'dropped' });

  const r = await t.as(staff).get('/api/membership/roster');
  assert.equal(r.status, 200);
  assert.equal(r.body.today, '2026-10-14');
  const by = Object.fromEntries(r.body.students.map(s => [s.name, s]));
  assert.deepEqual(Object.keys(by), ['A Fifteen', 'B Fourteen', 'C Today', 'D Yesterday', 'E Inactive', 'F None', 'H Pending']);
  assert.deepEqual([by['A Fifteen'].membership.state, by['A Fifteen'].membership.days_left], ['active', 15]);
  assert.deepEqual([by['B Fourteen'].membership.state, by['B Fourteen'].membership.days_left], ['ending', 14]);
  assert.deepEqual([by['C Today'].membership.state, by['C Today'].membership.days_left], ['ending', 0]);
  assert.deepEqual([by['D Yesterday'].membership.state, by['D Yesterday'].membership.days_left], ['expired', -1]);
  assert.equal(by['E Inactive'].membership.state, 'inactive');
  assert.equal(by['A Fifteen'].membership.renewal_needed, false);
  for (const n of ['B Fourteen', 'C Today', 'D Yesterday', 'E Inactive']) assert.equal(by[n].membership.renewal_needed, true, n);
  assert.equal(by['F None'].membership, null);
  assert.equal(by['H Pending'].linked, false);
  assert.equal(by['A Fifteen'].linked, true);
  assert.equal(by['A Fifteen'].parents.length, 2);
  assert.equal(by['A Fifteen'].parents[0], 'Aaron Garcia');
  const a = by['A Fifteen'];
  assert.deepEqual([a.active_schedules, a.paused_schedules, a.held_days], [1, 1, 3]);
  assert.deepEqual(a.schedules.map(s => [s.name, s.weekdays, s.days_per_week, s.status, s.term_name]),
    [['Mornings MWF', '1,3,5', 3, 'active', 'Fall 2026'], ['Spring Study TTh', '2,4', 2, 'paused', 'Spring 2027']]);
  assert.equal('active_slots' in a, false);
  assert.deepEqual([by['B Fourteen'].active_schedules, by['B Fourteen'].paused_schedules, by['B Fourteen'].held_days, by['B Fourteen'].schedules],
    [0, 0, 0, []]);
});

// ---------------- MB-4: reminders ----------------

test('MB-4', 'parents get one reminder 14 days and one 3 days before the last day, never twice', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-13', '06:00') });
  const loc = t.fx.location({ name: 'Irvine' });
  const { parent, student } = fam(t, loc, { membership: { expires: '2026-10-28' } });
  const p2 = t.fx.user('parent', { location: loc });
  t.fx.link(p2, student);
  const reminders = u => kinds(t, u, 'membership_reminder');

  t.jobs(); // 15 days out
  assert.equal(reminders(parent).length, 0);

  t.clock.set(at(LA, '2026-10-14', '06:00')); // 14 days out
  t.jobs(); t.jobs();
  for (const p of [parent, p2]) {
    const r = reminders(p);
    assert.equal(r.length, 1);
    assert.equal(r[0].title, "Leo's membership ends Wed, Oct 28, 2026");
    assert.match(r[0].body, /in 14 days/);
    assert.equal(r[0].body, "That's in 14 days. Renew with the front desk at Irvine to keep Leo's schedule.");
  }

  for (const d of ['2026-10-15', '2026-10-24']) { t.clock.set(at(LA, d, '06:00')); t.jobs(); }
  assert.equal(reminders(parent).length, 1);

  t.clock.set(at(LA, '2026-10-25', '06:00')); // 3 days out
  t.jobs(); t.jobs();
  t.clock.set(at(LA, '2026-10-26', '06:00'));
  t.jobs();
  for (const p of [parent, p2]) {
    const r = reminders(p);
    assert.equal(r.length, 2);
    assert.match(r[1].body, /in 3 days/);
  }
  assert.equal(reminders(student).length, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM membership_notices WHERE student_id = ?').get(student.id).n, 2);
});

test(['MB-4'], 'reminder days count on each location\'s own date', async () => {
  // 21:30 in Los Angeles is already 00:30 the next day in Toronto.
  const t = await makeApp({ now: at(LA, '2026-10-14', '21:30') });
  const la = t.fx.location({ timezone: LA }), tor = t.fx.location({ timezone: TOR });
  const fl = fam(t, la, { membership: { expires: '2026-10-29' } });
  const ft = fam(t, tor, { name: 'Noah Roy', membership: { expires: '2026-10-29' } });
  t.jobs();
  assert.equal(kinds(t, ft.parent, 'membership_reminder').length, 1); // Toronto: Oct 15, 14 days out
  assert.equal(kinds(t, fl.parent, 'membership_reminder').length, 0); // Los Angeles: Oct 14, 15 days out
});

test('MB-4', 'inactive memberships get no reminders, and a renewal starts a fresh set for the new last day', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const off = fam(t, loc, { name: 'Ana Ruiz', membership: { status: 'inactive', expires: '2026-10-28' } });
  const on = fam(t, loc, { membership: { expires: '2026-10-28' } });
  t.jobs();
  assert.equal(kinds(t, off.parent, 'membership_reminder').length, 0);
  assert.equal(kinds(t, on.parent, 'membership_reminder').length, 1);

  const staff = t.fx.staff(loc);
  assert.equal((await t.as(staff).put(url(on.student), body({ start_date: '2026-08-01', expires_on: '2026-11-11' }))).status, 200);
  t.clock.set(at(LA, '2026-10-28', '06:00')); // 14 days before the new last day
  t.jobs();
  const r = kinds(t, on.parent, 'membership_reminder');
  assert.equal(r.length, 2);
  assert.equal(r[1].title, "Leo's membership ends Wed, Nov 11, 2026");
});

// ---------------- MB-5 / D-16 / D-16a: pause and restore whole schedules ----------------

test('MB-5', 'once the location\'s date passes the last day, held schedules are paused (not deleted) and the family is told once', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '23:30') });
  const loc = t.fx.location();
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27);
  const { parent, student } = fam(t, loc, { membership: { expires: '2026-10-14' } });
  const sess = t.fx.session(loc, { term: fall }), quiet = t.fx.session(loc, { term: fall, name: 'Quiet Room', weekdays: '2,4', capacity: 1 });
  const later = t.fx.session(loc, { term: spring, name: 'Spring Study', weekdays: '1,3' });
  const e = t.fx.enroll(student, sess), es = t.fx.enroll(student, later); // Fall and Spring don't overlap, so both are held
  const old = t.fx.enroll(student, quiet, 0, { status: 'dropped' });
  const w = wait(t, student, quiet);
  const other = fam(t, loc, { name: 'Ana Ruiz' });
  const eo = t.fx.enroll(other.student, sess);
  t.fx.enroll(other.student, quiet); // Quiet Room is full, so no other job can move Leo off its waitlist

  t.jobs(); // still the last valid day
  assert.equal(enr(t, e).status, 'active');
  assert.equal(kinds(t, parent, 'membership_expired').length, 0);

  t.clock.set(at(LA, '2026-10-15', '00:05'));
  t.jobs(); t.jobs();
  assert.deepEqual([enr(t, e).status, enr(t, es).status], ['paused', 'paused']);
  assert.deepEqual([enr(t, e).ended_at, enr(t, es).ended_at], [null, null]);
  assert.equal(enr(t, old).status, 'dropped');
  assert.equal(enr(t, eo).status, 'active');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ?').get(student.id).n, 3);
  assert.equal(t.db.prepare('SELECT status FROM waitlist WHERE id = ?').get(w.id).status, 'waiting');
  assert.equal(row(t, student).status, 'active'); // the record itself is untouched; it is just past its last day
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_expired');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's membership has ended");
    assert.equal(n[0].body, "It ended on Wed, Oct 14, 2026. Afternoon Study and Spring Study are paused and saved until it's renewed with the front desk at " + loc.name + '.');
  }
  assert.equal(kinds(t, other.parent, 'membership_expired').length, 0);
});

test('MB-5', 'expiry pauses on each location\'s own date', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '22:30') }); // Toronto: Oct 15, 01:30
  const la = t.fx.location({ timezone: LA }), tor = t.fx.location({ timezone: TOR });
  const fl = fam(t, la, { membership: { expires: '2026-10-14' } });
  const ft = fam(t, tor, { name: 'Noah Roy', membership: { expires: '2026-10-14' } });
  const el = t.fx.enroll(fl.student, t.fx.session(la)), et = t.fx.enroll(ft.student, t.fx.session(tor));
  t.jobs();
  assert.equal(enr(t, et).status, 'paused');
  assert.equal(enr(t, el).status, 'active');
});

test(['MB-5', 'MB-2'], 'staff setting a membership inactive pauses the schedule right away, keeps waitlist places, and tells the family', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { parent, student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc), quiet = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', capacity: 1 });
  const e = t.fx.enroll(student, sess);
  const w = wait(t, student, quiet);

  const r = await t.as(staff).put(url(student), body({ status: 'inactive' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.paused, 1);
  assert.equal(r.body.membership.state, 'inactive');
  assert.deepEqual([r.body.active_schedules, r.body.paused_schedules, r.body.held_days], [0, 1, 0]);
  assert.equal(enr(t, e).status, 'paused');
  assert.equal(t.db.prepare('SELECT status FROM waitlist WHERE id = ?').get(w.id).status, 'waiting');
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_paused');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's schedule is paused");
    assert.equal(n[0].body, "Leo's membership isn't active right now, so Afternoon Study is on hold. It is saved and comes back when the membership is renewed with the front desk.");
  }
  // Another save while still inactive has nothing new to pause and sends nothing.
  const again = await t.as(staff).put(url(student), body({ status: 'inactive', weekly_cap: 4 }));
  assert.equal(again.body.paused, 0);
  assert.equal(kinds(t, parent, 'membership_paused').length, 1);
});

test('MB-5', 'pausing names each schedule once, and a v1 per-day enrollment (any weekday) is paused with the rest', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { parent, student } = fam(t, loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27);
  const v1 = t.fx.session(loc, { term: fall, name: 'Afternoons MWF' }), sp = t.fx.session(loc, { term: spring, name: 'Spring Study', weekdays: '2,4' });
  const rows = [t.fx.enroll(student, v1, 1), t.fx.enroll(student, v1, 3), t.fx.enroll(student, sp)];
  const r = await t.as(t.fx.staff(loc)).put(url(student), body({ status: 'inactive' }));
  assert.equal(r.body.paused, 2);
  assert.deepEqual(rows.map(e => enr(t, e).status), ['paused', 'paused', 'paused']);
  assert.deepEqual([r.body.paused_schedules, r.body.schedules.map(s => s.name)], [2, ['Afternoons MWF', 'Spring Study']]);
  const n = kinds(t, parent, 'membership_paused');
  assert.equal(n[0].title, "Leo's schedules are paused");
  assert.equal(n[0].body, "Leo's membership isn't active right now, so Afternoons MWF and Spring Study are on hold. They are saved and come back when the membership is renewed with the front desk.");
});

test('MB-5', 'a last day set in the past pauses at once; a last day of today keeps the schedule running', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc);
  const past = fam(t, loc), today = fam(t, loc, { name: 'Ana Ruiz' });
  const ep = t.fx.enroll(past.student, sess), et = t.fx.enroll(today.student, sess);
  const r = await t.as(staff).put(url(past.student), body({ expires_on: '2026-10-13' }));
  assert.equal(r.body.membership.state, 'expired');
  assert.equal(enr(t, ep).status, 'paused');
  const k = await t.as(staff).put(url(today.student), body({ expires_on: '2026-10-14' }));
  assert.equal(k.body.membership.state, 'ending');
  assert.equal(enr(t, et).status, 'active');
  assert.equal(kinds(t, today.parent, 'membership_paused').length, 0);
});

test(['MB-5', 'MB-4'], 'a last day set in the past sends the family one notice, saying the schedule is on hold; the daily job adds no second one (L57)', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc);
  const held = fam(t, loc), none = fam(t, loc, { name: 'Ana Ruiz' });
  const e = t.fx.enroll(held.student, sess);
  assert.equal((await t.as(staff).put(url(held.student), body({ expires_on: '2026-10-13' }))).body.paused, 1);
  t.jobs(); t.jobs();
  assert.equal(enr(t, e).status, 'paused');
  for (const u of [held.parent, held.student]) {
    const n = kinds(t, u, 'membership_paused');
    assert.equal(n.length, 1);
    assert.match(n[0].body, /Afternoon Study is on hold\. It is saved/);
    assert.equal(kinds(t, u, 'membership_expired').length, 0, 'no second notice that leaves out the paused schedule');
  }
  // With nothing to pause the save sends nothing, so the daily job's notice is the one the family gets.
  await t.as(staff).put(url(none.student), body({ expires_on: '2026-10-13' }));
  t.jobs(); t.jobs();
  assert.equal(kinds(t, none.parent, 'membership_paused').length, 0);
  const ended = kinds(t, none.parent, 'membership_expired');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].body, `It ended on Tue, Oct 13, 2026. Renew with the front desk at ${loc.name} to enroll in a schedule again.`);
});

test(['MB-5', 'NF-2'], 'reactivating restores a schedule with a free seat; a full one puts the student at the front of its waitlist', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27), summer = t.fx.term(loc, summer27);
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive' } });
  const pm = t.fx.session(loc, { term: fall, name: 'Afternoon Study', weekdays: '1,3,5', start: '13:00', capacity: 2 });
  const quiet = t.fx.session(loc, { term: spring, name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  const lab = t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '2', capacity: 1 });
  const ePm = t.fx.enroll(student, pm, 0, { status: 'paused' });
  const eQuiet = t.fx.enroll(student, quiet, 0, { status: 'paused' });
  const eLab = t.fx.enroll(student, lab, 0, { status: 'paused' });
  // Afternoon Study has one seat left: a live v1 per-day row doesn't take a seat (only whole-schedule rows count).
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, pm);
  t.fx.enroll(fam(t, loc, { name: 'Eve Tran' }).student, pm, 1);
  // Quiet Room and Summer Lab filled up while Leo was paused.
  t.fx.enroll(fam(t, loc, { name: 'Ben Ito' }).student, quiet);
  t.fx.enroll(fam(t, loc, { name: 'Cal Moss' }).student, lab);
  const early = fam(t, loc, { name: 'Dee Park' }).student;
  wait(t, early, quiet, { created_at: t.clock.now() - 86400000 });
  const already = wait(t, student, lab); // Leo was also waiting for Summer Lab

  const r = await t.as(staff).put(url(student), body({ status: 'active' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.waitlisted, r.body.kept_paused], [1, 2, 0]);
  assert.equal(enr(t, ePm).status, 'active');
  assert.equal(enr(t, eQuiet).status, 'dropped');
  assert.equal(enr(t, eQuiet).ended_at, t.clock.now());
  assert.equal(enr(t, eLab).status, 'dropped');

  const q = line(t, quiet);
  assert.deepEqual(q.map(w => [w.student_id, w.weekday]), [[student.id, 0], [early.id, 0]]);
  assert.equal(q[0].priority, 1);
  assert.equal(q[0].created_by, staff.id);
  assert.deepEqual(line(t, lab).map(w => [w.id, w.student_id, w.priority]), [[already.id, student.id, 1]]);

  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_restored');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's membership is active again");
    assert.equal(n[0].body, 'Back on: Afternoon Study. Full right now, so Leo is first on the waitlist for: Quiet Room and Summer Lab.');
  }
  assert.equal(t.fx.audit('membership.update').length, 1);
});

test('MB-5', 'renewing an expired membership brings its paused schedule back', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-15', '08:00') });
  const loc = t.fx.location();
  const { parent, student } = fam(t, loc, { membership: { start: '2026-08-01', expires: '2026-10-14' } });
  const e = t.fx.enroll(student, t.fx.session(loc));
  t.jobs();
  assert.equal(enr(t, e).status, 'paused');
  const r = await t.as(t.fx.staff(loc)).put(url(student), body({ start_date: '2026-08-01', expires_on: '2027-06-30' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 1);
  assert.equal(enr(t, e).status, 'active');
  const n = kinds(t, parent, 'membership_restored');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "Leo's schedule is back on");
  assert.equal(n[0].body, 'Back on: Afternoon Study.');
});

test(['MB-5', 'MB-2'], 'renewing under a weekly limit below a paused schedule\'s days keeps it paused and saved (not waitlisted, even when full); raising the limit brings it back', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27);
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive', cap: 3 } });
  const mwf = t.fx.session(loc, { term: fall, name: 'Mornings MWF', weekdays: '1,3,5', capacity: 1 });
  const tth = t.fx.session(loc, { term: spring, name: 'Spring TTh', weekdays: '2,4' });
  const eMwf = t.fx.enroll(student, mwf, 0, { status: 'paused' }), eTth = t.fx.enroll(student, tth, 0, { status: 'paused' });
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, mwf); // Mornings MWF filled up while Leo was paused
  const statuses = () => [eMwf, eTth].map(e => enr(t, e).status);
  const waits = () => t.db.prepare("SELECT * FROM waitlist WHERE student_id = ? AND status = 'waiting'").all(student.id);
  const restoredNotes = () => kinds(t, parent, 'membership_restored');

  const r = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 2 }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.waitlisted, r.body.kept_paused], [1, 0, 1]);
  assert.deepEqual([r.body.active_schedules, r.body.paused_schedules, r.body.held_days], [1, 1, 2]);
  assert.deepEqual(statuses(), ['paused', 'active']);
  assert.equal(enr(t, eMwf).ended_at, null);
  assert.equal(waits().length, 0); // over the limit, so not put in line for the full schedule either
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_restored');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's schedule is back on");
    assert.equal(n[0].body, "Back on: Spring TTh. Still paused, because Mornings MWF meets 3 days a week and Leo's membership allows 2. " +
      'It stays saved, and the front desk can bring it back if the weekly limit goes up.');
  }

  // Saving again with the same limit brings nothing back and sends nothing new.
  const again = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 2 }));
  assert.deepEqual([again.body.restored, again.body.kept_paused], [0, 1]);
  assert.deepEqual(statuses(), ['paused', 'active']);
  assert.equal(restoredNotes().length, 1);

  // A limit equal to its days fits: it comes back, or (full now) Leo goes to the front of its line.
  const up = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 3 }));
  assert.deepEqual([up.body.restored, up.body.waitlisted, up.body.kept_paused], [0, 1, 0]);
  assert.deepEqual(statuses(), ['dropped', 'active']);
  assert.deepEqual(waits().map(w => [w.session_id, w.weekday, w.priority]), [[mwf.id, 0, 1]]);
  assert.equal(restoredNotes().length, 2);
  assert.equal(restoredNotes()[1].body, 'Full right now, so Leo is first on the waitlist for: Mornings MWF.');
});

test('MB-5', 'the weekly limit is compared with each paused schedule on its own (D-43), so schedules in periods that don\'t overlap each come back when they fit', async () => {
  const t = await makeApp(); // Wed 2026-10-14, during Fall
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27), summer = t.fx.term(loc, summer27);
  const fs2 = t.fx.session(loc, { term: fall, name: 'Fall TTh', weekdays: '2,4' });
  const ss2 = t.fx.session(loc, { term: spring, name: 'Spring MW', weekdays: '1,3' });
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive', cap: 2 } });
  const es = [t.fx.enroll(student, fs2, 0, { status: 'paused' }), t.fx.enroll(student, ss2, 0, { status: 'paused' })];

  const r = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 2 }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.waitlisted, r.body.kept_paused], [2, 0, 0]);
  assert.deepEqual([r.body.active_schedules, r.body.paused_schedules, r.body.held_days], [2, 0, 2]);
  assert.deepEqual(es.map(e => enr(t, e).status), ['active', 'active']);
  const n = kinds(t, parent, 'membership_restored');
  assert.equal(n[0].title, "Leo's schedules are back on");
  assert.equal(n[0].body, 'Back on: Fall TTh and Spring MW.');

  // Several kept: Ana (limit 2) gets Summer TTh back, and both 3-day schedules stay paused and saved.
  const other = fam(t, loc, { name: 'Ana Ruiz', membership: { status: 'inactive', cap: 2 } });
  const f3 = t.fx.session(loc, { term: fall, name: 'Fall MWF', weekdays: '1,3,5' });
  const s3 = t.fx.session(loc, { term: spring, name: 'Spring MWF', weekdays: '1,3,5' });
  const u2 = t.fx.session(loc, { term: summer, name: 'Summer TTh', weekdays: '2,4' });
  const os = [f3, s3, u2].map(s => t.fx.enroll(other.student, s, 0, { status: 'paused' }));
  const o = await t.as(staff).put(url(other.student), body({ status: 'active', weekly_cap: 2 }));
  assert.deepEqual([o.body.restored, o.body.waitlisted, o.body.kept_paused], [1, 0, 2]);
  assert.deepEqual(os.map(e => enr(t, e).status), ['paused', 'paused', 'active']);
  assert.equal(kinds(t, other.parent, 'membership_restored')[0].body, "Back on: Summer TTh. Still paused, because Ana's membership allows 2 days a week: " +
    'Fall MWF (3 days a week) and Spring MWF (3 days a week). They stay saved, and the front desk can bring them back if the weekly limit goes up.');
});

test('MB-5', 'renewal leaves a paused schedule from a term that has ended alone: not restored, not waitlisted, not announced, not counted', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), summer = t.fx.term(loc, summer26);
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive' } });
  const lab = t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '2,4', capacity: 1 });
  const done = t.fx.session(loc, { term: summer, name: 'Summer Art', weekdays: '1' });
  const pm = t.fx.session(loc, { term: fall, name: 'Afternoon Study', weekdays: '1' });
  const eFall = t.fx.enroll(student, pm, 0, { status: 'paused' });
  const eLab = t.fx.enroll(student, lab, 0, { status: 'paused' }); // full
  const eArt = t.fx.enroll(student, done, 0, { status: 'paused' }); // had a free seat
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, lab);

  const before = await t.as(staff).get(url(student));
  assert.deepEqual([before.body.active_schedules, before.body.paused_schedules], [0, 1]);

  const r = await t.as(staff).put(url(student), body({ status: 'active' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.waitlisted, r.body.kept_paused], [1, 0, 0]);
  assert.deepEqual([r.body.active_schedules, r.body.paused_schedules], [1, 0]);
  assert.deepEqual([eFall, eLab, eArt].map(e => enr(t, e).status), ['active', 'paused', 'paused']);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE student_id = ?').get(student.id).n, 0);
  const n = kinds(t, parent, 'membership_restored');
  assert.equal(n.length, 1);
  assert.equal(n[0].body, 'Back on: Afternoon Study.');

  const roster = await t.as(staff).get('/api/membership/roster');
  const me = roster.body.students.find(s => s.id === student.id);
  assert.deepEqual([me.active_schedules, me.paused_schedules, me.schedules.map(s => s.name)], [1, 0, ['Afternoon Study']]);
});

test(['MB-5', 'MB-1', 'MB-3'], "an evening save in Los Angeles goes by Los Angeles' date, a day behind UTC", async () => {
  // Wed Oct 14 at 17:30 in Los Angeles is already 00:30 UTC on Oct 15.
  const t = await makeApp({ now: at(LA, '2026-10-14', '17:30') });
  const loc = t.fx.location({ timezone: LA });
  const { parent, student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const e = t.fx.enroll(student, t.fx.session(loc));

  // Today is the last valid day: the schedule keeps running, and everyone sees 0 days left.
  const keep = await t.as(staff).put(url(student), body({ expires_on: '2026-10-14' }));
  assert.equal(keep.status, 200);
  assert.equal(enr(t, e).status, 'active');
  assert.equal(keep.body.paused, 0);
  assert.deepEqual([keep.body.today, keep.body.membership.state, keep.body.membership.days_left], ['2026-10-14', 'ending', 0]);
  const roster = await t.as(staff).get('/api/membership/roster');
  assert.equal(roster.body.today, '2026-10-14');
  const r = roster.body.students.find(s => s.id === student.id);
  assert.deepEqual([r.membership.state, r.membership.days_left], ['ending', 0]);
  const mine = await t.as(parent).get('/api/membership/mine');
  assert.deepEqual([mine.body.members[0].membership.state, mine.body.members[0].membership.days_left], ['ending', 0]);

  // Yesterday was the last day: paused right away.
  const lapse = await t.as(staff).put(url(student), body({ expires_on: '2026-10-13' }));
  assert.equal(lapse.status, 200);
  assert.equal(lapse.body.paused, 1);
  assert.equal(enr(t, e).status, 'paused');
  assert.deepEqual([lapse.body.membership.state, lapse.body.membership.days_left], ['expired', -1]);
});

test('MB-5', 'pausing leaves schedules from a term that has ended alone, so the family is told only about real schedules', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location();
  const fall = t.fx.term(loc), summer = t.fx.term(loc, summer26);
  const lab = t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '2' });
  const pm = t.fx.session(loc, { term: fall, weekdays: '1,3' });

  // Staff set a membership inactive.
  const a = fam(t, loc);
  const aOld = t.fx.enroll(a.student, lab); // still marked active, but its term is over
  const aNow = t.fx.enroll(a.student, pm);
  const r = await t.as(t.fx.staff(loc)).put(url(a.student), body({ status: 'inactive' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.paused, 1);
  assert.deepEqual([enr(t, aNow).status, enr(t, aOld).status], ['paused', 'active']);
  assert.match(kinds(t, a.parent, 'membership_paused')[0].body, /, so Afternoon Study is on hold\./);

  // The expiry job, once the last day has passed.
  const b = fam(t, loc, { name: 'Ana Ruiz', membership: { expires: '2026-10-13' } });
  const bOld = t.fx.enroll(b.student, lab);
  const bNow = t.fx.enroll(b.student, pm);
  t.jobs();
  assert.deepEqual([enr(t, bNow).status, enr(t, bOld).status], ['paused', 'active']);
  assert.match(kinds(t, b.parent, 'membership_expired')[0].body, /\. Afternoon Study is paused and saved until/);
});

// ---------------- the Members roster: each account's state, as People decides it ----------------

// A student linked to a parent; one who set a password and waits for a parent's
// approval; and one invited who hasn't set up the account (no password yet).
function accountWorld(t, loc) {
  const linked = fam(t, loc, { name: 'A Linked' });
  const waiting = t.fx.user('student', { location: loc, name: 'B Waiting' });
  t.fx.link(t.fx.user('parent', { location: loc }), waiting, 'pending');
  const invited = t.fx.user('student', { location: loc, name: 'C Invited' });
  t.db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(invited.id);
  t.fx.link(t.fx.user('parent', { location: loc }), invited, 'pending');
  return { linked, waiting, invited };
}

test('MB-1', 'the roster gives each student\'s account state the way People does: active, waiting for parent approval, or invited', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  accountWorld(t, loc);
  const r = await t.as(t.fx.staff(loc)).get('/api/membership/roster');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.students.map(s => [s.name, s.account, s.linked]),
    [['A Linked', 'active', true], ['B Waiting', 'awaiting_approval', false], ['C Invited', 'invited', false]]);
});

// ---------------- D-27: the weekly limit can't go below a held schedule's days a week ----------------

test(['MB-1', 'MB-2'], 'staff can\'t lower the weekly limit below the days a week of a schedule the student holds; the refusal names the schedule and its days', async () => {
  const t = await makeApp(); // Wed 2026-10-14, during Fall
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27), summer = t.fx.term(loc, summer27), past = t.fx.term(loc, summer26);
  const { parent, student } = fam(t, loc, { membership: { cap: 4, start: '2026-08-01', expires: '2027-08-31' } });
  const four = t.fx.enroll(student, t.fx.session(loc, { term: fall, name: 'Mornings MTWTh', weekdays: '1,2,3,4' }));
  const save = cap => t.as(staff).put(url(student), body({ weekly_cap: cap, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  const msg = "Leo holds Mornings MTWTh (4 days a week), so the weekly limit can't go below 4. A parent can switch to a schedule with fewer days, or drop it, first.";

  for (const cap of [2, 3]) {
    const r = await save(cap);
    assert.equal(r.status, 409, String(cap));
    assert.equal(r.body.error, 'weekly_cap_below_held');
    assert.equal(r.body.message, msg);
  }
  assert.equal(row(t, student).weekly_cap, 4);
  assert.equal(enr(t, four).status, 'active');
  assert.equal(t.fx.audit('membership.update').length, 0);
  assert.equal(t.fx.notifications(parent).length, 0);
  assert.equal((await t.as(staff).get(url(student))).body.held_days, 4);

  // Not below what they hold: saved.
  assert.equal((await save(4)).status, 200);

  // The most days of any held schedule counts. Spring TTh (2) comes first, Summer MWF (3) holds more.
  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(t.clock.now(), four.id);
  t.fx.enroll(student, t.fx.session(loc, { term: spring, name: 'Spring TTh', weekdays: '2,4' }));
  const mwf = t.fx.enroll(student, t.fx.session(loc, { term: summer, name: 'Summer MWF', weekdays: '1,3,5' }));
  // Nothing else holds days against the limit: a dropped or paused schedule, one in a term that has ended,
  // one that was cancelled, or a live v1 per-day row (v1 history only; D-42).
  t.fx.enroll(student, t.fx.session(loc, { term: past, name: 'Summer Lab', weekdays: '1,2,3,4,5' }));
  t.fx.enroll(student, t.fx.session(loc, { term: fall, name: 'Fall Paused', weekdays: '1,2,3,4,5' }), 0, { status: 'paused' });
  const gone = t.fx.session(loc, { term: fall, name: 'Fall Cancelled', weekdays: '1,2,3,4,5' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(gone.id);
  t.fx.enroll(student, gone);
  t.fx.enroll(student, t.fx.session(loc, { term: fall, name: 'Fall v1', weekdays: '1,2,3,4,5' }), 1);
  assert.equal((await t.as(staff).get(url(student))).body.held_days, 3);
  assert.equal((await save(3)).status, 200);
  const two = await save(2);
  assert.equal(two.status, 409);
  assert.match(two.body.message, /^Leo holds Summer MWF \(3 days a week\), so the weekly limit can't go below 3\./);

  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(t.clock.now(), mwf.id);
  assert.equal((await save(2)).status, 200);
  const one = await save(1);
  assert.equal(one.status, 409);
  assert.match(one.body.message, /^Leo holds Spring TTh \(2 days a week\), so the weekly limit can't go below 2\./);
  assert.equal(row(t, student).weekly_cap, 2);
});

test(['MB-2', 'MB-5'], 'a lower weekly limit is saved when the same save pauses the schedule, and an edit that keeps the limit is never refused', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc, { name: 'Mornings MTW', weekdays: '1,2,3' });
  // Setting the membership inactive pauses the schedule, so a lower limit leaves nothing over it.
  const a = fam(t, loc, { name: 'Ana Ruiz', membership: { cap: 3 } });
  t.fx.enroll(a.student, sess);
  const off = await t.as(staff).put(url(a.student), body({ status: 'inactive', weekly_cap: 1, start_date: '2026-08-01' }));
  assert.equal(off.status, 200);
  assert.equal(off.body.paused, 1);
  assert.equal(row(t, a.student).weekly_cap, 1);

  // A student already over the limit (held before the limit was lowered) can still be renewed at the same limit.
  const b = fam(t, loc, { name: 'Ben Okafor', membership: { cap: 2, expires: '2026-10-20' } });
  t.fx.enroll(b.student, sess);
  const renew = await t.as(staff).put(url(b.student), body({ weekly_cap: 2, start_date: '2026-08-01', expires_on: '2027-06-30' }));
  assert.equal(renew.status, 200);
  assert.equal(row(t, b.student).expires_on, '2027-06-30');
  const lower = await t.as(staff).put(url(b.student), body({ weekly_cap: 1, start_date: '2026-08-01', expires_on: '2027-06-30' }));
  assert.equal(lower.status, 409);
  assert.equal(lower.body.message, "Ben holds Mornings MTW (3 days a week), so the weekly limit can't go below 3. A parent can switch to a schedule with fewer days, or drop it, first.");
});

// ---------------- R6: a membership counts from its start date ----------------

test(['MB-1', 'MB-3'], 'before its start date a membership reads as not started yet for staff and families, and as active from that day', async () => {
  const t = await makeApp(); // Wed 2026-10-14 in Los Angeles
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const { parent, student } = fam(t, loc, { name: 'Ben Okafor', membership: false });
  const r = await t.as(staff).put(url(student), body({ weekly_cap: 2, start_date: '2026-11-02', expires_on: '2027-06-30' }));
  assert.equal(r.status, 200);
  const want = { id: row(t, student).id, status: 'active', weekly_cap: 2, start_date: '2026-11-02', expires_on: '2027-06-30',
    days_left: 259, state: 'upcoming', renewal_needed: false };
  assert.deepEqual(r.body.membership, want);
  assert.deepEqual((await t.as(staff).get(url(student))).body.membership, want);
  assert.deepEqual((await t.as(parent).get('/api/membership/mine')).body.members[0].membership, want);
  assert.deepEqual((await t.as(student).get('/api/membership/mine')).body.members[0].membership, want);
  const roster = (await t.as(staff).get('/api/membership/roster')).body.students.find(s => s.id === student.id);
  assert.deepEqual(roster.membership, want);

  // The evening before it starts, still not started (on Los Angeles' date, though UTC is already Nov 2).
  t.clock.set(at(LA, '2026-11-01', '20:00'));
  assert.equal((await t.as(staff).get(url(student))).body.membership.state, 'upcoming');
  // From the start date on, it is active.
  t.clock.set(at(LA, '2026-11-02', '06:00'));
  const on = (await t.as(staff).get(url(student))).body.membership;
  assert.deepEqual([on.state, on.renewal_needed], ['active', false]);

  // An inactive membership with a future start reads as inactive, not as starting.
  const c = fam(t, loc, { name: 'Cara Diaz', membership: { status: 'inactive', start: '2026-12-01', expires: '2027-06-30' } });
  assert.equal((await t.as(staff).get(url(c.student))).body.membership.state, 'inactive');
});

// D-32: schedules never come back before the membership starts; the daily job brings them back on that day.
test(['MB-5', 'MB-1'], 'renewing with a start date still ahead keeps paused schedules paused until that day; the daily job brings them back then, under the weekly limit and seat rules, and tells the family then', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-05', '12:00') });
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27), summer = t.fx.term(loc, summer27);
  const { parent, student } = fam(t, loc, { membership: { cap: 3, start: '2026-08-01', expires: '2026-10-05' } });
  const quiet = t.fx.session(loc, { term: fall, name: 'Quiet Room', weekdays: '2', start: '16:30', end: '18:30', capacity: 1 });
  const pm = t.fx.session(loc, { term: spring, name: 'Afternoon Study', weekdays: '1,4', start: '13:00' });
  const lab = t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '1,3,5' });
  const eQuiet = t.fx.enroll(student, quiet), ePm = t.fx.enroll(student, pm), eLab = t.fx.enroll(student, lab);
  const statuses = () => [eQuiet, ePm, eLab].map(e => enr(t, e).status);
  const restoredNotes = u => kinds(t, u, 'membership_restored');
  const mark = () => t.db.prepare('SELECT COUNT(*) AS n FROM membership_starts WHERE student_id = ?').get(student.id).n;

  // The membership ended Mon Oct 5; that night the job paused all three, and Quiet Room filled up since.
  t.clock.set(at(LA, '2026-10-06', '00:05'));
  t.jobs();
  assert.deepEqual(statuses(), ['paused', 'paused', 'paused']);
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, quiet);

  // Wed Oct 14: staff renew it from Mon Nov 2 with a weekly limit of 2. Nothing comes back yet.
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  const r = await t.as(staff).put(url(student), body({ weekly_cap: 2, start_date: '2026-11-02', expires_on: '2027-08-31' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.waitlisted, r.body.kept_paused, r.body.paused], [0, 0, 0, 0]);
  assert.deepEqual([r.body.membership.state, r.body.active_schedules, r.body.paused_schedules], ['upcoming', 0, 3]);
  assert.deepEqual(statuses(), ['paused', 'paused', 'paused']);
  assert.deepEqual(line(t, quiet).map(w => w.student_id), []);
  assert.equal(mark(), 1);
  for (const u of [parent, student]) assert.equal(restoredNotes(u).length, 0);

  // Daily runs before the start date change nothing, by Los Angeles' date (UTC is already Nov 2 that evening).
  t.jobs();
  t.clock.set(at(LA, '2026-11-01', '20:00'));
  t.jobs();
  assert.deepEqual(statuses(), ['paused', 'paused', 'paused']);
  for (const u of [parent, student]) assert.equal(restoredNotes(u).length, 0);

  // Mon Nov 2: the job brings Afternoon Study back, puts Leo first in line for the full Quiet Room,
  // keeps Summer Lab (3 days, over the limit of 2) paused and saved, and tells the family once.
  t.clock.set(at(LA, '2026-11-02', '00:05'));
  t.jobs(); t.jobs();
  assert.deepEqual(statuses(), ['dropped', 'active', 'paused']);
  assert.equal(enr(t, eQuiet).ended_at, t.clock.now());
  assert.deepEqual(line(t, quiet).map(w => [w.student_id, w.priority]), [[student.id, 1]]);
  for (const u of [parent, student]) {
    const n = restoredNotes(u);
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's membership is active again");
    assert.equal(n[0].body, 'Back on: Afternoon Study. Full right now, so Leo is first on the waitlist for: Quiet Room. ' +
      "Still paused, because Summer Lab meets 3 days a week and Leo's membership allows 2. It stays saved, and the front desk can bring it back if the weekly limit goes up.");
  }

  // It runs once: the mark is gone, and Summer Lab stays paused until staff raise the limit (D-16a).
  assert.equal(mark(), 0);
  t.clock.set(at(LA, '2026-11-03', '00:05'));
  t.jobs();
  assert.equal(enr(t, eLab).status, 'paused');
  assert.equal(restoredNotes(parent).length, 1);
});

test(['MB-5', 'MB-2'], 'moving the start date ahead pauses the schedule a student holds until that day and says when it comes back; a later save that starts it today brings it back at once, and the job adds nothing', async () => {
  const t = await makeApp(); // Wed 2026-10-14 in Los Angeles
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc, { weekdays: '1,3' });
  const { parent, student } = fam(t, loc, { membership: { cap: 3, start: '2026-08-01' } });
  const e = t.fx.enroll(student, sess);
  const b = fam(t, loc, { name: 'Ana Ruiz', membership: { cap: 2, start: '2026-08-01' } });
  const be = t.fx.enroll(b.student, sess);
  const markOf = s => t.db.prepare('SELECT start_date FROM membership_starts WHERE student_id = ?').get(s.id);

  const r = await t.as(staff).put(url(student), body({ start_date: '2026-10-26' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.paused, r.body.restored, r.body.membership.state, r.body.active_schedules, r.body.paused_schedules], [1, 0, 'upcoming', 0, 1]);
  assert.equal(enr(t, e).status, 'paused');
  assert.equal(markOf(student).start_date, '2026-10-26');
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_paused');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's schedule is paused");
    assert.equal(n[0].body, "Leo's membership starts Mon, Oct 26, 2026, so Afternoon Study is on hold until then. " +
      "It is saved, and you'll get a notification on that day when it comes back.");
    assert.equal(kinds(t, u, 'membership_restored').length, 0);
  }

  // Ana's start moves ahead, then back to today: her schedule comes back at once, and no start mark is left for the job.
  assert.equal((await t.as(staff).put(url(b.student), body({ weekly_cap: 2, start_date: '2026-10-26' }))).body.paused, 1);
  assert.equal(markOf(b.student).start_date, '2026-10-26');
  const now = await t.as(staff).put(url(b.student), body({ weekly_cap: 2, start_date: '2026-10-14' }));
  assert.deepEqual([now.body.restored, now.body.kept_paused, now.body.membership.state], [1, 0, 'active']);
  assert.equal(enr(t, be).status, 'active');
  assert.equal(markOf(b.student), undefined);

  // The evening before (UTC is already Oct 26), nothing yet; on Mon Oct 26 Leo's schedule comes back and the family is told.
  t.clock.set(at(LA, '2026-10-25', '22:00'));
  t.jobs();
  assert.equal(enr(t, e).status, 'paused');
  t.clock.set(at(LA, '2026-10-26', '06:00'));
  t.jobs();
  assert.equal(enr(t, e).status, 'active');
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_restored');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's schedule is back on");
    assert.equal(n[0].body, 'Back on: Afternoon Study.');
  }
  assert.equal(kinds(t, b.parent, 'membership_restored').length, 1);
});

// ---------------- the Members screen and the Home card in a browser tab ----------------

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
  // Form controls, for the edit screen: a value, a checked radio, and the one selector its preview uses.
  get value() { return this.attrs.has('value') ? this.getAttribute('value') : ''; }
  set value(v) { this.setAttribute('value', v); }
  get checked() { return this.attrs.has('checked'); }
  querySelector(sel) {
    const m = /^(\w+)\[name="([^"]+)"\]:checked$/.exec(sel);
    return m ? this.find(n => n.tag === m[1] && n.getAttribute('name') === m[2] && n.checked) || null : null;
  }
}

// One tab running the real shell and membership view (read from ROOT, so the
// mutation runner's copy is the one exercised), signed in as `user` at `hash`.
async function openTab(t, user, hash) {
  const token = crypto.randomBytes(16).toString('hex');
  t.ctx.sessions.set(token, user.id);
  const pending = new Set();
  const track = p => { pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };
  const doc = { title: '', hidden: false, addEventListener() {} };
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
  const fetchAs = (url, opts = {}) => track(fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie: 'sid=' + token }) }))
    .then(async r => new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers })));
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator: {}, location: { hash },
    EventSource: class { close() {} }, history: { replaceState() {} }, addEventListener() {}, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/membership.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  win.App.start();
  do {
    await Promise.allSettled([...pending]);
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  } while (pending.size);
  return doc;
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();

test(['MB-1', 'MB-2', 'NF-7'], 'Members on a phone: an unapproved account reads as it does on People, the filter tabs stay one-line tabs in one row, and the table scrolls from the keyboard', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const { linked } = accountWorld(t, loc);
  const doc = await openTab(t, t.fx.staff(loc), '#/members');
  const main = doc.getElementById('main');
  const rows = main.findAll(n => n.tag === 'tr').slice(1).map(tr => words(tr.childNodes[0]));
  const parent = t.db.prepare('SELECT p.name FROM family_links fl JOIN users p ON p.id = fl.parent_id WHERE fl.student_id = ?').get(linked.student.id).name;
  assert.deepEqual(rows, ['A Linked Parent: ' + parent, 'B Waiting Waiting for parent approval', 'C Invited Invited, not set up yet']);

  const tabs = main.find(n => n.getAttribute('role') === 'tablist');
  assert.ok(tabs.cls.includes('mb-tabs'), tabs.className);
  const css = doc.head.findAll(n => n.tag === 'style').map(s => s.textContent.replace(/\s+/g, ' ')).join(' ');
  assert.match(css, /\.mb-tabs button \{ flex: none; white-space: nowrap;/, 'each tab keeps its width and its label stays on one line');

  const wrap = main.find(n => n.cls.includes('table-wrap'));
  assert.deepEqual([wrap.getAttribute('tabindex'), wrap.getAttribute('role'), wrap.getAttribute('aria-label')], ['0', 'region', 'Memberships at Irvine']);
});
test(['MB-1', 'MB-5'], 'the Members table shows each student\'s schedule by name and days, marks a paused one, and gives the weekly limit in days a week', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27);
  const leo = fam(t, loc, { membership: { cap: 3 } }).student;
  t.fx.enroll(leo, t.fx.session(loc, { term: fall, name: 'Mornings MWF', weekdays: '1,3,5' }));
  t.fx.enroll(leo, t.fx.session(loc, { term: spring, name: 'Spring TTh', weekdays: '2,4' }), 0, { status: 'paused' });
  fam(t, loc, { name: 'Ana Ruiz', membership: { cap: 1 } });
  const main = (await openTab(t, t.fx.staff(loc), '#/members')).getElementById('main');
  const head = main.findAll(n => n.tag === 'th').map(words);
  assert.deepEqual(head.slice(0, 5), ['Student', 'Membership', 'Weekly limit', 'Valid through', 'Schedule']);
  const cells = name => main.findAll(n => n.tag === 'tr').find(n => words(n).startsWith(name)).childNodes;
  assert.equal(words(cells('Leo Garcia')[2]), '3 days a week');
  assert.equal(words(cells('Leo Garcia')[4]), 'Mornings MWF · Mon, Wed, Fri Spring TTh · Tue, Thu Paused');
  assert.ok(cells('Leo Garcia')[4].find(n => n.cls.includes('badge') && words(n) === 'Paused'));
  assert.equal(words(cells('Ana Ruiz')[2]), '1 day a week');
  assert.equal(words(cells('Ana Ruiz')[4]), 'None');
});

test(['MB-3', 'MB-5'], "a student whose membership lapsed reads on Home the same words Schedule uses: it isn't active, the schedule is paused, and who renews it", async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const sess = t.fx.session(loc);
  const lapsed = fam(t, loc, { name: 'Daniel Kim', membership: { status: 'inactive' } });
  t.fx.enroll(lapsed.student, sess, 0, { status: 'paused' });
  const expired = fam(t, loc, { name: 'Ana Ruiz', membership: { expires: '2026-10-13' } });
  const card = async u => words((await openTab(t, u, '#/home')).getElementById('main').find(n => n.getAttribute('data-card') === 'membership'));
  assert.match(await card(lapsed.student), /Your membership isn't active, so your schedule is paused\. Ask a parent or the front desk at Irvine to renew it\.$/);
  assert.match(await card(expired.student), /Last day: Tue, Oct 13, 2026 Your membership isn't active\. Ask a parent or the front desk at Irvine to renew it\.$/);
  // Parents still get the details and what renewing does.
  assert.match(await card(lapsed.parent), /Up to 3 days a week .*Daniel's membership isn't active right now\. Afternoon Study is paused and saved\. Renew with the front desk at Irvine to bring it back\.$/);
  assert.match(await card(expired.parent), /Ana's membership ended on Tue, Oct 13, 2026\. Renew with the front desk at Irvine to enroll in a schedule again\.$/);
  // Ending soon: renew to keep the schedule.
  const soon = fam(t, loc, { name: 'Ben Ito', membership: { expires: '2026-10-20' } });
  assert.match(await card(soon.parent), /Ben's membership ends in 6 days \(Tue, Oct 20, 2026\)\. Renew with the front desk at Irvine to keep Ben's schedule\.$/);
});

test(['MB-1', 'MB-2'], 'the edit screen warns before saving a weekly limit below the days of the schedule the student holds, in the words the refusal uses', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const { student } = fam(t, loc, { membership: { cap: 4 } });
  t.fx.enroll(student, t.fx.session(loc, { name: 'Mornings MTWTh', weekdays: '1,2,3,4' }));
  const staff = t.fx.staff(loc);
  const main = (await openTab(t, staff, '#/members/' + student.id)).getElementById('main');
  const cap = main.find(n => n.id === 'mb-cap');
  assert.equal(words(main.find(n => n.tag === 'label' && n.getAttribute('for') === 'mb-cap')), 'Weekly limit (days a week)');
  assert.match(words(main.find(n => n.cls.includes('card'))), /Holds Mornings MTWTh \(4 days a week\)\.$/);
  const effect = () => words(main.find(n => n.getAttribute('aria-live') === 'polite'));
  assert.equal(effect(), '');
  cap.value = '2';
  cap.dispatch('input');
  assert.ok(main.find(n => n.cls.includes('notice-danger')), 'a notice says the save will be refused');
  const refusal = (await t.as(staff).put(url(student), body({ weekly_cap: 2, start_date: '2026-08-01' }))).body.message;
  assert.equal(effect(), refusal);
  assert.equal(effect(), "Leo holds Mornings MTWTh (4 days a week), so the weekly limit can't go below 4. A parent can switch to a schedule with fewer days, or drop it, first.");
  cap.value = '4';
  cap.dispatch('input');
  assert.equal(effect(), '');
});

test(['MB-1', 'MB-5'], 'the edit screen says which paused schedules a save brings back: only those whose days fit the new limit', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const fall = t.fx.term(loc), spring = t.fx.term(loc, spring27);
  const { student } = fam(t, loc, { membership: { status: 'inactive', cap: 3 } });
  t.fx.enroll(student, t.fx.session(loc, { term: fall, name: 'Mornings MWF', weekdays: '1,3,5' }), 0, { status: 'paused' });
  t.fx.enroll(student, t.fx.session(loc, { term: spring, name: 'Spring TTh', weekdays: '2,4' }), 0, { status: 'paused' });
  const main = (await openTab(t, t.fx.staff(loc), '#/members/' + student.id)).getElementById('main');
  assert.match(words(main.find(n => n.cls.includes('card'))), /No schedule right now\. Mornings MWF and Spring TTh are paused until the membership is active again\.$/);
  const cap = main.find(n => n.id === 'mb-cap');
  const radio = main.find(n => n.tag === 'input' && n.getAttribute('value') === 'active');
  const off = main.find(n => n.tag === 'input' && n.getAttribute('value') === 'inactive');
  off.attrs.delete('checked'); radio.setAttribute('checked', '');
  const effect = () => words(main.find(n => n.getAttribute('aria-live') === 'polite'));
  const save = () => words(main.find(n => n.tag === 'button' && n.getAttribute('type') === 'submit'));
  cap.dispatch('input');
  assert.equal(effect(), "Saving brings back Leo's paused schedules, Mornings MWF and Spring TTh. If one has filled up since, Leo goes first on its waitlist. The family gets a notification.");
  assert.equal(save(), 'Save and restore 2 schedules');
  cap.value = '2';
  cap.dispatch('input');
  assert.equal(effect(), "Saving brings back Leo's paused schedule, Spring TTh. If it has filled up since, Leo goes first on its waitlist. " +
    'Mornings MWF stays paused and saved, because the weekly limit is 2 days a week. The family gets a notification.');
  assert.equal(save(), 'Save and restore 1 schedule');
  cap.value = '1';
  cap.dispatch('input');
  assert.equal(effect(), 'Mornings MWF and Spring TTh meet more days a week than a weekly limit of 1, so they stay paused and saved. Raising the limit brings them back.');
  assert.equal(save(), 'Save membership');

  // Saved at 2, Right now says why Mornings MWF is still paused.
  assert.equal((await t.as(t.fx.staff(loc)).put(url(student), body({ status: 'active', weekly_cap: 2 }))).body.kept_paused, 1);
  const again = (await openTab(t, t.fx.staff(loc), '#/members/' + student.id)).getElementById('main');
  assert.match(words(again.find(n => n.cls.includes('card'))),
    /Holds Spring TTh \(2 days a week\)\. Mornings MWF is paused because it meets more days a week than the weekly limit\. Raising the limit brings it back\.$/);
});

test(['MB-1', 'MB-3'], 'a membership that has not started shows "Starts <date>" on Members, Right now and the Home card, and counts as not active', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location({ name: 'Irvine' });
  const { parent, student } = fam(t, loc, { name: 'Ben Okafor', membership: { cap: 2, start: '2026-11-02', expires: '2027-06-30' } });
  const staff = t.fx.staff(loc);

  const roster = (await openTab(t, staff, '#/members')).getElementById('main');
  const tr = roster.findAll(n => n.tag === 'tr').find(n => words(n).startsWith('Ben Okafor'));
  assert.equal(words(tr.childNodes[1]), 'Starts Mon, Nov 2, 2026 Not active until then');
  assert.equal(words(roster.find(n => n.id === 'mb-tab-off')), 'Not active (1)');

  const edit = (await openTab(t, staff, '#/members/' + student.id)).getElementById('main');
  const now = edit.find(n => n.cls.includes('card'));
  assert.match(words(now), /^Right now Starts Mon, Nov 2, 2026 Up to 2 days a week · Mon, Nov 2, 2026 through Wed, Jun 30, 2027 Not active until Mon, Nov 2, 2026, so Ben can't enroll in a schedule or check in before then\./);

  const card = async u => words((await openTab(t, u, '#/home')).getElementById('main').find(n => n.getAttribute('data-card') === 'membership'));
  assert.match(await card(parent), /Ben Okafor Starts Mon, Nov 2, 2026 Up to 2 days a week Valid through Wed, Jun 30, 2027 Ben's membership starts Mon, Nov 2, 2026\. Ben can enroll in a schedule and check in from that day\.$/);
  assert.match(await card(student), /Your membership starts Mon, Nov 2, 2026\. You can enroll in a schedule and check in from that day\.$/);
});

test(['MB-1', 'MB-5'], 'the edit screen says a schedule comes back on the start date, not on save: a start date ahead pauses the held schedule until then, and a paused one stays paused until that day', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location({ name: 'Irvine' });
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc, { weekdays: '1,3' });
  const held = fam(t, loc, { membership: { cap: 3, start: '2026-08-01' } });
  t.fx.enroll(held.student, sess);
  const lapsed = fam(t, loc, { name: 'Ana Ruiz', membership: { cap: 3, start: '2026-08-01', expires: '2026-10-05' } });
  t.fx.enroll(lapsed.student, sess, 0, { status: 'paused' });
  const open = async s => {
    const main = (await openTab(t, staff, '#/members/' + s.id)).getElementById('main');
    const start = main.find(n => n.id === 'mb-start'), end = main.find(n => n.id === 'mb-end');
    const effect = () => words(main.find(n => n.getAttribute('aria-live') === 'polite'));
    const save = () => words(main.find(n => n.tag === 'button' && n.getAttribute('type') === 'submit'));
    return { main, start, end, effect, save };
  };

  const a = await open(held.student);
  a.start.value = '2026-11-02';
  a.start.dispatch('input');
  assert.equal(a.effect(), "Saving pauses Leo's schedule, Afternoon Study. It's kept and comes back on Mon, Nov 2, 2026, when the membership starts. The family gets a notification.");
  assert.equal(a.save(), 'Save and pause 1 schedule');

  const b = await open(lapsed.student);
  b.end.value = '2027-06-30';
  b.end.dispatch('input');
  assert.match(b.effect(), /^Saving brings back Ana's paused schedule, Afternoon Study\./);
  b.start.value = '2026-11-02';
  b.start.dispatch('input');
  assert.equal(b.effect(), "Ana's paused schedule, Afternoon Study, stays paused until the membership starts on Mon, Nov 2, 2026. It comes back that day if its days fit the weekly limit, and the family gets a notification then.");
  assert.equal(b.save(), 'Save membership');

  // Saved that way, Right now says why it is paused.
  assert.equal((await t.as(staff).put(url(lapsed.student), body({ start_date: '2026-11-02', expires_on: '2027-06-30' }))).status, 200);
  const now = (await open(lapsed.student)).main.find(n => n.cls.includes('card'));
  assert.match(words(now), /No schedule right now\. Afternoon Study is paused until the membership starts\.$/);
});

test(['MB-3', 'MB-5'], 'membership notices in the Inbox open Home (the membership card) for families and Members for staff (L35)', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const { parent, student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  t.fx.enroll(student, t.fx.session(loc));
  assert.equal((await t.as(staff).put(url(student), body({ status: 'inactive' }))).body.paused, 1);
  // Staff get none today; one that reaches them opens their own membership screen.
  t.db.prepare("INSERT INTO notifications (user_id, kind, title, ref_type, ref_id, created_at) VALUES (?, 'membership_paused', ?, 'membership', ?, ?)")
    .run(staff.id, "Leo's schedule is paused", row(t, student).id, t.clock.now());
  const links = async u => (await openTab(t, u, '#/inbox')).getElementById('main')
    .findAll(n => n.tag === 'a' && n.cls.includes('inbox-link')).map(a => [words(a), a.getAttribute('href')]);
  const item = /^(New )?Leo's schedule is paused/;
  for (const [u, href] of [[parent, '#/home'], [student, '#/home'], [staff, '#/members']]) {
    const got = await links(u);
    assert.equal(got.length, 1, u.role + ' ' + JSON.stringify(got));
    assert.match(got[0][0], item);
    assert.equal(got[0][1], href, u.role);
  }
});
