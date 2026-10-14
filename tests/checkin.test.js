'use strict';
// Module checkin (PRD 1): the rotating entrance code, scan check-in and
// check-out, the auto-checkout job, parent notifications, and the staff
// "In the building" list with manual check-in/out and visit review.
const { test, makeApp, assert, load, at } = require('./lib');

const LA = 'America/Los_Angeles', TO = 'America/Toronto';
const mod = () => load('src/modules/checkin/index.js');
const M_PER_DEG = 6371000 * Math.PI / 180;
// A point `m` metres due north of the location.
const north = (loc, m) => ({ lat: loc.lat + m / M_PER_DEG, lng: loc.lng });

// Irvine (LA), one family enrolled in Afternoon Study on Wednesdays (13:00-16:00),
// clock at Wed 2026-10-14 13:05 local.
async function setup(opts = {}) {
  const t = await makeApp({ now: at(LA, '2026-10-14', '13:05'), dev: opts.dev });
  const loc = t.fx.location(Object.assign({ name: 'Irvine' }, opts.location));
  const fam = t.fx.family(loc, opts.family);
  const sess = t.fx.session(loc, { name: 'Afternoon Study', start: '13:00', end: '16:00', weekdays: '1,3,5' });
  t.fx.enroll(fam.student, sess, 3);
  rename(t, fam.student, 'Maya Johnson');
  const staff = t.fx.staff(loc, { name: 'Chris Ortiz' });
  const code = (l = loc) => mod().currentCode(t.ctx, l, t.clock.now());
  const scan = (student = fam.student, extra = {}) =>
    t.as(student).post('/api/checkin/scan', Object.assign({ locationId: loc.id, code: code() }, north(loc, 20), extra));
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

test(['CI-2'], "scans outside the location's radius, or without a location, are refused", async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  const far = await t.scan(leo, north(t.loc, 165)); // radius 150 m
  assert.equal(far.status, 403);
  assert.equal(far.body.error, 'outside_radius');
  assert.equal(far.body.message, 'You need to be inside Irvine to check in or out. If you are, ask staff to check you in.');
  const none = await t.scan(leo, { lat: null, lng: null });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'location_needed');
  const text = await t.scan(leo, { lat: String(t.loc.lat), lng: String(t.loc.lng) });
  assert.equal(text.body.error, 'location_needed');
  assert.equal(visitsOf(t, leo).length, 0);
  // just inside the radius works
  const near = await t.scan(t.fam.student, north(t.loc, 140));
  assert.equal(near.status, 200);
  assert.equal(near.body.action, 'checkin');
  // the radius is the location's own setting (D-5)
  t.db.prepare('UPDATE locations SET geofence_m = 200 WHERE id = ?').run(t.loc.id);
  const wider = await t.scan(leo, north(t.loc, 165));
  assert.equal(wider.status, 200);
  assert.equal(visitsOf(t, leo).length, 1);
});

test(['CI-2', 'NF-1'], 'only students scan, and only at their home location (D-1)', async () => {
  const t = await setup();
  const arcadia = t.fx.location({ name: 'Arcadia' });
  const visitor = kid(t, arcadia, 'Ana Lopez');
  const r = await t.scan(visitor);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'wrong_location');
  assert.equal(r.body.message, "This code is for Irvine. You're a member at Arcadia.");
  for (const u of [t.fam.parent, t.staff, t.fx.director(t.loc), t.fx.hq()]) {
    const x = await t.as(u).post('/api/checkin/scan', Object.assign({ locationId: t.loc.id, code: t.code() }, north(t.loc, 10)));
    assert.equal(x.status, 403, u.role);
    assert.equal(x.body.error, 'forbidden', u.role);
  }
  assert.equal((await t.anon.post('/api/checkin/scan', { locationId: t.loc.id, code: t.code() })).status, 401);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
});

test(['CI-2'], 'coordinates that are not a real place on Earth are refused, even ones that measure 0 m from the building', async () => {
  const t = await setup();
  const dist = (c) => load('src/time.js').distanceM(c.lat, c.lng, t.loc.lat, t.loc.lng);
  const huge = { lat: 1e308, lng: 1e308 };
  assert.ok(Number.isNaN(dist(huge)), 'the distance from 1e308 is not a number');
  // past a pole or once round the globe: each lands back on Irvine (33.6846, -117.8265)
  const wrapped = [{ lat: 146.3154, lng: 62.1735 }, { lat: -213.6846, lng: 62.1735 }, { lat: 33.6846, lng: 242.1735 }, { lat: 33.6846, lng: -477.8265 }];
  for (const c of wrapped) assert.ok(dist(c) < 1, `${JSON.stringify(c)} measures ${dist(c)} m`);
  for (const c of [huge, ...wrapped]) {
    const r = await t.scan(undefined, c);
    assert.equal(r.status, 400, JSON.stringify(c));
    assert.equal(r.body.error, 'location_needed', JSON.stringify(c));
    assert.equal(r.body.message, "We need your phone's location to check you in. It's only used for this check and isn't saved.");
  }
  assert.equal(visitsOf(t, t.fam.student).length, 0, 'no visit written');
  assert.equal(t.fx.notifications(t.fam.parent).length, 0);
  // the same coordinates can't check a student out either
  assert.equal((await t.scan()).body.action, 'checkin');
  setClock(t, '15:30');
  for (const c of [huge, ...wrapped]) assert.equal((await t.scan(undefined, c)).body.error, 'location_needed', JSON.stringify(c));
  assert.equal(visitsOf(t, t.fam.student)[0].check_out_at, null);
  assert.equal(t.fx.notifications(t.fam.parent, 'checkout').length, 0);
});

test(['CI-2'], 'the radius check fails closed: a distance that is not a number counts as outside', async () => {
  const t = await setup();
  const inside = (c) => mod().insideRadius(t.loc, c.lat, c.lng);
  assert.equal(inside({ lat: 1e308, lng: 1e308 }), false);
  assert.equal(inside({ lat: NaN, lng: t.loc.lng }), false);
  assert.equal(inside({ lat: t.loc.lat, lng: Infinity }), false);
  assert.equal(inside(north(t.loc, 140)), true);
  assert.equal(inside(north(t.loc, 165)), false);
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
  // a closure cancels the day's slots even for an enrolled student (SC-3)
  t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(t.loc.id, '2026-10-14', 'Staff training');
  const closed = await t.scan();
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error, 'no_session');
  assert.equal(closed.body.message, "You don't have a session right now. Your next one is Wed, Oct 21 at 1:00 PM. Staff can check you in if needed.");
  assert.equal(visitsOf(t, t.fam.student).length, 0);
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
    assert.equal(r.body.message, "Your membership isn't active right now. Ask a parent or the front desk.");
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
  assert.equal(n.body, "Maya didn't scan out of Irvine, so the app checked them out when Irvine closed. Total time 1h 55m. Staff will review it.");
});

test(['CI-5', 'NF-4', 'CI-3'], "check-in windows and auto-checkout run on each location's own clock (Toronto)", async () => {
  const t = await makeApp({ now: at(TO, '2026-10-14', '09:10') }); // 06:10 in LA
  const to = t.fx.location({ name: 'Toronto', timezone: TO, lat: 43.6532, lng: -79.3832 });
  const fam = t.fx.family(to);
  const s = t.fx.session(to, { name: 'Morning Focus', weekdays: '3', start: '09:00', end: '11:30' });
  t.fx.enroll(fam.student, s, 3);
  const r = await t.as(fam.student).post('/api/checkin/scan', Object.assign({ locationId: to.id, code: mod().currentCode(t.ctx, to, t.clock.now()) }, north(to, 10)));
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
    assert.equal(n[0].body, 'Total time 2h 42m.');
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
  assert.equal(auto[0].body, "Maya didn't scan out of Irvine, so the app checked them out when the session ended. Total time 2h 55m. Staff will review it.");
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
  await t.scan(rae); // ...and back in
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
  assert.equal(n.body, 'Total time 55m. Checked out by Dana Park.');
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
  const arcScan = s => t.as(s).post('/api/checkin/scan', Object.assign({ locationId: arcadia.id, code: t.code(arcadia) }, north(arcadia, 10)));
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
  assert.deepEqual(r.body, { locationId: t.loc.id, code: t.code(), lat: t.loc.lat, lng: t.loc.lng });
  for (const u of [t.fam.parent, t.staff]) assert.equal((await t.as(u).get('/api/checkin/dev/simulate')).status, 403, u.role);
  const scan = await t.as(t.fam.student).post('/api/checkin/scan', r.body);
  assert.equal(scan.status, 200);
  assert.equal(scan.body.action, 'checkin');
});

// ---------------------------------------------------------------- NF-5 privacy, NF-6 speed

test(['NF-5', 'CI-2'], 'scan coordinates are used for the radius check and never stored or logged', async () => {
  const t = await setup();
  const leo = kid(t, t.loc, 'Leo Garcia', t.sess, [3]);
  const lat = t.loc.lat + 0.000123457, lng = t.loc.lng - 0.000098765;     // ~15 m away
  const farLat = t.loc.lat + 0.004567891, farLng = t.loc.lng + 0.003456789; // ~600 m away
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
  assert.deepEqual([a.body.action, b.body.action, c.body.error], ['checkin', 'checkout', 'outside_radius']);
  assert.equal(t.fx.notifications(t.fam.parent).length, 2, 'the scans did write visits and notifications');
  const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  const dump = tables.map(n => JSON.stringify(t.db.prepare(`SELECT * FROM "${n}"`).all())).join('\n');
  const out = printed.join('\n');
  for (const n of [lat, lng, farLat, farLng]) {
    for (const s of [String(n), n.toFixed(6), n.toFixed(5)]) {
      assert.ok(!dump.includes(s), `database holds ${s}`);
      assert.ok(!out.includes(s), `console printed ${s}`);
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
    Object.assign({ locationId: loc.id, code: mod().currentCode(t.ctx, loc, t.clock.now()) }, north(loc, 10)));

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

test(['CI-2', 'CI-4'], 'checking out needs the phone inside the radius too; a scan from outside leaves the visit open', async () => {
  const t = await setup();
  assert.equal((await t.scan()).body.action, 'checkin');
  setClock(t, '15:30');
  const far = await t.scan(t.fam.student, north(t.loc, 165)); // radius 150 m
  assert.equal(far.status, 403);
  assert.equal(far.body.error, 'outside_radius');
  const [v] = visitsOf(t, t.fam.student);
  assert.deepEqual([v.check_out_at, v.checkout_method], [null, null]);
  assert.equal(t.fx.notifications(t.fam.parent, 'checkout').length, 0);
  const near = await t.scan(t.fam.student, north(t.loc, 140));
  assert.equal(near.body.action, 'checkout');
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
