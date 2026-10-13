'use strict';
// Foundation mutations: each breaks one core rule; core.test.js must catch it.
module.exports = [
  { name: 'let a pending-link student sign in', covers: ['CORE'], file: 'src/auth.js',
    find: "if (row.role === 'student' && !studentLinked(ctx, row.id)) {", repl: 'if (false) {' },
  { name: 'accept any password', covers: ['CORE'], file: 'src/auth.js',
    find: 'if (!row || !verifyPassword(password, row.password_hash))', repl: 'if (!row)' },
  { name: 'let staff see students at any location', covers: ['CORE'], file: 'src/auth.js',
    find: "s.location_id === user.location_id;", repl: 'true;' },
  { name: 'let parents see any student', covers: ['CORE'], file: 'src/auth.js',
    find: "if (user.role === 'parent') return linkedStudentIds(ctx, user.id).includes(studentId);", repl: "if (user.role === 'parent') return true;" },
  { name: 'flatten the role ladder', covers: ['CORE'], file: 'src/auth.js',
    find: '(OPS_RANK[user.role] || 0) >= OPS_RANK[role]', repl: '(OPS_RANK[user.role] || 0) > 0' },
  { name: 'show every user every notification', covers: ['CORE'], file: 'src/app.js',
    find: "SELECT * FROM notifications WHERE user_id = ? ORDER BY", repl: "SELECT * FROM notifications WHERE user_id > ?-1000000 ORDER BY" },
  { name: 'compute local dates in UTC', covers: ['CORE'], file: 'src/time.js',
    find: "const local = (loc, ms) => DateTime.fromMillis(ms, { zone: loc.timezone });", repl: "const local = (loc, ms) => DateTime.fromMillis(ms, { zone: 'UTC' });" },
  { name: 'let inactive accounts sign in', covers: ['CORE'], file: 'src/auth.js',
    find: "if (!row.active) throw", repl: "if (false) throw" },
];
