'use strict';
// Module: accounts - PRD Users and roles (AC-1..AC-6).
// Exports router(ctx), mounted at /api/accounts, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
