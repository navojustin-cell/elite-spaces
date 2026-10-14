'use strict';
// Family accounts (AC-1, AC-2, AC-3; decisions D-20):
// parent sign-up, student and guardian invites, invite acceptance, and the
// parent's approval that lets a student sign in.
//
// Public (no sign-in):
//   GET  /public/locations        names of active locations, for the sign-up picker
//   POST /signup                  { name, email, phone, password, location_id } -> parent account, signed in
//   GET  /invites/:code           what an invite is for (email masked)
//   POST /invites/accept          { code, password, email?, name?, phone? }
//                                 student: sets their password; the link stays pending until a parent approves.
//                                 On a phone-only invite they add an email, which can't be one another open invite holds
//                                 guardian: creates their parent account, linked to the family's students, signed in
// Parent:
//   GET  /family                  my students (with link state), my co-guardians and their open invites
//   POST /students/invite         { name, email?, phone? } -> pending student, pending links for me and my
//                                 co-guardians (see coGuardians), one-time code; refused while one of my
//                                 students already has an open invite to that email (use resend)
//   POST /students/:id/approve    activate a student who accepted their invite
//   POST /guardians/invite        { name, email } -> one-time code for a second guardian; refused for my own
//                                 student's email, a co-guardian's, or while the family has an open invite to that email
//   POST /invites/join            { code } -> an existing parent joins the family the invite came from
//   POST /invites/:id/resend      new code and expiry; the old code stops working
//   POST /invites/:id/cancel      the code stops working; a pending student is removed. For a student who
//                                 already accepted (a decline), the other parents are told and the
//                                 "accepted your invite" inbox items stop asking for approval
// Anyone signed in:
//   GET  /me                      { temp_password } - still using a password someone else set?
//   POST /password                { current_password, new_password }

const { tx } = require('../../db');
const auth = require('../../auth');
const notify = require('../../notify');
const { AppError, bad, forbidden, notFound, conflict } = require('../../errors');
const u = require('./util');

const INVITE_MS = 7 * 24 * 3600 * 1000;

// ---------- co-guardians ----------

// A parent's co-guardians: parentId itself plus the parents joined to them by
// an accepted guardian invite, in either direction. This one set decides who a
// new student is linked to, who the Family screen lists and whose invites a
// parent may manage. Only direct invites count, never a shared student: if X
// belongs to two families (with an ex, Y, through a student they share, and
// with a new partner, Z, through an invite), X's new student is shared with Z
// but not Y, and Z's new students never reach Y.
function coGuardians(db, parentId) {
  const rows = db.prepare(`SELECT invited_by AS id FROM account_invites WHERE kind = 'guardian' AND accepted_at IS NOT NULL AND user_id = ?1
    UNION SELECT user_id FROM account_invites WHERE kind = 'guardian' AND accepted_at IS NOT NULL AND invited_by = ?1 AND user_id IS NOT NULL`)
    .all(parentId);
  return [...new Set([parentId, ...rows.map(r => r.id)])];
}

const activeParents = (db, ids) => ids.filter(id => db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'parent' AND active = 1").get(id));

// ---------- invites ----------

function inviteOut(row, now) {
  return {
    id: row.id, kind: row.kind, name: row.name, email: row.email, phone: row.phone, user_id: row.user_id,
    invited_by: row.invited_by, created_at: row.created_at, expires_at: row.expires_at, expired: row.expires_at <= now,
    accepted_at: row.accepted_at,
  };
}

function createInvite(ctx, { kind, by, userId = null, name, email = null, phone = null }) {
  const code = u.newCode();
  const now = ctx.clock.now();
  const id = Number(ctx.db.prepare(`INSERT INTO account_invites (kind, invited_by, user_id, name, email, phone, code_hash, created_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(kind, by, userId, name, email, phone, u.hashCode(code), now, now + INVITE_MS).lastInsertRowid);
  const row = ctx.db.prepare('SELECT * FROM account_invites WHERE id = ?').get(id);
  return { invite: inviteOut(row, now), code, link: '/#/invite/' + code };
}

// An invite this family already has out to `addr` that is neither used nor
// cancelled (expired ones too: their card still offers a new code). A second
// one would mean a second card and a second working code. Guardian invites
// count across co-guardians, like the Family screen's list; student invites
// count for students linked to this parent. Phone numbers are not compared:
// siblings may share one.
function openInviteTo(db, parentId, kind, addr) {
  if (!addr) return null;
  if (kind === 'student') {
    return db.prepare(`SELECT i.* FROM account_invites i JOIN family_links fl ON fl.student_id = i.user_id AND fl.parent_id = ?1
      WHERE i.kind = 'student' AND i.email = ?2 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.id LIMIT 1`).get(parentId, addr);
  }
  const fam = coGuardians(db, parentId);
  return db.prepare(`SELECT * FROM account_invites WHERE kind = 'guardian' AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
    AND invited_by IN (${fam.map(() => '?').join(',')}) ORDER BY id LIMIT 1`).get(addr, ...fam);
}
// Whether an invite other than `exceptId` that is neither used nor cancelled was
// sent to `addr`, from any family. A student who picks their own email on a
// phone-only invite may not take it: that other invite could never be used.
const inviteHolds = (db, addr, exceptId) => !!db.prepare(`SELECT 1 FROM account_invites
  WHERE email = ? AND id != ? AND accepted_at IS NULL AND revoked_at IS NULL`).get(addr, exceptId);

const alreadyInvited = (row, now) => conflict('invite_pending',
  `${u.firstName(row.name)} already has an invite at that email. Use ${row.expires_at <= now ? 'Send a new code' : 'Resend'} on that invite instead of sending another.`);

// One answer for an email someone already uses, whoever that is, so an invite
// code can't be used to find out which addresses have accounts.
const emailUnavailable = fixed => conflict('email_unavailable', 'Already have an account? Sign in first, then open this invite again. '
  + (fixed ? 'If not, ask for a new invite to a different email.' : 'If not, use a different email.'));

const invalidInvite = () => new AppError(404, 'invite_invalid', "That invite code isn't valid. Check it and try again, or ask for a new invite.");

// An invite that can still be used, found by its code.
function openInvite(ctx, code) {
  const row = ctx.db.prepare('SELECT * FROM account_invites WHERE code_hash = ?').get(u.hashCode(code));
  if (!row || row.revoked_at || !u.normCode(code)) throw invalidInvite();
  const by = auth.getUser(ctx, row.invited_by);
  if (!by || !by.active) throw invalidInvite();
  if (row.accepted_at) throw new AppError(410, 'invite_used', 'This invite has already been used. Sign in instead.');
  if (row.expires_at <= ctx.clock.now()) {
    throw new AppError(410, 'invite_expired', `This invite has expired. Ask ${u.firstName(by.name)} to send you a new one.`);
  }
  return { row, by };
}

// An invite the calling parent may resend or cancel: a student invite for a
// student they are linked to, or a guardian invite sent by them or a co-guardian.
function managedInvite(ctx, user, id) {
  const row = ctx.db.prepare('SELECT * FROM account_invites WHERE id = ? AND revoked_at IS NULL').get(Number(id) || 0);
  if (!row) throw notFound('That invite no longer exists.');
  const ours = row.kind === 'student'
    ? !!ctx.db.prepare('SELECT 1 FROM family_links WHERE parent_id = ? AND student_id = ?').get(user.id, row.user_id)
    : coGuardians(ctx.db, user.id).includes(row.invited_by);
  if (!ours) throw forbidden();
  return row;
}

// Link `parentId` to every student of the parent who sent `inv`, in the same
// state: approved students stay approved, pending ones stay pending.
function joinFamily(ctx, inv, parentId) {
  const db = ctx.db;
  const now = ctx.clock.now();
  const kids = db.prepare(`SELECT fl.student_id, fl.status FROM family_links fl JOIN users s ON s.id = fl.student_id
    WHERE s.active = 1 AND fl.parent_id = ?`).all(inv.invited_by);
  const link = db.prepare(`INSERT INTO family_links (parent_id, student_id, status, created_at, approved_at) VALUES (?,?,?,?,?)
    ON CONFLICT(parent_id, student_id) DO UPDATE SET status = CASE WHEN excluded.status = 'active' THEN 'active' ELSE family_links.status END,
    approved_at = COALESCE(family_links.approved_at, excluded.approved_at)`);
  for (const k of kids) link.run(parentId, k.student_id, k.status, now, k.status === 'active' ? now : null);
  db.prepare('UPDATE account_invites SET accepted_at = ?, user_id = ? WHERE id = ?').run(now, parentId, inv.id);
  return kids.length;
}

function notifyJoined(ctx, inv, guardian) {
  const names = ctx.db.prepare(`SELECT s.name FROM family_links fl JOIN users s ON s.id = fl.student_id
    WHERE fl.parent_id = ? AND s.active = 1 ORDER BY s.name`).all(guardian.id).map(r => u.firstName(r.name));
  notify.send(ctx, [inv.invited_by], {
    kind: 'account_guardian_joined', title: `${guardian.name} joined your family`,
    body: names.length ? `They now see the same records as you for ${names.join(' and ')}.` : 'They will see every student you add.',
    refType: 'user', refId: guardian.id,
  });
}

function acceptStudent(ctx, row, body, pw) {
  const db = ctx.db;
  const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student' AND active = 1").get(row.user_id);
  if (!student) throw invalidInvite();
  const addr = row.email || u.email(body.email);
  if (u.emailTaken(db, addr, student.id)) throw emailUnavailable(!!row.email);
  if (!row.email && inviteHolds(db, addr, row.id)) throw emailUnavailable(false);
  const now = ctx.clock.now();
  tx(db, () => {
    db.prepare('UPDATE users SET password_hash = ?, email = ? WHERE id = ?').run(auth.hashPassword(pw), addr, student.id);
    db.prepare('UPDATE account_invites SET accepted_at = ? WHERE id = ?').run(now, row.id);
  });
  const parents = db.prepare("SELECT parent_id FROM family_links WHERE student_id = ? AND status = 'pending'").all(student.id).map(r => r.parent_id);
  const first = u.firstName(student.name);
  notify.send(ctx, parents, {
    kind: 'account_student_accepted', title: `${first} accepted your invite`,
    body: `Approve ${first} in Family so they can sign in to ELITE Spaces.`, refType: 'user', refId: student.id,
  });
  return { kind: 'student', status: 'awaiting_approval', name: student.name, email: addr };
}

function acceptGuardian(ctx, row, by, body, pw) {
  const db = ctx.db;
  if (u.emailTaken(db, row.email)) throw emailUnavailable(true);
  const name = body.name == null || String(body.name).trim() === '' ? row.name : u.text(body.name, 'name', 'your name');
  const phone = u.phone(body.phone);
  const id = tx(db, () => {
    const id = Number(db.prepare(`INSERT INTO users (role, name, email, phone, password_hash, location_id, created_at)
      VALUES ('parent',?,?,?,?,?,?)`).run(name, row.email, phone, auth.hashPassword(pw), by.location_id, ctx.clock.now()).lastInsertRowid);
    joinFamily(ctx, row, id);
    return id;
  });
  const user = auth.getUser(ctx, id);
  notifyJoined(ctx, row, user);
  return { kind: 'guardian', user };
}

// ---------- the parent's family screen ----------

function familyView(ctx, user) {
  const db = ctx.db;
  const now = ctx.clock.now();
  const fam = coGuardians(db, user.id);
  const inList = fam.map(() => '?').join(',');
  const students = db.prepare(`SELECT s.id, s.name, s.email, s.phone, s.location_id, fl.status AS link_status, fl.approved_at,
      s.password_hash IS NOT NULL AS accepted
    FROM family_links fl JOIN users s ON s.id = fl.student_id
    WHERE fl.parent_id = ? AND s.role = 'student' AND s.active = 1 ORDER BY s.name, s.id`).all(user.id);
  const lastInvite = db.prepare("SELECT * FROM account_invites WHERE kind = 'student' AND user_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1");
  for (const s of students) {
    const inv = lastInvite.get(s.id);
    s.accepted = !!s.accepted;
    s.invite = inv ? inviteOut(inv, now) : null;
    s.state = s.link_status === 'active' ? 'active'
      : s.accepted ? 'awaiting_approval'
        : s.invite && s.invite.expired ? 'invite_expired' : 'invited';
  }
  const guardians = db.prepare(`SELECT id, name, email, phone FROM users
    WHERE id IN (${inList}) AND role = 'parent' AND active = 1 ORDER BY name`).all(...fam)
    .map(g => Object.assign(g, { you: g.id === user.id }));
  const invites = db.prepare(`SELECT * FROM account_invites WHERE kind = 'guardian' AND invited_by IN (${inList})
    AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY id`).all(...fam).map(r => inviteOut(r, now));
  const location = user.location_id ? db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(user.location_id) : null;
  return { students, guardians, invites, location };
}

// ---------- routes ----------

function routes(r, ctx) {
  const db = ctx.db;

  r.get('/public/locations', (_req, res) => {
    res.json({ locations: db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY name').all() });
  });

  r.post('/signup', (req, res) => {
    const b = req.body || {};
    const name = u.text(b.name, 'name', 'your name');
    const addr = u.email(b.email);
    const phone = u.phone(b.phone, true);
    const pw = u.password(b.password);
    const loc = db.prepare('SELECT id FROM locations WHERE id = ? AND active = 1').get(Number(b.location_id) || 0);
    if (!loc) throw bad('location', 'Choose your home location.');
    if (u.emailTaken(db, addr)) throw conflict('email_taken', 'That email already has an account. Sign in instead, or use a different email.');
    const id = Number(db.prepare(`INSERT INTO users (role, name, email, phone, password_hash, location_id, created_at)
      VALUES ('parent',?,?,?,?,?,?)`).run(name, addr, phone, auth.hashPassword(pw), loc.id, ctx.clock.now()).lastInsertRowid);
    const token = auth.startSession(ctx, res, id);
    res.status(201).json({ user: auth.getUser(ctx, id), token });
  });

  r.get('/invites/:code', (req, res) => {
    const { row, by } = openInvite(ctx, req.params.code);
    const loc = by.location_id && db.prepare('SELECT name FROM locations WHERE id = ?').get(by.location_id);
    res.json({ invite: {
      kind: row.kind, name: row.name, invited_by: by.name, location: loc ? loc.name : null,
      email: u.maskEmail(row.email), phone: u.maskPhone(row.phone),
      needs_email: row.kind === 'student' && !row.email, expires_at: row.expires_at,
    } });
  });

  r.post('/invites/accept', (req, res) => {
    const b = req.body || {};
    const { row, by } = openInvite(ctx, b.code);
    const pw = u.password(b.password);
    if (row.kind === 'student') return res.json(acceptStudent(ctx, row, b, pw));
    const out = acceptGuardian(ctx, row, by, b, pw);
    out.token = auth.startSession(ctx, res, out.user.id);
    res.status(201).json(out);
  });

  r.post('/invites/join', auth.requireRole('parent'), (req, res) => {
    const { row, by } = openInvite(ctx, (req.body || {}).code);
    if (row.kind !== 'guardian') throw bad('invite_kind', 'That is a student invite. Your student accepts it on their own phone.');
    if (String(row.email).toLowerCase() !== String(req.user.email || '').toLowerCase()) {
      throw new AppError(403, 'invite_mismatch',
        `This invite was sent to ${u.maskEmail(row.email)}. Sign in with that address, or ask ${u.firstName(by.name)} to resend it.`);
    }
    if (coGuardians(db, row.invited_by).includes(req.user.id)) throw conflict('already_family', "You're already part of this family.");
    tx(db, () => joinFamily(ctx, row, req.user.id));
    notifyJoined(ctx, row, req.user);
    res.json(familyView(ctx, req.user));
  });

  r.get('/family', auth.requireRole('parent'), (req, res) => res.json(familyView(ctx, req.user)));

  r.post('/students/invite', auth.requireRole('parent'), (req, res) => {
    const b = req.body || {};
    const name = u.text(b.name, 'name', "your student's name");
    const addr = u.email(b.email, false);
    const phone = u.phone(b.phone);
    if (!addr && !phone) throw bad('contact', 'Add an email or a phone number so you can send the invite.');
    if (!req.user.location_id) throw bad('location', 'Your account has no home location yet. Ask the front desk to set it.');
    const twinStudent = openInviteTo(db, req.user.id, 'student', addr);
    if (twinStudent) throw alreadyInvited(twinStudent, ctx.clock.now());
    const parents = activeParents(db, coGuardians(db, req.user.id));
    const out = tx(db, () => {
      const now = ctx.clock.now();
      // A student account with no password: nobody can sign in to it yet (AC-3).
      const sid = Number(db.prepare(`INSERT INTO users (role, name, email, phone, password_hash, location_id, created_at)
        VALUES ('student',?,NULL,?,NULL,?,?)`).run(name, phone, req.user.location_id, now).lastInsertRowid);
      const link = db.prepare(`INSERT INTO family_links (parent_id, student_id, status, created_at) VALUES (?, ?, 'pending', ?)`);
      for (const pid of parents) link.run(pid, sid, now);
      return createInvite(ctx, { kind: 'student', by: req.user.id, userId: sid, name, email: addr, phone });
    });
    res.status(201).json(out);
  });

  r.post('/students/:id/approve', auth.requireRole('parent'), (req, res) => {
    const sid = Number(req.params.id) || 0;
    const mine = db.prepare('SELECT status FROM family_links WHERE parent_id = ? AND student_id = ?').get(req.user.id, sid);
    if (!mine) throw forbidden();
    const student = db.prepare("SELECT id, name, password_hash FROM users WHERE id = ? AND role = 'student' AND active = 1").get(sid);
    if (!student) throw notFound('That student is no longer on your account.');
    const first = u.firstName(student.name);
    if (mine.status === 'active') throw conflict('already_active', `${first} is already approved and can sign in.`);
    if (!student.password_hash) {
      throw conflict('not_accepted', `${first} hasn't accepted the invite yet. Share the invite code so they can set a password first.`);
    }
    const now = ctx.clock.now();
    db.prepare("UPDATE family_links SET status = 'active', approved_at = ? WHERE student_id = ? AND status = 'pending'").run(now, sid);
    notify.send(ctx, [sid], {
      kind: 'account_approved', title: "You're all set",
      body: `${u.firstName(req.user.name)} approved your account. Welcome to ELITE Spaces.`, refType: 'user', refId: sid,
    });
    res.json({ ok: true, student: { id: sid, name: student.name, state: 'active' } });
  });

  r.post('/guardians/invite', auth.requireRole('parent'), (req, res) => {
    const b = req.body || {};
    const name = u.text(b.name, 'name', "the guardian's name");
    const addr = u.email(b.email);
    if (addr === String(req.user.email || '').toLowerCase()) throw bad('email', "That's your own email. Enter the other guardian's email.");
    // A student's email can never sign in as a parent, so that invite could never be used.
    const kid = db.prepare(`SELECT s.name FROM family_links fl JOIN users s ON s.id = fl.student_id
      WHERE fl.parent_id = ?1 AND s.role = 'student' AND s.active = 1 AND (s.email = ?2 OR EXISTS (SELECT 1 FROM account_invites i
        WHERE i.kind = 'student' AND i.user_id = s.id AND i.revoked_at IS NULL AND i.email = ?2)) LIMIT 1`).get(req.user.id, addr);
    if (kid) throw bad('email', `That's the email for ${u.firstName(kid.name)}, a student on your account. Enter the guardian's own email.`);
    // A co-guardian can't accept or join again, so that invite could never be used.
    const fam = coGuardians(db, req.user.id);
    const member = db.prepare(`SELECT name FROM users WHERE lower(email) = ? AND id IN (${fam.map(() => '?').join(',')})`).get(addr, ...fam);
    if (member) throw conflict('already_family', `${member.name} is already in your family.`);
    const twinGuardian = openInviteTo(db, req.user.id, 'guardian', addr);
    if (twinGuardian) throw alreadyInvited(twinGuardian, ctx.clock.now());
    res.status(201).json(createInvite(ctx, { kind: 'guardian', by: req.user.id, name, email: addr }));
  });

  r.post('/invites/:id/resend', auth.requireRole('parent'), (req, res) => {
    const row = managedInvite(ctx, req.user, req.params.id);
    if (row.accepted_at) throw conflict('invite_used', 'This invite was already accepted, so there is nothing to resend.');
    const code = u.newCode();
    const now = ctx.clock.now();
    db.prepare('UPDATE account_invites SET code_hash = ?, created_at = ?, expires_at = ? WHERE id = ?')
      .run(u.hashCode(code), now, now + INVITE_MS, row.id);
    const fresh = db.prepare('SELECT * FROM account_invites WHERE id = ?').get(row.id);
    res.json({ invite: inviteOut(fresh, now), code, link: '/#/invite/' + code });
  });

  r.post('/invites/:id/cancel', auth.requireRole('parent'), (req, res) => {
    const row = managedInvite(ctx, req.user, req.params.id);
    if (row.kind === 'guardian' && row.accepted_at) throw conflict('invite_used', 'This guardian already joined, so the invite cannot be cancelled.');
    if (row.kind === 'student' && auth.studentLinked(ctx, row.user_id)) {
      throw conflict('already_active', `${u.firstName(row.name)} is already approved, so there is no invite to cancel.`);
    }
    // Declining: the student already accepted, so their parents were asked to approve them.
    const declined = row.kind === 'student' && !!row.accepted_at;
    const first = u.firstName(row.name);
    const now = ctx.clock.now();
    const others = declined ? activeParents(db, db.prepare("SELECT parent_id FROM family_links WHERE student_id = ? AND status = 'pending'")
      .all(row.user_id).map(r => r.parent_id).filter(id => id !== req.user.id)) : [];
    tx(db, () => {
      db.prepare('UPDATE account_invites SET revoked_at = ? WHERE id = ?').run(now, row.id);
      if (row.kind === 'student') {
        // The pending student never got access; retire the account so nobody can finish it.
        db.prepare("DELETE FROM family_links WHERE student_id = ? AND status = 'pending'").run(row.user_id);
        db.prepare('UPDATE users SET active = 0, email = NULL, password_hash = NULL WHERE id = ?').run(row.user_id);
      }
      if (declined) {
        // The "accepted your invite" items stop asking anyone to approve.
        db.prepare(`UPDATE notifications SET body = ?, read_at = COALESCE(read_at, ?)
          WHERE kind = 'account_student_accepted' AND ref_type = 'user' AND ref_id = ?`)
          .run(`${req.user.name} declined ${first}, so there's nothing to approve.`, now, row.user_id);
      }
    });
    if (declined) {
      notify.send(ctx, others, {
        kind: 'account_student_declined', title: `${u.firstName(req.user.name)} declined ${first}`,
        body: `${first}'s account wasn't created, and the invite code no longer works.`, refType: 'user', refId: row.user_id,
      });
    }
    res.json({ ok: true });
  });

  r.get('/me', auth.requireRole(), (req, res) => {
    const temp = !!db.prepare('SELECT 1 FROM account_temp_passwords WHERE user_id = ?').get(req.user.id);
    res.json({ user: req.user, temp_password: temp });
  });

  r.post('/password', auth.requireRole(), (req, res) => {
    const b = req.body || {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(b.current_password ?? ''), row.password_hash)) {
      throw bad('current_password', 'Your current password is incorrect.');
    }
    const pw = u.password(b.new_password, 'new_password');
    if (pw === String(b.current_password)) throw bad('new_password', 'Choose a password different from your current one.');
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), req.user.id);
      db.prepare('DELETE FROM account_temp_passwords WHERE user_id = ?').run(req.user.id);
    });
    res.json({ ok: true });
  });
}

module.exports = { routes, coGuardians };
