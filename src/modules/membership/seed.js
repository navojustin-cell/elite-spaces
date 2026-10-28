'use strict';
// Demo rows for the membership module: what the seeded memberships would already
// have behind them. Isha Patel's membership ends in 10 days, so her parent got the
// 14-day reminder a few days ago; Daniel Kim's was set inactive by staff after it ran out.
const DAY = 86400000;

module.exports = (ctx, demo) => {
  const db = ctx.db;
  const student = name => demo.families.flatMap(f => f.students).find(s => s.name === name);
  const membership = s => db.prepare('SELECT * FROM memberships WHERE student_id = ?').get(s.id);
  const pick = m => ({ status: m.status, weekly_cap: m.weekly_cap, start_date: m.start_date, expires_on: m.expires_on });

  const isha = student('Isha Patel');
  if (isha) {
    const m = membership(isha);
    const sent = demo.NOW - 4 * DAY;
    db.prepare("INSERT OR IGNORE INTO membership_notices (student_id, expires_on, kind, sent_at) VALUES (?,?,'remind14',?)").run(isha.id, m.expires_on, sent);
    const parent = demo.families.find(f => f.students.includes(isha)).parent;
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(isha.location_id);
    const when = new Date(m.expires_on + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    db.prepare(`INSERT INTO notifications (user_id, kind, title, body, ref_type, ref_id, created_at, delivered_at)
      VALUES (?, 'membership_reminder', ?, ?, 'membership', ?, ?, ?)`).run(parent.id, `Isha's membership ends ${when}`,
      `That's in 14 days. Renew with the front desk at ${loc.name} to keep Isha's schedule.`, m.id, sent, sent);
  }

  const daniel = student('Daniel Kim');
  if (daniel) {
    const m = membership(daniel);
    db.prepare(`INSERT INTO audit_log (actor_id, action, target_type, target_id, location_id, detail, at)
      VALUES (?, 'membership.update', 'membership', ?, ?, ?, ?)`).run(demo.staffIrvine.id, m.id, daniel.location_id,
      JSON.stringify({ student_id: daniel.id, before: Object.assign(pick(m), { status: 'active' }), after: pick(m) }), demo.NOW - 13 * DAY);
  }
};
