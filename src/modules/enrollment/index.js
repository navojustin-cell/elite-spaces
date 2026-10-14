'use strict';
// Module: enrollment - PRD 3. Enrollment and waitlists (EN-1..EN-7, NF-3).
// Mounted at /api/enrollment. Rules live in service.js; this file is routes
// and scope. Families act only for their own linked students (NF-1); staff at
// the student's location and HQ may read a student's catalog and schedule.

const express = require('express');
const auth = require('../../auth');
const svc = require('./service');

// Blocked and full are answers, not crashes: 409 with the reason, so the app
// can show it and (for full) offer the waitlist.
function reply(res, out, okStatus = 201) {
  if (out.outcome === 'blocked' || out.outcome === 'full') {
    return res.status(409).json({ error: out.code, outcome: out.outcome, message: out.message, waiting: out.waiting });
  }
  res.status(okStatus).json(out);
}

const body = req => req.body || {};

module.exports = {
  router(ctx) {
    const r = express.Router();
    const family = auth.requireRole('parent', 'student');
    const parent = auth.requireRole('parent');

    // The caller's students (a parent's linked students, or the student themself).
    r.get('/students', family, (req, res) => res.json({ students: svc.familyStudents(ctx, req.user) }));

    r.get('/students/:id/catalog', auth.requireRole(), (req, res) => {
      auth.assertSeeStudent(ctx, req.user, req.params.id);
      res.json(svc.catalog(ctx, svc.getStudent(ctx, req.params.id)));
    });

    r.get('/students/:id/schedule', auth.requireRole(), (req, res) => {
      auth.assertSeeStudent(ctx, req.user, req.params.id);
      res.json(svc.schedule(ctx, svc.getStudent(ctx, req.params.id), req.query));
    });

    r.post('/enroll', parent, (req, res) => reply(res, svc.enroll(ctx, req.user, body(req))));
    r.post('/waitlist', parent, (req, res) => reply(res, svc.joinWaitlist(ctx, req.user, body(req))));
    r.post('/waitlist/:id/leave', parent, (req, res) => res.json({ waitlist: svc.leaveWaitlist(ctx, req.user, req.params.id) }));
    r.post('/enrollments/:id/drop', parent, (req, res) => res.json({ enrollment: svc.drop(ctx, req.user, req.params.id) }));

    r.get('/requests', family, (req, res) => res.json({ requests: svc.listRequests(ctx, req.user) }));
    r.post('/requests', auth.requireRole('student'), (req, res) => res.status(201).json({ request: svc.createRequest(ctx, req.user, body(req)) }));
    r.post('/requests/:id/approve', parent, (req, res) => res.json(svc.decide(ctx, req.user, req.params.id, true)));
    r.post('/requests/:id/decline', parent, (req, res) => res.json(svc.decide(ctx, req.user, req.params.id, false)));

    return r;
  },
  // EN-5: seats freed by membership pauses or capacity raises are filled too.
  jobs: [{ name: 'promote-waitlists', run: ctx => svc.promoteAll(ctx) }],
};
