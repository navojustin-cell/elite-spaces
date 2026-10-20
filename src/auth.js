'use strict';
// Logins, sessions and the role/scope rules every module uses.
//
// Roles: student, parent (family side); staff < director < hq (operations side).
// Within its scope each operations role inherits the one below it.
// Scope: staff and directors see one location; hq sees all; families see only
// their own linked students.

const crypto = require('crypto');
const { forbidden, AppError } = require('./errors');

const OPS_RANK = { staff: 1, director: 2, hq: 3 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

// true when user's role is `role` or above it on the operations ladder.
function atLeast(user, role) {
  return !!user && (OPS_RANK[user.role] || 0) >= OPS_RANK[role];
}

function getUser(ctx, id) {
  return ctx.db.prepare('SELECT id, role, name, email, phone, location_id, active FROM users WHERE id = ?').get(id);
}

// A student may use the app only once a parent has approved the link.
function studentLinked(ctx, studentId) {
  return !!ctx.db.prepare("SELECT 1 FROM family_links WHERE student_id = ? AND status = 'active'").get(studentId);
}

function linkedStudentIds(ctx, parentId) {
  return ctx.db.prepare("SELECT student_id FROM family_links WHERE parent_id = ? AND status = 'active'")
    .all(parentId).map(r => r.student_id);
}

function canManageLocation(user, locationId) {
  if (!user) return false;
  if (user.role === 'hq') return true;
  return atLeast(user, 'staff') && user.location_id === Number(locationId);
}

// Who may see a student's records: the student, an active linked parent,
// staff/director at the student's home location, and hq.
function canSeeStudent(ctx, user, studentId) {
  studentId = Number(studentId);
  if (!user) return false;
  if (user.role === 'hq') return true;
  if (user.role === 'student') return user.id === studentId;
  if (user.role === 'parent') return linkedStudentIds(ctx, user.id).includes(studentId);
  const s = getUser(ctx, studentId);
  return !!s && s.role === 'student' && atLeast(user, 'staff') && s.location_id === user.location_id;
}

function assertSeeStudent(ctx, user, studentId) {
  if (!canSeeStudent(ctx, user, studentId)) throw forbidden();
}
function assertManageLocation(user, locationId) {
  if (!canManageLocation(user, locationId)) throw forbidden();
}

function login(ctx, email, password) {
  const row = ctx.db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || ''));
  if (!row || !verifyPassword(password, row.password_hash)) throw new AppError(401, 'bad_login', 'Email or password is incorrect.');
  if (!row.active) throw new AppError(403, 'inactive', 'This account is not active.');
  if (row.role === 'student' && !studentLinked(ctx, row.id)) {
    throw new AppError(403, 'link_pending', 'A parent needs to approve your account before you can sign in.');
  }
  return { user: getUser(ctx, row.id) };
}

// The sign-in cookie's options. Over HTTPS (req.secure, which trusts the
// hosting proxy's X-Forwarded-Proto) it is Secure, so it never travels over plain HTTP.
const cookieOptions = req => Object.assign({ httpOnly: true, sameSite: 'lax' }, req && req.secure ? { secure: true } : {});

// Signs `userId` in on this response: a new session token in the sign-in
// cookie (ctx.cookieName). Login, demo sign-in, family sign-up and invite
// acceptance all use this one helper. The returned token is for the server
// only; responses never echo it (L64).
function startSession(ctx, res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  ctx.sessions.set(token, userId);
  res.cookie(ctx.cookieName || 'sid', token, cookieOptions(res.req));
  return token;
}

// Signs `userId` out of every session except `keepToken` (R10: changing a
// password signs out the account's other devices; the current one stays).
function endOtherSessions(ctx, userId, keepToken) {
  for (const [token, uid] of ctx.sessions) if (uid === userId && token !== keepToken) ctx.sessions.delete(token);
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The caller's session token: the sign-in cookie, or an Authorization: Bearer header.
const sessionToken = (ctx, req) =>
  parseCookies(req.headers.cookie)[ctx.cookieName || 'sid'] || (req.headers.authorization || '').replace(/^Bearer /, '');

// Express middleware: sets req.user (or leaves it undefined).
function attachUser(ctx) {
  return (req, _res, next) => {
    const token = sessionToken(ctx, req);
    const id = token && ctx.sessions.get(token);
    const u = id && getUser(ctx, id);
    if (u && u.active && (u.role !== 'student' || studentLinked(ctx, u.id))) req.user = u;
    next();
  };
}

// requireRole() = any signed-in user; requireRole('parent','student') = those
// roles; requireRole('staff') = staff or above (director, hq).
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError(401, 'signin', 'Please sign in.'));
    if (!roles.length) return next();
    const ok = roles.some(r => (OPS_RANK[r] ? atLeast(req.user, r) : req.user.role === r));
    next(ok ? undefined : forbidden());
  };
}

module.exports = {
  OPS_RANK, hashPassword, verifyPassword, atLeast, getUser, studentLinked, linkedStudentIds,
  canManageLocation, canSeeStudent, assertSeeStudent, assertManageLocation, login, startSession, cookieOptions, endOtherSessions, sessionToken,
  attachUser, requireRole,
};
