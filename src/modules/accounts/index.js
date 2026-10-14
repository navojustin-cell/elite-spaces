'use strict';
// Module: accounts - PRD Users and roles (AC-1..AC-6), decisions D-5, D-20, D-21.
// Mounted at /api/accounts. family.js: parent sign-up, student and guardian
// invites, approvals (the family side). ops.js: staff, directors, locations and
// the staff-facing roster (the operations side). No scheduled jobs: invite
// expiry is checked whenever a code is used.

const express = require('express');
const family = require('./family');
const ops = require('./ops');

module.exports = {
  router(ctx) {
    const r = express.Router();
    family.routes(r, ctx);
    ops.routes(r, ctx);
    return r;
  },
  jobs: [],
};
