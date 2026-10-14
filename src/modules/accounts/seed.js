'use strict';
// Demo rows for the accounts module's private tables (run by scripts/seed.js
// after the core data). Local demo values only.

const notify = require('../../notify');
const u = require('./util');

const DAY = 24 * 3600 * 1000;

module.exports = (ctx, demo) => {
  const db = ctx.db;
  const now = demo.NOW;
  const invite = (kind, by, userId, name, email, phone, code, created, accepted) => db.prepare(`INSERT INTO account_invites
    (kind, invited_by, user_id, name, email, phone, code_hash, created_at, expires_at, accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(kind, by.id, userId, name, email, phone, u.hashCode(code), created, created + 7 * DAY, accepted);
  const parentByEmail = email => demo.families.map(f => f.parent).find(p => p.email === email);

  // Lily Chen accepted her invite; Wei Chen still has to approve her (D-20).
  const { chen, chenKid } = demo.extra;
  invite('student', chen, chenKid.id, chenKid.name, chenKid.email, null, u.newCode(), now - 2 * DAY, now - DAY);
  notify.send(ctx, [chen.id], {
    kind: 'account_student_accepted', title: 'Lily accepted your invite',
    body: 'Approve Lily in Family so they can sign in to ELITE Spaces.', refType: 'user', refId: chenKid.id,
  });

  // The Nguyens invited a second student who hasn't opened the invite yet.
  const nguyen = parentByEmail('nguyen@family.test');
  if (nguyen) {
    const minh = Number(db.prepare(`INSERT INTO users (role, name, email, phone, password_hash, location_id, created_at)
      VALUES ('student', 'Minh Nguyen', NULL, '555-0123', NULL, ?, ?)`).run(nguyen.location_id, now).lastInsertRowid);
    db.prepare("INSERT INTO family_links (parent_id, student_id, status, created_at) VALUES (?, ?, 'pending', ?)").run(nguyen.id, minh, now);
    invite('student', nguyen, minh, 'Minh Nguyen', 'minh.nguyen@family.test', '555-0123', 'DEMO-MINH', now - 3600 * 1000, null);
  }

  // Maria Garcia invited a second guardian who hasn't joined yet.
  const garcia = parentByEmail('garcia@family.test');
  if (garcia) invite('guardian', garcia, null, 'Luis Garcia', 'luis.garcia@family.test', null, 'DEMO-LUIS', now - DAY, null);

  // Mark Johnson joined through Erin's guardian invite last month.
  const erin = parentByEmail('johnson@family.test');
  if (erin && demo.extra.mark) invite('guardian', erin, demo.extra.mark.id, 'Mark Johnson', demo.extra.mark.email, null, u.newCode(), now - 30 * DAY, now - 29 * DAY);

  // Sam Rivera still uses the temporary password his director set (D-21).
  const sam = db.prepare("SELECT id FROM users WHERE email = 'sam.irvine@elitespaces.test'").get();
  if (sam) db.prepare('INSERT INTO account_temp_passwords (user_id, set_by, created_at) VALUES (?,?,?)').run(sam.id, demo.dirIrvine.id, now);

  console.log('  Demo invite codes: DEMO-MINH (student, Nguyen family), DEMO-LUIS (guardian, Garcia family)');
};
