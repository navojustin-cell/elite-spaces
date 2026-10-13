'use strict';
// Module: notes - PRD 6. Daily notes (DN-1..DN-5).
// Exports router(ctx), mounted at /api/notes, and jobs: [{ name, run(ctx) }]
// for anything that must happen on a schedule.

const express = require('express');

module.exports = {
  router(ctx) {
    const r = express.Router();
    return r;
  },
  jobs: [],
};
