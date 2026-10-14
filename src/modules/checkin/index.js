'use strict';
// Module: checkin - PRD 1. Check-in and check-out (CI-1..CI-7).
//
// Routes, mounted at /api/checkin:
//   POST /scan                       student scans the entrance code; checks in or out (CI-2, CI-3, CI-4)
//   GET  /status                     parent: each linked student's status today; student: their own
//   GET  /dev/simulate               dev mode only: today's code and the coordinates of the student's home location
//   GET  /locations/:id/qr           staff+ of that location: today's code, its app URL and an SVG (CI-1)
//   GET  /locations/:id/building     staff+: here / expected / left today and visits needing review (CI-7)
//   GET  /locations/:id/students?q=  staff+: find a student at the location for a manual check-in
//   POST /manual-checkin             staff+: { studentId, reason, override } (CI-7, audited)
//   POST /visits/:id/checkout        staff+: { reason } manual check-out (CI-7, audited)
//   POST /visits/:id/review          staff+: { out_time? } mark a flagged visit reviewed, optionally fixing the time out (audited)
// Job: auto-checkout (CI-5, D-14).
//
// Scan order: today's code -> home location (D-1) -> inside the radius -> an
// open visit today means check-out -> otherwise an enrolled slot window means
// check-in. Scan coordinates are used for the radius check only and are never
// stored or logged (NF-5, D-23).

const express = require('express');
const QRCode = require('qrcode');
const { tx } = require('../../db');
const auth = require('../../auth');
const audit = require('../../audit');
const time = require('../../time');
const { AppError, bad, forbidden, notFound, conflict } = require('../../errors');
const svc = require('./service');

const CONFIRM_MS = 5 * 60000; // a second scan this soon after checking in asks before checking out

const refuse = (code, msg) => new AppError(403, code, msg);
// Real coordinates only: a number on the globe for each. null, text, NaN, 1e308, or a latitude
// past a pole (146.3154 lands back on Irvine) is refused before any distance is measured.
const onGlobe = (n, max) => typeof n === 'number' && Math.abs(n) <= max;
const coordsGiven = b => onGlobe(b.lat, 90) && onGlobe(b.lng, 180);
// Fails closed: a distance that is not a number (NaN) counts as outside.
const insideRadius = (loc, lat, lng) => time.distanceM(lat, lng, loc.lat, loc.lng) <= loc.geofence_m;
// Body values that are objects or arrays are treated as missing, never a server error.
const idOf = v => (typeof v === 'number' || typeof v === 'string' ? Number(v) || 0 : 0);
const cleanReason = r => (typeof r === 'string' ? r : '').trim().slice(0, 200) || null;
const OUT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Staff, directors and HQ who manage that location (NF-1).
function managedLocation(ctx, user, id) {
  auth.assertManageLocation(user, Number(id));
  const loc = svc.getLocation(ctx, id);
  if (!loc) throw notFound('No such location.');
  return loc;
}
function managedVisit(ctx, user, id) {
  const v = svc.getVisit(ctx, id);
  if (!v) throw notFound('No such visit.');
  if (!auth.canManageLocation(user, v.location_id)) throw forbidden();
  return v;
}

function router(ctx) {
  const r = express.Router();

  // ---- student scan: check in or out (CI-2, CI-3, CI-4) ----
  r.post('/scan', auth.requireRole('student'), (req, res) => {
    const b = req.body || {};
    const student = req.user;
    const now = ctx.clock.now();
    const loc = svc.getLocation(ctx, idOf(b.locationId));
    if (!loc) throw notFound("We couldn't find that location. Scan the code at the entrance again.");
    const code = svc.checkCode(loc, b.code, now);
    if (code === 'expired') throw refuse('code_expired', "This code has expired. Scan today's code at the entrance.");
    if (code !== 'ok') throw refuse('bad_code', "That code didn't work. Scan the code at the entrance again.");
    if (loc.id !== student.location_id) {
      const home = svc.getLocation(ctx, student.location_id);
      throw refuse('wrong_location', `This code is for ${loc.name}. You're a member at ${home ? home.name : 'another location'}.`);
    }
    if (!coordsGiven(b)) throw bad('location_needed', "We need your phone's location to check you in. It's only used for this check and isn't saved.");
    if (!insideRadius(loc, b.lat, b.lng)) {
      throw refuse('outside_radius', `You need to be inside ${loc.name} to check in or out. If you are, ask staff to check you in.`);
    }
    // From here on the coordinates are not used again.

    const today = time.localDate(loc, now);
    const open = svc.openVisit(ctx, student.id, loc.id, today);
    if (open) {
      if (now - open.check_in_at < CONFIRM_MS && b.confirm !== true) {
        throw conflict('confirm_checkout', `You checked in at ${svc.clockTime(loc, open.check_in_at)}. Check out now?`);
      }
      const visit = svc.closeVisit(ctx, open, { ms: now, method: 'scan' });
      svc.announceCheckout(ctx, { student, loc, visit });
      return res.json({ action: 'checkout', visit, total_minutes: svc.minutes(visit.check_in_at, visit.check_out_at), location: svc.publicLocation(loc) });
    }

    if (!svc.membershipOk(ctx, student.id, today)) {
      throw refuse('membership_inactive', "Your membership isn't active right now. Ask a parent or the front desk.");
    }
    const slot = svc.slotNow(ctx, loc, student.id, now);
    if (!slot) throw refuse('no_session', svc.noSessionMessage(ctx, loc, student.id, now));
    const visit = svc.createVisit(ctx, { student, loc, slot, ms: now, method: 'scan' });
    svc.announceCheckin(ctx, { student, loc, visit, slot });
    res.json({
      action: 'checkin', visit, location: svc.publicLocation(loc),
      session: { id: slot.session_id, name: slot.name, start_at: slot.start_at, end_at: slot.end_at },
    });
  });

  // ---- family status for the Home cards ----
  r.get('/status', auth.requireRole('parent', 'student'), (req, res) => {
    const ids = req.user.role === 'student' ? [req.user.id] : auth.linkedStudentIds(ctx, req.user.id);
    const now = ctx.clock.now();
    res.json({ now, students: ids.map(id => svc.status(ctx, auth.getUser(ctx, id), now)).filter(Boolean) });
  });

  // ---- dev only: scan without a camera or GPS ----
  if (ctx.dev) {
    r.get('/dev/simulate', auth.requireRole('student'), (req, res) => {
      const loc = svc.getLocation(ctx, req.user.location_id);
      if (!loc) throw notFound('No home location.');
      res.json({ locationId: loc.id, code: svc.currentCode(ctx, loc), lat: loc.lat, lng: loc.lng });
    });
  }

  // ---- entrance QR (CI-1) ----
  r.get('/locations/:id/qr', auth.requireRole('staff'), async (req, res) => {
    const loc = managedLocation(ctx, req.user, req.params.id);
    const now = ctx.clock.now();
    const code = svc.currentCode(ctx, loc, now);
    const url = `/#/scan/${loc.id}/${code}`;
    const link = `${req.protocol}://${req.get('host')}${url}`;
    const svg = await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    res.json({ location: svc.publicLocation(loc), code, url, link, svg, qr_day: svc.qrDay(loc, now), valid_until: svc.codeExpiresAt(loc, now) });
  });

  // ---- staff: in the building (CI-7) ----
  r.get('/locations/:id/building', auth.requireRole('staff'), (req, res) => {
    const loc = managedLocation(ctx, req.user, req.params.id);
    res.json(svc.building(ctx, loc, ctx.clock.now()));
  });

  r.get('/locations/:id/students', auth.requireRole('staff'), (req, res) => {
    const loc = managedLocation(ctx, req.user, req.params.id);
    const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 60);
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const now = ctx.clock.now(), today = time.localDate(loc, now);
    const rows = ctx.db.prepare(`SELECT id, name FROM users WHERE role = 'student' AND active = 1 AND location_id = ?
      AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 25`).all(loc.id, like);
    res.json({
      students: rows.map(s => {
        const open = svc.openVisit(ctx, s.id, loc.id, today);
        const slot = open ? null : svc.slotNow(ctx, loc, s.id, now);
        return {
          id: s.id, name: s.name, here: !!open, visit_id: open ? open.id : null, since: open ? open.check_in_at : null,
          session_now: slot ? { id: slot.session_id, name: slot.name, end_at: slot.end_at } : null,
        };
      }),
    });
  });

  r.post('/manual-checkin', auth.requireRole('staff'), (req, res) => {
    const b = req.body || {};
    const student = auth.getUser(ctx, idOf(b.studentId));
    if (!student || student.role !== 'student') throw notFound('No such student.');
    auth.assertManageLocation(req.user, student.location_id);
    const loc = svc.getLocation(ctx, student.location_id);
    const now = ctx.clock.now();
    const open = svc.openVisit(ctx, student.id, loc.id, time.localDate(loc, now));
    if (open) throw conflict('already_here', `${student.name} is already checked in (since ${svc.clockTime(loc, open.check_in_at)}).`);
    const slot = svc.slotNow(ctx, loc, student.id, now);
    if (!slot && b.override !== true) {
      throw conflict('no_session', `${svc.firstName(student.name)} doesn't have a session right now. Check them in anyway?`);
    }
    const reason = cleanReason(b.reason);
    const visit = tx(ctx.db, () => {
      const v = svc.createVisit(ctx, { student, loc, slot, ms: now, method: 'staff', staff: req.user });
      audit.log(ctx, req.user, 'checkin.manual_checkin', {
        targetType: 'visit', targetId: v.id, locationId: loc.id,
        detail: { student_id: student.id, student: student.name, staff: req.user.name, reason, override: !slot, session: slot ? slot.name : null },
      });
      return v;
    });
    svc.announceCheckin(ctx, { student, loc, visit, slot, staff: req.user });
    res.json({ visit, override: !slot });
  });

  r.post('/visits/:id/checkout', auth.requireRole('staff'), (req, res) => {
    const b = req.body || {};
    const open = managedVisit(ctx, req.user, req.params.id);
    if (open.check_out_at != null) throw conflict('already_out', 'This student is already checked out.');
    const loc = svc.getLocation(ctx, open.location_id);
    const student = auth.getUser(ctx, open.student_id);
    const reason = cleanReason(b.reason);
    const visit = tx(ctx.db, () => {
      const v = svc.closeVisit(ctx, open, { ms: Math.max(ctx.clock.now(), open.check_in_at), method: 'staff', staff: req.user });
      audit.log(ctx, req.user, 'checkin.manual_checkout', {
        targetType: 'visit', targetId: v.id, locationId: loc.id,
        detail: { student_id: student.id, student: student.name, staff: req.user.name, reason },
      });
      return v;
    });
    svc.announceCheckout(ctx, { student, loc, visit, staff: req.user });
    res.json({ visit });
  });

  // Confirm a flagged visit, or fix its time out first.
  r.post('/visits/:id/review', auth.requireRole('staff'), (req, res) => {
    const b = req.body || {};
    const v = managedVisit(ctx, req.user, req.params.id);
    if (!v.flagged) throw conflict('not_flagged', "This visit doesn't need review.");
    if (v.reviewed_by != null) throw conflict('already_reviewed', 'This visit has already been reviewed.');
    const loc = svc.getLocation(ctx, v.location_id);
    const student = auth.getUser(ctx, v.student_id);
    let out = v.check_out_at, method = v.checkout_method, by = v.checked_out_by;
    if (b.out_time != null && b.out_time !== '') {
      if (typeof b.out_time !== 'string' || !OUT_TIME.test(b.out_time)) throw bad('bad_time', 'Enter the time out as hours and minutes, like 15:45.');
      out = time.toMs(loc, v.local_date, b.out_time);
      if (out <= v.check_in_at || out > ctx.clock.now()) {
        throw bad('bad_time', `The time out needs to be after ${svc.firstName(student.name)} checked in (${svc.clockTime(loc, v.check_in_at)}) and not in the future.`);
      }
      method = 'staff';
      by = req.user.id;
    }
    const visit = tx(ctx.db, () => {
      ctx.db.prepare('UPDATE visits SET reviewed_by = ?, check_out_at = ?, checkout_method = ?, checked_out_by = ? WHERE id = ?')
        .run(req.user.id, out, method, by, v.id);
      audit.log(ctx, req.user, 'checkin.review', {
        targetType: 'visit', targetId: v.id, locationId: loc.id,
        detail: {
          student_id: student.id, student: student.name, staff: req.user.name,
          before: { check_out_at: v.check_out_at, checkout_method: v.checkout_method }, after: { check_out_at: out, checkout_method: method },
        },
      });
      return svc.getVisit(ctx, v.id);
    });
    res.json({ visit });
  });

  return r;
}

module.exports = {
  router,
  jobs: [{ name: 'auto-checkout', run: ctx => svc.autoCheckout(ctx) }],
  // Read-only helper for other modules: the entrance code valid at `ms` (CI-1).
  currentCode: svc.currentCode,
  // The radius check on its own, so a test can prove it fails closed on a NaN distance (CI-2).
  insideRadius,
};
