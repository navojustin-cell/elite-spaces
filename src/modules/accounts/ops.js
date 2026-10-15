'use strict';
// Operations accounts (AC-4, AC-5, AC-6; decisions D-5, D-21).
// Directors manage staff at their own location; HQ creates locations and
// directors anywhere. Each role inherits the one below it within its scope.
//
//   GET   /roster                      staff+: students at my location with their parents (HQ: ?location_id or all)
//   GET   /staff                       director+: staff and directors (director: own location; HQ: ?location_id or all)
//   POST  /staff                       director+: { name, email, phone?, location_id? } -> staff + temporary password (shown once)
//   POST  /staff/:id/deactivate        director+: staff at my location (HQ: staff or directors anywhere)
//   POST  /staff/:id/reactivate        same scope
//   POST  /staff/:id/reset-password    same scope -> new temporary password (shown once)
//   GET   /locations                   director+: my location (HQ: all), with its directors
//   POST  /locations                   HQ: create a location
//   PATCH /locations/:id               HQ: any field; director: own location's radius, QR time and hours only (D-5).
//                                      New hours must still cover every active session of a term that hasn't ended (R4)
//   POST  /directors                   HQ: { name, email, phone?, location_id } -> director + temporary password
//   POST  /directors/assign            HQ: { user_id, location_id } -> make an existing staff member or director the director there

const crypto = require('crypto');
const { tx } = require('../../db');
const auth = require('../../auth');
const notify = require('../../notify');
const audit = require('../../audit');
const time = require('../../time');
const { bad, forbidden, notFound, conflict } = require('../../errors');
const u = require('./util');

const LOC_COLS = 'id, name, timezone, address, lat, lng, geofence_m, qr_rotate_at, open_time, close_time, active, created_at';
const DIRECTOR_FIELDS = ['geofence_m', 'qr_rotate_at', 'open_time', 'close_time'];
const HQ_FIELDS = ['name', 'timezone', 'address', 'lat', 'lng', 'active'];

// The location a request is about. HQ: the one asked for, or null for all.
// Everyone else: their own, and asking for another one is refused (NF-1).
function scopeLocation(ctx, user, raw) {
  const id = raw == null || raw === '' || raw === 'all' ? null : Number(raw);
  if (id != null && !ctx.db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id)) throw notFound('No such location.');
  if (id != null && !auth.canManageLocation(user, id)) throw forbidden('You can only see your own location.');
  return id ?? (user.role === 'hq' ? null : user.location_id);
}

// A staff member or director the caller may manage (AC-4): directors manage
// staff at their own location; HQ manages staff and directors anywhere.
function managedStaff(ctx, actor, id) {
  const t = ctx.db.prepare("SELECT id, role, name, email, location_id, active FROM users WHERE id = ? AND role IN ('staff','director')").get(Number(id) || 0);
  if (!t) throw notFound('No such staff member.');
  if (t.id === actor.id) throw bad('self', "You can't change your own account here.");
  if (actor.role === 'hq') return t;
  if (t.role !== 'staff') throw forbidden("Only HQ can change a director's account.");
  if (t.location_id !== actor.location_id) throw forbidden('That person works at another location.');
  return t;
}

const staffRows = (db, locId) => db.prepare(`SELECT u.id, u.role, u.name, u.email, u.phone, u.location_id, u.active,
    l.name AS location_name, (t.user_id IS NOT NULL) AS temp_password
  FROM users u LEFT JOIN locations l ON l.id = u.location_id LEFT JOIN account_temp_passwords t ON t.user_id = u.id
  WHERE u.role IN ('staff','director') AND (? IS NULL OR u.location_id = ?)
  ORDER BY u.active DESC, l.name, CASE u.role WHEN 'director' THEN 0 ELSE 1 END, u.name`).all(locId, locId)
  .map(r => Object.assign(r, { temp_password: !!r.temp_password }));

// Creates a staff member or director with a temporary password, returned once (D-21).
function createOpsUser(ctx, actor, role, b, locId) {
  const db = ctx.db;
  const name = u.text(b.name, 'name', 'their name');
  const addr = u.email(b.email);
  const phone = u.phone(b.phone);
  if (u.emailTaken(db, addr)) throw conflict('email_taken', 'That email already has an ELITE Spaces account.');
  const pw = u.tempPassword();
  const id = tx(db, () => {
    const now = ctx.clock.now();
    const id = Number(db.prepare('INSERT INTO users (role, name, email, phone, password_hash, location_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(role, name, addr, phone, auth.hashPassword(pw), locId, now).lastInsertRowid);
    db.prepare('INSERT INTO account_temp_passwords (user_id, set_by, created_at) VALUES (?,?,?)').run(id, actor.id, now);
    audit.log(ctx, actor, role + '.create', { targetType: 'user', targetId: id, locationId: locId, detail: { name, email: addr } });
    return id;
  });
  return { user: auth.getUser(ctx, id), temp_password: pw };
}

// Validated location fields from a request body. `cur` is the stored row when
// editing (missing fields keep their value) or null when creating.
function locationFields(b, cur) {
  const has = k => b[k] !== undefined;
  const pick = (k, fn) => (has(k) ? fn(b[k]) : cur ? cur[k] : undefined);
  const out = {
    name: pick('name', v => u.text(v, 'name', 'a location name')),
    timezone: pick('timezone', u.timezone),
    address: pick('address', v => u.optText(v, 'address', 'the address', 200)),
    lat: pick('lat', v => u.number(v, 'lat', 'a latitude', -90, 90)),
    lng: pick('lng', v => u.number(v, 'lng', 'a longitude', -180, 180)),
    geofence_m: pick('geofence_m', v => u.number(v, 'geofence_m', 'a check-in radius in meters', 25, 2000, true)),
    qr_rotate_at: pick('qr_rotate_at', v => u.hhmm(v, 'qr_rotate_at', 'the QR code change time')),
    open_time: pick('open_time', v => u.hhmm(v, 'open_time', 'the opening time')),
    close_time: pick('close_time', v => u.hhmm(v, 'close_time', 'the closing time')),
    active: pick('active', v => (v === true || v === 1 || v === '1' ? 1 : 0)),
  };
  if (!cur) {
    out.name = out.name ?? u.text(undefined, 'name', 'a location name');
    out.timezone = out.timezone ?? u.timezone(undefined);
    out.lat = out.lat ?? u.number(undefined, 'lat', 'a latitude', -90, 90);
    out.lng = out.lng ?? u.number(undefined, 'lng', 'a longitude', -180, 180);
    out.geofence_m = out.geofence_m ?? 150;
    out.qr_rotate_at = out.qr_rotate_at ?? '04:00';
    out.open_time = out.open_time ?? '09:00';
    out.close_time = out.close_time ?? '20:00';
    out.active = out.active ?? 1;
    out.address = out.address ?? null;
  }
  if (out.open_time >= out.close_time) throw bad('close_time', 'The closing time must be after the opening time.');
  return out;
}

// 'HH:MM' -> '9:00 AM'.
const ampm = hhmm => { const [h, m] = hhmm.split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

// R4: a location's hours may not be changed so that an active session of a
// term that hasn't ended falls outside them. `f` holds the new hours and zone.
function assertSessionsFit(ctx, locId, f) {
  const today = time.localDate(f, ctx.clock.now());
  const s = ctx.db.prepare(`SELECT s.name, s.start_time, s.end_time FROM sessions s JOIN terms t ON t.id = s.term_id
    WHERE s.location_id = ? AND s.status = 'active' AND t.end_date >= ? AND (s.start_time < ? OR s.end_time > ?)
    ORDER BY s.start_time, s.name LIMIT 1`).get(locId, today, f.open_time, f.close_time);
  if (!s) return;
  throw conflict('session_outside_hours', `${s.name} runs ${ampm(s.start_time)}–${ampm(s.end_time)}, outside ${ampm(f.open_time)}–${ampm(f.close_time)}. `
    + 'Choose hours that cover it, or change that session first.');
}

function locationsOut(db, rows) {
  const directors = db.prepare("SELECT id, name, email, phone, active FROM users WHERE role = 'director' AND location_id = ? ORDER BY active DESC, name");
  const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ? AND location_id = ? AND active = 1');
  return rows.map(l => Object.assign(l, {
    directors: directors.all(l.id),
    staff_count: count.get('staff', l.id).n,
    student_count: count.get('student', l.id).n,
  }));
}

function routes(r, ctx) {
  const db = ctx.db;

  r.get('/roster', auth.requireRole('staff'), (req, res) => {
    const locId = scopeLocation(ctx, req.user, req.query.location_id);
    const students = db.prepare(`SELECT s.id, s.name, s.email, s.phone, s.location_id, l.name AS location_name,
        s.password_hash IS NOT NULL AS accepted,
        EXISTS (SELECT 1 FROM family_links fl WHERE fl.student_id = s.id AND fl.status = 'active') AS linked
      FROM users s JOIN locations l ON l.id = s.location_id
      WHERE s.role = 'student' AND s.active = 1 AND (? IS NULL OR s.location_id = ?) ORDER BY s.name, s.id`).all(locId, locId);
    const parents = db.prepare(`SELECT fl.student_id, fl.status AS link_status, p.id, p.name, p.email, p.phone
      FROM family_links fl JOIN users p ON p.id = fl.parent_id JOIN users s ON s.id = fl.student_id
      WHERE p.active = 1 AND s.role = 'student' AND s.active = 1 AND (? IS NULL OR s.location_id = ?) ORDER BY p.name`).all(locId, locId);
    for (const s of students) {
      s.linked = !!s.linked;
      s.accepted = !!s.accepted;
      s.state = s.linked ? 'active' : s.accepted ? 'awaiting_approval' : 'invited';
      s.parents = parents.filter(p => p.student_id === s.id).map(({ student_id, ...p }) => p);
      delete s.accepted;
    }
    res.json({ location_id: locId, students });
  });

  r.get('/staff', auth.requireRole('director'), (req, res) => {
    res.json({ staff: staffRows(db, scopeLocation(ctx, req.user, req.query.location_id)) });
  });

  r.post('/staff', auth.requireRole('director'), (req, res) => {
    const b = req.body || {};
    const locId = scopeLocation(ctx, req.user, b.location_id);
    if (locId == null) throw bad('location', 'Choose a location for this staff member.');
    res.status(201).json(createOpsUser(ctx, req.user, 'staff', b, locId));
  });

  r.post('/staff/:id/deactivate', auth.requireRole('director'), (req, res) => {
    const t = managedStaff(ctx, req.user, req.params.id);
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(t.id);
    for (const [token, uid] of ctx.sessions) if (uid === t.id) ctx.sessions.delete(token);
    audit.log(ctx, req.user, 'staff.deactivate', { targetType: 'user', targetId: t.id, locationId: t.location_id, detail: { name: t.name } });
    res.json({ ok: true, user: auth.getUser(ctx, t.id) });
  });

  r.post('/staff/:id/reactivate', auth.requireRole('director'), (req, res) => {
    const t = managedStaff(ctx, req.user, req.params.id);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(t.id);
    audit.log(ctx, req.user, 'staff.reactivate', { targetType: 'user', targetId: t.id, locationId: t.location_id, detail: { name: t.name } });
    res.json({ ok: true, user: auth.getUser(ctx, t.id) });
  });

  r.post('/staff/:id/reset-password', auth.requireRole('director'), (req, res) => {
    const t = managedStaff(ctx, req.user, req.params.id);
    const pw = u.tempPassword();
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), t.id);
      db.prepare(`INSERT INTO account_temp_passwords (user_id, set_by, created_at) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET set_by = excluded.set_by, created_at = excluded.created_at`).run(t.id, req.user.id, ctx.clock.now());
      audit.log(ctx, req.user, 'staff.reset_password', { targetType: 'user', targetId: t.id, locationId: t.location_id, detail: { name: t.name } });
    });
    for (const [token, uid] of ctx.sessions) if (uid === t.id) ctx.sessions.delete(token);
    res.json({ user: auth.getUser(ctx, t.id), temp_password: pw });
  });

  r.get('/locations', auth.requireRole('director'), (req, res) => {
    const rows = req.user.role === 'hq'
      ? db.prepare(`SELECT ${LOC_COLS} FROM locations ORDER BY name`).all()
      : db.prepare(`SELECT ${LOC_COLS} FROM locations WHERE id = ?`).all(req.user.location_id);
    res.json({ locations: locationsOut(db, rows) });
  });

  r.post('/locations', auth.requireRole('hq'), (req, res) => {
    const f = locationFields(req.body || {}, null);
    const id = tx(db, () => {
      const id = Number(db.prepare(`INSERT INTO locations (name, timezone, address, lat, lng, geofence_m, qr_rotate_at, open_time, close_time, qr_secret, active, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.name, f.timezone, f.address, f.lat, f.lng, f.geofence_m, f.qr_rotate_at, f.open_time, f.close_time,
        crypto.randomBytes(16).toString('hex'), f.active, ctx.clock.now()).lastInsertRowid);
      audit.log(ctx, req.user, 'location.create', { targetType: 'location', targetId: id, locationId: id, detail: f });
      return id;
    });
    res.status(201).json({ location: locationsOut(db, [db.prepare(`SELECT ${LOC_COLS} FROM locations WHERE id = ?`).get(id)])[0] });
  });

  r.patch('/locations/:id', auth.requireRole('director'), (req, res) => {
    const b = req.body || {};
    const cur = db.prepare(`SELECT ${LOC_COLS} FROM locations WHERE id = ?`).get(Number(req.params.id) || 0);
    if (!cur) throw notFound('No such location.');
    if (!auth.canManageLocation(req.user, cur.id)) throw forbidden('You can only change your own location.');
    const asked = Object.keys(b).filter(k => b[k] !== undefined);
    if (req.user.role !== 'hq' && asked.some(k => HQ_FIELDS.includes(k))) {
      throw forbidden("Only HQ can change a location's name, time zone, address, map position or status.");
    }
    const f = locationFields(b, cur);
    const changes = {};
    for (const k of [...DIRECTOR_FIELDS, ...HQ_FIELDS]) if (f[k] !== cur[k]) changes[k] = [cur[k], f[k]];
    if (changes.open_time || changes.close_time) assertSessionsFit(ctx, cur.id, f);
    if (Object.keys(changes).length) {
      tx(db, () => {
        db.prepare(`UPDATE locations SET name = ?, timezone = ?, address = ?, lat = ?, lng = ?, geofence_m = ?, qr_rotate_at = ?,
          open_time = ?, close_time = ?, active = ? WHERE id = ?`).run(f.name, f.timezone, f.address, f.lat, f.lng, f.geofence_m,
          f.qr_rotate_at, f.open_time, f.close_time, f.active, cur.id);
        audit.log(ctx, req.user, 'location.update', { targetType: 'location', targetId: cur.id, locationId: cur.id, detail: changes });
      });
    }
    res.json({ location: locationsOut(db, [db.prepare(`SELECT ${LOC_COLS} FROM locations WHERE id = ?`).get(cur.id)])[0] });
  });

  r.post('/directors', auth.requireRole('hq'), (req, res) => {
    const b = req.body || {};
    const locId = scopeLocation(ctx, req.user, b.location_id);
    if (locId == null) throw bad('location', 'Choose the location this director will lead.');
    res.status(201).json(createOpsUser(ctx, req.user, 'director', b, locId));
  });

  r.post('/directors/assign', auth.requireRole('hq'), (req, res) => {
    const b = req.body || {};
    const t = db.prepare("SELECT id, role, name, location_id FROM users WHERE id = ? AND role IN ('staff','director') AND active = 1").get(Number(b.user_id) || 0);
    if (!t) throw notFound('Choose an active staff member or director.');
    const loc = db.prepare('SELECT id, name FROM locations WHERE id = ? AND active = 1').get(Number(b.location_id) || 0);
    if (!loc) throw bad('location', 'Choose an open location.');
    if (t.role === 'director' && t.location_id === loc.id) throw conflict('already_director', `${t.name} already leads ${loc.name}.`);
    tx(db, () => {
      db.prepare("UPDATE users SET role = 'director', location_id = ? WHERE id = ?").run(loc.id, t.id);
      audit.log(ctx, req.user, 'director.assign', { targetType: 'user', targetId: t.id, locationId: loc.id,
        detail: { name: t.name, from: { role: t.role, location_id: t.location_id }, to: { role: 'director', location_id: loc.id } } });
    });
    notify.send(ctx, [t.id], {
      kind: 'account_role', title: `You're now the director at ${loc.name}`,
      body: 'Your director tools are in the menu now.', refType: 'location', refId: loc.id,
    });
    res.json({ user: auth.getUser(ctx, t.id) });
  });
}

module.exports = { routes };
