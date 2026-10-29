'use strict';
// Integration: flows that cross modules, run with every module loaded (a scoped
// run of this file loads them all too, see run.js). Each module's own tests
// stand in for its neighbours by writing the core tables directly; these tests
// use the real neighbours' routes instead, so a contract that drifts between
// two modules (docs/decisions.md D-26) fails here.
const { test, makeApp, assert, load, at } = require('./lib');

const LA = 'America/Los_Angeles';

// Irvine with the Fall 2026 period and Afternoon Study (Mon/Wed/Fri 13:00-16:00), one
// family (cap 3), staff and a director. The clock starts at `now`. Enrollments are
// whole schedules (D-42): a parent posts { studentId, sessionId } and nothing else.
async function world(now) {
  const t = await makeApp({ now });
  const loc = t.fx.location({ name: 'Irvine', timezone: LA });
  t.fx.term(loc);
  const pm = t.fx.session(loc, { name: 'Afternoon Study', weekdays: '1,3,5', start: '13:00', end: '16:00' });
  const fam = t.fx.family(loc);
  const staff = t.fx.staff(loc, { name: 'Chris Ortiz' });
  const director = t.fx.director(loc);
  const enroll = (f = fam, s = pm) => t.as(f.parent).post('/api/enrollment/enroll', { studentId: f.student.id, sessionId: s.id });
  const membership = (o, f = fam) => t.as(staff).put(`/api/membership/student/${f.student.id}`,
    Object.assign({ status: 'active', weekly_cap: 3, start_date: '2026-08-01', expires_on: '2027-06-30' }, o));
  // A scan sends today's code only: no coordinates (D-49).
  const scan = (f = fam) => t.as(f.student).post('/api/checkin/scan',
    { locationId: loc.id, code: load('src/modules/checkin/index.js').currentCode(t.ctx, loc, t.clock.now()) });
  return { t, loc, pm, fam, staff, director, enroll, membership, scan };
}
const setClock = (t, date, hm) => t.clock.set(at(LA, date, hm));

test(['MB-5', 'EN-7', 'AT-2'], 'a lapse, a renewal under a lower weekly limit and a later raise: the whole schedule pauses, stays paused, comes back, and Schedule and Hours agree on every date', async () => {
  const w = await world(at(LA, '2026-09-01', '09:00'));
  const { t, fam } = w;
  assert.equal((await w.enroll()).status, 201); // one whole Mon/Wed/Fri schedule

  setClock(t, '2026-09-09', '09:00'); // Wed: staff set the membership inactive
  assert.equal((await w.membership({ status: 'inactive' })).body.paused, 1);
  setClock(t, '2026-09-21', '09:00'); // Mon: active again, but with a limit of 2, and the schedule meets 3 days a week
  const back = await w.membership({ weekly_cap: 2 });
  assert.deepEqual([back.body.restored, back.body.kept_paused], [0, 1]); // kept paused over the limit (D-16a)
  setClock(t, '2026-10-01', '09:00'); // Thu: the limit goes back to 3, and the schedule returns
  assert.equal((await w.membership({ weekly_cap: 3 })).body.restored, 1);

  setClock(t, '2026-10-14', '10:00');
  const range = 'from=2026-09-07&to=2026-10-12';
  const sched = await t.as(fam.parent).get(`/api/enrollment/students/${fam.student.id}/schedule?${range}`);
  assert.equal(sched.status, 200);
  const status = Object.fromEntries(sched.body.occurrences.map(o => [o.date, o.status]));
  assert.deepEqual(status, {
    '2026-09-07': 'absent', '2026-09-09': 'paused', '2026-09-11': 'paused',
    '2026-09-14': 'paused', '2026-09-16': 'paused', '2026-09-18': 'paused',
    '2026-09-21': 'paused', '2026-09-23': 'paused', '2026-09-25': 'paused', // kept paused: every date, none absent
    '2026-09-28': 'paused', '2026-09-30': 'paused', '2026-10-02': 'absent', // back on Oct 1
    '2026-10-05': 'absent', '2026-10-07': 'absent', '2026-10-09': 'absent', '2026-10-12': 'absent',
  });
  const hours = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?${range}`);
  assert.equal(hours.status, 200);
  assert.deepEqual(hours.body.absences.map(a => a.date), Object.keys(status).filter(d => status[d] === 'absent'));
  const report = await t.as(w.director).get(`/api/attendance/report?${range}`);
  assert.equal(report.body.totals.absences, 6);
  // The family heard about the pause and the return.
  assert.deepEqual(t.fx.notifications(fam.parent).filter(n => n.kind.startsWith('membership')).map(n => n.kind),
    ['membership_paused', 'membership_restored']);
});

test(['CI-3', 'CI-5', 'DN-1', 'DN-5', 'AT-1', 'EN-7'], "one student's day: scan in, auto check-out, a daily note, then Hours, Schedule and the director's report for the Mon/Wed/Fri week", async () => {
  const w = await world(at(LA, '2026-10-01', '09:00'));
  const { t, loc, fam, staff } = w;
  assert.equal((await w.enroll()).status, 201);
  setClock(t, '2026-10-14', '13:05'); // Wed; Monday Oct 12 was missed
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

  // Hours shows the visit with its schedule and how it ended (it still needs review), and Monday as absent.
  const week = 'from=2026-10-12&to=2026-10-14';
  const log = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?${week}`);
  assert.deepEqual(log.body.visits.map(v => [v.session_name, v.check_in_local, v.check_out_local, v.minutes, v.checkout_method, v.needs_review]),
    [['Afternoon Study', '13:05', '16:00', 175, 'auto', true]]);
  assert.deepEqual(log.body.absences.map(a => a.date), ['2026-10-12']);
  const sched = await t.as(fam.parent).get(`/api/enrollment/students/${fam.student.id}/schedule?${week}`);
  assert.deepEqual(sched.body.occurrences.map(o => [o.date, o.status, o.check_in_at]),
    [['2026-10-12', 'absent', null], ['2026-10-14', 'attended', at(LA, '2026-10-14', '13:05')]]);

  // Staff confirm the automatic check-out; the director's report has nothing left to review.
  const visitId = log.body.visits[0].id;
  assert.equal((await t.as(staff).post(`/api/checkin/visits/${visitId}/review`, {})).status, 200);
  const rep = await t.as(w.director).get(`/api/attendance/report?${week}`);
  assert.deepEqual([rep.body.totals.visits, rep.body.totals.needs_review, rep.body.totals.absences], [1, 0, 1]);
});

test(['SC-3', 'CI-3', 'EN-7', 'AT-2'], 'a closure set by the director: families are told, nobody can check in, and the day is closed, not absent', async () => {
  const w = await world(at(LA, '2026-10-01', '09:00'));
  const { t, loc, fam, staff } = w;
  assert.equal((await w.enroll()).status, 201);
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
  assert.deepEqual(sched.body.occurrences.map(o => [o.date, o.status, o.closure_reason]), [
    ['2026-10-12', 'absent', null], ['2026-10-14', 'absent', null], ['2026-10-16', 'absent', null],
    ['2026-10-19', 'closed', 'Staff training'],
  ]);
  const hours = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?from=2026-10-12&to=2026-10-19`);
  assert.deepEqual(hours.body.absences.map(a => a.date), ['2026-10-12', '2026-10-14', '2026-10-16']);
});

// ---------------------------------------------------------------- v1.1 flows (docs/v1.1-design.md 5.2)

test(['SC-5', 'CI-3', 'EN-7', 'AT-2'], 'flow 1: a parent enrolls, the director moves Monday to Tuesday, the family is told, Monday refuses a scan, Tuesday checks in, and Hours shows no absence', async () => {
  const w = await world(at(LA, '2026-11-16', '10:00'));
  const { t, loc, fam } = w;
  const mornings = t.fx.session(loc, { name: 'Mornings MWF', weekdays: '1,3,5', start: '09:00', end: '12:00' });
  assert.equal((await w.enroll(fam, mornings)).status, 201);

  const move = await t.as(w.director).post(`/api/sessions/${mornings.id}/dates`,
    { action: 'move', date: '2026-11-23', to: '2026-11-24', reason: 'Staff training day' });
  assert.equal(move.status, 201, JSON.stringify(move.body));
  const told = t.fx.notifications(fam.parent, 'schedule_date_moved');
  assert.equal(told.length, 1);
  assert.equal(told[0].title, 'Mornings MWF moves from Mon, Nov 23 to Tue, Nov 24');
  assert.equal(t.fx.notifications(fam.student, 'schedule_date_moved').length, 1);

  setClock(t, '2026-11-23', '09:05'); // Monday: it doesn't meet
  const mon = await w.scan();
  assert.deepEqual([mon.status, mon.body.error], [403, 'no_session']);
  assert.match(mon.body.message, /^Mornings MWF doesn't meet today \(moved to Tue/);

  setClock(t, '2026-11-24', '09:05'); // Tuesday: the moved date checks in
  const tue = await w.scan();
  assert.deepEqual([tue.status, tue.body.action], [200, 'checkin']);

  setClock(t, '2026-11-25', '08:00');
  const range = 'from=2026-11-23&to=2026-11-24';
  const hours = await t.as(fam.parent).get(`/api/attendance/students/${fam.student.id}/log?${range}`);
  assert.deepEqual(hours.body.absences, []);
  assert.deepEqual(hours.body.visits.map(v => [v.date, v.session_name]), [['2026-11-24', 'Mornings MWF']]);
  const sched = await t.as(fam.parent).get(`/api/enrollment/students/${fam.student.id}/schedule?${range}`);
  assert.deepEqual(sched.body.occurrences.filter(o => o.session_id === mornings.id).map(o => [o.date, o.status, o.change, o.moved_from]),
    [['2026-11-24', 'attended', 'moved', '2026-11-23']]);
});

test(['DG-1', 'DG-2', 'DN-2', 'DN-5'], "flow 2: a student checks in and sets 3 goals for the week; the next check-in asks about each one, and staff, the posted note and the parent's goals page all show the answers", async () => {
  const w = await world(at(LA, '2026-10-01', '09:00'));
  const { t, loc, fam, staff } = w;
  assert.equal((await w.enroll()).status, 201);
  const me = t.as(fam.student);
  const goals = [
    { subject: 'math', text: 'Finish the Chapter 5 practice problems and check my answers with the key.' },
    { subject: 'english', text: 'Read chapters 6 to 8 of my novel and write a paragraph on each.' },
    { subject: 'science', text: "Finish the lab report for this week's experiment, with the data table and graph." },
  ];
  // Wednesday: before the check-in there is nothing to set.
  setClock(t, '2026-10-14', '13:05');
  const early = await me.put('/api/notes/goals/week', { goals });
  assert.deepEqual([early.status, early.body.error], [400, 'no_visit_today']);
  assert.equal((await w.scan()).body.action, 'checkin');
  assert.deepEqual((await me.get('/api/notes/goals/week')).body.state, 'set');
  const set = await me.put('/api/notes/goals/week', { goals });
  assert.deepEqual([set.status, set.body.state, set.body.week_start], [200, 'done', '2026-10-12'], JSON.stringify(set.body));
  const [m, e, s] = set.body.goals.map(g => g.id);

  // Friday: the check-in asks about each goal on its own.
  setClock(t, '2026-10-16', '13:05');
  assert.equal((await w.scan()).body.action, 'checkin');
  assert.deepEqual((await me.get('/api/notes/goals/week')).body.goals.map(g => g.asks), [true, true, true]);
  assert.equal((await me.post('/api/notes/goals/week/check', { answers: [{ goalId: m, answer: 'yes' }] })).body.state, 'update');
  assert.equal((await me.post('/api/notes/goals/week/check', { answers: [{ goalId: e, answer: 'done', subject: 'history',
    text: 'Read Unit 3 and answer all of the review questions at the end.' }] })).body.state, 'update');
  const done = await me.post('/api/notes/goals/week/check', { answers: [{ goalId: s, answer: 'change', subject: 'art',
    text: 'Sketch three thumbnail ideas for my next portfolio piece.' }] });
  assert.deepEqual([done.body.state, done.body.goals.map(g => g.subject)], ['done', ['math', 'history', 'art']]);

  // Staff see the week with the day's answers on Daily notes, and post the note.
  const day = await t.as(staff).get(`/api/notes/day?location=${loc.id}&date=2026-10-16`);
  assert.deepEqual(day.body.goal_counts, { set: 1, none: 0 });
  const entry = day.body.students.find(x => x.id === fam.student.id);
  assert.deepEqual(entry.goals.map(g => [g.subject_label, g.answer]), [['Math', 'yes'], ['English', 'done'], ['History', null], ['Science', 'change'], ['Art', null]]);
  const ratings = Object.fromEntries(day.body.items.map(i => [i.id, 3]));
  const post = await t.as(staff).put(`/api/notes/students/${fam.student.id}/2026-10-16`,
    { ratings, comment: 'Nice work finishing the English reading.', post: true });
  assert.equal(post.status, 200);
  const note = (await t.as(fam.parent).get('/api/notes/today')).body.students[0].note;
  assert.deepEqual(note.goals.map(g => [g.subject, g.status, g.answer]), [
    ['math', 'open', 'yes'], ['english', 'done', 'done'], ['history', 'open', null], ['science', 'replaced', 'change'], ['art', 'open', null]]);

  // The parent's goals page has the week and every answer, any time.
  const page = await t.as(fam.parent).get('/api/notes/goals/student/' + fam.student.id);
  assert.deepEqual(page.body.checks.map(c => [c.date, c.answer]), [['2026-10-16', 'yes'], ['2026-10-16', 'done'], ['2026-10-16', 'change']]);
  assert.deepEqual(page.body.goals.filter(g => g.status === 'open').map(g => g.subject), ['math', 'history', 'art']);
});

test(['AT-5'], 'flow 3: a Monday date ending 4:00 PM with no visit: nothing at 4:20, one missed_day per active parent at 4:31, and nothing more on the next run', async () => {
  const w = await world(at(LA, '2026-10-15', '09:00')); // the Thursday before
  const { t, loc, fam } = w;
  const second = t.fx.user('parent', { location: loc });
  t.fx.link(second, fam.student);
  const pending = t.fx.user('parent', { location: loc });
  t.fx.link(pending, fam.student, 'pending');
  assert.equal((await w.enroll()).status, 201);

  setClock(t, '2026-10-19', '16:20'); // Monday, 20 minutes after the date ended
  t.jobs();
  const missed = () => t.db.prepare("SELECT user_id, ref_type, ref_id FROM notifications WHERE kind = 'missed_day' ORDER BY user_id").all();
  assert.deepEqual(missed(), []);

  setClock(t, '2026-10-19', '16:31');
  t.jobs();
  const sent = missed();
  assert.deepEqual(sent.map(n => n.user_id), [fam.parent.id, second.id]);
  assert.ok(sent.every(n => n.ref_type === 'missed_day'));
  // The notice opens that student's week: the parent's own student and the date.
  const open = await t.as(fam.parent).get('/api/attendance/missed/' + sent[0].ref_id);
  assert.deepEqual([open.status, open.body.student_id, open.body.local_date], [200, fam.student.id, '2026-10-19']);

  setClock(t, '2026-10-19', '17:00');
  t.jobs();
  assert.equal(missed().length, 2);
});

test(['AN-7'], "flow 4: HQ's alert to Irvine and Arcadia: the Irvine director can't end it, HQ can, it leaves the pinned list and its recipients are told", async () => {
  const w = await world(at(LA, '2026-10-14', '17:00'));
  const { t, loc, fam } = w;
  const arcadia = t.fx.location({ name: 'Arcadia', timezone: LA });
  const famB = t.fx.family(arcadia);
  const hq = t.fx.hq();
  const sent = await t.as(hq).post('/api/announcements/emergency',
    { title: 'Building closed early: power outage', body: 'Please pick students up now.', locations: [loc.id, arcadia.id] });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const id = sent.body.announcement.id;
  const pinned = async u => (await t.as(u).get('/api/announcements/feed')).body.active_emergencies.map(a => a.id);
  assert.deepEqual(await pinned(fam.parent), [id]);

  setClock(t, '2026-10-14', '19:42');
  assert.equal((await t.as(w.director).post(`/api/announcements/${id}/end`)).status, 403);
  const end = await t.as(hq).post(`/api/announcements/${id}/end`);
  assert.equal(end.status, 200, JSON.stringify(end.body));
  for (const u of [fam.parent, famB.parent, hq]) assert.deepEqual(await pinned(u), []);
  const post = (await t.as(fam.parent).get('/api/announcements/feed')).body.posts.find(p => p.id === id);
  assert.deepEqual([post.ended_at, post.ended_by], [at(LA, '2026-10-14', '19:42'), 'ELITE HQ']);
  for (const u of [fam.parent, fam.student, famB.parent, famB.student]) {
    assert.equal(t.fx.notifications(u, 'emergency_ended').length, 1);
  }
});

test(['EN-5', 'EN-8'], 'flow 5: a drop seats the waiting student with a switch, and the seat the switch frees goes to the next in line, in the same request', async () => {
  const w = await world(at(LA, '2026-10-14', '10:00'));
  const { t, loc } = w;
  const tth = t.fx.session(loc, { name: 'Afternoons TTh', weekdays: '2,4', start: '13:00', end: '16:00', capacity: 1 });
  const quiet = t.fx.session(loc, { name: 'Quiet Room TTh', weekdays: '2,4', start: '16:30', end: '18:30', capacity: 1 });
  const anh = t.fx.family(loc, { cap: 2 });
  const isha = t.fx.family(loc);
  const ben = t.fx.family(loc);
  assert.equal((await w.enroll(anh, tth)).status, 201);
  assert.equal((await w.enroll(isha, quiet)).status, 201);
  const wait = (f, s) => t.as(f.parent).post('/api/enrollment/waitlist', { studentId: f.student.id, sessionId: s.id });
  const anhWait = await wait(anh, quiet);
  assert.deepEqual([anhWait.status, anhWait.body.outcome, anhWait.body.keeps && anhWait.body.keeps.name], [201, 'waitlisted', 'Afternoons TTh']);
  assert.equal((await wait(ben, tth)).body.outcome, 'waitlisted');

  const ishaRow = t.db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status = 'active'").get(isha.student.id);
  const drop = await t.as(isha.parent).post(`/api/enrollment/enrollments/${ishaRow.id}/drop`);
  assert.equal(drop.status, 200, JSON.stringify(drop.body));

  const live = f => t.db.prepare("SELECT session_id, weekday FROM enrollments WHERE student_id = ? AND status = 'active' ORDER BY id")
    .all(f.student.id).map(r => [r.session_id, r.weekday]);
  assert.deepEqual(live(anh), [[quiet.id, 0]]);
  assert.deepEqual(live(ben), [[tth.id, 0]]);
  assert.deepEqual(live(isha), []);
  const ended = t.db.prepare('SELECT status, ended_at FROM enrollments WHERE student_id = ? AND session_id = ?').get(anh.student.id, tth.id);
  assert.deepEqual([ended.status, ended.ended_at], ['dropped', t.clock.now()]);
  const anhNote = t.fx.notifications(anh.parent, 'waitlist_promoted');
  assert.equal(anhNote.length, 1);
  assert.match(anhNote[0].title, /moved to Quiet Room TTh$/);
  assert.match(anhNote[0].body, /Afternoons TTh has ended for/);
  assert.equal(t.fx.notifications(ben.parent, 'waitlist_promoted').length, 1);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE status = 'waiting'").get().n, 0);
});

// Every Home card's request, for every role (public/js/views/*.js App.card).
// HQ has no home location, and a new parent has no students yet: the cards
// those users see must still load.
test(['NF-1'], 'every Home card loads for every role, including HQ with no home location and a parent with no students yet', async () => {
  const w = await world(at(LA, '2026-10-14', '10:00'));
  const { t, loc, fam, staff, director } = w;
  assert.equal((await w.enroll()).status, 201);
  const hq = t.fx.hq();
  const newParent = t.fx.user('parent', { location: loc });
  const week = 'from=2026-10-12&to=2026-10-18';
  const calls = {
    student: [fam.student, ['/api/checkin/status', '/api/notes/goals/week', '/api/enrollment/students',
      `/api/enrollment/students/${fam.student.id}/schedule`, '/api/membership/mine', '/api/announcements/feed?limit=10']],
    parent: [fam.parent, ['/api/checkin/status', '/api/accounts/family', '/api/notes/today', `/api/notes/goals/student/${fam.student.id}`,
      '/api/enrollment/students', `/api/enrollment/students/${fam.student.id}/schedule`, '/api/membership/mine', '/api/attendance/students',
      '/api/announcements/feed?limit=10']],
    newParent: [newParent, ['/api/checkin/status', '/api/accounts/family', '/api/notes/today',
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
  // The student request route is gone (D-48).
  assert.equal((await t.as(fam.parent).get('/api/enrollment/requests')).status, 404);
  const empty = await t.as(newParent).get('/api/enrollment/students');
  assert.deepEqual(empty.body.students, []);
});
