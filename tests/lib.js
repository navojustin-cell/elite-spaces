'use strict';
// Shared test kit. Every test file gets the app ONLY through load()/makeApp()
// here, never by requiring ../src directly: the mutation runner points
// ELITE_ROOT at a deliberately broken copy of the code, and a test that
// bypassed this would keep testing the unbroken original.

const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');

const ROOT = process.env.ELITE_ROOT || path.join(__dirname, '..');
const load = rel => require(path.join(ROOT, rel));

// ---- registry ----
const TESTS = [];
let currentFile = null;
// test(['CI-1', 'NF-4'], 'yesterday\'s code stops working', async t => { ... })
function test(ids, name, fn) {
  if (typeof ids === 'string') ids = [ids];
  TESTS.push({ ids, name, fn, file: currentFile });
}

// ---- default instant: Wed 14 Oct 2026, 10:00 in Los Angeles ----
const DEFAULT_NOW = Date.UTC(2026, 9, 14, 17, 0);

// One password hash shared by every fixture user (scrypt is slow on purpose).
let PW_HASH = null;
const pwHash = () => (PW_HASH = PW_HASH || load('src/auth.js').hashPassword('demo1234'));

const openServers = [];

async function makeApp(opts = {}) {
  const { createApp, runJobs } = load('src/app.js');
  const { app, ctx } = createApp({ now: opts.now ?? DEFAULT_NOW, dev: !!opts.dev });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  openServers.push(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    ctx,
    base,
    db: ctx.db,
    clock: ctx.clock,
    jobs: () => runJobs(ctx),
    as: user => client(base, ctx, user),
    anon: client(base, ctx, null),
    fx: fixtures(ctx),
  };
}

async function closeAll() {
  while (openServers.length) {
    const s = openServers.pop();
    s.closeAllConnections && s.closeAllConnections();
    await new Promise(r => s.close(() => r()));
  }
}

// HTTP client signed in as `user` (a session is minted directly, no scrypt).
function client(base, ctx, user) {
  let cookie = '';
  if (user) {
    const token = crypto.randomBytes(16).toString('hex');
    ctx.sessions.set(token, user.id);
    cookie = 'sid=' + token;
  }
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: Object.assign({ cookie }, body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.startsWith('text/') ? await res.text() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    get: url => call('GET', url),
    post: (url, body = {}) => call('POST', url, body),
    put: (url, body = {}) => call('PUT', url, body),
    patch: (url, body = {}) => call('PATCH', url, body),
    del: url => call('DELETE', url),
  };
}

// ---- fixtures: direct inserts on the core schema (schema/000_core.sql) ----
function fixtures(ctx) {
  const db = ctx.db;
  const now = () => ctx.clock.now();
  let n = 0;
  const ins = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);
  const user = (role, { location = null, name, email, active = 1 } = {}) => {
    n++;
    const id = ins('INSERT INTO users (role, name, email, password_hash, location_id, active, created_at) VALUES (?,?,?,?,?,?,?)',
      role, name || `${role} ${n}`, email || `${role}${n}.${crypto.randomBytes(3).toString('hex')}@test.local`, pwHash(),
      location ? location.id : null, active, now());
    return db.prepare('SELECT id, role, name, email, phone, location_id, active FROM users WHERE id = ?').get(id);
  };
  const fx = {
    location({ name, timezone = 'America/Los_Angeles', lat = 33.6846, lng = -117.8265, geofence_m = 150,
      qr_rotate_at = '04:00', open_time = '09:00', close_time = '20:00' } = {}) {
      n++;
      const id = ins(`INSERT INTO locations (name, timezone, lat, lng, geofence_m, qr_rotate_at, open_time, close_time, qr_secret, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, name || `Location ${n}`, timezone, lat, lng, geofence_m, qr_rotate_at, open_time, close_time,
        crypto.randomBytes(16).toString('hex'), now());
      return db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    },
    user,
    hq: o => user('hq', o),
    director: (location, o) => user('director', Object.assign({ location }, o)),
    staff: (location, o) => user('staff', Object.assign({ location }, o)),
    // A parent with `students` linked students, each with a membership.
    family(location, { students = 1, cap = 3, status = 'active', start = '2026-08-01', expires = '2027-06-30', linked = true } = {}) {
      const parent = user('parent', { location });
      const kids = [];
      for (let i = 0; i < students; i++) {
        const s = user('student', { location });
        db.prepare('INSERT INTO family_links (parent_id, student_id, status, created_at, approved_at) VALUES (?,?,?,?,?)')
          .run(parent.id, s.id, linked ? 'active' : 'pending', now(), linked ? now() : null);
        fx.membership(s, { cap, status, start, expires });
        kids.push(s);
      }
      return { parent, students: kids, student: kids[0] };
    },
    link(parent, student, status = 'active') {
      db.prepare('INSERT OR REPLACE INTO family_links (parent_id, student_id, status, created_at, approved_at) VALUES (?,?,?,?,?)')
        .run(parent.id, student.id, status, now(), status === 'active' ? now() : null);
    },
    membership(student, { cap = 3, status = 'active', start = '2026-08-01', expires = '2027-06-30' } = {}) {
      db.prepare(`INSERT INTO memberships (student_id, status, weekly_cap, start_date, expires_on, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(student_id) DO UPDATE SET status=excluded.status, weekly_cap=excluded.weekly_cap,
        start_date=excluded.start_date, expires_on=excluded.expires_on`).run(student.id, status, cap, start, expires, now());
    },
    term(location, { name = 'Fall 2026', start = '2026-08-17', end = '2026-12-18' } = {}) {
      const id = ins('INSERT INTO terms (location_id, name, start_date, end_date) VALUES (?,?,?,?)', location.id, name, start, end);
      return db.prepare('SELECT * FROM terms WHERE id = ?').get(id);
    },
    session(location, { term, name = 'Afternoon Study', weekdays = '1,3,5', start = '13:00', end = '16:00', capacity = 10 } = {}) {
      term = term || db.prepare('SELECT * FROM terms WHERE location_id = ? ORDER BY id LIMIT 1').get(location.id) || fx.term(location);
      const id = ins(`INSERT INTO sessions (location_id, term_id, name, weekdays, start_time, end_time, capacity, created_at)
        VALUES (?,?,?,?,?,?,?,?)`, location.id, term.id, name, weekdays, start, end, capacity, now());
      return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    },
    enroll(student, session, weekday, { status = 'active', source = 'parent' } = {}) {
      const id = ins('INSERT INTO enrollments (student_id, session_id, weekday, status, source, created_at) VALUES (?,?,?,?,?,?)',
        student.id, session.id, weekday, status, source, now());
      return db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id);
    },
    visit(student, location, { session = null, weekday = null, local_date = '2026-10-14', check_in_at, check_out_at = null,
      checkin_method = 'scan', checkout_method = null, flagged = 0 } = {}) {
      const id = ins(`INSERT INTO visits (student_id, location_id, session_id, weekday, local_date, check_in_at, check_out_at,
        checkin_method, checkout_method, flagged) VALUES (?,?,?,?,?,?,?,?,?,?)`, student.id, location.id, session ? session.id : null,
        weekday, local_date, check_in_at ?? now(), check_out_at, checkin_method, checkout_method, flagged);
      return db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
    },
    notifications: (u, kind) => db.prepare(`SELECT * FROM notifications WHERE user_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY id`)
      .all(...(kind ? [u.id, kind] : [u.id])),
    audit: action => db.prepare(`SELECT * FROM audit_log${action ? ' WHERE action = ?' : ''} ORDER BY id`).all(...(action ? [action] : [])),
  };
  return fx;
}

// UTC ms for a wall-clock time in a zone: at('America/Los_Angeles', '2026-10-14', '13:05')
function at(zone, date, hhmm) {
  return load('src/time.js').toMs({ timezone: zone }, date, hhmm);
}

module.exports = {
  test, TESTS, setFile: f => { currentFile = f; }, makeApp, closeAll, assert, load, at, ROOT, DEFAULT_NOW,
};
