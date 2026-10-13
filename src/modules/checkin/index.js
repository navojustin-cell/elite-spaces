'use strict';
// Module: checkin - PRD 1. Check-in and check-out (CI-1..CI-7).
// Exports router(ctx), mounted at /api/checkin, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
