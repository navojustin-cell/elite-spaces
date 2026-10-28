'use strict';
// Module: membership - PRD 4. Membership status (MB-1..MB-5), D-16, D-22.
//
// Routes, mounted at /api/membership:
//   GET /mine          parent: each linked student's membership; student: their own (MB-3)
//   GET /roster        staff+: every student at a location with their membership state
//                      (staff/director: own location; HQ: ?location_id= required)
//   GET /student/:id   anyone who may see the student (NF-1); staff+ also get the change history
//   PUT /student/:id   staff+ at the student's location, HQ any: create or replace the record (MB-2).
//                      Audited with before/after (NF-2). Unknown fields, such as payment details,
//                      are refused and never stored (D-22). Pauses or restores whole schedules (MB-5,
//                      D-16, D-16a); the weekly cap can't go below a held schedule's days a week (D-27).
// Every read carries active_schedules, paused_schedules, held_days and the schedules themselves.
// Job: expiry - reminders 14 and 3 days ahead, and pausing once the last day has passed.
// Job: starts - on a membership's start date, schedules paused until then come back (D-32).

const express = require('express');
const { DateTime } = require('luxon');
const { tx } = require('../../db');
const auth = require('../../auth');
const audit = require('../../audit');
const { bad, notFound, conflict } = require('../../errors');
const svc = require('./service');

const FIELDS = ['status', 'weekly_cap', 'start_date', 'expires_on'];
const CAP_MAX = 14;

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
const pick = m => (m ? { status: m.status, weekly_cap: m.weekly_cap, start_date: m.start_date, expires_on: m.expires_on } : null);

// The four membership fields, checked. Anything else in the body is refused (D-22).
function readBody(b) {
  b = b && typeof b === 'object' ? b : {};
  const extra = Object.keys(b).filter(k => !FIELDS.includes(k));
  if (extra.length) {
    throw bad('unknown_field', `ELITE Spaces doesn't store "${extra[0]}". A membership holds only its status, weekly limit and dates. Payment details stay in your billing system.`);
  }
  if (!['active', 'inactive'].includes(b.status)) throw bad('status', 'Choose Active or Inactive.');
  // L56: only a number or a string of digits. String() of a parsed {toString: 1} throws (a 500),
  // and String([3]) reads as "3".
  const w = b.weekly_cap;
  const cap = (typeof w === 'number' || typeof w === 'string') && /^\d+$/.test(String(w)) ? Number(w) : NaN;
  if (!(cap >= 1 && cap <= CAP_MAX)) throw bad('weekly_cap', `Set the weekly limit to a whole number from 1 to ${CAP_MAX}.`);
  if (!isDate(b.start_date)) throw bad('start_date', 'Choose a start date.');
  if (!isDate(b.expires_on)) throw bad('expires_on', 'Choose the last day of the membership.');
  if (b.expires_on < b.start_date) throw bad('expires_on', 'The last day must be on or after the start date.');
  return { status: b.status, weekly_cap: cap, start_date: b.start_date, expires_on: b.expires_on };
}

// The student, after the scope check (NF-1). Unknown ids are 403 for everyone but HQ.
function loadStudent(ctx, user, rawId) {
  const id = Number(rawId);
  auth.assertSeeStudent(ctx, user, id);
  const s = ctx.db.prepare("SELECT id, name, location_id, active FROM users WHERE id = ? AND role = 'student'").get(id);
  if (!s) throw notFound('No such student.');
  return s;
}

const membershipOf = (ctx, studentId) => ctx.db.prepare('SELECT * FROM memberships WHERE student_id = ?').get(studentId);

function history(ctx, m) {
  if (!m) return [];
  return ctx.db.prepare(`SELECT a.at, a.action, a.detail, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.target_type = 'membership' AND a.target_id = ? ORDER BY a.at DESC, a.id DESC LIMIT 20`).all(m.id)
    .map(r => { const d = JSON.parse(r.detail || '{}'); return { at: r.at, action: r.action, actor: r.actor, before: d.before, after: d.after }; });
}

// One student's membership as families and staff see it.
function summary(ctx, student) {
  const loc = svc.studentLocation(ctx, student.id);
  const today = svc.todayAt(ctx, loc);
  return {
    student: { id: student.id, name: student.name }, location: loc, today,
    membership: svc.describe(membershipOf(ctx, student.id), today), ...svc.scheduleCounts(ctx, student.id, today),
  };
}

module.exports = {
  router(ctx) {
    const r = express.Router();
    const db = ctx.db;

    // MB-3: a parent's linked students, or the student themselves.
    r.get('/mine', auth.requireRole('parent', 'student'), (req, res) => {
      const ids = req.user.role === 'student' ? [req.user.id] : auth.linkedStudentIds(ctx, req.user.id);
      const members = ids.map(id => db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'student'").get(id))
        .filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(s => summary(ctx, s));
      res.json({ members });
    });

    // Staff "Members" screen: every active student at the location.
    r.get('/roster', auth.requireRole('staff'), (req, res) => {
      const raw = req.query.location_id;
      const locId = raw != null && raw !== '' ? Number(raw) : req.user.location_id;
      if (!locId) throw bad('location', 'Choose a location.');
      auth.assertManageLocation(req.user, locId);
      const loc = db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(locId);
      if (!loc) throw notFound('No such location.');
      const today = svc.todayAt(ctx, loc);
      const parents = db.prepare(`SELECT p.name FROM family_links fl JOIN users p ON p.id = fl.parent_id
        WHERE fl.student_id = ? AND fl.status = 'active' ORDER BY p.name`);
      const students = db.prepare("SELECT id, name, password_hash IS NOT NULL AS accepted FROM users WHERE role = 'student' AND active = 1 AND location_id = ? ORDER BY name")
        .all(loc.id).map(s => {
          const ps = parents.all(s.id).map(p => p.name);
          return { id: s.id, name: s.name, parents: ps, linked: ps.length > 0,
            // The account's state, decided the way People's roster decides it (accounts):
            // a parent approved the link, or the student set a password and waits for that, or not even that yet.
            account: ps.length ? 'active' : s.accepted ? 'awaiting_approval' : 'invited',
            membership: svc.describe(membershipOf(ctx, s.id), today), ...svc.scheduleCounts(ctx, s.id, today) };
        });
      res.json({ location: loc, today, soon_days: svc.SOON_DAYS, students });
    });

    r.get('/student/:id', auth.requireRole(), (req, res) => {
      const student = loadStudent(ctx, req.user, req.params.id);
      const out = summary(ctx, student);
      if (auth.atLeast(req.user, 'staff')) out.history = history(ctx, membershipOf(ctx, student.id));
      res.json(out);
    });

    // MB-2: staff create or update the record by hand. NF-2: every change is logged.
    r.put('/student/:id', auth.requireRole('staff'), (req, res) => {
      const student = loadStudent(ctx, req.user, req.params.id);
      // L65: a retired account (such as a cancelled invite) is on no staff list and gets no membership.
      if (!student.active) throw notFound('No such student.');
      const input = readBody(req.body);
      const result = tx(db, () => {
        const before = membershipOf(ctx, student.id);
        const changed = !before || FIELDS.some(k => before[k] !== input[k]);
        const today = svc.todayAt(ctx, svc.studentLocation(ctx, student.id));
        // D-27: the weekly cap is days a week, so it can't be lowered below the days a
        // week of a schedule the student holds while that schedule stays active.
        const held = svc.heldDays(ctx, student.id, today);
        if (svc.isValid(input, today) && input.weekly_cap < held.days && (!before || input.weekly_cap < before.weekly_cap)) {
          const first = String(student.name).split(' ')[0];
          throw conflict('weekly_cap_below_held', `${first} holds ${held.name} (${held.days} day${held.days === 1 ? '' : 's'} a week), ` +
            `so the weekly limit can't go below ${held.days}. A parent can switch to a schedule with fewer days, or drop it, first.`);
        }
        if (changed) {
          db.prepare(`INSERT INTO memberships (student_id, status, weekly_cap, start_date, expires_on, updated_by, updated_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET status = excluded.status, weekly_cap = excluded.weekly_cap,
            start_date = excluded.start_date, expires_on = excluded.expires_on, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(student.id, input.status, input.weekly_cap, input.start_date, input.expires_on, req.user.id, ctx.clock.now());
        }
        const after = membershipOf(ctx, student.id);
        if (changed) {
          audit.log(ctx, req.user, before ? 'membership.update' : 'membership.create', {
            targetType: 'membership', targetId: after.id, locationId: student.location_id,
            detail: { student_id: student.id, before: pick(before), after: pick(after) },
          });
        }
        // MB-5 / D-16: no longer valid -> pause; valid again -> restore or front of the waitlist,
        // for each schedule whose days fit the weekly cap (D-16a); one over the cap stays paused.
        // D-32: before its start date it isn't valid yet, so schedules stay paused (or are paused) until that day.
        let paused = [], restored = { back: [], waitlisted: [], kept: [] };
        if (svc.isValid(after, today)) {
          restored = svc.restore(ctx, after, today, req.user.id);
          svc.notifyRestored(ctx, student, after, restored);
        } else {
          paused = svc.pause(ctx, student.id, today);
          if (paused.length) {
            svc.notifyPaused(ctx, student, after, paused, today);
            // L57: a last day already past: this is the family's one notice that it ended, so the
            // daily job doesn't send a second one that leaves out the paused schedules.
            if (after.status === 'active' && after.expires_on < today) svc.claim(ctx, after, 'expired');
          }
        }
        // D-32: not started yet -> the daily job brings the schedules back on the start date.
        svc.markStart(ctx, after, today);
        return { changed, paused: paused.length, restored: restored.back.length, waitlisted: restored.waitlisted.length, kept_paused: restored.kept.length };
      });
      res.json(Object.assign(summary(ctx, student), result));
    });

    return r;
  },
  jobs: [{ name: 'expiry', run: ctx => svc.runExpiry(ctx) }, { name: 'starts', run: ctx => svc.runStarts(ctx) }],
};
