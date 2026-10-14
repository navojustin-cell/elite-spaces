'use strict';
// Module: announcements - PRD 5. Announcements and emergency alerts (AN-1..AN-6).
//
// Routes, mounted at /api/announcements:
//   GET    /feed        posts the caller is an audience of (NF-1), active emergency alerts,
//                       the caller's scheduled posts (director: own, HQ: all) and their mute setting
//   GET    /options     compose helpers for directors/HQ: categories and the sessions they can target
//   POST   /preview     who a post would reach, without sending it (the review step)
//   POST   /            post or schedule an announcement (director: own location; HQ: all or a set)
//   POST   /emergency   send an emergency alert right now (director: own location; HQ: any)
//   DELETE /:id         cancel a scheduled post (its sender, or HQ)
//   GET    /:id/stats   delivered and read counts (its sender, or HQ)
//   POST   /:id/read    mark the caller's notification for a post as read
//   PUT    /prefs       { muted } turns announcement notifications off or on for the caller
// Job: publish-scheduled sends each due scheduled post exactly once.
//
// Who a post reaches is fixed when it is published and stored in
// announcement_recipients; a family member's feed is exactly those posts.
// Staff and directors see every post sent to their own location; HQ sees all.

const express = require('express');
const { tx } = require('../../db');
const auth = require('../../auth');
const notify = require('../../notify');
const audit = require('../../audit');
const time = require('../../time');
const { bad, forbidden, notFound, conflict } = require('../../errors');

const CATEGORIES = { event: 'Event', workshop: 'Workshop', holiday: 'Holiday', session_offering: 'Session offering', news: 'General news' };
const AUDIENCES = ['families', 'parents', 'students', 'session'];
const TITLE_MAX = 120;
const BODY_MAX = 2000;
const EMERGENCY_MAX = 300;                    // emergency text stays short and actionable
const EMERGENCY_ACTIVE_MS = 24 * 3600 * 1000; // an alert stays pinned on Home for a day
const PAST_GRACE_MS = 5 * 60 * 1000;          // a schedule time this close to now just means "now"
const MAX_AHEAD_MS = 365 * 24 * 3600 * 1000;  // a schedule time further out than a year is a typo

// ---------- input checks ----------

// Title or message text: a string, or a number from a loose client. Anything
// else (an object, array or boolean) is refused rather than coerced.
function text(v, field, label) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(field, `Write the ${label} as plain text.`);
  return String(v).trim();
}

// A location or session id: a number or numeric text. Anything else is NaN, so it matches nothing.
const toId = v => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN);

function content(b, bodyMax) {
  const title = text(b.title, 'title', 'title');
  const body = text(b.body, 'body', 'message');
  if (!title) throw bad('title', 'Add a title.');
  if (title.length > TITLE_MAX) throw bad('title', `Keep the title to ${TITLE_MAX} characters or fewer.`);
  if (!body) throw bad('body', 'Add a message.');
  if (body.length > bodyMax) throw bad('body', `Keep the message to ${bodyMax} characters or fewer.`);
  return { title, body };
}

// Locations a post goes to. HQ: 'all' or a chosen set (AN-2). Director: own only (AN-1, AN-5).
function targetLocations(ctx, user, raw) {
  if (user.role === 'hq') {
    if (raw === 'all') return ctx.db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id').all().map(r => r.id);
    if (!Array.isArray(raw) || !raw.length) throw bad('locations', 'Choose at least one location.');
    const ids = [...new Set(raw.map(toId))].sort((x, y) => x - y);
    const known = ctx.db.prepare('SELECT 1 FROM locations WHERE active = 1 AND id = ?');
    if (ids.some(id => !known.get(id))) throw bad('locations', 'One of those locations does not exist.');
    return ids;
  }
  const ownOnly = raw == null || (Array.isArray(raw) && raw.length > 0 && raw.every(v => toId(v) === user.location_id));
  if (!ownOnly) throw forbidden('Directors can post only to their own location.');
  return [user.location_id];
}

function targetSession(ctx, user, sessionId) {
  const s = ctx.db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(toId(sessionId) || 0);
  if (!s) throw bad('session', 'Choose a session.');
  if (!auth.canManageLocation(user, s.location_id)) throw forbidden('That session is at another location.');
  return s;
}

// { audience, sessionId, locationIds } after every scope check.
function resolveTarget(ctx, user, b, emergency) {
  if (emergency) return { audience: 'everyone', sessionId: null, locationIds: targetLocations(ctx, user, b.locations) };
  if (!AUDIENCES.includes(b.audience)) throw bad('audience', 'Choose who should get this.');
  if (b.audience === 'session') {
    const s = targetSession(ctx, user, b.session_id);
    return { audience: 'session', sessionId: s.id, locationIds: [s.location_id] };
  }
  return { audience: b.audience, sessionId: null, locationIds: targetLocations(ctx, user, b.locations) };
}

// publish_at: UTC ms, or 'YYYY-MM-DDTHH:MM' wall time at the post's (first) location.
// Missing means "now". A time that has already passed is refused rather than
// silently sent, so a mistyped schedule never goes out early; so is a clock time
// like 25:00 (which would roll into the next day) or one more than a year out.
function parsePublishAt(ctx, raw, locationId) {
  const now = ctx.clock.now();
  if (raw == null || raw === '') return now;
  let ms = NaN;
  const wall = typeof raw === 'string' && /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (typeof raw === 'number') ms = raw;
  else if (wall) {
    const loc = ctx.db.prepare('SELECT timezone FROM locations WHERE id = ?').get(locationId);
    ms = time.toMs(loc, wall[1], wall[2] + ':' + wall[3]);
  }
  if (!Number.isFinite(ms)) throw bad('publish_at', 'Choose a valid date and time.');
  if (ms < now - PAST_GRACE_MS) throw bad('publish_at', 'That time has already passed. Pick a later time, or send it now.');
  if (ms > now + MAX_AHEAD_MS) throw bad('publish_at', 'Pick a time within the next year.');
  return Math.max(ms, now);
}

// ---------- audiences ----------

// The users a post reaches (AN-4, AN-5): active accounts only, and students
// only once a parent has approved them (they cannot sign in before that).
function audienceUsers(ctx, t) {
  const db = ctx.db;
  const q = t.locationIds.map(() => '?').join(',') || 'NULL';
  const L = t.locationIds;
  const linked = "EXISTS (SELECT 1 FROM family_links fl WHERE fl.student_id = u.id AND fl.status = 'active')";
  const students = () => db.prepare(`SELECT u.id, u.role FROM users u
    WHERE u.role = 'student' AND u.active = 1 AND u.location_id IN (${q}) AND ${linked}`).all(...L);
  // Parents whose home location is here, or who have an active linked student here.
  const parents = () => db.prepare(`SELECT p.id, p.role FROM users p WHERE p.role = 'parent' AND p.active = 1
    AND (p.location_id IN (${q}) OR EXISTS (SELECT 1 FROM family_links pl JOIN users s ON s.id = pl.student_id
      WHERE pl.parent_id = p.id AND pl.status = 'active' AND s.location_id IN (${q})))`).all(...L, ...L);
  const ops = () => db.prepare(`SELECT u.id, u.role FROM users u
    WHERE u.role IN ('staff', 'director') AND u.active = 1 AND u.location_id IN (${q})`).all(...L);
  const sessionFamilies = () => {
    const kids = db.prepare(`SELECT DISTINCT u.id, u.role FROM enrollments e JOIN users u ON u.id = e.student_id
      WHERE e.session_id = ? AND e.status = 'active' AND u.active = 1 AND ${linked}`).all(t.sessionId);
    const kidIds = kids.map(k => k.id);
    const folks = kidIds.length ? db.prepare(`SELECT DISTINCT p.id, p.role FROM family_links sl JOIN users p ON p.id = sl.parent_id
      WHERE sl.status = 'active' AND p.active = 1 AND sl.student_id IN (${kidIds.map(() => '?').join(',')})`).all(...kidIds) : [];
    return [...folks, ...kids];
  };
  let list;
  switch (t.audience) {
    case 'parents': list = parents(); break;
    case 'students': list = students(); break;
    case 'families': list = [...parents(), ...students()]; break;
    case 'session': list = sessionFamilies(); break;
    case 'everyone': list = [...parents(), ...students(), ...ops()]; break;
    default: list = [];
  }
  return [...new Map(list.map(u => [u.id, u])).values()];
}

const mutedIds = ctx => new Set(ctx.db.prepare('SELECT user_id FROM announcement_prefs WHERE muted = 1').all().map(r => r.user_id));

// ---------- create and publish ----------

function createPost(ctx, user, p) {
  const db = ctx.db;
  const now = ctx.clock.now();
  return tx(db, () => {
    const id = Number(db.prepare(`INSERT INTO announcements (type, category, title, body, audience, session_id, status, publish_at, created_by, created_at)
      VALUES (?,?,?,?,?,?,'scheduled',?,?,?)`).run(p.type, p.category, p.title, p.body, p.audience, p.sessionId, p.publishAt, user.id, now).lastInsertRowid);
    const addLoc = db.prepare('INSERT INTO announcement_locations (announcement_id, location_id) VALUES (?, ?)');
    for (const l of p.locationIds) addLoc.run(id, l);
    const action = p.type === 'emergency' ? 'emergency.send' : p.publishAt > now ? 'announcement.schedule' : 'announcement.post';
    audit.log(ctx, user, action, { targetType: 'announcement', targetId: id, locationId: p.locationIds.length === 1 ? p.locationIds[0] : null,
      detail: { audience: p.audience, locations: p.locationIds, sessionId: p.sessionId } });
    return id;
  });
}

function fromLabel(ctx, a, locationIds) {
  const sender = ctx.db.prepare('SELECT role FROM users WHERE id = ?').get(a.created_by);
  if (sender && sender.role === 'hq') return 'ELITE HQ';
  const loc = ctx.db.prepare('SELECT name FROM locations WHERE id = ?').get(locationIds[0]);
  return loc ? loc.name : 'ELITE Spaces';
}

// Sends a scheduled post: fixes its recipients and notifies each one (AN-3).
// Returns null if it was already published or cancelled.
function publish(ctx, id) {
  const db = ctx.db;
  return tx(db, () => {
    const now = ctx.clock.now();
    // The status guard is what makes this exactly once, even if two job runs race.
    const claimed = db.prepare("UPDATE announcements SET status = 'published', published_at = ? WHERE id = ? AND status = 'scheduled'").run(now, id);
    if (claimed.changes !== 1) return null;
    const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
    const locationIds = db.prepare('SELECT location_id FROM announcement_locations WHERE announcement_id = ? ORDER BY location_id').all(id).map(r => r.location_id);
    const users = audienceUsers(ctx, { audience: a.audience, sessionId: a.session_id, locationIds });
    const addRecipient = db.prepare('INSERT OR IGNORE INTO announcement_recipients (announcement_id, user_id) VALUES (?, ?)');
    for (const u of users) addRecipient.run(id, u.id);
    const emergency = a.type === 'emergency';
    const ids = users.map(u => u.id);
    const muted = mutedIds(ctx);
    // Muted users still see the post in News; emergency alerts ignore mute (AN-5).
    const notifyIds = emergency ? ids : ids.filter(uid => !muted.has(uid));
    const from = fromLabel(ctx, a, locationIds);
    const snippet = a.body.length > 160 ? a.body.slice(0, 157).trimEnd() + '…' : a.body;
    notify.send(ctx, notifyIds, {
      kind: emergency ? 'emergency_alert' : 'announcement',
      title: a.title,
      body: (emergency ? 'Emergency alert from ' : 'From ') + from + ' · ' + snippet,
      refType: 'announcement',
      refId: id,
      priority: emergency ? 'emergency' : 'normal',
    });
    return { recipients: ids.length, notified: notifyIds.length };
  });
}

// ---------- reading ----------

// SQL that limits announcements `a` to what this user may see (NF-1).
function scope(user) {
  if (user.role === 'hq') return { sql: '1 = 1', args: [] };
  if (auth.atLeast(user, 'staff')) {
    return { sql: 'EXISTS (SELECT 1 FROM announcement_locations al WHERE al.announcement_id = a.id AND al.location_id = ?)', args: [user.location_id] };
  }
  return { sql: 'EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.user_id = ?)', args: [user.id] };
}

function visible(ctx, user, where = '', args = [], limit = 100) {
  const s = scope(user);
  return ctx.db.prepare(`SELECT a.* FROM announcements a WHERE a.status = 'published' AND ${s.sql}${where}
    ORDER BY a.published_at DESC, a.id DESC LIMIT ?`).all(...s.args, ...args, limit);
}

const senderOrHq = (user, a) => user.role === 'hq' || a.created_by === user.id;

// Delivery and read counts come from the notifications rows (AN-6).
function stats(ctx, id) {
  const n = ctx.db.prepare(`SELECT COUNT(*) AS delivered, COUNT(read_at) AS read FROM notifications
    WHERE ref_type = 'announcement' AND ref_id = ? AND delivered_at IS NOT NULL`).get(id);
  const recipients = ctx.db.prepare('SELECT COUNT(*) AS n FROM announcement_recipients WHERE announcement_id = ?').get(id).n;
  return { recipients, delivered: n.delivered, read: n.read, muted: Math.max(0, recipients - n.delivered) };
}

// A non-HQ user's own locations: their home, plus each linked student's for a parent.
function ownLocationIds(ctx, user) {
  const ids = new Set([user.location_id]);
  if (user.role === 'parent') {
    for (const sid of auth.linkedStudentIds(ctx, user.id)) ids.add((auth.getUser(ctx, sid) || {}).location_id);
  }
  return ids;
}

function shape(ctx, user, a) {
  const db = ctx.db;
  const locs = db.prepare(`SELECT l.id, l.name, l.timezone, l.address FROM announcement_locations al JOIN locations l ON l.id = al.location_id
    WHERE al.announcement_id = ? ORDER BY l.name`).all(a.id);
  // Outside HQ, a post names only the caller's own location(s).
  const own = user.role === 'hq' ? null : ownLocationIds(ctx, user);
  const shown = own ? locs.filter(l => own.has(l.id)) : locs;
  const sender = db.prepare('SELECT name, role FROM users WHERE id = ?').get(a.created_by) || { name: 'ELITE Spaces', role: null };
  const session = a.session_id ? db.prepare('SELECT id, name, weekdays, start_time, end_time FROM sessions WHERE id = ?').get(a.session_id) : null;
  const note = db.prepare("SELECT read_at FROM notifications WHERE user_id = ? AND ref_type = 'announcement' AND ref_id = ? ORDER BY id LIMIT 1").get(user.id, a.id);
  return {
    id: a.id, type: a.type, category: a.category, category_label: a.category ? CATEGORIES[a.category] : null,
    title: a.title, body: a.body, audience: a.audience, status: a.status,
    publish_at: a.publish_at, published_at: a.published_at, created_at: a.created_at,
    session, locations: shown, location_count: locs.length,
    tz: (shown[0] || locs[0] || {}).timezone || null,
    sender: { name: sender.name, role: sender.role },
    mine: a.created_by === user.id,
    unread: !!note && !note.read_at,
    stats: senderOrHq(user, a) ? stats(ctx, a.id) : null,
  };
}

function getPost(ctx, id) {
  const a = ctx.db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(id) || 0);
  if (!a) throw notFound('That announcement does not exist.');
  return a;
}

// ---------- routes ----------

function router(ctx) {
  const r = express.Router();
  const db = ctx.db;

  r.get('/feed', auth.requireRole(), (req, res) => {
    const u = req.user;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const posts = visible(ctx, u, '', [], limit).map(a => shape(ctx, u, a));
    const active = visible(ctx, u, " AND a.type = 'emergency' AND a.published_at > ?", [ctx.clock.now() - EMERGENCY_ACTIVE_MS]).map(a => shape(ctx, u, a));
    const scheduled = auth.atLeast(u, 'director')
      ? db.prepare(`SELECT a.* FROM announcements a WHERE a.status = 'scheduled' AND (? = 'hq' OR a.created_by = ?)
          ORDER BY a.publish_at, a.id`).all(u.role, u.id).map(a => shape(ctx, u, a))
      : [];
    const pref = db.prepare('SELECT muted FROM announcement_prefs WHERE user_id = ?').get(u.id);
    res.json({ posts, active_emergencies: active, scheduled, muted: !!(pref && pref.muted) });
  });

  r.get('/options', auth.requireRole('director'), (req, res) => {
    const u = req.user;
    const sessions = db.prepare(`SELECT s.id, s.name, s.weekdays, s.start_time, s.end_time, s.location_id,
        l.name AS location_name, l.timezone,
        (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e WHERE e.session_id = s.id AND e.status = 'active') AS enrolled
      FROM sessions s JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'active' AND (? = 'hq' OR s.location_id = ?)
      ORDER BY l.name, s.start_time, s.name, s.id`).all(u.role, u.location_id);
    res.json({ categories: CATEGORIES, sessions, title_max: TITLE_MAX, body_max: BODY_MAX, emergency_max: EMERGENCY_MAX });
  });

  r.post('/preview', auth.requireRole('director'), (req, res) => {
    const b = req.body || {};
    const emergency = b.type === 'emergency';
    const target = resolveTarget(ctx, req.user, b, emergency);
    const users = audienceUsers(ctx, target);
    const muted = mutedIds(ctx);
    const mutedCount = emergency ? 0 : users.filter(x => muted.has(x.id)).length;
    const names = db.prepare(`SELECT name FROM locations WHERE id IN (${target.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY name`)
      .all(...target.locationIds).map(l => l.name);
    res.json({
      recipients: users.length, notified: users.length - mutedCount, muted: mutedCount,
      parents: users.filter(x => x.role === 'parent').length,
      students: users.filter(x => x.role === 'student').length,
      staff: users.filter(x => x.role === 'staff' || x.role === 'director').length,
      locations: names,
    });
  });

  r.post('/', auth.requireRole('director'), (req, res) => {
    const b = req.body || {};
    const { title, body } = content(b, BODY_MAX);
    if (typeof b.category !== 'string' || !Object.hasOwn(CATEGORIES, b.category)) throw bad('category', 'Choose a category: event, workshop, holiday, session offering or general news.');
    const target = resolveTarget(ctx, req.user, b, false);
    const now = ctx.clock.now();
    const publishAt = parsePublishAt(ctx, b.publish_at, target.locationIds[0]);
    const id = createPost(ctx, req.user, { type: 'announcement', category: b.category, title, body, ...target, publishAt });
    const sent = publishAt <= now ? publish(ctx, id) : null;
    res.status(201).json({ announcement: shape(ctx, req.user, getPost(ctx, id)), recipients: sent ? sent.recipients : null, notified: sent ? sent.notified : null });
  });

  r.post('/emergency', auth.requireRole('director'), (req, res) => {
    const b = req.body || {};
    const { title, body } = content(b, EMERGENCY_MAX);
    const target = resolveTarget(ctx, req.user, b, true);
    // No scheduling for emergencies: it goes out now.
    const id = createPost(ctx, req.user, { type: 'emergency', category: null, title, body, ...target, publishAt: ctx.clock.now() });
    const sent = publish(ctx, id);
    res.status(201).json({ announcement: shape(ctx, req.user, getPost(ctx, id)), recipients: sent.recipients, notified: sent.notified });
  });

  r.put('/prefs', auth.requireRole(), (req, res) => {
    const muted = req.body && req.body.muted;
    if (typeof muted !== 'boolean') throw bad('muted', 'Choose whether announcement notifications are on or off.');
    db.prepare(`INSERT INTO announcement_prefs (user_id, muted, updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET muted = excluded.muted, updated_at = excluded.updated_at`).run(req.user.id, muted ? 1 : 0, ctx.clock.now());
    res.json({ muted });
  });

  r.delete('/:id', auth.requireRole('director'), (req, res) => {
    const a = getPost(ctx, req.params.id);
    if (!senderOrHq(req.user, a)) throw forbidden('Only the person who scheduled this post, or HQ, can cancel it.');
    if (a.status !== 'scheduled') throw conflict('not_scheduled', 'This post has already gone out, so it can no longer be cancelled.');
    db.prepare("UPDATE announcements SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'scheduled'").run(ctx.clock.now(), a.id);
    audit.log(ctx, req.user, 'announcement.cancel', { targetType: 'announcement', targetId: a.id });
    res.json({ ok: true });
  });

  r.get('/:id/stats', auth.requireRole('director'), (req, res) => {
    const a = getPost(ctx, req.params.id);
    if (!senderOrHq(req.user, a)) throw forbidden('Only the sender, or HQ, can see delivery numbers.');
    res.json(stats(ctx, a.id));
  });

  r.post('/:id/read', auth.requireRole(), (req, res) => {
    const [a] = visible(ctx, req.user, ' AND a.id = ?', [Number(req.params.id) || 0], 1);
    if (!a) throw notFound('That announcement is not available.');
    db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ? AND ref_type = 'announcement' AND ref_id = ?")
      .run(ctx.clock.now(), req.user.id, a.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = {
  router,
  jobs: [{
    name: 'publish-scheduled',
    run(ctx) {
      const due = ctx.db.prepare("SELECT id FROM announcements WHERE status = 'scheduled' AND publish_at <= ? ORDER BY publish_at, id").all(ctx.clock.now());
      for (const { id } of due) publish(ctx, id);
    },
  }],
  // For this module's seed and tests.
  createPost, publish, audienceUsers,
};
