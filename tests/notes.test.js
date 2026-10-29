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

// ---------------------------------------------------------------- DG-1, DG-2: daily goals

const SUBJECTS = [['math', 'Math'], ['english', 'English'], ['science', 'Science'], ['history', 'History'], ['language', 'Language'],
  ['art', 'Art'], ['test_prep', 'Test prep'], ['other', 'Other']];
const goalRows = (w, s) => w.t.db.prepare('SELECT local_date, position, subject, text FROM daily_goals WHERE student_id = ? ORDER BY local_date, position').all(s.id)
  .map(r => [r.local_date, r.position, r.subject, r.text]);
const goalDays = (w, s) => w.t.db.prepare('SELECT local_date, location_id, status FROM daily_goal_days WHERE student_id = ? ORDER BY local_date').all(s.id)
  .map(r => [r.local_date, r.location_id, r.status]);

test(['DG-1'], 'the goal subjects are fixed: eight subjects, each with three example goals, up to 3 goals of 280 characters', async () => {
  const w = await world();
  for (const u of [w.fa.students[0], w.fa.parent, w.staffA, w.hq]) {
    const r = await w.t.as(u).get('/api/notes/goals/subjects');
    assert.equal(r.status, 200, u.role);
    assert.deepEqual(r.body.subjects.map(s => [s.id, s.label]), SUBJECTS);
    assert.ok(r.body.subjects.every(s => s.examples.length === 3 && s.examples.every(x => typeof x === 'string' && x.length > 0)));
    assert.deepEqual([r.body.max_goals, r.body.text_max], [3, 280]);
  }
  const r = await w.t.as(w.fa.students[0]).get('/api/notes/goals/subjects');
  assert.deepEqual(r.body.subjects[0].examples, ['Finish the practice set for my current lesson', 'Review for my next quiz', 'Take notes on the new lesson video']);
  assert.deepEqual(r.body.subjects[2].examples, ['Finish my lab write-up', "Study this chapter's vocabulary", 'Watch the lesson video and answer the review questions']);
  assert.equal((await w.t.anon.get('/api/notes/goals/subjects')).status, 401);
});

test(['DG-1', 'DG-2'], "a student sets today's goals only after checking in today at their home location, and can edit them that day", async () => {
  const w = await world();
  const leo = w.fa.students[0];
  const me = w.t.as(leo);
  const two = [{ subject: 'math', text: 'Finish the practice set for my current lesson' }, { subject: 'science', text: '  Finish my lab write-up  ' }];

  // Before any check-in today: not answered, and nothing can be set or skipped.
  w.visit(leo, w.A, YESTERDAY);
  w.visit(leo, w.B); // a visit somewhere else isn't a check-in at his home location
  assert.deepEqual((await me.get('/api/notes/goals/today')).body, { date: TODAY, checked_in: false, status: 'none', goals: [] });
  for (const r of [await me.put('/api/notes/goals/today', { goals: two }), await me.post('/api/notes/goals/today/skip')]) {
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'no_visit_today');
    assert.equal(r.body.message, "Check in first, then set today's goals.");
  }
  assert.deepEqual(goalDays(w, leo), []);

  // He checks in (and even out again): now he can set them.
  w.visit(leo, w.A);
  assert.deepEqual((await me.get('/api/notes/goals/today')).body, { date: TODAY, checked_in: true, status: 'none', goals: [] });
  const set = await me.put('/api/notes/goals/today', { goals: two });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body, { date: TODAY, checked_in: true, status: 'set', goals: [
    { position: 1, subject: 'math', subject_label: 'Math', text: 'Finish the practice set for my current lesson' },
    { position: 2, subject: 'science', subject_label: 'Science', text: 'Finish my lab write-up' }] });
  assert.deepEqual((await me.get('/api/notes/goals/today')).body, set.body);
  assert.deepEqual(goalDays(w, leo), [[TODAY, w.A.id, 'set']]);

  // Editing replaces the day's goals.
  const edit = await me.put('/api/notes/goals/today', { goals: [{ subject: 'test_prep', text: 'Do one timed practice section' }] });
  assert.equal(edit.status, 200);
  assert.deepEqual(edit.body.goals.map(g => [g.position, g.subject_label, g.text]), [[1, 'Test prep', 'Do one timed practice section']]);
  assert.deepEqual(goalRows(w, leo), [[TODAY, 1, 'test_prep', 'Do one timed practice section']]);

  // Bad goals are refused and change nothing.
  const tooLong = 'x'.repeat(281);
  for (const [goals, error, message] of [
    [[], 'no_goals', 'Add at least one goal, or skip today.'],
    [undefined, 'no_goals', 'Add at least one goal, or skip today.'],
    [[...two, two[0], two[1]], 'too_many_goals', 'Set up to 3 goals for today.'],
    [[two[0], { subject: 'music', text: 'Practice scales' }], 'bad_subject', 'Choose a subject for goal 2.'],
    [[{ text: 'No subject' }], 'bad_subject', 'Choose a subject for goal 1.'],
    [[{ subject: 'math', text: '   ' }], 'goal_text', "Write what you're working on for goal 1."],
    [[two[0], { subject: 'art', text: 42 }], 'goal_text', "Write what you're working on for goal 2."],
    [[{ subject: 'math', text: tooLong }], 'goal_text', 'Keep goal 1 to 280 characters or fewer.'],
  ]) {
    const r = await me.put('/api/notes/goals/today', { goals });
    assert.equal(r.status, 400, JSON.stringify(goals));
    assert.deepEqual([r.body.error, r.body.message], [error, message]);
  }
  assert.deepEqual(goalRows(w, leo), [[TODAY, 1, 'test_prep', 'Do one timed practice section']]);

  // Three goals, one exactly 280 characters, are fine.
  const full = 'y'.repeat(280);
  const three = await me.put('/api/notes/goals/today', { goals: [two[0], two[1], { subject: 'other', text: full }] });
  assert.equal(three.status, 200);
  assert.deepEqual(three.body.goals.map(g => g.text), ['Finish the practice set for my current lesson', 'Finish my lab write-up', full]);

  // The next day starts unanswered; yesterday's goals stay with yesterday.
  w.t.clock.set(at(LA, '2026-10-15', '09:00'));
  assert.deepEqual((await me.get('/api/notes/goals/today')).body, { date: '2026-10-15', checked_in: false, status: 'none', goals: [] });
  assert.equal((await me.put('/api/notes/goals/today', { goals: two })).status, 400, 'no check-in yet on the new day');
  assert.equal(goalRows(w, leo).length, 3);
});

test(['DG-2'], 'a student can skip a day while it is not answered; set goals can be edited but not skipped', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A); w.visit(sofia, w.A);
  const me = w.t.as(leo);

  const skip = await me.post('/api/notes/goals/today/skip');
  assert.equal(skip.status, 200);
  assert.deepEqual(skip.body, { status: 'skipped' });
  assert.deepEqual((await me.get('/api/notes/goals/today')).body, { date: TODAY, checked_in: true, status: 'skipped', goals: [] });
  assert.equal((await me.post('/api/notes/goals/today/skip')).status, 200, 'skipping again changes nothing');
  assert.deepEqual(goalDays(w, leo), [[TODAY, w.A.id, 'skipped']]);

  // Setting goals later that day turns the skip into set.
  const set = await me.put('/api/notes/goals/today', { goals: [{ subject: 'english', text: 'Write the first draft of my essay' }] });
  assert.equal(set.status, 200);
  assert.equal(set.body.status, 'set');
  assert.deepEqual(goalDays(w, leo), [[TODAY, w.A.id, 'set']]);

  // Once set, skip is refused.
  const late = await me.post('/api/notes/goals/today/skip');
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'already_set');
  assert.equal(late.body.message, "You already set today's goals. You can edit them instead.");
  assert.deepEqual((await me.get('/api/notes/goals/today')).body.goals.map(g => g.text), ['Write the first draft of my essay']);
  assert.deepEqual(goalDays(w, sofia), [], "Sofia's day is her own");
});

test(['DG-1'], "a student's goal day is their home location's date", async () => {
  const w = await world();
  const TOR = 'America/Toronto', OCT15 = '2026-10-15';
  const T = w.t.fx.location({ name: 'Toronto', timezone: TOR });
  const eli = w.t.fx.family(T).student;
  const me = w.t.as(eli);
  w.visit(eli, T); // Wednesday in Toronto
  // 22:30 in Los Angeles is 01:30 on Thursday in Toronto: Wednesday's check-in no longer counts.
  w.t.clock.set(at(LA, TODAY, '22:30'));
  assert.deepEqual((await me.get('/api/notes/goals/today')).body, { date: OCT15, checked_in: false, status: 'none', goals: [] });
  assert.equal((await me.post('/api/notes/goals/today/skip')).status, 400);
  w.visit(eli, T, OCT15, { check_in_at: at(TOR, OCT15, '01:00'), check_out_at: null, checkout_method: null });
  assert.equal((await me.put('/api/notes/goals/today', { goals: [{ subject: 'history', text: 'Prepare notes for my essay' }] })).status, 200);
  assert.deepEqual(goalDays(w, eli), [[OCT15, T.id, 'set']]);
});

test(['DG-2', 'DN-4'], 'staff see each student\'s goals and status on the day list, with counts of set, skipped and not answered', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, anh = w.fb.student;
  for (const s of [leo, sofia, anh]) w.visit(s, w.A);
  w.visit(leo, w.A, YESTERDAY);
  assert.equal((await w.t.as(leo).put('/api/notes/goals/today', { goals: [
    { subject: 'math', text: 'Review for my next quiz' }, { subject: 'art', text: 'Plan my next portfolio piece' }] })).status, 200);
  assert.equal((await w.t.as(sofia).post('/api/notes/goals/today/skip')).status, 200);

  for (const u of [w.staffA, w.dirA]) {
    const r = await w.t.as(u).get('/api/notes/day');
    assert.deepEqual(r.body.goal_counts, { set: 1, skipped: 1, none: 1 }, u.role);
    const by = Object.fromEntries(r.body.students.map(s => [s.name, s.goals]));
    assert.deepEqual(by['Leo Garcia'], { status: 'set', items: [
      { position: 1, subject: 'math', subject_label: 'Math', text: 'Review for my next quiz' },
      { position: 2, subject: 'art', subject_label: 'Art', text: 'Plan my next portfolio piece' }] });
    assert.deepEqual(by['Sofia Garcia'], { status: 'skipped', items: [] });
    assert.deepEqual(by['Anh Nguyen'], { status: 'none', items: [] });
  }
  // Another day shows that day's record: Leo set nothing yesterday.
  const y = await w.t.as(w.staffA).get('/api/notes/day?date=' + YESTERDAY);
  assert.deepEqual(y.body.students.map(s => [s.name, s.goals.status]), [['Leo Garcia', 'none']]);
  assert.deepEqual(y.body.goal_counts, { set: 0, skipped: 0, none: 1 });
  // HQ too, for the location it picks; staff elsewhere see their own list only.
  assert.deepEqual((await w.t.as(w.hq).get('/api/notes/day?location=' + w.A.id)).body.goal_counts, { set: 1, skipped: 1, none: 1 });
  assert.equal((await w.t.as(w.staffB).get('/api/notes/day?location=' + w.A.id)).status, 403);
});

test(['DG-2', 'DN-2', 'DN-5'], 'parents see the goals only inside the posted note, read live; skipped or unanswered days show none', async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, anh = w.fb.student;
  for (const s of [leo, sofia, anh]) w.visit(s, w.A);
  assert.equal((await w.t.as(leo).put('/api/notes/goals/today', { goals: [{ subject: 'english', text: 'Revise a paragraph for grammar' }] })).status, 200);
  assert.equal((await w.t.as(sofia).post('/api/notes/goals/today/skip')).status, 200);
  const p = w.t.as(w.fa.parent);
  assert.deepEqual((await p.get('/api/notes/feed')).body.notes, [], 'no note posted yet, so no goals');

  for (const s of [leo, sofia, anh]) assert.equal((await w.save(w.staffA, s, TODAY, { ratings: w.all(3), comment: 'Good work on your goals.', post: true })).status, 200);
  const feed = await p.get('/api/notes/feed');
  const by = Object.fromEntries(feed.body.notes.map(n => [n.student_name, n.goals]));
  assert.deepEqual(by, { 'Leo Garcia': [{ position: 1, subject: 'english', subject_label: 'English', text: 'Revise a paragraph for grammar' }], 'Sofia Garcia': [] });
  assert.deepEqual((await w.t.as(w.fb.parent).get('/api/notes/feed')).body.notes[0].goals, [], 'unanswered shows nothing');

  // Leo edits his goals later that day: the posted note shows the edit.
  assert.equal((await w.t.as(leo).put('/api/notes/goals/today', { goals: [
    { subject: 'english', text: 'Revise two paragraphs for grammar' }, { subject: 'math', text: 'Review for my next quiz' }] })).status, 200);
  const today = await p.get('/api/notes/today');
  assert.deepEqual(today.body.students.find(s => s.id === leo.id).note.goals.map(g => [g.subject_label, g.text]),
    [['English', 'Revise two paragraphs for grammar'], ['Math', 'Review for my next quiz']]);
  const [n] = w.t.fx.notifications(w.fa.parent, 'note').filter(x => w.notes().find(y => y.id === x.ref_id).student_id === leo.id);
  assert.deepEqual((await p.get('/api/notes/note/' + n.ref_id)).body.note.goals.map(g => g.text), ['Revise two paragraphs for grammar', 'Review for my next quiz']);
  assert.equal(w.t.fx.notifications(w.fa.parent, 'note').length, 2, 'goals send no notice of their own');
});

test(['NF-1', 'DG-2'], "only a student reads or writes goals, and only their own: parents, staff and HQ can't use the goal routes", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A); w.visit(sofia, w.A);
  assert.equal((await w.t.as(leo).put('/api/notes/goals/today', { goals: [{ subject: 'math', text: "Leo's goal" }] })).status, 200);
  for (const u of [w.fa.parent, w.fb.parent, w.staffA, w.dirA, w.staffB, w.hq]) {
    const c = w.t.as(u);
    const get = await c.get('/api/notes/goals/today');
    assert.equal(get.status, 403, u.role + ' read');
    assert.equal(get.body.goals, undefined);
    assert.equal((await c.put('/api/notes/goals/today', { goals: [{ subject: 'math', text: 'Not mine' }] })).status, 403, u.role + ' write');
    assert.equal((await c.post('/api/notes/goals/today/skip')).status, 403, u.role + ' skip');
  }
  for (const [m, url] of [['get', '/api/notes/goals/today'], ['put', '/api/notes/goals/today'], ['post', '/api/notes/goals/today/skip']]) {
    assert.equal((await w.t.anon[m](url)).status, 401, m + ' ' + url);
  }
  // Sofia sees and changes only her own day.
  const sof = w.t.as(sofia);
  assert.deepEqual((await sof.get('/api/notes/goals/today')).body.status, 'none');
  assert.equal((await sof.post('/api/notes/goals/today/skip')).status, 200);
  assert.deepEqual(goalRows(w, leo), [[TODAY, 1, 'math', "Leo's goal"]]);
  assert.deepEqual(goalDays(w, leo), [[TODAY, w.A.id, 'set']]);
  assert.deepEqual(goalDays(w, sofia), [[TODAY, w.A.id, 'skipped']]);
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
  focus() { this.doc.focused = this; }
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
// mutation runner's copy is the one exercised) against the test server.
function notesTab(t) {
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
    App, requests, replaced, settle, main, css: () => doc.head.textContent,
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

// ---------------------------------------------------------------- daily goals on the screens

test(['DG-2', 'DN-4', 'DN-3'], "a staff note card shows the student's goals between the visit line and the ratings, and the comment invites a reply to them", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students, anh = w.fb.student, mia = w.t.fx.family(w.A).student;
  for (const s of [leo, sofia, anh, mia]) w.visit(s, w.A);
  assert.equal((await w.t.as(leo).put('/api/notes/goals/today', { goals: [
    { subject: 'math', text: 'Review for my next quiz' }, { subject: 'art', text: 'Plan my next portfolio piece' }] })).status, 200);
  assert.equal((await w.t.as(sofia).post('/api/notes/goals/today/skip')).status, 200);
  const tab = notesTab(w.t);
  await tab.signIn(w.staffA);
  const view = await tab.open('daily-notes');
  const goalsOf = s => noteCard(tab, s).card().find(n => n.cls.includes('note-goals'));
  const order = s => noteCard(tab, s).card().childNodes.map(n => n.cls.find(c => ['note-head', 'note-goals', 'note-rates', 'note-summary'].includes(c))).filter(Boolean);

  assert.equal(words(goalsOf(leo)), 'Goals Math , Review for my next quiz Art , Plan my next portfolio piece');
  // Read aloud (and as text), the subject and the goal stay apart.
  assert.deepEqual(goalsOf(leo).findAll(n => n.tag === 'li').map(li => li.textContent), ['Math, Review for my next quiz', 'Art, Plan my next portfolio piece']);
  assert.deepEqual(goalsOf(leo).findAll(n => n.tag === 'li').map(li => li.find(n => n.cls.includes('badge')).textContent), ['Math', 'Art']);
  assert.equal(words(goalsOf(sofia)), 'Goals Skipped goals');
  assert.equal(words(goalsOf(anh)), 'Goals No goals set');
  assert.deepEqual(order(leo), ['note-head', 'note-goals', 'note-rates']);
  assert.ok(view.find(n => n.tag === 'p' && n.textContent === 'Goals: 1 set · 1 skipped · 2 not answered'));

  const c = noteCard(tab, leo);
  assert.equal(c.comment().getAttribute('placeholder'), "How did today's goals go?");
  const label = view.find(n => n.tag === 'label' && n.getAttribute('for') === 'dn-c-' + leo.id);
  assert.equal(words(label), "Comment (optional) · reply to today's goals or anything else");

  // A posted note's summary keeps the goals in the same place.
  for (const l of PRD_ITEMS) await c.tap(l, 'Great');
  c.type('Nice work on the quiz review.');
  await tab.click(c.button('Post note'));
  assert.deepEqual(order(leo), ['note-head', 'note-goals', 'note-summary']);
  assert.equal(words(goalsOf(leo)), 'Goals Math , Review for my next quiz Art , Plan my next portfolio piece');
});

test(['DG-2', 'DN-5'], "a parent's note and Home card show the student's goals above the ratings when they were set, and nothing for a skipped day", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  w.visit(leo, w.A); w.visit(sofia, w.A);
  assert.equal((await w.t.as(leo).put('/api/notes/goals/today', { goals: [{ subject: 'science', text: 'Finish my lab write-up' }] })).status, 200);
  assert.equal((await w.t.as(sofia).post('/api/notes/goals/today/skip')).status, 200);
  for (const s of [leo, sofia]) assert.equal((await w.save(w.staffA, s, TODAY, { ratings: w.all(3), post: true })).status, 200);
  const tab = notesTab(w.t);
  await tab.signIn(w.fa.parent);

  const notes = await tab.open('notes');
  const cards = notes.findAll(n => n.tag === 'article');
  const nameOf = a => a.childNodes[0].find(n => n.cls.includes('badge-accent')).textContent;
  const leoCard = cards.find(a => nameOf(a) === 'Leo'), sofiaCard = cards.find(a => nameOf(a) === 'Sofia');
  const goals = leoCard.find(n => n.cls.includes('note-goals'));
  assert.equal(words(goals), "Leo's goals today Science , Finish my lab write-up");
  assert.equal(goals.find(n => n.tag === 'h3').textContent, "Leo's goals today");
  const kids = leoCard.childNodes;
  assert.ok(kids.indexOf(goals) < kids.findIndex(n => n.tag === 'ul' && n.cls.includes('list')), 'the goals come before the ratings');
  assert.equal(sofiaCard.find(n => n.cls.includes('note-goals')), undefined, 'a skipped day shows nothing');

  const home = await tab.card('notes-today');
  const lis = home.findAll(n => n.tag === 'li' && n.parentNode.cls.includes('list'));
  const leoLi = lis.find(li => li.find(n => n.tag === 'strong').textContent === 'Leo Garcia');
  assert.equal(words(leoLi.find(n => n.cls.includes('note-goals'))), "Leo's goals today Science , Finish my lab write-up");
  const grow = leoLi.find(n => n.cls.includes('grow')).childNodes;
  assert.ok(grow.findIndex(n => n.cls.includes('note-goals')) < grow.findIndex(n => n.cls.includes('note-summary')));
  assert.equal(lis.find(li => li.find(n => n.tag === 'strong').textContent === 'Sofia Garcia').find(n => n.cls.includes('note-goals')), undefined);
});

test(['DG-1', 'DG-2', 'NF-7'], "a student's Today's goals screen: subject, example chips, up to three goals, save or skip", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  const tab = notesTab(w.t);
  await tab.signIn(leo);
  const button = (box, label) => box.find(n => n.tag === 'button' && n.textContent === label);
  const blocks = box => box.findAll(n => n.tag === 'fieldset');

  // Before checking in: the message and no form.
  let view = await tab.open('goals');
  assert.match(words(view), /Check in first, then set today's goals\./);
  assert.equal(view.find(n => n.tag === 'select' || n.tag === 'textarea'), undefined);
  assert.equal(button(view, 'Save goals'), undefined);

  w.visit(leo, w.A);
  view = await tab.open('goals');
  assert.equal(blocks(view).length, 1);
  assert.equal(blocks(view)[0].find(n => n.tag === 'legend').textContent, 'Goal 1');
  const subject = byId(view, 'goal-1-subject');
  assert.equal(view.find(n => n.tag === 'label' && n.getAttribute('for') === 'goal-1-subject').childNodes[0].textContent, 'Subject');
  assert.equal(view.find(n => n.tag === 'label' && n.getAttribute('for') === 'goal-1-text').textContent, 'What are you working on?');
  assert.deepEqual(subject.findAll(n => n.tag === 'option').map(o => o.textContent), ['Choose a subject', ...SUBJECTS.map(s => s[1])]);
  assert.ok(button(view, 'Skip today') && button(view, 'Save goals') && button(view, 'Add another goal'));
  assert.equal(button(view, 'Remove'), undefined, "one goal can't be removed");
  assert.equal(view.find(n => n.cls.includes('goal-examples')), undefined, 'examples follow the subject');

  // Choosing Science offers its three examples; tapping one fills the text, which stays editable.
  subject.value = 'science'; subject.dispatch('change');
  const chips = view.find(n => n.cls.includes('goal-examples'));
  assert.equal(chips.getAttribute('role'), 'group');
  assert.deepEqual(chips.findAll(n => n.tag === 'button').map(b => b.textContent),
    ['Finish my lab write-up', "Study this chapter's vocabulary", 'Watch the lesson video and answer the review questions']);
  await tab.click(button(chips, 'Finish my lab write-up'));
  const text = byId(view, 'goal-1-text');
  assert.equal(text.value, 'Finish my lab write-up');
  assert.equal(text.getAttribute('maxlength'), '280');
  assert.equal(byId(view, 'goal-1-count').textContent, '22 of 280 characters');
  assert.equal(text.getAttribute('aria-describedby'), 'goal-1-count');
  text.value = 'Finish my lab write-up and the graph'; text.dispatch('input');
  assert.equal(byId(view, 'goal-1-count').textContent, '36 of 280 characters');

  // Up to three goals.
  await tab.click(button(view, 'Add another goal'));
  assert.equal(blocks(view).length, 2);
  await tab.click(button(view, 'Add another goal'));
  assert.equal(blocks(view).length, 3);
  assert.equal(button(view, 'Add another goal'), undefined);
  assert.match(words(view), /That makes 3 goals, the most for one day\./);
  assert.deepEqual(view.findAll(n => n.tag === 'button' && n.textContent === 'Remove').map(b => b.getAttribute('aria-label')), ['Remove goal 1', 'Remove goal 2', 'Remove goal 3']);
  const second = byId(view, 'goal-2-subject');
  second.value = 'math'; second.dispatch('change');
  const t2 = byId(view, 'goal-2-text');
  t2.value = 'Quiz review'; t2.dispatch('input');
  await tab.click(view.find(n => n.getAttribute('aria-label') === 'Remove goal 3'));
  assert.equal(blocks(view).length, 2);
  assert.ok(button(view, 'Add another goal'));
  assert.equal(byId(view, 'goal-1-text').value, 'Finish my lab write-up and the graph', 'the goals kept are the ones not removed');
  assert.equal(byId(view, 'goal-2-text').value, 'Quiz review');

  await tab.click(button(view, 'Save goals'));
  assert.deepEqual(goalRows(w, leo), [[TODAY, 1, 'science', 'Finish my lab write-up and the graph'], [TODAY, 2, 'math', 'Quiz review']]);
  assert.deepEqual(lastToast(tab), ["Saved today's goals.", false]);
  assert.equal(tab.hash(), '#/home');

  // Opening it again edits the goals set; Skip is gone once they are set.
  view = await tab.open('goals');
  assert.equal(blocks(view).length, 2);
  assert.equal(byId(view, 'goal-2-subject').find(o => o.getAttribute('selected') !== null).textContent, 'Math');
  assert.equal(button(view, 'Skip today'), undefined);
  await tab.click(view.find(n => n.getAttribute('aria-label') === 'Remove goal 1'));
  assert.equal(byId(view, 'goal-1-text').value, 'Quiz review');
  await tab.click(button(view, 'Save goals'));
  assert.deepEqual(goalRows(w, leo), [[TODAY, 1, 'math', 'Quiz review']]);

  // Sofia skips; a goal with no subject is refused with the reason.
  w.visit(sofia, w.A);
  await tab.signIn(sofia);
  view = await tab.open('goals');
  const st = byId(view, 'goal-1-text');
  st.value = 'Something'; st.dispatch('input');
  await tab.click(button(view, 'Save goals'));
  assert.deepEqual(lastToast(tab), ['Choose a subject for goal 1.', true]);
  assert.deepEqual(goalDays(w, sofia), []);
  await tab.click(button(view, 'Skip today'));
  assert.deepEqual(goalDays(w, sofia), [[TODAY, w.A.id, 'skipped']]);
  assert.deepEqual(lastToast(tab), ['Skipped. You can still add goals from Home today.', false]);
  assert.equal(tab.hash(), '#/home');
  view = await tab.open('goals');
  assert.equal(button(view, 'Skip today'), undefined, 'a skipped day can still be set, not skipped again');
  assert.ok(button(view, 'Save goals'));
});

test(['DG-1', 'DG-2'], "a student's Home card asks for today's goals after a check-in, shows them once set, and says when the day was skipped", async () => {
  const w = await world();
  const [leo, sofia] = w.fa.students;
  const tab = notesTab(w.t);
  await tab.signIn(leo);
  const link = (box, label) => box.find(n => n.tag === 'a' && n.textContent === label);

  assert.equal((await tab.card('notes-goals')).childNodes.length, 0, 'hidden on a day without a check-in');
  w.visit(leo, w.A);
  let box = await tab.card('notes-goals');
  assert.equal(box.find(n => n.tag === 'h2').textContent, "Today's goals");
  assert.match(words(box), /What are you working on today\?/);
  assert.equal(link(box, 'Set goals').getAttribute('href'), '#/goals');
  await tab.click(box.find(n => n.tag === 'button' && n.textContent === 'Skip today'));
  assert.deepEqual(goalDays(w, leo), [[TODAY, w.A.id, 'skipped']]);
  assert.match(words(box), /You skipped goals today\./);
  assert.ok(link(box, 'Set goals'));
  assert.equal(box.find(n => n.tag === 'button' && n.textContent === 'Skip today'), undefined);
  assert.deepEqual(lastToast(tab), ["Skipped today's goals. You can still set them here today.", false]);

  w.visit(sofia, w.A);
  assert.equal((await w.t.as(sofia).put('/api/notes/goals/today', { goals: [{ subject: 'math', text: 'Review for my next quiz' }] })).status, 200);
  await tab.signIn(sofia);
  box = await tab.card('notes-goals');
  assert.equal(box.find(n => n.cls.includes('note-goal-list')).textContent, 'Math, Review for my next quiz');
  const edit = link(box, 'Edit');
  assert.deepEqual([edit.getAttribute('href'), edit.getAttribute('aria-label')], ['#/goals', "Edit today's goals"]);
  assert.doesNotMatch(words(box), /What are you working on/);
});

// ---------------------------------------------------------------- the demo seed (docs/v1.1-design.md 5.3)

test(['DG-2'], 'the notes seed shows staff all three goal states on each location\'s latest visit day, and on the latest day with three students when that one had fewer', async () => {
  const w = await world(); // Wed Oct 14: past days are before it
  const [leo, sofia] = w.fa.students, anh = w.fb.student, noah = w.fc.student;
  const arcadia = [noah, w.t.fx.family(w.B).student, w.t.fx.family(w.B).student];
  for (const s of [leo, sofia, anh]) w.visit(s, w.A, '2026-10-09');
  for (const s of [leo, sofia]) w.visit(s, w.A, TWO_DAYS_AGO); // Irvine's latest day: only two came
  for (const s of arcadia) w.visit(s, w.B, TWO_DAYS_AGO, { session: null });
  w.visit(leo, w.A, TODAY); // today is the students' to answer
  load('src/modules/notes/seed.js')(w.t.ctx, { NOW: w.t.clock.now() });
  const states = (loc, date, kids) => kids.map(s => (w.t.db.prepare('SELECT status FROM daily_goal_days WHERE student_id = ? AND local_date = ? AND location_id = ?')
    .get(s.id, date, loc.id) || { status: 'none' }).status).sort();
  assert.deepEqual(states(w.A, '2026-10-09', [leo, sofia, anh]), ['none', 'set', 'skipped']);
  assert.deepEqual(states(w.A, TWO_DAYS_AGO, [leo, sofia]), ['set', 'skipped'], 'the latest day still shows as many states as it has students');
  assert.deepEqual(states(w.B, TWO_DAYS_AGO, arcadia), ['none', 'set', 'skipped']);
  assert.deepEqual(states(w.A, TODAY, [leo]), ['none']);
  // Staff see the three on Daily notes.
  w.t.clock.set(at(LA, TODAY, '10:00'));
  const day = await w.t.as(w.staffA).get('/api/notes/day?date=2026-10-09');
  assert.deepEqual(day.body.goal_counts, { set: 1, skipped: 1, none: 1 });
});
