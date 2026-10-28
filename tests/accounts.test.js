'use strict';
// accounts: parent sign-up, student and guardian invites, parent approval,
// staff and director accounts, locations, the staff roster, and scope (NF-1).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, load, DEFAULT_NOW, ROOT } = require('./lib');

const A = '/api/accounts';
const DAY = 24 * 3600 * 1000;

const login = (t, email, password) => t.anon.post('/api/auth/login', { email, password });
const userRow = (t, id) => t.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const links = (t, studentId) => t.db.prepare('SELECT parent_id, status FROM family_links WHERE student_id = ? ORDER BY parent_id')
  .all(studentId).map(r => ({ parent_id: r.parent_id, status: r.status }));
const parentAt = (t, loc, o) => t.fx.user('parent', Object.assign({ location: loc }, o));

async function inviteStudent(t, parent, body) {
  const r = await t.as(parent).post(A + '/students/invite', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function inviteGuardian(t, parent, body) {
  const r = await t.as(parent).post(A + '/guardians/invite', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
// Invite, accept and approve: a student who can sign in.
async function approvedStudent(t, parent, name, email) {
  const inv = await inviteStudent(t, parent, { name, email });
  assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
  assert.equal((await t.as(parent).post(A + '/students/' + inv.invite.user_id + '/approve')).status, 200);
  return userRow(t, inv.invite.user_id);
}

// ---------------------------------------------------------------- AC-1 sign-up

test(['AC-1'], 'a parent signs up from the sign-in screen, picks a home location and is signed in', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const r = await t.anon.post(A + '/signup', { name: '  Rosa Diaz ', email: 'Rosa@Family.Test', phone: '555-0142', password: 'goodpass1', location_id: loc.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'parent');
  assert.equal(r.body.user.name, 'Rosa Diaz');
  assert.equal(r.body.user.email, 'rosa@family.test');
  assert.equal(r.body.user.phone, '555-0142');
  assert.equal(r.body.user.location_id, loc.id);
  const sid = (r.headers.get('set-cookie') || '').match(/^sid=([0-9a-f]{48});/);
  assert.ok(sid, 'signed in by the httpOnly cookie');
  assert.equal(r.body.token, undefined, 'the session token is never in the body (L64)');
  const me = await fetch(t.base + '/api/auth/me', { headers: { cookie: 'sid=' + sid[1] } }).then(x => x.json());
  assert.equal(me.user.id, r.body.user.id);
  assert.equal((await login(t, 'ROSA@family.test', 'goodpass1')).status, 200);
  const fam = await t.as(r.body.user).get(A + '/family');
  assert.equal(fam.status, 200);
  assert.deepEqual(fam.body.students, []);
  assert.deepEqual(fam.body.guardians.map(g => [g.id, g.you]), [[r.body.user.id, true]]);
  assert.equal(fam.body.location.name, 'Irvine');
});

test(['AC-1', 'NF-1'], 'sign-up always makes a parent, and refuses taken emails, short passwords, no phone and closed locations', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const closed = t.fx.location();
  t.db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(closed.id);
  const base = { name: 'Sam Hill', email: 'sam@family.test', phone: '555-0100', password: 'goodpass1', location_id: loc.id };
  const sneaky = await t.anon.post(A + '/signup', Object.assign({}, base, { role: 'hq', location_id: loc.id }));
  assert.equal(sneaky.status, 201);
  assert.equal(userRow(t, sneaky.body.user.id).role, 'parent');
  const staff = t.fx.staff(loc);
  const taken = await t.anon.post(A + '/signup', Object.assign({}, base, { email: staff.email.toUpperCase() }));
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, 'email_unavailable'); // one neutral answer (L53); see the L53/L62 test below
  const again = await t.anon.post(A + '/signup', Object.assign({}, base, { email: 'SAM@family.test' }));
  assert.equal(again.status, 409);
  const fresh = Object.assign({}, base, { email: 'new@family.test' });
  assert.equal((await t.anon.post(A + '/signup', Object.assign({}, fresh, { password: 'short12' }))).body.error, 'password');
  assert.equal((await t.anon.post(A + '/signup', Object.assign({}, fresh, { phone: '' }))).body.error, 'phone');
  assert.equal((await t.anon.post(A + '/signup', Object.assign({}, fresh, { location_id: closed.id }))).body.error, 'location');
  assert.equal((await t.anon.post(A + '/signup', Object.assign({}, fresh, { location_id: 9999 }))).body.error, 'location');
  assert.equal((await t.anon.post(A + '/signup', Object.assign({}, fresh, { email: 'not-an-email' }))).body.error, 'email');
  assert.equal((await t.anon.post(A + '/signup', Object.assign({}, fresh, { name: '   ' }))).body.error, 'name');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'parent'").get().n, 1);
});

test(['AC-1', 'NF-1'], 'the sign-up location picker lists open locations by name only', async () => {
  const t = await makeApp();
  const a = t.fx.location({ name: 'Irvine' }), b = t.fx.location({ name: 'Arcadia' }), c = t.fx.location({ name: 'Closed' });
  t.db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(c.id);
  const r = await t.anon.get(A + '/public/locations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.locations, [{ id: b.id, name: 'Arcadia' }, { id: a.id, name: 'Irvine' }]);
});

// ---------------------------------------------------------------- AC-1 / AC-3 student invites

test(['AC-1', 'AC-3'], 'a parent invites a student by email: a pending student with no password and a hashed one-time code', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const r = await t.as(p).post(A + '/students/invite', { name: 'Leo Diaz', email: 'Leo@Kid.Test' });
  assert.equal(r.status, 201);
  assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(r.body.link, '/#/invite/' + r.body.code);
  const inv = t.db.prepare('SELECT * FROM account_invites WHERE id = ?').get(r.body.invite.id);
  assert.equal(inv.kind, 'student');
  assert.equal(inv.invited_by, p.id);
  assert.equal(inv.email, 'leo@kid.test');
  assert.equal(inv.code_hash, crypto.createHash('sha256').update(r.body.code.replace('-', '')).digest('hex'));
  assert.equal(JSON.stringify(t.db.prepare('SELECT * FROM account_invites').all()).includes(r.body.code.replace('-', '')), false);
  assert.equal(inv.expires_at - inv.created_at, 7 * DAY);
  const s = userRow(t, inv.user_id);
  assert.equal(s.role, 'student');
  assert.equal(s.password_hash, null);
  assert.equal(s.location_id, loc.id);
  assert.equal(s.name, 'Leo Diaz');
  assert.deepEqual(links(t, s.id), [{ parent_id: p.id, status: 'pending' }]);
  const fam = await t.as(p).get(A + '/family');
  assert.equal(fam.body.students.length, 1);
  assert.equal(fam.body.students[0].state, 'invited');
  assert.equal(fam.body.students[0].invite.email, 'leo@kid.test');
  // a name and a way to reach the student are required
  assert.equal((await t.as(p).post(A + '/students/invite', { name: '', email: 'x@kid.test' })).body.error, 'name');
  assert.equal((await t.as(p).post(A + '/students/invite', { name: 'Ana' })).body.error, 'contact');
});

test(['AC-1', 'AC-3'], 'a student invited by phone adds their own email when accepting', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const inv = await inviteStudent(t, p, { name: 'Ana Diaz', phone: '(555) 010-2030' });
  const pre = await t.anon.get(A + '/invites/' + inv.code);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.invite.needs_email, true);
  assert.equal(pre.body.invite.phone, '•••30');
  const noEmail = await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' });
  assert.equal(noEmail.status, 400);
  assert.equal(noEmail.body.error, 'email');
  const ok = await t.anon.post(A + '/invites/accept', { code: inv.code.toLowerCase(), password: 'kidpass12', email: 'Ana@Kid.Test' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'awaiting_approval');
  const s = userRow(t, inv.invite.user_id);
  assert.equal(s.email, 'ana@kid.test');
  assert.equal(s.phone, '(555) 010-2030');
});

test(['AC-3', 'AC-1'], 'end to end: the student sets a password, cannot sign in until a parent approves, then can', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const p = parentAt(t, loc, { name: 'Rosa Diaz' });
  const inv = await inviteStudent(t, p, { name: 'Leo Diaz', email: 'leo@kid.test' });
  const sid = inv.invite.user_id;
  const pre = await t.anon.get(A + '/invites/' + inv.code);
  assert.deepEqual(pre.body.invite, {
    kind: 'student', name: 'Leo Diaz', invited_by: 'Rosa Diaz', location: 'Irvine', email: 'l•••@kid.test',
    phone: null, needs_email: false, expires_at: DEFAULT_NOW + 7 * DAY,
  });
  assert.equal((await login(t, 'leo@kid.test', 'kidpass12')).status, 401);
  const acc = await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' });
  assert.equal(acc.status, 200);
  assert.equal(acc.headers.get('set-cookie'), null);
  const n = t.fx.notifications(p, 'account_student_accepted');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Leo accepted your invite');
  assert.equal(n[0].ref_id, sid);
  // accepted but not approved: sign-in and sessions are refused
  const early = await login(t, 'leo@kid.test', 'kidpass12');
  assert.equal(early.status, 403);
  assert.equal(early.body.error, 'link_pending');
  assert.equal((await t.as({ id: sid }).get('/api/auth/me')).status, 401);
  assert.deepEqual(links(t, sid), [{ parent_id: p.id, status: 'pending' }]);
  assert.equal((await t.as(p).get(A + '/family')).body.students[0].state, 'awaiting_approval');
  const ok = await t.as(p).post(A + '/students/' + sid + '/approve');
  assert.equal(ok.status, 200);
  assert.deepEqual(links(t, sid), [{ parent_id: p.id, status: 'active' }]);
  assert.equal(t.db.prepare('SELECT approved_at FROM family_links WHERE student_id = ?').get(sid).approved_at, DEFAULT_NOW);
  const s = await login(t, 'leo@kid.test', 'kidpass12');
  assert.equal(s.status, 200);
  assert.equal(s.body.user.role, 'student');
  assert.equal(t.fx.notifications({ id: sid }, 'account_approved').length, 1);
  assert.equal((await t.as(p).get(A + '/family')).body.students[0].state, 'active');
  assert.equal((await t.as(p).post(A + '/students/' + sid + '/approve')).status, 409);
});

test(['AC-3'], 'a parent cannot approve a student who has not accepted the invite yet', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const inv = await inviteStudent(t, p, { name: 'Leo Diaz', email: 'leo@kid.test' });
  const r = await t.as(p).post(A + '/students/' + inv.invite.user_id + '/approve');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_accepted');
  assert.deepEqual(links(t, inv.invite.user_id), [{ parent_id: p.id, status: 'pending' }]);
});

test(['AC-3', 'NF-1'], 'invite codes work once, expire after 7 days, and a wrong code is refused', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const a = await inviteStudent(t, p, { name: 'Leo Diaz', email: 'leo@kid.test' });
  const b = await inviteStudent(t, p, { name: 'Ana Diaz', email: 'ana@kid.test' });
  assert.equal((await t.anon.post(A + '/invites/accept', { code: a.code, password: 'kidpass12' })).status, 200);
  const again = await t.anon.post(A + '/invites/accept', { code: a.code, password: 'otherpass1' });
  assert.equal(again.status, 410);
  assert.equal(again.body.error, 'invite_used');
  assert.equal((await t.anon.get(A + '/invites/' + a.code)).body.error, 'invite_used');
  assert.equal((await login(t, 'leo@kid.test', 'otherpass1')).status, 401);
  t.clock.set(DEFAULT_NOW + 7 * DAY - 60000);
  assert.equal((await t.anon.get(A + '/invites/' + b.code)).status, 200);
  t.clock.set(DEFAULT_NOW + 7 * DAY);
  const late = await t.anon.get(A + '/invites/' + b.code);
  assert.equal(late.status, 410);
  assert.equal(late.body.error, 'invite_expired');
  assert.equal((await t.anon.post(A + '/invites/accept', { code: b.code, password: 'kidpass12' })).status, 410);
  assert.equal(userRow(t, b.invite.user_id).password_hash, null);
  const wrong = await t.anon.get(A + '/invites/ZZZZ-ZZZZ');
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error, 'invite_invalid');
  assert.equal((await t.anon.post(A + '/invites/accept', { password: 'kidpass12' })).status, 404);
});

test(['AC-3', 'AC-1'], 'resending replaces the code; cancelling stops it and removes the pending student', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const inv = await inviteStudent(t, p, { name: 'Leo Diaz', email: 'leo@kid.test' });
  t.clock.set(DEFAULT_NOW + 6 * DAY);
  const re = await t.as(p).post(A + '/invites/' + inv.invite.id + '/resend');
  assert.equal(re.status, 200);
  assert.notEqual(re.body.code, inv.code);
  assert.equal(re.body.invite.expires_at, DEFAULT_NOW + 13 * DAY);
  assert.equal((await t.anon.get(A + '/invites/' + inv.code)).status, 404);
  assert.equal((await t.anon.get(A + '/invites/' + re.body.code)).status, 200);
  const cancel = await t.as(p).post(A + '/invites/' + inv.invite.id + '/cancel');
  assert.equal(cancel.status, 200);
  assert.equal((await t.anon.get(A + '/invites/' + re.body.code)).status, 404);
  assert.equal((await t.anon.post(A + '/invites/accept', { code: re.body.code, password: 'kidpass12' })).status, 404);
  assert.equal(userRow(t, inv.invite.user_id).active, 0);
  assert.deepEqual(links(t, inv.invite.user_id), []);
  assert.deepEqual((await t.as(p).get(A + '/family')).body.students, []);
  // an approved student's invite cannot be cancelled
  const leo = await approvedStudent(t, p, 'Leo Diaz', 'leo2@kid.test');
  const invId = t.db.prepare('SELECT id FROM account_invites WHERE user_id = ?').get(leo.id).id;
  const late = await t.as(p).post(A + '/invites/' + invId + '/cancel');
  assert.equal(late.status, 409);
  assert.equal(userRow(t, leo.id).active, 1);
});

// ---------------------------------------------------------------- AC-2 several students, second guardian

test(['AC-2'], 'one parent account holds several students', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const leo = await approvedStudent(t, p, 'Leo Diaz', 'leo@kid.test');
  const ana = await approvedStudent(t, p, 'Ana Diaz', 'ana@kid.test');
  const fam = await t.as(p).get(A + '/family');
  assert.deepEqual(fam.body.students.map(s => [s.name, s.state]), [['Ana Diaz', 'active'], ['Leo Diaz', 'active']]);
  const auth = load('src/auth.js');
  assert.deepEqual(auth.linkedStudentIds(t.ctx, p.id).sort(), [leo.id, ana.id].sort());
});

test(['AC-2'], 'a second guardian joins by email invite and sees the same students and records', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const notify = load('src/notify.js');
  const loc = t.fx.location();
  const f = t.fx.family(loc, { students: 2 });
  const g = await inviteGuardian(t, f.parent, { name: 'Mark Johnson', email: 'Mark@Family.Test' });
  const pre = await t.anon.get(A + '/invites/' + g.code);
  assert.equal(pre.body.invite.kind, 'guardian');
  assert.equal(pre.body.invite.email, 'm•••@family.test');
  const pending = await t.as(f.parent).get(A + '/family');
  assert.deepEqual(pending.body.invites.map(i => [i.name, i.email]), [['Mark Johnson', 'mark@family.test']]);
  const acc = await t.anon.post(A + '/invites/accept', { code: g.code, password: 'markpass1', phone: '555-0199' });
  assert.equal(acc.status, 201);
  const mark = acc.body.user;
  assert.equal(mark.role, 'parent');
  assert.equal(mark.email, 'mark@family.test');
  assert.equal(mark.name, 'Mark Johnson');
  assert.equal(mark.location_id, loc.id);
  assert.match(acc.headers.get('set-cookie') || '', /sid=/);
  assert.deepEqual(Object.keys(acc.body).sort(), ['kind', 'user'], 'the session token is never in the body (L64)');
  for (const s of f.students) {
    assert.equal(auth.canSeeStudent(t.ctx, mark, s.id), true);
    assert.deepEqual(notify.parentsOf(t.ctx, s.id).sort(), [f.parent.id, mark.id].sort());
  }
  const mine = await t.as(f.parent).get(A + '/family');
  const his = await t.as(mark).get(A + '/family');
  assert.deepEqual(his.body.students.map(s => [s.id, s.state]), mine.body.students.map(s => [s.id, s.state]));
  assert.equal(his.body.students.length, 2);
  assert.deepEqual(his.body.guardians.map(x => x.id).sort(), [f.parent.id, mark.id].sort());
  assert.deepEqual(mine.body.invites, []);
  const joined = t.fx.notifications(f.parent, 'account_guardian_joined');
  assert.equal(joined.length, 1);
  assert.equal(joined[0].title, 'Mark Johnson joined your family');
  assert.equal((await login(t, 'mark@family.test', 'markpass1')).status, 200);
});

test(['AC-2', 'AC-3'], 'a student added after the guardian joined is shared with both, and either guardian can approve', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const g = await inviteGuardian(t, p, { name: 'Mark Johnson', email: 'mark@family.test' });
  const mark = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'markpass1' })).body.user;
  const inv = await inviteStudent(t, mark, { name: 'Leo Diaz', email: 'leo@kid.test' });
  const sid = inv.invite.user_id;
  assert.deepEqual(links(t, sid), [{ parent_id: p.id, status: 'pending' }, { parent_id: mark.id, status: 'pending' }]);
  assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
  assert.equal(t.fx.notifications(p, 'account_student_accepted').length, 1);
  assert.equal(t.fx.notifications(mark, 'account_student_accepted').length, 1);
  assert.equal((await t.as(p).get(A + '/family')).body.students[0].state, 'awaiting_approval');
  assert.equal((await t.as(p).post(A + '/students/' + sid + '/approve')).status, 200);
  assert.deepEqual(links(t, sid), [{ parent_id: p.id, status: 'active' }, { parent_id: mark.id, status: 'active' }]);
  assert.equal(auth.canSeeStudent(t.ctx, mark, sid), true);
});

test(['AC-3', 'AC-2'], 'a guardian who joins while a student waits for approval gets a pending link; the student still cannot sign in until a parent approves', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const loc = t.fx.location();
  const eve = parentAt(t, loc, { email: 'eve@family.test' });
  // Both ways a second guardian joins: a new account from the invite, or an existing parent signed in.
  const ways = [
    { how: 'accept', kid: 'Leo Diaz', kidEmail: 'leo@kid.test', guardianEmail: 'mark@family.test', join: async code => {
      const r = await t.anon.post(A + '/invites/accept', { code, password: 'markpass1' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.user;
    } },
    { how: 'join', kid: 'Ana Ruiz', kidEmail: 'ana@kid.test', guardianEmail: eve.email, join: async code => {
      const r = await t.as(eve).post(A + '/invites/join', { code });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return eve;
    } },
  ];
  for (const w of ways) {
    const p = parentAt(t, loc);
    const inv = await inviteStudent(t, p, { name: w.kid, email: w.kidEmail });
    const sid = inv.invite.user_id;
    assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200, w.how);
    const g = await inviteGuardian(t, p, { name: 'Second Guardian', email: w.guardianEmail });
    const guardian = await w.join(g.code);
    const pending = [p.id, guardian.id].sort((a, b) => a - b).map(id => ({ parent_id: id, status: 'pending' }));
    assert.deepEqual(links(t, sid), pending, w.how);
    assert.equal(t.db.prepare('SELECT approved_at FROM family_links WHERE parent_id = ? AND student_id = ?').get(guardian.id, sid).approved_at, null, w.how);
    // joining does not approve the student: sign-in, sessions and the guardian's access all wait
    const early = await login(t, w.kidEmail, 'kidpass12');
    assert.equal(early.status, 403, w.how);
    assert.equal(early.body.error, 'link_pending', w.how);
    assert.equal((await t.as({ id: sid }).get('/api/auth/me')).status, 401, w.how);
    assert.equal(auth.canSeeStudent(t.ctx, guardian, sid), false, w.how);
    const fam = await t.as(guardian).get(A + '/family');
    assert.deepEqual(fam.body.students.map(s => [s.id, s.state]), [[sid, 'awaiting_approval']], w.how);
    // either guardian may approve: the new one here, the inviting parent when an existing parent joined
    const approver = w.how === 'accept' ? guardian : p;
    assert.equal((await t.as(approver).post(A + '/students/' + sid + '/approve')).status, 200, w.how);
    assert.deepEqual(links(t, sid), pending.map(l => ({ parent_id: l.parent_id, status: 'active' })), w.how);
    const ok = await login(t, w.kidEmail, 'kidpass12');
    assert.equal(ok.status, 200, w.how);
    assert.equal(ok.body.user.id, sid, w.how);
    assert.equal(auth.canSeeStudent(t.ctx, guardian, sid), true, w.how);
  }
});

test(['AC-2', 'NF-1'], 'an existing parent joins only with an invite sent to their email, and joining never bridges two families', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const loc = t.fx.location();
  const z = t.fx.family(loc);                      // Z and their student K2
  const xy = t.fx.family(loc);                     // X and their student K1 ...
  const y = parentAt(t, loc);
  t.fx.link(y, xy.student);                        // ... shared with an ex, Y
  const g = await inviteGuardian(t, z.parent, { name: 'X', email: xy.parent.email });
  const stranger = parentAt(t, loc);
  const wrong = await t.as(stranger).post(A + '/invites/join', { code: g.code });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'invite_mismatch');
  assert.equal(wrong.body.message.includes(xy.parent.email), false);
  assert.equal(auth.canSeeStudent(t.ctx, stranger, z.student.id), false);
  const dup = await t.anon.post(A + '/invites/accept', { code: g.code, password: 'whatever1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'email_unavailable');
  const ok = await t.as(xy.parent).post(A + '/invites/join', { code: g.code });
  assert.equal(ok.status, 200);
  assert.equal(auth.canSeeStudent(t.ctx, xy.parent, z.student.id), true);
  assert.equal(t.fx.notifications(z.parent, 'account_guardian_joined').length, 1);
  assert.equal((await t.as(xy.parent).post(A + '/invites/join', { code: g.code })).status, 410);
  // Y (X's ex) gains nothing from Z's family, and Z nothing from Y's
  assert.equal(auth.canSeeStudent(t.ctx, y, z.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, z.parent, xy.student.id), false);
  const k3 = await inviteStudent(t, z.parent, { name: 'New Kid', email: 'k3@kid.test' });
  assert.deepEqual(links(t, k3.invite.user_id).map(l => l.parent_id).sort(), [z.parent.id, xy.parent.id].sort());
  const yFam = await t.as(y).get(A + '/family');
  assert.deepEqual(yFam.body.students.map(s => s.id), [xy.student.id]);
  assert.equal(yFam.body.guardians.some(x => x.id === z.parent.id), false);
});

test(['AC-2', 'NF-1'], 'a parent in two families never carries one family\'s students into the other when either adds a student', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const notify = load('src/notify.js');
  const loc = t.fx.location();
  const z = t.fx.family(loc);                      // Z, X's new partner
  const xy = t.fx.family(loc);                     // X and their student K1 ...
  const y = parentAt(t, loc);
  t.fx.link(y, xy.student);                        // ... shared with an ex, Y
  const g = await inviteGuardian(t, z.parent, { name: 'X', email: xy.parent.email });
  assert.equal((await t.as(xy.parent).post(A + '/invites/join', { code: g.code })).status, 200);
  // X adds a student first: shared with Z, whose family X joined, and not with X's ex
  const k3 = await inviteStudent(t, xy.parent, { name: 'Kid Three', email: 'k3@kid.test' });
  assert.deepEqual(links(t, k3.invite.user_id).map(l => l.parent_id).sort(), [z.parent.id, xy.parent.id].sort());
  // then Z adds one: Y gets no link, no notification, no approval and no access
  const k4 = await inviteStudent(t, z.parent, { name: 'Kid Four', email: 'k4@kid.test' });
  const sid = k4.invite.user_id;
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM family_links WHERE parent_id = ? AND student_id = ?').get(y.id, sid).n, 0);
  assert.deepEqual(links(t, sid).map(l => l.parent_id).sort(), [z.parent.id, xy.parent.id].sort());
  assert.equal((await t.anon.post(A + '/invites/accept', { code: k4.code, password: 'kidpass12' })).status, 200);
  assert.equal(t.fx.notifications(y, 'account_student_accepted').length, 0);
  assert.equal(t.fx.notifications(z.parent, 'account_student_accepted').length, 1);
  const yApprove = await t.as(y).post(A + '/students/' + sid + '/approve');
  assert.equal(yApprove.status, 403);
  assert.equal(links(t, sid).every(l => l.status === 'pending'), true);
  assert.equal((await t.as(z.parent).post(A + '/students/' + sid + '/approve')).status, 200);
  assert.equal(auth.canSeeStudent(t.ctx, y, sid), false);
  assert.deepEqual(notify.parentsOf(t.ctx, sid).sort(), [z.parent.id, xy.parent.id].sort());
  // Z's Family screen lists only Z and X; Y's lists neither Z nor Z's students
  const zFam = await t.as(z.parent).get(A + '/family');
  assert.deepEqual(zFam.body.guardians.map(x => x.id).sort(), [z.parent.id, xy.parent.id].sort());
  assert.equal(JSON.stringify(zFam.body).includes(y.email), false);
  const yFam = await t.as(y).get(A + '/family');
  assert.deepEqual(yFam.body.students.map(s => s.id), [xy.student.id]);
  assert.equal(yFam.body.guardians.some(x => x.id === z.parent.id), false);
  // Y can't resend or cancel the invites of Z's family either
  assert.equal((await t.as(y).post(A + '/invites/' + k4.invite.id + '/resend')).status, 403);
  const zInv = await inviteGuardian(t, z.parent, { name: 'Grandma Z', email: 'grandma@family.test' });
  assert.equal((await t.as(y).post(A + '/invites/' + zInv.invite.id + '/cancel')).status, 403);
  // S1/D-24: only the sender resends or cancels a guardian invite, not even a co-guardian
  assert.equal((await t.as(xy.parent).post(A + '/invites/' + zInv.invite.id + '/resend')).status, 403);
  assert.equal((await t.as(xy.parent).post(A + '/invites/' + zInv.invite.id + '/cancel')).status, 403);
  assert.equal((await t.as(z.parent).post(A + '/invites/' + zInv.invite.id + '/resend')).status, 200);
});

test(['AC-2', 'AC-3'], 'a family gets one open invite per email: a second guardian or student invite to it is refused, and Resend is the way', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const g = await inviteGuardian(t, p, { name: 'Mark Johnson', email: 'mark@family.test' });
  const mark = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'markpass1' })).body.user;
  const kemi = await inviteGuardian(t, p, { name: 'Kemi Adeyemi', email: 'kemi@family.test' });
  // the same email again, from the same parent or a co-guardian: refused. The sender is pointed at Resend;
  // a co-guardian, who can't resend another guardian's invite (S1), is pointed at the sender
  for (const [who, msg] of [[p, /^Kemi already has an invite at that email\. Use Resend/],
    [mark, new RegExp(`^Kemi already has an invite from ${p.name.split(' ')[0]} at that email\\. Ask ${p.name.split(' ')[0]} to resend it if Kemi needs a new code\\.$`)]]) {
    const again = await t.as(who).post(A + '/guardians/invite', { name: 'Kemi A', email: 'KEMI@family.test' });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error, 'invite_pending');
    assert.match(again.body.message, msg);
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM account_invites WHERE email = 'kemi@family.test'").get().n, 1);
  assert.deepEqual((await t.as(p).get(A + '/family')).body.invites.map(i => i.email), ['kemi@family.test']);
  // an expired invite still has its card, which offers a new code
  t.clock.set(DEFAULT_NOW + 8 * DAY);
  assert.match((await t.as(p).post(A + '/guardians/invite', { name: 'Kemi', email: 'kemi@family.test' })).body.message, /Use Send a new code/);
  // another family may invite the same person; once cancelled, this family may invite again
  assert.equal((await t.as(parentAt(t, loc)).post(A + '/guardians/invite', { name: 'Kemi', email: 'kemi@family.test' })).status, 201);
  assert.equal((await t.as(p).post(A + '/invites/' + kemi.invite.id + '/cancel')).status, 200);
  await inviteGuardian(t, p, { name: 'Kemi Adeyemi', email: 'kemi@family.test' });
  // students too: one open invite per email in the family, while siblings may share a phone
  const leo = await inviteStudent(t, p, { name: 'Leo Diaz', email: 'leo@kid.test' });
  for (const who of [p, mark]) {
    const twin = await t.as(who).post(A + '/students/invite', { name: 'Leo D', email: 'Leo@Kid.Test' });
    assert.equal(twin.status, 409, JSON.stringify(twin.body));
    assert.equal(twin.body.error, 'invite_pending');
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n, 1);
  await inviteStudent(t, p, { name: 'Ana Diaz', phone: '555-0140' });
  await inviteStudent(t, p, { name: 'Bo Diaz', phone: '555-0140' });
  // the first code still works
  assert.equal((await t.anon.post(A + '/invites/accept', { code: leo.code, password: 'kidpass12' })).status, 200);
});

test(['AC-2'], 'a guardian invite to the email of one of the family\'s own students is refused when it is made', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  await approvedStudent(t, p, 'Leo Diaz', 'leo@kid.test');
  await inviteStudent(t, p, { name: 'Ana Diaz', email: 'ana@kid.test' });
  for (const [email, kid] of [['LEO@kid.test', 'Leo'], ['ana@kid.test', 'Ana']]) {
    const r = await t.as(p).post(A + '/guardians/invite', { name: 'Grandpa', email });
    assert.equal(r.status, 400, email);
    assert.equal(r.body.error, 'email');
    assert.equal(r.body.message, `That's the email for ${kid}, a student on your account. Enter the guardian's own email.`);
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM account_invites WHERE kind = 'guardian'").get().n, 0);
  // another family's student is not named or refused: that would tell a stranger the address is in use
  assert.equal((await t.as(parentAt(t, loc)).post(A + '/guardians/invite', { name: 'Someone', email: 'leo@kid.test' })).status, 201);
});

test(['AC-2'], 'a guardian invite to someone who is already a co-guardian is refused when it is made', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const erin = parentAt(t, loc, { name: 'Erin Johnson', email: 'johnson@family.test' });
  const g = await inviteGuardian(t, erin, { name: 'Mark Johnson', email: 'mark.johnson@family.test' });
  const mark = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'markpass1' })).body.user;
  // a parent who joined from their own account, with an existing invite
  const kemi = parentAt(t, loc, { name: 'Kemi Adeyemi', email: 'kemi@family.test' });
  const k = await inviteGuardian(t, erin, { name: 'Kemi', email: kemi.email });
  assert.equal((await t.as(kemi).post(A + '/invites/join', { code: k.code })).status, 200);
  for (const [who, email, name] of [[erin, 'Mark.Johnson@family.test', 'Mark Johnson'], [erin, kemi.email, 'Kemi Adeyemi'], [mark, erin.email, 'Erin Johnson']]) {
    const r = await t.as(who).post(A + '/guardians/invite', { name: 'Again', email });
    assert.equal(r.status, 409, email);
    assert.equal(r.body.error, 'already_family', email);
    assert.equal(r.body.message, `${name} is already in your family.`, email);
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM account_invites WHERE kind = 'guardian' AND accepted_at IS NULL").get().n, 0);
  assert.deepEqual((await t.as(erin).get(A + '/family')).body.invites, []);
  // sharing a student does not make a co-guardian (D-24), so that parent can still be invited and join
  const ex = parentAt(t, loc);
  t.fx.link(ex, (await approvedStudent(t, erin, 'Maya Johnson', 'maya@kid.test')));
  const exInv = await inviteGuardian(t, erin, { name: 'Ex', email: ex.email });
  assert.equal((await t.as(ex).post(A + '/invites/join', { code: exInv.code })).status, 200);
});

test(['AC-1', 'AC-3', 'NF-1'], 'the invite accept screen gives one neutral answer for an email in use, whoever holds it', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const holders = [parentAt(t, loc), t.fx.staff(loc), t.fx.staff(loc, { active: 0 }), t.fx.hq()];
  const inv = await inviteStudent(t, p, { name: 'Ana Diaz', phone: '555-0101' });
  const answers = [];
  for (const h of [...holders, { email: holders[0].email.toUpperCase() }]) {
    const r = await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12', email: h.email });
    answers.push({ status: r.status, body: r.body });
  }
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.equal(answers[0].status, 409);
  assert.equal(answers[0].body.error, 'email_unavailable');
  assert.equal(answers[0].body.message, 'Already have an account? Sign in first, then open this invite again. If not, use a different email.');
  assert.doesNotMatch(JSON.stringify(answers[0].body), /already has|exists|taken|in use|staff|parent/i);
  assert.equal(userRow(t, inv.invite.user_id).password_hash, null);
  assert.equal((await t.anon.get(A + '/invites/' + inv.code)).status, 200);
  // an invite whose email was set by the inviter: the same answer for a student invite and a guardian invite.
  // A student invite to an email in use is refused when it is made (S12), so here the email is taken afterwards.
  const kid = await inviteStudent(t, p, { name: 'Bo Diaz', email: 'bo@kid.test' });
  parentAt(t, loc, { email: 'bo@kid.test' });
  const grown = await inviteGuardian(t, p, { name: 'Mark Diaz', email: holders[2].email });
  const k = await t.anon.post(A + '/invites/accept', { code: kid.code, password: 'kidpass12' });
  const g = await t.anon.post(A + '/invites/accept', { code: grown.code, password: 'markpass1' });
  assert.deepEqual({ status: k.status, body: k.body }, { status: g.status, body: g.body });
  assert.deepEqual(k.body, { error: 'email_unavailable',
    message: 'Already have an account? Sign in first, then open this invite again. If not, ask for a new invite to a different email.' });
  // a free email goes straight through
  assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12', email: 'ana@kid.test' })).status, 200);
});

test(['AC-1', 'AC-3', 'NF-1'], 'a student on a phone-only invite cannot take an email another open invite was sent to, and hears the same neutral answer', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const other = parentAt(t, loc);
  const leo = await inviteStudent(t, other, { name: 'Leo Diaz', email: 'leo@kid.test' });
  const gran = await inviteGuardian(t, other, { name: 'Gran Diaz', email: 'gran@family.test' });
  const p = parentAt(t, loc);
  const inv = await inviteStudent(t, p, { name: 'Ana Ruiz', phone: '555-0101' });
  const accept = async email => {
    const r = await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12', email });
    return { status: r.status, body: r.body };
  };
  // the answer for an email that already has an account
  const held = await accept(parentAt(t, loc).email);
  assert.equal(held.status, 409);
  assert.equal(held.body.error, 'email_unavailable');
  for (const email of ['leo@kid.test', 'GRAN@family.test']) assert.deepEqual(await accept(email), held, email);
  assert.equal(userRow(t, inv.invite.user_id).password_hash, null);
  assert.equal(userRow(t, inv.invite.user_id).email, null);
  // the other family's invites still work
  assert.equal((await t.anon.post(A + '/invites/accept', { code: leo.code, password: 'kidpass12' })).status, 200);
  assert.equal((await t.anon.post(A + '/invites/accept', { code: gran.code, password: 'granpass1' })).status, 201);
  // a cancelled invite holds nothing
  const kemi = await inviteGuardian(t, other, { name: 'Kemi Adeyemi', email: 'kemi@family.test' });
  assert.deepEqual(await accept('kemi@family.test'), held);
  assert.equal((await t.as(other).post(A + '/invites/' + kemi.invite.id + '/cancel')).status, 200);
  assert.equal((await accept('kemi@family.test')).status, 200);
  assert.equal(userRow(t, inv.invite.user_id).email, 'kemi@family.test');
});

test(['AC-3', 'AC-2'], 'declining a student who accepted tells the other guardians, and the accepted item stops asking for approval', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc, { name: 'Rosa Diaz' });
  const g = await inviteGuardian(t, p, { name: 'Mark Diaz', email: 'mark@family.test' });
  const mark = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'markpass1' })).body.user;
  const leo = await inviteStudent(t, p, { name: 'Leo Diaz', email: 'leo@kid.test' });
  const ana = await inviteStudent(t, p, { name: 'Ana Diaz', email: 'ana@kid.test' });
  for (const inv of [leo, ana]) assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
  const accepted = (who, sid) => t.fx.notifications(who, 'account_student_accepted').find(n => n.ref_id === sid);
  for (const who of [p, mark]) assert.match(accepted(who, leo.invite.user_id).body, /^Approve Leo/);
  const r = await t.as(p).post(A + '/invites/' + leo.invite.id + '/cancel');
  assert.equal(r.status, 200);
  for (const who of [p, mark]) {
    const n = accepted(who, leo.invite.user_id);
    assert.equal(n.body, "Rosa Diaz declined Leo, so there's nothing to approve.");
    assert.equal(n.read_at, DEFAULT_NOW);
    // Ana still waits, and her item still asks
    assert.match(accepted(who, ana.invite.user_id).body, /^Approve Ana/);
    assert.equal(accepted(who, ana.invite.user_id).read_at, null);
  }
  const told = t.fx.notifications(mark, 'account_student_declined');
  assert.equal(told.length, 1);
  assert.equal(told[0].title, 'Rosa declined Leo');
  assert.equal(told[0].body, "Leo's account wasn't created, and the invite code no longer works.");
  assert.deepEqual([told[0].ref_type, told[0].ref_id], ['user', leo.invite.user_id]);
  assert.equal(t.fx.notifications(p, 'account_student_declined').length, 0);
  assert.equal(userRow(t, leo.invite.user_id).active, 0);
});

// ---------------------------------------------------------------- AC-4 staff accounts

test(['AC-4'], 'a director creates staff at their location with a temporary password shown once', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const dir = t.fx.director(loc);
  const r = await t.as(dir).post(A + '/staff', { name: 'Chris Ortiz', email: 'Chris@Elite.Test', phone: '555-0111' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'staff');
  assert.equal(r.body.user.location_id, loc.id);
  assert.equal(r.body.user.email, 'chris@elite.test');
  assert.match(r.body.temp_password, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
  const signin = await login(t, 'chris@elite.test', r.body.temp_password);
  assert.equal(signin.status, 200);
  const chris = signin.body.user;
  assert.equal((await t.as(chris).get(A + '/me')).body.temp_password, true);
  const list = await t.as(dir).get(A + '/staff');
  const row = list.body.staff.find(s => s.id === chris.id);
  assert.equal(row.temp_password, true);
  assert.equal(JSON.stringify(list.body).includes(r.body.temp_password), false);
  const log = t.fx.audit('staff.create');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, dir.id);
  assert.equal(log[0].target_id, chris.id);
  assert.equal(log[0].location_id, loc.id);
  assert.equal(JSON.stringify(log).includes(r.body.temp_password), false);
  // choosing their own password retires the temporary one
  const pw = await t.as(chris).post(A + '/password', { current_password: r.body.temp_password, new_password: 'chrispass9' });
  assert.equal(pw.status, 200);
  assert.equal((await t.as(chris).get(A + '/me')).body.temp_password, false);
  assert.equal((await login(t, 'chris@elite.test', r.body.temp_password)).status, 401);
  assert.equal((await login(t, 'chris@elite.test', 'chrispass9')).status, 200);
  const dup = await t.as(dir).post(A + '/staff', { name: 'Chris Again', email: 'CHRIS@elite.test' });
  assert.equal(dup.status, 409);
});

test(['AC-4'], 'a director deactivates, reactivates and resets staff at their location; a deactivated account is shut out at once', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const dir = t.fx.director(loc);
  const s = t.fx.staff(loc);
  const session = t.as(s);
  assert.equal((await session.get(A + '/roster')).status, 200);
  const off = await t.as(dir).post(A + '/staff/' + s.id + '/deactivate');
  assert.equal(off.status, 200);
  assert.equal(userRow(t, s.id).active, 0);
  assert.equal((await session.get(A + '/roster')).status, 401);
  assert.equal((await login(t, s.email, 'demo1234')).status, 403);
  assert.equal(t.fx.audit('staff.deactivate')[0].target_id, s.id);
  assert.equal((await t.as(dir).post(A + '/staff/' + s.id + '/reactivate')).status, 200);
  assert.equal((await login(t, s.email, 'demo1234')).status, 200);
  assert.equal(t.fx.audit('staff.reactivate').length, 1);
  const reset = await t.as(dir).post(A + '/staff/' + s.id + '/reset-password');
  assert.equal(reset.status, 200);
  assert.equal((await login(t, s.email, 'demo1234')).status, 401);
  const back = await login(t, s.email, reset.body.temp_password);
  assert.equal(back.status, 200);
  assert.equal((await t.as(s).get(A + '/me')).body.temp_password, true);
  assert.equal(t.fx.audit('staff.reset_password').length, 1);
  assert.equal((await t.as(dir).post(A + '/staff/' + dir.id + '/deactivate')).status, 400);
});

test(['AC-4', 'NF-1'], 'a director cannot see or change staff at another location, or touch a director', async () => {
  const t = await makeApp();
  const a = t.fx.location(), b = t.fx.location();
  const dirA = t.fx.director(a), dirA2 = t.fx.director(a), staffB = t.fx.staff(b), staffA = t.fx.staff(a);
  const list = await t.as(dirA).get(A + '/staff');
  assert.deepEqual(list.body.staff.map(x => x.id).sort(), [dirA.id, dirA2.id, staffA.id].sort());
  assert.equal((await t.as(dirA).get(A + '/staff?location_id=' + b.id)).status, 403);
  const create = await t.as(dirA).post(A + '/staff', { name: 'Elsewhere', email: 'else@elite.test', location_id: b.id });
  assert.equal(create.status, 403);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'else@elite.test'").get().n, 0);
  for (const action of ['deactivate', 'reactivate', 'reset-password']) {
    assert.equal((await t.as(dirA).post(A + '/staff/' + staffB.id + '/' + action)).status, 403, action + ' other location');
    assert.equal((await t.as(dirA).post(A + '/staff/' + dirA2.id + '/' + action)).status, 403, action + ' a director');
  }
  assert.equal(userRow(t, staffB.id).active, 1);
  assert.equal(userRow(t, dirA2.id).active, 1);
  assert.equal(t.fx.audit().length, 0);
});

// ---------------------------------------------------------------- AC-5 locations and directors

test(['AC-5'], 'HQ creates a location with its own time zone, radius, QR time and hours', async () => {
  const t = await makeApp();
  const hq = t.fx.hq();
  const body = { name: 'Toronto', timezone: 'America/Toronto', address: '100 Queen St W', lat: 43.6532, lng: -79.3832,
    geofence_m: 200, qr_rotate_at: '05:00', open_time: '08:00', close_time: '19:30' };
  const r = await t.as(hq).post(A + '/locations', body);
  assert.equal(r.status, 201);
  const row = t.db.prepare('SELECT * FROM locations WHERE id = ?').get(r.body.location.id);
  for (const [k, v] of Object.entries(body)) assert.equal(row[k], v, k);
  assert.equal(row.active, 1);
  assert.match(row.qr_secret, /^[0-9a-f]{32}$/);
  assert.equal(r.body.location.qr_secret, undefined);
  assert.equal(t.fx.audit('location.create')[0].target_id, row.id);
  const defaults = await t.as(hq).post(A + '/locations', { name: 'Plain', timezone: 'America/Chicago', lat: 41.9, lng: -87.6 });
  assert.equal(defaults.body.location.geofence_m, 150);
  assert.equal(defaults.body.location.qr_rotate_at, '04:00');
  const bad = async (over, field) => {
    const x = await t.as(hq).post(A + '/locations', Object.assign({}, body, over));
    assert.equal(x.status, 400, field);
    assert.equal(x.body.error, field);
  };
  await bad({ timezone: 'Mars/Olympus' }, 'timezone');
  await bad({ lat: 120 }, 'lat');
  await bad({ lng: 'west' }, 'lng');
  await bad({ geofence_m: 5 }, 'geofence_m');
  await bad({ qr_rotate_at: '4am' }, 'qr_rotate_at');
  await bad({ open_time: '20:00', close_time: '09:00' }, 'close_time');
  await bad({ name: '' }, 'name');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, 2);
});

test(['AC-5'], 'HQ creates a director at a location and assigns an existing staff member as director', async () => {
  const t = await makeApp();
  const hq = t.fx.hq();
  const a = t.fx.location({ name: 'Irvine' }), b = t.fx.location({ name: 'Arcadia' });
  const r = await t.as(hq).post(A + '/directors', { name: 'Dana Park', email: 'dana@elite.test', location_id: a.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'director');
  assert.equal(r.body.user.location_id, a.id);
  assert.equal((await login(t, 'dana@elite.test', r.body.temp_password)).status, 200);
  assert.equal(t.fx.audit('director.create')[0].target_id, r.body.user.id);
  assert.equal((await t.as(hq).post(A + '/directors', { name: 'No Place', email: 'np@elite.test' })).status, 400);
  const s = t.fx.staff(a);
  const as = await t.as(hq).post(A + '/directors/assign', { user_id: s.id, location_id: b.id });
  assert.equal(as.status, 200);
  assert.equal(userRow(t, s.id).role, 'director');
  assert.equal(userRow(t, s.id).location_id, b.id);
  const n = t.fx.notifications(s, 'account_role');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "You're now the director at Arcadia");
  assert.deepEqual(JSON.parse(t.fx.audit('director.assign')[0].detail).to, { role: 'director', location_id: b.id });
  const list = await t.as(hq).get(A + '/locations');
  const arc = list.body.locations.find(l => l.id === b.id);
  assert.deepEqual(arc.directors.map(d => d.id), [s.id]);
  // the new director now has director powers at Arcadia
  assert.equal((await t.as(userRow(t, s.id)).post(A + '/staff', { name: 'New Hire', email: 'hire@elite.test' })).status, 201);
  assert.equal((await t.as(hq).post(A + '/directors/assign', { user_id: t.fx.family(a).parent.id, location_id: b.id })).status, 404);
});

test(['AC-5'], 'moving a location\'s only director away says which location now has no director (fix list item 8)', async () => {
  const t = await makeApp();
  const hq = t.fx.hq();
  const a = t.fx.location({ name: 'Irvine' }), b = t.fx.location({ name: 'Arcadia' }), c = t.fx.location({ name: 'Tustin' });
  const dana = t.fx.director(a, { name: 'Dana Park' });
  // A deactivated co-director doesn't count: Irvine is left with no active director.
  const gone = t.fx.director(a, { name: 'Old Boss' });
  t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone.id);
  const moved = await t.as(hq).post(A + '/directors/assign', { user_id: dana.id, location_id: b.id });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.left_without_director, { id: a.id, name: 'Irvine' });
  assert.equal(userRow(t, dana.id).location_id, b.id);
  // One of two active directors moving leaves the other in charge: nothing to report.
  const lee = t.fx.director(c, { name: 'Lee Wong' });
  t.fx.director(c, { name: 'Mo Diaz' });
  const shared = await t.as(hq).post(A + '/directors/assign', { user_id: lee.id, location_id: a.id });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.left_without_director, null);
  // A staff member made director leaves no location without one, even one that has no director.
  const s = t.fx.staff(t.fx.location({ name: 'Orange' }));
  const promoted = await t.as(hq).post(A + '/directors/assign', { user_id: s.id, location_id: c.id });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.left_without_director, null);
});

test(['AC-5', 'NF-1'], 'directors edit only their own location\'s radius, QR time and hours; HQ edits anything', async () => {
  const t = await makeApp();
  const a = t.fx.location({ name: 'Irvine' }), b = t.fx.location({ name: 'Arcadia' });
  const dirA = t.fx.director(a), staffA = t.fx.staff(a), hq = t.fx.hq();
  const ok = await t.as(dirA).patch(A + '/locations/' + a.id, { geofence_m: 250, qr_rotate_at: '03:30', open_time: '08:30', close_time: '21:00' });
  assert.equal(ok.status, 200);
  const row = t.db.prepare('SELECT * FROM locations WHERE id = ?').get(a.id);
  assert.deepEqual([row.geofence_m, row.qr_rotate_at, row.open_time, row.close_time], [250, '03:30', '08:30', '21:00']);
  const log = t.fx.audit('location.update');
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0].detail).geofence_m, [150, 250]);
  for (const over of [{ name: 'Mine Now' }, { timezone: 'America/New_York' }, { lat: 1 }, { address: 'Elsewhere' }, { active: 0 }]) {
    const x = await t.as(dirA).patch(A + '/locations/' + a.id, over);
    assert.equal(x.status, 403, JSON.stringify(over));
  }
  assert.equal(t.db.prepare('SELECT name, timezone FROM locations WHERE id = ?').get(a.id).name, 'Irvine');
  assert.equal((await t.as(dirA).patch(A + '/locations/' + b.id, { geofence_m: 999 })).status, 403);
  assert.equal(t.db.prepare('SELECT geofence_m FROM locations WHERE id = ?').get(b.id).geofence_m, 150);
  assert.equal((await t.as(staffA).patch(A + '/locations/' + a.id, { geofence_m: 300 })).status, 403);
  assert.equal((await t.as(dirA).patch(A + '/locations/' + a.id, { open_time: '22:00' })).body.error, 'close_time');
  const own = await t.as(dirA).get(A + '/locations');
  assert.deepEqual(own.body.locations.map(l => l.id), [a.id]);
  const hqEdit = await t.as(hq).patch(A + '/locations/' + b.id, { name: 'Arcadia Center', timezone: 'America/Denver', geofence_m: 300 });
  assert.equal(hqEdit.status, 200);
  assert.equal(hqEdit.body.location.name, 'Arcadia Center');
  assert.equal(hqEdit.body.location.timezone, 'America/Denver');
  assert.equal((await t.as(hq).get(A + '/locations')).body.locations.length, 2);
});

test(['AC-5', 'AC-6'], 'only HQ creates locations and directors or assigns directors', async () => {
  const t = await makeApp();
  const a = t.fx.location();
  const dir = t.fx.director(a), s = t.fx.staff(a);
  const loc = { name: 'Rogue', timezone: 'America/Chicago', lat: 41.9, lng: -87.6 };
  assert.equal((await t.as(dir).post(A + '/locations', loc)).status, 403);
  assert.equal((await t.as(dir).post(A + '/directors', { name: 'Co Director', email: 'co@elite.test', location_id: a.id })).status, 403);
  assert.equal((await t.as(dir).post(A + '/directors/assign', { user_id: s.id, location_id: a.id })).status, 403);
  assert.equal((await t.as(dir).post(A + '/staff', { name: 'Not A Director', email: 'nd@elite.test', role: 'director' })).body.user.role, 'staff');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, 1);
  assert.equal(userRow(t, s.id).role, 'staff');
});

// ---------------------------------------------------------------- AC-6 role inheritance

test(['AC-6', 'AC-4'], 'roles inherit within scope: directors do staff things at their location, staff cannot do director things, HQ does everything', async () => {
  const t = await makeApp();
  const a = t.fx.location(), b = t.fx.location();
  const dirA = t.fx.director(a), staffA = t.fx.staff(a), hq = t.fx.hq();
  const fa = t.fx.family(a), fb = t.fx.family(b);
  // director inherits the staff roster at their own location
  const dr = await t.as(dirA).get(A + '/roster');
  assert.equal(dr.status, 200);
  assert.deepEqual(dr.body.students.map(s => s.id), [fa.student.id]);
  // staff do not inherit director powers
  assert.equal((await t.as(staffA).get(A + '/staff')).status, 403);
  assert.equal((await t.as(staffA).post(A + '/staff', { name: 'Self Made', email: 'sm@elite.test' })).status, 403);
  assert.equal((await t.as(staffA).post(A + '/staff/' + t.fx.staff(a).id + '/deactivate')).status, 403);
  assert.equal((await t.as(staffA).get(A + '/locations')).status, 403);
  // HQ: every location, every power
  const hr = await t.as(hq).get(A + '/roster?location_id=' + b.id);
  assert.deepEqual(hr.body.students.map(s => s.id), [fb.student.id]);
  assert.equal((await t.as(hq).get(A + '/roster')).body.students.length, 2);
  const made = await t.as(hq).post(A + '/staff', { name: 'B Staff', email: 'bstaff@elite.test', location_id: b.id });
  assert.equal(made.status, 201);
  assert.equal(made.body.user.location_id, b.id);
  assert.equal((await t.as(hq).post(A + '/staff/' + dirA.id + '/deactivate')).status, 200);
  assert.equal((await t.as(hq).get(A + '/staff?location_id=' + b.id)).body.staff.length, 1);
});

// ---------------------------------------------------------------- NF-1 roster and family scope

test(['NF-1', 'AC-6'], 'roster: staff see their own location\'s students with linked parents, never another location', async () => {
  const t = await makeApp();
  const a = t.fx.location(), b = t.fx.location();
  const staffA = t.fx.staff(a);
  const fa = t.fx.family(a, { students: 2 }), fb = t.fx.family(b);
  const second = parentAt(t, a);
  t.fx.link(second, fa.students[0]);
  const pending = await inviteStudent(t, fa.parent, { name: 'Zed Pending', phone: '555-0177' });
  const r = await t.as(staffA).get(A + '/roster');
  assert.equal(r.status, 200);
  assert.equal(r.body.location_id, a.id);
  const ids = r.body.students.map(s => s.id);
  assert.deepEqual(ids.slice().sort(), [fa.students[0].id, fa.students[1].id, pending.invite.user_id].sort());
  assert.equal(ids.includes(fb.student.id), false);
  const first = r.body.students.find(s => s.id === fa.students[0].id);
  assert.equal(first.state, 'active');
  assert.deepEqual(first.parents.map(p => p.id).sort(), [fa.parent.id, second.id].sort());
  assert.deepEqual(Object.keys(first.parents[0]).sort(), ['email', 'id', 'link_status', 'name', 'phone']);
  assert.equal(r.body.students.find(s => s.id === pending.invite.user_id).state, 'invited');
  assert.equal(JSON.stringify(r.body).includes('password'), false);
  assert.equal((await t.as(staffA).get(A + '/roster?location_id=' + b.id)).status, 403);
  assert.equal((await t.as(fa.parent).get(A + '/roster')).status, 403);
  assert.equal((await t.as(fa.student).get(A + '/roster')).status, 403);
});

test(['NF-1'], 'a parent never sees or changes another family\'s students or invites', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const pa = parentAt(t, loc), pb = parentAt(t, loc);
  const leo = await approvedStudent(t, pa, 'Leo Diaz', 'leo@kid.test');
  const inv = await inviteStudent(t, pa, { name: 'Ana Diaz', email: 'ana@kid.test' });
  const g = await inviteGuardian(t, pa, { name: 'Mark Diaz', email: 'mark@family.test' });
  const b = await t.as(pb).get(A + '/family');
  assert.deepEqual(b.body.students, []);
  assert.deepEqual(b.body.invites, []);
  assert.deepEqual(b.body.guardians.map(x => x.id), [pb.id]);
  assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
  assert.equal((await t.as(pb).post(A + '/students/' + inv.invite.user_id + '/approve')).status, 403);
  assert.equal(links(t, inv.invite.user_id)[0].status, 'pending');
  for (const id of [inv.invite.id, g.invite.id]) {
    assert.equal((await t.as(pb).post(A + '/invites/' + id + '/resend')).status, 403);
    assert.equal((await t.as(pb).post(A + '/invites/' + id + '/cancel')).status, 403);
  }
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM account_invites WHERE revoked_at IS NOT NULL').get().n, 0);
  assert.equal(userRow(t, inv.invite.user_id).active, 1);
  // students, staff and HQ have no family screen; a student cannot invite or approve
  const student = userRow(t, leo.id);
  for (const who of [student, t.fx.staff(loc), t.fx.hq()]) {
    assert.equal((await t.as(who).get(A + '/family')).status, 403);
    assert.equal((await t.as(who).post(A + '/students/invite', { name: 'Sneaky', email: 's@kid.test' })).status, 403);
    assert.equal((await t.as(who).post(A + '/students/' + inv.invite.user_id + '/approve')).status, 403);
    assert.equal((await t.as(who).post(A + '/guardians/invite', { name: 'Sneaky', email: 'sg@kid.test' })).status, 403);
  }
  assert.equal(links(t, inv.invite.user_id)[0].status, 'pending');
});

test(['NF-1'], 'every signed-in route refuses a signed-out caller, and lower roles are refused the higher routes', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const f = t.fx.family(loc);
  const staff = t.fx.staff(loc), dir = t.fx.director(loc);
  const routes = [
    ['get', '/me'], ['post', '/password'], ['get', '/family'], ['post', '/students/invite'], ['post', '/students/1/approve'],
    ['post', '/guardians/invite'], ['post', '/invites/join'], ['post', '/invites/1/resend'], ['post', '/invites/1/cancel'],
    ['get', '/roster'], ['get', '/staff'], ['post', '/staff'], ['post', '/staff/1/deactivate'], ['post', '/staff/1/reactivate'],
    ['post', '/staff/1/reset-password'], ['get', '/locations'], ['post', '/locations'], ['patch', '/locations/' + loc.id],
    ['post', '/directors'], ['post', '/directors/assign'],
  ];
  for (const [m, path] of routes) {
    const r = await t.anon[m](A + path, m === 'get' ? undefined : {});
    assert.equal(r.status, 401, m + ' ' + path);
  }
  const refused = [
    [[f.parent, f.student], [['get', '/roster'], ['get', '/staff'], ['post', '/staff'], ['get', '/locations'], ['patch', '/locations/' + loc.id], ['post', '/locations'], ['post', '/directors']]],
    [[staff], [['get', '/staff'], ['post', '/staff'], ['post', '/staff/' + staff.id + '/reset-password'], ['get', '/locations'], ['patch', '/locations/' + loc.id], ['post', '/locations'], ['post', '/directors'], ['post', '/directors/assign']]],
    [[dir], [['post', '/locations'], ['post', '/directors'], ['post', '/directors/assign'], ['post', '/invites/join'], ['get', '/family']]],
  ];
  for (const [who, list] of refused) {
    for (const u of who) {
      for (const [m, path] of list) {
        const r = await t.as(u)[m](A + path, m === 'get' ? undefined : {});
        assert.equal(r.status, 403, u.role + ' ' + m + ' ' + path);
      }
    }
  }
});

test(['NF-1', 'AC-1'], 'changing your password needs your current one', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc);
  const wrong = await t.as(p).post(A + '/password', { current_password: 'nope-nope', new_password: 'brandnew1' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'current_password');
  assert.equal((await t.as(p).post(A + '/password', { current_password: 'demo1234', new_password: 'short' })).body.error, 'new_password');
  assert.equal((await t.as(p).post(A + '/password', { current_password: 'demo1234', new_password: 'demo1234' })).body.error, 'new_password');
  assert.equal((await login(t, p.email, 'brandnew1')).status, 401);
  assert.equal((await t.as(p).post(A + '/password', { current_password: 'demo1234', new_password: 'brandnew1' })).status, 200);
  assert.equal((await login(t, p.email, 'brandnew1')).status, 200);
  assert.equal((await login(t, p.email, 'demo1234')).status, 401);
});

// ---------------------------------------------------------------- sweep 2026-10-14 (S1, S25, S12/S26, R10, R4)

test(['AC-2', 'NF-1'], 'S1: only the guardian who sent a guardian invite can resend or cancel it, so a co-guardian never gets a code that reaches the other guardian\'s own students', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const loc = t.fx.location();
  const yf = t.fx.family(loc);                     // Y and Yan
  const xf = t.fx.family(loc);                     // X and Wes, X's own family
  const y = yf.parent, x = xf.parent, wes = xf.student;
  const g = await inviteGuardian(t, y, { name: 'X', email: x.email });
  assert.equal((await t.as(x).post(A + '/invites/join', { code: g.code })).status, 200);
  assert.equal(auth.canSeeStudent(t.ctx, y, wes.id), false);    // D-24: X's own student is not shared with Y
  const zoe = await inviteGuardian(t, x, { name: 'Zoe New', email: 'zoe@example.com' });
  const hash = () => t.db.prepare('SELECT code_hash FROM account_invites WHERE id = ?').get(zoe.invite.id).code_hash;
  const before = hash();
  // Y sees X's invite on the Family screen, but can neither take a new code for it nor cancel it
  const yFam = await t.as(y).get(A + '/family');
  assert.deepEqual(yFam.body.invites.map(i => [i.id, i.invited_by]), [[zoe.invite.id, x.id]]);
  const re = await t.as(y).post(A + '/invites/' + zoe.invite.id + '/resend');
  assert.equal(re.status, 403);
  assert.equal(re.body.code, undefined);
  assert.equal((await t.as(y).post(A + '/invites/' + zoe.invite.id + '/cancel')).status, 403);
  assert.equal(hash(), before);
  assert.equal(t.db.prepare('SELECT revoked_at FROM account_invites WHERE id = ?').get(zoe.invite.id).revoked_at, null);
  // X, who sent it, still can; the guardian who accepts is linked to X's students and no one else's
  const fresh = await t.as(x).post(A + '/invites/' + zoe.invite.id + '/resend');
  assert.equal(fresh.status, 200);
  const acc = await t.anon.post(A + '/invites/accept', { code: fresh.body.code, password: 'zoepass12' });
  assert.equal(acc.status, 201);
  assert.deepEqual(auth.linkedStudentIds(t.ctx, acc.body.user.id).sort(), auth.linkedStudentIds(t.ctx, x.id).sort());
  // the same holds the other way: X can't resend or cancel an invite Y sends
  const yInv = await inviteGuardian(t, y, { name: 'Gran', email: 'gran@example.com' });
  assert.equal((await t.as(x).post(A + '/invites/' + yInv.invite.id + '/resend')).status, 403);
  assert.equal((await t.as(x).post(A + '/invites/' + yInv.invite.id + '/cancel')).status, 403);
  assert.equal((await t.as(y).post(A + '/invites/' + yInv.invite.id + '/cancel')).status, 200);
});

test(['AC-2'], 'S25: "joined your family" names only the inviter\'s students, never the joining guardian\'s own', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const a = parentAt(t, loc, { name: 'Amy Lee' });
  for (const name of ['Cal Lee', 'Ann Lee', 'Ben Lee']) t.fx.link(a, t.fx.user('student', { location: loc, name }));
  const b = parentAt(t, loc, { name: 'Bo Park' });
  t.fx.link(b, t.fx.user('student', { location: loc, name: 'Zed Park' }));
  const g = await inviteGuardian(t, a, { name: 'Bo Park', email: b.email });
  assert.equal((await t.as(b).post(A + '/invites/join', { code: g.code })).status, 200);
  const n = t.fx.notifications(a, 'account_guardian_joined');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Bo Park joined your family');
  assert.equal(n[0].body, 'They now see the same records as you for Ann, Ben and Cal.');
  assert.doesNotMatch(n[0].body, /Zed/);
  // two students read "Ann and Ben"
  const c = parentAt(t, loc);
  for (const name of ['Ann Roe', 'Ben Roe']) t.fx.link(c, t.fx.user('student', { location: loc, name }));
  const d = parentAt(t, loc);
  t.fx.link(d, t.fx.user('student', { location: loc, name: 'Dee Roe' }));
  const g2 = await inviteGuardian(t, c, { name: 'D', email: d.email });
  assert.equal((await t.as(d).post(A + '/invites/join', { code: g2.code })).status, 200);
  assert.equal(t.fx.notifications(c, 'account_guardian_joined')[0].body, 'They now see the same records as you for Ann and Ben.');
});

test(['AC-1', 'AC-3', 'NF-1'], 'S12/S26: a student invite to an email that already has an account is refused when it is made, with one neutral answer', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = parentAt(t, loc, { email: 'mom@example.com' });
  const g = await inviteGuardian(t, p, { name: 'Dad', email: 'dad@example.com' });
  const dad = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'dadpass12' })).body.user;
  const kid = await approvedStudent(t, p, 'Leo Diaz', 'leo@kid.test');
  const elsewhere = t.fx.family(t.fx.location());
  const holders = ['MOM@example.com', dad.email, kid.email, t.fx.staff(loc).email, t.fx.staff(loc, { active: 0 }).email,
    t.fx.hq().email, elsewhere.parent.email, elsewhere.student.email];
  const students = () => t.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n;
  const invites = () => t.db.prepare('SELECT COUNT(*) AS n FROM account_invites').get().n;
  const [n0, i0] = [students(), invites()];
  const answers = [];
  for (const [who, email] of holders.map(e => [p, e]).concat([[dad, 'mom@example.com']])) {
    const r = await t.as(who).post(A + '/students/invite', { name: 'Ada Diaz', email });
    answers.push({ status: r.status, body: r.body });
  }
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.deepEqual(answers[0], { status: 400, body: { error: 'email',
    message: "That email can't be used for a new student account. Enter an email only your student uses, or leave it blank and add their phone: they choose an email when they accept." } });
  assert.doesNotMatch(answers[0].body.message, /your own|staff|parent|guardian|already has|exists|taken/i);
  assert.deepEqual([students(), invites()], [n0, i0]);
  // an email a co-guardian's open guardian invite was sent to gets the same answer; once that invite is cancelled it is free
  const gran = await inviteGuardian(t, dad, { name: 'Gran', email: 'gran@example.com' });
  assert.deepEqual(await t.as(p).post(A + '/students/invite', { name: 'Ada Diaz', email: 'GRAN@example.com' })
    .then(r => ({ status: r.status, body: r.body })), answers[0]);
  assert.equal(students(), n0);
  assert.equal((await t.as(dad).post(A + '/invites/' + gran.invite.id + '/cancel')).status, 200);
  const granKid = await inviteStudent(t, p, { name: 'Gia Diaz', email: 'gran@example.com' });
  assert.equal((await t.anon.post(A + '/invites/accept', { code: granKid.code, password: 'kidpass12' })).status, 200);
  // a free email, or a phone alone, still goes through and can be accepted
  const ok = await inviteStudent(t, p, { name: 'Ada Diaz', email: 'ada@kid.test' });
  assert.equal((await t.anon.post(A + '/invites/accept', { code: ok.code, password: 'kidpass12' })).status, 200);
  const byPhone = await inviteStudent(t, p, { name: 'Bo Diaz', phone: '555-0140' });
  assert.equal((await t.anon.post(A + '/invites/accept', { code: byPhone.code, password: 'kidpass12', email: 'bo@kid.test' })).status, 200);
});

test(['NF-1', 'AC-1'], 'R10: changing a password signs out every other session of that account, and the current one stays signed in', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const f = t.fx.family(loc);
  const other = t.fx.family(loc);
  const phone = t.as(f.parent), tablet = t.as(f.parent), laptop = t.as(f.parent), theirs = t.as(other.parent);
  for (const c of [phone, tablet, laptop, theirs]) assert.equal((await c.get(A + '/family')).status, 200);
  // a refused change signs nobody out
  assert.equal((await laptop.post(A + '/password', { current_password: 'wrong-one', new_password: 'newpass12345' })).status, 400);
  assert.equal((await phone.get(A + '/family')).status, 200);
  assert.equal((await laptop.post(A + '/password', { current_password: 'demo1234', new_password: 'newpass12345' })).status, 200);
  for (const c of [phone, tablet]) {
    const r = await c.get(A + '/family');
    assert.equal(r.status, 401);
    assert.equal(JSON.stringify(r.body).includes(f.student.name), false);
  }
  assert.equal((await laptop.get(A + '/family')).status, 200);
  assert.equal((await theirs.get(A + '/family')).status, 200);
  assert.equal([...t.ctx.sessions.values()].filter(id => id === f.parent.id).length, 1);
  assert.equal((await login(t, f.parent.email, 'newpass12345')).status, 200);
});

test(['AC-5'], 'R4: location hours can\'t be changed so that an active session of a current or upcoming term falls outside them', async () => {
  const t = await makeApp();
  const a = t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' }), b = t.fx.location();
  const dir = t.fx.director(a), hq = t.fx.hq();
  const fall = t.fx.term(a);                                                   // runs through Dec 18
  t.fx.session(a, { term: fall, name: 'Morning Focus', start: '09:00', end: '11:30' });
  t.fx.session(a, { term: fall, name: 'Afternoon Study', start: '13:00', end: '16:00' });
  // none of these hold the hours back: a cancelled session, a term that has ended, another location
  const late = t.fx.session(a, { term: fall, name: 'Late Club', start: '18:00', end: '21:00' });
  t.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(late.id);
  t.fx.session(a, { term: t.fx.term(a, { name: 'Summer', start: '2026-06-01', end: '2026-10-13' }), name: 'Early Bird', start: '07:00', end: '08:00' });
  t.fx.session(b, { name: 'Dawn Patrol', start: '06:00', end: '22:00' });
  const hours = () => { const r = t.db.prepare('SELECT open_time, close_time FROM locations WHERE id = ?').get(a.id); return [r.open_time, r.close_time]; };
  const refuse = async (who, body, message) => {
    const r = await t.as(who).patch(A + '/locations/' + a.id, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(r.body.error, 'session_outside_hours');
    assert.equal(r.body.message, message);
    assert.deepEqual(hours(), ['09:00', '20:00']);
  };
  await refuse(dir, { close_time: '10:00' },
    'Morning Focus runs 9:00 AM–11:30 AM, outside 9:00 AM–10:00 AM. Choose hours that cover it, or change that session first.');
  await refuse(hq, { close_time: '15:00', geofence_m: 300 },
    'Afternoon Study runs 1:00 PM–4:00 PM, outside 9:00 AM–3:00 PM. Choose hours that cover it, or change that session first.');
  await refuse(dir, { open_time: '09:30' },
    'Morning Focus runs 9:00 AM–11:30 AM, outside 9:30 AM–8:00 PM. Choose hours that cover it, or change that session first.');
  assert.equal(t.db.prepare('SELECT geofence_m FROM locations WHERE id = ?').get(a.id).geofence_m, 150);
  assert.equal(t.fx.audit('location.update').length, 0);
  // hours that still cover every session are saved, edges included
  const ok = await t.as(dir).patch(A + '/locations/' + a.id, { open_time: '09:00', close_time: '16:00' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(hours(), ['09:00', '16:00']);
  // a term that ends today still counts
  t.fx.session(a, { term: t.fx.term(a, { name: 'Short', start: '2026-10-01', end: '2026-10-14' }), name: 'Last Day', start: '16:00', end: '17:00' });
  assert.equal((await t.as(dir).patch(A + '/locations/' + a.id, { close_time: '17:00' })).status, 200);
  const r = await t.as(dir).patch(A + '/locations/' + a.id, { close_time: '16:30' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /^Last Day runs 4:00 PM–5:00 PM/);
  // a change that leaves the hours alone is never held back
  assert.equal((await t.as(dir).patch(A + '/locations/' + a.id, { geofence_m: 200 })).status, 200);
});

// ---------------------------------------------------------------- sweep 2026-10-14, round 2

test(['AC-1', 'NF-1'], 'L53/L62: sign-up gives one neutral answer for an email in use, whoever holds it, and never says it has an account', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const fam = t.fx.family(loc);
  const holders = [fam.parent.email, fam.student.email, t.fx.staff(loc).email, t.fx.staff(loc, { active: 0 }).email,
    t.fx.director(loc).email, t.fx.hq().email, fam.parent.email.toUpperCase(), ' ' + fam.student.email.toUpperCase() + ' '];
  const users = () => t.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const n0 = users();
  const answers = [];
  for (const email of holders) {
    const r = await t.anon.post(A + '/signup', { name: 'Probe Person', email, phone: '555-0101', password: 'whatever123', location_id: loc.id });
    answers.push({ status: r.status, body: r.body, cookie: r.headers.get('set-cookie') });
  }
  // a student's, a parent's, staff, a deactivated account, a director, HQ: the same status, words and headers
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.deepEqual(answers[0], { status: 409, cookie: null, body: { error: 'email_unavailable',
    message: 'Already have an account? Sign in instead. If not, use a different email.' } });
  assert.doesNotMatch(JSON.stringify(answers[0].body), /already has|exists|taken|in use|staff|parent|student|director/i);
  assert.equal(users(), n0);
  // the same kind of answer the invite screen gives (email_unavailable), not a sign-up-only code
  const inv = await inviteStudent(t, fam.parent, { name: 'Ana Diaz', phone: '555-0102' });
  const viaInvite = await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12', email: fam.parent.email });
  assert.deepEqual([viaInvite.status, viaInvite.body.error], [answers[0].status, answers[0].body.error]);
  // a free email still signs up and signs in
  const ok = await t.anon.post(A + '/signup', { name: 'New Parent', email: 'new@family.test', phone: '555-0103', password: 'whatever123', location_id: loc.id });
  assert.equal(ok.status, 201);
  assert.match(ok.headers.get('set-cookie') || '', /sid=/);
});

test(['AC-3', 'AC-2'], 'L48: approving a student tells the other guardians, and every "accepted your invite" item about that student stops asking', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const tara = parentAt(t, loc, { name: 'Tara Okafor' });
  const g = await inviteGuardian(t, tara, { name: 'Kemi Okafor', email: 'kemi@family.test' });
  const kemi = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'kemipass1' })).body.user;
  const kids = {};
  for (const [name, email] of [['Ada Okafor', 'ada@kid.test'], ['Ben Okafor', 'ben@kid.test'], ['Cal Okafor', 'cal@kid.test']]) {
    const inv = await inviteStudent(t, tara, { name, email });
    assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
    kids[name.split(' ')[0]] = inv.invite.user_id;
  }
  const accepted = (who, sid) => t.fx.notifications(who, 'account_student_accepted').find(n => n.ref_id === sid);
  const approvedNotes = who => t.fx.notifications(who, 'account_student_approved').map(n => [n.title, n.body, n.ref_type, n.ref_id]);
  assert.equal((await t.as(tara).post(A + '/students/' + kids.Ada + '/approve')).status, 200);
  assert.equal((await t.as(kemi).post(A + '/students/' + kids.Ben + '/approve')).status, 200);
  for (const who of [tara, kemi]) {
    assert.equal(accepted(who, kids.Ada).body, "Tara Okafor approved Ada, so there's nothing left to approve.");
    assert.equal(accepted(who, kids.Ada).read_at, DEFAULT_NOW);
    assert.equal(accepted(who, kids.Ben).body, "Kemi Okafor approved Ben, so there's nothing left to approve.");
    assert.equal(accepted(who, kids.Ben).read_at, DEFAULT_NOW);
    // Cal still waits, and his item still asks
    assert.equal(accepted(who, kids.Cal).body, 'Approve Cal in Family so they can sign in to ELITE Spaces.');
    assert.equal(accepted(who, kids.Cal).read_at, null);
  }
  // the other guardian hears who approved; the one who approved does not
  assert.deepEqual(approvedNotes(kemi), [['Tara approved Ada', 'Ada can sign in to ELITE Spaces now.', 'user', kids.Ada]]);
  assert.deepEqual(approvedNotes(tara), [['Kemi approved Ben', 'Ben can sign in to ELITE Spaces now.', 'user', kids.Ben]]);
});

test(['AC-3', 'AC-2'], 'L50: only the parent who sent a student invite is told "accepted your invite"; a co-guardian reads whose invite it was', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const tara = parentAt(t, loc, { name: 'Tara Okafor' });
  const g = await inviteGuardian(t, tara, { name: 'Kemi Okafor', email: 'kemi@family.test' });
  const kemi = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'kemipass1' })).body.user;
  const ben = await inviteStudent(t, tara, { name: 'Ben Okafor', email: 'ben@kid.test' });
  const ada = await inviteStudent(t, kemi, { name: 'Ada Okafor', email: 'ada@kid.test' });
  for (const inv of [ben, ada]) assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
  const titles = who => t.fx.notifications(who, 'account_student_accepted').map(n => [n.ref_id, n.title, n.body]);
  assert.deepEqual(titles(tara), [
    [ben.invite.user_id, 'Ben accepted your invite', 'Approve Ben in Family so they can sign in to ELITE Spaces.'],
    [ada.invite.user_id, "Ada accepted Kemi's invite", 'Approve Ada in Family so they can sign in to ELITE Spaces.'],
  ]);
  assert.deepEqual(titles(kemi), [
    [ben.invite.user_id, "Ben accepted Tara's invite", 'Approve Ben in Family so they can sign in to ELITE Spaces.'],
    [ada.invite.user_id, 'Ada accepted your invite', 'Approve Ada in Family so they can sign in to ELITE Spaces.'],
  ]);
});

test(['AC-5'], 'L44: no two locations share a name, ignoring case and spaces; a location can still be renamed in another case', async () => {
  const t = await makeApp();
  const hq = t.fx.hq();
  const irvine = t.fx.location({ name: 'Irvine' });
  const old = t.fx.location({ name: 'Old Town' });
  t.db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(old.id);
  const body = name => ({ name, timezone: 'America/Los_Angeles', lat: 33, lng: -117 });
  for (const name of ['irvine ', 'Irvine', 'IRVINE', 'old town']) {
    const r = await t.as(hq).post(A + '/locations', body(name));
    assert.equal(r.status, 409, name);
    assert.equal(r.body.error, 'location_name_taken', name);
  }
  assert.equal((await t.as(hq).post(A + '/locations', body('irvine '))).body.message, "There's already a location named Irvine. Choose a different name.");
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, 2);
  const tustin = await t.as(hq).post(A + '/locations', body('Tustin'));
  assert.equal(tustin.status, 201);
  // renaming onto another location's name is refused too
  const clash = await t.as(hq).patch(A + '/locations/' + tustin.body.location.id, { name: ' irvine' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'location_name_taken');
  assert.equal(t.db.prepare('SELECT name FROM locations WHERE id = ?').get(tustin.body.location.id).name, 'Tustin');
  // its own name, in any case, is fine, and so is a save that keeps the name
  assert.equal((await t.as(hq).patch(A + '/locations/' + irvine.id, { name: 'IRVINE' })).body.location.name, 'IRVINE');
  assert.equal((await t.as(hq).patch(A + '/locations/' + irvine.id, { name: 'IRVINE', geofence_m: 300 })).status, 200);
  const names = (await t.as(hq).get(A + '/locations')).body.locations.map(l => l.name.toLowerCase());
  assert.deepEqual(names, [...new Set(names)]);
});

// ---------------------------------------------------------------- the accounts screens in a browser tab

// Just enough DOM for public/js/app.js and the accounts view: one tree under
// <html>, focus that is lost when its element leaves the page, and simple
// selectors ('tag', '#id', '.class', '[attr]', '[attr=v]', descendants, commas).
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get cls() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  get disabled() { return this.attrs.has('disabled'); }
  set disabled(v) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  get value() { return this.typed ?? this.getAttribute('value') ?? ''; }
  set value(v) { this.typed = String(v); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.doc.documentElement; }
  get firstChild() { return this.childNodes[0] || null; }
  addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
  dispatch(type, props) {
    const ev = Object.assign({ type, target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } }, props);
    for (let n = this; n && !ev.stopped; n = n.parentNode) { ev.currentTarget = n; for (const fn of n.on[type] || []) fn(ev); }
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.doc.focused = this; }
  adopt(kids) { return kids.map(k => { const n = k instanceof El ? k : new El(this.doc, null, String(k)); n.remove(); n.parentNode = this; return n; }); }
  append(...kids) { this.childNodes.push(...this.adopt(kids)); }
  appendChild(k) { this.append(k); return k; }
  prepend(...kids) { this.childNodes.unshift(...this.adopt(kids)); }
  after(...kids) { const p = this.parentNode, ns = p.adopt(kids); p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, ...ns); }
  replaceChildren(...kids) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this.append(...kids); }
  replaceWith(n) { const p = this.parentNode; n.remove(); p.childNodes[p.childNodes.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  all() { return this.childNodes.flatMap(c => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
  querySelectorAll(sel) {
    const one = part => n => !!n.tag && (part.match(/[#.]?[\w-]+|\[[^\]]+\]/g) || []).every(p => {
      if (p[0] === '#') return n.id === p.slice(1);
      if (p[0] === '.') return n.cls.includes(p.slice(1));
      if (p[0] === '[') { const [k, v] = p.slice(1, -1).split('='); return v === undefined ? n.attrs.has(k) : n.getAttribute(k) === v.replace(/^"|"$/g, ''); }
      return n.tag === p;
    });
    const chain = (roots, parts) => (parts.length ? chain(roots.flatMap(r => r.findAll(one(parts[0]))), parts.slice(1)) : roots);
    const hits = new Set(sel.split(',').flatMap(s => chain([this], s.trim().split(/\s+(?![^[]*\])/))));
    return this.all().filter(n => hits.has(n));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// One browser tab running the real shell and accounts view (read from ROOT, so the
// mutation runner's copy is the one exercised) against the test server.
function accountsTab(t) {
  let cookie = '';
  const pending = new Set();
  const doc = { title: '', hidden: false, addEventListener() {} };
  const el = (tag, id) => { const n = new El(doc, tag); if (id) n.setAttribute('id', id); return n; };
  doc.documentElement = el('html');
  doc.head = el('head');
  doc.body = el('body');
  const main = el('main', 'main');
  doc.body.append(el('div', 'topbar'), el('div', 'devbar'), el('div', 'toasts'), main, el('nav', 'nav'));
  doc.documentElement.append(doc.head, doc.body);
  Object.assign(doc, {
    createElement: tag => el(tag), createTextNode: s => new El(doc, null, String(s)),
    getElementById: id => doc.documentElement.find(n => n.id === id) || null,
    querySelector: sel => doc.documentElement.querySelector(sel),
  });
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused && doc.focused.isConnected ? doc.focused : doc.body) });
  const fetchAs = (url, opts = {}) => {
    const p = fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
      .then(async r => new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers }));
    pending.add(p);
    const done = () => pending.delete(p);
    p.then(done, done);
    return p;
  };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, URLSearchParams, console, navigator: {},
    location: { hash: '', origin: 'http://elite.test' }, history: { replaceState() {} }, addEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/accounts.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  const App = win.App;
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    App, doc, main, settle,
    async signIn(user) {
      const token = crypto.randomBytes(16).toString('hex');
      t.ctx.sessions.set(token, user.id);
      cookie = 'sid=' + token;
      App.me = await App.api.get('/api/auth/me');
    },
    // Opens a route the way the shell does, so App.refresh() redraws the same screen.
    async open(route) { win.location.hash = '#/' + route; App.refresh(); await settle(); return main; },
    async card(id) { const box = el('div'); main.replaceChildren(box); await App.cards.find(c => c.id === id).render(box); await settle(); return box; },
    // Taps `button`, then the confirm box's `confirmLabel`, and waits for the screen to redraw.
    async confirm(button, confirmLabel) {
      button.focus();
      button.click();
      const box = main.find(n => n.getAttribute('role') === 'alertdialog');
      assert.ok(box, 'a confirm box opened');
      const ok = box.find(n => n.tag === 'button' && n.textContent === confirmLabel);
      assert.ok(ok, `the confirm button says "${confirmLabel}": ` + box.findAll(n => n.tag === 'button').map(b => b.textContent).join(' | '));
      ok.click();
      await settle();
    },
  };
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const buttonsIn = root => root.findAll(n => n.tag === 'button').map(b => b.getAttribute('aria-label') || b.textContent);
const buttonNamed = (root, label) => root.find(n => n.tag === 'button' && n.textContent === label);

test(['AC-3', 'AC-2'], 'Family screen and Home card: Approve, Decline and Cancel buttons name the person, "your invite" only for the sender (L49, L50), and focus lands on the list heading after a Decline or Cancel', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const tara = parentAt(t, loc, { name: 'Tara Okafor' });
  const g = await inviteGuardian(t, tara, { name: 'Kemi Okafor', email: 'kemi@family.test' });
  const kemi = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'kemipass1' })).body.user;
  const ben = await inviteStudent(t, tara, { name: 'Ben Okafor', email: 'ben@kid.test' });
  const ada = await inviteStudent(t, kemi, { name: 'Ada Okafor', email: 'ada@kid.test' });
  for (const inv of [ben, ada]) assert.equal((await t.anon.post(A + '/invites/accept', { code: inv.code, password: 'kidpass12' })).status, 200);
  await inviteStudent(t, tara, { name: 'Cal Okafor', phone: '555-0177' });
  await inviteGuardian(t, tara, { name: 'Gina Park', email: 'gina@family.test' });
  const tab = accountsTab(t);
  await tab.signIn(tara);

  // Home: one Approve button per student, each naming that student, and whose invite it was.
  const card = await tab.card('accounts-family');
  assert.deepEqual(buttonsIn(card), ['Approve Ada', 'Approve Ben']);
  assert.deepEqual(card.findAll(n => n.tag === 'li').map(words), [
    "A Ada Okafor Accepted Kemi's invite · ada@kid.test Approve Ada",
    'B Ben Okafor Accepted your invite · ben@kid.test Approve Ben',
  ]);

  // Family: the same wording, and every Decline or Cancel names the person.
  const page = await tab.open('family');
  assert.match(words(page), /Ada accepted Kemi's invite\. Approve them so they can sign in\./);
  assert.match(words(page), /Ben accepted your invite\. Approve them so they can sign in\./);
  assert.deepEqual(buttonsIn(page).filter(b => /^(Approve|Decline|Cancel|Resend)/.test(b)),
    ['Approve Ada', 'Decline Ada', 'Approve Ben', 'Decline Ben', 'Resend', "Cancel Cal's invite", 'Resend', 'Cancel invite to Gina']);

  // Decline Ada: the row is gone and focus is on the Students heading, not the top of the page.
  await tab.confirm(buttonNamed(page, 'Decline Ada'), 'Decline Ada');
  assert.ok(!buttonNamed(tab.main, 'Approve Ada'), 'Ada is gone');
  assert.equal(tab.doc.activeElement, tab.doc.getElementById('ac-st'));
  assert.equal(tab.doc.activeElement.getAttribute('tabindex'), '-1');

  // Cancel Cal's invite: the same.
  await tab.confirm(buttonNamed(tab.main, "Cancel Cal's invite"), "Cancel Cal's invite");
  assert.ok(!buttonNamed(tab.main, "Cancel Cal's invite"));
  assert.equal(tab.doc.activeElement, tab.doc.getElementById('ac-st'));

  // Cancel the guardian invite: focus goes to the Guardians heading.
  await tab.confirm(buttonNamed(tab.main, 'Cancel invite to Gina'), 'Cancel invite to Gina');
  assert.ok(!buttonNamed(tab.main, 'Cancel invite to Gina'));
  assert.equal(tab.doc.activeElement, tab.doc.getElementById('ac-gu'));
  assert.equal(tab.doc.activeElement.getAttribute('tabindex'), '-1');
});

test(['AC-3', 'AC-4', 'AC-5'], 'Inbox: family account items open Family, a student\'s "You\'re all set" opens Home, and a new director\'s item opens Location settings', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const tara = parentAt(t, loc, { name: 'Tara Okafor' });
  const g = await inviteGuardian(t, tara, { name: 'Kemi Okafor', email: 'kemi@family.test' });
  const kemi = (await t.anon.post(A + '/invites/accept', { code: g.code, password: 'kemipass1' })).body.user;
  const ben = await approvedStudent(t, tara, 'Ben Okafor', 'ben@kid.test');
  const hq = t.fx.hq();
  const amy = t.fx.staff(loc, { name: 'Amy Chen' });
  assert.equal((await t.as(hq).post(A + '/directors/assign', { user_id: amy.id, location_id: loc.id })).status, 200);
  const tab = accountsTab(t);
  const inboxLinks = async who => {
    await tab.signIn(who);
    const page = await tab.open('inbox');
    return page.findAll(n => n.tag === 'a' && n.find(c => c.tag === 'strong')).map(a => [a.find(c => c.tag === 'strong').textContent, a.getAttribute('href')]);
  };
  assert.deepEqual(await inboxLinks(tara), [['Ben accepted your invite', '#/family'], ['Kemi Okafor joined your family', '#/family']]);
  assert.deepEqual(await inboxLinks(kemi), [['Tara approved Ben', '#/family'], ["Ben accepted Tara's invite", '#/family']]);
  assert.deepEqual(await inboxLinks(ben), [["You're all set", '#/home']]);
  assert.deepEqual(await inboxLinks(amy), [["You're now the director at Irvine", '#/people/location']]);
});

test(['AC-4', 'AC-6'], 'People: after a confirmed Deactivate, focus goes to the next person\'s row; the roster never marks a parent "(not approved yet)" (L51)', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine' });
  const dir = t.fx.director(loc, { name: 'Dana Director' });
  const [amy] = ['Amy Chen', 'Bob Diaz', 'Cara Eze'].map(name => t.fx.staff(loc, { name }));
  const kemi = parentAt(t, loc, { name: 'Kemi Okafor' });
  await inviteStudent(t, kemi, { name: 'Chidi Okafor', phone: '555-0199' });
  const tab = accountsTab(t);
  await tab.signIn(dir);

  const page = await tab.open('people/staff');
  const amyRow = page.find(n => n.tag === 'tr' && n.getAttribute('data-staff') === String(amy.id));
  await tab.confirm(amyRow.find(n => n.getAttribute('aria-label') === 'Deactivate Amy Chen'), 'Deactivate Amy');
  assert.equal(t.db.prepare('SELECT active FROM users WHERE id = ?').get(amy.id).active, 0);
  const focused = tab.doc.activeElement;
  assert.equal(focused.getAttribute('aria-label'), 'Reset password for Bob Diaz', 'focus is on the next row, not the top of the page');
  assert.ok(tab.main.contains(focused));

  // Families: the invited student's parent is just listed; the badge says what is pending.
  const roster = await tab.open('people/families');
  const row = roster.find(n => n.tag === 'tr' && /Chidi Okafor/.test(n.textContent));
  assert.match(words(row), /^Chidi Okafor 555-0199 Invited, not set up yet Kemi Okafor/);
  assert.doesNotMatch(words(row), /not approved/);
});

test(['AC-5'], 'Locations: "Make someone director" asks first, naming the location, before moving its only director away (fix list item 8)', async () => {
  const t = await makeApp();
  const hq = t.fx.hq();
  const a = t.fx.location({ name: 'Irvine' }), b = t.fx.location({ name: 'Arcadia' });
  const dana = t.fx.director(a, { name: 'Dana Park' });
  const tab = accountsTab(t);
  await tab.signIn(hq);
  const page = await tab.open('locations');
  page.find(n => n.tag === 'button' && n.getAttribute('aria-label') === 'Make someone director of Arcadia').click();
  await tab.settle();
  const form = tab.main.find(n => n.tag === 'form' && /Make director/.test(n.textContent));
  const who = form.find(n => n.tag === 'select');
  const submit = () => { who.value = String(dana.id); form.dispatch('submit'); return tab.main.find(n => n.getAttribute('role') === 'alertdialog'); };
  let box = submit();
  assert.ok(box, 'a confirm box opened');
  assert.match(words(box), /Leave Irvine with no director\?/);
  assert.match(words(box), /Dana Park is the only director at Irvine/);
  assert.deepEqual(box.findAll(n => n.tag === 'button').map(n => n.textContent), ['Keep Dana Park at Irvine', 'Move Dana Park to Arcadia']);
  box.findAll(n => n.tag === 'button')[0].click();
  await tab.settle();
  assert.equal(userRow(t, dana.id).location_id, a.id, 'keeping her moves nobody');
  box = submit();
  box.findAll(n => n.tag === 'button')[1].click();
  await tab.settle();
  assert.equal(userRow(t, dana.id).location_id, b.id);
  assert.match(tab.doc.getElementById('toasts').textContent, /Dana Park now leads Arcadia\. Irvine has no director now\./);
});
