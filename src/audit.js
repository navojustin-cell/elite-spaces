'use strict';
// Every staff edit is logged with who did it (privacy and safety requirement).
function log(ctx, actor, action, { targetType, targetId, locationId, detail } = {}) {
  ctx.db.prepare(
    'INSERT INTO audit_log (actor_id, action, target_type, target_id, location_id, detail, at) VALUES (?,?,?,?,?,?,?)'
  ).run(actor ? actor.id : null, action, targetType || null, targetId ?? null, locationId ?? null,
    detail ? JSON.stringify(detail) : null, ctx.clock.now());
}
module.exports = { log };
