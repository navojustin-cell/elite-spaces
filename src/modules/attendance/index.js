'use strict';
// Module: attendance - PRD 7. Attendance and hours export (AT-1..AT-4).
//
// Routes, mounted at /api/attendance:
//   Family side: parents only, and only for students they are actively linked to (NF-1).
//   GET /students                 linked students with this week's and month's totals, terms and range shortcuts
//   GET /students/:id/history     ?period=week|month|term&date=YYYY-MM-DD   visits, absences and totals (AT-1, AT-2)
//   GET /students/:id/log         ?from&to   the same for a chosen date range (the export preview)
//   GET /students/:id/log.csv     ?from&to   download as CSV (AT-3)
//   GET /students/:id/log.pdf     ?from&to   download as PDF (AT-3)
//   Operations side: directors for their own location, HQ for any one location or all (AT-4).
//   Staff are not given reports.
//   GET /report/options           the locations, sessions and range shortcuts the caller may report on
//   GET /report                   ?location=<id|all>&session=<id>&from&to   (`timing`: upcoming, current or past)
//   GET /report.csv, /report.pdf  the same report as a download
// No scheduled jobs: absences are computed on every read (D-15), never stored.

const express = require('express');
const auth = require('../../auth');
const time = require('../../time');
const { bad, forbidden, notFound } = require('../../errors');
const svc = require('./service');
const files = require('./export');

const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ampm = hhmm => { const [h, m] = hhmm.split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
// "Afternoon Study · Mon/Wed/Fri 1:00 PM–4:00 PM": two sessions can share a name, so the days and times tell them apart.
const sessionLabel = s => `${s.name} · ${s.weekdays.split(',').map(d => WEEKDAYS[Number(d)]).join('/')} ${ampm(s.start_time)}–${ampm(s.end_time)}`;

function download(res, type, filename, body) {
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send(body);
}

// NF-1: a parent reaches a student's records only through an active family link.
function ownStudent(ctx, req) {
  const id = Number(req.params.id);
  if (!auth.linkedStudentIds(ctx, req.user.id).includes(id)) throw forbidden('You can only see your own students\' attendance.');
  const s = svc.student(ctx, id);
  if (!s) throw notFound('No such student.');
  return s;
}

const publicStudent = s => ({ id: s.id, name: s.name, location: s.location, today: s.today });

// One student's log for ?from&to (AT-3).
function studentLog(ctx, req) {
  const s = ownStudent(ctx, req);
  const { from, to } = svc.checkRange(req.query.from, req.query.to);
  const log = svc.log(ctx, { studentId: s.id, from, to });
  return { student: s, from, to, label: svc.rangeLabel(from, to), log,
    filename: ext => `attendance-${files.slug(s.name, 'student')}-${from}-to-${to}.${ext}` };
}

// NF-1 / AT-4: what a director or HQ may report on. Directors: their own location
// only. HQ: one location or all of them (`all`). A session must belong to the chosen
// location. `location` is where the report is: the one chosen or, with all locations
// and one session chosen, the session's.
function reportScope(ctx, user, q) {
  const raw = q.location == null || q.location === '' ? (user.role === 'hq' ? 'all' : String(user.location_id)) : String(q.location);
  let location = null; // null = every location
  if (raw === 'all') {
    if (user.role !== 'hq') throw forbidden('Directors can report on their own location only.');
  } else {
    const id = Number(raw);
    if (!auth.canManageLocation(user, id)) throw forbidden('Directors can report on their own location only.');
    location = ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);
    if (!location) throw notFound('No such location.');
  }
  let session = null;
  if (q.session != null && q.session !== '') {
    const s = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(q.session));
    if (!s) throw notFound('No such session.');
    if (!auth.canManageLocation(user, s.location_id)) throw forbidden('That session is at another location.');
    if (location && s.location_id !== location.id) throw bad('session_location', 'That session isn\'t at this location.');
    session = { id: s.id, name: s.name, location_id: s.location_id, label: sessionLabel(s) };
    // A session is at one location, so with all locations chosen the report is still that
    // location's: its heading, files, file name and times all name it.
    if (!location) location = ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(s.location_id);
  }
  const { from, to } = svc.checkRange(q.from, q.to);
  return { from, to, all: raw === 'all', location, session };
}

// Every location an all-locations report covers, by name.
const allLocations = ctx => ctx.db.prepare('SELECT id, name, timezone FROM locations ORDER BY name, id').all();

// Where the range stands against today, so the screen never says a session that
// hasn't happened yet had a check-in (D-15 counts only sessions that have ended):
// 'upcoming' before it starts, 'past' once it is over, else 'current'. Today is the
// location's own date; across every location, a range has started once it has
// started anywhere, and is over once it is over everywhere.
function timing(ctx, scope) {
  const now = ctx.clock.now();
  const todays = (scope.location ? [scope.location] : allLocations(ctx)).map(l => time.localDate(l, now)).sort();
  if (scope.from > todays[todays.length - 1]) return 'upcoming';
  if (scope.to < todays[0]) return 'past';
  return 'current';
}

function report(ctx, scope) {
  const log = svc.log(ctx, { locationId: scope.all ? null : scope.location.id, sessionId: scope.session ? scope.session.id : null,
    from: scope.from, to: scope.to });
  return {
    filters: { location: scope.location, session: scope.session, from: scope.from, to: scope.to },
    label: svc.rangeLabel(scope.from, scope.to),
    timing: timing(ctx, scope),
    ...log,
    by_student: svc.byStudent(log.visits, log.absences),
  };
}

const reportFilename = (scope, ext) => ['attendance-report', files.slug(scope.location ? scope.location.name : 'all locations', 'location'),
  ...(scope.session ? [files.slug(scope.session.name, 'session')] : []), scope.from, 'to', scope.to].join('-') + '.' + ext;

module.exports = {
  router(ctx) {
    const r = express.Router();

    // ---------- family side (AT-1, AT-2, AT-3) ----------
    r.use('/students', auth.requireRole('parent'));

    r.get('/students', (req, res) => {
      const students = auth.linkedStudentIds(ctx, req.user.id).map(id => svc.student(ctx, id)).filter(Boolean).map(s => {
        const week = svc.period(ctx, s.location, 'week', s.today, s.today);
        const month = svc.period(ctx, s.location, 'month', s.today, s.today);
        return Object.assign(publicStudent(s), {
          terms: svc.termsAt(ctx, s.location.id),
          presets: svc.presets(ctx, s.location, s.today),
          week: Object.assign(week, { totals: svc.log(ctx, { studentId: s.id, from: week.from, to: week.to }).totals }),
          month: Object.assign(month, { totals: svc.log(ctx, { studentId: s.id, from: month.from, to: month.to }).totals }),
        });
      });
      res.json({ students: students.sort((a, b) => a.name.localeCompare(b.name)) });
    });

    r.get('/students/:id/history', (req, res) => {
      const s = ownStudent(ctx, req);
      const p = svc.period(ctx, s.location, String(req.query.period || 'week'), String(req.query.date || s.today), s.today);
      res.json(Object.assign({ student: publicStudent(s), period: p }, svc.log(ctx, { studentId: s.id, from: p.from, to: p.to })));
    });

    r.get('/students/:id/log', (req, res) => {
      const l = studentLog(ctx, req);
      res.json(Object.assign({ student: publicStudent(l.student), from: l.from, to: l.to, label: l.label }, l.log));
    });

    r.get('/students/:id/log.csv', (req, res) => {
      const l = studentLog(ctx, req);
      download(res, 'text/csv; charset=utf-8', l.filename('csv'),
        files.csv(l.log, { who: { student: l.student.name, location: l.student.location.name }, range: { from: l.from, to: l.to } }));
    });

    r.get('/students/:id/log.pdf', async (req, res) => {
      const l = studentLog(ctx, req);
      const pdf = await files.familyPdf({ student: l.student, from: l.from, to: l.to, label: l.label, log: l.log, now: ctx.clock.now() });
      download(res, 'application/pdf', l.filename('pdf'), pdf);
    });

    // ---------- operations side (AT-4) ----------
    const reportsOnly = auth.requireRole('director');

    r.get('/report/options', reportsOnly, (req, res) => {
      const locs = req.user.role === 'hq'
        ? ctx.db.prepare('SELECT * FROM locations ORDER BY name, id').all()
        : ctx.db.prepare('SELECT * FROM locations WHERE id = ?').all(req.user.location_id);
      const sessions = ctx.db.prepare('SELECT * FROM sessions WHERE location_id = ? ORDER BY status, name, start_time, id');
      res.json({
        all_locations: req.user.role === 'hq',
        locations: locs.map(l => {
          const today = time.localDate(l, ctx.clock.now());
          return {
            id: l.id, name: l.name, timezone: l.timezone, today,
            presets: svc.presets(ctx, l, today),
            sessions: sessions.all(l.id).map(s => ({ id: s.id, name: s.name, label: sessionLabel(s), status: s.status })),
          };
        }),
      });
    });

    r.get('/report', reportsOnly, (req, res) => {
      res.json(report(ctx, reportScope(ctx, req.user, req.query)));
    });

    r.get('/report.csv', reportsOnly, (req, res) => {
      const scope = reportScope(ctx, req.user, req.query);
      const rep = report(ctx, scope);
      download(res, 'text/csv; charset=utf-8', reportFilename(scope, 'csv'),
        files.csv(rep, { staff: true, range: { from: scope.from, to: scope.to },
          who: { location: scope.location ? scope.location.name : 'All locations', session: scope.session ? scope.session.label : 'All sessions' } }));
    });

    r.get('/report.pdf', reportsOnly, async (req, res) => {
      const scope = reportScope(ctx, req.user, req.query);
      const rep = report(ctx, scope);
      const pdf = await files.reportPdf({ filters: rep.filters, label: rep.label, log: rep, byStudent: rep.by_student, now: ctx.clock.now(),
        locations: scope.location ? [] : allLocations(ctx) });
      download(res, 'application/pdf', reportFilename(scope, 'pdf'), pdf);
    });

    return r;
  },
  jobs: [],
};
