'use strict';
// Module checkin (PRD 1): the rotating entrance code, scan check-in and
// check-out, the auto-checkout job, parent notifications, and the staff
// "In the building" list with manual check-in/out and visit review.
const { test, makeApp, assert, load, at } = require('./lib');

const LA = 'America/Los_Angeles', TO = 'America/Toronto';
const mod = () => load('src/modules/checkin/index.js');

// Irvine (LA), one family enrolled in Afternoon Study on Wednesdays (13:00-16:00), a v1
// per-weekday row (D-42: it counts only on Wednesdays; `weekday: 0` makes it the whole schedule),
// clock at Wed 2026-10-14 13:05 local.
// A scan sends the code only (D-49).
async function setup(opts = {}) {
  const t = await makeApp({ now: at(LA, '2026-10-14', '13:05'), dev: opts.dev });
  const loc = t.fx.location(Object.assign({ name: 'Irvine' }, opts.location));
  const fam = t.fx.family(loc, opts.family);
  const sess = t.fx.session(loc, { name: 'Afternoon Study', start: '13:00', end: '16:00', weekdays: '1,3,5' });
  t.fx.enroll(fam.student, sess, opts.weekday ?? 3);
  rename(t, fam.student, 'Maya Johnson');
  const staff = t.fx.staff(loc, { name: 'Chris Ortiz' });
  const code = (l = loc) => mod().currentCode(t.ctx, l, t.clock.now());
  const scan = (student = fam.student, extra = {}) =>
    t.as(student).post('/api/checkin/scan', Object.assign({ locationId: loc.id, code: code() }, extra));
  return Object.assign(t, { loc, fam, sess, staff, code, scan });
}
function rename(t, user, name) {
  t.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  user.name = name;
  return user;
}
// A new student at `loc`, optionally enrolled in `sess` on the given weekdays.
function kid(t, loc, name, sess, weekdays = [], famOpts) {
  const f = t.fx.family(loc, famOpts);
  rename(t, f.student, name);
  for (const wd of weekdays) t.fx.enroll(f.student, sess, wd);
  return Object.assign(f.student, { parent: f.parent });
}
const visitsOf = (t, student) => t.db.prepare('SELECT * FROM visits WHERE student_id = ? ORDER BY id').all(student.id);
const setClock = (t, hm, date = '2026-10-14', zone = LA) => t.clock.set(at(zone, date, hm));

// ---------------------------------------------------------------- CI-1 QR code

test(['CI-1'], "staff get today's entrance code with its app link and a QR picture of that link", async () => {
  const t = await setup();
  const r = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/qr`);
  assert.equal(r.status, 200);
  assert.equal(r.body.code, t.code());
  assert.match(r.body.code, /^[0-9a-f]{20}$/);
  assert.equal(r.body.url, `/#/scan/${t.loc.id}/${t.code()}`);
  assert.equal(r.body.link, t.base + r.body.url);
  assert.equal(r.body.svg, await require('qrcode').toString(r.body.link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  assert.match(r.body.svg, /^<svg[\s\S]*<\/svg>\s*$/);
  assert.equal(r.body.qr_day, '2026-10-14');
  assert.equal(r.body.valid_until, at(LA, '2026-10-15', '04:00'));
  assert.equal(r.body.location.name, 'Irvine');
  // every location has its own code
  assert.notEqual(t.code(t.fx.location()), t.code());
});

test(['CI-1', 'NF-4'], "the code rotates at qr_rotate_at in the location's own time zone", async () => {
  const t = await makeApp();
  const la = t.fx.location({ timezone: LA });
  const to = t.fx.location({ timezone: TO, lat: 43.6532, lng: -79.3832 });
  const late = t.fx.location({ timezone: LA, qr_rotate_at: '06:30' });
  const code = (loc, zone, date, hm) => mod().currentCode(t.ctx, loc, at(zone, date, hm));
  const wedLA = code(la, LA, '2026-10-14', '12:00');
  assert.equal(code(la, LA, '2026-10-15', '03:59'), wedLA, 'before 04:00 the previous day\'s code is still current');
  assert.notEqual(code(la, LA, '2026-10-15', '04:00'), wedLA, 'at 04:00 a new code starts');
  assert.equal(code(la, LA, '2026-10-15', '04:00'), code(la, LA, '2026-10-15', '23:59'));
  // Toronto flips at 04:00 Toronto time (01:00 in LA)
  const wedTO = code(to, TO, '2026-10-14', '12:00');
  assert.equal(code(to, TO, '2026-10-15', '03:59'), wedTO);
  assert.notEqual(code(to, TO, '2026-10-15', '04:00'), wedTO);
  // a director-chosen rotation time
  const wedLate = code(late, LA, '2026-10-14', '12:00');
  assert.equal(code(late, LA, '2026-10-15', '06:29'), wedLate);
  assert.notEqual(code(late, LA, '2026-10-15', '06:30'), wedLate);
  // the QR endpoint reports Toronto's own QR day and rotation instant
  t.clock.set(at(TO, '2026-10-15', '02:00')); // 23:00 on the 14th in LA
  const r = await t.as(t.fx.director(to)).get(`/api/checkin/locations/${to.id}/qr`);
  assert.equal(r.status, 200);
  assert.equal(r.body.qr_day, '2026-10-14');
  assert.equal(r.body.valid_until, at(TO, '2026-10-15', '04:00'));
});

test(['CI-1'], "yesterday's code stops working once the code rotates; a made-up or other location's code never works", async () => {
  const t = await setup({ location: { qr_rotate_at: '13:30' } });
  const tuesday = mod().currentCode(t.ctx, t.loc, at(LA, '2026-10-13', '15:00'));
  setClock(t, '13:10'); // QR day is still Tuesday until 13:30
  const ok = await t.scan(undefined, { code: tuesday });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.action, 'checkin');
  setClock(t, '13:30');
  const old = await t.scan(undefined, { code: tuesday });
  assert.equal(old.status, 403);
  assert.equal(old.body.error, 'code_expired');
  assert.equal(old.body.message, "This code has expired. Scan today's code at the entrance.");
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null, 'a refused scan changes nothing');
  const made = await t.scan(undefined, { code: 'abc123' });
  assert.equal(made.status, 403);
  assert.equal(made.body.error, 'bad_code');
  const theirs = await t.scan(undefined, { code: t.code(t.fx.location()) });
  assert.equal(theirs.body.error, 'bad_code');
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  const today = await t.scan();
  assert.equal(today.status, 200);
  assert.equal(today.body.action, 'checkout');
});

test(['CI-1'], 'a code with non-ASCII characters is refused as a bad code, not a server error', async () => {
  const t = await setup();
  // 20 characters but 40 bytes; 10 characters but the same 20 bytes as a real code; 19 ASCII + one 2-byte character
  for (const code of ['é'.repeat(20), 'é'.repeat(10), t.code().slice(0, 19) + 'é']) {
    const r = await t.scan(undefined, { code });
    assert.equal(r.status, 403, code);
    assert.equal(r.body.error, 'bad_code', code);
    assert.equal(r.body.message, "That code didn't work. Scan the code at the entrance again.");
  }
  assert.equal(visitsOf(t, t.fam.student).length, 0);
  assert.equal(t.fx.notifications(t.fam.parent).length, 0);
  const ok = await t.scan();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.action, 'checkin');
});

// ---------------------------------------------------------------- CI-2 location check

test(['CI-2', 'NF-5'], "a scan of today's code at the home location is being there: no coordinates are needed, and any sent are ignored (S-5, D-49)", async () => {
  const t = await setup();
  // the location itself needs no coordinates or radius (stored as 0, 0 and a radius nobody could be inside)
  t.db.prepare('UPDATE locations SET lat = 0, lng = 0, geofence_m = 1 WHERE id = ?').run(t.loc.id);
  const plain = await t.scan();
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.action, 'checkin');
  // far away, past a pole, text, objects: never read, so each one checks its student in
  const sent = [{ lat: 40.7128, lng: -74.006 }, { lat: 1e308, lng: 1e308 }, { lat: 146.3154, lng: 62.1735 },
    { lat: 'north', lng: null }, { lat: { toString: 1 }, lng: [1] }];
  for (const [i, c] of sent.entries()) {
    const kidN = kid(t, t.loc, 'Kid ' + i, t.sess, [3]);
    const r = await t.scan(kidN, c);
    assert.equal(r.status, 200, JSON.stringify(c));
    assert.equal(r.body.action, 'checkin', JSON.stringify(c));
  }
  // and the same goes for a check-out
  setClock(t, '15:00');
  const out = await t.scan(undefined, { lat: 40.7128, lng: -74.006 });
  assert.equal(out.body.action, 'checkout');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 6);
});

test(['CI-2', 'NF-1'], 'only students scan, and only at their home location (D-1)', async () => {
  const t = await setup();
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const visitor = kid(t, arcadia, 'Ana Lopez');
  const r = await t.scan(visitor);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'wrong_location');
  assert.equal(r.body.message, "This code is for Irvine. You're a member at Arcadia. Scan the code at Arcadia, or ask staff at the front desk.");
  for (const u of [t.fam.parent, t.staff, t.fx.director(t.loc), t.fx.hq()]) {
    const x = await t.as(u).post('/api/checkin/scan', { locationId: t.loc.id, code: t.code() });
    assert.equal(x.status, 403, u.role);
    assert.equal(x.body.error, 'forbidden', u.role);
  }
  assert.equal((await t.anon.post('/api/checkin/scan', { locationId: t.loc.id, code: t.code() })).status, 401);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
});

// ---------------------------------------------------------------- CI-3 enrolled slot

test(['CI-3'], 'a scan check-in is linked to the enrolled session and weekday', async () => {
  const t = await setup();
  const r = await t.scan();
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'checkin');
  assert.deepEqual(r.body.session, { id: t.sess.id, name: 'Afternoon Study', start_at: at(LA, '2026-10-14', '13:00'), end_at: at(LA, '2026-10-14', '16:00') });
  const [v] = visitsOf(t, t.fam.student);
  assert.deepEqual(
    { session_id: v.session_id, weekday: v.weekday, local_date: v.local_date, check_in_at: v.check_in_at, location_id: v.location_id,
      checkin_method: v.checkin_method, check_out_at: v.check_out_at, checked_in_by: v.checked_in_by },
    { session_id: t.sess.id, weekday: 3, local_date: '2026-10-14', check_in_at: at(LA, '2026-10-14', '13:05'), location_id: t.loc.id,
      checkin_method: 'scan', check_out_at: null, checked_in_by: null });
  assert.equal(r.body.visit.id, v.id);
});

test(['CI-3'], 'the check-in window opens 30 minutes before the start and closes at the end (D-13)', async () => {
  const t = await setup();
  setClock(t, '12:29');
  const early = await t.scan();
  assert.equal(early.status, 403);
  assert.equal(early.body.error, 'no_session');
  assert.equal(early.body.message, 'Check-in for your 1:00 PM session opens at 12:30 PM. Staff can check you in if needed.');
  setClock(t, '12:30');
  assert.equal((await t.scan()).status, 200);
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3, 5]);
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3, 5]);
  setClock(t, '16:00');
  const last = await t.scan(leo);
  assert.equal(last.status, 200);
  assert.equal(last.body.action, 'checkin');
  setClock(t, '16:01');
  const late = await t.scan(ivy);
  assert.equal(late.status, 403);
  assert.equal(late.body.error, 'no_session');
  assert.equal(late.body.message, "You don't have a session right now. Your next one is Fri, Oct 16 at 1:00 PM. Staff can check you in if needed.");
  assert.equal(visitsOf(t, ivy).length, 0);
});

test(['CI-3'], 'no check-in without a live enrollment that day: paused, other weekday, cancelled session, past term, or closure', async () => {
  const t = await setup();
  const paused = kid(t, t.loc, 'Pat Paused');
  t.fx.enroll(paused, t.sess, 3, { status: 'paused' });
  const monday = kid(t, t.loc, 'Mo Monday', t.sess, [1]);
  const cancelled = t.fx.session(t.loc, { name: 'Old Block', weekdays: '3', start: '13:00', end: '16:00' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(cancelled.id);
  const cx = kid(t, t.loc, 'Cy Cancelled', cancelled, [3]);
  const summer = t.fx.term(t.loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-14' });
  const summerSess = t.fx.session(t.loc, { term: summer, name: 'Summer Study', weekdays: '3', start: '13:00', end: '16:00' });
  const past = kid(t, t.loc, 'Sam Summer', summerSess, [3]);
  const none = kid(t, t.loc, 'Nia None');
  for (const s of [paused, monday, cx, past, none]) {
    const r = await t.scan(s);
    assert.equal(r.status, 403, s.name);
    assert.equal(r.body.error, 'no_session', s.name);
    assert.match(r.body.message, /Staff can check you in if needed\.$/);
    assert.equal(visitsOf(t, s).length, 0, s.name);
    assert.equal(t.fx.notifications(s.parent).length, 0, s.name);
  }
  // a closure cancels the day's slots even for an enrolled student (SC-3), and the scan says the center is closed (L31)
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-14', 'Staff training');
  const closed = await t.scan();
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error, 'no_session');
  assert.equal(closed.body.message, 'Irvine is closed today (Staff training), so there are no sessions. Your next one is Wed, Oct 21 at 1:00 PM.');
  assert.equal(visitsOf(t, t.fam.student).length, 0);
});

test(['CI-3', 'NF-1'], 'status tells a student their sessions are paused by a lapsed membership, and only for that student', async () => {
  const t = await setup();
  const lapsed = kid(t, t.loc, 'Dan Lapsed', t.sess, [1], { status: 'inactive' });
  t.db.prepare("UPDATE enrollments SET status = 'paused' WHERE student_id = ?").run(lapsed.id);
  const mine = await t.as(lapsed).get('/api/checkin/status');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.students.length, 1);
  assert.equal(mine.body.students[0].paused, true);
  assert.equal(mine.body.students[0].next, null);
  const other = await t.as(t.fam.student).get('/api/checkin/status');
  assert.equal(other.body.students[0].paused, false);
});

test(['CI-3'], 'an inactive or expired membership is refused with its own message; the last valid day still works', async () => {
  const t = await setup();
  const inactive = kid(t, t.loc, 'Ina Active', t.sess, [3], { status: 'inactive' });
  const expired = kid(t, t.loc, 'Ed Expired', t.sess, [3], { expires: '2026-10-13' });
  const lastDay = kid(t, t.loc, 'Lu Lastday', t.sess, [3], { expires: '2026-10-14' });
  for (const s of [inactive, expired]) {
    const r = await t.scan(s);
    assert.equal(r.status, 403, s.name);
    assert.equal(r.body.error, 'membership_inactive', s.name);
    assert.equal(r.body.message, "Your membership isn't active, so your sessions are paused. Ask a parent or the front desk at Irvine to renew it.");
    assert.equal(visitsOf(t, s).length, 0);
  }
  const ok = await t.scan(lastDay);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.action, 'checkin');
});

test(['CI-3'], 'with several sessions the check-in links the one whose window is open', async () => {
  const t = await setup();
  const morning = t.fx.session(t.loc, { name: 'Morning Focus', weekdays: '3', start: '09:30', end: '12:00' });
  t.fx.enroll(t.fam.student, morning, 3);
  const leo = kid(t, t.loc, 'Leo Garcia', morning, [3]);
  t.fx.enroll(leo, t.sess, 3);
  setClock(t, '11:40'); // morning running, afternoon window not yet open
  const a = await t.scan(leo);
  assert.equal(a.body.session.id, morning.id);
  setClock(t, '12:40'); // morning over, afternoon window open
  const b = await t.scan();
  assert.equal(b.status, 200);
  assert.equal(b.body.session.id, t.sess.id);
  assert.equal(visitsOf(t, t.fam.student)[0].session_id, t.sess.id);
});

// ---------------------------------------------------------------- CI-4 check-out

test(['CI-4'], 'scanning the same code again checks the student out; a later scan starts a new visit', async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '15:50');
  const out = await t.scan();
  assert.equal(out.status, 200);
  assert.equal(out.body.action, 'checkout');
  assert.equal(out.body.total_minutes, 165);
  let vs = visitsOf(t, t.fam.student);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].check_out_at, at(LA, '2026-10-14', '15:50'));
  assert.equal(vs[0].checkout_method, 'scan');
  assert.equal(vs[0].flagged, 0);
  setClock(t, '15:55');
  const back = await t.scan();
  assert.equal(back.body.action, 'checkin');
  vs = visitsOf(t, t.fam.student);
  assert.equal(vs.length, 2);
  assert.equal(vs[1].check_out_at, null);
  assert.equal(vs[0].check_out_at, at(LA, '2026-10-14', '15:50'));
});

test(['CI-4'], 'a second scan within five minutes of checking in asks before checking out', async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '13:08');
  const ask = await t.scan();
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error, 'confirm_checkout');
  assert.equal(ask.body.message, 'You checked in at 1:05 PM. Check out now?');
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  const yes = await t.scan(undefined, { confirm: true });
  assert.equal(yes.status, 200);
  assert.equal(yes.body.action, 'checkout');
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, at(LA, '2026-10-14', '13:08'));
});

test(['CI-4', 'CI-6'], 'a second scan within five minutes of checking out asks before checking back in, and tells nobody until confirmed', async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '15:50');
  assert.equal((await t.scan()).body.action, 'checkout');
  for (const hm of ['15:52', '15:54']) {
    setClock(t, hm);
    const ask = await t.scan();
    assert.equal(ask.status, 409, hm);
    assert.equal(ask.body.error, 'confirm_checkin', hm);
    assert.equal(ask.body.message, 'You checked out at 3:50 PM. Check back in?', hm);
  }
  assert.equal(visitsOf(t, t.fam.student).length, 1, 'no phantom visit');
  assert.equal(t.fx.notifications(t.fam.parent, 'checkin').length, 1, 'no second "checked in" notice');
  const status = await t.as(t.fam.parent).get('/api/checkin/status');
  assert.equal(status.body.students[0].state, 'left');
  const yes = await t.scan(undefined, { confirm: true });
  assert.equal(yes.status, 200);
  assert.equal(yes.body.action, 'checkin');
  const vs = visitsOf(t, t.fam.student);
  assert.equal(vs.length, 2);
  assert.deepEqual([vs[1].check_in_at, vs[1].check_out_at], [at(LA, '2026-10-14', '15:54'), null]);
  assert.equal(t.fx.notifications(t.fam.parent, 'checkin').length, 2);
  // the question is about the latest check-out of the day
  setClock(t, '15:58');
  assert.equal((await t.scan(undefined, { confirm: true })).body.action, 'checkout');
  setClock(t, '16:00');
  const again = await t.scan();
  assert.equal(again.body.error, 'confirm_checkin');
  assert.equal(again.body.message, 'You checked out at 3:58 PM. Check back in?');
  assert.equal(visitsOf(t, t.fam.student).length, 2);
});

test(['CI-4'], 'a scan check-out names the session and the total time; a visit with no session names none', async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '15:50');
  const out = await t.scan();
  assert.equal(out.status, 200);
  assert.equal(out.body.action, 'checkout');
  assert.deepEqual(out.body.session, { id: t.sess.id, name: 'Afternoon Study', start_at: at(LA, '2026-10-14', '13:00'), end_at: at(LA, '2026-10-14', '16:00') });
  assert.equal(out.body.total_minutes, 165);
  // a staff override check-in has no session, so the check-out names none
  const leo = kid(t, t.loc, 'Leo Garcia');
  assert.equal((await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id, override: true })).status, 200);
  setClock(t, '16:30');
  const leoOut = await t.scan(leo);
  assert.equal(leoOut.body.action, 'checkout');
  assert.equal(leoOut.body.session, null);
  assert.equal(leoOut.body.total_minutes, 40);
  // the parent's check-out notice names the session when there is one, and none when there isn't
  assert.equal(t.fx.notifications(t.fam.parent, 'checkout')[0].body, 'Afternoon Study. Total time 2h 45m.');
  assert.equal(t.fx.notifications(leo.parent, 'checkout')[0].body, 'Total time 40m.');
});

// ---------------------------------------------------------------- CI-5 auto-checkout

test(['CI-5'], 'an open visit is checked out automatically at the session end and flagged for review', async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  await t.scan();
  await t.scan(leo);
  setClock(t, '15:30');
  await t.scan(leo); // Leo scans out himself
  setClock(t, '15:59');
  t.jobs();
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null, 'nothing happens before the session ends');
  setClock(t, '16:20');
  assert.ok(t.jobs().includes('checkin.auto-checkout'));
  const [v] = visitsOf(t, t.fam.student);
  assert.equal(v.check_out_at, at(LA, '2026-10-14', '16:00'));
  assert.equal(v.checkout_method, 'auto');
  assert.equal(v.flagged, 1);
  assert.equal(v.flag_reason, 'Did not scan out');
  const [l] = visitsOf(t, leo);
  assert.equal(l.check_out_at, at(LA, '2026-10-14', '15:30'));
  assert.equal(l.checkout_method, 'scan');
  assert.equal(l.flagged, 0);
});

test(['CI-5'], "the location's closing time wins when it comes first; a visit with no session closes at closing time", async () => {
  const t = await setup({ location: { close_time: '15:00' } });
  await t.scan();
  const walkIn = kid(t, t.loc, 'Wes Walkin');
  t.fx.visit(walkIn, t.loc, { check_in_at: at(LA, '2026-10-14', '13:00'), checkin_method: 'staff' });
  setClock(t, '14:59');
  t.jobs();
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  assert.equal(visitsOf(t, walkIn)[0].check_out_at, null);
  setClock(t, '15:01');
  t.jobs();
  for (const s of [t.fam.student, walkIn]) {
    const [v] = visitsOf(t, s);
    assert.equal(v.check_out_at, at(LA, '2026-10-14', '15:00'), s.name);
    assert.equal(v.checkout_method, 'auto');
    assert.equal(v.flagged, 1);
  }
  const [n] = t.fx.notifications(t.fam.parent, 'checkout_auto');
  assert.equal(n.body, "Maya didn't scan out of Afternoon Study at Irvine, so the app checked them out when Irvine closed. Total time 1h 55m. Staff will review it.");
  // a visit with no session names no session (F14)
  const [w] = t.fx.notifications(walkIn.parent, 'checkout_auto');
  assert.equal(w.body, "Wes didn't scan out of Irvine, so the app checked them out when Irvine closed. Total time 2h 0m. Staff will review it.");
});

test(['CI-5', 'NF-4', 'CI-3'], "check-in windows and auto-checkout run on each location's own clock (Toronto)", async () => {
  const t = await makeApp({ now: at(TO, '2026-10-14', '09:10') }); // 06:10 in LA
  const to = t.fx.location({ name: 'Toronto', timezone: TO, lat: 43.6532, lng: -79.3832 });
  const fam = t.fx.family(to);
  const s = t.fx.session(to, { name: 'Morning Focus', weekdays: '3', start: '09:00', end: '11:30' });
  t.fx.enroll(fam.student, s, 3);
  const r = await t.as(fam.student).post('/api/checkin/scan', { locationId: to.id, code: mod().currentCode(t.ctx, to, t.clock.now()) });
  assert.equal(r.status, 200);
  assert.equal(r.body.session.end_at, at(TO, '2026-10-14', '11:30'));
  assert.equal(visitsOf(t, fam.student)[0].local_date, '2026-10-14');
  t.clock.set(at(TO, '2026-10-14', '11:29'));
  t.jobs();
  assert.equal(visitsOf(t, fam.student)[0].check_out_at, null);
  t.clock.set(at(TO, '2026-10-14', '11:31'));
  t.jobs();
  const [v] = visitsOf(t, fam.student);
  assert.equal(v.check_out_at, at(TO, '2026-10-14', '11:30'));
  assert.equal(v.checkout_method, 'auto');
  const [n] = t.fx.notifications(fam.parent, 'checkout_auto');
  assert.match(n.title, /checked out automatically · 11:30 AM$/);
  // a staff override visit (no session) closes at Toronto's 20:00, not LA's
  const walkIn = t.fx.family(to).student;
  t.fx.visit(walkIn, to, { local_date: '2026-10-14', check_in_at: at(TO, '2026-10-14', '12:00'), checkin_method: 'staff' });
  t.clock.set(at(TO, '2026-10-14', '19:59'));
  t.jobs();
  assert.equal(visitsOf(t, walkIn)[0].check_out_at, null);
  t.clock.set(at(TO, '2026-10-14', '20:01'));
  t.jobs();
  assert.equal(visitsOf(t, walkIn)[0].check_out_at, at(TO, '2026-10-14', '20:00'));
});

// ---------------------------------------------------------------- CI-6 parent notifications

test(['CI-6'], 'every active linked parent is told about each check-in and check-out, in one readable sentence', async () => {
  const t = await setup();
  const second = t.fx.user('parent', { location: t.loc });
  t.fx.link(second, t.fam.student);
  const pending = t.fx.user('parent', { location: t.loc });
  t.fx.link(pending, t.fam.student, 'pending');
  await t.scan();
  const [v] = visitsOf(t, t.fam.student);
  for (const p of [t.fam.parent, second]) {
    const n = t.fx.notifications(p, 'checkin');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Maya checked in at Irvine · 1:05 PM');
    assert.equal(n[0].body, 'Afternoon Study, until 4:00 PM.');
    assert.equal(n[0].ref_type, 'visit');
    assert.equal(n[0].ref_id, v.id);
  }
  setClock(t, '15:47');
  await t.scan();
  for (const p of [t.fam.parent, second]) {
    const n = t.fx.notifications(p, 'checkout');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Maya checked out of Irvine · 3:47 PM');
    assert.equal(n[0].body, 'Afternoon Study. Total time 2h 42m.', 'the check-out names the session, as the check-in does');
  }
  assert.equal(t.fx.notifications(pending).length, 0, 'a pending guardian is not told');
  assert.equal(t.fx.notifications(t.fam.student).length, 0);
  // a refused scan tells nobody
  const leo = kid(t, t.loc, 'Leo Garcia');
  await t.scan(leo);
  assert.equal(t.fx.notifications(leo.parent).length, 0);
});

test(['CI-6', 'CI-5'], 'an automatic check-out is labeled as automatic, once', async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '16:30');
  t.jobs();
  t.jobs();
  const auto = t.fx.notifications(t.fam.parent, 'checkout_auto');
  assert.equal(auto.length, 1);
  assert.equal(auto[0].title, 'Maya was checked out automatically · 4:00 PM');
  assert.equal(auto[0].body, "Maya didn't scan out of Afternoon Study at Irvine, so the app checked them out when the session ended. Total time 2h 55m. Staff will review it.",
    'the automatic check-out names the session, as the scan and staff ones do (F14)');
  assert.equal(auto[0].ref_id, visitsOf(t, t.fam.student)[0].id);
  assert.equal(t.fx.notifications(t.fam.parent, 'checkout').length, 0);
});

// ---------------------------------------------------------------- CI-7 staff

test(['CI-7', 'NF-1'], 'In the building lists who is here, who is still expected and who has left, for that location only', async () => {
  const t = await setup();
  const evening = t.fx.session(t.loc, { name: 'Evening Study', weekdays: '3', start: '17:00', end: '19:00' });
  const morning = t.fx.session(t.loc, { name: 'Morning Focus', weekdays: '3', start: '09:30', end: '12:00' });
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]);
  const eve = kid(t, t.loc, 'Eve Early', evening, [3]);     // here early on a staff override
  const evan = kid(t, t.loc, 'Evan Evening', evening, [3]);
  kid(t, t.loc, 'Mo Monday', t.sess, [1]);
  kid(t, t.loc, 'Max Morning', morning, [3]); // slot already over: absent, not expected
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const arcSess = t.fx.session(arcadia, { weekdays: '3', start: '13:00', end: '16:00' });
  kid(t, arcadia, 'Ari Arcadia', arcSess, [3]);
  const rae = kid(t, t.loc, 'Rae Returned', t.sess, [3]);
  await t.scan();
  await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: eve.id, override: true });
  await t.scan(leo);
  await t.scan(rae);
  setClock(t, '13:20');
  await t.scan(leo);
  await t.scan(rae); // out...
  await t.scan(rae, { confirm: true }); // ...and back in, confirmed (a scan this soon after checking out asks first)
  const r = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`);
  assert.equal(r.status, 200);
  assert.equal(r.body.today, '2026-10-14');
  assert.deepEqual(r.body.here.map(v => [v.name, v.session_name, v.checkin_method]),
    [['Maya Johnson', 'Afternoon Study', 'scan'], ['Eve Early', null, 'staff'], ['Rae Returned', 'Afternoon Study', 'scan']]);
  assert.equal(r.body.here[0].check_in_at, at(LA, '2026-10-14', '13:05'));
  assert.equal(r.body.here[0].ends_at, at(LA, '2026-10-14', '16:00'));
  assert.deepEqual(r.body.left.map(v => [v.name, v.checkout_method, v.check_out_at]), [['Leo Garcia', 'scan', at(LA, '2026-10-14', '13:20')]]);
  assert.deepEqual(r.body.expected.map(e => [e.student_id, e.name, e.session_name, e.start_at]),
    [[ivy.id, 'Ivy Chen', 'Afternoon Study', at(LA, '2026-10-14', '13:00')], [evan.id, 'Evan Evening', 'Evening Study', at(LA, '2026-10-14', '17:00')]]);
  assert.deepEqual(r.body.needs_review, []);
});

test(['CI-7', 'NF-2', 'CI-6'], 'staff check in a student with no session only as an explicit override, logged with their name', async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia');
  const ask = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id, reason: 'Phone is dead' });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error, 'no_session');
  assert.equal(ask.body.message, "Leo doesn't have a session right now. Check them in anyway?");
  assert.equal(visitsOf(t, leo).length, 0);
  const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id, reason: 'Phone is dead', override: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.override, true);
  const [v] = visitsOf(t, leo);
  assert.deepEqual({ m: v.checkin_method, by: v.checked_in_by, s: v.session_id, wd: v.weekday, d: v.local_date, at: v.check_in_at },
    { m: 'staff', by: t.staff.id, s: null, wd: null, d: '2026-10-14', at: at(LA, '2026-10-14', '13:05') });
  const logs = t.fx.audit('checkin.manual_checkin');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_id, t.staff.id);
  assert.equal(logs[0].target_type, 'visit');
  assert.equal(logs[0].target_id, v.id);
  assert.equal(logs[0].location_id, t.loc.id);
  assert.deepEqual(JSON.parse(logs[0].detail),
    { student_id: leo.id, student: 'Leo Garcia', staff: 'Chris Ortiz', reason: 'Phone is dead', override: true, session: null });
  const [n] = t.fx.notifications(leo.parent, 'checkin');
  assert.equal(n.title, 'Leo was checked in by staff at Irvine · 1:05 PM');
  assert.equal(n.body, 'Checked in by Chris Ortiz.');
  const again = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id, override: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_here');
  assert.equal(visitsOf(t, leo).length, 1);
  assert.equal(t.fx.audit('checkin.manual_checkin').length, 1);
});

test(['CI-7', 'NF-2', 'CI-6'], 'a manual check-in links the enrolled session; a manual check-out is logged with the staff member', async () => {
  const t = await setup();
  const dir = t.fx.director(t.loc, { name: 'Dana Park' });
  const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: t.fam.student.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.override, false);
  const [v] = visitsOf(t, t.fam.student);
  assert.equal(v.session_id, t.sess.id);
  assert.equal(v.weekday, 3);
  assert.equal(JSON.parse(t.fx.audit('checkin.manual_checkin')[0].detail).session, 'Afternoon Study');
  assert.equal(t.fx.notifications(t.fam.parent, 'checkin')[0].body, 'Afternoon Study, until 4:00 PM. Checked in by Chris Ortiz.');
  setClock(t, '14:00');
  const out = await t.as(dir).post(`/api/checkin/visits/${v.id}/checkout`, { reason: 'Left early with a parent' });
  assert.equal(out.status, 200);
  const [o] = visitsOf(t, t.fam.student);
  assert.equal(o.check_out_at, at(LA, '2026-10-14', '14:00'));
  assert.equal(o.checkout_method, 'staff');
  assert.equal(o.checked_out_by, dir.id);
  const logs = t.fx.audit('checkin.manual_checkout');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_id, dir.id);
  assert.equal(logs[0].target_id, v.id);
  assert.deepEqual(JSON.parse(logs[0].detail), { student_id: t.fam.student.id, student: 'Maya Johnson', staff: 'Dana Park', reason: 'Left early with a parent' });
  const [n] = t.fx.notifications(t.fam.parent, 'checkout');
  assert.equal(n.title, 'Maya was checked out by staff at Irvine · 2:00 PM');
  assert.equal(n.body, 'Afternoon Study. Total time 55m. Checked out by Dana Park.');
  const again = await t.as(dir).post(`/api/checkin/visits/${v.id}/checkout`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_out');
  assert.equal(t.fx.audit('checkin.manual_checkout').length, 1);
});

test(['CI-7', 'NF-2'], 'flagged visits wait for review; staff confirm them or fix the time out, and each review is logged', async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia');
  await t.scan();
  setClock(t, '16:30');
  t.jobs(); // Maya's visit is now auto-checked-out and flagged
  const yday = t.fx.visit(leo, t.loc, { session: t.sess, weekday: 2, local_date: '2026-10-13', check_in_at: at(LA, '2026-10-13', '13:00'),
    check_out_at: at(LA, '2026-10-13', '16:00'), checkout_method: 'auto', flagged: 1 });
  const fine = t.fx.visit(leo, t.loc, { local_date: '2026-10-12', check_in_at: at(LA, '2026-10-12', '13:00'),
    check_out_at: at(LA, '2026-10-12', '15:00'), checkout_method: 'scan' });
  const [maya] = visitsOf(t, t.fam.student);
  const list = async () => (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body.needs_review;
  assert.deepEqual((await list()).map(v => [v.visit_id, v.name, v.flag_reason]), [[maya.id, 'Maya Johnson', 'Did not scan out'], [yday.id, 'Leo Garcia', null]]);

  // confirm the automatic time
  const ok = await t.as(t.staff).post(`/api/checkin/visits/${maya.id}/review`, {});
  assert.equal(ok.status, 200);
  const m = t.db.prepare('SELECT * FROM visits WHERE id = ?').get(maya.id);
  assert.deepEqual([m.reviewed_by, m.check_out_at, m.checkout_method], [t.staff.id, at(LA, '2026-10-14', '16:00'), 'auto']);

  // bad corrections are refused and change nothing
  for (const out_time of ['12:59', '25:00', '1pm']) {
    const bad = await t.as(t.staff).post(`/api/checkin/visits/${yday.id}/review`, { out_time });
    assert.equal(bad.status, 400, out_time);
    assert.equal(bad.body.error, 'bad_time');
  }
  setClock(t, '15:00', '2026-10-13'); // "now" is before Tuesday 16:00 again
  const future = await t.as(t.staff).post(`/api/checkin/visits/${yday.id}/review`, { out_time: '15:30' });
  assert.equal(future.status, 400);
  assert.equal(t.db.prepare('SELECT reviewed_by FROM visits WHERE id = ?').get(yday.id).reviewed_by, null);
  setClock(t, '16:30');

  // fix the time out
  const fix = await t.as(t.staff).post(`/api/checkin/visits/${yday.id}/review`, { out_time: '15:10' });
  assert.equal(fix.status, 200);
  const y = t.db.prepare('SELECT * FROM visits WHERE id = ?').get(yday.id);
  assert.deepEqual([y.reviewed_by, y.check_out_at, y.checkout_method, y.checked_out_by], [t.staff.id, at(LA, '2026-10-13', '15:10'), 'staff', t.staff.id]);
  assert.deepEqual(await list(), []);

  const logs = t.fx.audit('checkin.review');
  assert.deepEqual(logs.map(l => [l.actor_id, l.target_id]), [[t.staff.id, maya.id], [t.staff.id, yday.id]]);
  assert.deepEqual(JSON.parse(logs[1].detail), {
    student_id: leo.id, student: 'Leo Garcia', staff: 'Chris Ortiz',
    before: { check_out_at: at(LA, '2026-10-13', '16:00'), checkout_method: 'auto' },
    after: { check_out_at: at(LA, '2026-10-13', '15:10'), checkout_method: 'staff' },
  });
  const twice = await t.as(t.staff).post(`/api/checkin/visits/${maya.id}/review`, {});
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, 'already_reviewed');
  const notFlagged = await t.as(t.staff).post(`/api/checkin/visits/${fine.id}/review`, {});
  assert.equal(notFlagged.status, 409);
  assert.equal(notFlagged.body.error, 'not_flagged');
  assert.equal(t.fx.audit('checkin.review').length, 2);
});

test(['CI-7', 'NF-2'], '"Fix time out" saved with the automatic time unchanged confirms it, exactly like "Time is right"', async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '16:30');
  t.jobs(); // Maya is checked out automatically at 16:00 and flagged
  const [maya] = visitsOf(t, t.fam.student);
  // The fix form opens at 16:00; staff press "Save time out" without changing it.
  const r = await t.as(t.staff).post(`/api/checkin/visits/${maya.id}/review`, { out_time: '16:00' });
  assert.equal(r.status, 200);
  const m = visitsOf(t, t.fam.student)[0];
  assert.deepEqual([m.reviewed_by, m.check_out_at, m.checkout_method, m.checked_out_by], [t.staff.id, at(LA, '2026-10-14', '16:00'), 'auto', null]);
  const b = (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  assert.deepEqual(b.needs_review, []);
  assert.deepEqual(b.left.map(v => [v.visit_id, v.checkout_method, v.checked_out_by_name]), [[maya.id, 'auto', null]]);
  const logs = t.fx.audit('checkin.review');
  assert.deepEqual(logs.map(l => [l.actor_id, l.target_id]), [[t.staff.id, maya.id]]);
  assert.deepEqual(JSON.parse(logs[0].detail), {
    student_id: t.fam.student.id, student: 'Maya Johnson', staff: 'Chris Ortiz',
    before: { check_out_at: at(LA, '2026-10-14', '16:00'), checkout_method: 'auto' },
    after: { check_out_at: at(LA, '2026-10-14', '16:00'), checkout_method: 'auto' },
  });

  // An automatic time out with seconds (checked in after closing, so it is the check-in time) shows as 18:05
  // in the form; saving that unchanged also just confirms it, keeping the exact time.
  const leo = kid(t, t.loc, 'Leo Garcia');
  const late = at(LA, '2026-10-13', '18:05') + 23000;
  const v = t.fx.visit(leo, t.loc, { local_date: '2026-10-13', check_in_at: late, checkin_method: 'staff', checked_in_by: t.staff.id,
    check_out_at: late, checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' });
  const same = await t.as(t.staff).post(`/api/checkin/visits/${v.id}/review`, { out_time: '18:05' });
  assert.equal(same.status, 200);
  const l = visitsOf(t, leo)[0];
  assert.deepEqual([l.reviewed_by, l.check_out_at, l.checkout_method, l.checked_out_by], [t.staff.id, late, 'auto', null]);
  assert.equal(t.fx.audit('checkin.review').length, 2);
});

test(['CI-7', 'NF-2'], 'In the building names who checked a visit in or out by hand and why, in Here, Left today and Needs review', async () => {
  const t = await setup();
  const dir = t.fx.director(t.loc, { name: 'Dana Park' });
  const leo = kid(t, t.loc, 'Leo Garcia');
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]);
  const ana = kid(t, t.loc, 'Ana Lopez', t.sess, [3]);
  await t.scan(); // Maya scans in herself
  assert.equal((await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id, override: true, reason: 'Phone is dead' })).status, 200);
  assert.equal((await t.as(dir).post('/api/checkin/manual-checkin', { studentId: ivy.id, reason: 'Picked up from the dentist' })).status, 200);
  assert.equal((await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: ana.id })).status, 200); // no reason given
  setClock(t, '14:00');
  const [ivyVisit] = visitsOf(t, ivy);
  assert.equal((await t.as(t.staff).post(`/api/checkin/visits/${ivyVisit.id}/checkout`, { reason: 'Leaving early' })).status, 200);
  const by = v => [v.name, v.checked_in_by_name, v.checkin_reason, v.checked_out_by_name, v.checkout_reason];
  const b = (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  assert.deepEqual(b.here.map(by), [
    ['Maya Johnson', null, null, null, null],
    ['Leo Garcia', 'Chris Ortiz', 'Phone is dead', null, null],
    ['Ana Lopez', 'Chris Ortiz', null, null, null],
  ]);
  assert.deepEqual(b.left.map(by), [['Ivy Chen', 'Dana Park', 'Picked up from the dentist', 'Chris Ortiz', 'Leaving early']]);
  // Leo is never scanned out: the auto-checkout flags the visit, and Needs review still says who checked him in and why
  setClock(t, '20:30');
  t.jobs();
  const r = (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body.needs_review;
  const leoRow = r.find(v => v.student_id === leo.id);
  assert.deepEqual([leoRow.checkin_method, ...by(leoRow)], ['staff', 'Leo Garcia', 'Chris Ortiz', 'Phone is dead', null, null]);
  assert.deepEqual(by(r.find(v => v.student_id === t.fam.student.id)), ['Maya Johnson', null, null, null, null]);
  assert.equal(r.find(v => v.student_id === t.fam.student.id).checkin_method, 'scan');
});

test(['CI-7'], "a manual check-in warns when the student's membership isn't active, and goes through only when staff confirm", async () => {
  const t = await setup();
  const daniel = kid(t, t.loc, 'Daniel Kim', t.sess, [3], { status: 'inactive' });
  const ed = kid(t, t.loc, 'Ed Expired', t.sess, [3], { expires: '2026-10-13' });
  const lu = kid(t, t.loc, 'Lu Lastday', t.sess, [3], { expires: '2026-10-14' });
  // staff see it before they open the dialog: in the search and in the expected list
  const found = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/students?q=`);
  assert.deepEqual(found.body.students.filter(s => [daniel.id, ed.id, lu.id, t.fam.student.id].includes(s.id)).map(s => [s.name, s.membership_active]),
    [['Daniel Kim', false], ['Ed Expired', false], ['Lu Lastday', true], ['Maya Johnson', true]]);
  const b = (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  assert.deepEqual(b.expected.map(e => [e.name, e.membership_active]).sort(),
    [['Daniel Kim', false], ['Ed Expired', false], ['Lu Lastday', true], ['Maya Johnson', true]]);
  for (const s of [daniel, ed]) {
    const ask = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: s.id, reason: 'Phone is dead' });
    assert.equal(ask.status, 409, s.name);
    assert.equal(ask.body.error, 'membership_inactive', s.name);
    assert.equal(ask.body.message, `${s.name.split(' ')[0]}'s membership isn't active. Check in anyway?`);
    assert.equal(visitsOf(t, s).length, 0, s.name);
  }
  assert.equal(t.fx.audit('checkin.manual_checkin').length, 0);
  assert.equal(t.fx.notifications(daniel.parent).length, 0);
  // the last valid day is still active (D-16)
  assert.equal((await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: lu.id })).status, 200);
  const yes = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: daniel.id, reason: 'Phone is dead', override: true });
  assert.equal(yes.status, 200);
  const [v] = visitsOf(t, daniel);
  assert.deepEqual([v.checkin_method, v.checked_in_by, v.session_id], ['staff', t.staff.id, t.sess.id]);
  assert.equal(t.fx.audit('checkin.manual_checkin').length, 2);
});

test(['CI-7', 'NF-1'], "staff search finds only their own location's students, with whether each is here or has a session now", async () => {
  const t = await setup();
  const mason = kid(t, t.loc, 'Mason Lee');
  kid(t, t.fx.location(), 'Mara Elsewhere');
  await t.scan();
  const r = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/students?q=ma`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.students.map(s => [s.name, s.here, s.session_now && s.session_now.name]),
    [['Mason Lee', false, null], ['Maya Johnson', true, null]]);
  assert.equal(r.body.students[1].since, at(LA, '2026-10-14', '13:05'));
  assert.equal(r.body.students[0].id, mason.id);
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]);
  const s = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/students?q=IVY`);
  assert.deepEqual(s.body.students.map(x => [x.id, x.session_now && x.session_now.id]), [[ivy.id, t.sess.id]]);
  const pct = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/students?q=%25`);
  assert.deepEqual(pct.body.students, []);
});

// ---------------------------------------------------------------- NF-1 scope

test(['NF-1', 'CI-7', 'CI-1'], 'every staff route refuses other locations, families and students; HQ and directors reach their scope', async () => {
  const t = await setup();
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const outsiders = [t.fx.staff(arcadia), t.fx.director(arcadia), t.fam.parent, t.fam.student];
  const leo = kid(t, t.loc, 'Leo Garcia');
  const ivy = kid(t, t.loc, 'Ivy Chen');
  await t.scan();
  const [open] = visitsOf(t, t.fam.student);
  const flagged = t.fx.visit(leo, t.loc, { local_date: '2026-10-13', check_in_at: at(LA, '2026-10-13', '13:00'),
    check_out_at: at(LA, '2026-10-13', '16:00'), checkout_method: 'auto', flagged: 1 });
  const routes = [
    ['get', `/api/checkin/locations/${t.loc.id}/qr`],
    ['get', `/api/checkin/locations/${t.loc.id}/building`],
    ['get', `/api/checkin/locations/${t.loc.id}/students?q=`],
    ['post', '/api/checkin/manual-checkin', { studentId: ivy.id, override: true }],
    ['post', `/api/checkin/visits/${open.id}/checkout`, {}],
    ['post', `/api/checkin/visits/${flagged.id}/review`, {}],
  ];
  for (const u of outsiders) {
    for (const [method, url, body] of routes) {
      const r = await t.as(u)[method](url, body);
      assert.equal(r.status, 403, `${u.role} ${method} ${url}`);
    }
  }
  for (const [method, url, body] of routes) assert.equal((await t.anon[method](url, body)).status, 401, url);
  assert.equal(visitsOf(t, ivy).length, 0);
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  assert.equal(t.db.prepare('SELECT reviewed_by FROM visits WHERE id = ?').get(flagged.id).reviewed_by, null);
  assert.equal(t.fx.audit().length, 0);
  // HQ reaches any location; a director their own
  const hq = t.fx.hq();
  for (const u of [hq, t.fx.director(t.loc)]) {
    assert.equal((await t.as(u).get(`/api/checkin/locations/${t.loc.id}/qr`)).status, 200, u.role);
    assert.equal((await t.as(u).get(`/api/checkin/locations/${t.loc.id}/building`)).body.here.length, 1, u.role);
  }
  assert.equal((await t.as(hq).get(`/api/checkin/locations/${arcadia.id}/building`)).status, 200);
  assert.equal((await t.as(hq).get('/api/checkin/locations/99999/qr')).status, 404);
});

test(['NF-1', 'CI-7'], "In the building never mixes in another location's visits; HQ sees each location's own", async () => {
  const t = await setup();
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const arcSess = t.fx.session(arcadia, { name: 'Arcadia Study', weekdays: '3', start: '13:00', end: '16:00' });
  const arcScan = s => t.as(s).post('/api/checkin/scan', { locationId: arcadia.id, code: t.code(arcadia) });
  // Irvine: Maya stays, Leo comes and goes, Ivy has a flagged visit from yesterday
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  const ivy = kid(t, t.loc, 'Ivy Chen');
  // Arcadia: Ari stays, Ben comes and goes, Cal has a flagged visit from yesterday and is due today
  const ari = kid(t, arcadia, 'Ari Arcadia', arcSess, [3]);
  const ben = kid(t, arcadia, 'Ben Arcadia', arcSess, [3]);
  const cal = kid(t, arcadia, 'Cal Arcadia', arcSess, [3]);
  for (const r of [await t.scan(), await t.scan(leo), await arcScan(ari), await arcScan(ben)]) {
    assert.equal(r.status, 200);
    assert.equal(r.body.action, 'checkin');
  }
  setClock(t, '13:20');
  for (const r of [await t.scan(leo), await arcScan(ben)]) {
    assert.equal(r.status, 200);
    assert.equal(r.body.action, 'checkout');
  }
  const flag = (s, loc) => t.fx.visit(s, loc, { local_date: '2026-10-13', check_in_at: at(LA, '2026-10-13', '13:00'),
    check_out_at: at(LA, '2026-10-13', '16:00'), checkout_method: 'auto', flagged: 1 });
  const ivyFlag = flag(ivy, t.loc);
  const calFlag = flag(cal, arcadia);
  const ids = b => [...b.here, ...b.left, ...b.expected, ...b.needs_review].map(v => v.student_id);
  const view = async (u, loc) => {
    const r = await t.as(u).get(`/api/checkin/locations/${loc.id}/building`);
    assert.equal(r.status, 200, `${u.role} at ${loc.name}`);
    return r.body;
  };

  // Irvine staff (and HQ looking at Irvine) see Irvine only
  const hq = t.fx.hq();
  for (const u of [t.staff, hq]) {
    const b = await view(u, t.loc);
    assert.deepEqual(b.here.map(v => [v.student_id, v.name]), [[t.fam.student.id, 'Maya Johnson']], u.role);
    assert.deepEqual(b.left.map(v => [v.student_id, v.name, v.check_out_at]), [[leo.id, 'Leo Garcia', at(LA, '2026-10-14', '13:20')]], u.role);
    assert.deepEqual(b.needs_review.map(v => [v.visit_id, v.student_id]), [[ivyFlag.id, ivy.id]], u.role);
    assert.deepEqual(b.expected, [], u.role);
    for (const s of [ari, ben, cal]) assert.ok(!ids(b).includes(s.id), `${u.role} at Irvine sees ${s.name}`);
  }

  // HQ looking at Arcadia sees Arcadia only, the same list Arcadia's own staff see
  const a = await view(hq, arcadia);
  assert.equal(a.location.name, 'Arcadia');
  assert.deepEqual(a.here.map(v => [v.student_id, v.name, v.session_name]), [[ari.id, 'Ari Arcadia', 'Arcadia Study']]);
  assert.deepEqual(a.left.map(v => [v.student_id, v.name, v.check_out_at]), [[ben.id, 'Ben Arcadia', at(LA, '2026-10-14', '13:20')]]);
  assert.deepEqual(a.needs_review.map(v => [v.visit_id, v.student_id]), [[calFlag.id, cal.id]]);
  assert.deepEqual(a.expected.map(e => [e.student_id, e.session_name]), [[cal.id, 'Arcadia Study']]);
  for (const s of [t.fam.student, leo, ivy]) assert.ok(!ids(a).includes(s.id), `HQ at Arcadia sees ${s.name}`);
  assert.deepEqual(await view(t.fx.staff(arcadia), arcadia), a);
});

test(['NF-1'], "families see only their own students' status today", async () => {
  const t = await setup();
  const other = t.fx.family(t.loc, { students: 2 });
  for (const s of other.students) t.fx.enroll(s, t.sess, 5);
  const pendingKid = t.fx.user('student', { location: t.loc });
  t.fx.link(t.fam.parent, pendingKid, 'pending');
  await t.scan();
  const mine = await t.as(t.fam.parent).get('/api/checkin/status');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.students.map(s => [s.id, s.state]), [[t.fam.student.id, 'here']]);
  assert.equal(mine.body.students[0].visit.check_in_at, at(LA, '2026-10-14', '13:05'));
  assert.equal(mine.body.students[0].visit.ends_at, at(LA, '2026-10-14', '16:00'));
  assert.equal(mine.body.students[0].location.name, 'Irvine');
  const theirs = await t.as(other.parent).get('/api/checkin/status');
  assert.deepEqual(theirs.body.students.map(s => [s.id, s.state]).sort(), other.students.map(s => [s.id, 'none']).sort());
  assert.deepEqual(theirs.body.students.map(s => s.next.start_at), [at(LA, '2026-10-16', '13:00'), at(LA, '2026-10-16', '13:00')]);
  assert.equal(theirs.body.students[0].next.when, 'Fri, Oct 16 at 1:00 PM');
  const self = await t.as(other.students[0]).get('/api/checkin/status');
  assert.deepEqual(self.body.students.map(s => s.id), [other.students[0].id]);
  for (const u of [t.staff, t.fx.hq()]) assert.equal((await t.as(u).get('/api/checkin/status')).status, 403, u.role);
  assert.equal((await t.anon.get('/api/checkin/status')).status, 401);
});

test(['NF-1', 'CI-2'], 'the scan simulator exists only in dev mode and only for students at their own location', async () => {
  const prod = await setup();
  assert.equal((await prod.as(prod.fam.student).get('/api/checkin/dev/simulate')).status, 404);
  const t = await setup({ dev: true });
  const r = await t.as(t.fam.student).get('/api/checkin/dev/simulate');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { locationId: t.loc.id, code: t.code() });
  for (const u of [t.fam.parent, t.staff]) assert.equal((await t.as(u).get('/api/checkin/dev/simulate')).status, 403, u.role);
  const scan = await t.as(t.fam.student).post('/api/checkin/scan', r.body);
  assert.equal(scan.status, 200);
  assert.equal(scan.body.action, 'checkin');
});

// ---------------------------------------------------------------- NF-5 privacy, NF-6 speed

test(['NF-5', 'CI-2'], 'coordinates sent with a scan are never stored, logged or sent back (D-49)', async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  const lat = 33.68471234567, lng = -117.82659876543;
  const farLat = 33.68916789123, farLng = -117.82304321987;
  const printed = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => printed.push(a.map(String).join(' ')); }
  let a, b, c;
  try {
    a = await t.scan(undefined, { lat, lng });
    setClock(t, '15:00');
    b = await t.scan(undefined, { lat, lng });
    c = await t.scan(leo, { lat: farLat, lng: farLng });
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual([a.body.action, b.body.action, c.body.action], ['checkin', 'checkout', 'checkin']);
  assert.equal(t.fx.notifications(t.fam.parent).length, 2, 'the scans did write visits and notifications');
  const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  const dump = tables.map(n => JSON.stringify(t.db.prepare(`SELECT * FROM "${n}"`).all())).join('\n');
  const out = printed.join('\n');
  const replies = JSON.stringify([a.body, b.body, c.body]);
  for (const n of [lat, lng, farLat, farLng]) {
    for (const s of [String(n), n.toFixed(6), n.toFixed(5)]) {
      assert.ok(!dump.includes(s), `database holds ${s}`);
      assert.ok(!out.includes(s), `console printed ${s}`);
      assert.ok(!replies.includes(s), `a reply echoed ${s}`);
    }
  }
  const cols = t.db.prepare('PRAGMA table_info(visits)').all().map(x => x.name);
  assert.ok(!cols.some(x => /lat|lng|lon|coord|geo/i.test(x)), 'visits has no coordinate column');
});

test(['NF-6'], 'a check-in scan completes in under 2 seconds at a busy location', async () => {
  const t = await setup();
  const ins = t.db.prepare("INSERT INTO users (role, name, email, location_id, created_at) VALUES ('student', ?, ?, ?, ?)");
  const vis = t.db.prepare(`INSERT INTO visits (student_id, location_id, session_id, weekday, local_date, check_in_at, check_out_at, checkin_method, checkout_method)
    VALUES (?,?,?,?,?,?,?,'scan','scan')`);
  const enr = t.db.prepare("INSERT INTO enrollments (student_id, session_id, weekday, status, source, created_at) VALUES (?,?,3,'active','parent',?)");
  t.db.exec('BEGIN');
  for (let i = 0; i < 300; i++) {
    const id = Number(ins.run('Student ' + i, `bulk${i}@test.local`, t.loc.id, t.clock.now()).lastInsertRowid);
    enr.run(id, t.sess.id, t.clock.now());
    for (let d = 1; d <= 20; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      vis.run(id, t.loc.id, t.sess.id, 3, date, at(LA, date, '13:00'), at(LA, date, '16:00'));
    }
  }
  t.db.exec('COMMIT');
  const t0 = performance.now();
  const r = await t.scan();
  const inMs = performance.now() - t0;
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'checkin');
  assert.ok(inMs < 2000, `check-in took ${Math.round(inMs)} ms`);
  setClock(t, '15:30');
  const t1 = performance.now();
  const o = await t.scan();
  const outMs = performance.now() - t1;
  assert.equal(o.body.action, 'checkout');
  assert.ok(outMs < 2000, `check-out took ${Math.round(outMs)} ms`);
});

// ---------------------------------------------------------------- NF-4 the location's date, not UTC's

test(['NF-4', 'CI-3', 'CI-4', 'CI-7'], "an evening in Los Angeles is still that day there even though it is already tomorrow in UTC", async () => {
  // Wed Oct 14 at 18:00 in Los Angeles is 01:00 UTC on Thursday Oct 15.
  const t = await makeApp({ now: at(LA, '2026-10-14', '18:00') });
  const loc = t.fx.location({ name: 'Irvine', timezone: LA });
  // Wednesday is the membership's last valid day (D-16).
  const fam = t.fx.family(loc, { expires: '2026-10-14' });
  const eve = t.fx.session(loc, { name: 'Evening Study', weekdays: '3', start: '17:30', end: '19:30' });
  t.fx.enroll(fam.student, eve, 3);
  const staff = t.fx.staff(loc);
  const scan = () => t.as(fam.student).post('/api/checkin/scan',
    { locationId: loc.id, code: mod().currentCode(t.ctx, loc, t.clock.now()) });

  const r = await scan();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, 'checkin');
  assert.equal(r.body.visit.local_date, '2026-10-14');
  assert.equal(r.body.visit.weekday, 3);
  assert.equal(r.body.session.end_at, at(LA, '2026-10-14', '19:30'));

  const b = await t.as(staff).get(`/api/checkin/locations/${loc.id}/building`);
  assert.equal(b.body.today, '2026-10-14');
  assert.deepEqual(b.body.here.map(v => v.student_id), [fam.student.id]);
  const s = await t.as(fam.parent).get('/api/checkin/status');
  assert.equal(s.body.students[0].state, 'here');
  const again = await t.as(staff).post('/api/checkin/manual-checkin', { studentId: fam.student.id });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_here');

  // Scanning again at 19:00 (02:00 UTC Thursday) checks the same visit out.
  t.clock.set(at(LA, '2026-10-14', '19:00'));
  const out = await scan();
  assert.equal(out.status, 200);
  assert.equal(out.body.action, 'checkout');
  const vs = visitsOf(t, fam.student);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].check_out_at, at(LA, '2026-10-14', '19:00'));
});

test(['NF-4', 'CI-7'], "a corrected time out is read in the visit's own location zone (Toronto)", async () => {
  const t = await makeApp({ now: at(TO, '2026-10-14', '10:00') });
  const to = t.fx.location({ name: 'Toronto', timezone: TO, lat: 43.6532, lng: -79.3832 });
  const fam = t.fx.family(to);
  const s = t.fx.session(to, { name: 'Afternoon Study', weekdays: '2', start: '13:00', end: '16:00' });
  const staff = t.fx.staff(to);
  const v = t.fx.visit(fam.student, to, { session: s, weekday: 2, local_date: '2026-10-13', check_in_at: at(TO, '2026-10-13', '13:00'),
    check_out_at: at(TO, '2026-10-13', '16:00'), checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' });
  const r = await t.as(staff).post(`/api/checkin/visits/${v.id}/review`, { out_time: '15:10' });
  assert.equal(r.status, 200);
  assert.equal(r.body.visit.check_out_at, at(TO, '2026-10-13', '15:10'));
  assert.equal(visitsOf(t, fam.student)[0].check_out_at, at(TO, '2026-10-13', '15:10'));
});

// ---------------------------------------------------------------- malformed requests: a clear answer, never a server error

// String() of this object throws, so code that coerces body values with String() or Number() would crash.
const ODD = () => ({ toString: 1 });

test(['CI-7', 'NF-2'], 'a reason that is not text is left out; the manual check-in and check-out still go through', async () => {
  const t = await setup();
  const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: t.fam.student.id, reason: ODD() });
  assert.equal(r.status, 200);
  const [v] = visitsOf(t, t.fam.student);
  assert.deepEqual([v.checkin_method, v.checked_in_by], ['staff', t.staff.id]);
  assert.equal(JSON.parse(t.fx.audit('checkin.manual_checkin')[0].detail).reason, null);
  setClock(t, '14:00');
  const out = await t.as(t.staff).post(`/api/checkin/visits/${v.id}/checkout`, { reason: ODD() });
  assert.equal(out.status, 200);
  assert.deepEqual([visitsOf(t, t.fam.student)[0].check_out_at, visitsOf(t, t.fam.student)[0].checkout_method], [at(LA, '2026-10-14', '14:00'), 'staff']);
  assert.equal(JSON.parse(t.fx.audit('checkin.manual_checkout')[0].detail).reason, null);
  // a list is not text either
  const leo = kid(t, t.loc, 'Leo Garcia');
  const list = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id, override: true, reason: ['Phone is dead'] });
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(t.fx.audit('checkin.manual_checkin')[1].detail).reason, null);
});

test(['CI-7'], 'a time out sent as anything but text is refused with the usual message and changes nothing', async () => {
  const t = await setup();
  const v = t.fx.visit(t.fam.student, t.loc, { session: t.sess, weekday: 2, local_date: '2026-10-13', check_in_at: at(LA, '2026-10-13', '13:00'),
    check_out_at: at(LA, '2026-10-13', '16:00'), checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' });
  for (const out_time of [['15:10'], ODD(), 1510, true]) {
    const r = await t.as(t.staff).post(`/api/checkin/visits/${v.id}/review`, { out_time });
    assert.equal(r.status, 400, JSON.stringify(out_time));
    assert.equal(r.body.error, 'bad_time', JSON.stringify(out_time));
    assert.equal(r.body.message, 'Enter the time out as hours and minutes, like 15:45.');
  }
  const row = t.db.prepare('SELECT * FROM visits WHERE id = ?').get(v.id);
  assert.deepEqual([row.reviewed_by, row.check_out_at, row.checkout_method], [null, at(LA, '2026-10-13', '16:00'), 'auto']);
  assert.equal(t.fx.audit('checkin.review').length, 0);
  const ok = await t.as(t.staff).post(`/api/checkin/visits/${v.id}/review`, { out_time: '15:10' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.visit.check_out_at, at(LA, '2026-10-13', '15:10'));
});

test(['CI-2', 'CI-7'], 'a location or student sent as an object or a list is treated as unknown, not a server error', async () => {
  const t = await setup();
  for (const locationId of [ODD(), [t.loc.id]]) {
    const r = await t.scan(undefined, { locationId });
    assert.equal(r.status, 404, JSON.stringify(locationId));
    assert.equal(r.body.message, "We couldn't find that location. Scan the code at the entrance again.");
  }
  for (const studentId of [ODD(), [t.fam.student.id]]) {
    const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId, override: true });
    assert.equal(r.status, 404, JSON.stringify(studentId));
    assert.equal(r.body.message, 'No such student.');
  }
  assert.equal(visitsOf(t, t.fam.student).length, 0);
  assert.equal(t.fx.audit().length, 0);
  assert.equal(t.fx.notifications(t.fam.parent).length, 0);
  // the same requests with plain ids work (the app sends numbers; a link from the QR may carry text)
  assert.equal((await t.scan(undefined, { locationId: String(t.loc.id) })).body.action, 'checkin');
});

// ---------------------------------------------------------------- sweep 2026-10-14: R2, R5, R6, D-15a, D-16a

test(['CI-5', 'CI-4', 'CI-7'], 'back-to-back sessions are one visit: no auto-checkout between them, and a scan during the stay checks out (R2)', async () => {
  const t = await setup(); // Afternoon Study, Wed 13:00-16:00
  const late = t.fx.session(t.loc, { name: 'Late Study', weekdays: '3', start: '16:00', end: '19:00' });
  t.fx.enroll(t.fam.student, late, 3);
  const building = async () => (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  setClock(t, '12:55');
  const r = await t.scan();
  assert.equal(r.body.action, 'checkin');
  assert.equal(r.body.session.id, t.sess.id);
  setClock(t, '16:05');
  t.jobs();
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null, 'Late Study follows, so the visit stays open');
  assert.equal(t.fx.notifications(t.fam.parent, 'checkout_auto').length, 0);
  assert.deepEqual((await building()).here.map(v => v.student_id), [t.fam.student.id]);
  setClock(t, '18:55');
  const out = await t.scan();
  assert.equal(out.status, 200);
  assert.equal(out.body.action, 'checkout');
  assert.equal(out.body.total_minutes, 360);
  const vs = visitsOf(t, t.fam.student);
  assert.equal(vs.length, 1, 'one visit, not a second check-in');
  assert.deepEqual([vs[0].check_out_at, vs[0].checkout_method, vs[0].flagged], [at(LA, '2026-10-14', '18:55'), 'scan', 0]);
  // the stay overlapped Late Study, so she is not still expected for it once she has left
  const b = await building();
  assert.deepEqual(b.expected.map(e => e.student_id), []);
  assert.deepEqual(b.left.map(v => v.student_id), [t.fam.student.id]);
  setClock(t, '19:05');
  t.jobs();
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, at(LA, '2026-10-14', '18:55'));
  assert.deepEqual(t.fx.notifications(t.fam.parent).map(n => n.kind), ['checkin', 'checkout']);
});

test(['CI-5', 'CI-6'], 'a stay is checked out automatically at the end of the last back-to-back session, capped by closing time (R2)', async () => {
  const t = await setup();
  // Wed: Afternoon 13:00-16:00; Late 16:30-18:00 (its window opens at 16:00, exactly when Afternoon ends);
  // Night 17:45-21:00 overlaps Late and runs past Irvine's 20:00 closing; Gap 16:31-18:00 opens a minute too late.
  const late = t.fx.session(t.loc, { name: 'Late Study', weekdays: '3,5', start: '16:30', end: '18:00' });
  const night = t.fx.session(t.loc, { name: 'Night Study', weekdays: '3', start: '17:45', end: '21:00' });
  const gap = t.fx.session(t.loc, { name: 'Gap Study', weekdays: '3', start: '16:31', end: '18:00' });
  t.fx.enroll(t.fam.student, late, 3);
  t.fx.enroll(t.fam.student, night, 3);
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]);
  t.fx.enroll(ivy, late, 3);
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  t.fx.enroll(leo, gap, 3);
  t.fx.enroll(leo, late, 5); // Late Study on Friday is not that day
  setClock(t, '15:45');
  for (const s of [t.fam.student, ivy, leo]) {
    const r = await t.scan(s);
    assert.equal(r.body.action, 'checkin', s.name);
    assert.equal(r.body.session.id, t.sess.id, s.name);
  }
  setClock(t, '16:05');
  t.jobs();
  const outAt = s => visitsOf(t, s)[0].check_out_at;
  assert.deepEqual([outAt(t.fam.student), outAt(ivy), outAt(leo)], [null, null, at(LA, '2026-10-14', '16:00')]);
  // Leo's Gap Study is a new visit
  setClock(t, '16:35');
  const back = await t.scan(leo);
  assert.equal(back.body.action, 'checkin');
  assert.equal(back.body.session.id, gap.id);
  setClock(t, '18:01');
  t.jobs();
  assert.equal(outAt(ivy), at(LA, '2026-10-14', '18:00'));
  assert.equal(outAt(t.fam.student), null);
  const [ivyAuto] = t.fx.notifications(ivy.parent, 'checkout_auto');
  assert.equal(ivyAuto.title, 'Ivy was checked out automatically · 6:00 PM');
  // it names the session the stay ended in, not the one it began in (F14)
  assert.equal(ivyAuto.body, "Ivy didn't scan out of Late Study at Irvine, so the app checked them out when the session ended. Total time 2h 15m. Staff will review it.");
  setClock(t, '19:59');
  t.jobs();
  assert.equal(outAt(t.fam.student), null);
  setClock(t, '20:01');
  t.jobs();
  const [v] = visitsOf(t, t.fam.student);
  assert.deepEqual([v.check_out_at, v.checkout_method, v.flagged, v.flag_reason], [at(LA, '2026-10-14', '20:00'), 'auto', 1, 'Did not scan out']);
  const auto = t.fx.notifications(t.fam.parent, 'checkout_auto');
  assert.equal(auto.length, 1);
  assert.equal(auto[0].body, "Maya didn't scan out of Night Study at Irvine, so the app checked them out when Irvine closed. Total time 4h 15m. Staff will review it.");
});

test(['CI-7'], 'a staff check-in with no session counts toward the session it overlaps: after leaving, the student is not still expected (D-15a)', async () => {
  const t = await setup();
  setClock(t, '12:00');
  const ask = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: t.fam.student.id, reason: 'Phone is dead' });
  assert.equal(ask.body.error, 'no_session');
  const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: t.fam.student.id, reason: 'Phone is dead', override: true });
  assert.equal(r.status, 200);
  assert.equal(visitsOf(t, t.fam.student)[0].session_id, null);
  // Ivy came in the morning and left before Afternoon Study started: she is still expected
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]);
  t.fx.visit(ivy, t.loc, { check_in_at: at(LA, '2026-10-14', '10:00'), check_out_at: at(LA, '2026-10-14', '12:30'),
    checkin_method: 'staff', checkout_method: 'staff', checked_in_by: t.staff.id, checked_out_by: t.staff.id });
  setClock(t, '14:00');
  const [v] = visitsOf(t, t.fam.student);
  assert.equal((await t.as(t.staff).post(`/api/checkin/visits/${v.id}/checkout`, {})).status, 200);
  const b = (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  assert.deepEqual(b.here, []);
  assert.deepEqual(b.left.map(x => x.student_id), [t.fam.student.id, ivy.id]);
  assert.deepEqual(b.expected.map(e => [e.student_id, e.session_name]), [[ivy.id, 'Afternoon Study']]);
});

test(['CI-3'], "the Home card says sessions are paused by the membership only when the membership isn't valid (D-16a)", async () => {
  const t = await setup();
  // Summer slots paused when the membership lapsed stay paused after renewal (D-16a); the membership is valid now
  const summer = t.fx.term(t.loc, { name: 'Summer 2026', start: '2026-06-01', end: '2026-08-14' });
  const summerSess = t.fx.session(t.loc, { term: summer, name: 'Summer Study', weekdays: '3', start: '13:00', end: '16:00' });
  const sam = kid(t, t.loc, 'Sam Summer');
  t.fx.enroll(sam, summerSess, 3, { status: 'paused' });
  // a slot kept paused because it is over the weekly cap, membership valid
  const cy = kid(t, t.loc, 'Cy Capped', t.sess, [1], { cap: 1 });
  t.fx.enroll(cy, t.sess, 3, { status: 'paused' });
  // a lapsed membership with paused slots, and one with nothing paused
  const dan = kid(t, t.loc, 'Dan Lapsed', t.sess, [], { expires: '2026-10-13' });
  t.fx.enroll(dan, t.sess, 3, { status: 'paused' });
  const ina = kid(t, t.loc, 'Ina Active', t.sess, [], { status: 'inactive' });
  const paused = async s => (await t.as(s).get('/api/checkin/status')).body.students[0].paused;
  assert.equal(await paused(sam), false);
  assert.equal(await paused(cy), false);
  assert.equal(await paused(dan), true);
  assert.equal(await paused(ina), false);
  const parent = (await t.as(sam.parent).get('/api/checkin/status')).body.students[0];
  assert.deepEqual([parent.id, parent.paused, parent.next], [sam.id, false, null]);
});

test(['CI-3', 'CI-7'], "a membership that hasn't started yet can't check in until its start date (R6)", async () => {
  const t = await setup();
  const ben = kid(t, t.loc, 'Ben Okafor', t.sess, [1, 3], { start: '2026-11-02' });
  const r = await t.scan(ben);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'membership_inactive');
  assert.equal(r.body.message, "Your membership starts Mon, Nov 2, so you can't check in yet. Ask a parent or the front desk at Irvine if that's wrong.");
  assert.equal(visitsOf(t, ben).length, 0);
  assert.equal(t.fx.notifications(ben.parent).length, 0);
  const found = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/students?q=ben`);
  assert.deepEqual(found.body.students.map(s => [s.id, s.membership_active]), [[ben.id, false]]);
  const b = (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  assert.deepEqual(b.expected.filter(e => e.student_id === ben.id).map(e => e.membership_active), [false]);
  const ask = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: ben.id });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error, 'membership_inactive');
  assert.equal(ask.body.message, "Ben's membership starts Mon, Nov 2. Check in anyway?");
  assert.equal(visitsOf(t, ben).length, 0);
  // the evening before, in Irvine, is still before the start date (it is already Nov 2 in UTC)
  setClock(t, '17:30', '2026-11-01');
  const eve = await t.scan(ben);
  assert.equal(eve.body.error, 'membership_inactive');
  assert.match(eve.body.message, /^Your membership starts Mon, Nov 2,/);
  // on the start date it works
  setClock(t, '13:05', '2026-11-02');
  const ok = await t.scan(ben);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.action, 'checkin');
});

test(['CI-2', 'CI-7'], 'a location marked closed refuses scans and manual check-ins with a clear message; staff can still check a student out (R5)', async () => {
  const t = await setup();
  assert.equal((await t.scan()).body.action, 'checkin');
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  t.db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(t.loc.id);
  setClock(t, '13:30');
  for (const s of [leo, t.fam.student]) {
    const r = await t.scan(s);
    assert.equal(r.status, 403, s.name);
    assert.equal(r.body.error, 'location_closed', s.name);
    assert.equal(r.body.message, "Irvine is marked closed, so scanning in and out is turned off. If you're here, ask staff at the front desk.");
  }
  assert.equal(visitsOf(t, leo).length, 0);
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  for (const body of [{ studentId: leo.id }, { studentId: leo.id, override: true, reason: 'Phone is dead' }]) {
    const m = await t.as(t.staff).post('/api/checkin/manual-checkin', body);
    assert.equal(m.status, 403);
    assert.equal(m.body.error, 'location_closed');
    assert.equal(m.body.message, 'Irvine is marked closed, so check-ins are turned off. HQ can reopen it in Locations.');
  }
  assert.equal(visitsOf(t, leo).length, 0);
  assert.equal(t.fx.audit('checkin.manual_checkin').length, 0);
  assert.equal(t.fx.notifications(leo.parent).length, 0);
  const [v] = visitsOf(t, t.fam.student);
  assert.equal((await t.as(t.staff).post(`/api/checkin/visits/${v.id}/checkout`, { reason: 'Leaving early' })).status, 200);
  t.db.prepare('UPDATE locations SET active = 1 WHERE id = ?').run(t.loc.id);
  assert.equal((await t.scan(leo)).body.action, 'checkin');
});

// ---------------------------------------------------------------- sweep 2026-10-14, round 2: the Home card

test(['CI-3', 'CI-5'], 'the Home card follows a back-to-back stay into the session the student is in now, and after it offers no session the stay covered (R2)', async () => {
  const t = await setup(); // Afternoon Study, Mon/Wed/Fri 13:00-16:00
  const late = t.fx.session(t.loc, { name: 'Late Study', weekdays: '3', start: '16:00', end: '19:00' });
  t.fx.enroll(t.fam.student, late, 3);
  const st = async who => (await t.as(who).get('/api/checkin/status')).body.students[0];
  setClock(t, '12:55');
  assert.equal((await t.scan()).body.action, 'checkin');
  // before Late Study starts the stay is still in Afternoon Study, even inside Late Study's check-in window
  setClock(t, '15:45');
  let s = await st(t.fam.student);
  assert.deepEqual([s.state, s.visit.session_name, s.visit.ends_at], ['here', 'Afternoon Study', at(LA, '2026-10-14', '16:00')]);
  setClock(t, '16:30');
  t.jobs();
  for (const who of [t.fam.student, t.fam.parent]) {
    s = await st(who);
    assert.deepEqual([s.state, s.visit.session_name, s.visit.ends_at], ['here', 'Late Study', at(LA, '2026-10-14', '19:00')]);
  }
  setClock(t, '18:30');
  assert.equal((await t.scan()).body.action, 'checkout');
  s = await st(t.fam.student);
  assert.equal(s.state, 'left');
  // Late Study is still running, but the stay covered it: the next one is next Wednesday's Afternoon Study
  assert.deepEqual([s.next.session_name, s.next.date], ['Afternoon Study', '2026-10-21']);
});

test(['CI-7', 'CI-5'], 'In the building follows a back-to-back stay into the session the student is in now (R2)', async () => {
  const t = await setup(); // Afternoon Study, Mon/Wed/Fri 13:00-16:00
  const late = t.fx.session(t.loc, { name: 'Late Study', weekdays: '3', start: '16:00', end: '19:00' });
  t.fx.enroll(t.fam.student, late, 3);
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]); // Afternoon Study only
  const here = async () => (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body.here
    .map(v => [v.student_id, v.session_name, v.ends_at]);
  setClock(t, '12:55');
  assert.equal((await t.scan()).body.action, 'checkin');
  assert.equal((await t.scan(ivy)).body.action, 'checkin');
  // inside Late Study's check-in window but before it starts, the stay is still in Afternoon Study
  setClock(t, '15:45');
  assert.deepEqual(await here(), [[t.fam.student.id, 'Afternoon Study', at(LA, '2026-10-14', '16:00')], [ivy.id, 'Afternoon Study', at(LA, '2026-10-14', '16:00')]]);
  setClock(t, '16:30');
  t.jobs();
  assert.deepEqual(await here(), [[t.fam.student.id, 'Late Study', at(LA, '2026-10-14', '19:00')]]);
  // the visit stays linked to the session it began in
  assert.equal(visitsOf(t, t.fam.student)[0].session_id, t.sess.id);
});

test(['CI-3', 'CI-7'], 'after a staff check-in with no session, the Home card does not offer the session the visit overlapped as next (D-15a)', async () => {
  const t = await setup();
  setClock(t, '12:00');
  const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: t.fam.student.id, reason: 'Phone is dead', override: true });
  assert.equal(r.status, 200);
  // Ivy came in the morning and left before Afternoon Study started: it is still her next session
  const ivy = kid(t, t.loc, 'Ivy Chen', t.sess, [3]);
  t.fx.visit(ivy, t.loc, { check_in_at: at(LA, '2026-10-14', '10:00'), check_out_at: at(LA, '2026-10-14', '12:30'),
    checkin_method: 'staff', checkout_method: 'staff', checked_in_by: t.staff.id, checked_out_by: t.staff.id });
  setClock(t, '14:00');
  const [v] = visitsOf(t, t.fam.student);
  assert.equal((await t.as(t.staff).post(`/api/checkin/visits/${v.id}/checkout`, {})).status, 200);
  const maya = (await t.as(t.fam.parent).get('/api/checkin/status')).body.students[0];
  assert.deepEqual([maya.state, maya.next.session_name, maya.next.date], ['left', 'Afternoon Study', '2026-10-21']);
  const iv = (await t.as(ivy).get('/api/checkin/status')).body.students[0];
  assert.deepEqual([iv.state, iv.next.session_name, iv.next.date], ['left', 'Afternoon Study', '2026-10-14']);
});

test(['CI-3', 'NF-1'], "the Home card says when a membership that hasn't started begins, and only for that student (R6)", async () => {
  const t = await setup();
  const ben = kid(t, t.loc, 'Ben Okafor', t.sess, [3], { start: '2026-11-02' });
  const dan = kid(t, t.loc, 'Dan Lapsed', t.sess, [], { expires: '2026-10-13' });
  const startsOn = async who => (await t.as(who).get('/api/checkin/status')).body.students.map(s => [s.id, s.starts_on]);
  assert.deepEqual(await startsOn(ben), [[ben.id, '2026-11-02']]);
  assert.deepEqual(await startsOn(ben.parent), [[ben.id, '2026-11-02']]);
  assert.deepEqual(await startsOn(t.fam.parent), [[t.fam.student.id, null]]);
  assert.deepEqual(await startsOn(dan), [[dan.id, null]]);
  // the evening before, in Irvine, it hasn't started yet (it is already Nov 2 in UTC); on the day it has
  setClock(t, '17:30', '2026-11-01');
  assert.deepEqual(await startsOn(ben), [[ben.id, '2026-11-02']]);
  setClock(t, '09:00', '2026-11-02');
  assert.deepEqual(await startsOn(ben), [[ben.id, null]]);
});

// ---------------------------------------------------------------- sweep fixes (Oct 14 sweep: L31, L32, L37, L63, L65)

test(['CI-3'], 'a scan on a closure day says the center is closed, names the reason and the next session, and offers no staff check-in (L31)', async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3, 5]);
  const nia = kid(t, t.loc, 'Nia None');
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-14', null);
  const leoR = await t.scan(leo);
  assert.equal(leoR.status, 403);
  assert.equal(leoR.body.error, 'no_session');
  assert.equal(leoR.body.message, 'Irvine is closed today, so there are no sessions. Your next one is Fri, Oct 16 at 1:00 PM.');
  const niaR = await t.scan(nia);
  assert.deepEqual([niaR.status, niaR.body.error, niaR.body.message], [403, 'no_session', 'Irvine is closed today, so there are no sessions.']);
  assert.equal(visitsOf(t, leo).length + visitsOf(t, nia).length, 0);
  assert.equal(t.fx.notifications(leo.parent).length, 0);
  // a closure on a later day doesn't make today's scan say closed
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-21', 'Staff training');
  setClock(t, '13:05', '2026-10-15');
  const thu = await t.scan(leo);
  assert.equal(thu.body.message, "You don't have a session right now. Your next one is tomorrow at 1:00 PM. Staff can check you in if needed.");
});

test(['CI-3', 'SC-3'], "the status says when today is a closure day, with its reason, so the Check in screen can say so (L31)", async () => {
  const t = await setup();
  const closed = async who => (await t.as(who).get('/api/checkin/status')).body.students.map(s => s.closed_today);
  assert.deepEqual(await closed(t.fam.student), [null]);
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-14', 'Power outage');
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-16', null);
  assert.deepEqual(await closed(t.fam.student), [{ reason: 'Power outage' }]);
  assert.deepEqual(await closed(t.fam.parent), [{ reason: 'Power outage' }]);
  // a closure on a later day doesn't make today closed; a closure with no reason is still closed
  setClock(t, '13:05', '2026-10-15');
  assert.deepEqual(await closed(t.fam.student), [null]);
  setClock(t, '13:05', '2026-10-16');
  assert.deepEqual(await closed(t.fam.student), [{ reason: null }]);
});

test(['CI-4', 'CI-5'], 'a scan after the auto-checkout says the student is already checked out, not that there is no session; a later session still checks in (L32)', async () => {
  const t = await setup();
  const evening = t.fx.session(t.loc, { name: 'Evening Study', weekdays: '3', start: '17:00', end: '19:00' });
  t.fx.enroll(t.fam.student, evening, 3);
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  assert.equal((await t.scan()).body.action, 'checkin');
  assert.equal((await t.scan(leo)).body.action, 'checkin');
  setClock(t, '14:00');
  const [lv] = visitsOf(t, leo);
  assert.equal((await t.as(t.staff).post(`/api/checkin/visits/${lv.id}/checkout`, {})).status, 200);
  setClock(t, '16:01');
  t.jobs();
  const r = await t.scan();
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'checked_out_auto');
  assert.equal(r.body.message, "You were already checked out automatically at 4:00 PM, so there's nothing to scan out of. If you need to check back in, ask staff at the front desk.");
  assert.equal(visitsOf(t, t.fam.student).length, 1);
  assert.deepEqual(t.fx.notifications(t.fam.parent).map(n => n.kind).sort(), ['checkin', 'checkout_auto']);
  // a check-out by staff is not an automatic one: Leo hears the usual no-session answer
  const leoR = await t.scan(leo);
  assert.equal(leoR.body.error, 'no_session');
  // once the next session's check-in window opens, a scan checks in as usual
  setClock(t, '16:35');
  const back = await t.scan();
  assert.equal(back.status, 200);
  assert.equal(back.body.action, 'checkin');
  assert.equal(back.body.session.name, 'Evening Study');
});

test(['CI-7'], "'Left today' lists a student who left twice once, at their latest check-out (L37)", async () => {
  const t = await setup();
  const dir = t.fx.director(t.loc, { name: 'Dana Park' });
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  setClock(t, '12:49');
  assert.equal((await t.as(dir).post('/api/checkin/manual-checkin', { studentId: leo.id })).status, 200);
  setClock(t, '13:20');
  const [first] = visitsOf(t, leo);
  assert.equal((await t.as(dir).post(`/api/checkin/visits/${first.id}/checkout`, { reason: 'Leaving early' })).status, 200);
  setClock(t, '13:30');
  assert.equal((await t.as(dir).post('/api/checkin/manual-checkin', { studentId: leo.id })).status, 200);
  setClock(t, '16:05');
  t.jobs();
  const b = (await t.as(dir).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  assert.deepEqual(b.here, []);
  const second = visitsOf(t, leo)[1];
  assert.deepEqual(b.left.map(v => [v.student_id, v.visit_id, v.checkout_method, v.check_out_at]),
    [[leo.id, second.id, 'auto', at(LA, '2026-10-14', '16:00')]]);
});

test(['CI-7', 'CI-6'], 'staff can check in a student only after a parent approves the account; the search says who is waiting (L63)', async () => {
  const t = await setup();
  const pend = t.fx.family(t.loc, { linked: false });
  rename(t, pend.student, 'Pia Pending');
  const s = await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/students?q=`);
  assert.deepEqual(s.body.students.map(x => [x.name, x.approved]), [['Maya Johnson', true], ['Pia Pending', false]]);
  for (const override of [undefined, true]) {
    const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: pend.student.id, override, reason: 'walked in' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_approved');
    assert.equal(r.body.message, "Pia Pending's account isn't approved by a parent yet, so they can't be checked in. A parent approves it in Family.");
  }
  assert.equal(visitsOf(t, pend.student).length, 0);
  assert.equal(t.fx.audit('checkin.manual_checkin').length, 0);
  // once the parent approves, staff can check them in and the parent is told
  t.fx.link(pend.parent, pend.student, 'active');
  const ok = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: pend.student.id, override: true });
  assert.equal(ok.status, 200);
  assert.equal(t.fx.notifications(pend.parent, 'checkin').length, 1);
});

test(['CI-7', 'NF-1'], 'a retired (inactive) student is not found for a manual check-in, even by id (L65)', async () => {
  const t = await setup();
  const gone = kid(t, t.loc, 'Ray Retired', t.sess, [3]);
  t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone.id);
  for (const override of [undefined, true]) {
    const r = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: gone.id, override });
    assert.equal(r.status, 404);
    assert.equal(r.body.message, 'No such student.');
  }
  assert.equal(visitsOf(t, gone).length, 0);
  assert.equal(t.fx.notifications(gone.parent).length, 0);
  // staff at another location still get a plain refusal, as for any student there
  const other = t.fx.staff(t.fx.location({ name: 'Arcadia' }));
  assert.equal((await t.as(other).post('/api/checkin/manual-checkin', { studentId: gone.id, override: true })).status, 403);
});

// ---------------------------------------------------------------- the check-in screens in a browser tab

// Just enough DOM for public/js/app.js and this module's view, as in core.test.js and
// enrollment.test.js: one tree under <html>; focus, bubbling events and isConnected work as in a browser.
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  get value() { return this._value ?? this.getAttribute('value') ?? ''; }
  set value(v) { this._value = String(v); }
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
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
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
  // Only what the views ask for: '.class', or a tag name (the last part of '#main h1').
  querySelector(sel) {
    const last = sel.split(/\s+/).pop();
    return this.find(n => (last.startsWith('.') ? n.cls.includes(last.slice(1)) : n.tag === last)) || null;
  }
}

// One tab running the real shell and the check-in view (read from ROOT, so the
// mutation runner's copy is the one exercised) against the test server.
// `stub` answers some requests itself ({ 'GET /api/notes/goals/today': () => [200, body] }), for the
// notes module a scoped run doesn't load; `requests` lists every request the tab sent.
function shellTab(t, { stub = {}, navigator = {} } = {}) {
  const vm = require('vm'), fs = require('fs'), path = require('path'), crypto = require('crypto');
  const { ROOT } = require('./lib');
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
    querySelector: sel => doc.documentElement.querySelector(sel),
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
  const requests = [];
  const fetchAs = (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    requests.push({ method, url, body: opts.body ? JSON.parse(opts.body) : undefined });
    const fake = stub[method + ' ' + url];
    if (fake) {
      const [status, body] = fake();
      return track(Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
    }
    return track(fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
      .then(async r => new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers })));
  };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator, location, EventSource,
    history: { replaceState(_s, _t, url) { location._hash = String(url).replace(/^[^#]*/, ''); } },
    addEventListener(type, fn) { (winOn[type] = winOn[type] || []).push(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, ms).unref(), clearInterval };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/checkin.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    doc, settle, requests, main: () => doc.getElementById('main'), App: win.App,
    async open(user, hash) {
      const token = crypto.randomBytes(16).toString('hex');
      t.ctx.sessions.set(token, user.id);
      cookie = 'sid=' + token;
      location._hash = hash;
      win.App.start();
      await settle();
    },
  };
}
// Visible text, one space between words (Intl may put a narrow no-break space before AM/PM).
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const byTag = (root, tag) => root.findAll(n => n.tag === tag);

test(['CI-3'], 'Home says a session is on now only once it has started; in the 30 minutes before, it says when it starts and that check-in is open (L34)', async () => {
  const t = await setup();
  const line = async (user, hm) => {
    setClock(t, hm);
    const tab = shellTab(t);
    await tab.open(user, '#/home');
    return words(tab.main());
  };
  for (const [user, who] of [[t.fam.student, 'student'], [t.fam.parent, 'parent']]) {
    const early = await line(user, '12:48');
    assert.match(early, /Afternoon Study starts at 1:00 PM · check-in is open/, who);
    assert.doesNotMatch(early, /on now/, who);
    assert.match(await line(user, '13:00'), /Afternoon Study is on now, until 4:00 PM/, who);
    assert.match(await line(user, '12:10'), /Next session today at 1:00 PM · Afternoon Study/, who);
  }
});

test(['CI-4', 'CI-5', 'CI-3'], 'the Check in screen offers staff help to check out while the student is here, and names an auto-checkout or a closure when the scan is refused (L31, L32)', async () => {
  const t = await setup({ dev: true });
  const help = tab => tab.main().findAll(n => n.tag === 'p' && /^Having trouble\?/.test(n.textContent)).map(n => n.textContent);
  const screen = async () => {
    const tab = shellTab(t);
    await tab.open(t.fam.student, '#/checkin');
    return tab;
  };
  const simulate = async tab => {
    byTag(tab.main(), 'button').find(b => /Simulate scan/.test(b.textContent)).click();
    await tab.settle();
    return words(tab.main().find(n => n.getAttribute('role') === 'alert'));
  };
  assert.deepEqual(help(await screen()), ['Having trouble? Ask staff at the front desk to check you in.']);
  assert.equal((await t.scan()).body.action, 'checkin');
  assert.deepEqual(help(await screen()), ['Having trouble? Ask staff at the front desk to check you out.']);
  setClock(t, '16:01');
  t.jobs();
  const tab = await screen();
  assert.deepEqual(help(tab), ['Having trouble? Ask staff at the front desk to check you in.']);
  assert.equal(await simulate(tab), "You're already checked out You were already checked out automatically at 4:00 PM, so there's nothing to scan out of. If you need to check back in, ask staff at the front desk.");
  // on a closure day the screen says the center is closed: the refusal's title and the line under the button,
  // even on a screen opened before the closure was added
  setClock(t, '13:05', '2026-10-21');
  const open = await screen();
  assert.deepEqual(help(open), ['Having trouble? Ask staff at the front desk to check you in.']);
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-21', 'Power outage');
  const closedText = 'Closed today Irvine is closed today (Power outage), so there are no sessions. Your next one is Wed, Oct 28 at 1:00 PM.';
  const closedLine = 'Irvine is closed today (Power outage). There are no sessions to check in to.';
  const lines = tab => tab.main().findAll(n => n.tag === 'p' && /Having trouble\?|closed today/.test(n.textContent)).map(n => n.textContent);
  assert.equal(await simulate(open), closedText);
  assert.deepEqual(lines(open), [closedLine]);
  const fresh = await screen();
  assert.deepEqual(lines(fresh), [closedLine]);
  assert.equal(await simulate(fresh), closedText);
});

test(['CI-7'], 'the staff search shows a student waiting for parent approval with no Check in button (L63)', async () => {
  const t = await setup();
  const pend = t.fx.family(t.loc, { linked: false });
  rename(t, pend.student, 'Pia Pending');
  const tab = shellTab(t);
  await tab.open(t.staff, '#/building');
  const q = tab.doc.getElementById('ci-find');
  q.value = '';
  q.dispatch('input');
  await new Promise(r => setTimeout(r, 300));
  await tab.settle();
  const rows = byTag(q.parentNode.parentNode, 'li');
  assert.deepEqual(rows.map(li => [words(li), byTag(li, 'button').map(b => b.textContent)]), [
    ['MJ Maya Johnson Has Afternoon Study now Check in', ['Check in']],
    ['PP Pia Pending Waiting for a parent to approve the account', []],
  ]);
});

test(['CI-6'], "check-in Inbox items open a screen: a parent's check-in opens Home, a check-out opens Hours, staff open In the building (L35)", async () => {
  const t = await setup();
  assert.equal((await t.scan()).body.action, 'checkin');
  setClock(t, '14:00');
  assert.equal((await t.scan()).body.action, 'checkout');
  setClock(t, '14:01');
  assert.equal((await t.scan(t.fam.student, { confirm: true })).body.action, 'checkin');
  setClock(t, '16:01');
  t.jobs();
  load('src/notify.js').send(t.ctx, [t.staff.id], { kind: 'checkin', title: 'Staff visit item', refType: 'visit', refId: 1 });
  const links = async (user, withHours) => {
    const tab = shellTab(t);
    // Hours is the attendance module's screen, not loaded here: a stand-in shows where the link goes.
    if (withHours) tab.App.register({ id: 'hours', title: 'Hours', roles: ['parent'], render(el) { el.append('hours'); } });
    await tab.open(user, '#/inbox');
    return byTag(tab.main(), 'li').map(li => [li.childNodes[0].find(n => n.tag === 'strong').textContent.split(' ')[1],
      li.childNodes[0].tag === 'a' ? li.childNodes[0].getAttribute('href') : null]);
  };
  assert.deepEqual(await links(t.fam.parent, true),
    [['was', '#/hours'], ['checked', '#/home'], ['checked', '#/hours'], ['checked', '#/home']]);
  // with no Hours screen a check-out still opens Home
  assert.deepEqual((await links(t.fam.parent, false)).map(x => x[1]), ['#/home', '#/home', '#/home', '#/home']);
  assert.deepEqual(await links(t.staff, false), [['visit', '#/building']]);
});

// ---------------------------------------------------------------- fix list 2026-10-21 (F7, F12, F13)

test(['CI-3', 'CI-5', 'CI-7'], 'once the first back-to-back session ends, the status and Home card name the session the student is in now, before it starts (F12)', async () => {
  const t = await setup(); // Afternoon Study, Mon/Wed/Fri 13:00-16:00
  // Late Study's check-in window opens at 15:50, before Afternoon Study ends, so the stay runs on into it
  const late = t.fx.session(t.loc, { name: 'Late Study', weekdays: '3', start: '16:20', end: '18:00' });
  t.fx.enroll(t.fam.student, late, 3);
  const st = async who => { const s = (await t.as(who).get('/api/checkin/status')).body.students[0]; return [s.state, s.visit.session_name, s.visit.ends_at]; };
  const here = async () => (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body.here.map(v => [v.session_name, v.ends_at]);
  assert.equal((await t.scan()).body.action, 'checkin');
  const afternoon = ['here', 'Afternoon Study', at(LA, '2026-10-14', '16:00')];
  const lateNow = ['here', 'Late Study', at(LA, '2026-10-14', '18:00')];
  setClock(t, '15:55');
  assert.deepEqual(await st(t.fam.student), afternoon);
  setClock(t, '16:00');
  assert.deepEqual(await st(t.fam.student), afternoon, 'at the minute it ends the stay is still in Afternoon Study');
  setClock(t, '16:05');
  t.jobs();
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null, 'still one open visit');
  for (const who of [t.fam.student, t.fam.parent]) assert.deepEqual(await st(who), lateNow, who.role);
  assert.deepEqual(await here(), [lateNow.slice(1)]);
  // the Home card says so in words
  const tab = shellTab(t);
  await tab.open(t.fam.parent, '#/home');
  assert.match(words(tab.main()), /Maya is at Irvine since 1:05 PM · Late Study until 6:00 PM/);
  assert.doesNotMatch(words(tab.main()), /Afternoon Study until/);
});

test(['CI-4', 'CI-5'], 'after a refused scan the Check in screen refreshes its status card to match the message (F13)', async () => {
  const t = await setup({ dev: true });
  const tab = shellTab(t);
  await tab.open(t.fam.student, '#/checkin');
  const card = () => words(tab.main().find(n => n.cls.includes('card')));
  const label = () => tab.main().find(n => n.cls.includes('ci-scan-label')).textContent;
  const simulate = async () => {
    byTag(tab.main(), 'button').find(b => /Simulate scan/.test(b.textContent)).click();
    await tab.settle();
    return words(tab.main().find(n => n.getAttribute('role') === 'status'));
  };
  assert.match(await simulate(), /^✓ Checked in 1:05 PM/, 'the first scan checks in');
  assert.match(card(), /^You're checked in/);
  // the screen stays open while the app checks Maya out automatically
  setClock(t, '16:01');
  t.jobs();
  assert.match(card(), /^You're checked in/, 'nothing has refreshed the card yet');
  assert.match(await simulate(), /^You're already checked out/);
  assert.match(card(), /^You've checked out Left at 4:00 PM \(checked out automatically\)/);
  assert.equal(label(), 'Scan to check in');
});

test(['CI-7'], "the Needs review buttons' screen-reader names contain their visible text (F7)", async () => {
  const t = await setup();
  await t.scan();
  setClock(t, '16:30');
  t.jobs();
  const tab = shellTab(t);
  await tab.open(t.staff, '#/building');
  const buttons = byTag(tab.main(), 'button').filter(b => /^(Time is right|Fix time out)$/.test(b.textContent));
  assert.deepEqual(buttons.map(b => [b.textContent, b.getAttribute('aria-label')]),
    [['Time is right', 'Time is right for Maya Johnson'], ['Fix time out', 'Fix time out for Maya Johnson']]);
});

// ---------------------------------------------------------------- v1.1: whole schedules and date changes (D-42, D-46, D-47)

test(['CI-3', 'SC-5'], 'a whole-schedule enrollment checks in on every meeting date of the schedule, and on no other day', async () => {
  const t = await setup({ weekday: 0 }); // Afternoon Study meets Mon, Wed, Fri
  const day = async (date, wd) => {
    setClock(t, '13:05', date);
    const r = await t.scan();
    assert.equal(r.status, 200, date + ' ' + JSON.stringify(r.body));
    assert.equal(r.body.action, 'checkin', date);
    assert.equal(r.body.session.id, t.sess.id, date);
    // the visit keeps the date's own ISO weekday, never the enrollment's 0
    assert.equal(visitsOf(t, t.fam.student).pop().weekday, wd, date);
    setClock(t, '15:00', date);
    assert.equal((await t.scan()).body.action, 'checkout', date);
  };
  await day('2026-10-14', 3);
  await day('2026-10-16', 5);
  await day('2026-10-19', 1);
  setClock(t, '13:05', '2026-10-20');
  const tue = await t.scan();
  assert.equal(tue.status, 403);
  assert.equal(tue.body.error, 'no_session');
  assert.equal(tue.body.message, "You don't have a session right now. Your next one is tomorrow at 1:00 PM. Staff can check you in if needed.");
  assert.equal(visitsOf(t, t.fam.student).length, 3);
});

test(['SC-5', 'CI-3'], 'an added date checks in, linked to the schedule; a skipped date is refused and says where it moved', async () => {
  const t = await setup({ weekday: 0 });
  // Monday Oct 19 moves to Tuesday Oct 20; Wednesday Oct 21 is skipped
  t.fx.sessionDate(t.sess, '2026-10-19', 'skip', { reason: 'Staff training day' });
  t.fx.sessionDate(t.sess, '2026-10-20', 'add', { moved_from: '2026-10-19', reason: 'Staff training day' });
  t.fx.sessionDate(t.sess, '2026-10-21', 'skip', { reason: 'Field trip' });
  const fay = kid(t, t.loc, 'Fay Friday', t.sess, [5]); // a v1 Friday-only row: Monday was never hers
  const nia = kid(t, t.loc, 'Nia None');
  setClock(t, '13:05', '2026-10-19');
  const mon = await t.scan();
  assert.equal(mon.status, 403);
  assert.equal(mon.body.error, 'no_session');
  assert.equal(mon.body.message, "Afternoon Study doesn't meet today (moved to Tue, Oct 20). Your next one is tomorrow at 1:00 PM. Staff can check you in if needed.");
  assert.equal((await t.scan(fay)).body.message, "You don't have a session right now. Your next one is Fri, Oct 23 at 1:00 PM. Staff can check you in if needed.");
  assert.equal((await t.scan(nia)).body.message, "You don't have a session right now. Staff can check you in if needed.");
  assert.equal(visitsOf(t, t.fam.student).length, 0);
  assert.equal(t.fx.notifications(t.fam.parent).length, 0);
  // the added Tuesday opens 30 minutes early and links the schedule
  setClock(t, '12:30', '2026-10-20');
  const tue = await t.scan();
  assert.equal(tue.status, 200, JSON.stringify(tue.body));
  assert.equal(tue.body.action, 'checkin');
  assert.deepEqual(tue.body.session, { id: t.sess.id, name: 'Afternoon Study', start_at: at(LA, '2026-10-20', '13:00'), end_at: at(LA, '2026-10-20', '16:00') });
  const [v] = visitsOf(t, t.fam.student);
  assert.deepEqual([v.session_id, v.local_date, v.weekday], [t.sess.id, '2026-10-20', 2]);
  assert.equal(t.fx.notifications(t.fam.parent, 'checkin')[0].body, 'Afternoon Study, until 4:00 PM.');
  // a plain skip says so, without a move
  setClock(t, '13:05', '2026-10-21');
  assert.equal((await t.scan()).body.message, "Afternoon Study doesn't meet today. Your next one is Fri, Oct 23 at 1:00 PM. Staff can check you in if needed.");
});

test(['SC-5', 'CI-5', 'CI-7'], 'the status, In the building, a manual check-in and the auto-checkout all follow the changed dates', async () => {
  const t = await setup({ weekday: 0 });
  t.fx.sessionDate(t.sess, '2026-10-19', 'skip');
  t.fx.sessionDate(t.sess, '2026-10-20', 'add', { moved_from: '2026-10-19' });
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [0]);
  const status = async () => (await t.as(t.fam.parent).get('/api/checkin/status')).body.students[0];
  const building = async () => (await t.as(t.staff).get(`/api/checkin/locations/${t.loc.id}/building`)).body;
  // Monday: nothing is expected, and the next date is the added Tuesday
  setClock(t, '12:00', '2026-10-19');
  assert.deepEqual((await building()).expected, []);
  const next = (await status()).next;
  assert.deepEqual([next.date, next.start_at, next.when], ['2026-10-20', at(LA, '2026-10-20', '13:00'), 'tomorrow at 1:00 PM']);
  const refused = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'no_session');
  // Tuesday: both are expected, staff check Leo in without an override, and Maya scans in
  setClock(t, '12:40', '2026-10-20');
  const start = at(LA, '2026-10-20', '13:00');
  assert.deepEqual((await building()).expected.map(x => [x.name, x.session_id, x.start_at]).sort(),
    [['Leo Garcia', t.sess.id, start], ['Maya Johnson', t.sess.id, start]]);
  const manual = await t.as(t.staff).post('/api/checkin/manual-checkin', { studentId: leo.id });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.deepEqual([manual.body.override, manual.body.visit.session_id], [false, t.sess.id]);
  assert.equal((await t.scan()).body.action, 'checkin');
  // the added date ends at 4:00 PM, so the auto-checkout closes both visits then
  setClock(t, '15:59', '2026-10-20');
  t.jobs();
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  setClock(t, '16:01', '2026-10-20');
  t.jobs();
  for (const s of [t.fam.student, leo]) {
    const [v] = visitsOf(t, s);
    assert.deepEqual([v.check_out_at, v.checkout_method, v.flagged], [at(LA, '2026-10-20', '16:00'), 'auto', 1], s.name);
  }
});

// ---------------------------------------------------------------- v1.1 screens: no location, today's goals (D-49, D-50)

test(['CI-2', 'NF-5'], "the Check in screen sends the code only and never asks for the phone's location", async () => {
  const t = await setup({ dev: true });
  let asked = 0;
  const geolocation = {
    getCurrentPosition: ok => { asked++; ok({ coords: { latitude: 33.6846, longitude: -117.8265, accuracy: 5 } }); },
    watchPosition: () => { asked++; return 1; },
  };
  const tab = shellTab(t, { navigator: { geolocation } });
  await tab.open(t.fam.student, '#/checkin');
  assert.doesNotMatch(words(tab.main()), /location isn't saved|in the building/i);
  byTag(tab.main(), 'button').find(b => /Simulate scan/.test(b.textContent)).click();
  await tab.settle();
  assert.match(words(tab.main().find(n => n.getAttribute('role') === 'status')), /^✓ Checked in 1:05 PM/);
  const scans = tab.requests.filter(r => r.url === '/api/checkin/scan');
  assert.deepEqual(scans.map(r => Object.keys(r.body).sort()), [['code', 'locationId']]);
  assert.equal(asked, 0, 'the screen never asked for the location');
});

test(['CI-2', 'NF-5'], "the dev scan button doesn't suggest a location check (D-49)", async () => {
  const t = await setup({ dev: true });
  const tab = shellTab(t);
  await tab.open(t.fam.student, '#/checkin');
  const dev = byTag(tab.main(), 'button').filter(b => /Simulate/.test(b.textContent)).map(b => b.textContent);
  assert.deepEqual(dev, ['Simulate scan (dev)']);
  assert.doesNotMatch(words(tab.main()), /location/i);
});

test(['CI-4', 'NF-7'], 'a second scan soon after asks with the shell confirm: the safe answer comes first and has focus, on the Check in screen and the #/scan link', async () => {
  const t = await setup({ dev: true });
  const tab = shellTab(t, { stub: { 'GET /api/notes/goals/today': () => [200, { status: 'skipped', goals: [] }] } });
  await tab.open(t.fam.student, '#/checkin');
  const simulate = async () => {
    byTag(tab.main(), 'button').find(b => /Simulate scan/.test(b.textContent)).click();
    await tab.settle();
  };
  const ask = () => tab.main().find(n => n.getAttribute('role') === 'alertdialog');
  await simulate();
  setClock(t, '13:08');
  await simulate();
  let box = ask();
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-labelledby')).textContent, 'You checked in at 1:05 PM. Check out now?');
  assert.deepEqual(byTag(box, 'button').map(b => b.textContent), ['Stay checked in', 'Check out']);
  assert.equal(tab.doc.activeElement, byTag(box, 'button')[0], 'focus starts on the safe answer');
  tab.doc.activeElement.click();
  await tab.settle();
  assert.equal(ask(), undefined);
  assert.equal(tab.doc.activeElement.textContent, "OK, you're still checked in.");
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  await simulate();
  byTag(ask(), 'button').find(b => b.textContent === 'Check out').click();
  await tab.settle();
  assert.match(words(tab.main().find(n => n.getAttribute('role') === 'status')), /^✓ Checked out 1:08 PM/);
  // The entrance link: "Check back in?" takes focus on "Stay checked out" too.
  setClock(t, '13:10');
  const link = shellTab(t);
  await link.open(t.fam.student, `#/scan/${t.loc.id}/${t.code()}`);
  box = link.main().find(n => n.getAttribute('role') === 'alertdialog');
  assert.deepEqual(byTag(box, 'button').map(b => b.textContent), ['Stay checked out', 'Check back in']);
  assert.equal(link.doc.activeElement, byTag(box, 'button')[0]);
  assert.equal(visitsOf(t, t.fam.student).length, 1);
});

test(['DG-3', 'CI-2'], "after a check-in (never a check-out) the Check in screen asks for today's goals through the notes API", async () => {
  const t = await setup({ dev: true });
  let goals = { date: '2026-10-14', checked_in: true, status: 'none', goals: [] };
  const stub = {
    'GET /api/notes/goals/today': () => [200, goals],
    'POST /api/notes/goals/today/skip': () => { goals = Object.assign({}, goals, { status: 'skipped' }); return [200, { status: 'skipped' }]; },
  };
  const tab = shellTab(t, { stub });
  await tab.open(t.fam.student, '#/checkin');
  const result = () => tab.main().find(n => n.getAttribute('role') === 'status');
  const simulate = async () => {
    byTag(tab.main(), 'button').find(b => /Simulate scan/.test(b.textContent)).click();
    await tab.settle();
    return words(result());
  };
  const asked = () => tab.requests.filter(r => r.url.startsWith('/api/notes/')).map(r => r.method + ' ' + r.url);
  // not answered: Set today's goals (#/goals) or Skip today
  assert.match(await simulate(), /^✓ Checked in 1:05 PM .* What are you working on today\? Set today's goals Skip today$/);
  assert.equal(result().find(n => n.tag === 'a' && /Set today's goals/.test(n.textContent)).getAttribute('href'), '#/goals');
  byTag(result(), 'button').find(b => b.textContent === 'Skip today').click();
  await tab.settle();
  assert.deepEqual(asked(), ['GET /api/notes/goals/today', 'POST /api/notes/goals/today/skip']);
  assert.match(words(result()), /Skipped\. You can still add goals from Home today\.$/);
  // a check-out asks nothing
  setClock(t, '15:00');
  assert.doesNotMatch(await simulate(), /goals|working on/);
  assert.equal(asked().length, 2);
  // an answered day shows nothing when skipped, and the subjects with Edit when set
  setClock(t, '15:10');
  assert.match(await simulate(), /^✓ Checked in 3:10 PM .*Your parents have been told\.$/);
  goals = { date: '2026-10-14', checked_in: true, status: 'set', goals: [
    { position: 1, subject: 'math', subject_label: 'Math', text: 'Finish the practice set' },
    { position: 2, subject: 'english', subject_label: 'English', text: 'Write the first draft of my essay' }] };
  setClock(t, '15:20');
  assert.match(await simulate(), /^✓ Checked out/);
  setClock(t, '15:30');
  assert.match(await simulate(), /Today's goals: Math · English Edit$/);
  assert.equal(result().find(n => n.tag === 'a' && n.textContent === 'Edit').getAttribute('href'), '#/goals');
});

test(['CI-7', 'NF-5'], "a manual check-in's reasons no longer offer a failed location check", async () => {
  const t = await setup();
  const tab = shellTab(t);
  await tab.open(t.staff, '#/building');
  byTag(tab.main(), 'button').find(b => b.getAttribute('aria-label') === 'Check in Maya Johnson').click();
  await tab.settle();
  const select = tab.doc.getElementById('ci-reason');
  assert.deepEqual(byTag(select, 'option').map(o => o.textContent), ['No reason given', 'Phone is dead', 'Forgot phone', "Camera didn't work", 'Other']);
});
