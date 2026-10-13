'use strict';
// Module: announcements - PRD 5. Announcements and emergency alerts (AN-1..AN-6).
// Exports router(ctx), mounted at /api/announcements, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
