'use strict';
// Module: enrollment - PRD 3. Enrollment and waitlists (EN-1..EN-7).
// Exports router(ctx), mounted at /api/enrollment, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
