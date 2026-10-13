'use strict';
// The eight v1 modules. Each lives in its own folder and owns its own routes
// (mounted at /api/<name>), schema file, view, tests and mutations.
// ELITE_MODULES (set by scoped test runs) limits which modules load.
const ALL = ['accounts', 'checkin', 'sessions', 'enrollment', 'membership', 'announcements', 'notes', 'attendance'];
const sel = process.env.ELITE_MODULES;
const names = sel == null ? ALL : sel.split(',').filter(n => ALL.includes(n));
module.exports = names.map(name => Object.assign({ name }, require('./' + name)));
