'use strict';
// Membership: records (MB-1), staff edits with an audit trail and no payment
// data (MB-2, NF-2, D-22), family read access (MB-3), expiry reminders (MB-4),
// pausing and restoring enrollments (MB-5, D-16), and scope on every route (NF-1).
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
function wait(t, student, session, weekday, { priority = 0, created_at = t.clock.now() } = {}) {
  const id = Number(t.db.prepare("INSERT INTO waitlist (student_id, session_id, weekday, status, priority, created_at) VALUES (?,?,?,'waiting',?,?)")
    .run(student.id, session.id, weekday, priority, created_at).lastInsertRowid);
  return t.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
}
const line = (t, session, weekday) => t.db.prepare(`SELECT * FROM waitlist WHERE session_id = ? AND weekday = ? AND status = 'waiting'
  ORDER BY priority DESC, created_at ASC, id ASC`).all(session.id, weekday);

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
  const sess = t.fx.session(loc), sess2 = t.fx.session(loc, { weekdays: '2,4' });
  t.fx.enroll(s15, sess, 1); t.fx.enroll(s15, sess, 3);
  t.fx.enroll(s15, sess2, 2, { status: 'paused' }); t.fx.enroll(s15, sess2, 4, { status: 'dropped' });

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
  assert.equal(by['A Fifteen'].active_slots, 2);
  assert.equal(by['A Fifteen'].paused_slots, 1);
  assert.equal(by['B Fourteen'].active_slots, 0);
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
    assert.match(r[0].body, /front desk at Irvine/);
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

// ---------------- MB-5: pause and restore ----------------

test('MB-5', 'once the location\'s date passes the last day, active enrollments are paused (not deleted) and the family is told once', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '23:30') });
  const loc = t.fx.location();
  const { parent, student } = fam(t, loc, { membership: { expires: '2026-10-14' } });
  const sess = t.fx.session(loc), sess2 = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', capacity: 1 });
  const e1 = t.fx.enroll(student, sess, 1), e3 = t.fx.enroll(student, sess, 3);
  const old = t.fx.enroll(student, sess2, 2, { status: 'dropped' });
  const w = wait(t, student, sess2, 4);
  const other = fam(t, loc, { name: 'Ana Ruiz' });
  const eo = t.fx.enroll(other.student, sess, 1);
  t.fx.enroll(other.student, sess2, 4); // Thursday is full, so no other job can move Leo off its waitlist

  t.jobs(); // still the last valid day
  assert.equal(enr(t, e1).status, 'active');
  assert.equal(kinds(t, parent, 'membership_expired').length, 0);

  t.clock.set(at(LA, '2026-10-15', '00:05'));
  t.jobs(); t.jobs();
  assert.equal(enr(t, e1).status, 'paused');
  assert.equal(enr(t, e3).status, 'paused');
  assert.equal(enr(t, old).status, 'dropped');
  assert.equal(enr(t, eo).status, 'active');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ?').get(student.id).n, 3);
  assert.equal(t.db.prepare('SELECT status FROM waitlist WHERE id = ?').get(w.id).status, 'waiting');
  assert.equal(row(t, student).status, 'active'); // the record itself is untouched; it is just past its last day
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_expired');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's membership has ended");
    assert.match(n[0].body, /2 weekly sessions are paused/);
  }
  assert.equal(kinds(t, other.parent, 'membership_expired').length, 0);
});

test('MB-5', 'expiry pauses on each location\'s own date', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '22:30') }); // Toronto: Oct 15, 01:30
  const la = t.fx.location({ timezone: LA }), tor = t.fx.location({ timezone: TOR });
  const fl = fam(t, la, { membership: { expires: '2026-10-14' } });
  const ft = fam(t, tor, { name: 'Noah Roy', membership: { expires: '2026-10-14' } });
  const el = t.fx.enroll(fl.student, t.fx.session(la), 1), et = t.fx.enroll(ft.student, t.fx.session(tor), 1);
  t.jobs();
  assert.equal(enr(t, et).status, 'paused');
  assert.equal(enr(t, el).status, 'active');
});

test(['MB-5', 'MB-2'], 'staff setting a membership inactive pauses enrollments right away, keeps waitlist places, and tells the family', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { parent, student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc), sess2 = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', capacity: 1 });
  const e1 = t.fx.enroll(student, sess, 1), e3 = t.fx.enroll(student, sess, 3);
  const w = wait(t, student, sess2, 2);

  const r = await t.as(staff).put(url(student), body({ status: 'inactive' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.paused, 2);
  assert.equal(r.body.membership.state, 'inactive');
  assert.equal(r.body.active_slots, 0);
  assert.equal(r.body.paused_slots, 2);
  assert.equal(enr(t, e1).status, 'paused');
  assert.equal(enr(t, e3).status, 'paused');
  assert.equal(t.db.prepare('SELECT status FROM waitlist WHERE id = ?').get(w.id).status, 'waiting');
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_paused');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's weekly sessions are paused");
    assert.match(n[0].body, /2 weekly sessions are on hold/);
  }
  // Another save while still inactive has nothing new to pause and sends nothing.
  const again = await t.as(staff).put(url(student), body({ status: 'inactive', weekly_cap: 4 }));
  assert.equal(again.body.paused, 0);
  assert.equal(kinds(t, parent, 'membership_paused').length, 1);
});

test('MB-5', 'a last day set in the past pauses at once; a last day of today keeps sessions running', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc);
  const past = fam(t, loc), today = fam(t, loc, { name: 'Ana Ruiz' });
  const ep = t.fx.enroll(past.student, sess, 1), et = t.fx.enroll(today.student, sess, 1);
  const r = await t.as(staff).put(url(past.student), body({ expires_on: '2026-10-13' }));
  assert.equal(r.body.membership.state, 'expired');
  assert.equal(enr(t, ep).status, 'paused');
  const k = await t.as(staff).put(url(today.student), body({ expires_on: '2026-10-14' }));
  assert.equal(k.body.membership.state, 'ending');
  assert.equal(enr(t, et).status, 'active');
  assert.equal(kinds(t, today.parent, 'membership_paused').length, 0);
});

test(['MB-5', 'NF-2'], 'reactivating restores slots with a free seat; a full slot puts the student at the front of its waitlist', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive' } });
  const pm = t.fx.session(loc, { name: 'Afternoon Study', weekdays: '1,3,5', start: '13:00', capacity: 2 });
  const quiet = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  const eMon = t.fx.enroll(student, pm, 1, { status: 'paused' });
  const eTue = t.fx.enroll(student, quiet, 2, { status: 'paused' });
  const eThu = t.fx.enroll(student, quiet, 4, { status: 'paused' });
  // Monday has one seat left; Tuesday and Thursday filled up while Leo was paused.
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, pm, 1);
  t.fx.enroll(fam(t, loc, { name: 'Ben Ito' }).student, quiet, 2);
  t.fx.enroll(fam(t, loc, { name: 'Cal Moss' }).student, quiet, 4);
  const early = fam(t, loc, { name: 'Dee Park' }).student;
  wait(t, early, quiet, 2, { created_at: t.clock.now() - 86400000 });
  const already = wait(t, student, quiet, 4); // Leo was also waiting on Thursday

  const r = await t.as(staff).put(url(student), body({ status: 'active' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 1);
  assert.equal(r.body.waitlisted, 2);
  assert.equal(enr(t, eMon).status, 'active');
  assert.equal(enr(t, eTue).status, 'dropped');
  assert.equal(enr(t, eTue).ended_at, t.clock.now());
  assert.equal(enr(t, eThu).status, 'dropped');

  const tue = line(t, quiet, 2);
  assert.deepEqual(tue.map(w => w.student_id), [student.id, early.id]);
  assert.equal(tue[0].priority, 1);
  assert.equal(tue[0].created_by, staff.id);
  const thu = line(t, quiet, 4);
  assert.deepEqual(thu.map(w => [w.id, w.student_id, w.priority]), [[already.id, student.id, 1]]);

  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_restored');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's membership is active again");
    assert.match(n[0].body, /Back on the schedule: Afternoon Study \(Mon 1:00 PM\)\./);
    assert.match(n[0].body, /first on the waitlist for: Quiet Room \(Tue 4:30 PM\), Quiet Room \(Thu 4:30 PM\)\./);
  }
  assert.equal(t.fx.audit('membership.update').length, 1);
});

test('MB-5', 'renewing an expired membership brings its paused sessions back', async () => {
  const t = await makeApp({ now: at(LA, '2026-10-15', '08:00') });
  const loc = t.fx.location();
  const { parent, student } = fam(t, loc, { membership: { start: '2026-08-01', expires: '2026-10-14' } });
  const e = t.fx.enroll(student, t.fx.session(loc), 1);
  t.jobs();
  assert.equal(enr(t, e).status, 'paused');
  const r = await t.as(t.fx.staff(loc)).put(url(student), body({ start_date: '2026-08-01', expires_on: '2027-06-30' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 1);
  assert.equal(enr(t, e).status, 'active');
  const n = kinds(t, parent, 'membership_restored');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "Leo's sessions are back on");
});

// D-3 / EN-4 still hold on renewal: restoring never takes a student past the weekly limit.
const activeNow = (t, s) => t.db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ? AND status = 'active'").get(s.id).n;

test(['MB-5', 'MB-2'], 'reactivating with a weekly limit below the paused count restores only up to the limit; the rest stay paused and saved', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive', cap: 3 } });
  const pm = t.fx.session(loc, { name: 'Afternoon Study', weekdays: '1,3', start: '13:00' });
  const quiet = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2', start: '16:30', end: '18:30', capacity: 1 });
  const eMon = t.fx.enroll(student, pm, 1, { status: 'paused' });
  const eWed = t.fx.enroll(student, pm, 3, { status: 'paused' });
  const eTue = t.fx.enroll(student, quiet, 2, { status: 'paused' });
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, quiet, 2); // Tuesday filled up while Leo was paused
  const statuses = () => [eMon, eWed, eTue].map(e => enr(t, e).status);
  const waits = () => t.db.prepare("SELECT * FROM waitlist WHERE student_id = ? AND status = 'waiting'").all(student.id);
  const restoredNotes = () => kinds(t, parent, 'membership_restored');

  const r = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 1 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 1);
  assert.equal(r.body.waitlisted, 0);
  assert.equal(r.body.kept_paused, 2);
  assert.equal(r.body.active_slots, 1);
  assert.equal(r.body.paused_slots, 2);
  assert.deepEqual(statuses(), ['active', 'paused', 'paused']);
  assert.equal(activeNow(t, student), 1);
  assert.equal(enr(t, eWed).ended_at, null);
  assert.equal(enr(t, eTue).ended_at, null);
  assert.equal(waits().length, 0); // over the limit, so not put in line for the full Tuesday either
  for (const u of [parent, student]) {
    const n = kinds(t, u, 'membership_restored');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Leo's sessions are back on");
    assert.match(n[0].body, /Back on the schedule: Afternoon Study \(Mon 1:00 PM\)\./);
    assert.match(n[0].body, /Still paused, because Leo's membership allows 1 weekly session: Afternoon Study \(Wed 1:00 PM\), Quiet Room \(Tue 4:30 PM\)\./);
    assert.match(n[0].body, /They stay saved/);
  }

  // Saving again with the same limit brings nothing back and sends nothing new.
  const again = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 1 }));
  assert.equal(again.body.restored, 0);
  assert.equal(again.body.kept_paused, 2);
  assert.deepEqual(statuses(), ['active', 'paused', 'paused']);
  assert.equal(restoredNotes().length, 1);

  // Raising the limit brings the saved ones back, up to the new limit.
  const up = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 2 }));
  assert.equal(up.body.restored, 1);
  assert.equal(up.body.waitlisted, 0);
  assert.equal(up.body.kept_paused, 1);
  assert.deepEqual(statuses(), ['active', 'active', 'paused']);
  assert.equal(activeNow(t, student), 2);
  assert.equal(waits().length, 0);
  const n2 = restoredNotes();
  assert.equal(n2.length, 2);
  assert.match(n2[1].body, /Back on the schedule: Afternoon Study \(Wed 1:00 PM\)\./);
  assert.match(n2[1].body, /allows 2 weekly sessions: Quiet Room \(Tue 4:30 PM\)\. It stays saved/);

  // With room under the limit, the full slot goes to the front of its line as before.
  const three = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 3 }));
  assert.equal(three.body.restored, 0);
  assert.equal(three.body.waitlisted, 1);
  assert.equal(three.body.kept_paused, 0);
  assert.deepEqual(statuses(), ['active', 'active', 'dropped']);
  assert.deepEqual(waits().map(w => [w.session_id, w.weekday, w.priority]), [[quiet.id, 2, 1]]);
  assert.equal(activeNow(t, student), 2);
});

test('MB-5', 'the weekly limit counts current and upcoming terms together, the way enrollment does, so renewal never restores past it', async () => {
  const t = await makeApp(); // Wed 2026-10-14, during Fall
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const fall = t.fx.term(loc), spring = t.fx.term(loc, { name: 'Spring 2027', start: '2027-01-11', end: '2027-05-28' });
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive', cap: 2 } });
  const fs = t.fx.session(loc, { term: fall, weekdays: '1,3' }), ss = t.fx.session(loc, { term: spring, name: 'Spring Study', weekdays: '1,3' });
  const es = [t.fx.enroll(student, fs, 1, { status: 'paused' }), t.fx.enroll(student, fs, 3, { status: 'paused' }),
    t.fx.enroll(student, ss, 1, { status: 'paused' }), t.fx.enroll(student, ss, 3, { status: 'paused' })];

  // The staff screen counts all four as paused, so its preview offers "2 of 4".
  const before = await t.as(staff).get(url(student));
  assert.deepEqual([before.body.active_slots, before.body.paused_slots], [0, 4]);

  const r = await t.as(staff).put(url(student), body({ status: 'active', weekly_cap: 2 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 2);
  assert.equal(r.body.waitlisted, 0);
  assert.equal(r.body.kept_paused, 2);
  assert.deepEqual([r.body.active_slots, r.body.paused_slots], [2, 2]);
  assert.deepEqual(es.map(e => enr(t, e).status), ['active', 'active', 'paused', 'paused']);
  assert.deepEqual(es.slice(2).map(e => enr(t, e).ended_at), [null, null]);
  assert.equal(activeNow(t, student), 2);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE student_id = ?').get(student.id).n, 0);
  const n = kinds(t, parent, 'membership_restored');
  assert.equal(n.length, 1);
  assert.match(n[0].body, /Back on the schedule: Afternoon Study \(Mon 1:00 PM\), Afternoon Study \(Wed 1:00 PM\)\./);
  assert.match(n[0].body, /allows 2 weekly sessions: Spring Study \(Mon 1:00 PM\), Spring Study \(Wed 1:00 PM\)\. They stay saved/);

  // Slots already held in an upcoming term count too: Ana holds two Spring slots, so her paused Fall slot stays paused.
  const other = fam(t, loc, { name: 'Ana Ruiz', membership: { cap: 2 } });
  const sMon = t.fx.enroll(other.student, ss, 1), sWed = t.fx.enroll(other.student, ss, 3);
  const fMon = t.fx.enroll(other.student, fs, 1, { status: 'paused' });
  const o = await t.as(staff).put(url(other.student), body({ status: 'active', weekly_cap: 2 }));
  assert.equal(o.status, 200);
  assert.deepEqual([o.body.restored, o.body.waitlisted, o.body.kept_paused], [0, 0, 1]);
  assert.deepEqual([sMon, sWed, fMon].map(e => enr(t, e).status), ['active', 'active', 'paused']);
});

test('MB-5', 'on renewal, slots still marked active in a term that has ended hold nothing against the weekly limit', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location();
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' }), fall = t.fx.term(loc);
  const { student } = fam(t, loc, { membership: { cap: 1 } });
  const old = t.fx.enroll(student, t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '2' }), 2); // still 'active', term over
  const eFall = t.fx.enroll(student, t.fx.session(loc, { term: fall, weekdays: '1' }), 1, { status: 'paused' });
  const r = await t.as(t.fx.staff(loc)).put(url(student), body({ status: 'active', weekly_cap: 1 }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.restored, r.body.kept_paused], [1, 0]);
  assert.deepEqual([r.body.active_slots, r.body.paused_slots], [1, 0]);
  assert.equal(enr(t, eFall).status, 'active');
  assert.equal(enr(t, old).status, 'active');
});

test('MB-5', 'renewal leaves a paused session from a term that has ended alone: not restored, not waitlisted, not announced, not counted', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' }), fall = t.fx.term(loc);
  const { parent, student } = fam(t, loc, { membership: { status: 'inactive' } });
  const lab = t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '2,4', capacity: 1 });
  const pm = t.fx.session(loc, { term: fall, name: 'Afternoon Study', weekdays: '1' });
  const eFall = t.fx.enroll(student, pm, 1, { status: 'paused' });
  const eTue = t.fx.enroll(student, lab, 2, { status: 'paused' }); // had a free seat
  const eThu = t.fx.enroll(student, lab, 4, { status: 'paused' }); // full
  t.fx.enroll(fam(t, loc, { name: 'Ana Ruiz' }).student, lab, 4);

  const before = await t.as(staff).get(url(student));
  assert.equal(before.body.paused_slots, 1);
  assert.equal(before.body.active_slots, 0);

  const r = await t.as(staff).put(url(student), body({ status: 'active' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, 1);
  assert.equal(r.body.waitlisted, 0);
  assert.equal(r.body.kept_paused, 0);
  assert.equal(r.body.active_slots, 1);
  assert.equal(r.body.paused_slots, 0);
  assert.equal(enr(t, eFall).status, 'active');
  assert.equal(enr(t, eTue).status, 'paused');
  assert.equal(enr(t, eThu).status, 'paused');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE student_id = ?').get(student.id).n, 0);
  const n = kinds(t, parent, 'membership_restored');
  assert.equal(n.length, 1);
  assert.match(n[0].body, /Back on the schedule: Afternoon Study \(Mon 1:00 PM\)\./);
  assert.doesNotMatch(n[0].body, /Summer Lab/);

  const roster = await t.as(staff).get('/api/membership/roster');
  const me = roster.body.students.find(s => s.id === student.id);
  assert.deepEqual([me.active_slots, me.paused_slots], [1, 0]);
});

test(['MB-5', 'MB-1', 'MB-3'], "an evening save in Los Angeles goes by Los Angeles' date, a day behind UTC", async () => {
  // Wed Oct 14 at 17:30 in Los Angeles is already 00:30 UTC on Oct 15.
  const t = await makeApp({ now: at(LA, '2026-10-14', '17:30') });
  const loc = t.fx.location({ timezone: LA });
  const { parent, student } = fam(t, loc);
  const staff = t.fx.staff(loc);
  const e = t.fx.enroll(student, t.fx.session(loc), 1);

  // Today is the last valid day: sessions keep running, and everyone sees 0 days left.
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

test('MB-5', 'pausing leaves slots from a term that has ended alone, so the family is told only about real weekly sessions', async () => {
  const t = await makeApp(); // Wed 2026-10-14
  const loc = t.fx.location();
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' }), fall = t.fx.term(loc);
  const lab = t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '2' });
  const pm = t.fx.session(loc, { term: fall, weekdays: '1,3' });

  // Staff set a membership inactive.
  const a = fam(t, loc);
  const aOld = t.fx.enroll(a.student, lab, 2); // still marked active, but its term is over
  const aNow = t.fx.enroll(a.student, pm, 1);
  const r = await t.as(t.fx.staff(loc)).put(url(a.student), body({ status: 'inactive' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.paused, 1);
  assert.deepEqual([enr(t, aNow).status, enr(t, aOld).status], ['paused', 'active']);
  assert.match(kinds(t, a.parent, 'membership_paused')[0].body, /, so 1 weekly session is on hold\./);

  // The expiry job, once the last day has passed.
  const b = fam(t, loc, { name: 'Ana Ruiz', membership: { expires: '2026-10-13' } });
  const bOld = t.fx.enroll(b.student, lab, 2);
  const bNow = t.fx.enroll(b.student, pm, 3);
  t.jobs();
  assert.deepEqual([enr(t, bNow).status, enr(t, bOld).status], ['paused', 'active']);
  assert.match(kinds(t, b.parent, 'membership_expired')[0].body, /\. 1 weekly session is paused and saved/);
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

// ---------------- R1 / D-3: the weekly limit is a hard cap ----------------

test(['MB-1', 'MB-2'], 'staff can\'t lower the weekly limit below the weekly sessions a student holds; the refusal names how many they hold', async () => {
  const t = await makeApp(); // Wed 2026-10-14, during Fall
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const { parent, student } = fam(t, loc, { membership: { cap: 4, start: '2026-08-01', expires: '2027-06-30' } });
  const sess = t.fx.session(loc, { weekdays: '1,2,3,4' });
  const es = [1, 2, 3, 4].map(d => t.fx.enroll(student, sess, d));
  const statuses = () => es.map(e => enr(t, e).status);
  const msg = "Leo holds 4 weekly sessions, so the weekly limit can't go below 4. A parent can drop sessions on Schedule first, then you can lower the limit.";

  for (const cap of [2, 3]) {
    const r = await t.as(staff).put(url(student), body({ weekly_cap: cap, start_date: '2026-08-01' }));
    assert.equal(r.status, 409, String(cap));
    assert.equal(r.body.error, 'weekly_cap_below_held');
    assert.equal(r.body.message, msg);
  }
  assert.equal(row(t, student).weekly_cap, 4);
  assert.deepEqual(statuses(), ['active', 'active', 'active', 'active']);
  assert.equal(t.fx.audit('membership.update').length, 0);
  assert.equal(t.fx.notifications(parent).length, 0);

  // Not below what they hold: saved.
  const same = await t.as(staff).put(url(student), body({ weekly_cap: 4, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  assert.equal(same.status, 200);
  assert.equal(row(t, student).expires_on, '2027-08-31');

  // A dropped slot, or one from a term that has ended, holds nothing against the limit.
  t.db.prepare("UPDATE enrollments SET status = 'dropped' WHERE id = ?").run(es[3].id);
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' });
  t.fx.enroll(student, t.fx.session(loc, { term: summer, name: 'Summer Lab', weekdays: '5' }), 5);
  const down = await t.as(staff).put(url(student), body({ weekly_cap: 3, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  assert.equal(down.status, 200);
  assert.equal(row(t, student).weekly_cap, 3);
  const two = await t.as(staff).put(url(student), body({ weekly_cap: 2, start_date: '2026-08-01', expires_on: '2027-08-31' }));
  assert.equal(two.status, 409);
  assert.match(two.body.message, /^Leo holds 3 weekly sessions, so the weekly limit can't go below 3\./);
});

test(['MB-2', 'MB-5'], 'a lower weekly limit is saved when the same save pauses the sessions, and an edit that keeps the limit is never refused', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const staff = t.fx.staff(loc);
  const sess = t.fx.session(loc, { weekdays: '1,2,3' });
  // Setting the membership inactive pauses every slot, so a lower limit leaves nothing over it.
  const a = fam(t, loc, { name: 'Ana Ruiz', membership: { cap: 3 } });
  [1, 2, 3].forEach(d => t.fx.enroll(a.student, sess, d));
  const off = await t.as(staff).put(url(a.student), body({ status: 'inactive', weekly_cap: 1, start_date: '2026-08-01' }));
  assert.equal(off.status, 200);
  assert.equal(off.body.paused, 3);
  assert.equal(row(t, a.student).weekly_cap, 1);

  // A student already over the limit (held before this rule) can still be renewed at the same limit.
  const b = fam(t, loc, { name: 'Ben Okafor', membership: { cap: 2, expires: '2026-10-20' } });
  [1, 2, 3].forEach(d => t.fx.enroll(b.student, sess, d));
  const renew = await t.as(staff).put(url(b.student), body({ weekly_cap: 2, start_date: '2026-08-01', expires_on: '2027-06-30' }));
  assert.equal(renew.status, 200);
  assert.equal(row(t, b.student).expires_on, '2027-06-30');
  const lower = await t.as(staff).put(url(b.student), body({ weekly_cap: 1, start_date: '2026-08-01', expires_on: '2027-06-30' }));
  assert.equal(lower.status, 409);
  assert.equal(lower.body.message, "Ben holds 3 weekly sessions, so the weekly limit can't go below 3. A parent can drop sessions on Schedule first, then you can lower the limit.");
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

test(['MB-3', 'MB-5'], "a student whose membership lapsed reads on Home the same words Schedule uses: it isn't active, the sessions are paused, and who renews it", async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const sess = t.fx.session(loc);
  const lapsed = fam(t, loc, { name: 'Daniel Kim', membership: { status: 'inactive' } });
  t.fx.enroll(lapsed.student, sess, 1, { status: 'paused' });
  const expired = fam(t, loc, { name: 'Ana Ruiz', membership: { expires: '2026-10-13' } });
  const card = async u => words((await openTab(t, u, '#/home')).getElementById('main').find(n => n.getAttribute('data-card') === 'membership'));
  assert.match(await card(lapsed.student), /Your membership isn't active, so your sessions are paused\. Ask a parent or the front desk at Irvine to renew it\.$/);
  assert.match(await card(expired.student), /Last day: Tue, Oct 13, 2026 Your membership isn't active\. Ask a parent or the front desk at Irvine to renew it\.$/);
  // Parents still get the details and what renewing does.
  assert.match(await card(lapsed.parent), /Daniel's membership isn't active right now\. 1 weekly session is paused and saved\. Renew with the front desk at Irvine to bring it back\.$/);
});

test(['MB-1', 'MB-2'], 'the edit screen warns before saving a weekly limit below the sessions the student holds, in the words the refusal uses', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const { student } = fam(t, loc, { membership: { cap: 4 } });
  const sess = t.fx.session(loc, { weekdays: '1,2,3,4' });
  [1, 2, 3, 4].forEach(d => t.fx.enroll(student, sess, d));
  const doc = await openTab(t, t.fx.staff(loc), '#/members/' + student.id);
  const main = doc.getElementById('main');
  const cap = main.find(n => n.id === 'mb-cap');
  const effect = () => words(main.find(n => n.getAttribute('aria-live') === 'polite'));
  assert.equal(effect(), '');
  cap.value = '2';
  cap.dispatch('input');
  assert.ok(main.find(n => n.cls.includes('notice-danger')), 'a notice says the save will be refused');
  assert.equal(effect(), "Leo holds 4 weekly sessions, so the weekly limit can't go below 4. A parent can drop sessions on Schedule first, then you can lower the limit.");
  cap.value = '4';
  cap.dispatch('input');
  assert.equal(effect(), '');
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
  assert.match(words(now), /^Right now Starts Mon, Nov 2, 2026 Up to 2 sessions a week · Mon, Nov 2, 2026 through Wed, Jun 30, 2027 Not active until Mon, Nov 2, 2026, so Ben can't enroll in sessions or check in before then\./);

  const card = async u => words((await openTab(t, u, '#/home')).getElementById('main').find(n => n.getAttribute('data-card') === 'membership'));
  assert.match(await card(parent), /Ben Okafor Starts Mon, Nov 2, 2026 Up to 2 sessions a week Valid through Wed, Jun 30, 2027 Ben's membership starts Mon, Nov 2, 2026\. Ben can enroll in sessions and check in from that day\.$/);
  assert.match(await card(student), /Your membership starts Mon, Nov 2, 2026\. You can enroll in sessions and check in from that day\.$/);
});
