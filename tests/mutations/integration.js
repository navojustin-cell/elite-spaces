'use strict';
// Integration mutations: each breaks a contract between modules (docs/decisions.md
// D-26); tests/integration.test.js catches each one on its own, with every module loaded.
module.exports = [
  { name: 'attendance ignores the enrollment status log, so a slot kept paused counts as missed', covers: ['AT-2', 'MB-5'],
    file: 'src/modules/attendance/service.js', find: 'if (pausedAt(statusLog.get(e.id), start)) continue;', repl: '' },
  { name: 'enrollment status changes are not logged, so paused weeks read as absent', covers: ['EN-7', 'MB-5'],
    file: 'schema/040_enrollment.sql',
    find: 'INSERT INTO enrollment_status_log (enrollment_id, from_status, to_status, at) VALUES (NEW.id, OLD.status, NEW.status, app_now());',
    repl: 'SELECT 1;' },
  { name: 'auto check-out does not flag the visit, so Hours and reports never show it needs review', covers: ['CI-5', 'AT-1'],
    file: 'src/modules/checkin/service.js',
    find: "UPDATE visits SET check_out_at = ?, checkout_method = 'auto', flagged = 1, flag_reason = ?",
    repl: "UPDATE visits SET check_out_at = ?, checkout_method = 'auto', flagged = 0, flag_reason = ?" },
  { name: 'a staff-set closure is not checked by the scan', covers: ['SC-3', 'CI-3'],
    file: 'src/modules/checkin/service.js',
    find: "if (ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date)) return [];", repl: '' },
  // v1.1 flows (docs/v1.1-design.md 5.2).
  { name: "check-in ignores a schedule's date changes, so a moved date can't check in (flow 1)", covers: ['SC-5', 'CI-3'],
    file: 'src/modules/checkin/service.js',
    find: 'const ov = dates.overrides(ctx, [...new Set(rows.map(r => r.session_id))]);', repl: 'const ov = new Map();' },
  { name: "a posted note leaves out the student's goals (flow 2)", covers: ['DN-2', 'DN-5'],
    file: 'src/modules/notes/index.js',
    find: 'goals: goalDay(db, n.student_id, n.local_date).items,', repl: 'goals: [],' },
  { name: 'the missed-day job is not scheduled, so no parent is told (flow 3)', covers: ['AT-5'],
    file: 'src/modules/attendance/index.js',
    find: "jobs: [{ name: 'missed-day', run: ctx => svc.runMissedDays(ctx) }],", repl: 'jobs: [],' },
  { name: 'an ended alert stays pinned (flow 4)', covers: ['AN-7'],
    file: 'src/modules/announcements/index.js',
    find: 'const active = visible(ctx, u, ACTIVE_ALERT + NOT_ENDED,', repl: 'const active = visible(ctx, u, ACTIVE_ALERT,' },
  { name: 'a switch frees a seat but its line is not promoted in the same request (flow 5)', covers: ['EN-5', 'EN-8'],
    file: 'src/modules/enrollment/service.js',
    find: 'for (const e of ended) promoteSchedule(ctx, e.session_id);', repl: '' },
];
