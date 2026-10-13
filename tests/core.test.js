'use strict';
// Foundation: sign-in, scope rules, notifications inbox, location time helpers.
const { test, makeApp, assert, load, at } = require('./lib');

test('CORE', 'login works with the right password and returns the user', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = t.fx.family(loc).parent;
  const ok = await t.anon.post('/api/auth/login', { email: p.email, password: 'demo1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.id, p.id);
  const bad = await t.anon.post('/api/auth/login', { email: p.email, password: 'nope' });
  assert.equal(bad.status, 401);
});

test('CORE', 'a student whose parent link is still pending cannot sign in or use a session', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = t.fx.family(loc, { linked: false });
  const r = await t.anon.post('/api/auth/login', { email: student.email, password: 'demo1234' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'link_pending');
  const me = await t.as(student).get('/api/auth/me');
  assert.equal(me.status, 401);
});

test('CORE', 'inactive accounts cannot sign in', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const s = t.fx.staff(loc, { active: 0 });
  const r = await t.anon.post('/api/auth/login', { email: s.email, password: 'demo1234' });
  assert.equal(r.status, 403);
});

test('CORE', 'scope: staff see only their own location\'s students; parents only their own; hq everyone', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const a = t.fx.location(), b = t.fx.location();
  const fa = t.fx.family(a), fb = t.fx.family(b);
  const staffA = t.fx.staff(a), dirA = t.fx.director(a), hq = t.fx.hq();
  assert.equal(auth.canSeeStudent(t.ctx, staffA, fa.student.id), true);
  assert.equal(auth.canSeeStudent(t.ctx, staffA, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, dirA, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, fa.parent, fa.student.id), true);
  assert.equal(auth.canSeeStudent(t.ctx, fa.parent, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, fa.student, fa.student.id), true);
  assert.equal(auth.canSeeStudent(t.ctx, fa.student, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, hq, fb.student.id), true);
});

test('CORE', 'role ladder: director passes a staff gate, staff fails a director gate, families fail both', async () => {
  const auth = load('src/auth.js');
  assert.equal(auth.atLeast({ role: 'director' }, 'staff'), true);
  assert.equal(auth.atLeast({ role: 'hq' }, 'director'), true);
  assert.equal(auth.atLeast({ role: 'staff' }, 'director'), false);
  assert.equal(auth.atLeast({ role: 'parent' }, 'staff'), false);
  assert.equal(auth.atLeast({ role: 'student' }, 'staff'), false);
  assert.equal(auth.canManageLocation({ role: 'director', location_id: 1 }, 2), false);
  assert.equal(auth.canManageLocation({ role: 'hq', location_id: null }, 2), true);
});

test('CORE', 'notifications inbox: each user sees only their own, and can mark them read', async () => {
  const t = await makeApp();
  const notify = load('src/notify.js');
  const loc = t.fx.location();
  const f1 = t.fx.family(loc), f2 = t.fx.family(loc);
  notify.send(t.ctx, notify.parentsOf(t.ctx, f1.student.id), { kind: 'test', title: 'Hello' });
  const mine = await t.as(f1.parent).get('/api/notifications');
  assert.equal(mine.body.notifications.length, 1);
  assert.equal(mine.body.unread, 1);
  const theirs = await t.as(f2.parent).get('/api/notifications');
  assert.equal(theirs.body.notifications.length, 0);
  await t.as(f1.parent).post('/api/notifications/' + mine.body.notifications[0].id + '/read');
  assert.equal((await t.as(f1.parent).get('/api/notifications')).body.unread, 0);
});

test('CORE', 'time helpers use the location\'s zone, not the server\'s', async () => {
  const time = load('src/time.js');
  const la = { timezone: 'America/Los_Angeles' }, to = { timezone: 'America/Toronto' };
  const ms = at('America/Los_Angeles', '2026-10-14', '22:30'); // 01:30 next day in Toronto
  assert.equal(time.localDate(la, ms), '2026-10-14');
  assert.equal(time.localDate(to, ms), '2026-10-15');
  assert.equal(time.weekday(la, ms), 3);
  assert.equal(time.weekday(to, ms), 4);
  assert.equal(time.localTime(to, ms), '01:30');
});

test('CORE', 'unknown API paths return JSON 404 and errors never leak a stack', async () => {
  const t = await makeApp();
  const r = await t.anon.get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
});
