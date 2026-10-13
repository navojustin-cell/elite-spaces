'use strict';
// Module: sessions - PRD 2. Sessions and scheduling (SC-1..SC-4).
// Exports router(ctx), mounted at /api/sessions, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
