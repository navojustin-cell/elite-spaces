'use strict';
// The eight v1 modules. Each lives in its own folder and owns its own routes
// (mounted at /api/<name>), schema file, view, tests and mutations.
module.exports = ['accounts', 'checkin', 'sessions', 'enrollment', 'membership', 'announcements', 'notes', 'attendance']
  .map(name => Object.assign({ name }, require('./' + name)));
