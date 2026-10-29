'use strict';
// Daily notes (PRD 6): DN-1..DN-5, plus NF-1 scope on every notes route, and
// the notes screens (public/js/views/notes.js) in a browser tab at the end.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, at, ROOT, load } = require('./lib');

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
  w.t.fx.enroll(w.fb.student, w.sessA);     // enrolled (MWF, so today) but never came
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

// L45: two identical rating rows would show staff (and parents) the same item twice.
test(['DN-2'], 'a checklist item name is used only once, whatever its case or spacing; a retired name is restored, not added again', async () => {
  const w = await world();
  const hq = w.t.as(w.hq);
  const [onTime, focused, , productive] = w.items;
  const labels = () => w.t.db.prepare('SELECT label, active FROM note_items ORDER BY id').all().map(r => [r.label, r.active]);
  const before = labels();

  for (const label of ['Focused', 'focused', '  FOCUSED  ', 'On   time']) {
    const r = await hq.post('/api/notes/items', { label });
    assert.equal(r.status, 409, label);
    assert.equal(r.body.error, 'duplicate_label', label);
  }
  assert.equal((await hq.post('/api/notes/items', { label: 'focused' })).body.message,
    '"Focused" is already on the checklist. Give the item a different name.');
  // Renaming one item to another's name, in any case, is refused too.
  const rename = await hq.patch('/api/notes/items/' + onTime.id, { label: 'FOCUSED' });
  assert.equal(rename.status, 409);
  assert.equal(rename.body.message, '"Focused" is already on the checklist. Give the item a different name.');
  assert.deepEqual(labels(), before);
  assert.equal(w.t.fx.audit().length, 0, 'nothing refused is logged');

  // An item may change its own case or spacing.
  const own = await hq.patch('/api/notes/items/' + onTime.id, { label: 'ON  TIME' });
  assert.equal(own.status, 200);
  assert.equal(own.body.item.label, 'ON TIME');

  // A retired item keeps its name: adding it again points to Restore, and Restore works.
  assert.equal((await hq.patch('/api/notes/items/' + productive.id, { active: false })).status, 200);
  const again = await hq.post('/api/notes/items', { label: 'productive use of time' });
  assert.equal(again.status, 409);
  assert.equal(again.body.message, '"Productive use of time" is a retired item. Restore it instead of adding it again.');
  assert.equal((await hq.patch('/api/notes/items/' + focused.id, { label: 'Productive use of TIME' })).status, 409);
  assert.equal((await hq.patch('/api/notes/items/' + productive.id, { active: true })).status, 200);

  // A checklist that already holds a duplicate (from before this rule) can't restore it beside its twin.
  const twin = Number(w.t.db.prepare("INSERT INTO note_items (label, position, active) VALUES ('focused', 9, 0)").run().lastInsertRowid);
  const restore = await hq.patch('/api/notes/items/' + twin, { active: true });
  assert.equal(restore.status, 409);
  assert.equal(restore.body.message, '"Focused" is already on the checklist. Give the item a different name.');
  assert.equal(w.t.db.prepare('SELECT active FROM note_items WHERE id = ?').get(twin).active, 0);
  // Retiring it, or anything else, is never blocked by a name.
  assert.equal((await hq.patch('/api/notes/items/' + focused.id, { active: false })).status, 200);
  assert.equal((await hq.patch('/api/notes/items/' + twin, { active: true })).status, 200, 'with its twin retired, it can come back');

  // Staff see each item once.
  const day = await w.t.as(w.staffA).get('/api/notes/day');
  const names = day.body.items.map(i => i.label.toLowerCase());
  assert.equal(new Set(names).size, names.length);
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

test(['DN-2', 'DN-4'], 'an item HQ retires while a note form is open drops off the note instead of blocking every save', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const [onTime, focused, respectful, productive] = w.items;
  // The form was loaded with all four items; HQ then retires Focused.
  assert.equal((await w.t.as(w.hq).patch('/api/notes/items/' + focused.id, { active: false })).status, 200);

  // Save for later with the stale keys, the retired one rated or blank.
  const later = await w.save(w.staffA, leo, TODAY, { ratings: { [onTime.id]: 3, [focused.id]: 2, [respectful.id]: null, [productive.id]: 2 }, comment: 'Busy day.', post: false });
  assert.equal(later.status, 200);
  assert.equal(later.body.student.status, 'draft');
  assert.deepEqual(later.body.student.ratings.map(x => [x.label, x.rating]),
    [['On time', 3], ['Respectful of others / not distracting', null], ['Productive use of time', 2]]);
  const blankRetired = await w.save(w.staffA, leo, TODAY, { ratings: { [onTime.id]: 3, [focused.id]: null, [respectful.id]: 2, [productive.id]: 2 }, comment: 'Busy day.', post: true });
  assert.equal(blankRetired.status, 200, 'a blank on a retired item does not block posting');
  assert.equal(blankRetired.body.student.status, 'posted');
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.label), ['On time', 'Respectful of others / not distracting', 'Productive use of time']);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1);

  // An id that was never on the checklist is still refused.
  const unknown = await w.save(w.staffA, leo, TODAY, { ratings: { [onTime.id]: 3, [respectful.id]: 2, [productive.id]: 2, 999: 2 } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown_item');
});

test(['DN-5', 'DN-4'], '"Save for later" or "Post note" on a note a colleague has already posted is refused and leaves the posted note alone', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const sam = w.t.fx.staff(w.A, { name: 'Sam Rivera' });
  w.t.clock.set(at(LA, TODAY, '16:10'));
  assert.equal((await w.save(sam, leo, TODAY, { ratings: w.all(3), comment: 'Great day.', post: true })).status, 200);

  // Chris's screen still shows the note as not posted.
  w.t.clock.set(at(LA, TODAY, '16:12'));
  const stale = await w.save(w.staffA, leo, TODAY, { ratings: w.all(1), comment: 'my draft', post: false });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'already_posted');
  assert.equal(stale.body.message, "Sam Rivera already posted Leo's note, so it can't be saved for later. Your changes weren't saved.");
  const [row] = w.notes();
  assert.deepEqual([row.status, row.comment, row.edited_at, row.posted_by], ['posted', 'Great day.', null, sam.id]);
  assert.deepEqual(w.ratingsOf(row.id).map(x => x.rating), [3, 3, 3, 3]);
  assert.equal(w.t.fx.audit('note.edit').length, 0);
  const feed = await w.t.as(w.fa.parent).get('/api/notes/feed');
  assert.deepEqual([feed.body.notes[0].comment, feed.body.notes[0].edited_at], ['Great day.', null]);

  // "Post note" from the same stale screen is refused too: it would overwrite Sam's note, and parents are not told again.
  const stalePost = await w.save(w.staffA, leo, TODAY, { ratings: w.all(1), comment: 'my note', post: true });
  assert.equal(stalePost.status, 409);
  assert.equal(stalePost.body.error, 'already_posted');
  assert.equal(stalePost.body.message, "Sam Rivera already posted Leo's note, so yours wasn't posted. Your changes weren't saved.");
  assert.deepEqual([w.notes()[0].comment, w.notes()[0].edited_at], ['Great day.', null]);
  assert.deepEqual(w.ratingsOf(row.id).map(x => x.rating), [3, 3, 3, 3]);
  assert.equal(w.t.fx.audit('note.edit').length, 0);

  // A deliberate edit (no `post`, as "Save changes" sends) still updates it in place, without a second notification.
  const edit = await w.save(w.staffA, leo, TODAY, { ratings: Object.assign(w.all(3), { [w.items[1].id]: 2 }), comment: 'Great day.' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.student.note.edited_by_name, 'Chris Ortiz');
  assert.equal(w.t.fx.audit('note.edit').length, 1);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1);
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

test(['DN-5'], "the parent home knows whether today's session is still to come, so a student isn't called absent before it ends", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, anh = w.fb.student;
  w.t.fx.enroll(leo, w.sessA); // the whole MWF 1-4 PM schedule, so today (Wednesday)
  w.t.fx.enroll(anh, w.sessA);
  w.t.fx.enroll(sofia, w.t.fx.session(w.A, { name: 'Monday Study', weekdays: '1' })); // Mondays only
  const home = async parent => (await w.t.as(parent).get('/api/notes/today')).body.students
    .map(s => [s.name, s.visited, s.in_building, s.session_today, s.session_later]);

  // 10:00, before the session: Leo's is still to come; Sofia has none today.
  assert.deepEqual(await home(w.fa.parent), [['Leo Garcia', false, false, true, true], ['Sofia Garcia', false, false, false, false]]);

  // Leo scans in at 1:05 PM. At 3:59 PM Anh hasn't come, but the session hasn't ended either.
  w.t.clock.set(at(LA, TODAY, '13:05'));
  const v = w.visit(leo, w.A, TODAY, { check_in_at: at(LA, TODAY, '13:05'), check_out_at: null, checkout_method: null });
  assert.deepEqual((await home(w.fa.parent))[0], ['Leo Garcia', true, true, true, true]);
  w.t.clock.set(at(LA, TODAY, '15:59'));
  assert.deepEqual(await home(w.fb.parent), [['Anh Nguyen', false, false, true, true]]);

  // 4:30 PM: the session is over. Leo is still in until he scans out; Anh never came.
  w.t.clock.set(at(LA, TODAY, '16:30'));
  assert.deepEqual((await home(w.fa.parent))[0], ['Leo Garcia', true, true, true, false]);
  w.t.db.prepare("UPDATE visits SET check_out_at = ?, checkout_method = 'scan' WHERE id = ?").run(at(LA, TODAY, '16:20'), v.id);
  assert.deepEqual((await home(w.fa.parent))[0], ['Leo Garcia', true, false, true, false]);
  assert.deepEqual(await home(w.fb.parent), [['Anh Nguyen', false, false, true, false]]);

  // No session runs today on a closure day, a date the director skipped, or for a paused schedule,
  // a cancelled one or a term that has ended.
  w.t.clock.set(at(LA, TODAY, '10:00'));
  const anhDay = async () => (await home(w.fb.parent))[0].slice(3);
  assert.deepEqual(await anhDay(), [true, true]);
  for (const [why, set, undo] of [
    ['closed today', `INSERT INTO closures (location_id, date, reason) VALUES (${w.A.id}, '${TODAY}', 'Staff training')`, 'DELETE FROM closures'],
    ['date skipped', `INSERT INTO session_dates (session_id, date, kind, created_at) VALUES (${w.sessA.id}, '${TODAY}', 'skip', 0)`, 'DELETE FROM session_dates'],
    ['schedule paused', "UPDATE enrollments SET status = 'paused'", "UPDATE enrollments SET status = 'active'"],
    ['session cancelled', "UPDATE sessions SET status = 'cancelled'", "UPDATE sessions SET status = 'active'"],
    ['term ended', `UPDATE terms SET end_date = '${YESTERDAY}'`, "UPDATE terms SET end_date = '2026-12-18'"],
  ]) {
    w.t.db.exec(set);
    assert.deepEqual(await anhDay(), [false, false], why);
    w.t.db.exec(undo);
  }
  assert.deepEqual(await anhDay(), [true, true]);
});

test(['DN-5'], "the parent home follows each schedule's meeting dates: an added date is a session today, a moved-away date isn't, and a v1 per-day row counts only on its weekday", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, anh = w.fb.student;
  const monday = w.t.fx.session(w.A, { name: 'Monday Study', weekdays: '1', start: '09:00', end: '12:00' });
  w.t.fx.enroll(leo, w.sessA); // MWF 1-4 PM
  w.t.fx.enroll(sofia, monday);
  const day = async parent => (await w.t.as(parent).get('/api/notes/today')).body.students.map(s => [s.name, s.session_today, s.session_later]);
  assert.deepEqual(await day(w.fa.parent), [['Leo Garcia', true, true], ['Sofia Garcia', false, false]]);

  // The director moves Leo's Wednesday to Thursday and adds this Wednesday to Monday Study (9-12).
  w.t.fx.sessionDate(w.sessA, TODAY, 'skip');
  w.t.fx.sessionDate(w.sessA, '2026-10-15', 'add', { moved_from: TODAY });
  w.t.fx.sessionDate(monday, TODAY, 'add', { reason: 'Extra study morning' });
  assert.deepEqual(await day(w.fa.parent), [['Leo Garcia', false, false], ['Sofia Garcia', true, true]]);
  w.t.clock.set(at(LA, TODAY, '12:30'));
  assert.deepEqual(await day(w.fa.parent), [['Leo Garcia', false, false], ['Sofia Garcia', true, false]], 'the added date ends at its own time');
  w.t.clock.set(at(LA, '2026-10-15', '10:00'));
  assert.deepEqual(await day(w.fa.parent), [['Leo Garcia', true, true], ['Sofia Garcia', false, false]], 'the moved date meets Thursday');

  // A v1 row (one weekday, history from before v1.1) counts only on its own weekday.
  w.t.clock.set(at(LA, TODAY, '10:00'));
  const anhDay = async () => (await day(w.fb.parent))[0].slice(1);
  const v1 = w.t.fx.enroll(anh, w.t.fx.session(w.A, { name: 'Evening MWF', start: '16:00', end: '19:00' }), 1);
  assert.deepEqual(await anhDay(), [false, false], 'a Monday row is not a Wednesday session');
  w.t.db.prepare('UPDATE enrollments SET weekday = 3 WHERE id = ?').run(v1.id);
  assert.deepEqual(await anhDay(), [true, true]);
});

test(['DN-5'], "whether today's session has ended is worked out in the student's location zone", async () => {
  const w = await world();
  const TOR = 'America/Toronto';
  const T = w.t.fx.location({ name: 'Toronto', timezone: TOR });
  const ft = w.t.fx.family(T);
  w.t.fx.enroll(ft.student, w.t.fx.session(T, { name: 'Toronto Study' })); // MWF 1-4 PM Toronto time
  const day = async () => (await w.t.as(ft.parent).get('/api/notes/today')).body.students.map(s => [s.date, s.session_today, s.session_later]);
  w.t.clock.set(at(TOR, TODAY, '15:30')); // 12:30 PM in Los Angeles
  assert.deepEqual(await day(), [[TODAY, true, true]]);
  w.t.clock.set(at(TOR, TODAY, '16:30')); // 1:30 PM in Los Angeles: over in Toronto
  assert.deepEqual(await day(), [[TODAY, true, false]]);
});

test(['DN-5', 'NF-1'], "a note-is-ready notification leads a parent to that note's student and day, and nobody else", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A, YESTERDAY); w.visit(sofia, w.A);
  assert.equal((await w.save(w.staffA, leo, YESTERDAY, { ratings: w.all(3), post: true })).status, 200); // posted a day late
  assert.equal((await w.save(w.staffA, sofia, TODAY, { ratings: w.all(2) })).status, 200); // a draft
  const [n] = w.t.fx.notifications(w.fa.parent, 'note');
  const r = await w.t.as(w.fa.parent).get('/api/notes/note/' + n.ref_id);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.note.id, r.body.note.student_id, r.body.note.student_name, r.body.note.local_date], [n.ref_id, leo.id, 'Leo Garcia', YESTERDAY]);
  assert.deepEqual(r.body.note.ratings.map(x => x.word), ['Great', 'Great', 'Great', 'Great']);

  const draft = w.notes().find(x => x.student_id === sofia.id);
  assert.equal((await w.t.as(w.fa.parent).get('/api/notes/note/' + draft.id)).status, 404, 'a draft is not there for parents');
  assert.equal((await w.t.as(w.fa.parent).get('/api/notes/note/999')).status, 404);
  const pending = w.t.fx.user('parent', { location: w.A });
  w.t.fx.link(pending, leo, 'pending');
  for (const u of [w.fb.parent, pending, leo, w.staffA, w.hq]) {
    const other = await w.t.as(u).get('/api/notes/note/' + n.ref_id);
    assert.equal(other.status, 403, u.role + ' ' + u.id);
    assert.equal(other.body.note, undefined);
  }
  assert.equal((await w.t.anon.get('/api/notes/note/' + n.ref_id)).status, 401);
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

// ---------------------------------------------------------------- DG-1, DG-2: weekly top 3 goals (D-57)

const SUBJECTS = [['math', 'Math'], ['english', 'English'], ['science', 'Science'], ['history', 'History'], ['language', 'Language'],
  ['art', 'Art'], ['test_prep', 'Test prep'], ['other', 'Other']];
const TIP = "Say what you'll finish: the chapter, the assignment or the problems.";
const SAME = 'Pick a different subject for each goal. Doing more than one thing in a subject? Put it all in that goal.';
const WEEK = { week_start: '2026-10-12', week_end: '2026-10-18' }; // Wed Oct 14 is in Mon Oct 12 - Sun Oct 18
const THU = '2026-10-15', FRI = '2026-10-16';
const MATH = { subject: 'math', text: 'Finish the Chapter 5 practice problems and check my answers with the key.' };
const ENG = { subject: 'english', text: 'Read chapters 6 to 8 of my novel and write a paragraph on each.' };
const SCI = { subject: 'science', text: "Finish the lab report for this week's experiment, with the data table and graph." };
const HIST = { subject: 'history', text: 'Read Unit 3 and answer all of the review questions at the end.' };
const ART = { subject: 'art', text: 'Sketch three thumbnail ideas for my next portfolio piece.' };
// Every goal ever written for a student, oldest first, and every daily answer.
const goalRows = (w, s) => w.t.db.prepare(`SELECT g.id, w.week_start, g.position, g.subject, g.text, g.status, g.created_on, g.done_on, g.replaced_on, g.replaced_by
  FROM week_goals g JOIN goal_weeks w ON w.id = g.week_id WHERE w.student_id = ? ORDER BY g.id`).all(s.id).map(r => Object.assign({}, r));
const checkRows = (w, s) => w.t.db.prepare(`SELECT c.goal_id, c.date, c.answer, c.answered_at FROM goal_checks c JOIN week_goals g ON g.id = c.goal_id
  JOIN goal_weeks w ON w.id = g.week_id WHERE w.student_id = ? ORDER BY c.date, c.goal_id`).all(s.id).map(r => [r.goal_id, r.date, r.answer, r.answered_at]);
// A check-in on `date` at 09:31 local, the clock just after it, and the week's 3 goals set.
async function setWeek(w, s, goals = [MATH, ENG, SCI], date = TODAY, loc = w.A) {
  w.visit(s, loc, date);
  w.t.clock.set(at(loc.timezone, date, '09:40'));
  const r = await w.t.as(s).put('/api/notes/goals/week', { goals });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
// The next visit day: a check-in, the clock just after it, and the student's week.
async function nextDay(w, s, date, loc = w.A) {
  w.visit(s, loc, date);
  w.t.clock.set(at(loc.timezone, date, '09:40'));
  return (await w.t.as(s).get('/api/notes/goals/week')).body;
}
const answer = (w, s, ...answers) => w.t.as(s).post('/api/notes/goals/week/check', { answers });

test(['DG-1'], 'the goal subjects are fixed: eight high-school subjects, each with one or two examples that pass the goal check, and the tip', async () => {
  const w = await world();
  for (const u of [w.fa.students[0], w.fa.parent, w.staffA, w.hq]) {
    const r = await w.t.as(u).get('/api/notes/goals/subjects');
    assert.equal(r.status, 200, u.role);
    assert.deepEqual(r.body.subjects.map(s => [s.id, s.label]), SUBJECTS);
    assert.ok(r.body.subjects.every(s => s.examples.length >= 1 && s.examples.length <= 2));
    assert.deepEqual([r.body.goals_per_week, r.body.text_max, r.body.max_sentences, r.body.tip], [3, 500, 3, TIP]);
  }
  const { body } = await w.t.as(w.fa.students[0]).get('/api/notes/goals/subjects');
  assert.deepEqual(body.subjects[0].examples, ['Finish the Chapter 5 practice problems and check my answers with the key.',
    'Redo the quiz problems I missed and write down what I got wrong.']);
  assert.deepEqual(body.subjects[6].examples, ['Do one full timed SAT math section and review every question I missed.']);
  // Every example is itself a goal the check accepts: an example a student taps is never refused.
  for (const s of body.subjects) for (const x of s.examples) {
    assert.deepEqual((await w.t.as(w.fa.students[0]).post('/api/notes/goals/check-text', { subject: s.id, text: x })).body, { ok: true, message: '' }, x);
  }
  assert.equal((await w.t.anon.get('/api/notes/goals/subjects')).status, 401);
});

test(['DG-1'], 'goal text is judged by one check: at least 6 words, up to 3 sentences and 500 characters, and the tip when it is too short', async () => {
  const w = await world();
  const check = async text => (await w.t.as(w.fa.students[0]).post('/api/notes/goals/check-text', { subject: 'math', text })).body;
  const no = message => ({ ok: false, message });
  for (const text of ['', '   ', 'Do math', 'Finish my math homework today', undefined, 42]) assert.deepEqual(await check(text), no(TIP), String(text));
  assert.deepEqual(await check('Finish all my math homework today'), { ok: true, message: '' }, 'six words');
  assert.deepEqual(await check("  Finish my essay draft. Study for Friday's vocab test.  "), { ok: true, message: '' }, 'two sentences');
  assert.deepEqual(await check('Read Chapter 3. Take notes on it. Do the review questions.'), { ok: true, message: '' }, 'three sentences');
  assert.deepEqual(await check('Read Chapter 3. Take notes on it. Do the review. Then quiz myself!'), no('Keep it to 3 sentences or fewer.'));
  assert.deepEqual(await check('Finish problems 3.5, 3.6 and 3.9 in the workbook and check them.'), { ok: true, message: '' }, 'a decimal ends no sentence');
  const long = 'Finish all of the practice problems ' + 'x'.repeat(500 - 'Finish all of the practice problems '.length);
  assert.deepEqual(await check(long), { ok: true, message: '' }, '500 characters');
  assert.deepEqual(await check(long + 'x'), no('Keep it to 500 characters or fewer.'));
  for (const u of [w.fa.parent, w.staffA, w.hq]) assert.equal((await w.t.as(u).post('/api/notes/goals/check-text', { text: 'x' })).status, 403, u.role);
});

test(['DG-1', 'DG-2'], 'a student sets exactly 3 goals for the week, in 3 different subjects, only after checking in that day at their home location; there is no skip', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  const me = w.t.as(leo);
  w.visit(leo, w.A, YESTERDAY);
  w.visit(leo, w.B); // a visit somewhere else isn't a check-in at his home location
  const empty = Object.assign({ today: TODAY }, WEEK, { checked_in: false, state: 'set', goals: [], done: [] });
  assert.deepEqual((await me.get('/api/notes/goals/week')).body, empty);
  const early = await me.put('/api/notes/goals/week', { goals: [MATH, ENG, SCI] });
  assert.deepEqual([early.status, early.body.error, early.body.message], [400, 'no_visit_today', 'Check in first, then set your goals.']);
  assert.equal((await me.post('/api/notes/goals/today/skip')).status, 404, 'there is no skip');

  w.visit(leo, w.A);
  assert.deepEqual((await me.get('/api/notes/goals/week')).body, Object.assign({}, empty, { checked_in: true }));
  const unset = await me.post('/api/notes/goals/week/check', { answers: [{ goalId: 1, answer: 'yes' }] });
  assert.deepEqual([unset.status, unset.body.error, unset.body.message], [409, 'not_set', 'Set your 3 goals for this week first.']);
  // Refusals name the goal and change nothing.
  for (const [goals, error, message] of [
    [[MATH, ENG], 'three_goals', 'Set 3 goals for this week.'],
    [[MATH, ENG, SCI, HIST], 'three_goals', 'Set 3 goals for this week.'],
    [undefined, 'three_goals', 'Set 3 goals for this week.'],
    [[MATH, { subject: 'music', text: ENG.text }, SCI], 'bad_subject', 'Goal 2: Pick a subject.'],
    [[{ text: MATH.text }, ENG, SCI], 'bad_subject', 'Goal 1: Pick a subject.'],
    [[MATH, ENG, { subject: 'science', text: 'Do science' }], 'goal_text', 'Goal 3: ' + TIP],
    [[MATH, ENG, { subject: 'science', text: 'One. Two three. Four five. Six seven eight.' }], 'goal_text', 'Goal 3: Keep it to 3 sentences or fewer.'],
    [[MATH, ENG, { subject: 'math', text: SCI.text }], 'same_subject', 'Goal 3: ' + SAME],
    [[{ subject: 'other', text: MATH.text }, ENG, { subject: 'other', text: SCI.text }], 'same_subject', 'Goal 3: ' + SAME],
  ]) {
    const r = await me.put('/api/notes/goals/week', { goals });
    assert.deepEqual([r.status, r.body.error, r.body.message], [400, error, message], JSON.stringify(goals));
  }
  assert.deepEqual(goalRows(w, leo), []);
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM goal_weeks').get().n, 0);

  // Other is a subject and can be used once. Text is trimmed.
  const set = await me.put('/api/notes/goals/week', { goals: [MATH, { subject: 'other', text: '  ' + ENG.text + '  ' }, SCI] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body, Object.assign({ today: TODAY }, WEEK, { checked_in: true, state: 'done', goals: [
    ['math', 'Math', MATH.text], ['other', 'Other', ENG.text], ['science', 'Science', SCI.text]].map(([subject, subject_label, text], i) => ({
    id: set.body.goals[i].id, week_id: set.body.goals[0].week_id, position: i + 1, subject, subject_label, text, status: 'open',
    created_on: TODAY, done_on: null, replaced_on: null, replaced_by: null, answer: null, asks: false })), done: [] }), 'goals set today are not asked about today');
  assert.deepEqual((await me.get('/api/notes/goals/week')).body, set.body);
  assert.deepEqual(w.t.db.prepare('SELECT student_id, location_id, week_start FROM goal_weeks').all().map(r => [r.student_id, r.location_id, r.week_start]),
    [[leo.id, w.A.id, '2026-10-12']]);

  // Once set, the week isn't set again: a goal changes through Change.
  const again = await me.put('/api/notes/goals/week', { goals: [HIST, ENG, SCI] });
  assert.deepEqual([again.status, again.body.error, again.body.message], [409, 'already_set', "You already set this week's goals. Tap Change on a goal to swap it."]);
  assert.deepEqual(goalRows(w, leo).map(g => g.text), [MATH.text, ENG.text, SCI.text]);
});

test(['DG-1', 'DG-2'], 'each later check-in that week asks about each open goal on its own: Yes, Done or Change, one answer per goal per day, and the week keeps 3 open goals in 3 subjects', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  const set = await setWeek(w, leo);
  const [m, e, s] = set.goals.map(g => g.id);

  // Thursday, before checking in: asked, but nothing can be answered yet.
  w.t.clock.set(at(LA, THU, '08:00'));
  let wk = (await w.t.as(leo).get('/api/notes/goals/week')).body;
  assert.deepEqual([wk.checked_in, wk.state, wk.goals.map(g => g.asks)], [false, 'update', [true, true, true]]);
  assert.equal((await answer(w, leo, { goalId: m, answer: 'yes' })).body.error, 'no_visit_today');
  wk = await nextDay(w, leo, THU);
  assert.deepEqual([wk.checked_in, wk.state], [true, 'update']);

  // Refusals change nothing.
  for (const [answers, error, message] of [
    [[], 'no_answers', 'Answer Yes, Done or Change for a goal.'],
    [[{ goalId: 999, answer: 'yes' }], 'unknown_goal', "That goal isn't one of this week's open goals. Reload and try again."],
    [[{ goalId: m, answer: 'yes' }, { goalId: m, answer: 'yes' }], 'twice', 'Answer each goal once.'],
    [[{ goalId: m, answer: 'maybe' }], 'bad_answer', 'Answer Yes, Done or Change.'],
    [[{ goalId: e, answer: 'done' }], 'bad_subject', 'Pick a subject.'],
    [[{ goalId: e, answer: 'done', subject: 'history', text: 'Read more history' }], 'goal_text', TIP],
    [[{ goalId: e, answer: 'change', subject: 'science', text: HIST.text }], 'same_subject', SAME],
    [[{ goalId: m, answer: 'yes' }, { goalId: e, answer: 'change', subject: 'math', text: HIST.text }], 'same_subject', SAME],
  ]) {
    const r = await answer(w, leo, ...answers);
    assert.deepEqual([r.status, r.body.error, r.body.message], [400, error, message], JSON.stringify(answers));
  }
  assert.deepEqual(checkRows(w, leo), []);
  assert.equal(goalRows(w, leo).length, 3);

  // Yes on Math: one goal answered, two still asked.
  wk = (await answer(w, leo, { goalId: m, answer: 'yes' })).body;
  assert.deepEqual([wk.state, wk.goals.map(g => [g.subject, g.answer, g.asks])], ['update', [['math', 'yes', false], ['english', null, true], ['science', null, true]]]);
  // Done on English, with the next goal in its place (position 2).
  w.t.clock.set(at(LA, THU, '09:45'));
  wk = (await answer(w, leo, { goalId: e, answer: 'done', subject: 'history', text: '  ' + HIST.text })).body;
  assert.deepEqual(wk.goals.map(g => [g.position, g.subject, g.text, g.created_on, g.asks]), [
    [1, 'math', MATH.text, TODAY, false], [2, 'history', HIST.text, THU, false], [3, 'science', SCI.text, TODAY, true]]);
  assert.equal(wk.state, 'update');
  // Answering Math again that day replaces the answer: now a Change, to another Math goal (its own subject is fine).
  const MATH2 = 'Redo the quiz problems I missed and write down what I got wrong.';
  w.t.clock.set(at(LA, THU, '09:50'));
  wk = (await answer(w, leo, { goalId: m, answer: 'change', subject: 'math', text: MATH2 })).body;
  assert.equal(wk.state, 'update');
  // Science, the last one: done for the day.
  wk = (await answer(w, leo, { goalId: s, answer: 'yes' })).body;
  assert.equal(wk.state, 'done');
  assert.deepEqual(wk.goals.map(g => [g.subject, g.text]), [['math', MATH2], ['history', HIST.text], ['science', SCI.text]]);
  // A closed goal can't be answered again.
  assert.equal((await answer(w, leo, { goalId: e, answer: 'yes' })).body.error, 'unknown_goal');

  // Checking out and back in that day doesn't ask again.
  w.visit(leo, w.A, THU, { check_in_at: at(LA, THU, '13:00'), check_out_at: null, checkout_method: null });
  w.t.clock.set(at(LA, THU, '13:05'));
  assert.equal((await w.t.as(leo).get('/api/notes/goals/week')).body.state, 'done');

  // The full dated history: nothing deleted or overwritten.
  const rows = goalRows(w, leo);
  const [newHist, newMath] = rows.slice(3).map(g => g.id);
  assert.deepEqual(rows.map(g => [g.position, g.subject, g.status, g.created_on, g.done_on, g.replaced_on, g.replaced_by]), [
    [1, 'math', 'replaced', TODAY, null, THU, newMath],
    [2, 'english', 'done', TODAY, THU, null, newHist],
    [3, 'science', 'open', TODAY, null, null, null],
    [2, 'history', 'open', THU, null, null, null],
    [1, 'math', 'open', THU, null, null, null]]);
  assert.deepEqual(rows.map(g => g.text), [MATH.text, ENG.text, SCI.text, HIST.text, MATH2]);
  assert.deepEqual(checkRows(w, leo), [[m, THU, 'change', at(LA, THU, '09:50')], [e, THU, 'done', at(LA, THU, '09:45')], [s, THU, 'yes', at(LA, THU, '09:50')]]);

  // Friday: every open goal is asked again, including the ones added Thursday.
  wk = await nextDay(w, leo, FRI);
  assert.deepEqual([wk.state, wk.goals.map(g => g.asks)], ['update', [true, true, true]]);
  // The student's week lists the goals done so far (English, Thursday), not the replaced Math one.
  assert.deepEqual(wk.done.map(g => [g.id, g.subject, g.text, g.status, g.done_on, g.replaced_by]), [[e, 'english', ENG.text, 'done', THU, newHist]]);
});

test(['DG-2'], 'a Change has to change something: the same subject and text is refused by the goal check, a new subject with the same words is a change', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  const set = await setWeek(w, leo);
  const s = set.goals[2].id;
  await nextDay(w, leo, THU);
  const UNCHANGED = 'Change something first, or tap Cancel to keep it.';
  const same = await answer(w, leo, { goalId: s, answer: 'change', subject: 'science', text: '  ' + SCI.text + ' ' });
  assert.deepEqual([same.status, same.body.error, same.body.message], [400, 'goal_text', UNCHANGED]);
  assert.deepEqual([checkRows(w, leo), goalRows(w, leo).length], [[], 3]);
  const moved = await answer(w, leo, { goalId: s, answer: 'change', subject: 'art', text: SCI.text });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body.goals.map(g => g.subject), ['math', 'english', 'art']);
});

test(['DG-1'], 'the week is Monday to Sunday; the next week starts fresh and last week stays as it was', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  await setWeek(w, leo);
  const sun = await nextDay(w, leo, '2026-10-18');
  assert.deepEqual([sun.week_start, sun.state, sun.goals.length], ['2026-10-12', 'update', 3]);
  const mon = await nextDay(w, leo, '2026-10-19');
  assert.deepEqual([mon.week_start, mon.week_end, mon.state, mon.goals], ['2026-10-19', '2026-10-25', 'set', []]);
  assert.equal((await w.t.as(leo).put('/api/notes/goals/week', { goals: [HIST, ENG, ART] })).status, 200);
  assert.deepEqual(goalRows(w, leo).map(g => [g.week_start, g.subject, g.status]), [
    ['2026-10-12', 'math', 'open'], ['2026-10-12', 'english', 'open'], ['2026-10-12', 'science', 'open'],
    ['2026-10-19', 'history', 'open'], ['2026-10-19', 'english', 'open'], ['2026-10-19', 'art', 'open']]);
});

test(['DG-1', 'NF-4'], "a student's day and week are their home location's", async () => {
  const w = await world();
  const TOR = 'America/Toronto';
  const T = w.t.fx.location({ name: 'Toronto', timezone: TOR });
  const eli = w.t.fx.family(T).student;
  await setWeek(w, eli, [MATH, ENG, SCI], TODAY, T);
  // 10:30 PM Sunday in Los Angeles is 1:30 AM Monday in Toronto: a new week there.
  w.t.clock.set(at(LA, '2026-10-18', '22:30'));
  const wk = (await w.t.as(eli).get('/api/notes/goals/week')).body;
  assert.deepEqual([wk.today, wk.week_start, wk.state, wk.checked_in], ['2026-10-19', '2026-10-19', 'set', false]);
  // A visit on Toronto's Monday counts for Monday.
  w.visit(eli, T, '2026-10-19', { check_in_at: at(TOR, '2026-10-19', '01:00'), check_out_at: null, checkout_method: null });
  assert.equal((await w.t.as(eli).put('/api/notes/goals/week', { goals: [HIST, ENG, ART] })).status, 200);
  assert.deepEqual(w.t.db.prepare('SELECT week_start, location_id FROM goal_weeks WHERE student_id = ? ORDER BY id').all(eli.id).map(r => [r.week_start, r.location_id]),
    [['2026-10-12', T.id], ['2026-10-19', T.id]]);
});

test(['DG-2', 'DN-4'], "staff see each student's goals this week next to their name, with that day's answer, or none; a past day shows the goals as they stood", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, anh = w.fb.student;
  await setWeek(w, leo);
  w.visit(sofia, w.A); w.visit(anh, w.A);
  const [m, e, s] = (await w.t.as(leo).get('/api/notes/goals/week')).body.goals.map(g => g.id);
  await nextDay(w, leo, THU);
  await answer(w, leo, { goalId: m, answer: 'yes' });
  await answer(w, leo, { goalId: e, answer: 'done', subject: 'history', text: HIST.text });
  await answer(w, leo, { goalId: s, answer: 'change', subject: 'art', text: ART.text });
  const row = g => [g.subject_label, g.text, g.status, g.answer];

  for (const u of [w.staffA, w.dirA]) {
    const r = await w.t.as(u).get('/api/notes/day?date=' + THU);
    assert.deepEqual(r.body.goal_counts, { set: 1, none: 0 }, u.role);
    assert.deepEqual(r.body.students.find(x => x.id === leo.id).goals.map(row), [
      ['Math', MATH.text, 'open', 'yes'], ['English', ENG.text, 'done', 'done'], ['History', HIST.text, 'open', null],
      ['Science', SCI.text, 'replaced', 'change'], ['Art', ART.text, 'open', null]]);
  }
  // Wednesday: the week as it stood then, no answers that day; Sofia and Anh set none.
  const wed = await w.t.as(w.staffA).get('/api/notes/day?date=' + TODAY);
  assert.deepEqual(wed.body.goal_counts, { set: 1, none: 2 });
  const by = Object.fromEntries(wed.body.students.map(x => [x.name, x.goals.map(row)]));
  assert.deepEqual(by, { 'Leo Garcia': [['Math', MATH.text, 'open', null], ['English', ENG.text, 'open', null], ['Science', SCI.text, 'open', null]],
    'Sofia Garcia': [], 'Anh Nguyen': [] });
  // HQ too, for the location it picks; staff elsewhere see their own list only.
  assert.deepEqual((await w.t.as(w.hq).get(`/api/notes/day?location=${w.A.id}&date=${THU}`)).body.goal_counts, { set: 1, none: 0 });
  assert.equal((await w.t.as(w.staffB).get('/api/notes/day?location=' + w.A.id)).status, 403);
});

test(['DG-2', 'DN-2', 'DN-5'], "parents see the goals any time, read-only: this week's goals and every daily answer; a posted note shows the goals as of its day", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  await setWeek(w, leo);
  w.visit(sofia, w.A);
  const p = w.t.as(w.fa.parent);
  // Before any note: the goals route already has them.
  let h = (await p.get('/api/notes/goals/student/' + leo.id)).body;
  assert.deepEqual([h.student, h.today, h.week_start, h.week_end, h.timezone], [{ id: leo.id, name: 'Leo Garcia' }, TODAY, ...Object.values(WEEK), LA]);
  assert.deepEqual([h.goals.map(g => [g.subject, g.status]), h.checks], [[['math', 'open'], ['english', 'open'], ['science', 'open']], []]);
  assert.deepEqual((await p.get('/api/notes/goals/student/' + sofia.id)).body.goals, [], 'Sofia set none');
  for (const s of [leo, sofia]) assert.equal((await w.save(w.staffA, s, TODAY, { ratings: w.all(3), post: true })).status, 200);

  const [m, e] = h.goals.map(g => g.id);
  await nextDay(w, leo, THU);
  await answer(w, leo, { goalId: m, answer: 'yes' });
  await answer(w, leo, { goalId: e, answer: 'done', subject: 'history', text: HIST.text });
  assert.equal((await w.save(w.staffA, leo, THU, { ratings: w.all(2), post: true })).status, 200);

  h = (await p.get('/api/notes/goals/student/' + leo.id)).body;
  const hist = h.goals.find(g => g.subject === 'history');
  assert.deepEqual(h.goals.map(g => [g.subject, g.status, g.created_on, g.done_on, g.replaced_by]), [
    ['math', 'open', TODAY, null, null], ['english', 'done', TODAY, THU, hist.id], ['history', 'open', THU, null, null], ['science', 'open', TODAY, null, null]]);
  assert.deepEqual(h.checks.map(c => [c.goal_id, c.date, c.answer]), [[m, THU, 'yes'], [e, THU, 'done']]);

  // Each posted note shows the goals as they stood that day, with that day's answers.
  const feed = (await p.get('/api/notes/feed?student=' + leo.id)).body.notes;
  assert.deepEqual(feed.map(n => [n.local_date, n.goals.map(g => [g.subject, g.status, g.answer])]), [
    [THU, [['math', 'open', 'yes'], ['english', 'done', 'done'], ['history', 'open', null], ['science', 'open', null]]],
    [TODAY, [['math', 'open', null], ['english', 'open', null], ['science', 'open', null]]]]);
  const today = (await p.get('/api/notes/today')).body.students;
  assert.deepEqual(today.find(s => s.id === leo.id).note.goals.map(g => g.subject), ['math', 'english', 'history', 'science']);
  assert.deepEqual((await p.get('/api/notes/feed?student=' + sofia.id)).body.notes[0].goals, [], 'no goals, nothing shown');
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 3, 'goals send no notice of their own');
  // Friday's answers come first.
  await nextDay(w, leo, FRI);
  await answer(w, leo, { goalId: m, answer: 'yes' });
  h = (await p.get('/api/notes/goals/student/' + leo.id)).body;
  assert.deepEqual(h.checks.map(c => [c.goal_id, c.date]), [[m, FRI], [m, THU], [e, THU]]);
  // Read-only: a parent can't set or answer goals.
  assert.equal((await p.put('/api/notes/goals/week', { goals: [MATH, ENG, SCI] })).status, 403);
  assert.equal((await p.post('/api/notes/goals/week/check', { answers: [{ goalId: m, answer: 'yes' }] })).status, 403);
});

test(['NF-1', 'DG-2'], "a student reads and writes only their own week; parents see only linked students' goals, staff only their location's, HQ all", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, noah = w.fc.student;
  await setWeek(w, leo);
  const leoGoal = goalRows(w, leo)[0].id;
  // The student routes are students' only.
  for (const u of [w.fa.parent, w.staffA, w.dirA, w.hq]) {
    const c = w.t.as(u);
    const get = await c.get('/api/notes/goals/week');
    assert.deepEqual([get.status, get.body.goals], [403, undefined], u.role);
    assert.equal((await c.put('/api/notes/goals/week', { goals: [MATH, ENG, SCI] })).status, 403, u.role);
    assert.equal((await c.post('/api/notes/goals/week/check', { answers: [{ goalId: leoGoal, answer: 'yes' }] })).status, 403, u.role);
  }
  for (const [m, url] of [['get', '/api/notes/goals/week'], ['put', '/api/notes/goals/week'], ['post', '/api/notes/goals/week/check'],
    ['post', '/api/notes/goals/check-text'], ['get', '/api/notes/goals/student/' + leo.id]]) {
    assert.equal((await w.t.anon[m](url)).status, 401, m + ' ' + url);
  }
  // Sofia sees her own week, and can't answer Leo's goal.
  await nextDay(w, sofia, TODAY);
  assert.deepEqual((await w.t.as(sofia).get('/api/notes/goals/week')).body.goals, []);
  await setWeek(w, sofia, [HIST, ENG, ART]);
  await nextDay(w, sofia, THU);
  assert.equal((await answer(w, sofia, { goalId: leoGoal, answer: 'yes' })).body.error, 'unknown_goal');
  assert.deepEqual(checkRows(w, leo), []);

  // The read-only goals route.
  const read = async (u, s) => (await w.t.as(u).get('/api/notes/goals/student/' + s.id)).status;
  assert.equal(await read(w.fa.parent, leo), 200);
  assert.equal(await read(w.fb.parent, leo), 403, "another family's student");
  assert.equal(await read(w.fc.parent, noah), 200);
  assert.equal(await read(w.staffA, leo), 200);
  assert.equal(await read(w.dirA, leo), 200);
  assert.equal(await read(w.staffB, leo), 403, "another location's student");
  assert.equal(await read(w.staffA, noah), 403);
  assert.equal(await read(w.hq, leo), 200);
  assert.equal(await read(w.hq, noah), 200);
  assert.equal(await read(leo, leo), 403, 'students use their own route');
  assert.equal((await w.t.as(w.hq).get('/api/notes/goals/student/' + w.staffA.id)).status, 404, 'not a student');
  const unlinked = w.t.fx.user('student', { location: w.A });
  w.t.fx.link(w.fa.parent, unlinked, 'pending');
  assert.equal(await read(w.fa.parent, unlinked), 403, 'a pending link');
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

// ---------------------------------------------------------------- the notes screens in a browser tab

// Just enough DOM for public/js/app.js and the notes view. Elements live in one
// tree under <html>, so getElementById and querySelector find what the view drew,
// and a disabled button ignores clicks, as in a browser.
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  get id() { return this.getAttribute('id') || ''; }
  get cls() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  get classList() {
    return { toggle: (c, on) => { const s = new Set(this.cls); if (on) s.add(c); else s.delete(c); this.setAttribute('class', [...s].join(' ')); } };
  }
  get disabled() { return this.attrs.has('disabled'); }
  set disabled(v) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  get dataset() { return Object.fromEntries([...this.attrs].filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])); }
  get value() { return this.typed ?? this.getAttribute('value') ?? ''; }
  set value(v) { this.typed = String(v); }
  addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
  dispatch(type) { for (const fn of this.on[type] || []) fn({ type, target: this, currentTarget: this, preventDefault() {} }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus(opts) { this.doc.focused = this; this.doc.focusOpts = opts; }
  scrollIntoView(opts) { this.doc.scrolled = [this, opts]; }
  append(...kids) {
    for (const k of kids) {
      const n = k instanceof El ? k : new El(this.doc, null, String(k));
      n.remove();
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this.append(...kids); }
  replaceWith(n) { const p = this.parentNode; n.remove(); p.childNodes[p.childNodes.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; }
  all() { return this.childNodes.flatMap(c => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
  // Descendant selectors made of #id, .class and tag parts: '#dn-5 .note-scale .btn', 'button'.
  querySelector(sel) {
    const parts = sel.trim().split(/\s+/);
    const hits = (n, part) => !!n.tag && part.split(/(?=[#.])/).every(p => (p[0] === '#' ? n.id === p.slice(1) : p[0] === '.' ? n.cls.includes(p.slice(1)) : n.tag === p));
    const walk = (root, i) => {
      for (const n of root.all()) {
        if (!hits(n, parts[i])) continue;
        const got = i === parts.length - 1 ? n : walk(n, i + 1);
        if (got) return got;
      }
      return null;
    };
    return walk(this, 0);
  }
}

// One browser tab running the real shell and notes view (read from ROOT, so the
// mutation runner's copy is the one exercised) against the test server. `extras` go on
// window (a localStorage shared by two tabs is one browser, so a new tab is a reload).
function notesTab(t, extras = {}) {
  let cookie = '';
  const pending = new Set(), requests = [], replaced = [];
  const doc = { addEventListener() {} };
  const el = (tag, id) => { const n = new El(doc, tag); if (id) n.setAttribute('id', id); return n; };
  doc.documentElement = el('html');
  doc.head = el('head');
  doc.body = el('body');
  const main = el('main', 'main');
  doc.body.append(el('div', 'toasts'), main);
  doc.documentElement.append(doc.head, doc.body);
  Object.assign(doc, {
    createElement: tag => el(tag), createTextNode: s => new El(doc, null, String(s)),
    getElementById: id => doc.documentElement.find(n => n.id === id) || null,
    querySelector: sel => doc.documentElement.querySelector(sel),
  });
  const fetchAs = (url, opts = {}) => {
    const p = fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
      .then(async r => {
        const body = await r.arrayBuffer();
        requests.push({ url, method: opts.method || 'GET', status: r.status });
        return new Response(body, { status: r.status, headers: r.headers });
      });
    pending.add(p);
    const done = () => pending.delete(p);
    p.then(done, done);
    return p;
  };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, URLSearchParams, console, navigator: {}, location: { hash: '' },
    history: { replaceState(_s, _t, url) { replaced.push(url); } }, addEventListener() {}, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  Object.defineProperties(win, Object.getOwnPropertyDescriptors(extras));
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/notes.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  const App = win.App;
  // Waits until every request has answered and the view has drawn what came back.
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  const mount = async draw => { const box = el('div'); main.replaceChildren(box); await draw(box); await settle(); return box; };
  return {
    App, requests, replaced, settle, main, doc, css: () => doc.head.textContent,
    async signIn(user) {
      const token = crypto.randomBytes(16).toString('hex');
      t.ctx.sessions.set(token, user.id);
      cookie = 'sid=' + token;
      App.me = await App.api.get('/api/auth/me');
    },
    open: (id, ...params) => mount(box => App.views.find(v => v.id === id).render(box, params)),
    hash: () => win.location.hash,
    // Opens the route App.go last set, read as public/js/app.js reads the address.
    follow() {
      const [id, ...params] = win.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      return this.open(id, ...params);
    },
    card: id => mount(box => App.cards.find(c => c.id === id).render(box)),
    async click(button) { button.click(); await settle(); },
  };
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
// Text a browser would print for a false, 0 or null handed to append or replaceChildren.
const strays = n => n.all().filter(c => !c.tag && /^(false|true|0|null|undefined|NaN)$/.test(c.data.trim())).map(c => c.data);
const byId = (root, id) => root.find(n => n.id === id);
const postedLines = root => root.findAll(n => n.tag === 'p' && n.textContent.startsWith('Posted ')).map(n => n.textContent);

test(['DN-5'], "a parent's Home card says a student wasn't in only after the day's last session has ended", async () => {
  const w = await world();
  const [leo] = w.fa.students;
  w.t.fx.enroll(leo, w.sessA); // MWF 1-4 PM; Sofia has nothing today
  w.t.fx.enroll(w.fb.student, w.sessA);
  const tab = notesTab(w.t);
  const lines = async parent => {
    await tab.signIn(parent);
    const box = await tab.card('notes-today');
    return box.findAll(n => n.tag === 'li').map(li => [li.find(n => n.tag === 'strong').textContent, words(li.find(n => n.cls.includes('muted')))]);
  };

  // 10:00 AM, before the session.
  assert.deepEqual(await lines(w.fa.parent), [['Leo Garcia', "No note yet. Notes post after Leo's session."],
    ['Sofia Garcia', "Sofia has no session today, so there's no note."]]);
  // In the building, even after the session's end until he scans out.
  const v = w.visit(leo, w.A, TODAY, { check_in_at: at(LA, TODAY, '13:05'), check_out_at: null, checkout_method: null });
  w.t.clock.set(at(LA, TODAY, '16:10'));
  assert.deepEqual((await lines(w.fa.parent))[0], ['Leo Garcia', "No note yet. Notes post after Leo's session."]);
  // Gone home, note not posted yet.
  w.t.db.prepare("UPDATE visits SET check_out_at = ?, checkout_method = 'scan' WHERE id = ?").run(at(LA, TODAY, '16:00'), v.id);
  assert.deepEqual((await lines(w.fa.parent))[0], ['Leo Garcia', 'No note yet. Notes usually post by the end of the day.']);

  // Anh hasn't come: still possible a minute before the end, not after it.
  w.t.clock.set(at(LA, TODAY, '15:59'));
  assert.deepEqual(await lines(w.fb.parent), [['Anh Nguyen', "No note yet. Notes post after Anh's session."]]);
  w.t.clock.set(at(LA, TODAY, '16:01'));
  assert.deepEqual(await lines(w.fb.parent), [['Anh Nguyen', "Anh wasn't in today, so there's no note."]]);
});

test(['DN-5'], "a note posted after the visit's day shows the posting date, and its notification opens Notes at the visit's day", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A, YESTERDAY); w.visit(leo, w.A); w.visit(sofia, w.A, YESTERDAY);
  const post = async (s, date, day, hhmm) => {
    w.t.clock.set(at(LA, day, hhmm));
    assert.equal((await w.save(w.staffA, s, date, { ratings: w.all(3), post: true })).status, 200);
  };
  await post(sofia, YESTERDAY, YESTERDAY, '17:00'); // on the day
  await post(leo, YESTERDAY, TODAY, '09:05'); // the next morning
  await post(leo, TODAY, TODAY, '16:10');
  const [sofiaTue, leoTue, leoWed] = w.t.fx.notifications(w.fa.parent, 'note').map(n => n.ref_id);
  const tab = notesTab(w.t);

  // Staff: each card says when its note was posted, with the date when it was another day.
  await tab.signIn(w.staffA);
  assert.deepEqual(postedLines(await tab.open('daily-notes', YESTERDAY)),
    ['Posted Wed, Oct 14, 9:05 AM by Chris Ortiz', 'Posted 5:00 PM by Chris Ortiz']);
  assert.deepEqual(postedLines(await tab.open('daily-notes', TODAY)), ['Posted 4:10 PM by Chris Ortiz']);

  // Parent: the latest notes.
  await tab.signIn(w.fa.parent);
  const latest = await tab.open('notes');
  assert.deepEqual(latest.findAll(n => n.tag === 'h2').map(n => n.textContent), ['Wednesday, Oct 14', 'Tuesday, Oct 13', 'Tuesday, Oct 13']);
  assert.deepEqual(postedLines(latest), ['Posted by Chris Ortiz at 4:10 PM', 'Posted by Chris Ortiz on Wed, Oct 14 at 9:05 AM',
    'Posted by Chris Ortiz at 5:00 PM']);

  // The Inbox: each "note is ready" item opens Notes at that note.
  const inbox = await tab.open('inbox');
  assert.deepEqual(inbox.findAll(n => n.tag === 'a').map(a => [a.find(n => n.tag === 'strong').textContent, a.getAttribute('href')]), [
    ["Leo's daily note from Irvine is ready", '#/notes/note/' + leoWed],
    ["Leo's daily note from Irvine is ready", '#/notes/note/' + leoTue],
    ["Sofia's daily note from Irvine is ready", '#/notes/note/' + sofiaTue],
  ]);

  // Opening Leo's Tuesday note: his notes, from Tuesday back, and the address says so.
  const opened = await tab.open('notes', 'note', String(leoTue));
  assert.deepEqual(tab.requests.slice(-2).map(r => [r.url, r.status]), [
    ['/api/notes/note/' + leoTue, 200], [`/api/notes/feed?limit=20&student=${leo.id}&to=${YESTERDAY}`, 200]]);
  assert.equal(tab.replaced.at(-1), `#/notes/${leo.id}/${YESTERDAY}`);
  assert.equal(byId(opened, 'pn-student').find(o => o.getAttribute('selected') !== null).textContent, 'Leo Garcia');
  assert.equal(byId(opened, 'pn-date').value, YESTERDAY);
  assert.deepEqual(opened.findAll(n => n.tag === 'h2').map(n => n.textContent), ['Tuesday, Oct 13']);
  assert.deepEqual(postedLines(opened), ['Posted by Chris Ortiz on Wed, Oct 14 at 9:05 AM']);
});

test(['DN-4', 'DN-2', 'NF-7'], "on the day list, tapping the chosen rating again clears it; a note with a cleared item can't be posted or saved, and the button doesn't move", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  await tab.open('daily-notes');
  const card = () => byId(tab.main, 'dn-' + leo.id);
  const groups = () => card().findAll(n => n.getAttribute('role') === 'group');
  const tap = (label, word) => tab.click(groups().find(g => g.childNodes[0].textContent === label).find(b => b.tag === 'button' && b.textContent === word));
  const pressed = () => groups().map(g => { const b = g.find(x => x.tag === 'button' && x.getAttribute('aria-pressed') === 'true'); return b ? b.textContent : null; });
  const hint = () => card().find(n => n.cls.includes('note-hint')).textContent;
  const button = label => card().find(n => n.tag === 'button' && n.textContent === label);

  await tap('On time', 'Great');
  assert.deepEqual(pressed(), ['Great', null, null, null]);
  await tap('On time', 'Great');
  assert.deepEqual(pressed(), [null, null, null, null], 'tapping the chosen rating again clears it');
  assert.equal(hint(), 'Rate each item to post.');
  assert.equal(button('Post note').disabled, true);
  await tap('On time', 'Good');
  await tap('On time', 'Great');
  assert.deepEqual(pressed(), ['Great', null, null, null], 'tapping another rating switches to it');
  for (const label of PRD_ITEMS.slice(1)) await tap(label, 'Great');
  assert.equal(button('Post note').disabled, false);
  assert.equal(hint(), 'Ready to post. Parents get a notification.');

  // Cleared again, Post is blocked and names the item; saving keeps the blank.
  await tap('Focused', 'Great');
  assert.deepEqual(pressed(), ['Great', null, 'Great', 'Great']);
  assert.equal(button('Post note').disabled, true);
  assert.equal(hint(), 'Rate Focused to post.');
  await tab.click(button('Post note'));
  await tab.click(button('Save for later'));
  const [row] = w.notes();
  assert.equal(row.status, 'draft');
  assert.deepEqual(w.ratingsOf(row.id).map(x => x.rating), [3, null, 3, 3]);

  await tap('Focused', 'Good');
  await tab.click(button('Post note'));
  assert.equal(w.notes()[0].status, 'posted');

  // Editing the posted note: the hint keeps its space while empty, and a cleared item blocks Save changes.
  assert.match(tab.css(), /\.note-hint \{ min-height: 3em; \}/);
  await tab.click(button('Edit note'));
  assert.equal(hint(), '');
  await tap('On time', 'Great');
  assert.deepEqual(pressed(), [null, 'Good', 'Great', 'Great']);
  assert.equal(button('Save changes').disabled, true);
  assert.equal(hint(), 'Rate On time to save.');
  await tab.click(button('Save changes'));
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.rating), [3, 2, 3, 3], 'the posted note is untouched');
  assert.equal(w.t.fx.audit('note.edit').length, 0);
});

test(['DN-2', 'NF-7'], "the checklist's move up and move down buttons are 44px targets", async () => {
  const w = await world();
  const tab = notesTab(w.t);
  await tab.signIn(w.hq);
  const view = await tab.open('note-checklist');
  const moves = view.findAll(n => n.tag === 'button' && /^nc-(up|down)-/.test(n.id));
  assert.equal(moves.length, 8);
  for (const b of moves) assert.ok(b.cls.includes('note-move'), b.id);
  assert.match(tab.css(), /\.note-move \{ min-width: 44px; min-height: 44px; \}/);
});

// One student's card on the staff day list, with helpers to tap ratings, type and read it back.
function noteCard(tab, student) {
  const card = () => byId(tab.main, 'dn-' + student.id);
  const groups = () => card().findAll(n => n.getAttribute('role') === 'group');
  return {
    card,
    labels: () => groups().map(g => g.childNodes[0].textContent),
    tap: (label, word) => tab.click(groups().find(g => g.childNodes[0].textContent === label).find(b => b.tag === 'button' && b.textContent === word)),
    pressed: () => groups().map(g => { const b = g.find(x => x.tag === 'button' && x.getAttribute('aria-pressed') === 'true'); return b ? b.textContent : null; }),
    hint: () => card().find(n => n.cls.includes('note-hint')).textContent,
    badge: () => card().find(n => n.tag === 'span' && n.cls.includes('badge')).textContent,
    button: label => card().find(n => n.tag === 'button' && n.textContent === label),
    comment: () => byId(tab.main, 'dn-c-' + student.id),
    type(text) { const c = this.comment(); c.value = text; c.dispatch('input'); },
  };
}
const lastToast = tab => { const t = tab.main.parentNode.find(n => n.id === 'toasts').childNodes.at(-1); return t && [t.textContent, t.cls.includes('toast-error')]; };

test(['DN-5', 'DN-4'], "on a stale screen, \"Save for later\" on a note a colleague posted says so, keeps the posted note, and redraws the card as posted with the edits kept", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const sam = w.t.fx.staff(w.A, { name: 'Sam Rivera' });
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  await tab.open('daily-notes');
  const c = noteCard(tab, leo);
  assert.equal(c.badge(), 'Not started');

  // Sam posts from another device; Chris's screen hasn't caught up.
  assert.equal((await w.save(sam, leo, TODAY, { ratings: w.all(3), comment: 'Great day.', post: true })).status, 200);
  await c.tap('On time', 'Good');
  c.type('my draft');
  await tab.click(c.button('Save for later'));

  const [row] = w.notes();
  assert.deepEqual([row.status, row.comment, row.edited_at], ['posted', 'Great day.', null], "Sam's posted note is untouched");
  assert.deepEqual(w.ratingsOf(row.id).map(x => x.rating), [3, 3, 3, 3]);
  assert.deepEqual(lastToast(tab), ["Sam Rivera already posted Leo's note, so it can't be saved for later. Your changes weren't saved.", true]);
  // The card now shows the note as posted, with Chris's edits still on the form to save deliberately or drop.
  assert.equal(c.badge(), 'Posted');
  assert.equal(c.button('Save for later'), undefined);
  assert.ok(c.button('Save changes') && c.button('Cancel'));
  assert.deepEqual(c.pressed(), ['Good', null, null, null]);
  assert.equal(c.comment().value, 'my draft');
  await tab.click(c.button('Cancel'));
  assert.match(words(c.card()), /Great day\./);
  assert.match(words(c.card()), /Posted .* by Sam Rivera/);

  // Edit note, Save changes: a deliberate edit goes through, without a second notification.
  await tab.click(c.button('Edit note'));
  await c.tap('Focused', 'Good');
  await tab.click(c.button('Save changes'));
  assert.deepEqual(lastToast(tab), ["Saved changes to Leo's note.", false]);
  assert.deepEqual(w.ratingsOf(w.notes()[0].id).map(x => x.rating), [3, 2, 3, 3]);
  assert.equal(w.notes()[0].edited_by, w.staffA.id);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1);
});

test(['DN-5', 'DN-4'], 'on a stale screen, "Post note" on a note a colleague posted says so instead of claiming parents were notified, and keeps the posted note', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const sam = w.t.fx.staff(w.A, { name: 'Sam Rivera' });
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  await tab.open('daily-notes');
  const c = noteCard(tab, leo);

  assert.equal((await w.save(sam, leo, TODAY, { ratings: w.all(3), comment: 'Great day.', post: true })).status, 200);
  for (const label of PRD_ITEMS) await c.tap(label, 'Needs work');
  c.type('my note');
  await tab.click(c.button('Post note'));

  const [row] = w.notes();
  assert.deepEqual([row.status, row.comment, row.edited_at, row.posted_by], ['posted', 'Great day.', null, sam.id], "Sam's posted note is untouched");
  assert.deepEqual(w.ratingsOf(row.id).map(x => x.rating), [3, 3, 3, 3]);
  assert.deepEqual(lastToast(tab), ["Sam Rivera already posted Leo's note, so yours wasn't posted. Your changes weren't saved.", true]);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1);
  assert.equal(c.badge(), 'Posted');
  assert.ok(c.button('Save changes') && c.button('Cancel'));
  assert.deepEqual(c.pressed(), ['Needs work', 'Needs work', 'Needs work', 'Needs work']);
  assert.equal(c.comment().value, 'my note');

  // Saving those edits now is a deliberate edit of Sam's note.
  await tab.click(c.button('Save changes'));
  assert.deepEqual(lastToast(tab), ["Saved changes to Leo's note.", false]);
  assert.deepEqual([w.notes()[0].comment, w.notes()[0].edited_by], ['my note', w.staffA.id]);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 1);
});

test(['DN-2', 'DN-4'], 'when HQ retires a checklist item while a note form is open, saving and posting still work; when HQ adds one, the card redraws to show it', async () => {
  const w = await world();
  const leo = w.fa.students[0], anh = w.fb.student;
  w.visit(leo, w.A); w.visit(anh, w.A);
  const [, focused] = w.items;
  const hq = w.t.as(w.hq);
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  await tab.open('daily-notes');
  const L = noteCard(tab, leo), A = noteCard(tab, anh);

  // Leo: rated and commented, then HQ retires Focused.
  for (const label of PRD_ITEMS) await L.tap(label, 'Great');
  await L.tap('Respectful of others / not distracting', 'Great'); // cleared again: a draft
  L.type('Busy day.');
  assert.equal((await hq.patch('/api/notes/items/' + focused.id, { active: false })).status, 200);
  await tab.click(L.button('Save for later'));
  assert.deepEqual(lastToast(tab), ["Saved Leo's note for later. Parents can't see it yet.", false]);
  assert.equal(L.badge(), 'Saved, not posted');
  assert.deepEqual(L.labels(), ['On time', 'Respectful of others / not distracting', 'Productive use of time']);
  assert.deepEqual(L.pressed(), ['Great', null, 'Great']);
  assert.equal(L.comment().value, 'Busy day.');
  await L.tap('Respectful of others / not distracting', 'Good');
  await tab.click(L.button('Post note'));
  assert.equal(L.badge(), 'Posted');
  const leoNote = w.notes().find(n => n.student_id === leo.id);
  assert.deepEqual(w.ratingsOf(leoNote.id).map(x => [x.label, x.rating]),
    [['On time', 3], ['Respectful of others / not distracting', 2], ['Productive use of time', 3]]);
  assert.equal(leoNote.comment, 'Busy day.');

  // Anh: HQ adds an item the open form doesn't show yet. Post is refused, and the card redraws with it.
  assert.equal((await hq.post('/api/notes/items', { label: 'Tidy' })).status, 201);
  for (const label of A.labels()) await A.tap(label, 'Great');
  await tab.click(A.button('Post note'));
  assert.deepEqual(lastToast(tab), ['Rate Tidy to post this note.', true]);
  assert.deepEqual(A.labels(), ['On time', 'Respectful of others / not distracting', 'Productive use of time', 'Tidy']);
  assert.deepEqual(A.pressed(), ['Great', 'Great', 'Great', null], 'the ratings already chosen are kept');
  assert.equal(A.hint(), 'Rate Tidy to post.');
  assert.equal(A.button('Post note').disabled, true);
  await A.tap('Tidy', 'Good');
  await tab.click(A.button('Post note'));
  assert.equal(w.notes().find(n => n.student_id === anh.id).status, 'posted');
});

// L46: HQ's location switch used to carry the old location's "today" as a chosen date.
test(['DN-4'], "HQ switching location on Daily notes lands on that location's own today, and keeps a past day it was showing", async () => {
  const w = await world();
  const tor = w.t.fx.location({ name: 'Toronto', timezone: 'America/Toronto' });
  // 10:30 PM Sunday Oct 18 in Irvine and Arcadia is 1:30 AM Monday Oct 19 in Toronto.
  w.t.clock.set(Date.parse('2026-10-19T05:30:00Z'));
  const tab = notesTab(w.t);
  await tab.signIn(w.hq);
  const head = box => box.find(n => n.tag === 'p' && n.parentNode.find(x => x.tag === 'h1')).textContent;
  const button = (box, label) => box.find(n => n.tag === 'button' && n.textContent === label);
  const switchTo = async (box, loc) => { const s = byId(box, 'dn-loc'); s.value = String(loc.id); s.dispatch('change'); return tab.follow(); };

  const irvine = await tab.open('daily-notes', 'today', String(w.A.id));
  assert.equal(head(irvine), 'Today, Sunday, October 18 · Irvine');
  const toronto = await switchTo(irvine, tor);
  assert.equal(tab.hash(), `#/daily-notes/today/${tor.id}`);
  assert.equal(tab.requests.at(-1).url, `/api/notes/day?location=${tor.id}`, 'no date is sent, so the server uses Toronto\'s today');
  assert.equal(head(toronto), 'Today, Monday, October 19 · Toronto');
  assert.equal(byId(toronto, 'dn-date').value, '2026-10-19');
  assert.equal(button(toronto, 'Back to today'), undefined);
  // And back again: Irvine's today, not Toronto's.
  assert.equal(head(await switchTo(toronto, w.A)), 'Today, Sunday, October 18 · Irvine');

  // A past day HQ chose stays chosen at the next location.
  const past = await tab.open('daily-notes', '2026-10-15', String(tor.id));
  assert.equal(head(past), 'Thursday, October 15 · Toronto');
  const there = await switchTo(past, w.A);
  assert.equal(tab.hash(), `#/daily-notes/2026-10-15/${w.A.id}`);
  assert.equal(head(there), 'Thursday, October 15 · Irvine');
  assert.ok(button(there, 'Back to today'));
});

// L59 (WCAG 2.5.3 Label in Name): a button's accessible name contains the words it shows.
test(['DN-2', 'DN-4', 'NF-7'], "the notes screens' buttons have accessible names that contain their visible text", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  assert.equal((await w.save(w.staffA, leo, TODAY, { ratings: w.all(3), post: true })).status, 200);
  assert.equal((await w.t.as(w.hq).patch('/api/notes/items/' + w.items[3].id, { active: false })).status, 200);
  const tab = notesTab(w.t);
  const labelInName = box => {
    const named = box.findAll(n => n.tag === 'button' && n.getAttribute('aria-label') !== null && /[a-z]/i.test(n.textContent));
    for (const b of named) assert.ok(b.getAttribute('aria-label').toLowerCase().includes(b.textContent.toLowerCase()), `"${b.textContent}" is named "${b.getAttribute('aria-label')}"`);
    return named.map(b => b.getAttribute('aria-label'));
  };

  await tab.signIn(w.hq);
  const checklist = await tab.open('note-checklist');
  assert.deepEqual(labelInName(checklist).filter(l => /^Rename/.test(l)), ['Rename item 1', 'Rename item 2', 'Rename item 3']);
  assert.ok(labelInName(checklist).includes('Restore "Productive use of time"'));

  await tab.signIn(w.staffA);
  const day = await tab.open('daily-notes');
  assert.deepEqual(labelInName(day), ['Edit note for Leo Garcia']);
});

// Open item: on a 320px phone the hint can run to three lines; below the buttons it never pushes them.
test(['DN-4', 'NF-7'], 'the note hint sits below Post note and Save changes, so a longer hint never moves them', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  await tab.open('daily-notes');
  const c = noteCard(tab, leo);
  const order = () => {
    const kids = c.card().childNodes;
    const hint = kids.findIndex(n => n.cls.includes('note-hint'));
    const actions = kids.findIndex(n => n.cls.includes('note-actions'));
    return [actions >= 0, hint === kids.length - 1, hint > actions];
  };
  assert.deepEqual(order(), [true, true, true], 'Post note');
  for (const label of PRD_ITEMS) await c.tap(label, 'Great');
  await tab.click(c.button('Post note'));
  await tab.click(c.button('Edit note'));
  await c.tap('Focused', 'Good');
  assert.equal(c.hint(), 'Ready to save. Parents see the change but are not notified again.');
  assert.deepEqual(order(), [true, true, true], 'Save changes');
});

// Fix list 17: at 320px the hint runs to several lines; it reserves its longest wordings so the card never changes height.
test(['DN-4', 'NF-7'], 'the note hint reserves the height of its longest wordings, so the card keeps its height as the hint changes', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  await tab.open('daily-notes');
  const c = noteCard(tab, leo);
  const p = () => c.card().find(n => n.cls.includes('note-hint'));
  const fit = () => [p().getAttribute('data-fit-list'), p().getAttribute('data-fit-ready')];
  // The live wording is in its own span, in the same grid cell as the two hidden longest wordings.
  const live = () => { const kids = p().childNodes; return kids.length === 1 && kids[0].tag === 'span' ? kids[0].textContent : null; };
  const css = tab.css();
  assert.match(css, /\.note-hint \{ display: grid; grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.note-hint > span, \.note-hint::before, \.note-hint::after \{ grid-area: 1 \/ 1;/);
  assert.match(css, /\.note-hint::before \{ content: attr\(data-fit-list\); visibility: hidden; \}/);
  assert.match(css, /\.note-hint::after \{ content: attr\(data-fit-ready\); visibility: hidden; \}/);

  // Every "Rate ... to post." wording is a shorter run of the one naming every item.
  const everyItem = 'Rate On time, Focused, Respectful of others / not distracting and Productive use of time to ';
  assert.deepEqual(fit(), [everyItem + 'post.', 'Ready to post. Parents get a notification.']);
  assert.equal(live(), 'Rate each item to post.');
  await c.tap('On time', 'Great');
  assert.equal(live(), 'Rate Focused, Respectful of others / not distracting and Productive use of time to post.');
  assert.deepEqual(fit(), [everyItem + 'post.', 'Ready to post. Parents get a notification.'], 'the reserved wordings stay as the hint changes');
  for (const label of PRD_ITEMS.slice(1)) await c.tap(label, 'Great');
  assert.equal(live(), 'Ready to post. Parents get a notification.');

  // Editing a posted note reserves the save wordings, and the empty hint keeps them.
  await tab.click(c.button('Post note'));
  await tab.click(c.button('Edit note'));
  assert.equal(live(), '');
  assert.deepEqual(fit(), [everyItem + 'save.', 'Ready to save. Parents see the change but are not notified again.']);
  await c.tap('Focused', 'Good');
  assert.equal(live(), 'Ready to save. Parents see the change but are not notified again.');
});

// ---------------------------------------------------------------- weekly goals on the screens (D-57)

const pressedOf = box => box.findAll(n => n.tag === 'button' && n.getAttribute('aria-pressed') === 'true').map(b => b.textContent);
const buttonIn = (box, label) => box.find(n => n.tag === 'button' && n.textContent === label);
const subjectChip = (box, label) => box.find(n => n.tag === 'button' && n.getAttribute('data-subject') !== null && n.childNodes[0].textContent === label);
const errorText = (box, id) => byId(box, id).textContent;
const type = (box, id, text) => { const t = byId(box, id); t.value = text; t.dispatch('input'); };

test(['DG-2', 'DN-4', 'DN-3'], "a staff note card shows the student's goals this week, with that day's answers, between the visit line and the ratings", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  await setWeek(w, leo);
  const [m, e] = goalRows(w, leo).map(g => g.id);
  await nextDay(w, leo, THU);
  await answer(w, leo, { goalId: m, answer: 'yes' });
  await answer(w, leo, { goalId: e, answer: 'done', subject: 'history', text: HIST.text });
  w.visit(sofia, w.A, THU); w.visit(w.fb.student, w.A, THU);
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  const view = await tab.open('daily-notes');
  const goalsOf = s => noteCard(tab, s).card().find(n => n.cls.includes('note-goals'));
  const order = s => noteCard(tab, s).card().childNodes.map(n => n.cls.find(c => ['note-head', 'note-goals', 'note-rates', 'note-summary'].includes(c))).filter(Boolean);

  assert.equal(goalsOf(leo).find(n => n.tag === 'h3').textContent, 'Goals this week');
  // Read aloud (and as text), the subject, the goal and the day's answer stay apart.
  assert.deepEqual(goalsOf(leo).findAll(n => n.tag === 'li').map(li => li.textContent), [
    'Math, ' + MATH.text + '. Still working on it', 'English, ' + ENG.text + '. Done today', 'History, ' + HIST.text, 'Science, ' + SCI.text]);
  assert.deepEqual(goalsOf(leo).findAll(n => n.cls.includes('goal-answer')).map(b => [b.textContent, b.cls.includes('badge-ok')]),
    [['Still working on it', false], ['Done today', true]]);
  assert.equal(words(goalsOf(sofia)), 'Goals this week No goals this week');
  assert.deepEqual(order(leo), ['note-head', 'note-goals', 'note-rates']);
  assert.ok(view.find(n => n.tag === 'p' && n.textContent === 'Goals this week: 1 set · 2 not set'));
  const c = noteCard(tab, leo);
  assert.equal(c.comment().getAttribute('placeholder'), "How did today's goals go?");
  const label = view.find(n => n.tag === 'label' && n.getAttribute('for') === 'dn-c-' + leo.id);
  assert.equal(words(label), "Comment (optional) · reply to today's goals or anything else");

  // A posted note's summary keeps the goals in the same place.
  for (const l of PRD_ITEMS) await c.tap(l, 'Great');
  await tab.click(c.button('Post note'));
  assert.deepEqual(order(leo), ['note-head', 'note-goals', 'note-summary']);
});

test(['DG-2', 'DN-5'], "a parent's note and Home card show the student's goals as of that day above the ratings, and nothing for a student with none", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  await setWeek(w, leo);
  const [, , s] = goalRows(w, leo).map(g => g.id);
  w.visit(sofia, w.A);
  await nextDay(w, leo, THU);
  await answer(w, leo, { goalId: s, answer: 'change', subject: 'art', text: ART.text });
  for (const [st, d] of [[leo, TODAY], [sofia, TODAY], [leo, THU]]) assert.equal((await w.save(w.staffA, st, d, { ratings: w.all(3), post: true })).status, 200);
  const tab = notesTab(w.t);
  await tab.signIn(w.fa.parent);

  const notes = await tab.open('notes');
  const cards = notes.findAll(n => n.tag === 'article');
  const goalsOf = a => a.find(n => n.cls.includes('note-goals'));
  const [thu, wedLeo] = cards.filter(a => /Leo/.test(a.childNodes[0].textContent));
  assert.equal(goalsOf(thu).find(n => n.tag === 'h3').textContent, "Leo's goals this week");
  assert.deepEqual(goalsOf(thu).findAll(n => n.tag === 'li').map(li => li.textContent), [
    'Math, ' + MATH.text, 'English, ' + ENG.text, 'Science, ' + SCI.text + '. Changed today', 'Art, ' + ART.text]);
  assert.deepEqual(goalsOf(wedLeo).findAll(n => n.tag === 'li').map(li => li.textContent), ['Math, ' + MATH.text, 'English, ' + ENG.text, 'Science, ' + SCI.text]);
  const kids = thu.childNodes;
  assert.ok(kids.indexOf(goalsOf(thu)) < kids.findIndex(n => n.tag === 'ul' && n.cls.includes('list')), 'the goals come before the ratings');
  assert.equal(goalsOf(cards.find(a => /Sofia/.test(a.childNodes[0].textContent))), undefined, 'no goals, nothing shown');

  const home = await tab.card('notes-today');
  const leoLi = home.findAll(n => n.tag === 'li' && n.parentNode.cls.includes('list')).find(li => li.find(n => n.tag === 'strong').textContent === 'Leo Garcia');
  const grow = leoLi.find(n => n.cls.includes('grow')).childNodes;
  const idx = grow.findIndex(n => n.cls.includes('note-goals'));
  assert.ok(idx >= 0 && idx < grow.findIndex(n => n.cls.includes('note-summary')), 'the goals, above the ratings');
  assert.equal(grow[idx].findAll(n => n.tag === 'li').length, 4);
});

test(['DG-2', 'NF-7'], 'the daily update before checking in says to check in, with a button to the Check in screen; after checking in the button is gone', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  await setWeek(w, leo);
  w.t.clock.set(at(LA, THU, '08:00'));
  const tab = notesTab(w.t);
  await tab.signIn(leo);
  let view = await tab.open('goals');
  assert.ok(words(view).includes('Check in to update your goals today.'), words(view));
  const go = view.find(n => n.tag === 'a' && n.textContent === 'Go to Check in');
  assert.deepEqual([go && go.getAttribute('href'), go && go.cls.includes('btn-lg')], ['#/checkin', true]);
  await nextDay(w, leo, THU);
  view = await tab.open('goals');
  assert.equal(view.find(n => n.tag === 'a' && n.textContent === 'Go to Check in'), undefined);
});

test(['DG-1', 'DG-2', 'NF-7'], "setting the week's goals is one short flow, Goal 1 of 3: tap a subject, tap an example to fill the box, errors by the field, and no skip", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  const tab = notesTab(w.t);
  await tab.signIn(leo);

  // Before checking in: the message, a button to the Check in screen, and no form.
  let view = await tab.open('goals');
  assert.match(words(view), /^My goals This week: Mon, Oct 12 – Sun, Oct 18 Check in first, then set your 3 goals for this week\. Go to Check in$/);
  const go = view.find(n => n.tag === 'a' && n.textContent === 'Go to Check in');
  assert.deepEqual([go.getAttribute('href'), go.cls.includes('btn-lg')], ['#/checkin', true]);
  assert.equal(view.find(n => n.tag === 'textarea'), undefined);

  w.visit(leo, w.A);
  view = await tab.open('goals');
  const step = () => byId(view, 'goal-step').textContent;
  assert.equal(step(), 'Goal 1 of 3');
  assert.match(words(view), /Pick 3 things to finish this week, each in a different subject\./);
  assert.equal(view.find(n => /skip/i.test(n.textContent) && n.tag === 'button'), undefined, 'there is no Skip');
  const chips = () => view.findAll(n => n.tag === 'button' && n.getAttribute('data-subject') !== null);
  assert.deepEqual(chips().map(b => b.textContent), SUBJECTS.map(s => s[1]));
  assert.deepEqual(chips().map(b => b.getAttribute('aria-pressed')), SUBJECTS.map(() => 'false'));
  assert.equal(byId(view, 'goal-subject-label').textContent, 'Pick a subject');
  assert.equal(view.find(n => n.cls.includes('goal-subjects')).getAttribute('role'), 'group');
  assert.equal(view.find(n => n.cls.includes('goal-tip')).textContent, TIP, 'the tip sits above the examples');
  assert.equal(view.find(n => n.cls.includes('goal-examples')), undefined, 'examples follow the subject');
  assert.equal(view.find(n => n.tag === 'label' && n.getAttribute('for') === 'goal-text').textContent, 'Your goal (up to 3 sentences)');
  const text = () => byId(view, 'goal-text');
  assert.deepEqual([text().getAttribute('maxlength'), text().getAttribute('aria-describedby')], ['500', 'goal-text-err']);

  // Next with nothing picked: the reason under the subjects.
  await tab.click(buttonIn(view, 'Next'));
  assert.equal(errorText(view, 'goal-subject-err'), 'Pick a subject.');
  assert.equal(step(), 'Goal 1 of 3');
  // Tapping Math marks it and offers its examples; tapping one fills the box, which stays editable.
  await tab.click(subjectChip(view, 'Math'));
  assert.equal(errorText(view, 'goal-subject-err'), '');
  assert.deepEqual(pressedOf(view.find(n => n.cls.includes('goal-subjects'))), ['Math']);
  const examples = view.find(n => n.cls.includes('goal-examples'));
  assert.deepEqual([examples.getAttribute('role'), examples.findAll(n => n.tag === 'button').map(b => b.textContent)],
    ['group', [MATH.text, 'Redo the quiz problems I missed and write down what I got wrong.']]);
  assert.equal(byId(view, 'goal-ex').textContent, 'Tap an example, then make it yours');
  const own = () => byId(view, 'goal-own').textContent;
  assert.equal(own(), '');
  await tab.click(buttonIn(examples, MATH.text));
  assert.equal(text().value, MATH.text);
  // An example as it stands: a nudge to make it the student's own, until the words change.
  assert.equal(own(), "Now make it yours: change the chapter, unit or assignment to the one you're doing.");
  assert.equal(byId(view, 'goal-own').getAttribute('aria-live'), 'polite');
  type(view, 'goal-text', 'Finish the Chapter 7 practice problems and check my answers with the key.');
  assert.equal(own(), '');
  // No subject is taken on goal 1, so no tip about putting more in one goal.
  assert.equal(view.find(n => n.cls.includes('goal-same')), undefined);
  // Too short: the tip, right under the box, and what was typed stays.
  type(view, 'goal-text', 'Do math');
  await tab.click(buttonIn(view, 'Next'));
  assert.equal(errorText(view, 'goal-text-err'), TIP);
  assert.equal(text().getAttribute('aria-invalid'), 'true');
  assert.equal(text().value, 'Do math');
  assert.equal(step(), 'Goal 1 of 3');
  type(view, 'goal-text', MATH.text);
  assert.equal(errorText(view, 'goal-text-err'), '', 'typing clears it');
  tab.doc.scrolled = null;
  await tab.click(buttonIn(view, 'Next'));

  // Goal 2: Math is taken by goal 1, so it can't be picked again, and the tip says to put more Math in goal 1.
  assert.equal(step(), 'Goal 2 of 3');
  // The new step's card scrolls to its top (clear of the sticky bar), and focus on its heading doesn't scroll again.
  assert.deepEqual([tab.doc.scrolled[0].cls.join(' '), JSON.stringify(tab.doc.scrolled[1])], ['card goal-steps', '{"block":"start"}']);
  assert.equal(tab.doc.focused, byId(view, 'goal-step'));
  assert.equal(JSON.stringify(tab.doc.focusOpts), '{"preventScroll":true}');
  assert.match(tab.css(), /\.goal-steps, \.goal-form h3, #goal-done \{ scroll-margin-top: 84px; \}/);
  assert.equal(view.find(n => n.cls.includes('goal-same')).textContent, 'Doing more than one thing in a subject? Put it all in that goal.');
  assert.deepEqual(strays(view), [], 'no stray false under the progress dots');
  assert.deepEqual([subjectChip(view, 'Math').disabled, words(subjectChip(view, 'Math'))], [true, 'Math · Goal 1']);
  assert.equal(text().value, '');
  await tab.click(subjectChip(view, 'Other'));
  type(view, 'goal-text', ENG.text);
  // Back keeps what was written.
  await tab.click(buttonIn(view, 'Back'));
  assert.deepEqual([step(), text().value, pressedOf(view.find(n => n.cls.includes('goal-subjects')))], ['Goal 1 of 3', MATH.text, ['Math']]);
  assert.deepEqual([subjectChip(view, 'Math').disabled, subjectChip(view, 'Other').disabled, words(subjectChip(view, 'Other'))], [false, true, 'Other · Goal 2'],
    "a step's own subject stays open to it");
  await tab.click(buttonIn(view, 'Next'));
  assert.deepEqual([step(), text().value], ['Goal 2 of 3', ENG.text]);
  await tab.click(buttonIn(view, 'Next'));
  assert.equal(step(), 'Goal 3 of 3');
  assert.equal(buttonIn(view, 'Next'), undefined);
  assert.deepEqual(strays(view), []);
  await tab.click(subjectChip(view, 'Science'));
  type(view, 'goal-text', SCI.text);
  await tab.click(buttonIn(view, 'Save my 3 goals'));
  assert.deepEqual(goalRows(w, leo).map(g => [g.position, g.subject, g.text]), [[1, 'math', MATH.text], [2, 'other', ENG.text], [3, 'science', SCI.text]]);
  assert.deepEqual(lastToast(tab), ["You're set for today.", false]);
  assert.equal(tab.hash(), '#/home');
  // Each step was checked by the server's one goal check.
  assert.deepEqual(tab.requests.filter(r => r.method !== 'GET').map(r => r.url), [...Array(5).fill('/api/notes/goals/check-text'), '/api/notes/goals/week']);
  // Big, thumb-sized targets.
  assert.match(tab.css(), /\.goal-subjects \.btn, \.goal-answers \.btn \{ min-height: 48px;/);
  assert.ok(buttonIn(view, 'Save my 3 goals').cls.includes('btn-lg'));
});

test(['DG-1', 'NF-7'], 'a refusal of the whole week goes back to the goal it names and shows the reason by its field', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  w.visit(leo, w.A);
  const tab = notesTab(w.t);
  await tab.signIn(leo);
  const view = await tab.open('goals');
  // A screen whose step check let a short goal through (say, an older copy): the server's own refusal of the week.
  const realPost = tab.App.api.post;
  tab.App.api.post = (url, body) => (url === '/api/notes/goals/check-text' ? Promise.resolve({ ok: true, message: '' }) : realPost(url, body));
  for (const [label, text] of [['Math', 'Do math'], ['English', ENG.text], ['Science', SCI.text]]) {
    await tab.click(subjectChip(view, label));
    type(view, 'goal-text', text);
    await tab.click(buttonIn(view, label === 'Science' ? 'Save my 3 goals' : 'Next'));
  }
  assert.equal(byId(view, 'goal-step').textContent, 'Goal 1 of 3');
  assert.equal(errorText(view, 'goal-text-err'), TIP);
  assert.equal(byId(view, 'goal-text').value, 'Do math', 'what was typed stays');
  assert.deepEqual(goalRows(w, leo), []);
  assert.equal(lastToast(tab), undefined, 'shown by the field, not as a toast');
  assert.equal(tab.hash(), '');
});

// A localStorage like a browser's: strings in, strings out.
const fakeStorage = () => {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
    get length() { return m.size; }, key: i => [...m.keys()][i] ?? null };
};

test(['DG-1', 'NF-7'], 'a half-set week is kept on the device for that student and week: leaving the screen or reloading picks up at the same goal with what was typed, and saving clears it', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A);
  w.visit(sofia, w.A);
  const localStorage = fakeStorage();
  // A draft left from last week, and another student's: last week's goes when Leo opens the screen.
  const lastWeek = 'elite.goals.' + leo.id + '.2026-10-05', hersKey = 'elite.goals.' + sofia.id + '.' + WEEK.week_start;
  localStorage.setItem(lastWeek, JSON.stringify({ step: 2, picks: [ART, HIST, SCI] }));
  localStorage.setItem(hersKey, JSON.stringify({ step: 0, picks: [{ subject: '', text: '' }, { subject: '', text: '' }, { subject: '', text: '' }] }));
  const fill = async (tab, view, label, text, next = 'Next') => {
    await tab.click(subjectChip(view, label));
    type(view, 'goal-text', text);
    if (next) await tab.click(buttonIn(view, next));
  };
  let tab = notesTab(w.t, { localStorage });
  await tab.signIn(leo);
  let view = await tab.open('goals');
  assert.deepEqual([localStorage.getItem(lastWeek), byId(view, 'goal-step').textContent], [null, 'Goal 1 of 3']);
  assert.notEqual(localStorage.getItem(hersKey), null, "another student's draft stays");
  await fill(tab, view, 'Math', MATH.text);
  await fill(tab, view, 'English', 'Read chapters 6 to 8', null); // half typed on goal 2
  const key = 'elite.goals.' + leo.id + '.' + WEEK.week_start;
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), { step: 1, picks: [MATH, { subject: 'english', text: 'Read chapters 6 to 8' }, { subject: '', text: '' }] });

  // Away to Home and back: the same goal, as it was.
  const at2 = v => [byId(v, 'goal-step').textContent, byId(v, 'goal-text').value, pressedOf(v.find(n => n.cls.includes('goal-subjects')))];
  view = await tab.open('goals');
  assert.deepEqual(at2(view), ['Goal 2 of 3', 'Read chapters 6 to 8', ['English']]);
  // A reload (a new tab on the same device): the same.
  tab = notesTab(w.t, { localStorage });
  await tab.signIn(leo);
  view = await tab.open('goals');
  assert.deepEqual(at2(view), ['Goal 2 of 3', 'Read chapters 6 to 8', ['English']]);
  await tab.click(buttonIn(view, 'Back'));
  assert.equal(byId(view, 'goal-text').value, MATH.text);
  // Another student on this device starts from scratch.
  const other = notesTab(w.t, { localStorage });
  await other.signIn(sofia);
  const hers = await other.open('goals');
  assert.deepEqual([byId(hers, 'goal-step').textContent, byId(hers, 'goal-text').value], ['Goal 1 of 3', '']);

  // Saving the week clears it.
  await tab.click(buttonIn(view, 'Next'));
  type(view, 'goal-text', ENG.text);
  await tab.click(buttonIn(view, 'Next'));
  await fill(tab, view, 'Science', SCI.text, 'Save my 3 goals');
  assert.deepEqual(goalRows(w, leo).map(g => g.subject), ['math', 'english', 'science']);
  assert.equal(localStorage.getItem(key), null);

  // Something else under the key (an older screen, a hand edit) is ignored.
  localStorage.setItem('elite.goals.' + sofia.id + '.' + WEEK.week_start, JSON.stringify({ step: 7, picks: 'x' }));
  const fresh = notesTab(w.t, { localStorage });
  await fresh.signIn(sofia);
  const v2 = await fresh.open('goals');
  assert.deepEqual([byId(v2, 'goal-step').textContent, byId(v2, 'goal-text').value], ['Goal 1 of 3', '']);

  // A browser that blocks storage still keeps it while the app is open.
  const blocked = notesTab(w.t, { get localStorage() { throw new Error('SecurityError'); } });
  await blocked.signIn(sofia);
  let v3 = await blocked.open('goals');
  await fill(blocked, v3, 'Art', ART.text);
  v3 = await blocked.open('goals');
  assert.deepEqual([byId(v3, 'goal-step').textContent, byId(v3, 'goal-text').value], ['Goal 2 of 3', '']);
  await blocked.click(buttonIn(v3, 'Back'));
  assert.equal(byId(v3, 'goal-text').value, ART.text);
});

test(['DG-1', 'DG-2', 'NF-7'], 'the daily update is one card per goal with Yes, Done and Change; each goal is answered on its own, Done and Change ask for the next goal, then "You\'re set for today"', async () => {
  const w = await world();
  const leo = w.fa.students[0];
  await setWeek(w, leo, [MATH, ENG, SCI]);
  const tab = notesTab(w.t);
  await tab.signIn(leo);

  // The day the goals were set there is nothing to answer: each goal says it's new, and can only be changed.
  let view = await tab.open('goals');
  assert.match(words(view.find(n => n.getAttribute('role') === 'status')), /^✓ You're set for today\.$/);
  assert.deepEqual(view.findAll(n => n.tag === 'article').map(a => words(a)), [
    `Math Goal 1 ${MATH.text} New today. Want to change it? Change`,
    `English Goal 2 ${ENG.text} New today. Want to change it? Change`,
    `Science Goal 3 ${SCI.text} New today. Want to change it? Change`]);
  assert.equal(view.find(n => n.cls.includes('goal-answers')).getAttribute('aria-labelledby').split(' ').map(id => byId(view, id).textContent).join(' · '),
    'New today. Want to change it? · Math');
  // Change opens on the goal as it is; Cancel puts focus back on that card's Change.
  const mathChange = buttonIn(view.findAll(n => n.tag === 'article')[0], 'Change');
  await tab.click(mathChange);
  assert.deepEqual([byId(view, `goal-${goalRows(w, leo)[0].id}-text`).value, pressedOf(view.find(n => n.cls.includes('goal-form')).find(n => n.cls.includes('goal-subjects')))],
    [MATH.text, ['Math']]);
  await tab.click(buttonIn(view, 'Cancel'));
  assert.equal(tab.doc.focused, byId(view, 'goal-change-' + goalRows(w, leo)[0].id));
  await nextDay(w, leo, THU);
  view = await tab.open('goals');
  const status = () => words(view.find(n => n.getAttribute('role') === 'status'));
  const cards = () => view.findAll(n => n.tag === 'article');
  const cardOf = subject => cards().find(a => a.find(n => n.cls.includes('badge-accent')).textContent === subject);
  assert.equal(status(), 'Still working on these? Answer each goal. 3 to go.');
  assert.deepEqual(cards().map(a => words(a)), [
    `Math Goal 1 ${MATH.text} Still working on this? Yes Done Change`,
    `English Goal 2 ${ENG.text} Still working on this? Yes Done Change`,
    `Science Goal 3 ${SCI.text} Still working on this? Yes Done Change`]);
  // Each card's buttons are a group named by its question and subject; no button answers them all.
  const group = cards()[0].find(n => n.getAttribute('role') === 'group');
  assert.deepEqual(group.getAttribute('aria-labelledby').split(' ').map(id => byId(view, id).textContent), ['Still working on this?', 'Math']);
  assert.deepEqual([...new Set(view.findAll(n => n.tag === 'button').map(b => b.textContent))], ['Yes', 'Done', 'Change']);

  await tab.click(buttonIn(cardOf('Math'), 'Yes'));
  assert.equal(status(), 'Still working on these? Answer each goal. 2 to go.');
  assert.deepEqual([words(cardOf('Math').find(n => n.cls.includes('goal-q'))), pressedOf(cardOf('Math'))], ['✓ Still working on it', ['Yes']]);

  // Change on English: the form for the new goal, starting from the goal as it is, with the other goals' subjects taken.
  const answersOf = subject => cardOf(subject).find(n => n.cls.includes('goal-answers'));
  await tab.click(buttonIn(cardOf('English'), 'Change'));
  assert.deepEqual(pressedOf(answersOf('English')), ['Change'], 'the chosen answer is pressed for screen readers too');
  let form = cardOf('English').find(n => n.cls.includes('goal-form'));
  const eId = goalRows(w, leo)[1].id;
  assert.equal(form.find(n => n.tag === 'h3').textContent, "What's your new goal?");
  assert.deepEqual(form.findAll(n => n.tag === 'button' && n.disabled).map(b => words(b)), ['Math · Goal 1', 'Science · Goal 3']);
  assert.deepEqual([pressedOf(form.find(n => n.cls.includes('goal-subjects'))), byId(view, `goal-${eId}-text`).value], [['English'], ENG.text]);
  // Saving it unchanged isn't a change: the goal check says so, by the text, and what's there stays.
  await tab.click(buttonIn(form, 'Save new goal'));
  assert.equal(errorText(view, `goal-${eId}-text-err`), 'Change something first, or tap Cancel to keep it.');
  assert.equal(byId(view, `goal-${eId}-text`).value, ENG.text);
  assert.equal(goalRows(w, leo).length, 3, 'nothing changed');
  // A small fix in the same subject is fine; this one, though, is too short.
  type(view, `goal-${eId}-text`, ENG.text + ' Then outline my essay.');
  assert.equal(errorText(view, `goal-${eId}-text-err`), '');
  await tab.click(subjectChip(form, 'History'));
  type(view, `goal-${eId}-text`, 'Read history');
  await tab.click(buttonIn(form, 'Save new goal'));
  assert.equal(errorText(view, `goal-${eId}-text-err`), TIP, 'the server says why, under the box');
  assert.equal(byId(view, `goal-${eId}-text`).value, 'Read history');
  type(view, `goal-${eId}-text`, HIST.text);
  await tab.click(buttonIn(form, 'Save new goal'));
  assert.equal(status(), 'Still working on these? Answer each goal. 1 to go.');
  assert.deepEqual(cards().map(a => a.find(n => n.cls.includes('badge-accent')).textContent), ['Math', 'History', 'Science']);
  assert.equal(words(cardOf('History').find(n => n.cls.includes('goal-q'))), 'New today. Want to change it?');
  assert.deepEqual(answersOf('History').findAll(n => n.tag === 'button').map(b => b.textContent), ['Change'], 'nothing to answer about a goal added today');

  // Done on Science: "Nice work!", and its next goal, from scratch.
  await tab.click(buttonIn(cardOf('Science'), 'Done'));
  assert.deepEqual(pressedOf(answersOf('Science')), ['Done']);
  form = cardOf('Science').find(n => n.cls.includes('goal-form'));
  const sId = goalRows(w, leo)[2].id;
  assert.equal(form.find(n => n.tag === 'h3').textContent, "Nice work! What's your next goal?");
  assert.deepEqual([pressedOf(form.find(n => n.cls.includes('goal-subjects'))), byId(view, `goal-${sId}-text`).value], [[], '']);
  assert.equal(view.find(n => n.id === 'goal-done-h'), undefined, 'nothing done yet this week');
  await tab.click(buttonIn(form, 'Save new goal'));
  assert.equal(errorText(view, `goal-${sId}-subject-err`), 'Pick a subject.');
  await tab.click(subjectChip(form, 'Art'));
  await tab.click(buttonIn(form.find(n => n.cls.includes('goal-examples')), 'Sketch three thumbnail ideas for my next portfolio piece.'));
  await tab.click(buttonIn(form, 'Save new goal'));
  assert.equal(status(), "✓ You're set for today.");
  assert.deepEqual(lastToast(tab), ["You're set for today.", false]);
  assert.deepEqual(cards().map(a => a.find(n => n.cls.includes('badge-accent')).textContent), ['Math', 'History', 'Art']);
  // The finished goal stays in view, under Done this week.
  const done = byId(view, 'goal-done-h').parentNode;
  assert.equal(done.getAttribute('aria-labelledby'), 'goal-done-h');
  assert.deepEqual(done.findAll(n => n.tag === 'li').map(li => li.textContent), ['Science, ' + SCI.text + '. ✓ Done Thu']);
  // One answer per request, each for one goal.
  const sent = tab.requests.filter(r => r.url === '/api/notes/goals/week/check' && r.status === 200);
  assert.equal(sent.length, 3);
  assert.deepEqual(checkRows(w, leo).map(c => c[2]), ['yes', 'change', 'done']);
});

test(['DG-1', 'DG-2'], "a student's Home card asks for the week's goals until they're set, then shows them with today's status", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  const tab = notesTab(w.t);
  await tab.signIn(leo);
  const link = (box, label) => box.find(n => n.tag === 'a' && n.textContent === label);

  let box = await tab.card('notes-goals');
  assert.equal(words(box), "This week's goals Set your 3 goals for this week. You'll set them after you check in.");
  w.visit(leo, w.A);
  box = await tab.card('notes-goals');
  assert.equal(words(box), "This week's goals Set your 3 goals for this week. Set my 3 goals");
  assert.deepEqual([link(box, 'Set my 3 goals').getAttribute('href'), link(box, 'Set my 3 goals').cls.includes('btn-lg')], ['#/goals', true]);

  await setWeek(w, leo);
  box = await tab.card('notes-goals');
  // Every goal has a status chip: new today, not answered yet, or still working on it.
  assert.deepEqual(box.findAll(n => n.tag === 'li').map(li => li.textContent),
    ['Math, ' + MATH.text + '. New today', 'English, ' + ENG.text + '. New today', 'Science, ' + SCI.text + '. New today']);
  assert.match(words(box), /✓ You're set for today\. See my goals$/);
  assert.equal(link(box, 'See my goals').getAttribute('href'), '#/goals');

  // The next day, before checking in: the goals, no question yet; after: the update.
  w.t.clock.set(at(LA, THU, '08:00'));
  box = await tab.card('notes-goals');
  assert.doesNotMatch(words(box), /set for today|Still working/);
  assert.equal(box.findAll(n => n.tag === 'li')[0].textContent, 'Math, ' + MATH.text + '. Not answered yet');
  await nextDay(w, leo, THU);
  box = await tab.card('notes-goals');
  assert.match(words(box), /Still working on these\? Update my goals$/);
  const [m, e] = goalRows(w, leo).map(g => g.id);
  await answer(w, leo, { goalId: m, answer: 'yes' });
  box = await tab.card('notes-goals');
  assert.equal(box.findAll(n => n.tag === 'li')[0].textContent, 'Math, ' + MATH.text + '. Still working on it');
  assert.equal(box.find(n => n.tag === 'h3'), undefined, 'nothing done yet');
  // A finished goal stays on the card, under Done this week, with the day.
  await answer(w, leo, { goalId: e, answer: 'done', subject: 'history', text: HIST.text });
  box = await tab.card('notes-goals');
  assert.deepEqual(box.findAll(n => n.tag === 'li').map(li => li.textContent), ['Math, ' + MATH.text + '. Still working on it',
    'History, ' + HIST.text + '. New today', 'Science, ' + SCI.text + '. Not answered yet', 'English, ' + ENG.text + '. ✓ Done Thu']);
  assert.equal(box.find(n => n.tag === 'h3').textContent, 'Done this week');
  assert.deepEqual(strays(box), []);
});

test(['DG-2', 'DN-5'], "a parent's Home card shows each student's goals this week any time, and See updates lists every daily answer by day", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  await setWeek(w, leo);
  const [m, e] = goalRows(w, leo).map(g => g.id);
  await nextDay(w, leo, THU);
  await answer(w, leo, { goalId: m, answer: 'yes' });
  await answer(w, leo, { goalId: e, answer: 'done', subject: 'history', text: HIST.text });
  const tab = notesTab(w.t);
  await tab.signIn(w.fa.parent);

  const home = await tab.card('notes-week-goals');
  assert.equal(home.find(n => n.tag === 'h2').textContent, "This week's goals");
  const lis = home.findAll(n => n.tag === 'li' && n.parentNode.cls.includes('list'));
  const leoLi = lis.find(li => li.find(n => n.tag === 'strong').textContent === 'Leo Garcia');
  assert.deepEqual(leoLi.findAll(n => n.tag === 'li').map(li => li.textContent), [
    'Math, ' + MATH.text + '. Still working on it', 'History, ' + HIST.text, 'Science, ' + SCI.text]);
  const see = leoLi.find(n => n.tag === 'a');
  assert.deepEqual([see.textContent, see.getAttribute('aria-label'), see.getAttribute('href')], ['See updates', 'See updates for Leo Garcia', '#/week-goals/' + leo.id]);
  const sofiaLi = lis.find(li => li.find(n => n.tag === 'strong').textContent === 'Sofia Garcia');
  assert.equal(sofiaLi.find(n => n.cls.includes('muted')).textContent, "Sofia hasn't set this week's goals yet.");
  assert.deepEqual([sofiaLi.find(n => n.cls.includes('grow')).textContent, strays(home)], ["Sofia GarciaSofia hasn't set this week's goals yet.", []], 'no stray 0 and no See updates without goals');

  const view = await tab.open('week-goals', String(leo.id));
  assert.equal(view.find(n => n.tag === 'h1').textContent, "Leo's goals");
  const sections = view.findAll(n => n.tag === 'section');
  assert.equal(words(sections[0]), `Working on now Math , ${MATH.text} . Still working on it History , ${HIST.text} Science , ${SCI.text}`);
  assert.equal(sections[1].find(n => n.tag === 'h3').textContent, 'Thursday, Oct 15');
  assert.deepEqual(sections[1].findAll(n => n.tag === 'li').map(li => li.textContent), [
    'Math, ' + MATH.text + '. Still working on it', 'English, ' + ENG.text + '. DoneNext goal: History, ' + HIST.text]);
  // On Friday, Thursday's answers are history: the Home card shows no answer for today yet.
  await nextDay(w, leo, FRI);
  const fri = await tab.card('notes-week-goals');
  assert.equal(fri.findAll(n => n.tag === 'li' && !n.parentNode.cls.includes('list'))[0].textContent, 'Math, ' + MATH.text);
  const none = await tab.open('week-goals', String(sofia.id));
  assert.match(words(none), /Sofia hasn't set this week's goals yet\./);
});
// ---------------------------------------------------------------- the demo seed (docs/v1.1-design.md 5.3)

test(['DG-2'], 'the notes seed writes last week and this week: 3 goals in 3 subjects at the first visit, a mix of daily answers at later visits, and one student with no goals this week', async () => {
  const w = await world(); // Wed Oct 14: this week is Oct 12-18, last week Oct 5-11
  const [leo, sofia] = w.fa.students, anh = w.fb.student, noah = w.fc.student;
  for (const d of ['2026-09-30', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', YESTERDAY, TODAY]) w.visit(leo, w.A, d);
  w.visit(leo, w.B, '2026-10-08', { session: null }); // not his home location
  for (const d of ['2026-10-12', YESTERDAY]) w.visit(sofia, w.A, d);
  for (const d of ['2026-10-09', YESTERDAY]) w.visit(anh, w.A, d);
  w.visit(noah, w.B, '2026-10-12', { session: null });
  load('src/modules/notes/seed.js')(w.t.ctx, { NOW: w.t.clock.now() });

  const weeks = s => w.t.db.prepare('SELECT week_start, location_id FROM goal_weeks WHERE student_id = ? ORDER BY week_start').all(s.id).map(r => [r.week_start, r.location_id]);
  assert.deepEqual(weeks(leo), [['2026-10-05', w.A.id], ['2026-10-12', w.A.id]]);
  assert.deepEqual(weeks(anh), [['2026-10-05', w.A.id], ['2026-10-12', w.A.id]]);
  assert.deepEqual(weeks(noah), [['2026-10-12', w.B.id]]);
  assert.deepEqual(weeks(sofia), [], 'the last student by name who came this week has no goals this week');

  const visitDays = { [leo.id]: ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', YESTERDAY], [anh.id]: ['2026-10-09', YESTERDAY], [noah.id]: ['2026-10-12'] };
  const answers = new Set();
  for (const s of [leo, anh, noah]) {
    const rows = goalRows(w, s), checks = checkRows(w, s);
    for (const [ws] of weeks(s)) {
      const inWeek = rows.filter(g => g.week_start === ws);
      const days = visitDays[s.id].filter(d => d >= ws && d < { '2026-10-05': '2026-10-12', '2026-10-12': '2026-10-19' }[ws]);
      // Set at the first visit: 3 goals, 3 subjects.
      assert.deepEqual(inWeek.filter(g => g.created_on === days[0]).map(g => g.position), [1, 2, 3], s.name + ' ' + ws);
      const open = inWeek.filter(g => g.status === 'open');
      assert.deepEqual([open.length, new Set(open.map(g => g.subject)).size], [3, 3], s.name + ' ' + ws);
      // Every later visit day answers each goal open that day, once; nothing on other days.
      for (const d of days.slice(1)) {
        const openThen = inWeek.filter(g => g.created_on < d && (g.done_on || g.replaced_on || '9999') >= d).map(g => g.id).sort();
        assert.deepEqual(checks.filter(c => c[1] === d).map(c => c[0]).sort(), openThen, s.name + ' ' + d);
      }
      assert.ok(checks.every(c => visitDays[s.id].includes(c[1])), 'answers only on visit days');
      for (const g of inWeek) assert.ok(days.includes(g.created_on), 'goals only on visit days');
    }
    checks.forEach(c => answers.add(c[2]));
    for (const g of rows) {
      const r = await w.t.as(s).post('/api/notes/goals/check-text', { subject: g.subject, text: g.text });
      assert.ok(r.body.ok, g.text);
    }
    assert.ok(rows.every(g => g.status === 'open' || g.replaced_by), 'a closed goal points at its replacement');
  }
  assert.deepEqual([...answers].sort(), ['change', 'done', 'yes']);
  assert.deepEqual(goalRows(w, leo).filter(g => g.created_on === TODAY || g.created_on < '2026-10-05'), [], "today and older weeks are left alone");
  // Staff see them on Daily notes, with the day's answers.
  const day = await w.t.as(w.staffA).get('/api/notes/day?date=' + YESTERDAY);
  assert.deepEqual(day.body.goal_counts, { set: 2, none: 1 });
  assert.ok(day.body.students.find(s => s.id === leo.id).goals.every(g => g.answer || g.created_on === YESTERDAY));
});
