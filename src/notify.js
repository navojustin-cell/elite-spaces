'use strict';
// Notifications land in the in-app inbox (notifications table), stream live to
// open apps over SSE, and go out as web push to the user's subscribed browsers
// (src/push.js, fire-and-forget; D-11).

const push = require('./push');

const listeners = new Set(); // (userId, row) => void, used by the SSE endpoint

function send(ctx, userIds, { kind, title, body, refType, refId, priority = 'normal' }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const now = ctx.clock.now();
  const stmt = ctx.db.prepare(
    'INSERT INTO notifications (user_id, kind, title, body, ref_type, ref_id, priority, created_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const rows = ids.map(uid => {
    const r = stmt.run(uid, kind, title, body || null, refType || null, refId ?? null, priority, now, now);
    return { id: Number(r.lastInsertRowid), user_id: uid, kind, title, body, ref_type: refType, ref_id: refId, priority, created_at: now };
  });
  for (const row of rows) for (const fn of listeners) { try { fn(row.user_id, row); } catch (_) { /* a dead stream must not block others */ } }
  try { push.deliver(ctx, rows); } catch (_) { /* push never breaks the caller */ }
  return rows;
}

// Active linked parents of a student.
function parentsOf(ctx, studentId) {
  return ctx.db.prepare("SELECT parent_id FROM family_links WHERE student_id = ? AND status = 'active'")
    .all(studentId).map(r => r.parent_id);
}

module.exports = { send, parentsOf, listeners };
