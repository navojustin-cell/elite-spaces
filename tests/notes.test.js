'use strict';
// Daily notes (PRD 6): DN-1..DN-5, plus NF-1 scope on every notes route.
const { test, makeApp, assert, at } = require('./lib');

const LA = 'America/Los_Angeles';
const TODAY = '2026-10-14', YESTERDAY = '2026-10-13', TWO_DAYS_AGO = '2026-10-12';
const PRD_ITEMS = ['On time', 'Focused', 'Respectful of others / not distracting', 'Productive use of time'];

// Two locations (Irvine, Arcadia), staff at each, HQ, and three families:
// Garcia (Leo, Sofia) and Nguyen (Anh) at Irvine, Roy (Noah) at Arcadia.
async function world() {
  const t = await makeApp();
  const A = t.fx.location({ name: 'Irvine' }), B = t.fx.location({ name: 'Arcadia' });
  const sessA = t.fx.session(A, { name: 'Afternoon Study' });
  const staffA = t.fx.staff(A, { name: 'Chris Ortiz' }), dirA = t.fx.director(A, { name: 'Dana Park' });
  const staffB = t.fx.staff(B, { name: 'Jordan Wu' }), dirB = t.fx.director(B, { name: 'Priya Shah' });
  const hq = t.fx.hq({ name: 'Morgan Lee' });
  const rename = (u, name) => { t.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id); u.name = name; return u; };
  const fa = t.fx.family(A, { students: 2 }), fb = t.fx.family(A), fc = t.fx.family(B);
  rename(fa.students[0], 'Leo Garcia'); rename(fa.students[1], 'Sofia Garcia'); rename(fa.parent, 'Maria Garcia');
  rename(fb.student, 'Anh Nguyen'); rename(fb.parent, 'Thanh Nguyen');
  rename(fc.student, 'Noah Roy'); rename(fc.parent, 'Sophie Roy');
  const visit = (s, loc, date = TODAY, o = {}) => t.fx.visit(s, loc, Object.assign({
    session: loc.id === A.id ? sessA : null, weekday: 3, local_date: date,
    check_in_at: at(loc.timezone, date, '09:31'), check_out_at: at(loc.timezone, date, '11:58'), checkout_method: 'scan',
  }, o));
  const items = t.db.prepare('SELECT id, label FROM note_items WHERE active = 1 ORDER BY position').all();
  const all = (v, list = items) => Object.fromEntries(list.map(i => [i.id, v]));
  const save = (user, student, date, body) => t.as(user).put(`/api/notes/students/${student.id}/${date}`, body);
  const notes = () => t.db.prepare('SELECT * FROM daily_notes ORDER BY id').all();
  const ratingsOf = noteId => t.db.prepare('SELECT item_id, label, rating FROM daily_note_ratings WHERE note_id = ? ORDER BY position').all(noteId);
  return { t, A, B, sessA, staffA, dirA, staffB, dirB, hq, fa, fb, fc, rename, visit, items, all, save, notes, ratingsOf };
}

// ---------------------------------------------------------------- DN-4

test(['DN-4', 'DN-1'], 'the day list shows exactly the students who checked in at this location that day, ratings blank', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A);                        // here today
  w.visit(sofia, w.A, YESTERDAY);           // here yesterday only
  w.visit(w.fc.student, w.B);               // at the other location today
  w.t.fx.enroll(w.fb.student, w.sessA, 3);  // enrolled today but never came
  const r = await w.t.as(w.staffA).get('/api/notes/day');
  assert.equal(r.status, 200);
  assert.equal(r.body.date, TODAY);
  assert.equal(r.body.today, TODAY);
  assert.equal(r.body.location.id, w.A.id);
  assert.deepEqual(r.body.items.map(i => i.label), PRD_ITEMS);
  assert.deepEqual(r.body.students.map(s => s.id), [leo.id]);
  const s = r.body.students[0];
  assert.equal(s.name, 'Leo Garcia');
  assert.equal(s.status, 'none');
  assert.equal(s.note, null);
  assert.equal(s.comment, null);
  assert.deepEqual(s.ratings.map(x => x.label), PRD_ITEMS);
  assert.deepEqual(s.ratings.map(x => x.rating), [null, null, null, null]);
  assert.deepEqual(s.visits.map(v => [v.session_name, v.check_in_at]), [['Afternoon Study', at(LA, TODAY, '09:31')]]);
  assert.deepEqual([r.body.posted, r.body.total], [0, 1]);

  const y = await w.t.as(w.staffA).get('/api/notes/day?date=' + YESTERDAY);
  assert.equal(y.status, 200);
  assert.deepEqual(y.body.students.map(x => x.id), [sofia.id]);

  // Two visits on one day are one row, with both visits listed.
  w.visit(leo, w.A, TODAY, { session: null, check_in_at: at(LA, TODAY, '16:30'), check_out_at: null, checkout_method: null });
  const twice = await w.t.as(w.staffA).get('/api/notes/day');
  assert.equal(twice.body.students.length, 1);
  assert.deepEqual(twice.body.students[0].visits.map(v => v.check_in_at), [at(LA, TODAY, '09:31'), at(LA, TODAY, '16:30')]);

  const bad = await w.t.as(w.staffA).get('/api/notes/day?date=2026-02-30');
  assert.equal(bad.status, 400);
});

test(['DN-4', 'DN-2'], 'staff can save a half-finished note from the list; posting needs every item rated', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const [onTime, focused, respectful, productive] = w.items;

  const draft = await w.save(w.staffA, leo, TODAY, { ratings: { [onTime.id]: 3 }, comment: 'Settling in well.' });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.student.status, 'draft');
  assert.deepEqual(draft.body.student.ratings.map(x => x.rating), [3, null, null, null]);
  const [row] = w.notes();
  assert.equal(row.status, 'draft');
  assert.equal(row.posted_at, null);
  assert.equal(w.t.fx.notifications(w.fa.parent).length, 0, 'a draft does not reach parents');
  assert.equal((await w.t.as(w.fa.parent).get('/api/notes/feed')).body.notes.length, 0);

  // The list shows the draft where staff left it.
  const day = await w.t.as(w.staffA).get('/api/notes/day');
  const s = day.body.students[0];
  assert.equal(s.status, 'draft');
  assert.equal(s.comment, 'Settling in well.');
  assert.deepEqual(s.ratings.map(x => x.rating), [3, null, null, null]);
  assert.deepEqual([day.body.posted, day.body.total], [0, 1]);

  // Posting with blanks is refused, naming what's missing.
  const blank = await w.save(w.staffA, leo, TODAY, { ratings: { [onTime.id]: 3, [respectful.id]: 2 }, post: true });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, 'unrated');
  assert.equal(blank.body.message, 'Rate Focused and Productive use of time to post this note.');
  assert.equal(w.notes()[0].status, 'draft');
  assert.deepEqual(w.ratingsOf(row.id).map(x => x.rating), [3, null, null, null], 'a refused post changes nothing');
  assert.equal(w.t.fx.notifications(w.fa.parent).length, 0);

  const ok = await w.save(w.staffA, leo, TODAY, {
    ratings: { [onTime.id]: 3, [focused.id]: 2, [respectful.id]: 2, [productive.id]: 3 }, comment: 'Settling in well.', post: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.student.status, 'posted');
  assert.equal(w.notes().length, 1, 'still one note for the day');
  assert.equal(w.notes()[0].status, 'posted');
  assert.equal(w.notes()[0].posted_by, w.staffA.id);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1);
});

test(['DN-4'], 'the list counts notes posted and puts the ones still to write first', async () => {
  const w = await world();
  const ava = w.rename(w.fa.students[0], 'Ava Adams'), ben = w.rename(w.fa.students[1], 'Ben Brown'), cara = w.rename(w.fb.student, 'Cara Cole');
  for (const s of [ava, ben, cara]) w.visit(s, w.A);
  assert.equal((await w.save(w.staffA, ava, TODAY, { ratings: w.all(3), post: true })).status, 200);
  assert.equal((await w.save(w.staffA, cara, TODAY, { ratings: w.all(2) })).status, 200);
  const r = await w.t.as(w.staffA).get('/api/notes/day');
  assert.deepEqual([r.body.posted, r.body.total], [1, 3]);
  assert.deepEqual(r.body.students.map(s => [s.name, s.status]), [['Ben Brown', 'none'], ['Cara Cole', 'draft'], ['Ava Adams', 'posted']]);
});

test(['DN-4'], "the day follows the location's own time zone", async () => {
  const w = await world();
  const T = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  const staffT = w.t.fx.staff(T);
  const noah = w.t.fx.family(T).student;

  // 17:30 in Los Angeles is 00:30 on Oct 15 in UTC, but still Oct 14 at Irvine.
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  w.t.clock.set(at(LA, TODAY, '17:30'));
  const irvine = await w.t.as(w.staffA).get('/api/notes/day');
  assert.equal(irvine.status, 200);
  assert.equal(irvine.body.today, TODAY);
  assert.equal(irvine.body.date, TODAY);
  assert.deepEqual(irvine.body.students.map(s => s.id), [leo.id]);

  w.t.clock.set(at(LA, TODAY, '22:30')); // 01:30 on Oct 15 in Toronto
  w.visit(noah, T, '2026-10-15', { check_in_at: at('America/Toronto', '2026-10-15', '01:00'), check_out_at: null, checkout_method: null });
  w.visit(noah, T, TODAY);
  const r = await w.t.as(staffT).get('/api/notes/day');
  assert.equal(r.status, 200);
  assert.equal(r.body.today, '2026-10-15');
  assert.equal(r.body.date, '2026-10-15');
  assert.deepEqual(r.body.students.map(s => s.visits.length), [1]);
  assert.equal(r.body.students[0].visits[0].check_in_at, at('America/Toronto', '2026-10-15', '01:00'));
});

// ---------------------------------------------------------------- DN-1

test(['DN-1'], 'a note can be written only for a student who checked in at this location that day', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(sofia, w.A, YESTERDAY);
  w.visit(leo, w.B, TODAY); // a visit somewhere else doesn't count
  for (const [s, date] of [[w.fb.student, TODAY], [sofia, TODAY], [leo, TODAY], [leo, YESTERDAY]]) {
    const r = await w.save(w.staffA, s, date, { ratings: w.all(3), post: true });
    assert.equal(r.status, 400, `${s.name} on ${date}`);
    assert.equal(r.body.error, 'no_visit');
  }
  const msg = await w.save(w.staffA, w.fb.student, TODAY, { ratings: w.all(3) });
  assert.equal(msg.body.message, "Anh Nguyen didn't check in at Irvine on Wed, Oct 14, so there's no note to write.");
  assert.equal(w.notes().length, 0);
  assert.equal(w.t.fx.notifications(w.fa.parent).length, 0);
  assert.equal(w.t.fx.notifications(w.fb.parent).length, 0);

  // Sofia came yesterday, so yesterday's note is fine, even written today.
  const ok = await w.save(w.staffA, sofia, YESTERDAY, { ratings: w.all(3), post: true });
  assert.equal(ok.status, 200);
  const [n] = w.notes();
  assert.deepEqual([n.student_id, n.location_id, n.local_date, n.status, n.posted_by, n.created_by],
    [sofia.id, w.A.id, YESTERDAY, 'posted', w.staffA.id, w.staffA.id]);
  assert.equal(n.posted_at, w.t.clock.now());
});

// ---------------------------------------------------------------- DN-2

test(['DN-2'], 'each item is rated 1 Needs work, 2 Good or 3 Great; anything else is refused', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const items = await w.t.as(w.staffA).get('/api/notes/items');
  assert.equal(items.status, 200);
  assert.deepEqual(items.body.scale, { 1: 'Needs work', 2: 'Good', 3: 'Great' });
  assert.deepEqual(items.body.items.map(i => i.label), PRD_ITEMS);

  for (const v of [0, 4, -1, 2.5, '3', 'Great', true]) {
    const r = await w.save(w.staffA, leo, TODAY, { ratings: Object.assign(w.all(2), { [w.items[1].id]: v }) });
    assert.equal(r.status, 400, 'rating ' + JSON.stringify(v));
    assert.equal(r.body.error, 'bad_rating');
    assert.equal(r.body.message, 'Rate Focused as Needs work, Good or Great.');
  }
  const unknown = await w.save(w.staffA, leo, TODAY, { ratings: Object.assign(w.all(2), { 999: 2 }) });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown_item');
  assert.equal(w.notes().length, 0);

  const ids = w.items.map(i => i.id);
  const ok = await w.save(w.staffA, leo, TODAY, { ratings: { [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: 3, [ids[3]]: 3 }, post: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.student.ratings.map(x => x.rating), [1, 2, 3, 3]);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => [x.label, x.rating]), PRD_ITEMS.map((l, i) => [l, [1, 2, 3, 3][i]]));
  const feed = await w.t.as(w.fa.parent).get('/api/notes/feed');
  assert.deepEqual(feed.body.notes[0].ratings.map(x => x.word), ['Needs work', 'Good', 'Great', 'Great']);
});

test(['DN-2'], 'HQ adds, renames, reorders, retires and restores checklist items, and new notes follow', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const [onTime, focused, respectful, productive] = w.items;
  const hq = w.t.as(w.hq);

  const add = await hq.post('/api/notes/items', { label: '  Asked for help   when stuck ' });
  assert.equal(add.status, 201);
  const help = add.body.item;
  assert.deepEqual([help.label, help.position, help.active], ['Asked for help when stuck', 5, 1]);
  assert.equal((await hq.patch('/api/notes/items/' + focused.id, { label: 'Stayed focused' })).status, 200);
  const order = await hq.put('/api/notes/items/order', { ids: [help.id, onTime.id, focused.id, respectful.id, productive.id] });
  assert.equal(order.status, 200);
  const retire = await hq.patch('/api/notes/items/' + productive.id, { active: false });
  assert.equal(retire.status, 200);
  assert.equal(retire.body.item.active, 0);

  const NEW = ['Asked for help when stuck', 'On time', 'Stayed focused', 'Respectful of others / not distracting'];
  const day = await w.t.as(w.staffA).get('/api/notes/day');
  assert.deepEqual(day.body.items.map(i => i.label), NEW);
  assert.deepEqual(day.body.students[0].ratings.map(x => x.label), NEW);
  assert.deepEqual(day.body.students[0].ratings.map(x => x.rating), [null, null, null, null]);

  // HQ still sees the retired item, after the ones in use.
  const list = await hq.get('/api/notes/items');
  assert.deepEqual(list.body.items.map(i => [i.label, i.active]), [...NEW.map(l => [l, 1]), ['Productive use of time', 0]]);

  // New notes rate the new item and not the retired one.
  const old = await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), post: true });
  assert.equal(old.status, 400);
  const current = [help, onTime, focused, respectful];
  const ok = await w.save(w.staffA, leo, TODAY, { ratings: w.all(3, current), post: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.label), NEW);

  // Restoring puts it back on new notes.
  assert.equal((await hq.patch('/api/notes/items/' + productive.id, { active: true })).status, 200);
  assert.deepEqual((await w.t.as(w.staffA).get('/api/notes/day')).body.items.map(i => i.label), [...NEW, 'Productive use of time']);

  // Each change is logged.
  assert.equal(w.t.fx.audit('note_item.add').length, 1);
  assert.equal(w.t.fx.audit('note_item.update').length, 3);
  assert.equal(w.t.fx.audit('note_item.reorder').length, 1);
  assert.equal(w.t.fx.audit('note_item.update')[0].actor_id, w.hq.id);

  // Bad input.
  assert.equal((await hq.post('/api/notes/items', { label: '   ' })).status, 400);
  assert.equal((await hq.patch('/api/notes/items/' + focused.id, { label: 'x'.repeat(81) })).status, 400);
  assert.equal((await hq.patch('/api/notes/items/999', { label: 'Nope' })).status, 404);
  assert.equal((await hq.put('/api/notes/items/order', { ids: [help.id, onTime.id] })).status, 400);
  assert.equal((await hq.put('/api/notes/items/order', { ids: [help.id, help.id, focused.id, respectful.id, productive.id] })).status, 400);
});

test(['DN-2'], 'the checklist always keeps at least one item', async () => {
  const w = await world();
  const hq = w.t.as(w.hq);
  for (const i of w.items.slice(0, 3)) assert.equal((await hq.patch('/api/notes/items/' + i.id, { active: false })).status, 200);
  const last = await hq.patch('/api/notes/items/' + w.items[3].id, { active: false });
  assert.equal(last.status, 400);
  assert.equal(last.body.error, 'last_item');
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM note_items WHERE active = 1').get().n, 1);
});

test(['DN-2', 'DN-5'], 'a posted note keeps the checklist wording it was written with', async () => {
  const w = await world();
  const leo = w.fa.students[0], anh = w.fb.student;
  w.visit(leo, w.A); w.visit(anh, w.A);
  const [onTime, focused, respectful, productive] = w.items;
  const posted = await w.save(w.staffA, leo, TODAY, {
    ratings: { [onTime.id]: 3, [focused.id]: 2, [respectful.id]: 3, [productive.id]: 1 }, post: true });
  assert.equal(posted.status, 200);

  const hq = w.t.as(w.hq);
  await hq.patch('/api/notes/items/' + focused.id, { label: 'Stayed focused' });
  await hq.patch('/api/notes/items/' + productive.id, { active: false });
  const help = (await hq.post('/api/notes/items', { label: 'Asked for help when stuck' })).body.item;

  const feed = await w.t.as(w.fa.parent).get('/api/notes/feed');
  assert.deepEqual(feed.body.notes[0].ratings.map(x => [x.label, x.word]),
    [['On time', 'Great'], ['Focused', 'Good'], ['Respectful of others / not distracting', 'Great'], ['Productive use of time', 'Needs work']]);

  const day = await w.t.as(w.staffA).get('/api/notes/day');
  const byId = Object.fromEntries(day.body.students.map(s => [s.id, s]));
  assert.deepEqual(byId[leo.id].ratings.map(x => x.label), PRD_ITEMS, 'the posted note keeps its items');
  assert.deepEqual(byId[anh.id].ratings.map(x => x.label),
    ['On time', 'Stayed focused', 'Respectful of others / not distracting', 'Asked for help when stuck'], 'a new note uses the new list');

  // Editing the posted note works on its own items, retired one included.
  const edit = await w.save(w.staffA, leo, TODAY, { ratings: { [onTime.id]: 3, [focused.id]: 2, [respectful.id]: 3, [productive.id]: 2 } });
  assert.equal(edit.status, 200);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => [x.label, x.rating]), PRD_ITEMS.map((l, i) => [l, [3, 2, 3, 2][i]]));

  const fresh = await w.save(w.staffA, anh, TODAY, { ratings: w.all(2, [onTime, focused, respectful, help]), post: true });
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.student.ratings.map(x => x.label),
    ['On time', 'Stayed focused', 'Respectful of others / not distracting', 'Asked for help when stuck']);
});

// ---------------------------------------------------------------- DN-3

test(['DN-3'], 'the comment is optional; when given, parents see it as written', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A); w.visit(sofia, w.A);
  const none = await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), post: true });
  assert.equal(none.status, 200);
  const withText = await w.save(w.staffA, sofia, TODAY, { ratings: w.all(2), comment: '  Worked through two chapters of algebra.  ', post: true });
  assert.equal(withText.status, 200);
  const rows = Object.fromEntries(w.notes().map(n => [n.student_id, n]));
  assert.equal(rows[leo.id].comment, null);
  assert.equal(rows[sofia.id].comment, 'Worked through two chapters of algebra.');

  const feed = await w.t.as(w.fa.parent).get('/api/notes/feed');
  const byStudent = Object.fromEntries(feed.body.notes.map(n => [n.student_id, n]));
  assert.equal(byStudent[leo.id].comment, null);
  assert.equal(byStudent[sofia.id].comment, 'Worked through two chapters of algebra.');

  const long = await w.save(w.staffA, sofia, TODAY, { ratings: w.all(2), comment: 'x'.repeat(2001) });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'comment_too_long');
  assert.equal(w.t.db.prepare('SELECT comment FROM daily_notes WHERE student_id = ?').get(sofia.id).comment, 'Worked through two chapters of algebra.');

  // Clearing the comment on a posted note removes it.
  const cleared = await w.save(w.staffA, sofia, TODAY, { ratings: w.all(2), comment: '' });
  assert.equal(cleared.status, 200);
  assert.equal(w.t.db.prepare('SELECT comment FROM daily_notes WHERE student_id = ?').get(sofia.id).comment, null);
});

// ---------------------------------------------------------------- DN-5

test(['DN-5'], 'posting notifies each active parent once; editing a posted note updates it without a second notification', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const guardian2 = w.t.fx.user('parent', { location: w.A, name: 'Luis Garcia' });
  w.t.fx.link(guardian2, leo);
  const pending = w.t.fx.user('parent', { location: w.A });
  w.t.fx.link(pending, leo, 'pending');

  w.t.clock.set(at(LA, TODAY, '16:10'));
  const r = await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), comment: 'Great day.', post: true });
  assert.equal(r.status, 200);
  const noteId = r.body.student.note.id;
  assert.equal(r.body.student.note.posted_at, at(LA, TODAY, '16:10'));
  assert.equal(r.body.student.note.posted_by_name, 'Chris Ortiz');
  for (const p of [w.fa.parent, guardian2]) {
    const n = w.t.fx.notifications(p, 'note');
    assert.equal(n.length, 1);
    assert.deepEqual([n[0].ref_type, n[0].ref_id], ['daily_note', noteId]);
    assert.equal(n[0].title, "Leo's daily note from Irvine is ready");
    assert.equal(n[0].body, 'Wed, Oct 14 · posted by Chris Ortiz. Open Notes to read it.');
  }
  assert.equal(w.t.fx.notifications(pending).length, 0);
  assert.equal(w.t.fx.notifications(w.fb.parent).length, 0);
  assert.equal(w.t.fx.notifications(leo).length, 0, 'students are not told (D-2)');
  assert.equal(w.t.fx.audit('note.post').length, 1);

  // Another staff member edits it later.
  const sam = w.t.fx.staff(w.A, { name: 'Sam Rivera' });
  w.t.clock.set(at(LA, TODAY, '16:30'));
  const body = { ratings: Object.assign(w.all(3), { [w.items[1].id]: 2 }), comment: 'Great day. Drifted a little after 3.' };
  const e = await w.save(sam, leo, TODAY, body);
  assert.equal(e.status, 200);
  assert.equal(e.body.student.status, 'posted');
  assert.equal(e.body.student.note.edited_at, at(LA, TODAY, '16:30'));
  assert.equal(e.body.student.note.edited_by_name, 'Sam Rivera');
  assert.equal(e.body.student.note.posted_by_name, 'Chris Ortiz');
  assert.equal(w.notes().length, 1);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1, 'no second notification');
  assert.equal(w.t.fx.notifications(guardian2, 'note').length, 1);
  const [log] = w.t.fx.audit('note.edit');
  assert.equal(log.actor_id, sam.id);
  const detail = JSON.parse(log.detail);
  assert.equal(detail.before.ratings[1].rating, 3);
  assert.equal(detail.after.ratings[1].rating, 2);
  assert.equal(detail.after.comment, 'Great day. Drifted a little after 3.');

  const feed = await w.t.as(w.fa.parent).get('/api/notes/feed');
  assert.equal(feed.body.notes[0].ratings[1].word, 'Good');
  assert.equal(feed.body.notes[0].comment, 'Great day. Drifted a little after 3.');
  assert.equal(feed.body.notes[0].edited_at, at(LA, TODAY, '16:30'));

  // Saving again with nothing changed doesn't mark it edited again.
  w.t.clock.set(at(LA, TODAY, '17:00'));
  assert.equal((await w.save(sam, leo, TODAY, body)).status, 200);
  assert.equal(w.notes()[0].edited_at, at(LA, TODAY, '16:30'));
  assert.equal(w.t.fx.audit('note.edit').length, 1);

  // A posted note can't be blanked.
  const blank = await w.save(sam, leo, TODAY, { ratings: Object.assign(w.all(3), { [w.items[0].id]: null }) });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, 'unrated');
});

test(['DN-5'], 'parents browse posted notes by date, newest first, with the visit details; drafts stay hidden', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  for (const d of [TWO_DAYS_AGO, YESTERDAY, TODAY]) w.visit(leo, w.A, d);
  w.visit(sofia, w.A, YESTERDAY);
  for (const [s, d] of [[leo, TWO_DAYS_AGO], [leo, YESTERDAY], [sofia, YESTERDAY]]) {
    assert.equal((await w.save(w.staffA, s, d, { ratings: w.all(3), post: true })).status, 200);
  }
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(2), comment: 'Not done yet' })).status, 200); // draft

  const p = w.t.as(w.fa.parent);
  const feed = await p.get('/api/notes/feed');
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.students.map(s => s.name), ['Leo Garcia', 'Sofia Garcia']);
  assert.deepEqual(feed.body.notes.map(n => [n.local_date, n.student_name]),
    [[YESTERDAY, 'Leo Garcia'], [YESTERDAY, 'Sofia Garcia'], [TWO_DAYS_AGO, 'Leo Garcia']]);
  assert.equal(feed.body.more, false);
  const n = feed.body.notes[0];
  assert.equal(n.location_name, 'Irvine');
  assert.equal(n.timezone, LA);
  assert.equal(n.posted_by_name, 'Chris Ortiz');
  assert.equal(n.edited_at, null);
  assert.deepEqual(n.visits.map(v => [v.session_name, v.check_in_at, v.check_out_at]),
    [['Afternoon Study', at(LA, YESTERDAY, '09:31'), at(LA, YESTERDAY, '11:58')]]);
  assert.deepEqual(n.ratings.map(x => x.label), PRD_ITEMS);

  const onlySofia = await p.get('/api/notes/feed?student=' + sofia.id);
  assert.deepEqual(onlySofia.body.notes.map(x => [x.local_date, x.student_id]), [[YESTERDAY, sofia.id]]);
  const upTo = await p.get('/api/notes/feed?to=' + TWO_DAYS_AGO);
  assert.deepEqual(upTo.body.notes.map(x => x.local_date), [TWO_DAYS_AGO]);
  const oneDay = await p.get(`/api/notes/feed?from=${YESTERDAY}&to=${YESTERDAY}`);
  assert.deepEqual(oneDay.body.notes.map(x => x.student_id), [leo.id, sofia.id]);
  const paged = await p.get('/api/notes/feed?limit=2');
  assert.equal(paged.body.notes.length, 2);
  assert.equal(paged.body.more, true);
  assert.equal((await p.get('/api/notes/feed?to=yesterday')).status, 400);
});

test(['DN-5'], "a parent's home shows today's posted note for each student", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A); w.visit(sofia, w.A); w.visit(leo, w.A, YESTERDAY);
  assert.equal((await w.save(w.staffA, leo, YESTERDAY, { ratings: w.all(1), post: true })).status, 200);
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), comment: 'Focused all morning.', post: true })).status, 200);
  assert.equal((await w.save(w.staffA, sofia, TODAY, { ratings: w.all(2) })).status, 200); // draft only

  const r = await w.t.as(w.fa.parent).get('/api/notes/today');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.students.map(s => [s.name, s.date, s.visited]), [['Leo Garcia', TODAY, true], ['Sofia Garcia', TODAY, true]]);
  const [l, s] = r.body.students;
  assert.equal(l.note.local_date, TODAY);
  assert.equal(l.note.comment, 'Focused all morning.');
  assert.deepEqual(l.note.ratings.map(x => x.word), ['Great', 'Great', 'Great', 'Great']);
  assert.equal(s.note, null, 'a draft is not shown');

  const other = await w.t.as(w.fb.parent).get('/api/notes/today');
  assert.deepEqual(other.body.students.map(x => [x.id, x.visited, x.note]), [[w.fb.student.id, false, null]]);
});

test(['DN-5'], "the parent home's 'today' is the date at each student's home location", async () => {
  const w = await world();
  const TOR = 'America/Toronto', OCT15 = '2026-10-15';
  const T = w.t.fx.location({ name: 'Toronto', timezone: TOR });
  const staffT = w.t.fx.staff(T);
  const ft = w.t.fx.family(T);
  const eli = w.rename(ft.student, 'Eli Martin');
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  w.visit(eli, T);
  w.visit(eli, T, OCT15, { check_in_at: at(TOR, OCT15, '01:00'), check_out_at: null, checkout_method: null });
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(2), comment: 'Leo, Wednesday', post: true })).status, 200);
  assert.equal((await w.save(staffT, eli, TODAY, { ratings: w.all(1), comment: 'Eli, Wednesday', post: true })).status, 200);
  assert.equal((await w.save(staffT, eli, OCT15, { ratings: w.all(3), comment: 'Eli, Thursday', post: true })).status, 200);
  const home = async parent => {
    const r = await w.t.as(parent).get('/api/notes/today');
    assert.equal(r.status, 200);
    return r.body.students.map(s => [s.name, s.date, s.visited, s.note && s.note.local_date, s.note && s.note.comment]);
  };

  // 17:30 in Los Angeles is 00:30 on Oct 15 in UTC, but still Oct 14 in LA (and 20:30 in Toronto).
  w.t.clock.set(at(LA, TODAY, '17:30'));
  assert.deepEqual(await home(w.fa.parent), [['Leo Garcia', TODAY, true, TODAY, 'Leo, Wednesday'], ['Sofia Garcia', TODAY, false, null, null]]);
  assert.deepEqual(await home(ft.parent), [['Eli Martin', TODAY, true, TODAY, 'Eli, Wednesday']]);

  // 22:30 in Los Angeles is 01:30 on Oct 15 in Toronto (05:30 UTC): Eli's card moves on, Leo's doesn't.
  w.t.clock.set(at(LA, TODAY, '22:30'));
  assert.deepEqual(await home(ft.parent), [['Eli Martin', OCT15, true, OCT15, 'Eli, Thursday']]);
  assert.deepEqual(await home(w.fa.parent), [['Leo Garcia', TODAY, true, TODAY, 'Leo, Wednesday'], ['Sofia Garcia', TODAY, false, null, null]]);
});

test(['DN-5', 'NF-1'], 'students cannot see daily notes in v1, not even their own', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), post: true })).status, 200);
  const me = w.t.as(leo);
  for (const url of ['/api/notes/feed', '/api/notes/feed?student=' + leo.id, '/api/notes/today', '/api/notes/day', '/api/notes/items']) {
    const r = await me.get(url);
    assert.equal(r.status, 403, url);
    assert.equal(r.body.notes, undefined);
  }
  assert.equal((await me.put(`/api/notes/students/${leo.id}/${TODAY}`, { ratings: w.all(1) })).status, 403);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.rating), [3, 3, 3, 3]);
});

// ---------------------------------------------------------------- NF-1

test(['NF-1', 'DN-1'], "staff and directors can't read or write another location's notes; HQ can", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A); w.visit(w.fb.student, w.A); w.visit(w.fc.student, w.B);
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), comment: 'Kind to others.', post: true })).status, 200);

  for (const u of [w.staffB, w.dirB]) {
    const read = await w.t.as(u).get('/api/notes/day?location=' + w.A.id);
    assert.equal(read.status, 403, u.role + ' reading A');
    assert.equal(read.body.students, undefined);
    const own = await w.t.as(u).get('/api/notes/day');
    assert.deepEqual(own.body.students.map(s => s.id), [w.fc.student.id], u.role + ' sees only B');
    for (const body of [{ ratings: w.all(1) }, { ratings: w.all(1), location_id: w.A.id }]) {
      const write = await w.save(u, leo, TODAY, body);
      assert.equal(write.status, 403, u.role + ' writing for A');
    }
    assert.equal((await w.save(u, w.fb.student, TODAY, { ratings: w.all(1), post: true })).status, 403);
  }
  assert.deepEqual(w.notes().map(n => [n.student_id, n.edited_at]), [[leo.id, null]]);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.rating), [3, 3, 3, 3]);
  assert.equal(w.t.fx.notifications(w.fb.parent).length, 0);

  // A director at A works like staff at A.
  const dirOwn = await w.t.as(w.dirA).get('/api/notes/day');
  assert.deepEqual(dirOwn.body.students.map(s => s.id).sort(), [leo.id, w.fb.student.id].sort());

  // HQ picks a location, and can write too.
  const hq = w.t.as(w.hq);
  assert.equal((await hq.get('/api/notes/day')).status, 400);
  assert.equal((await hq.get('/api/notes/day?location=999')).status, 404);
  const hqA = await hq.get('/api/notes/day?location=' + w.A.id);
  assert.equal(hqA.status, 200);
  assert.equal(hqA.body.students.find(s => s.id === leo.id).comment, 'Kind to others.');
  const hqB = await hq.get('/api/notes/day?location=' + w.B.id);
  assert.deepEqual(hqB.body.students.map(s => s.id), [w.fc.student.id]);
  const hqWrite = await w.save(w.hq, w.fc.student, TODAY, { ratings: w.all(2), post: true });
  assert.equal(hqWrite.status, 200);
  const hqNote = w.notes().find(n => n.student_id === w.fc.student.id);
  assert.deepEqual([hqNote.location_id, hqNote.status, hqNote.posted_by], [w.B.id, 'posted', w.hq.id]);
  assert.equal(w.t.fx.notifications(w.fc.parent, 'note').length, 1);
});

test(['NF-1'], "parents see only their own family's notes and can't use staff routes", async () => {
  const w = await world();
  const leo = w.fa.students[0], anh = w.fb.student;
  w.visit(leo, w.A); w.visit(anh, w.A);
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), post: true })).status, 200);
  assert.equal((await w.save(w.staffA, anh, TODAY, { ratings: w.all(2), post: true })).status, 200);

  const nguyen = w.t.as(w.fb.parent);
  const feed = await nguyen.get('/api/notes/feed');
  assert.deepEqual(feed.body.notes.map(n => n.student_id), [anh.id]);
  assert.deepEqual(feed.body.students.map(s => s.id), [anh.id]);
  const peek = await nguyen.get('/api/notes/feed?student=' + leo.id);
  assert.equal(peek.status, 403);
  assert.equal(peek.body.notes, undefined);
  const today = await nguyen.get('/api/notes/today');
  assert.deepEqual(today.body.students.map(s => s.id), [anh.id]);

  // A parent whose link is still pending sees nothing.
  const pendingParent = w.t.fx.user('parent', { location: w.A });
  w.t.fx.link(pendingParent, leo, 'pending');
  assert.deepEqual((await w.t.as(pendingParent).get('/api/notes/feed')).body.notes, []);
  assert.equal((await w.t.as(pendingParent).get('/api/notes/feed?student=' + leo.id)).status, 403);

  // Staff and HQ routes are closed to parents.
  const garcia = w.t.as(w.fa.parent);
  assert.equal((await garcia.get('/api/notes/day')).status, 403);
  assert.equal((await garcia.get('/api/notes/day?location=' + w.A.id)).status, 403);
  assert.equal((await garcia.get('/api/notes/items')).status, 403);
  assert.equal((await garcia.put(`/api/notes/students/${leo.id}/${TODAY}`, { ratings: w.all(1) })).status, 403);
  assert.equal((await garcia.post('/api/notes/items', { label: 'Nope' })).status, 403);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.rating), [3, 3, 3, 3]);
  for (const url of ['/api/notes/day', '/api/notes/feed', '/api/notes/today', '/api/notes/items']) {
    assert.equal((await w.t.anon.get(url)).status, 401, url);
  }
});

test(['NF-1', 'DN-2'], 'only HQ can change the checklist', async () => {
  const w = await world();
  for (const u of [w.staffA, w.dirA, w.fa.parent, w.fa.students[0]]) {
    const c = w.t.as(u);
    assert.equal((await c.post('/api/notes/items', { label: 'Tidy desk' })).status, 403, u.role + ' add');
    assert.equal((await c.patch('/api/notes/items/' + w.items[0].id, { label: 'Punctual' })).status, 403, u.role + ' rename');
    assert.equal((await c.patch('/api/notes/items/' + w.items[1].id, { active: false })).status, 403, u.role + ' retire');
    assert.equal((await c.put('/api/notes/items/order', { ids: w.items.map(i => i.id).reverse() })).status, 403, u.role + ' reorder');
  }
  assert.deepEqual(w.t.db.prepare('SELECT label, position, active FROM note_items ORDER BY id').all().map(r => [r.label, r.position, r.active]),
    PRD_ITEMS.map((l, i) => [l, i + 1, 1]));
  assert.equal(w.t.fx.audit().length, 0);
  // Staff can read it.
  const read = await w.t.as(w.staffA).get('/api/notes/items');
  assert.equal(read.status, 200);
  assert.equal(read.body.items.length, 4);
});
