'use strict';
// Integration: flows that cross modules, run with every module loaded (a scoped
// run of this file loads them all too, see run.js). Each module's own tests
// stand in for its neighbours by writing the core tables directly; these tests
// use the real neighbours' routes instead, so a contract that drifts between
// two modules (docs/decisions.md D-26) fails here.
const { test, makeApp, assert, load, at } = require('./lib');

const LA = 'America/Los_Angeles';
const M_PER_DEG = 6371000 * Math.PI / 180;
const north = (loc, m) => ({ lat: loc.lat + m / M_PER_DEG, lng: loc.lng });

// Irvine with the Fall term and Afternoon Study (Mon/Wed/Fri 13:00-16:00), one
// family (cap 3), staff and a director. The clock starts at `now`.
async function world(now) {
  const t = await makeApp({ now });
  const loc = t.fx.location({ name: 'Irvine', timezone: LA });
  t.fx.term(loc);
  const pm = t.fx.session(loc, { name: 'Afternoon Study', weekdays: '1,3,5', start: '13:00', end: '16:00' });
  const fam = t.fx.family(loc);
  const staff = t.fx.staff(loc, { name: 'Chris Ortiz' });
  const director = t.fx.director(loc);
  const enroll = (wd, f = fam) => t.as(f.parent).post('/api/enrollment/enroll', { studentId: f.student.id, sessionId: pm.id, weekday: wd });
  const membership = (o, f = fam) => t.as(staff).put(`/api/membership/student/${f.student.id}`,
    Object.assign({ status: 'active', weekly_cap: 3, start_date: '2026-08-01', expires_on: '2027-06-30' }, o));
  const scan = (f = fam) => t.as(f.student).post('/api/checkin/scan',
    Object.assign({ locationId: loc.id, code: load('src/modules/checkin/index.js').currentCode(t.ctx, loc, t.clock.now()) }, north(loc, 10)));
  return { t, loc, pm, fam, staff, director, enroll, membership, scan };
}
const setClock = (t, date, hm) => t.clock.set(at(LA, date, hm));

test(['MB-5', 'EN-7', 'AT-2'], 'a lapse, a renewal under a lower weekly limit and a later raise: Schedule and Hours agree on every week', async () => {
  const w = await world(at(LA, '2026-09-01', '09:00'));
  const { t, fam } = w;
  for (const wd of [1, 3, 5]) assert.equal((await w.enroll(wd)).status, 201);

  setClock(t, '2026-09-09', '09:00'); // Wed: staff set the membership inactive
  assert.equal((await w.membership({ status: 'inactive' })).body.paused, 3);
  setClock(t, '2026-09-21', '09:00'); // Mon: active again, but with a limit of 2
  const back = await w.membership({ weekly_cap: 2 });
  assert.deepEqual([back.body.restored, back.body.kept_paused], [2, 1]); // Monday and Wednesday; Friday stays paused
  setClock(t, '2026-10-01', '09:00'); // Thu: the limit goes back to 3, and Friday returns
  assert.equal((await w.membership({ weekly_cap: 3 })).body.restored, 1);

  setClock(t, '2026-10-14', '10:00');
  const range = 'from=2026-09-07&to=2026-10-12';
  const sched = await t.as(fam.parent).get(`/api/enrollment/students/${fam.student.id}/schedule?${range}`);
  assert.equal(sched.status, 200);
  const status = Object.fromEntries(sched.body.occurrences.map(o => [o.date, o.status]));
  assert.deepEqual(status, {
    '2026-09-07': 'absent', '2026-09-09': 'paused', '2026-09-11': 'paused',
    '2026-09-14': 'paused', '2026-09-16': 'paused', '2026-09-18': 'paused',
    '2026-09-21': 'absent', '2026-09-23': 'absent', '2026-09-25': 'paused', // Friday was kept paused over the limit
    '2026-09-28': 'absent', '2026-09-30': 'absent', '2026-10-02': 'absent',
    '2026-10-05': 'absent', '2026-10-07': 'absent', '2026-10-09': 'absent', '2026-10-12': 'absent',
  });
  const hours = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?${range}`);
  assert.equal(hours.status, 200);
  assert.deepEqual(hours.body.absences.map(a => a.date), Object.keys(status).filter(d => status[d] === 'absent'));
  const report = await t.as(w.director).get(`/api/attendance/report?${range}`);
  assert.equal(report.body.totals.absences, 10);
  // The family heard about each step.
  assert.deepEqual(t.fx.notifications(fam.parent).filter(n => n.kind.startsWith('membership')).map(n => n.kind),
    ['membership_paused', 'membership_restored', 'membership_restored']);
});

test(['CI-3', 'CI-5', 'DN-1', 'DN-5', 'AT-1', 'EN-7'], "one student's day: scan in, auto check-out, a daily note, then Hours, Schedule and the director's report", async () => {
  const w = await world(at(LA, '2026-10-01', '09:00'));
  const { t, loc, fam, staff } = w;
  assert.equal((await w.enroll(3)).status, 201);
  setClock(t, '2026-10-14', '13:05');
  const s = await w.scan();
  assert.equal(s.status, 200);
  assert.equal(s.body.action, 'checkin');
  const here = await t.as(staff).get(`/api/checkin/locations/${loc.id}/building`);
  assert.deepEqual(here.body.here.map(v => v.student_id), [fam.student.id]);

  setClock(t, '2026-10-14', '16:30');
  t.jobs(); // she forgot to scan out
  assert.equal(t.fx.notifications(fam.parent, 'checkout_auto').length, 1);

  // Staff write the note from the day's attendance list.
  const day = await t.as(staff).get(`/api/notes/day?location=${loc.id}&date=2026-10-14`);
  assert.deepEqual(day.body.students.map(x => x.id), [fam.student.id]);
  const ratings = Object.fromEntries(day.body.items.map(i => [i.id, 3]));
  const put = await t.as(staff).put(`/api/notes/students/${fam.student.id}/2026-10-14`, { ratings, comment: 'Finished the essay draft.', post: true });
  assert.equal(put.status, 200);
  assert.equal(t.fx.notifications(fam.parent, 'note').length, 1);
  const today = await t.as(fam.parent).get('/api/notes/today');
  assert.equal(today.body.students[0].note.comment, 'Finished the essay draft.');

  // Hours shows the visit with its session and how it ended; it still needs review.
  const log = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?from=2026-10-14&to=2026-10-14`);
  assert.deepEqual(log.body.visits.map(v => [v.session_name, v.check_in_local, v.check_out_local, v.minutes, v.checkout_method, v.needs_review]),
    [['Afternoon Study', '13:05', '16:00', 175, 'auto', true]]);
  assert.deepEqual(log.body.absences, []);
  const sched = await t.as(fam.parent).get(`/api/enrollment/students/${fam.student.id}/schedule?from=2026-10-14&to=2026-10-14`);
  assert.deepEqual(sched.body.occurrences.map(o => [o.status, o.check_in_at]), [['attended', at(LA, '2026-10-14', '13:05')]]);

  // Staff confirm the automatic check-out; the director's report has nothing left to review.
  const visitId = log.body.visits[0].id;
  assert.equal((await t.as(staff).post(`/api/checkin/visits/${visitId}/review`, {})).status, 200);
  const rep = await t.as(w.director).get('/api/attendance/report?from=2026-10-14&to=2026-10-14');
  assert.deepEqual([rep.body.totals.visits, rep.body.totals.needs_review, rep.body.totals.absences], [1, 0, 0]);
});

test(['SC-3', 'CI-3', 'EN-7', 'AT-2'], 'a closure set by the director: families are told, nobody can check in, and the day is closed, not absent', async () => {
  const w = await world(at(LA, '2026-10-01', '09:00'));
  const { t, loc, fam, staff } = w;
  assert.equal((await w.enroll(1)).status, 201);
  setClock(t, '2026-10-14', '10:00');
  const c = await t.as(w.director).post('/api/sessions/closures', { location_id: loc.id, date: '2026-10-19', reason: 'Staff training' });
  assert.equal(c.status, 201);
  assert.equal(t.fx.notifications(fam.parent, 'session_closure').length, 1);

  setClock(t, '2026-10-19', '13:05');
  const s = await w.scan();
  assert.equal(s.status, 403);
  assert.equal(s.body.error, 'no_session');
  const b = await t.as(staff).get(`/api/checkin/locations/${loc.id}/building`);
  assert.deepEqual(b.body.expected, []);

  setClock(t, '2026-10-20', '10:00');
  const sched = await t.as(fam.parent).get(`/api/enrollment/students/${fam.student.id}/schedule?from=2026-10-12&to=2026-10-19`);
  assert.deepEqual(sched.body.occurrences.map(o => [o.date, o.status, o.closure_reason]),
    [['2026-10-12', 'absent', null], ['2026-10-19', 'closed', 'Staff training']]);
  const hours = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?from=2026-10-12&to=2026-10-19`);
  assert.deepEqual(hours.body.absences.map(a => a.date), ['2026-10-12']);
});

// Every Home card's request, for every role (public/js/views/*.js App.card).
// HQ has no home location, and a new parent has no students yet: the cards
// those users see must still load.
test(['NF-1'], 'every Home card loads for every role, including HQ with no home location and a parent with no students yet', async () => {
  const w = await world(at(LA, '2026-10-14', '10:00'));
  const { t, loc, fam, staff, director } = w;
  assert.equal((await w.enroll(3)).status, 201);
  const hq = t.fx.hq();
  const newParent = t.fx.user('parent', { location: loc });
  const week = 'from=2026-10-12&to=2026-10-18';
  const calls = {
    student: [fam.student, ['/api/checkin/status', '/api/enrollment/students', `/api/enrollment/students/${fam.student.id}/schedule`,
      '/api/membership/mine', '/api/announcements/feed?limit=10']],
    parent: [fam.parent, ['/api/checkin/status', '/api/accounts/family', '/api/enrollment/requests', '/api/notes/today',
      '/api/enrollment/students', `/api/enrollment/students/${fam.student.id}/schedule`, '/api/membership/mine', '/api/attendance/students',
      '/api/announcements/feed?limit=10']],
    newParent: [newParent, ['/api/checkin/status', '/api/accounts/family', '/api/enrollment/requests', '/api/notes/today',
      '/api/enrollment/students', '/api/membership/mine', '/api/attendance/students', '/api/announcements/feed?limit=10']],
    staff: [staff, ['/api/accounts/me', `/api/checkin/locations/${loc.id}/building`, '/api/notes/day',
      `/api/sessions/today?location_id=${loc.id}`, '/api/announcements/feed?limit=10']],
    director: [director, ['/api/accounts/me', `/api/checkin/locations/${loc.id}/building`, '/api/notes/day',
      `/api/sessions/today?location_id=${loc.id}`, '/api/attendance/report/options', `/api/attendance/report?location=${loc.id}&${week}`,
      '/api/announcements/feed?limit=10']],
    hq: [hq, ['/api/accounts/me', '/api/notes/items', '/api/locations', `/api/sessions/today?location_id=${loc.id}`,
      '/api/attendance/report/options', `/api/attendance/report?location=all&${week}`, '/api/announcements/feed?limit=10']],
  };
  for (const [who, [user, urls]] of Object.entries(calls)) {
    for (const url of urls) {
      const r = await t.as(user).get(url);
      assert.equal(r.status, 200, `${who} ${url}: ${JSON.stringify(r.body)}`);
    }
  }
  const empty = await t.as(newParent).get('/api/enrollment/students');
  assert.deepEqual(empty.body.students, []);
});
