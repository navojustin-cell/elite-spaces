'use strict';
// Web push (D-11 upgrade). Every notification notify.send() writes is also
// pushed to the browsers its user turned notifications on in, so a phone
// shows it even when the app is closed.
//
// - VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT.
//   Without them the app makes a key pair once and keeps it in `settings`, so a
//   restart keeps every subscription working.
// - Delivery is fire-and-forget: it runs after the request that sent the
//   notification has finished (so a rolled-back write pushes nothing), never
//   throws into the caller, and drops a subscription the push service says is
//   gone (404/410).
// - Only real push services are accepted as endpoints, so the server never
//   posts to an address a user made up.
// - Tests set ctx.pushSender to a fake: (subscription, payload, options) => Promise.

const webpush = require('web-push');
const { bad } = require('./errors');

const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const DEFAULT_SUBJECT = 'mailto:admin@example.com';

function vapid(ctx, env = process.env) {
  if (ctx.vapid) return ctx.vapid;
  const subject = env.VAPID_SUBJECT || DEFAULT_SUBJECT;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return (ctx.vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject });
  }
  const get = k => (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
  if (!get('vapid_public_key') || !get('vapid_private_key')) {
    const k = webpush.generateVAPIDKeys();
    const put = ctx.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    put.run('vapid_public_key', k.publicKey);
    put.run('vapid_private_key', k.privateKey);
  }
  return (ctx.vapid = { publicKey: get('vapid_public_key'), privateKey: get('vapid_private_key'), subject });
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
function pushHost(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (_) { return false; }
  return u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}

// Saves this browser's subscription for `userId`. The endpoint belongs to the
// device, so a device that signs in as someone else moves to that account.
function subscribe(ctx, userId, body) {
  const b = body || {};
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  const keys = b.keys || {};
  if (!endpoint || endpoint.length > 2048 || !pushHost(endpoint)) throw bad('bad_subscription', 'That is not a push subscription this app can use.');
  for (const k of ['p256dh', 'auth']) {
    if (typeof keys[k] !== 'string' || keys[k].length > 200 || !B64URL.test(keys[k])) throw bad('bad_subscription', 'That push subscription is missing its keys.');
  }
  ctx.db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, created_at = excluded.created_at`)
    .run(userId, endpoint, JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }), ctx.clock.now());
}

// Removes one of the caller's own subscriptions. Returns how many went (0 or 1).
function unsubscribe(ctx, userId, endpoint) {
  return Number(ctx.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint || ''), userId).changes);
}

// Queues a push for each notification row notify.send() wrote. Never throws.
function deliver(ctx, rows) {
  if (!rows || !rows.length) return;
  const job = new Promise(r => setImmediate(r)).then(() => pushRows(ctx, rows)).catch(() => {});
  const pending = ctx.pushPending || (ctx.pushPending = new Set());
  pending.add(job);
  job.then(() => pending.delete(job));
}

async function pushRows(ctx, rows) {
  const stillThere = ctx.db.prepare('SELECT 1 FROM notifications WHERE id = ? AND user_id = ? AND created_at = ?');
  const subsOf = ctx.db.prepare(`SELECT s.id, s.endpoint, s.keys FROM push_subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND u.active = 1 ORDER BY s.id`);
  const sends = [];
  for (const row of rows) {
    if (!stillThere.get(row.id, row.user_id, row.created_at)) continue; // the write that made it was rolled back
    const subs = subsOf.all(row.user_id);
    if (!subs.length) continue;
    const emergency = row.priority === 'emergency';
    const payload = JSON.stringify({
      id: row.id, title: row.title, body: String(row.body || '').slice(0, 1000), tag: 'n' + row.id,
      url: '/#/inbox/' + row.id, emergency, requireInteraction: emergency,
    });
    const v = vapid(ctx);
    const options = { TTL: 86400, urgency: emergency ? 'high' : 'normal',
      vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey } };
    for (const s of subs) sends.push(sendOne(ctx, s, payload, options));
  }
  await Promise.all(sends);
}

function sendOne(ctx, s, payload, options) {
  const sender = ctx.pushSender || ((sub, p, o) => webpush.sendNotification(sub, p, o));
  let p;
  try { p = Promise.resolve(sender({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, options)); } catch (e) { p = Promise.reject(e); }
  return p.catch(err => {
    // The push service says this browser unsubscribed or the subscription expired.
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND endpoint = ?').run(s.id, s.endpoint);
    }
  });
}

// Resolves once every queued push has been attempted (tests use this).
async function flush(ctx) {
  await new Promise(r => setImmediate(r));
  while (ctx.pushPending && ctx.pushPending.size) await Promise.allSettled([...ctx.pushPending]);
}

module.exports = { vapid, subscribe, unsubscribe, deliver, flush, PUSH_HOSTS };
