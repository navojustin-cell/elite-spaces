'use strict';
// Module: membership - PRD 4. Membership status (MB-1..MB-5).
// Exports router(ctx), mounted at /api/membership, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
