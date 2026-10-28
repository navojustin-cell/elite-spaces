'use strict';
// Builds the app: database, clock, foundation routes, and the eight modules.
// createApp() is what the server and every test call, so tests exercise the
// same wiring that ships.

const path = require('path');
const express = require('express');
const db = require('./db');
const { createClock } = require('./clock');
const auth = require('./auth');
const notify = require('./notify');
const push = require('./push');
const { AppError, forbidden } = require('./errors');
const MODULES = require('./modules');

// cookieName: the sign-in cookie. Browsers share cookies across ports on one
// host, so server.js names it per port; two local servers then never sign each
// other out. Tests keep the default.
function createApp({ dbFile = ':memory:', now = null, dev = false, cookieName = 'sid' } = {}) {
  const clock = createClock(now);
  const ctx = { db: db.open(dbFile, () => clock.now()), clock, sessions: new Map(), dev, cookieName };
  const app = express();
  // Behind a hosting proxy (Render) that ends HTTPS: trust its X-Forwarded-Proto
  // so req.secure is right and the sign-in cookie gets Secure (auth.startSession).
  app.set('trust proxy', 1);
  // Security headers on every response, the app's own and the static files.
  // No script policy: only frame-ancestors, so nothing the app loads is blocked.
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // HSTS only over HTTPS (through the host's proxy); local HTTP never gets it.
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // Uptime check for the host: no sign-in, no database work.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(auth.attachUser(ctx));

  // ---- auth ----
  app.post('/api/auth/login', (req, res) => {
    const { user } = auth.login(ctx, req.body.email, req.body.password);
    // The httpOnly cookie is the session; the token never goes in the body (L64).
    auth.startSession(ctx, res, user.id);
    res.json({ user });
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = auth.sessionToken(ctx, req);
    if (token) ctx.sessions.delete(token);
    res.clearCookie(ctx.cookieName, auth.cookieOptions(req)).json({ ok: true });
  });
  // clock_fixed: the dev clock is pinned, so the app should use `now` rather than its own clock.
  app.get('/api/auth/me', auth.requireRole(), (req, res) => {
    const loc = req.user.location_id && ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(req.user.location_id);
    res.json({ user: req.user, location: loc || null, dev: ctx.dev, now: ctx.clock.now(), clock_fixed: ctx.clock.isFixed() });
  });

  // ---- notifications inbox (shared by every module) ----
  app.get('/api/notifications', auth.requireRole(), (req, res) => {
    const rows = ctx.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200').all(req.user.id);
    res.json({ notifications: rows, unread: rows.filter(r => !r.read_at).length });
  });
  app.post('/api/notifications/:id/read', auth.requireRole(), (req, res) => {
    ctx.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(ctx.clock.now(), req.params.id, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/notifications/read-all', auth.requireRole(), (req, res) => {
    ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(ctx.clock.now(), req.user.id);
    res.json({ ok: true });
  });
  app.get('/api/notifications/stream', auth.requireRole(), (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }).flushHeaders();
    const fn = (uid, row) => { if (uid === req.user.id) res.write('data: ' + JSON.stringify(row) + '\n\n'); };
    notify.listeners.add(fn);
    req.on('close', () => notify.listeners.delete(fn));
  });

  // ---- web push (src/push.js): each signed-in user manages only their own browsers ----
  app.get('/api/push/key', auth.requireRole(), (_req, res) => res.json({ publicKey: push.vapid(ctx).publicKey }));
  app.post('/api/push/subscribe', auth.requireRole(), (req, res) => {
    push.subscribe(ctx, req.user.id, req.body);
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', auth.requireRole(), (req, res) => {
    res.json({ ok: true, removed: push.unsubscribe(ctx, req.user.id, req.body && req.body.endpoint) });
  });

  // ---- locations visible to the caller ----
  app.get('/api/locations', auth.requireRole(), (req, res) => {
    const cols = 'id, name, timezone, address, lat, lng, geofence_m, qr_rotate_at, open_time, close_time, active';
    const rows = req.user.role === 'hq'
      ? ctx.db.prepare(`SELECT ${cols} FROM locations ORDER BY name`).all()
      : ctx.db.prepare(`SELECT ${cols} FROM locations WHERE id = ?`).all(req.user.location_id);
    res.json({ locations: rows });
  });

  // ---- dev-only helpers: demo sign-in, clock control, run scheduled jobs ----
  if (dev) {
    app.get('/api/dev/accounts', (_req, res) => {
      const rows = ctx.db.prepare(`SELECT u.id, u.role, u.name, u.email, l.name AS location FROM users u
        LEFT JOIN locations l ON l.id = u.location_id WHERE u.active = 1 AND u.password_hash IS NOT NULL
        ORDER BY CASE u.role WHEN 'hq' THEN 0 WHEN 'director' THEN 1 WHEN 'staff' THEN 2 WHEN 'parent' THEN 3 ELSE 4 END, u.name`).all();
      res.json({ accounts: rows.filter(u => u.role !== 'student' || auth.studentLinked(ctx, u.id)) });
    });
    app.post('/api/dev/login-as', (req, res) => {
      const u = auth.getUser(ctx, Number(req.body.userId));
      if (!u) throw new AppError(404, 'not_found', 'No such user.');
      if (u.role === 'student' && !auth.studentLinked(ctx, u.id)) throw forbidden('This student has not been approved by a parent yet.');
      auth.startSession(ctx, res, u.id);
      res.json({ user: u });
    });
    // The clock and the job runner are shared by everyone on the demo, so only a
    // signed-in user may read or move them (fix list 2026-10-21 item 4). The demo
    // sign-in screen needs the two above, so they stay open.
    app.get('/api/dev/clock', auth.requireRole(), (_req, res) => res.json({ now: ctx.clock.now(), fixed: ctx.clock.isFixed() }));
    app.post('/api/dev/clock', auth.requireRole(), (req, res) => { ctx.clock.set(req.body.now ?? null); res.json({ now: ctx.clock.now(), fixed: ctx.clock.isFixed() }); });
    app.post('/api/dev/run-jobs', auth.requireRole(), (_req, res) => res.json({ ran: runJobs(ctx) }));
  }

  // ---- modules ----
  for (const m of MODULES) app.use('/api/' + m.name, m.router(ctx));

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'not_found', 'No such endpoint.')));
  // iPhones also look for the home-screen icon at the site root.
  app.get('/apple-touch-icon.png', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'icons', 'apple-touch-icon.png')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Errors -> JSON. AppError carries its own status; anything else is a 500.
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Request body is not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'server', message: 'Something went wrong.' });
  });

  return { app, ctx };
}

// Run every module's scheduled jobs once (auto-checkout, waitlist promotion,
// membership reminders, scheduled announcements...). The server calls this on
// an interval; tests call it directly after moving the clock.
function runJobs(ctx) {
  const ran = [];
  for (const m of MODULES) for (const j of m.jobs || []) { j.run(ctx); ran.push(m.name + '.' + j.name); }
  return ran;
}

// Dev mode (one-tap demo sign-in, clock control, the /api/dev endpoints) is off
// unless ELITE_DEV=1 is set explicitly (R9). server.js reads it through here.
const devFromEnv = env => env.ELITE_DEV === '1';

// A new database gets the schema and nothing else. Demo data goes in only when
// ELITE_SEED_DEMO=1 asks for it AND the database has no accounts yet, so the
// seed (which starts from a blank file) can never wipe real data.
function needsDemoSeed(dbFile, env) {
  if (env.ELITE_SEED_DEMO !== '1') return false;
  if (!dbFile || dbFile === ':memory:' || !require('fs').existsSync(dbFile)) return true;
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(dbFile);
  try { return !d.prepare('SELECT 1 FROM users LIMIT 1').get(); } catch (_) { return true; } finally { d.close(); }
}

module.exports = { createApp, runJobs, devFromEnv, needsDemoSeed };
