'use strict';
// Module: attendance - PRD 7. Attendance and hours export (AT-1..AT-4).
// Exports router(ctx), mounted at /api/attendance, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
