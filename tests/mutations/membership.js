'use strict';
// Membership mutations: each breaks one membership rule; membership.test.js must catch it.
const R = 'src/modules/membership/index.js';
const S = 'src/modules/membership/service.js';
const V = 'public/js/views/membership.js';

module.exports = [
  // MB-1: the record and its state
  { name: 'accept any status', covers: ['MB-1'], file: R,
    find: "if (!['active', 'inactive'].includes(b.status)) throw", repl: 'if (false) throw' },
  { name: 'accept any weekly limit', covers: ['MB-1'], file: R,
    find: 'if (!(cap >= 1 && cap <= CAP_MAX)) throw', repl: 'if (false) throw' },
  { name: 'allow a last day before the start date', covers: ['MB-1'], file: R,
    find: 'if (b.expires_on < b.start_date) throw', repl: 'if (false) throw' },
  { name: 'call the last valid day expired', covers: ['MB-1'], file: S,
    find: "days_left < 0 ? 'expired'", repl: "days_left <= 0 ? 'expired'" },
  { name: 'shrink the ending-soon window', covers: ['MB-1'], file: S,
    find: "days_left <= SOON_DAYS ? 'ending'", repl: "days_left < SOON_DAYS ? 'ending'" },
  { name: 'show an inactive membership as active', covers: ['MB-1', 'MB-3'], file: S,
    find: "m.status !== 'active' ? 'inactive'", repl: "false ? 'inactive'" },

  // MB-2 / D-22: staff edits, no payment data
  { name: 'store a body with payment fields in it', covers: ['MB-2'], file: R,
    find: 'if (extra.length) {', repl: 'if (false) {' },
  { name: 'let families edit memberships', covers: ['MB-2', 'NF-1'], file: R,
    find: "r.put('/student/:id', auth.requireRole('staff'),", repl: "r.put('/student/:id', auth.requireRole()," },
  { name: 'ignore a changed weekly limit', covers: ['MB-2'], file: R,
    find: 'weekly_cap = excluded.weekly_cap,', repl: 'weekly_cap = memberships.weekly_cap,' },

  // NF-2: every change is logged
  { name: 'skip the audit log on membership edits', covers: ['NF-2'], file: R,
    find: "audit.log(ctx, req.user, before ? 'membership.update' : 'membership.create', {",
    repl: "(() => {})(ctx, req.user, before ? 'membership.update' : 'membership.create', {" },
  { name: 'log the new values as the old ones', covers: ['NF-2'], file: R,
    find: 'before: pick(before), after: pick(after)', repl: 'before: pick(after), after: pick(after)' },
  { name: 'show families the staff change log', covers: ['NF-1', 'NF-2'], file: R,
    find: "if (auth.atLeast(req.user, 'staff')) out.history", repl: 'if (true) out.history' },

  // MB-3: families can see it
  { name: 'show parents none of their students', covers: ['MB-3'], file: R,
    find: 'auth.linkedStudentIds(ctx, req.user.id)', repl: '[]' },
  { name: 'show students nothing of their own', covers: ['MB-3'], file: R,
    find: "req.user.role === 'student' ? [req.user.id] :", repl: "req.user.role === 'student' ? [] :" },

  // NF-1: scope on every route
  { name: 'let anyone read or edit any student', covers: ['NF-1'], file: R,
    find: 'auth.assertSeeStudent(ctx, user, id);', repl: '' },
  { name: 'let staff open another location\'s roster', covers: ['NF-1'], file: R,
    find: 'auth.assertManageLocation(req.user, locId);', repl: '' },
  { name: 'list students from every location on the roster', covers: ['NF-1'], file: R,
    find: "WHERE role = 'student' AND active = 1 AND location_id = ? ORDER BY name",
    repl: "WHERE role = 'student' AND active = 1 AND location_id > ? - 1000000 ORDER BY name" },
  { name: 'let staff use the family membership list', covers: ['NF-1'], file: R,
    find: "r.get('/mine', auth.requireRole('parent', 'student'),", repl: "r.get('/mine', auth.requireRole()," },

  // MB-4: reminders
  { name: 'skip the daily membership job', covers: ['MB-4', 'MB-5'], file: R,
    find: 'run: ctx => svc.runExpiry(ctx)', repl: 'run: () => {}' },
  { name: 'send the 14-day reminder a day late', covers: ['MB-4'], file: S,
    find: "days <= SOON_DAYS ? 'remind14'", repl: "days < SOON_DAYS ? 'remind14'" },
  { name: 'send the 3-day reminder a day late', covers: ['MB-4'], file: S,
    find: "days <= LAST_CALL ? 'remind3'", repl: "days < LAST_CALL ? 'remind3'" },
  { name: 'send reminders again on every run', covers: ['MB-4'], file: S,
    find: '.changes) === 1;', repl: '.changes) >= 0;' },
  { name: 'remind the student instead of the parents', covers: ['MB-4'], file: S,
    find: 'notify.send(ctx, notify.parentsOf(ctx, m.student_id), {', repl: 'notify.send(ctx, [m.student_id], {' },
  { name: 'remind inactive memberships too', covers: ['MB-4'], file: S,
    find: "WHERE m.status = 'active' ORDER BY m.id", repl: 'WHERE 1 = 1 ORDER BY m.id' },
  { name: 'count days on the UTC date, not the location\'s', covers: ['MB-4', 'MB-5'], file: S,
    find: 'const todayAt = (ctx, loc) => time.localDate(loc, ctx.clock.now());',
    repl: "const todayAt = (ctx, loc) => time.localDate({ timezone: 'UTC' }, ctx.clock.now());" },

  // MB-5 / D-16: pause and restore
  { name: 'pause on the last valid day', covers: ['MB-5'], file: S,
    find: 'if (days < 0) {', repl: 'if (days <= 0) {' },
  { name: 'drop enrollments instead of pausing them', covers: ['MB-5'], file: S,
    find: "SET status = 'paused' WHERE student_id = ? AND status = 'active'", repl: "SET status = 'dropped' WHERE student_id = ? AND status = 'active'" },
  { name: 'tell no one when a membership ends', covers: ['MB-5'], file: S,
    find: "if (!claim(ctx, m, 'expired')) return;", repl: 'if (true) return;' },
  { name: 'staff deactivation pauses nothing', covers: ['MB-5'], file: R,
    find: 'if (svc.isValid(after, today)) {', repl: 'if (true) {' },
  { name: 'treat the last day as already past', covers: ['MB-5'], file: S,
    find: "m.status === 'active' && today <= m.expires_on", repl: "m.status === 'active' && today < m.expires_on" },
  { name: 'tell no one when staff pause sessions', covers: ['MB-5'], file: R,
    find: 'if (paused) svc.notifyPaused(', repl: 'if (false) svc.notifyPaused(' },
  { name: 'renewal restores nothing', covers: ['MB-5'], file: R,
    find: 'restored = svc.restore(ctx, after, today, req.user.id);', repl: 'restored = { back: [], waitlisted: [], kept: [] };' },
  { name: 'restore into a slot that is already full', covers: ['MB-5'], file: S,
    find: 'if (taken < e.capacity) {', repl: 'if (taken <= e.capacity) {' },
  { name: 'leave a full slot paused instead of dropped', covers: ['MB-5'], file: S,
    find: "SET status = 'dropped', ended_at = ? WHERE id = ?", repl: "SET status = 'paused', ended_at = ? WHERE id = ?" },
  { name: 'put a renewed student at the back of the waitlist', covers: ['MB-5'], file: S,
    find: "VALUES (?,?,?,'waiting',1,?,?)", repl: "VALUES (?,?,?,'waiting',0,?,?)" },
  { name: 'leave an existing waitlist place where it was', covers: ['MB-5'], file: S,
    find: "'UPDATE waitlist SET priority = 1 WHERE id = ?'", repl: "'UPDATE waitlist SET priority = 0 WHERE id = ?'" },
  { name: 'tell no one when sessions come back', covers: ['MB-5'], file: R,
    find: 'svc.notifyRestored(ctx, student, after, restored);', repl: '' },

  // MB-5 with D-3: renewal respects the weekly cap; ended terms are left alone
  { name: 'restore past the weekly cap', covers: ['MB-5'], file: S,
    find: 'if (used.get(studentId, today).n >= m.weekly_cap) {', repl: 'if (false) {' },
  // The old per-term count: only slots in terms overlapping the paused slot's term, unlike enrollment's cap.
  { name: 'count the cap only within the paused slot\'s term', covers: ['MB-5'], file: S,
    find: 'if (used.get(studentId, today).n >= m.weekly_cap) {',
    repl: "if (db.prepare(`SELECT COUNT(*) AS n FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id " +
      "WHERE e.student_id = ? AND e.status = 'active' AND s.status = 'active' AND t.start_date <= " +
      "(SELECT t2.end_date FROM sessions s2 JOIN terms t2 ON t2.id = s2.term_id WHERE s2.id = ?) AND t.end_date >= " +
      "(SELECT t2.start_date FROM sessions s2 JOIN terms t2 ON t2.id = s2.term_id WHERE s2.id = ?)`)" +
      '.get(studentId, e.session_id, e.session_id).n >= m.weekly_cap) {' },
  { name: 'count slots from ended terms against the cap on renewal', covers: ['MB-5'], file: S,
    find: "AND s.status = 'active' AND t.end_date >= ?`);", repl: "AND s.status = 'active' AND ? IS NOT NULL`);" },
  { name: 'never tell the family which sessions stay paused', covers: ['MB-5'], file: S,
    find: 'if (kept.length) {', repl: 'if (false) {' },
  { name: 'report no sessions kept paused to staff', covers: ['MB-5'], file: R,
    find: 'kept_paused: restored.kept.length', repl: 'kept_paused: 0' },
  { name: 'restore sessions from a term that has ended', covers: ['MB-5'], file: S,
    find: "WHERE e.student_id = ? AND e.status = 'paused' AND t.end_date >= ? ORDER BY e.id", repl: "WHERE e.student_id = ? AND e.status = 'paused' AND ? IS NOT NULL ORDER BY e.id" },
  { name: 'count sessions from terms that have ended', covers: ['MB-5'], file: S,
    find: 'WHERE e.student_id = ? AND t.end_date >= ?`).get(studentId, today);', repl: 'WHERE e.student_id = ? AND ? IS NOT NULL`).get(studentId, today);' },

  // NF-4 / D-16: "today" is the student's location's date, never UTC's (an LA evening is already tomorrow in UTC).
  { name: 'a staff save pauses or restores by the UTC date', covers: ['MB-5'], file: R,
    find: 'const today = svc.todayAt(ctx, svc.studentLocation(ctx, student.id));', repl: "const today = svc.todayAt(ctx, { timezone: 'UTC' });" },
  { name: 'the roster shows each state on the UTC date', covers: ['MB-1'], file: R,
    find: "if (!loc) throw notFound('No such location.');\n      const today = svc.todayAt(ctx, loc);",
    repl: "if (!loc) throw notFound('No such location.');\n      const today = svc.todayAt(ctx, { timezone: 'UTC' });" },
  { name: 'families see the state on the UTC date', covers: ['MB-3'], file: R,
    find: 'const loc = svc.studentLocation(ctx, student.id);\n  const today = svc.todayAt(ctx, loc);',
    repl: "const loc = svc.studentLocation(ctx, student.id);\n  const today = svc.todayAt(ctx, { timezone: 'UTC' });" },
  // MB-5: only slots with weeks left are paused, so the family's notice counts real sessions.
  { name: 'pause slots from terms that have ended', covers: ['MB-5'], file: S,
    find: 'AND session_id IN (SELECT s.id FROM sessions s JOIN terms t ON t.id = s.term_id WHERE t.end_date >= ?)`).run(studentId, today)',
    repl: 'AND ? IS NOT NULL`).run(studentId, today)' },
  // MB-1: the last day must be a real calendar date.
  { name: 'accept a last day that is not a real date', covers: ['MB-1'], file: R,
    find: "if (!isDate(b.expires_on)) throw bad('expires_on'", repl: "if (false) throw bad('expires_on'" },

  // MB-1: the roster names each account's state as People's roster decides it.
  { name: 'every account no parent approved yet is called waiting for approval', covers: ['MB-1'], file: R,
    find: "account: ps.length ? 'active' : s.accepted ? 'awaiting_approval' : 'invited',", repl: "account: ps.length ? 'active' : 'awaiting_approval'," },

  // ---- the Members screen and Home card (views/membership.js) ----
  { name: 'Members words an unapproved account its own way, not as People does', covers: ['MB-1'], file: V,
    find: "const ACCOUNT = { awaiting_approval: 'Waiting for parent approval', invited: 'Invited, not set up yet' };",
    repl: "const ACCOUNT = { awaiting_approval: 'Waiting for a parent to approve the account', invited: 'Waiting for a parent to approve the account' };" },
  { name: 'the Members table cannot be scrolled from the keyboard', covers: ['MB-1'], file: V,
    find: "tabindex: '0', role: 'region', 'aria-label': title }", repl: "role: 'region', 'aria-label': title }" },
  { name: 'the Members table scroll box has no name', covers: ['MB-1'], file: V,
    find: "tabindex: '0', role: 'region', 'aria-label': title }", repl: "tabindex: '0', role: 'region' }" },
  { name: 'the Members filter tabs wrap their labels onto several lines', covers: ['MB-1'], file: V,
    find: '.mb-tabs button { flex: none; white-space: nowrap;', repl: '.mb-tabs button {' },
  { name: 'the Members filter tabs lose their one-row style', covers: ['MB-1'], file: V,
    find: "class: 'tabs mb-tabs'", repl: "class: 'tabs'" },
  { name: "a student's Home card words a lapse differently from Schedule", covers: ['MB-3', 'MB-5'], file: V,
    find: "? (paused ? 'Your membership isn\\'t active, so your sessions are paused. ' : 'Your membership isn\\'t active. ') + renew",
    repl: "? 'Your membership isn\\'t active right now. ' + renew" },
];
