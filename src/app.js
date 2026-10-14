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
const { AppError, forbidden } = require('./errors');
const MODULES = require('./modules');

// cookieName: the sign-in cookie. Browsers share cookies across ports on one
// host, so server.js names it per port; two local servers then never sign each
// other out. Tests keep the default.
function createApp({ dbFile = ':memory:', now = null, dev = false, cookieName = 'sid' } = {}) {
  const clock = createClock(now);
  const ctx = { db: db.open(dbFile, () => clock.now()), clock, sessions: new Map(), dev, cookieName };
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(auth.attachUser(ctx));

  // ---- auth ----
  app.post('/api/auth/login', (req, res) => {
    const { user } = auth.login(ctx, req.body.email, req.body.password);
    const token = auth.startSession(ctx, res, user.id);
    res.json({ user, token });
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = auth.sessionToken(ctx, req);
    if (token) ctx.sessions.delete(token);
    res.clearCookie(ctx.cookieName).json({ ok: true });
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
    app.get('/api/dev/clock', (_req, res) => res.json({ now: ctx.clock.now(), fixed: ctx.clock.isFixed() }));
    app.post('/api/dev/clock', (req, res) => { ctx.clock.set(req.body.now ?? null); res.json({ now: ctx.clock.now(), fixed: ctx.clock.isFixed() }); });
    app.post('/api/dev/run-jobs', (_req, res) => res.json({ ran: runJobs(ctx) }));
  }

  // ---- modules ----
  for (const m of MODULES) app.use('/api/' + m.name, m.router(ctx));

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'not_found', 'No such endpoint.')));
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

module.exports = { createApp, runJobs };
