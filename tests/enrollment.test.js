'use strict';
// Enrollment and waitlists (PRD 3): EN-1..EN-7, NF-1, NF-3.
// Default clock: Wed 14 Oct 2026 10:00 in Los Angeles. The default session
// meets Mon/Wed/Fri 13:00-16:00 in the Fall 2026 term (Aug 17 - Dec 18).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, at, load, ROOT } = require('./lib');

const LA = 'America/Los_Angeles';

async function world({ capacity = 10 } = {}) {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const sess = t.fx.session(loc, { capacity });
  return { t, loc, sess };
}
const enroll = (t, parent, student, session, weekday) =>
  t.as(parent).post('/api/enrollment/enroll', { studentId: student.id, sessionId: session.id, weekday });
const joinLine = (t, parent, student, session, weekday) =>
  t.as(parent).post('/api/enrollment/waitlist', { studentId: student.id, sessionId: session.id, weekday });
const drop = (t, parent, enrollmentId) => t.as(parent).post(`/api/enrollment/enrollments/${enrollmentId}/drop`);
const active = (t, student) => t.db.prepare("SELECT * FROM enrollments WHERE student_id = ? AND status = 'active' ORDER BY id").all(student.id);
const seats = (t, session, wd) => t.db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND weekday = ? AND status = 'active'").get(session.id, wd).n;
const lineRow = (t, student, session, wd) => t.db.prepare('SELECT * FROM waitlist WHERE student_id = ? AND session_id = ? AND weekday = ? ORDER BY id DESC').get(student.id, session.id, wd);
const fill = (t, loc, session, wd, n) => Array.from({ length: n }, () => { const f = t.fx.family(loc); t.fx.enroll(f.student, session, wd); return f; });
const snapshot = t => JSON.stringify(['enrollments', 'waitlist', 'enrollment_requests'].map(tb => t.db.prepare(`SELECT * FROM ${tb} ORDER BY id`).all()));

// ---------------------------------------------------------------- EN-1, EN-2

test(['EN-1', 'EN-2'], 'a parent enrolls a student in a weekly slot that repeats every week for the rest of the term', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const r = await enroll(t, f.parent, f.student, sess, 1);
  assert.equal(r.status, 201);
  assert.equal(r.body.outcome, 'enrolled');
  const rows = active(t, f.student);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, sess.id);
  assert.equal(rows[0].weekday, 1);
  assert.equal(rows[0].source, 'parent');
  assert.equal(rows[0].created_by, f.parent.id);
  // Every Monday from next week through the end of the term (Dec 18), nothing after.
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-10-14&to=2026-12-31`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.occurrences.map(o => o.date),
    ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']);
  assert.ok(s.body.occurrences.every(o => o.status === 'upcoming' && o.start_time === '13:00'));
  // The family overview shows the weekly slot and the cap in use.
  const fam = await t.as(f.parent).get('/api/enrollment/students');
  assert.equal(fam.status, 200);
  assert.deepEqual(fam.body.students.map(x => x.id), [f.student.id]);
  assert.deepEqual(fam.body.students[0].enrollments.map(e => [e.session_id, e.weekday, e.status]), [[sess.id, 1, 'active']]);
  assert.equal(fam.body.students[0].membership.used, 1);
  assert.equal(fam.body.students[0].membership.weekly_cap, 3);
  assert.equal(fam.body.students[0].membership.can_add, true);
});

test(['EN-1'], 'enrollment is for a day the session meets every week, never a single date', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const tue = await enroll(t, f.parent, f.student, sess, 2); // session meets Mon/Wed/Fri
  assert.equal(tue.status, 400);
  assert.equal(tue.body.error, 'bad_weekday');
  const date = await t.as(f.parent).post('/api/enrollment/enroll', { studentId: f.student.id, sessionId: sess.id, date: '2026-10-19' });
  assert.equal(date.status, 400);
  assert.equal(date.body.error, 'bad_weekday');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
});

test(['EN-1'], 'clear refusals for a cancelled session, an ended term, or a slot already held', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-07' });
  const old = t.fx.session(loc, { term: summer, name: 'Summer Study' });
  const gone = t.fx.session(loc, { name: 'Evening Study' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(gone.id);
  const a = await enroll(t, f.parent, f.student, old, 1);
  assert.equal(a.status, 409);
  assert.equal(a.body.error, 'term_over');
  const b = await enroll(t, f.parent, f.student, gone, 1);
  assert.equal(b.status, 409);
  assert.equal(b.body.error, 'session_cancelled');
  assert.equal((await enroll(t, f.parent, f.student, sess, 1)).status, 201);
  const c = await enroll(t, f.parent, f.student, sess, 1);
  assert.equal(c.status, 409);
  assert.equal(c.body.error, 'already_enrolled');
  assert.equal(active(t, f.student).length, 1);
});

test(['EN-2'], 'the whole family is notified when a student is enrolled', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const guardian = t.fx.user('parent', { location: loc });
  t.fx.link(guardian, f.student);
  const r = await enroll(t, f.parent, f.student, sess, 1);
  assert.equal(r.status, 201);
  for (const u of [f.parent, guardian, f.student]) {
    const n = t.fx.notifications(u, 'enrollment_confirmed');
    assert.equal(n.length, 1, 'one confirmation for ' + u.role);
    assert.match(n[0].title, new RegExp(f.student.name.split(' ')[0] + ' is enrolled in Afternoon Study at Irvine'));
    assert.match(n[0].body, /Mondays 1pm–4pm, every week through Dec 18, 2026/);
    assert.equal(n[0].ref_id, r.body.enrollment.id);
  }
});

test(['EN-2', 'NF-1'], 'a parent can only enroll their own linked students', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc), other = t.fx.family(loc);
  const pending = t.fx.user('parent', { location: loc });
  t.fx.link(pending, f.student, 'pending');
  assert.equal((await enroll(t, other.parent, f.student, sess, 1)).status, 403);
  assert.equal((await enroll(t, pending, f.student, sess, 1)).status, 403);
  assert.equal((await t.as(f.student).post('/api/enrollment/enroll', { studentId: f.student.id, sessionId: sess.id, weekday: 1 })).status, 403);
  assert.equal((await enroll(t, t.fx.staff(loc), f.student, sess, 1)).status, 403);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
});

// ---------------------------------------------------------------- EN-4

test(['EN-4'], 'blocked when the membership is inactive or missing, with the reason spelled out', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { status: 'inactive' });
  const r = await enroll(t, f.parent, f.student, sess, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'membership_inactive');
  assert.equal(r.body.outcome, 'blocked');
  assert.match(r.body.message, new RegExp(f.student.name.split(' ')[0] + "'s membership is inactive"));
  const g = t.fx.family(loc);
  t.db.prepare('DELETE FROM memberships WHERE student_id = ?').run(g.student.id);
  const r2 = await enroll(t, g.parent, g.student, sess, 1);
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'no_membership');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test(['EN-4'], "expiry is judged by the location's local date, and the last day still counts", async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '23:30') }); // already Oct 15 in UTC and in Toronto
  const la = t.fx.location({ name: 'Irvine' });
  const to = t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  const sLA = t.fx.session(la), sTO = t.fx.session(to);
  const a = t.fx.family(la, { expires: '2026-10-14' });
  const b = t.fx.family(to, { expires: '2026-10-14' });
  const ok = await enroll(t, a.parent, a.student, sLA, 1);
  assert.equal(ok.status, 201, 'Oct 14 is still the last valid day in Los Angeles');
  const no = await enroll(t, b.parent, b.student, sTO, 1);
  assert.equal(no.status, 409);
  assert.equal(no.body.error, 'membership_expired');
  assert.match(no.body.message, /expired on Oct 14, 2026/);
  assert.equal(active(t, b.student).length, 0);
});

// R6: a membership counts only from start_date through expires_on, by the location's local date.
test(['EN-4', 'EN-3', 'EN-5'], "a membership that hasn't started yet is not active: enrolling, the waitlist and approvals are refused until its first day", async () => {
  const t = await makeApp({ now: at(LA, '2026-10-14', '23:30') }); // already Oct 15 in Toronto
  const la = t.fx.location({ name: 'Irvine' });
  const to = t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  const sLA = t.fx.session(la, { capacity: 1 }), sTO = t.fx.session(to);
  const a = t.fx.family(la, { start: '2026-10-15' });
  const b = t.fx.family(to, { start: '2026-10-15' });
  const no = await enroll(t, a.parent, a.student, sLA, 1);
  assert.equal(no.status, 409, 'Oct 15 has not begun in Los Angeles');
  assert.equal(no.body.error, 'membership_not_started');
  assert.equal(no.body.message, `${a.student.name.split(' ')[0]}'s membership starts on Oct 15, 2026. Sessions can be added from that day.`);
  assert.equal((await enroll(t, b.parent, b.student, sTO, 1)).status, 201, 'it is already Oct 15 in Toronto');
  // The catalog and the family overview say so before the server is asked.
  const cat = await t.as(a.parent).get(`/api/enrollment/students/${a.student.id}/catalog`);
  assert.deepEqual([cat.body.membership.can_add, cat.body.membership.code, cat.body.membership.start_date], [false, 'membership_not_started', '2026-10-15']);
  assert.ok(cat.body.slots.every(s => s.can_add === false));
  // The waitlist runs the same check, and so does a parent's approval.
  fill(t, la, sLA, 3, 1);
  const w = await joinLine(t, a.parent, a.student, sLA, 3);
  assert.deepEqual([w.status, w.body.error], [409, 'membership_not_started']);
  const r = await t.as(a.student).post('/api/enrollment/requests', { sessionId: sLA.id, weekday: 5 });
  assert.equal(r.status, 201);
  const list = await t.as(a.parent).get('/api/enrollment/requests');
  assert.deepEqual([list.body.requests[0].check.ok, list.body.requests[0].check.code], [false, 'membership_not_started']);
  const ok = await t.as(a.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
  assert.deepEqual([ok.body.outcome, ok.body.code], ['blocked', 'membership_not_started']);
  assert.equal(active(t, a.student).length, 0);
  // A spot paused before the start says why, instead of blaming the weekly limit or asking for a renewal.
  t.fx.enroll(a.student, sLA, 1, { status: 'paused' });
  const p = await enroll(t, a.parent, a.student, sLA, 1);
  assert.equal(p.body.message, `${a.student.name.split(' ')[0]}'s spot in Afternoon Study is paused because the membership doesn't start until Oct 15, 2026.`);
  // From its first day it is active.
  t.clock.set(at(LA, '2026-10-15', '00:05'));
  assert.equal((await enroll(t, a.parent, a.student, sLA, 5)).status, 201);
});

test(['EN-4'], 'the weekly cap is a hard cap on slots held; paused, dropped and past-term slots do not count', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { cap: 2 });
  const tueThu = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-07' });
  t.fx.enroll(f.student, t.fx.session(loc, { term: summer, name: 'Summer Study' }), 1); // still 'active' but last term
  t.fx.enroll(f.student, sess, 3, { status: 'paused' });
  t.fx.enroll(f.student, tueThu, 4, { status: 'dropped' });
  assert.equal((await enroll(t, f.parent, f.student, sess, 1)).status, 201);
  assert.equal((await enroll(t, f.parent, f.student, sess, 5)).status, 201);
  const third = await enroll(t, f.parent, f.student, tueThu, 2);
  assert.equal(third.status, 409);
  assert.equal(third.body.error, 'weekly_cap');
  assert.match(third.body.message, /already has 2 weekly sessions, the most the membership allows/);
  assert.equal(active(t, f.student).filter(e => e.session_id !== sess.id).length, 1); // only the old summer row
  const fam = await t.as(f.parent).get('/api/enrollment/students');
  assert.equal(fam.body.students[0].membership.can_add, false);
  assert.equal(fam.body.students[0].membership.code, 'weekly_cap');
});

test(['EN-4', 'EN-5'], 'joining the waitlist runs the same membership and cap checks', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  fill(t, loc, sess, 1, 1);
  const inactive = t.fx.family(loc, { status: 'inactive' });
  const r = await joinLine(t, inactive.parent, inactive.student, sess, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'membership_inactive');
  const capped = t.fx.family(loc, { cap: 1 });
  t.fx.enroll(capped.student, sess, 3);
  const r2 = await joinLine(t, capped.parent, capped.student, sess, 1);
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'weekly_cap');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n, 0);
});

// D-3: the cap counts every slot the student holds in the current and upcoming
// terms, whichever term the new slot is in. The catalog's can_add must say
// exactly what the server then does.
const winterSessions = (t, loc) => {
  const winter = t.fx.term(loc, { name: 'Winter 2027', start: '2027-01-11', end: '2027-03-19' });
  return {
    winterTue: t.fx.session(loc, { term: winter, name: 'Winter Study', weekdays: '2', start: '15:00', end: '17:00' }),
    winterThu: t.fx.session(loc, { term: winter, name: 'Winter Lab', weekdays: '4', start: '15:00', end: '17:00', capacity: 1 }),
  };
};
const catalogOf = (t, f) => t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/catalog`);
const slotIn = (cat, session, wd) => cat.body.slots.find(s => s.session_id === session.id && s.weekday === wd);

test(['EN-4', 'EN-3', 'EN-5'], 'at the cap in this term, a slot in an upcoming term is blocked, and the catalog says so before the server does', async () => {
  const { t, loc, sess } = await world();
  const { winterTue, winterThu } = winterSessions(t, loc);
  fill(t, loc, winterThu, 4, 1); // Winter Thursdays are full
  const f = t.fx.family(loc, { cap: 2 });
  const mon = await enroll(t, f.parent, f.student, sess, 1);
  assert.equal(mon.status, 201);
  assert.equal((await enroll(t, f.parent, f.student, sess, 3)).status, 201);
  // Both of the cap's slots are in Fall, so nothing else can be added, Fall or Winter.
  let cat = await catalogOf(t, f);
  assert.deepEqual([cat.body.membership.used, cat.body.membership.can_add, cat.body.membership.code], [2, false, 'weekly_cap']);
  assert.deepEqual(cat.body.slots.map(s => [s.name, s.weekday, s.mine, s.can_add]), [
    ['Afternoon Study', 1, 'enrolled', false],
    ['Winter Study', 2, null, false],
    ['Afternoon Study', 3, 'enrolled', false],
    ['Winter Lab', 4, null, false],
    ['Afternoon Study', 5, null, false],
  ]);
  const r = await enroll(t, f.parent, f.student, winterTue, 2);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'weekly_cap');
  assert.match(r.body.message, /already has 2 weekly sessions, the most the membership allows/);
  const w = await joinLine(t, f.parent, f.student, winterThu, 4);
  assert.equal(w.status, 409);
  assert.equal(w.body.error, 'weekly_cap');
  // A student's request gets the same answer: flagged before approval, blocked on approval.
  const req = await t.as(f.student).post('/api/enrollment/requests', { sessionId: winterTue.id, weekday: 2 });
  assert.equal(req.status, 201);
  const list = await t.as(f.parent).get('/api/enrollment/requests');
  assert.deepEqual([list.body.requests[0].check.ok, list.body.requests[0].check.code], [false, 'weekly_cap']);
  const ap = await t.as(f.parent).post(`/api/enrollment/requests/${req.body.request.id}/approve`);
  assert.deepEqual([ap.status, ap.body.outcome, ap.body.code], [200, 'blocked', 'weekly_cap']);
  assert.deepEqual(active(t, f.student).map(e => [e.session_id, e.weekday]), [[sess.id, 1], [sess.id, 3]]);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE student_id = ?').get(f.student.id).n, 0);

  // Dropping a Fall slot frees one: the catalog opens Winter and the server agrees.
  assert.equal((await drop(t, f.parent, mon.body.enrollment.id)).status, 200);
  cat = await catalogOf(t, f);
  assert.deepEqual([cat.body.membership.used, cat.body.membership.can_add], [1, true]);
  assert.deepEqual([slotIn(cat, winterTue, 2).can_add, slotIn(cat, sess, 3).can_add], [true, false]);
  assert.equal((await enroll(t, f.parent, f.student, winterTue, 2)).status, 201);
  cat = await catalogOf(t, f);
  assert.deepEqual([cat.body.membership.used, cat.body.membership.can_add], [2, false]);
  assert.deepEqual([slotIn(cat, winterTue, 2).mine, slotIn(cat, winterTue, 2).can_add, slotIn(cat, sess, 1).can_add], ['enrolled', false, false]);
  const fam = await t.as(f.parent).get('/api/enrollment/students');
  assert.deepEqual([fam.body.students[0].membership.used, fam.body.students[0].membership.can_add], [2, false]);
});

test(['EN-4', 'EN-5'], 'a slot held in an upcoming term uses the cap now: this term is closed, the line skips them, and the catalog matches', async () => {
  const { t, loc, sess } = await world();
  const { winterTue } = winterSessions(t, loc);
  const quiet = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2', start: '16:30', end: '18:30', capacity: 1 });
  const [holder] = fill(t, loc, quiet, 2, 1);
  const f = t.fx.family(loc, { cap: 1 }), g = t.fx.family(loc);
  assert.equal((await joinLine(t, f.parent, f.student, quiet, 2)).body.position, 1); // in line before the Winter slot
  t.clock.advance(60000);
  assert.equal((await joinLine(t, g.parent, g.student, quiet, 2)).body.position, 2);
  assert.equal((await enroll(t, f.parent, f.student, winterTue, 2)).status, 201);
  // The one Winter slot is the whole cap: every Fall slot is closed, and the server agrees slot by slot.
  const cat = await catalogOf(t, f);
  assert.deepEqual([cat.body.membership.used, cat.body.membership.can_add, cat.body.membership.code], [1, false, 'weekly_cap']);
  assert.deepEqual(cat.body.slots.map(s => [s.name, s.weekday, s.mine, s.can_add]), [
    ['Afternoon Study', 1, null, false],
    ['Winter Study', 2, 'enrolled', false],
    ['Quiet Room', 2, 'waiting', false],
    ['Afternoon Study', 3, null, false],
    ['Winter Lab', 4, null, false],
    ['Afternoon Study', 5, null, false],
  ]);
  for (const s of cat.body.slots.filter(x => !x.mine)) {
    const r = await t.as(f.parent).post('/api/enrollment/enroll', { studentId: f.student.id, sessionId: s.session_id, weekday: s.weekday });
    assert.deepEqual([r.status, r.body.error], [409, 'weekly_cap'], `${s.name} on day ${s.weekday}`);
  }
  // A Quiet Room seat opens: first in line, but at the cap, so skipped with the place kept.
  assert.equal((await drop(t, holder.parent, active(t, holder.student)[0].id)).status, 200);
  assert.deepEqual(active(t, f.student).map(e => e.session_id), [winterTue.id]);
  assert.deepEqual(active(t, g.student).map(e => [e.session_id, e.source]), [[quiet.id, 'waitlist']]);
  assert.equal(lineRow(t, f.student, quiet, 2).status, 'waiting');
  assert.equal(t.fx.notifications(f.parent, 'waitlist_promoted').length, 0);
  const fam = await t.as(f.parent).get('/api/enrollment/students');
  assert.deepEqual([fam.body.students[0].membership.used, fam.body.students[0].membership.can_add], [1, false]);
  assert.deepEqual(fam.body.students[0].waitlist.map(x => [x.session_id, x.position]), [[quiet.id, 1]]);
});

// ---------------------------------------------------------------- EN-5, EN-6

test(['EN-5'], 'a full slot offers the waitlist, and places are first come, first served', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  fill(t, loc, sess, 1, 1);
  const a = t.fx.family(loc), b = t.fx.family(loc), c = t.fx.family(loc);
  const full = await enroll(t, a.parent, a.student, sess, 1);
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'full');
  assert.equal(full.body.outcome, 'full');
  assert.match(full.body.message, /is full\. Join the waitlist/);
  assert.equal(active(t, a.student).length, 0);
  const ja = await joinLine(t, a.parent, a.student, sess, 1);
  assert.equal(ja.status, 201);
  assert.equal(ja.body.outcome, 'waitlisted');
  assert.equal(ja.body.position, 1);
  const jb = await joinLine(t, b.parent, b.student, sess, 1);
  assert.equal(jb.body.position, 2);
  const jc = await joinLine(t, c.parent, c.student, sess, 1);
  assert.equal(jc.body.position, 3);
  const again = await joinLine(t, b.parent, b.student, sess, 1);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_waiting');
  // b's catalog shows where they stand; enrolling again just repeats the line position.
  const cat = await t.as(b.parent).get(`/api/enrollment/students/${b.student.id}/catalog`);
  const mon = cat.body.slots.find(s => s.session_id === sess.id && s.weekday === 1);
  assert.deepEqual([mon.mine, mon.position, mon.waiting, mon.seats_left], ['waiting', 2, 3, 0]);
  const fam = await t.as(b.parent).get('/api/enrollment/students');
  assert.deepEqual(fam.body.students[0].waitlist.map(w => [w.session_id, w.weekday, w.position, w.in_line]), [[sess.id, 1, 2, 3]]);
  // Leaving the line moves everyone behind up.
  const leave = await t.as(a.parent).post(`/api/enrollment/waitlist/${ja.body.waitlist.id}/leave`);
  assert.equal(leave.status, 200);
  assert.equal(lineRow(t, a.student, sess, 1).status, 'removed');
  const cat2 = await t.as(b.parent).get(`/api/enrollment/students/${b.student.id}/catalog`);
  assert.equal(cat2.body.slots.find(s => s.session_id === sess.id && s.weekday === 1).position, 1);
});

test(['EN-5', 'EN-6'], 'dropping frees the seat, and the first family in line is enrolled automatically and notified', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const holder = t.fx.family(loc);
  const e = t.fx.enroll(holder.student, sess, 1);
  const a = t.fx.family(loc), b = t.fx.family(loc);
  assert.equal((await joinLine(t, a.parent, a.student, sess, 1)).status, 201);
  t.clock.advance(60000);
  assert.equal((await joinLine(t, b.parent, b.student, sess, 1)).status, 201);
  t.clock.advance(60000);
  const r = await drop(t, holder.parent, e.id);
  assert.equal(r.status, 200);
  const dropped = t.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e.id);
  assert.equal(dropped.status, 'dropped');
  assert.equal(dropped.ended_at, t.clock.now());
  const got = active(t, a.student);
  assert.equal(got.length, 1);
  assert.equal(got[0].source, 'waitlist');
  assert.equal(lineRow(t, a.student, sess, 1).status, 'enrolled');
  assert.equal(lineRow(t, a.student, sess, 1).resolved_at, t.clock.now());
  assert.equal(lineRow(t, b.student, sess, 1).status, 'waiting');
  assert.equal(seats(t, sess, 1), 1);
  for (const u of [a.parent, a.student]) {
    const n = t.fx.notifications(u, 'waitlist_promoted');
    assert.equal(n.length, 1);
    assert.match(n[0].title, /A seat opened: .* is now enrolled in Afternoon Study/);
  }
  assert.equal(t.fx.notifications(b.parent).length, 0);
  assert.equal(t.fx.notifications(holder.parent).length, 0);
});

test(['EN-5'], 'an ineligible family at the front is skipped but keeps its place', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const holder = t.fx.family(loc);
  const e = t.fx.enroll(holder.student, sess, 1);
  const a = t.fx.family(loc), b = t.fx.family(loc);
  await joinLine(t, a.parent, a.student, sess, 1);
  t.clock.advance(60000);
  await joinLine(t, b.parent, b.student, sess, 1);
  t.fx.membership(a.student, { status: 'inactive' }); // lapsed while waiting
  assert.equal((await drop(t, holder.parent, e.id)).status, 200);
  assert.equal(active(t, a.student).length, 0);
  assert.equal(active(t, b.student).length, 1);
  assert.equal(lineRow(t, a.student, sess, 1).status, 'waiting');
  const cat = await t.as(a.parent).get(`/api/enrollment/students/${a.student.id}/catalog`);
  assert.equal(cat.body.slots.find(s => s.session_id === sess.id && s.weekday === 1).position, 1);
  // Renewed, and the next free seat is theirs.
  t.fx.membership(a.student, { status: 'active' });
  t.db.prepare('UPDATE sessions SET capacity = 2 WHERE id = ?').run(sess.id);
  t.jobs();
  assert.equal(active(t, a.student).length, 1);
});

test(['EN-5'], 'a renewed membership waiting at the front goes first, and its paused spot comes back', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const holder = t.fx.family(loc);
  const e = t.fx.enroll(holder.student, sess, 1);
  const early = t.fx.family(loc), renewed = t.fx.family(loc);
  await joinLine(t, early.parent, early.student, sess, 1);
  t.clock.advance(60000);
  // D-16: the renewed student's paused spot is at the front of the line.
  const paused = t.fx.enroll(renewed.student, sess, 1, { status: 'paused' });
  t.db.prepare('INSERT INTO waitlist (student_id, session_id, weekday, priority, created_at) VALUES (?,?,?,?,?)')
    .run(renewed.student.id, sess.id, 1, 1, t.clock.now());
  await drop(t, holder.parent, e.id);
  const rows = t.db.prepare('SELECT * FROM enrollments WHERE student_id = ? ORDER BY id').all(renewed.student.id);
  assert.deepEqual(rows.map(r => [r.id, r.status]), [[paused.id, 'active']]);
  assert.equal(active(t, early.student).length, 0);
  assert.equal(lineRow(t, early.student, sess, 1).status, 'waiting');
});

test(['EN-5', 'NF-3'], 'the scheduled job fills seats freed by a capacity raise or a lapsed membership, never past capacity', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const [holder] = fill(t, loc, sess, 1, 1);
  const fams = [t.fx.family(loc), t.fx.family(loc), t.fx.family(loc)];
  for (const f of fams) { await joinLine(t, f.parent, f.student, sess, 1); t.clock.advance(60000); }
  t.db.prepare('UPDATE sessions SET capacity = 3 WHERE id = ?').run(sess.id);
  const ran = t.jobs();
  assert.ok(ran.includes('enrollment.promote-waitlists'));
  assert.deepEqual(fams.map(f => active(t, f.student).length), [1, 1, 0]);
  assert.equal(seats(t, sess, 1), 3);
  // The holder's membership lapses: their enrollment is paused and no longer holds a seat (MB-5).
  t.fx.membership(holder.student, { status: 'inactive' });
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE student_id = ?").run(holder.student.id);
  t.jobs();
  assert.deepEqual(fams.map(f => active(t, f.student).length), [1, 1, 1]);
  assert.equal(seats(t, sess, 1), 3);
  assert.equal(t.fx.notifications(fams[2].parent, 'waitlist_promoted').length, 1);
});

test(['EN-5'], 'direct enrollment serves the waitlist first, so nobody jumps the line', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  fill(t, loc, sess, 1, 1);
  const waiting = t.fx.family(loc), late = t.fx.family(loc);
  await joinLine(t, waiting.parent, waiting.student, sess, 1);
  t.db.prepare('UPDATE sessions SET capacity = 2 WHERE id = ?').run(sess.id); // job has not run yet
  const r = await enroll(t, late.parent, late.student, sess, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'full');
  assert.equal(active(t, waiting.student).length, 1);
  assert.equal(active(t, late.student).length, 0);
});

test(['EN-5', 'EN-6'], 'paused enrollments do not hold a seat and are shown as paused', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const lapsed = t.fx.family(loc, { status: 'inactive' });
  t.fx.enroll(lapsed.student, sess, 1, { status: 'paused' });
  const f = t.fx.family(loc);
  assert.equal((await enroll(t, f.parent, f.student, sess, 1)).status, 201);
  assert.equal(seats(t, sess, 1), 1);
  const cat = await t.as(lapsed.parent).get(`/api/enrollment/students/${lapsed.student.id}/catalog`);
  const mon = cat.body.slots.find(s => s.session_id === sess.id && s.weekday === 1);
  assert.equal(mon.mine, 'paused');
  const fam = await t.as(lapsed.student).get('/api/enrollment/students');
  assert.deepEqual(fam.body.students[0].enrollments.map(e => e.status), ['paused']);
  const again = await enroll(t, lapsed.parent, lapsed.student, sess, 1);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_enrolled');
  assert.match(again.body.message, /paused until the membership is renewed/);
});

// ---------------------------------------------------------------- NF-3

test(['NF-3'], 'families racing for the last seats: exactly as many enroll as there are seats', async () => {
  const { t, loc, sess } = await world({ capacity: 3 });
  fill(t, loc, sess, 3, 1);
  const fams = Array.from({ length: 6 }, () => t.fx.family(loc));
  const res = await Promise.all(fams.map(f => enroll(t, f.parent, f.student, sess, 3)));
  assert.deepEqual(res.map(r => r.status).sort(), [201, 201, 409, 409, 409, 409]);
  assert.ok(res.filter(r => r.status === 409).every(r => r.body.error === 'full'));
  assert.equal(seats(t, sess, 3), 3);
  // The last seat, two families at once.
  t.db.prepare('UPDATE sessions SET capacity = 4 WHERE id = ?').run(sess.id);
  const two = [t.fx.family(loc), t.fx.family(loc)];
  const r2 = await Promise.all(two.map(f => enroll(t, f.parent, f.student, sess, 3)));
  assert.deepEqual(r2.map(r => r.status).sort(), [201, 409]);
  assert.equal(seats(t, sess, 3), 4);
});

// ---------------------------------------------------------------- EN-3

test(['EN-3'], 'a student request reaches every active parent; the first decision wins and the student hears the result', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const guardian = t.fx.user('parent', { location: loc, name: 'Gus Guardian' });
  t.fx.link(guardian, f.student);
  const unapproved = t.fx.user('parent', { location: loc });
  t.fx.link(unapproved, f.student, 'pending');
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.request.status, 'pending');
  assert.equal(active(t, f.student).length, 0, 'a request alone enrolls nothing');
  for (const p of [f.parent, guardian]) {
    const n = t.fx.notifications(p, 'enrollment_request');
    assert.equal(n.length, 1);
    assert.match(n[0].title, /asked to join Afternoon Study/);
    assert.equal(n[0].ref_id, r.body.request.id);
  }
  assert.equal(t.fx.notifications(unapproved).length, 0);
  const list = await t.as(guardian).get('/api/enrollment/requests');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.requests.map(x => [x.id, x.status, x.check.ok]), [[r.body.request.id, 'pending', true]]);
  const mine = await t.as(f.student).get('/api/enrollment/requests');
  assert.deepEqual(mine.body.requests.map(x => x.id), [r.body.request.id]);

  const ok = await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.outcome, 'enrolled');
  const rows = active(t, f.student);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'request');
  assert.equal(rows[0].created_by, f.parent.id);
  const row = t.db.prepare('SELECT * FROM enrollment_requests WHERE id = ?').get(r.body.request.id);
  assert.deepEqual([row.status, row.outcome, row.decided_by], ['approved', 'enrolled', f.parent.id]);
  const told = t.fx.notifications(f.student, 'enrollment_request_approved');
  assert.equal(told.length, 1);
  assert.match(told[0].title, /approved your request: you're enrolled in Afternoon Study/);
  assert.equal(t.fx.notifications(guardian, 'enrollment_confirmed').length, 1);

  const late = await t.as(guardian).post(`/api/enrollment/requests/${r.body.request.id}/decline`);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'already_decided');
  assert.match(late.body.message, new RegExp(f.parent.name.split(' ')[0] + ' already approved'));
  const late2 = await t.as(guardian).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
  assert.equal(late2.status, 409);
  assert.equal(t.db.prepare('SELECT status FROM enrollment_requests WHERE id = ?').get(r.body.request.id).status, 'approved');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ?').get(f.student.id).n, 1);
});

test(['EN-3'], 'a declined request notifies the student and enrolls nothing', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 3 });
  const d = await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/decline`);
  assert.equal(d.status, 200);
  assert.equal(d.body.outcome, 'declined');
  const row = t.db.prepare('SELECT * FROM enrollment_requests WHERE id = ?').get(r.body.request.id);
  assert.deepEqual([row.status, row.decided_by, row.decided_at], ['declined', f.parent.id, t.clock.now()]);
  const n = t.fx.notifications(f.student, 'enrollment_request_declined');
  assert.equal(n.length, 1);
  assert.match(n[0].title, /declined your request for Afternoon Study/);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
  assert.equal((await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`)).status, 409);
  // Declined, so the student may ask again.
  assert.equal((await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 3 })).status, 201);
});

test(['EN-3', 'EN-4'], 'an approval runs the same membership and seat checks as a direct enrollment', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { cap: 1 });
  t.fx.enroll(f.student, sess, 1);
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 3 });
  assert.equal(r.status, 201);
  const list = await t.as(f.parent).get('/api/enrollment/requests');
  assert.deepEqual([list.body.requests[0].check.ok, list.body.requests[0].check.code], [false, 'weekly_cap']);
  const a = await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
  assert.equal(a.status, 200);
  assert.equal(a.body.outcome, 'blocked');
  assert.equal(a.body.code, 'weekly_cap');
  assert.equal(active(t, f.student).length, 1);
  const row = t.db.prepare('SELECT * FROM enrollment_requests WHERE id = ?').get(r.body.request.id);
  assert.deepEqual([row.status, row.outcome], ['approved', 'blocked']);
  // The parent's reply names the student; what the student is told speaks to them (L54).
  assert.match(a.body.message, /already has 1 weekly session, the most the membership allows\. Drop one to add another\./);
  assert.match(row.outcome_message, /^You already have 1 weekly session, the most your membership allows\./);
  const told = t.fx.notifications(f.student, 'enrollment_request_approved');
  assert.equal(told.length, 1);
  assert.match(told[0].title, /couldn't be enrolled$/); // nothing retries it, so no "yet" (L29)
  assert.match(told[0].body, /weekly session/);

  // Full: the approval is recorded, and the parent can then take the waitlist.
  const small = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  fill(t, loc, small, 2, 1);
  const g = t.fx.family(loc);
  const r2 = await t.as(g.student).post('/api/enrollment/requests', { sessionId: small.id, weekday: 2 });
  const a2 = await t.as(g.parent).post(`/api/enrollment/requests/${r2.body.request.id}/approve`);
  assert.equal(a2.status, 200);
  assert.equal(a2.body.outcome, 'full');
  assert.equal(active(t, g.student).length, 0);
  assert.match(t.fx.notifications(g.student, 'enrollment_request_approved')[0].title, /Quiet Room is full/);
  const w = await joinLine(t, g.parent, g.student, small, 2);
  assert.equal(w.status, 201);
  assert.equal(w.body.outcome, 'waitlisted');
});

test(['EN-3', 'NF-1'], 'only the student asks, and only that student\'s own parents decide', async () => {
  const { t, loc, sess } = await world();
  const other = t.fx.location({ name: 'Arcadia' });
  const away = t.fx.session(other);
  const f = t.fx.family(loc), g = t.fx.family(loc);
  const staff = t.fx.staff(loc);
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 5 });
  const id = r.body.request.id;
  assert.equal((await t.as(f.parent).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 1 })).status, 403);
  assert.equal((await t.as(staff).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 1 })).status, 403);
  const dup = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 5 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'already_requested');
  const elsewhere = await t.as(f.student).post('/api/enrollment/requests', { sessionId: away.id, weekday: 1 });
  assert.equal(elsewhere.status, 409);
  assert.equal(elsewhere.body.error, 'not_home_location');
  for (const u of [g.parent, f.student, g.student, staff]) {
    assert.equal((await t.as(u).post(`/api/enrollment/requests/${id}/approve`)).status, 403);
    assert.equal((await t.as(u).post(`/api/enrollment/requests/${id}/decline`)).status, 403);
  }
  assert.equal(t.db.prepare('SELECT status FROM enrollment_requests WHERE id = ?').get(id).status, 'pending');
  assert.deepEqual((await t.as(g.parent).get('/api/enrollment/requests')).body.requests, []);
  assert.deepEqual((await t.as(g.student).get('/api/enrollment/requests')).body.requests, []);
});

// A request whose slot is gone can never be approved: it is closed with the
// center's real reason, and nobody tells the student a parent declined it.
test(['EN-3'], 'a pending request for a day the session no longer meets is closed with that reason, never as a parent decline', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const first = f.student.name.split(' ')[0];
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 5 });
  const keep = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 1 });
  t.db.prepare("UPDATE sessions SET weekdays = '1,3' WHERE id = ?").run(sess.id); // the director takes Friday off
  const list = await t.as(f.parent).get('/api/enrollment/requests');
  assert.deepEqual(list.body.requests.filter(x => x.status === 'pending').map(x => x.id), [keep.body.request.id], 'only the Monday request still waits for a parent');
  const row = t.db.prepare('SELECT * FROM enrollment_requests WHERE id = ?').get(r.body.request.id);
  assert.deepEqual([row.status, row.decided_by, row.decided_at, row.outcome_message],
    ['declined', null, t.clock.now(), 'Afternoon Study no longer meets on Fridays.']);
  const told = t.fx.notifications(f.student, 'enrollment_request_closed');
  assert.equal(told.length, 1);
  assert.equal(told[0].title, 'Your request for Afternoon Study on Fridays was closed');
  assert.equal(told[0].body, "Afternoon Study no longer meets on Fridays. Your request can't go ahead, so it was closed. You can ask for a different session in Schedule.");
  assert.equal(told[0].ref_id, r.body.request.id);
  assert.equal(t.fx.notifications(f.student, 'enrollment_request_declined').length, 0, 'no parent declined it');
  // Listing again tells nobody twice; a late approve or decline says it was already closed, and why.
  await t.as(f.student).get('/api/enrollment/requests');
  t.jobs();
  assert.equal(t.fx.notifications(f.student, 'enrollment_request_closed').length, 1);
  for (const how of ['approve', 'decline']) {
    const late = await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/${how}`);
    assert.deepEqual([late.status, late.body.error, late.body.message],
      [409, 'already_decided', 'This request was already closed: Afternoon Study no longer meets on Fridays.']);
  }
  assert.equal(t.db.prepare('SELECT status FROM enrollment_requests WHERE id = ?').get(keep.body.request.id).status, 'pending');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 0);
  // The student sees it closed, with the reason.
  const mine = (await t.as(f.student).get('/api/enrollment/requests')).body.requests.find(x => x.id === r.body.request.id);
  assert.deepEqual([mine.status, mine.decided_by, mine.outcome_message], ['declined', null, 'Afternoon Study no longer meets on Fridays.']);
});

test(['EN-3'], 'approving or declining a request for a cancelled session closes it with the real reason; the job closes ones whose term ended', async () => {
  const { t, loc, sess } = await world();
  const quiet = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30' });
  const f = t.fx.family(loc), g = t.fx.family(loc);
  const name = s => s.name.split(' ')[0];
  const a = (await t.as(f.student).post('/api/enrollment/requests', { sessionId: quiet.id, weekday: 2 })).body.request;
  const b = (await t.as(g.student).post('/api/enrollment/requests', { sessionId: quiet.id, weekday: 4 })).body.request;
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(quiet.id); // the director cancels it
  // Neither family has looked since, so each parent acts on the stale row.
  const ok = await t.as(f.parent).post(`/api/enrollment/requests/${a.id}/approve`);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.outcome, ok.body.code, ok.body.message], ['closed', 'request_closed',
    `The center cancelled Quiet Room. ${name(f.student)}'s request can't go ahead, so it was closed, and ${name(f.student)} has been told why.`]);
  const no = await t.as(g.parent).post(`/api/enrollment/requests/${b.id}/decline`);
  assert.equal(no.body.outcome, 'closed');
  for (const [s, req] of [[f.student, a], [g.student, b]]) {
    const row = t.db.prepare('SELECT status, decided_by, outcome_message FROM enrollment_requests WHERE id = ?').get(req.id);
    assert.deepEqual({ ...row }, { status: 'declined', decided_by: null, outcome_message: 'The center cancelled Quiet Room.' });
    assert.equal(t.fx.notifications(s, 'enrollment_request_closed').length, 1);
    assert.match(t.fx.notifications(s, 'enrollment_request_closed')[0].body, /^The center cancelled Quiet Room\. /);
    assert.equal(t.fx.notifications(s, 'enrollment_request_declined').length, 0);
    assert.equal(t.fx.notifications(s, 'enrollment_request_approved').length, 0);
  }
  // A request left waiting until its term is over is closed by the scheduled job, with nobody looking.
  const h = t.fx.family(loc);
  const c = (await t.as(h.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 1 })).body.request;
  t.clock.set(at(LA, '2026-12-18', '20:00'));
  t.jobs();
  assert.equal(t.db.prepare('SELECT status FROM enrollment_requests WHERE id = ?').get(c.id).status, 'pending', 'Dec 18 is still the last day of the term');
  t.clock.set(at(LA, '2026-12-19', '08:00'));
  const ran = t.jobs();
  assert.ok(ran.includes('enrollment.close-gone-requests'));
  assert.deepEqual({ ...t.db.prepare('SELECT status, decided_by, outcome_message FROM enrollment_requests WHERE id = ?').get(c.id) },
    { status: 'declined', decided_by: null, outcome_message: 'Fall 2026 has ended.' });
  assert.equal(t.fx.notifications(h.student, 'enrollment_request_closed')[0].title, 'Your request for Afternoon Study on Mondays was closed');
  assert.equal(t.fx.notifications(h.parent).filter(n => n.kind !== 'enrollment_request').length, 0, 'the student is the one told');
});

// ---------------------------------------------------------------- EN-6, EN-7

test(['EN-6', 'EN-7'], 'parents drop any time, even minutes before or during a session, with no penalty', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const wed = t.fx.enroll(f.student, sess, 3);
  const fri = t.fx.enroll(f.student, sess, 5);
  t.clock.set(at(LA, '2026-10-14', '12:55')); // five minutes before Wednesday's session
  assert.equal((await drop(t, f.student, wed.id)).status, 403);
  const r = await drop(t, f.parent, wed.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.enrollment.status, 'dropped');
  const row = t.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(wed.id);
  assert.deepEqual([row.status, row.ended_at], ['dropped', at(LA, '2026-10-14', '12:55')]);
  t.clock.set(at(LA, '2026-10-16', '14:00')); // in the middle of Friday's session
  assert.equal((await drop(t, f.parent, fri.id)).status, 200);
  const again = await drop(t, f.parent, fri.id);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'not_enrolled');
  // History stays; nothing from the drop on is expected, and no penalty is recorded.
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-10-05&to=2026-10-25`);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.status}`), ['2026-10-07 absent', '2026-10-09 absent']);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test(['EN-7'], 'the schedule shows attended, absent, closed, paused and upcoming, computed and never stored', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2', start: '09:30', end: '12:00' });
  const evening = t.fx.session(loc, { name: 'Evening Study', weekdays: '4', start: '17:00', end: '19:00' });
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  for (const wd of [1, 3, 5]) t.fx.enroll(f.student, sess, wd);
  t.fx.enroll(f.student, evening, 4, { status: 'paused' });
  t.clock.set(at(LA, '2026-10-07', '12:30')); // enrolled in Tuesdays after the Oct 6 one
  t.fx.enroll(f.student, morning, 2);
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-09-28', check_in_at: at(LA, '2026-09-28', '13:02'), check_out_at: at(LA, '2026-09-28', '15:58'), checkout_method: 'scan' });
  // Staff check-in with no linked session, during the session window: still attended.
  t.fx.visit(f.student, loc, { local_date: '2026-09-30', check_in_at: at(LA, '2026-09-30', '13:20'), check_out_at: at(LA, '2026-09-30', '15:00'), checkin_method: 'staff', checkout_method: 'staff' });
  // A visit that day but outside the session window does not count.
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
  assert.equal(s.body.occurrences[0].start_at, at(LA, '2026-09-28', '13:00'));
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

test(['EN-7'], 'a schedule range over a year is refused at once, even 0001-01-01 to 9999-12-31, without stepping through the days', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.fx.enroll(f.student, sess, 1); // Mondays, from next week to the end of the term (Dec 18)
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

test(['EN-7'], 'a slot dropped and taken again shows each week once, and a recorded visit always counts as attended', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const first = t.fx.enroll(f.student, sess, 1);
  t.clock.set(at(LA, '2026-10-01', '09:00'));
  t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(t.clock.now(), first.id);
  t.clock.set(at(LA, '2026-10-02', '09:00'));
  t.fx.enroll(f.student, sess, 1); // Mondays again, a new row
  t.clock.set(at(LA, '2026-10-08', '09:00'));
  t.fx.enroll(f.student, sess, 3); // Wednesdays from Oct 8, but they came on Oct 7 (staff linked the visit)
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-09-28', check_in_at: at(LA, '2026-09-28', '13:00'), check_out_at: at(LA, '2026-09-28', '16:00'), checkout_method: 'scan' });
  t.fx.visit(f.student, loc, { session: sess, weekday: 3, local_date: '2026-10-07', check_in_at: at(LA, '2026-10-07', '13:10'), check_out_at: at(LA, '2026-10-07', '16:00'), checkin_method: 'staff', checkout_method: 'staff' });
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-21&to=2026-10-18`);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.status}`), [
    '2026-09-21 absent', '2026-09-28 attended', '2026-10-05 absent', '2026-10-07 attended', '2026-10-12 absent', '2026-10-14 upcoming',
  ]);
});

test(['EN-7'], "each week is judged by the enrollment's status that day: a week missed before a pause stays absent, weeks on hold stay paused after renewal", async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const r = await enroll(t, f.parent, f.student, sess, 1); // Mondays
  assert.equal(r.status, 201);
  const id = r.body.enrollment.id;
  for (const d of ['2026-09-07', '2026-09-21']) {
    t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: d, check_in_at: at(LA, d, '13:00'), check_out_at: at(LA, d, '16:00'), checkout_method: 'scan' });
  }
  // Sep 14 is missed. Fri Sep 25: the membership lapses and the membership module pauses the spot (MB-5).
  t.clock.set(at(LA, '2026-09-25', '09:00'));
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE student_id = ? AND status = 'active'").run(f.student.id);
  const weeks = async to => (await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-07&to=${to}`))
    .body.occurrences.map(o => `${o.date} ${o.status}`);
  // While it is paused, the missed week before the pause is still an absence.
  t.clock.set(at(LA, '2026-10-01', '10:00'));
  assert.deepEqual(await weeks('2026-10-19'), [
    '2026-09-07 attended', '2026-09-14 absent', '2026-09-21 attended',
    '2026-09-28 paused', '2026-10-05 paused', '2026-10-12 paused', '2026-10-19 paused',
  ]);
  // Wed Oct 14: renewed, and the spot comes back (D-16). The weeks on hold are never absences.
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

test(['EN-7'], 'a cancelled session keeps the weeks before the cancellation on the schedule and drops the ones after', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  t.clock.set(at(LA, '2026-09-01', '08:00'));
  t.fx.enroll(f.student, sess, 1);
  t.fx.enroll(f.student, morning, 2);
  t.fx.enroll(f.student, morning, 4);
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

test(['EN-1', 'EN-2'], 'the catalog lists home-location slots in current and upcoming terms, with seats and the line', async () => {
  const { t, loc, sess } = await world({ capacity: 3 });
  const other = t.fx.location({ name: 'Arcadia' });
  t.fx.session(other, { name: 'Arcadia Study' });
  const summer = t.fx.term(loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-07' });
  t.fx.session(loc, { term: summer, name: 'Summer Study' });
  const winter = t.fx.term(loc, { name: 'Winter 2027', start: '2027-01-11', end: '2027-03-19' });
  const next = t.fx.session(loc, { term: winter, name: 'Winter Study', weekdays: '2', start: '15:00', end: '17:00', capacity: 3 });
  const gone = t.fx.session(loc, { name: 'Cancelled Study' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(gone.id);
  const f = t.fx.family(loc);
  t.fx.enroll(f.student, sess, 1);
  fill(t, loc, sess, 1, 1);
  fill(t, loc, sess, 3, 3);
  const w = t.fx.family(loc);
  await joinLine(t, w.parent, w.student, sess, 3);
  await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 5 });
  const c = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/catalog`);
  assert.equal(c.status, 200);
  assert.equal(c.body.location.timezone, LA);
  assert.deepEqual(c.body.slots.map(s => [s.name, s.weekday, s.seats_left, s.waiting, s.mine]), [
    ['Afternoon Study', 1, 1, 0, 'enrolled'],
    ['Winter Study', 2, 3, 0, null],
    ['Afternoon Study', 3, 0, 1, null],
    ['Afternoon Study', 5, 3, 0, 'requested'],
  ]);
  assert.equal(c.body.slots[1].term_name, 'Winter 2027');
  assert.equal(c.body.slots[1].session_id, next.id);
  // The student sees the same catalog for themselves.
  const mine = await t.as(f.student).get(`/api/enrollment/students/${f.student.id}/catalog`);
  assert.equal(mine.body.slots.length, 4);
});

// ---------------------------------------------------------------- NF-1

test(['NF-1'], 'every enrollment route refuses other families, other locations and lower roles', async () => {
  const { t, loc, sess } = await world({ capacity: 1 });
  const locB = t.fx.location({ name: 'Arcadia' });
  const sessB = t.fx.session(locB);
  const a = t.fx.family(loc), b = t.fx.family(loc), far = t.fx.family(locB);
  const staffA = t.fx.staff(loc), staffB = t.fx.staff(locB), dirB = t.fx.director(locB), hq = t.fx.hq();
  const e = t.fx.enroll(a.student, sess, 1);
  fill(t, loc, sess, 3, 1);
  const w = await joinLine(t, a.parent, a.student, sess, 3);
  const req = await t.as(a.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 5 });
  assert.equal(w.status, 201);
  assert.equal(req.status, 201);
  const sid = a.student.id;
  const before = snapshot(t);

  // Reads of one student: the family, staff at that location, and HQ only.
  for (const path of [`/api/enrollment/students/${sid}/catalog`, `/api/enrollment/students/${sid}/schedule`]) {
    for (const u of [b.parent, b.student, far.parent, staffB, dirB]) assert.equal((await t.as(u).get(path)).status, 403, path + ' as ' + u.role);
    for (const u of [a.parent, a.student, staffA, hq]) assert.equal((await t.as(u).get(path)).status, 200, path + ' as ' + u.role);
    assert.equal((await t.anon.get(path)).status, 401);
  }
  // Family lists hold only the caller's own students and requests.
  const bl = await t.as(b.parent).get('/api/enrollment/students');
  assert.deepEqual(bl.body.students.map(s => s.id), [b.student.id]);
  const al = await t.as(a.student).get('/api/enrollment/students');
  assert.deepEqual(al.body.students.map(s => s.id), [sid]);
  assert.deepEqual((await t.as(b.parent).get('/api/enrollment/requests')).body.requests, []);
  for (const u of [staffA, hq]) {
    assert.equal((await t.as(u).get('/api/enrollment/students')).status, 403);
    assert.equal((await t.as(u).get('/api/enrollment/requests')).status, 403);
  }
  // Writes: only a linked parent.
  const writes = [
    ['/api/enrollment/enroll', { studentId: sid, sessionId: sess.id, weekday: 5 }],
    ['/api/enrollment/waitlist', { studentId: sid, sessionId: sess.id, weekday: 5 }],
    [`/api/enrollment/waitlist/${w.body.waitlist.id}/leave`, {}],
    [`/api/enrollment/enrollments/${e.id}/drop`, {}],
    [`/api/enrollment/requests/${req.body.request.id}/approve`, {}],
    [`/api/enrollment/requests/${req.body.request.id}/decline`, {}],
  ];
  for (const [path, payload] of writes) {
    for (const u of [b.parent, far.parent, a.student, staffA, dirB, hq]) {
      assert.equal((await t.as(u).post(path, payload)).status, 403, path + ' as ' + u.role + ' ' + u.id);
    }
    assert.equal((await t.anon.post(path, payload)).status, 401);
  }
  assert.equal(snapshot(t), before, 'refused calls change nothing');
  // Another location's session is out of reach even for the student's own parent.
  const away = await enroll(t, a.parent, a.student, sessB, 1);
  assert.equal(away.status, 409);
  assert.equal(away.body.error, 'not_home_location');
  const awayLine = await joinLine(t, a.parent, a.student, sessB, 1);
  assert.equal(awayLine.status, 409);
  assert.equal(snapshot(t), before);
});

// ---------------------------------------------------------------- integration follow-ups

test(['NF-1', 'EN-7'], "a schedule never borrows another student's visit or another location's closure", async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc), other = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess, 1); // Mondays 13:00-16:00
  t.fx.enroll(other.student, sess, 1);
  // Another family's student came to the same slot on Mon Oct 5 ...
  t.fx.visit(other.student, loc, { session: sess, weekday: 1, local_date: '2026-10-05', check_in_at: at(LA, '2026-10-05', '13:00'),
    check_out_at: at(LA, '2026-10-05', '16:00'), checkout_method: 'scan' });
  // ... and a different location closed on Mon Oct 12.
  const arcadia = t.fx.location({ name: 'Arcadia' });
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(arcadia.id, '2026-10-12', 'Arcadia staff training');
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-10-05&to=2026-10-12`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.occurrences.map(o => [o.date, o.status, o.check_in_at, o.closure_reason]),
    [['2026-10-05', 'absent', null, null], ['2026-10-12', 'absent', null, null]]);
  const theirs = await t.as(other.parent).get(`/api/enrollment/students/${other.student.id}/schedule?from=2026-10-05&to=2026-10-12`);
  assert.deepEqual(theirs.body.occurrences.map(o => [o.date, o.status]), [['2026-10-05', 'attended'], ['2026-10-12', 'absent']]);
});

test(['EN-4', 'MB-5'], 'a spot kept paused over the weekly limit says so, instead of asking for a renewal (D-16a)', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { cap: 1 });
  t.fx.enroll(f.student, sess, 1);
  t.fx.enroll(f.student, sess, 3, { status: 'paused' }); // kept paused when the membership came back with a limit of 1
  const r = await enroll(t, f.parent, f.student, sess, 3);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'already_enrolled');
  assert.match(r.body.message, /^\S+'s spot in Afternoon Study is paused because it would go over the membership's weekly limit\. It stays saved, and the front desk can bring it back if the limit goes up\.$/);
  // The same spot with the membership lapsed waits for a renewal; so does one past its last day.
  t.fx.membership(f.student, { cap: 1, expires: '2026-10-13' });
  assert.match((await enroll(t, f.parent, f.student, sess, 3)).body.message, /is paused until the membership is renewed\.$/);
  t.fx.membership(f.student, { cap: 1, status: 'inactive' });
  assert.match((await enroll(t, f.parent, f.student, sess, 3)).body.message, /is paused until the membership is renewed\.$/);
});

// ---------------------------------------------------------------- the demo data (src/modules/enrollment/seed.js)

test(['EN-3'], "the demo's pending request and its notice in the parents' Inbox carry the same time", async () => {
  const { t, loc, sess } = await world();
  const garcia = t.fx.family(loc, { students: 2 }), nguyen = t.fx.family(loc);
  const small = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', capacity: 1 });
  const morning = t.fx.session(loc, { name: 'Morning Focus', weekdays: '1,2,3,4,5', start: '09:30', end: '12:00' });
  const demo = { NOW: t.clock.now(), families: [garcia, nguyen], sessions: { small, pmMWF: sess, morning } };
  load('src/modules/enrollment/seed.js')(t.ctx, demo);
  const asked = t.db.prepare("SELECT * FROM enrollment_requests WHERE status = 'pending'").all();
  assert.deepEqual(asked.map(r => [r.student_id, r.created_at]), [[garcia.students[1].id, demo.NOW - 3 * 3600e3]]);
  const told = t.fx.notifications(garcia.parent, 'enrollment_request');
  assert.deepEqual(told.map(n => [n.ref_id, n.created_at]), [[asked[0].id, asked[0].created_at]], 'Home says "asked" at the time the Inbox shows');
  assert.equal(t.clock.now(), demo.NOW, 'the clock is left as it was');
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

test(['EN-6'], 'Drop asks inline in place of the row: "Keep Mondays" comes first and has focus, Escape keeps the spot, "Drop Mondays" drops it', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  rename(t, f.student, 'Leo Garcia');
  const e = t.fx.enroll(f.student, sess, 1);
  const tab = shellTab(t);
  await tab.open(f.parent, '#/schedule');
  const dropButton = () => byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Drop Afternoon Study on Mondays');
  const status = () => t.db.prepare('SELECT status FROM enrollments WHERE id = ?').get(e.id).status;

  const btn = dropButton();
  const row = btn.parentNode, before = row.childNodes.slice();
  btn.click();
  const box = row.childNodes[0];
  assert.equal(row.childNodes.length, 1, 'the question takes the place of the row');
  assert.equal(box.getAttribute('role'), 'alertdialog');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Drop Leo from Afternoon Study on Mondays?');
  assert.match(tab.doc.getElementById(box.getAttribute('aria-describedby')).textContent,
    /^This ends the weekly spot \(1pm–4pm\)\. The seat goes to the next family on the waitlist/);
  const choices = byTag(box, 'button');
  assert.deepEqual(choices.map(b => b.textContent), ['Keep Mondays', 'Drop Mondays'], 'the safe answer comes first, and each names the day');
  assert.ok(choices[1].cls.includes('btn-danger'));
  assert.equal(tab.doc.activeElement, choices[0], 'focus starts on the safe answer');
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  await tab.settle();
  assert.equal(status(), 'active', 'Escape keeps the spot');
  assert.ok(row.childNodes.length === before.length && row.childNodes.every((n, i) => n === before[i]), 'the row comes back');
  assert.equal(tab.doc.activeElement, btn, 'focus goes back to Drop');

  btn.click();
  byTag(row, 'button').find(b => b.textContent === 'Drop Mondays').click();
  await tab.settle();
  assert.equal(status(), 'dropped');
  assert.deepEqual(tab.toasts(), ['Dropped Afternoon Study on Mondays.']);
  assert.equal(dropButton(), undefined, 'the page is drawn again without the spot');
  assert.equal(tab.confirms, 0, 'window.confirm is never used');
});

test(['EN-3'], 'request notices in the Inbox open Schedule, for the parents asked and for the student told the answer', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 1 });
  assert.equal((await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/decline`)).status, 200);
  const links = tab => tab.main().findAll(n => n.tag === 'li').map(li => li.childNodes[0])
    .map(item => [words(item), item.tag === 'a' ? item.getAttribute('href') : null]);
  const parent = shellTab(t);
  await parent.open(f.parent, '#/inbox');
  const opens = '#/schedule/request/' + r.body.request.id; // Schedule on that student (L35)
  assert.deepEqual(links(parent).map(([text, href]) => [/asked to join Afternoon Study/.test(text), href]), [[true, opens]]);
  const student = shellTab(t);
  await student.open(f.student, '#/inbox');
  assert.deepEqual(links(student).map(([text, href]) => [/declined your request for Afternoon Study/.test(text), href]), [[true, opens]]);
  await student.go(opens);
  assert.equal(byTag(student.main(), 'h1')[0].textContent, 'My schedule');
});

test(['EN-4', 'MB-5'], "a student whose membership lapsed hears one message on Schedule: it isn't active, the sessions are paused, and who renews it", async () => {
  const { t, loc, sess } = await world();
  const lapsed = t.fx.family(loc, { status: 'inactive' });
  t.fx.enroll(lapsed.student, sess, 1, { status: 'paused' });
  const expired = t.fx.family(loc, { expires: '2026-10-13' });
  t.fx.enroll(expired.student, sess, 3, { status: 'paused' });
  const never = t.fx.family(loc, { status: 'inactive' });
  const fine = t.fx.family(loc);
  const notes = tab => tab.main().findAll(n => n.getAttribute('role') === 'note').map(words);
  const paused = "Your membership isn't active, so your sessions are paused. Ask a parent or the front desk at Irvine to renew it.";
  const ask = "Nothing new can be added until it's renewed. You can still ask; your parent will see this too.";
  for (const [who, want] of [[lapsed, [paused, ask]], [expired, [paused, ask]],
    [never, ["Your membership isn't active. Ask a parent or the front desk at Irvine to renew it.", ask]], [fine, []]]) {
    const tab = shellTab(t);
    await tab.open(who.student, '#/schedule');
    assert.deepEqual(notes(tab), want);
  }
});

// D-16 / R6: the Schedule's membership line names the state the server judged, never "active" for a lapsed or unstarted one.
test(['EN-4'], 'the membership line on Schedule says expired past the last day and "starts" before the first, for parents and students alike', async () => {
  const { t, loc, sess } = await world();
  const expired = t.fx.family(loc, { expires: '2026-10-13' });
  t.fx.enroll(expired.student, sess, 1, { status: 'paused' });
  const early = t.fx.family(loc, { cap: 2, start: '2026-11-02' });
  t.fx.enroll(early.student, sess, 3, { status: 'paused' });
  const fine = t.fx.family(loc);
  const off = t.fx.family(loc, { status: 'inactive' });
  const lines = tab => tab.main().findAll(n => n.tag === 'p' && /^(Membership|No membership)/.test(words(n))).map(words);
  for (const [who, want] of [
    [expired, 'Membership expired · 0 of 3 weekly sessions in use · last day was Oct 13, 2026'],
    [early, 'Membership starts Nov 2, 2026 · 0 of 2 weekly sessions in use · valid through Jun 30, 2027'],
    [fine, 'Membership active · 0 of 3 weekly sessions in use · valid through Jun 30, 2027'],
    [off, 'Membership inactive · 0 of 3 weekly sessions in use · valid through Jun 30, 2027']]) {
    for (const u of [who.parent, who.student]) {
      const tab = shellTab(t);
      await tab.open(u, '#/schedule');
      assert.deepEqual(lines(tab), [want], u.role);
    }
  }
  // Before the start, nobody is told to renew, and paused weeks name the start date.
  const tab = shellTab(t);
  await tab.open(early.student, '#/schedule');
  const notes = tab.main().findAll(n => n.getAttribute('role') === 'note').map(words);
  assert.deepEqual(notes, ['Your membership starts on Nov 2, 2026. Sessions can be added from that day. You can still ask; your parent will see this too.']);
  assert.ok(words(tab.main()).includes('Membership starts Nov 2, 2026'));
  assert.ok(!/renew/i.test(words(tab.main())), 'nothing asks to renew a membership that has not started');
  // Weeks before the start are not started (D-32); a paused week from the start on names the start date too.
  for (let i = 0; i < 3; i++) {
    byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Next week').click();
    await tab.settle();
  }
  const nov4 = tab.main().findAll(n => n.tag === 'li').map(words).filter(w => /Nov 4/.test(w));
  assert.deepEqual(nov4, ['Wed Nov 4 Afternoon Study 1pm–4pm · Membership starts Nov 2, 2026 Paused']);
  const parent = shellTab(t);
  await parent.open(early.parent, '#/schedule');
  assert.ok(words(parent.main()).includes("Paused sessions don't hold a seat. " + early.student.name.split(' ')[0] + "'s membership starts on Nov 2, 2026."));
  assert.ok(!/renew/i.test(words(parent.main())));
});

test(['EN-3'], 'a request closed because its slot is gone shows as Closed with the reason, and a parent acting on a stale row is told the real reason', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc);
  rename(t, f.student, 'Sofia Garcia');
  const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 5 });
  const parent = shellTab(t);
  await parent.open(f.parent, '#/schedule');
  const approve = byTag(parent.main(), 'button').find(b => b.getAttribute('aria-label') === "Approve Sofia's request for Afternoon Study on Fridays");
  t.db.prepare("UPDATE sessions SET weekdays = '1,3' WHERE id = ?").run(sess.id); // Friday is taken off while the page is open
  approve.click();
  await parent.settle();
  assert.deepEqual(parent.toasts(), ["Afternoon Study no longer meets on Fridays. Sofia's request can't go ahead, so it was closed, and Sofia has been told why."]);
  assert.equal(byTag(parent.main(), 'button').find(b => /^Approve Sofia/.test(b.getAttribute('aria-label') || '')), undefined, 'the request is gone from the list');
  assert.equal(t.db.prepare('SELECT outcome_message FROM enrollment_requests WHERE id = ?').get(r.body.request.id).outcome_message, 'Afternoon Study no longer meets on Fridays.');
  const student = shellTab(t);
  await student.open(f.student, '#/schedule');
  const card = student.main().find(n => n.getAttribute('aria-labelledby') === 'en-myreq-h');
  const row = card.findAll(n => n.tag === 'li')[0];
  assert.match(words(row), /^Afternoon Study Fridays · 1pm–4pm Afternoon Study no longer meets on Fridays\. Closed$/);
  assert.ok(!/Declined/.test(words(card)));
});

// ---------------------------------------------------------------- D-28, D-34, D-32 on the Schedule

// D-28: one visit through back-to-back sessions counts for every enrolled slot it overlaps at that
// location, on the Schedule and the Home "This week" card, the rule attendance uses.
test(['EN-7'], 'one visit through back-to-back sessions marks every enrolled slot it overlaps attended, never absent', async () => {
  const { t, loc } = await world();
  const f = t.fx.family(loc);
  const early = t.fx.session(loc, { name: 'Early', weekdays: '3,5', start: '13:00', end: '16:00' });
  const late = t.fx.session(loc, { name: 'Late', weekdays: '3,5', start: '16:00', end: '19:00' });
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const away = t.fx.session(arcadia, { name: 'Arcadia Study', weekdays: '3', start: '16:00', end: '19:00' });
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, early, 3);
  t.fx.enroll(f.student, early, 5);
  t.fx.enroll(f.student, late, 3);
  t.clock.set(at(LA, '2026-10-10', '09:00'));
  t.fx.enroll(f.student, late, 5); // Late on Fridays only from Sat Oct 10
  const stay = (d, wd, from, to, session = early, place = loc) => t.fx.visit(f.student, place, { session, weekday: wd, local_date: d,
    check_in_at: at(LA, d, from), check_out_at: at(LA, d, to), checkout_method: 'scan' });
  stay('2026-09-30', 3, '12:55', '16:00'); // out when Early ended: Late is not covered
  stay('2026-09-30', 3, '16:30', '18:00', away, arcadia); // another location's visit never counts here
  stay('2026-10-09', 5, '12:55', '18:55'); // through Late's hours, but before Late on Fridays was theirs
  stay('2026-10-14', 3, '12:55', '18:55'); // one visit, Early then Late
  t.clock.set(at(LA, '2026-10-14', '19:30'));
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-28&to=2026-10-18`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.name} ${o.status}`), [
    '2026-09-30 Early attended', '2026-09-30 Late absent',
    '2026-10-02 Early absent',
    '2026-10-07 Early absent', '2026-10-07 Late absent',
    '2026-10-09 Early attended',
    '2026-10-14 Early attended', '2026-10-14 Late attended',
    '2026-10-16 Early upcoming', '2026-10-16 Late upcoming',
  ]);
  const both = s.body.occurrences.filter(o => o.date === '2026-10-14').map(o => [o.check_in_at, o.check_out_at]);
  const stayed = [at(LA, '2026-10-14', '12:55'), at(LA, '2026-10-14', '18:55')];
  assert.deepEqual(both, [stayed, stayed]);
  // Home "This week" shows both as attended too.
  const tab = shellTab(t);
  await tab.open(f.parent, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), [
    'Today 1pm–4pm Early Attended', 'Today 4pm–7pm Late Attended', 'Fri 1pm–4pm Early Upcoming', 'Fri 4pm–7pm Late Upcoming',
  ]);
});

// D-34: a session's time edit applies from the edit date on. Past weeks keep the hours they had, so
// their status and times on the Schedule do not change.
test(['EN-7'], "editing a session's times leaves past weeks on the Schedule with the hours they had and the same status", async () => {
  const { t, loc, sess } = await world(); // Mon/Wed/Fri 13:00-16:00
  const f = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess, 3); // Wednesdays since September
  t.clock.set(at(LA, '2026-10-05', '14:00')); // Mondays from partway through Oct 5, so Oct 5 was never theirs
  t.fx.enroll(f.student, sess, 1);
  // A staff check-in with no session on Wed Oct 7, 13:05-14:50; a linked visit on Mon Oct 12.
  t.fx.visit(f.student, loc, { local_date: '2026-10-07', check_in_at: at(LA, '2026-10-07', '13:05'), check_out_at: at(LA, '2026-10-07', '14:50'),
    checkin_method: 'staff', checkout_method: 'staff' });
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-10-12', check_in_at: at(LA, '2026-10-12', '13:00'),
    check_out_at: at(LA, '2026-10-12', '16:00'), checkout_method: 'scan' });
  t.clock.set(at(LA, '2026-10-13', '10:00'));
  const weeks = async () => (await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-28&to=2026-10-19`))
    .body.occurrences.map(o => `${o.date} ${o.start_time}-${o.end_time} ${o.status}`);
  assert.deepEqual(await weeks(), [
    '2026-09-30 13:00-16:00 absent', '2026-10-07 13:00-16:00 attended', '2026-10-12 13:00-16:00 attended',
    '2026-10-14 13:00-16:00 upcoming', '2026-10-19 13:00-16:00 upcoming',
  ]);
  // Tue Oct 13: the director moves it to 15:00-18:00; the sessions module keeps the old times through Oct 12 (R8).
  t.db.prepare("UPDATE sessions SET start_time = '15:00', end_time = '18:00' WHERE id = ?").run(sess.id);
  t.db.prepare("INSERT INTO session_times (session_id, until_date, start_time, end_time, changed_at) VALUES (?, '2026-10-12', '13:00', '16:00', ?)")
    .run(sess.id, t.clock.now());
  assert.deepEqual(await weeks(), [
    '2026-09-30 13:00-16:00 absent', '2026-10-07 13:00-16:00 attended', '2026-10-12 13:00-16:00 attended',
    '2026-10-14 15:00-18:00 upcoming', '2026-10-19 15:00-18:00 upcoming',
  ]);
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-09-30&to=2026-09-30`);
  assert.deepEqual([s.body.occurrences[0].start_at, s.body.occurrences[0].end_at], [at(LA, '2026-09-30', '13:00'), at(LA, '2026-09-30', '16:00')]);
});

// D-32: before the membership's start date nothing is absent. The start date is the one in force
// that week, so moving it forward leaves the weeks before the change as they were.
test(['EN-7'], 'weeks before the membership starts show as not started, never absent, on the Schedule and Home', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc); // membership from Aug 1
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  t.fx.enroll(f.student, sess, 1); // Mondays
  const m = t.db.prepare('SELECT * FROM memberships WHERE student_id = ?').get(f.student.id);
  // Wed Oct 14: staff move the start to Mon Nov 2, written to the audit log as D-26 says.
  t.clock.set(at(LA, '2026-10-14', '10:00'));
  const pick = r => ({ status: r.status, weekly_cap: r.weekly_cap, start_date: r.start_date, expires_on: r.expires_on });
  t.db.prepare("UPDATE memberships SET start_date = '2026-11-02' WHERE id = ?").run(m.id);
  t.db.prepare("INSERT INTO audit_log (action, target_type, target_id, location_id, detail, at) VALUES ('membership.update', 'membership', ?, ?, ?, ?)")
    .run(m.id, loc.id, JSON.stringify({ student_id: f.student.id, before: pick(m), after: Object.assign(pick(m), { start_date: '2026-11-02' }) }), t.clock.now());
  // A staff check-in with no session on Mon Oct 19: they came, so it is attended.
  t.fx.visit(f.student, loc, { local_date: '2026-10-19', check_in_at: at(LA, '2026-10-19', '13:10'), check_out_at: at(LA, '2026-10-19', '15:00'),
    checkin_method: 'staff', checkout_method: 'staff' });
  t.clock.set(at(LA, '2026-11-04', '10:00'));
  const s = await t.as(f.parent).get(`/api/enrollment/students/${f.student.id}/schedule?from=2026-10-05&to=2026-11-09`);
  assert.deepEqual(s.body.occurrences.map(o => `${o.date} ${o.status} ${o.membership_starts}`), [
    '2026-10-05 absent null', '2026-10-12 absent null', // missed under the membership in force then
    '2026-10-19 attended null', '2026-10-26 not_started 2026-11-02',
    '2026-11-02 absent null', '2026-11-09 upcoming null',
  ]);
  // Late October the family sees the week before the start as not started, never absent.
  t.clock.set(at(LA, '2026-10-28', '10:00'));
  const tab = shellTab(t);
  await tab.open(f.parent, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), ['Mon 1pm–4pm Afternoon Study Not started']);
  await tab.go('#/schedule');
  const rows = tab.main().findAll(n => n.tag === 'li').map(words).filter(w => /Oct 26/.test(w));
  assert.deepEqual(rows, ['Mon Oct 26 Afternoon Study 1pm–4pm · Membership starts Nov 2, 2026 Not started']);
});

// ---------------------------------------------------------------- sweep fixes L29, L30, L33, L35, L52, L54

// L54 / L29: an approval that can't enroll the student tells the parent what they can do, and tells the
// student in their own words what a parent or the front desk can do. Nothing retries it, so nothing says "yet".
test(['EN-3', 'EN-4'], 'a student whose approved request could not enroll them is told in their own words, never to drop a session or join the waitlist', async () => {
  const { t, loc, sess } = await world();
  const ask = async (f, session, weekday) => {
    const r = await t.as(f.student).post('/api/enrollment/requests', { sessionId: session.id, weekday });
    assert.equal(r.status, 201);
    const a = await t.as(f.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
    assert.equal(a.status, 200);
    const mine = (await t.as(f.student).get('/api/enrollment/requests')).body.requests.find(x => x.id === r.body.request.id);
    const told = t.fx.notifications(f.student, 'enrollment_request_approved').pop();
    return { a: a.body, stored: mine.outcome_message, title: told.title, body: told.body };
  };
  const named = (f, student, parent) => { rename(t, f.student, student); rename(t, f.parent, parent); return f; };

  const capped = named(t.fx.family(loc, { cap: 1 }), 'Leo Garcia', 'Maria Garcia');
  t.fx.enroll(capped.student, sess, 1);
  const c = await ask(capped, sess, 3);
  assert.equal(c.a.outcome, 'blocked');
  assert.equal(c.a.message, 'Leo already has 1 weekly session, the most the membership allows. Drop one to add another.');
  const capText = 'You already have 1 weekly session, the most your membership allows. A parent can drop one to make room, then add this one.';
  assert.deepEqual([c.stored, c.title, c.body], [capText, "Maria approved your request, but you couldn't be enrolled", capText]);

  const noMembership = named(t.fx.family(loc), 'Ana Diaz', 'Rosa Diaz');
  t.db.prepare('DELETE FROM memberships WHERE student_id = ?').run(noMembership.student.id);
  const cases = [
    [noMembership, "You don't have a membership yet. A parent can set one up with the front desk."],
    [named(t.fx.family(loc, { status: 'inactive' }), 'Ben Ito', 'Kai Ito'), "Your membership is inactive, so new sessions can't be added. A parent or the front desk can reactivate it."],
    [named(t.fx.family(loc, { expires: '2026-10-13' }), 'Cy Park', 'Jo Park'), "Your membership expired on Oct 13, 2026. Once it's renewed, a parent can add sessions again."],
    [named(t.fx.family(loc, { start: '2026-11-02' }), 'Di Lee', 'Al Lee'), 'Your membership starts on Nov 2, 2026. A parent can add sessions from that day.'],
  ];
  for (const [f, want] of cases) {
    const o = await ask(f, sess, 5);
    assert.equal(o.a.outcome, 'blocked');
    assert.deepEqual([o.stored, o.body], [want, want]);
  }

  // Full: the student hears that a parent can add them to the waitlist, or where they stand if one already did.
  const small = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  fill(t, loc, small, 2, 1);
  fill(t, loc, small, 4, 1);
  const full = named(t.fx.family(loc), 'Eve Ruiz', 'Lu Ruiz');
  const fu = await ask(full, small, 2);
  assert.equal(fu.a.outcome, 'full');
  assert.match(fu.a.message, /^Quiet Room on Tuesdays is full\. Join the waitlist and Eve will be enrolled automatically/);
  assert.deepEqual([fu.stored, fu.body], ['Quiet Room on Tuesdays is full. A parent can add you to the waitlist.', 'Tuesdays 4:30pm–6:30pm. A parent can add you to the waitlist.']);
  const inLine = named(t.fx.family(loc), 'Fay Wu', 'Ty Wu');
  const r = await t.as(inLine.student).post('/api/enrollment/requests', { sessionId: small.id, weekday: 4 });
  assert.equal((await joinLine(t, inLine.parent, inLine.student, small, 4)).body.outcome, 'waitlisted'); // a parent put her in line first
  const a = await t.as(inLine.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
  assert.equal(a.body.outcome, 'full');
  const stored = t.db.prepare('SELECT outcome_message FROM enrollment_requests WHERE id = ?').get(r.body.request.id).outcome_message;
  assert.equal(stored, "Quiet Room on Thursdays is full. You're number 1 on its waitlist and will be enrolled automatically when a seat opens.");
  assert.equal(t.fx.notifications(inLine.student, 'enrollment_request_approved')[0].body,
    "Thursdays 4:30pm–6:30pm. You're number 1 on its waitlist and will be enrolled automatically when a seat opens.");

  // Nothing a student reads asks them to drop or join the waitlist, or names them in the third person.
  for (const f of [capped, full, inLine, ...cases.map(x => x[0])]) {
    const reqs = (await t.as(f.student).get('/api/enrollment/requests')).body.requests;
    const said = reqs.map(x => x.outcome_message).concat(t.fx.notifications(f.student).map(n => n.title + ' ' + n.body)).join(' ');
    assert.ok(!/Drop one|Join the waitlist/.test(said), said);
    assert.ok(!new RegExp('\\b' + f.student.name.split(' ')[0] + '\\b').test(said), said);
  }
});

// L30: a request approved while the slot was full (or blocked) says enrolled once the student holds that slot.
test(['EN-3', 'EN-5'], 'an approved request that could not enroll the student then says enrolled once they get that seat, from the waitlist or directly', async () => {
  const { t, loc, sess } = await world();
  const small = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  const [holder] = fill(t, loc, small, 4, 1);
  const f = t.fx.family(loc);
  const g = t.fx.family(loc); // another family asking for the same slot stays as it was
  const askAndApprove = async (fam, session, wd) => {
    const r = await t.as(fam.student).post('/api/enrollment/requests', { sessionId: session.id, weekday: wd });
    await t.as(fam.parent).post(`/api/enrollment/requests/${r.body.request.id}/approve`);
    return r.body.request.id;
  };
  const thu = await askAndApprove(f, small, 4);
  const tue = await askAndApprove(f, small, 2); // a seat was free on Tuesdays
  const other = await askAndApprove(g, small, 4);
  const req = id => t.db.prepare('SELECT outcome, outcome_message FROM enrollment_requests WHERE id = ?').get(id);
  assert.equal(req(thu).outcome, 'full');
  assert.equal(req(tue).outcome, 'enrolled');
  assert.equal((await joinLine(t, f.parent, f.student, small, 4)).body.outcome, 'waitlisted');
  const seat = t.db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND session_id = ? AND weekday = 4 AND status = 'active'").get(holder.student.id, small.id);
  assert.equal((await drop(t, holder.parent, seat.id)).status, 200); // the seat goes to the first in line
  assert.deepEqual(active(t, f.student).map(e => [e.session_id, e.weekday]), [[small.id, 2], [small.id, 4]]);
  const mine = (await t.as(f.student).get('/api/enrollment/requests')).body.requests.find(x => x.id === thu);
  assert.deepEqual([mine.status, mine.outcome, mine.outcome_message], ['approved', 'enrolled', null]);
  assert.equal(req(other).outcome, 'full', "another student's request is untouched");

  // Blocked at the cap, then the parent makes room and adds that slot.
  const capped = t.fx.family(loc, { cap: 1 });
  const held = t.fx.enroll(capped.student, sess, 1);
  const wed = await askAndApprove(capped, sess, 3);
  assert.equal(req(wed).outcome, 'blocked');
  assert.equal((await drop(t, capped.parent, held.id)).status, 200);
  assert.equal(req(wed).outcome, 'blocked', 'dropping alone enrolls nothing (no retry, D-17)');
  assert.equal((await enroll(t, capped.parent, capped.student, sess, 3)).status, 201);
  assert.deepEqual({ ...req(wed) }, { outcome: 'enrolled', outcome_message: null });
});

// L33: a renewal while today's session is running brings today's occurrence back; it is not "Paused"
// while the student can check in. If it ends unattended it stays paused, never absent.
test(['EN-7', 'MB-5'], "a spot restored while today's session is running shows today as upcoming, and as paused if it ends unattended", async () => {
  const { t, loc, sess } = await world(); // Mon/Wed/Fri 13:00-16:00
  const f = t.fx.family(loc), g = t.fx.family(loc);
  t.clock.set(at(LA, '2026-09-01', '09:00'));
  const e = t.fx.enroll(f.student, sess, 1);
  t.fx.enroll(g.student, sess, 1);
  t.clock.set(at(LA, '2026-10-24', '08:00')); // both memberships lapse and the spots pause (MB-5)
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE session_id = ?").run(sess.id);
  t.clock.set(at(LA, '2026-10-26', '13:05')); // Mon: f's membership is renewed five minutes into the session
  t.db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(e.id);
  const today = async (who, clock) => {
    t.clock.set(at(LA, '2026-10-26', clock));
    return (await t.as(who.parent).get(`/api/enrollment/students/${who.student.id}/schedule?from=2026-10-26&to=2026-11-02`))
      .body.occurrences.map(o => `${o.date} ${o.status}`);
  };
  assert.deepEqual(await today(f, '13:10'), ['2026-10-26 upcoming', '2026-11-02 upcoming']);
  assert.deepEqual(await today(g, '13:10'), ['2026-10-26 paused', '2026-11-02 paused'], 'a spot still paused stays paused');
  const tab = shellTab(t);
  await tab.open(f.student, '#/home');
  const card = tab.main().find(n => n.getAttribute('data-card') === 'enrollment-week');
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), ['Today 1pm–4pm Afternoon Study Upcoming']);
  // It ended and she never came: on hold when it began, so paused, not absent.
  assert.deepEqual(await today(f, '16:30'), ['2026-10-26 paused', '2026-11-02 upcoming']);
  // Had she checked in, it is attended.
  t.fx.visit(f.student, loc, { session: sess, weekday: 1, local_date: '2026-10-26', check_in_at: at(LA, '2026-10-26', '13:15'), check_out_at: at(LA, '2026-10-26', '16:00'), checkout_method: 'scan' });
  assert.deepEqual(await today(f, '16:30'), ['2026-10-26 attended', '2026-11-02 upcoming']);
});

// L52: with no way to add a session (no membership, or one that isn't active), Schedule and Home don't
// point the parent at "Add a session"; the notice there says why.
test(['EN-4'], 'a family that cannot add sessions is not told to pick one on Schedule or Home', async () => {
  const { t, loc } = await world();
  const none = t.fx.family(loc);
  t.db.prepare('DELETE FROM memberships WHERE student_id = ?').run(none.student.id);
  const off = t.fx.family(loc, { status: 'inactive' });
  const fine = t.fx.family(loc);
  const empty = tab => tab.main().findAll(n => n.tag === 'p' && /^No (weekly )?sessions/.test(words(n))).map(words);
  for (const [who, schedule, home] of [
    [none, 'No weekly sessions yet.', 'No sessions this week.'],
    [off, 'No weekly sessions yet.', 'No sessions this week.'],
    [fine, 'No weekly sessions yet. Pick one under "Add a session" below.', 'No sessions this week. Add one from Schedule.']]) {
    const tab = shellTab(t);
    await tab.open(who.parent, '#/schedule');
    assert.deepEqual(empty(tab).filter(w => /^No weekly/.test(w)), [schedule]);
    const enrolls = byTag(tab.main(), 'button').filter(b => /^Enroll /.test(b.getAttribute('aria-label') || ''));
    assert.ok(enrolls.length > 0 && enrolls.every(b => (b.getAttribute('disabled') !== null) === (who !== fine)));
    await tab.go('#/home');
    assert.deepEqual(empty(tab), [home]);
  }
  // A student can still ask, so their Home keeps pointing at Schedule.
  const tab = shellTab(t);
  await tab.open(none.student, '#/home');
  assert.deepEqual(empty(tab), ['No sessions this week. Ask a parent for one from Schedule.']);
});

// L29: the screens don't promise a retry that never comes.
test(['EN-3'], 'approving a request over the weekly cap says it could not be enrolled, never "yet", on the parent and student screens', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { cap: 1 });
  rename(t, f.student, 'Leo Garcia');
  t.fx.enroll(f.student, sess, 1);
  assert.equal((await t.as(f.student).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 3 })).status, 201);
  const parent = shellTab(t);
  await parent.open(f.parent, '#/schedule');
  const cardText = words(parent.main().find(n => n.getAttribute('aria-labelledby') === 'en-req-h'));
  assert.ok(cardText.includes("Approving won't enroll them: Leo already has 1 weekly session, the most the membership allows. Drop one to add another."), cardText);
  byTag(parent.main(), 'button').find(b => b.getAttribute('aria-label') === "Approve Leo's request for Afternoon Study on Wednesdays").click();
  await parent.settle();
  assert.deepEqual(parent.toasts(), ["Approved, but Leo couldn't be enrolled. Leo already has 1 weekly session, the most the membership allows. Drop one to add another."]);
  const student = shellTab(t);
  await student.open(f.student, '#/schedule');
  const row = student.main().find(n => n.getAttribute('aria-labelledby') === 'en-myreq-h').findAll(n => n.tag === 'li')[0];
  assert.match(words(row), /^Afternoon Study Wednesdays · 1pm–4pm · \S+ You already have 1 weekly session, the most your membership allows\. A parent can drop one to make room, then add this one\. Approved · not enrolled$/);
  assert.ok(!/\byet\b/.test(words(row)));
});

// L35: enrollment and request notices open Schedule on the student they are about.
test(['EN-2', 'EN-3', 'EN-5'], 'enrollment, waitlist and request notices in the Inbox open Schedule on the student they are about', async () => {
  const { t, loc, sess } = await world();
  const f = t.fx.family(loc, { students: 2 });
  const leo = rename(t, f.students[0], 'Leo Garcia'), sofia = rename(t, f.students[1], 'Sofia Garcia');
  const en = await enroll(t, f.parent, sofia, sess, 1); // Sofia is the second tab
  assert.equal(en.status, 201);
  const rq = await t.as(sofia).post('/api/enrollment/requests', { sessionId: sess.id, weekday: 3 });
  const links = tab => tab.main().findAll(n => n.tag === 'li').map(li => li.childNodes[0])
    .map(item => [words(item).replace(/^New /, '').split(' ').slice(0, 2).join(' '), item.tag === 'a' ? item.getAttribute('href') : null]);
  const parent = shellTab(t);
  await parent.open(f.parent, '#/inbox');
  const toEnrollment = '#/schedule/enrollment/' + en.body.enrollment.id, toRequest = '#/schedule/request/' + rq.body.request.id;
  assert.deepEqual(links(parent).sort(), [['Sofia asked', toRequest], ['Sofia is', toEnrollment]]);
  const shown = tab => [byTag(tab.main(), 'button').filter(b => b.getAttribute('role') === 'tab' && b.getAttribute('aria-selected') === 'true').map(b => b.textContent),
    words(tab.main().find(n => n.id === 'en-mine-h'))];
  for (const to of [toEnrollment, toRequest]) {
    await parent.go(to);
    assert.deepEqual(shown(parent), [['Sofia'], "Sofia's weekly sessions"], to);
    assert.ok(parent.main().find(n => n.id === 'en-week-h'), 'this week is shown');
  }
  await parent.go('#/schedule');
  assert.deepEqual(shown(parent), [['Leo'], "Leo's weekly sessions"]);
  // The student's own notice opens their schedule, with this week shown.
  const student = shellTab(t);
  await student.open(sofia, '#/inbox');
  assert.deepEqual(links(student), [['Sofia is', toEnrollment]]);
  await student.go(toEnrollment);
  assert.equal(byTag(student.main(), 'h1')[0].textContent, 'My schedule');
  assert.ok(student.main().find(n => n.id === 'en-week-h'), 'this week is shown');
  // A waitlist promotion carries the same kind of link.
  const small = t.fx.session(loc, { name: 'Quiet Room', weekdays: '2', start: '16:30', end: '18:30', capacity: 1 });
  const [holder] = fill(t, loc, small, 2, 1);
  assert.equal((await joinLine(t, f.parent, leo, small, 2)).body.outcome, 'waitlisted');
  const seat = t.db.prepare('SELECT id FROM enrollments WHERE student_id = ? AND session_id = ?').get(holder.student.id, small.id);
  assert.equal((await drop(t, holder.parent, seat.id)).status, 200);
  const promoted = t.db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND session_id = ? AND status = 'active'").get(leo.id, small.id);
  const later = shellTab(t);
  await later.open(f.parent, '#/inbox');
  assert.ok(links(later).some(([text, href]) => text === 'A seat' && href === '#/schedule/enrollment/' + promoted.id), JSON.stringify(links(later)));
  await later.go('#/schedule/enrollment/' + promoted.id);
  assert.deepEqual(shown(later), [['Leo'], "Leo's weekly sessions"]);
});
