'use strict';
// Module: notes - PRD 6. Daily notes (DN-1..DN-5).
//
// Staff rate each student who visited their location that day on HQ's
// checklist (1 Needs work, 2 Good, 3 Great - D-8) and may add a comment.
// Ratings start blank (DN-4). A note can be saved unfinished, but it can't be
// posted until every item is rated, so a blank never reaches a parent as a
// score. Posting notifies the student's active parents once; later edits
// update the note in place ("Edited") without a second notification.
// Parents browse posted notes by date. Students don't see notes in v1 (D-2).
//
// Routes, mounted at /api/notes:
//   GET   /items                       the checklist (staff and up)
//   POST  /items                       add an item (HQ)
//   PATCH /items/:id                   rename, retire or restore an item (HQ)
//   PUT   /items/order                 reorder the checklist (HQ)
//   GET   /day?location=&date=         the day's attendance list with each note (staff at that location, HQ)
//   PUT   /students/:studentId/:date   save a draft, post, or edit a posted note
//   GET   /feed?student=&from=&to=&limit=   posted notes, newest date first (parents)
//   GET   /today                       today's posted note for each linked student (parents)

const express = require('express');
const { DateTime } = require('luxon');
const auth = require('../../auth');
const notify = require('../../notify');
const audit = require('../../audit');
const time = require('../../time');
const { tx } = require('../../db');
const { bad, conflict, forbidden, notFound } = require('../../errors');

const SCALE = { 1: 'Needs work', 2: 'Good', 3: 'Great' }; // D-8
const MAX_COMMENT = 2000;
const MAX_LABEL = 80;

function checkDate(raw) {
  const d = String(raw || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !DateTime.fromISO(d).isValid) throw bad('bad_date', 'Pick a valid date.');
  return d;
}
const fmtDay = d => DateTime.fromISO(d).toFormat('ccc, LLL d');
const listWords = a => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

function cleanLabel(raw) {
  const label = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!label) throw bad('label_required', 'Give the item a name.');
  if (label.length > MAX_LABEL) throw bad('label_too_long', `Keep item names under ${MAX_LABEL} characters.`);
  return label;
}

// The checklist new notes use, in order. Retired items stay in the table
// (active = 0) so posted notes and the audit log still make sense.
const currentItems = db => db.prepare('SELECT id, label, position FROM note_items WHERE active = 1 ORDER BY position, id').all();

// A student's visits at one location on one local date, oldest first.
const visitsFor = (db, studentId, locationId, date) => db.prepare(`SELECT v.id, s.name AS session_name, v.check_in_at, v.check_out_at, v.checkout_method
  FROM visits v LEFT JOIN sessions s ON s.id = v.session_id
  WHERE v.student_id = ? AND v.location_id = ? AND v.local_date = ? ORDER BY v.check_in_at, v.id`).all(studentId, locationId, date);

const NOTE_COLS = `n.*, pb.name AS posted_by_name, eb.name AS edited_by_name
  FROM daily_notes n LEFT JOIN users pb ON pb.id = n.posted_by LEFT JOIN users eb ON eb.id = n.edited_by`;
const noteFor = (db, studentId, date) => db.prepare(`SELECT ${NOTE_COLS} WHERE n.student_id = ? AND n.local_date = ?`).get(studentId, date);
// A note as parents read it, with the student, location and zone.
const PARENT_NOTE = `SELECT n.*, pb.name AS posted_by_name, eb.name AS edited_by_name,
  u.name AS student_name, l.name AS location_name, l.timezone
  FROM daily_notes n JOIN users u ON u.id = n.student_id JOIN locations l ON l.id = n.location_id
  LEFT JOIN users pb ON pb.id = n.posted_by LEFT JOIN users eb ON eb.id = n.edited_by`;

// The ratings as saved on the note, with the labels it was written with.
const savedRatings = (db, noteId) => db.prepare(
  'SELECT item_id, label, rating FROM daily_note_ratings WHERE note_id = ? ORDER BY position, item_id').all(noteId);

// The ratings a note is filled in against. A posted note keeps the items and
// wording it was posted with (DN-2); anything not yet posted follows the
// current checklist, blank until set (DN-4).
function ratingsToEdit(db, note) {
  if (note && note.status === 'posted') return savedRatings(db, note.id);
  const saved = new Map(note ? savedRatings(db, note.id).map(r => [r.item_id, r.rating]) : []);
  return currentItems(db).map(i => ({ item_id: i.id, label: i.label, rating: saved.has(i.id) ? saved.get(i.id) : null }));
}

// One row of the staff attendance list (DN-4).
function dayEntry(db, student, loc, date) {
  const note = noteFor(db, student.id, date);
  return {
    id: student.id,
    name: student.name,
    visits: visitsFor(db, student.id, loc.id, date),
    status: note ? note.status : 'none',
    comment: note ? note.comment : null,
    ratings: ratingsToEdit(db, note),
    note: note ? { id: note.id, posted_at: note.posted_at, posted_by_name: note.posted_by_name, edited_at: note.edited_at,
      edited_by_name: note.edited_by_name, updated_at: note.updated_at } : null,
  };
}

// What a parent sees (DN-5): date, location, visits, ratings in words, comment, who posted, "Edited".
function parentNote(db, n) {
  return {
    id: n.id, student_id: n.student_id, student_name: n.student_name, local_date: n.local_date,
    location_name: n.location_name, timezone: n.timezone, comment: n.comment,
    posted_at: n.posted_at, posted_by_name: n.posted_by_name, edited_at: n.edited_at,
    ratings: savedRatings(db, n.id).map(r => ({ label: r.label, rating: r.rating, word: SCALE[r.rating] })),
    visits: visitsFor(db, n.student_id, n.location_id, n.local_date),
  };
}

module.exports = {
  router(ctx) {
    const r = express.Router();
    const db = ctx.db;

    // Staff and directors work at their own location; HQ names one.
    function locationFor(user, raw) {
      const id = Number(raw || user.location_id);
      if (!id) throw bad('location_required', 'Choose a location.');
      auth.assertManageLocation(user, id);
      const loc = db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);
      if (!loc) throw notFound('No such location.');
      return loc;
    }

    // ---------- the checklist (DN-2) ----------
    r.get('/items', auth.requireRole('staff'), (_req, res) => {
      const items = db.prepare('SELECT id, label, position, active FROM note_items ORDER BY active DESC, position, id').all();
      res.json({ items, scale: SCALE });
    });

    r.post('/items', auth.requireRole('hq'), (req, res) => {
      const label = cleanLabel((req.body || {}).label);
      const now = ctx.clock.now();
      const id = tx(db, () => {
        const next = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM note_items').get().p;
        const newId = Number(db.prepare('INSERT INTO note_items (label, position, active, updated_by, updated_at) VALUES (?,?,1,?,?)')
          .run(label, next, req.user.id, now).lastInsertRowid);
        audit.log(ctx, req.user, 'note_item.add', { targetType: 'note_item', targetId: newId, detail: { label } });
        return newId;
      });
      res.status(201).json({ item: db.prepare('SELECT id, label, position, active FROM note_items WHERE id = ?').get(id) });
    });

    r.put('/items/order', auth.requireRole('hq'), (req, res) => {
      const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number) : [];
      const all = db.prepare('SELECT id FROM note_items').all().map(x => x.id);
      if (ids.length !== all.length || new Set(ids).size !== ids.length || !all.every(id => ids.includes(id))) {
        throw bad('bad_order', 'Send every checklist item once, in the new order.');
      }
      const now = ctx.clock.now();
      tx(db, () => {
        const move = db.prepare('UPDATE note_items SET position = ?, updated_by = ?, updated_at = ? WHERE id = ?');
        ids.forEach((id, i) => move.run(i + 1, req.user.id, now, id));
        audit.log(ctx, req.user, 'note_item.reorder', { targetType: 'note_item', detail: { ids } });
      });
      res.json({ items: db.prepare('SELECT id, label, position, active FROM note_items ORDER BY active DESC, position, id').all() });
    });

    r.patch('/items/:id', auth.requireRole('hq'), (req, res) => {
      const body = req.body || {};
      const item = db.prepare('SELECT * FROM note_items WHERE id = ?').get(Number(req.params.id));
      if (!item) throw notFound('No such checklist item.');
      const label = body.label === undefined ? item.label : cleanLabel(body.label);
      const active = body.active === undefined ? item.active : (body.active ? 1 : 0);
      if (item.active && !active && db.prepare('SELECT SUM(active) AS n FROM note_items').get().n <= 1) {
        throw bad('last_item', 'Keep at least one item on the checklist.');
      }
      tx(db, () => {
        db.prepare('UPDATE note_items SET label = ?, active = ?, updated_by = ?, updated_at = ? WHERE id = ?')
          .run(label, active, req.user.id, ctx.clock.now(), item.id);
        audit.log(ctx, req.user, 'note_item.update', { targetType: 'note_item', targetId: item.id,
          detail: { before: { label: item.label, active: item.active }, after: { label, active } } });
      });
      res.json({ item: db.prepare('SELECT id, label, position, active FROM note_items WHERE id = ?').get(item.id) });
    });

    // ---------- staff: the day's attendance list (DN-1, DN-4) ----------
    r.get('/day', auth.requireRole('staff'), (req, res) => {
      const loc = locationFor(req.user, req.query.location);
      const today = time.localDate(loc, ctx.clock.now());
      const date = req.query.date ? checkDate(req.query.date) : today;
      const visited = db.prepare(`SELECT DISTINCT u.id, u.name FROM visits v JOIN users u ON u.id = v.student_id
        WHERE v.location_id = ? AND v.local_date = ? ORDER BY u.name, u.id`).all(loc.id, date);
      const students = visited.map(s => dayEntry(db, s, loc, date));
      // Notes still to post come first; the sort is stable, so names stay in order.
      students.sort((a, b) => (a.status === 'posted') - (b.status === 'posted'));
      const posted = students.filter(s => s.status === 'posted').length;
      res.json({ location: loc, date, today, items: currentItems(db), scale: SCALE, posted, total: students.length, students });
    });

    // Save a draft (post: false), post (post: true), or edit a posted note.
    // Body: { ratings: { <itemId>: 1|2|3|null }, comment, post, location_id (HQ only) }
    r.put('/students/:studentId/:date', auth.requireRole('staff'), (req, res) => {
      const body = req.body || {};
      const date = checkDate(req.params.date);
      const studentId = Number(req.params.studentId);
      auth.assertSeeStudent(ctx, req.user, studentId);
      const student = db.prepare("SELECT id, name, location_id FROM users WHERE id = ? AND role = 'student'").get(studentId);
      if (!student) throw notFound('No such student.');
      const loc = locationFor(req.user, req.user.role === 'hq' ? (body.location_id || student.location_id) : req.user.location_id);

      // DN-1: a note is only for a student who visited this location that day.
      if (!visitsFor(db, studentId, loc.id, date).length) {
        throw bad('no_visit', `${student.name} didn't check in at ${loc.name} on ${fmtDay(date)}, so there's no note to write.`);
      }
      const note = noteFor(db, studentId, date);
      if (note && note.location_id !== loc.id) throw conflict('other_location', 'This student already has a note for that day from another location.');
      const wasPosted = !!note && note.status === 'posted';

      // DN-2: each item takes 1, 2 or 3; a missing one stays blank.
      const given = body.ratings == null ? {} : body.ratings;
      if (typeof given !== 'object' || Array.isArray(given)) throw bad('bad_ratings', 'Ratings must list each checklist item.');
      const base = ratingsToEdit(db, note);
      const known = new Set(base.map(x => String(x.item_id)));
      if (Object.keys(given).some(k => !known.has(k))) throw bad('unknown_item', 'That checklist item is not on this note. Reload and try again.');
      const ratings = base.map(x => {
        const v = given[x.item_id] ?? null;
        if (v !== null && ![1, 2, 3].includes(v)) throw bad('bad_rating', `Rate ${x.label} as Needs work, Good or Great.`);
        return { item_id: x.item_id, label: x.label, rating: v };
      });

      // DN-3: the comment is optional.
      const comment = body.comment == null ? '' : String(body.comment).trim();
      if (comment.length > MAX_COMMENT) throw bad('comment_too_long', `Keep the comment under ${MAX_COMMENT} characters.`);

      // A blank never reaches a parent as a score: posting needs every item rated.
      const post = wasPosted || body.post === true;
      const missing = ratings.filter(x => x.rating == null).map(x => x.label);
      if (post && missing.length) throw bad('unrated', `Rate ${listWords(missing)} to post this note.`);

      const before = note && { comment: note.comment, ratings: savedRatings(db, note.id).map(x => ({ item_id: x.item_id, rating: x.rating })) };
      const beforeRating = new Map(before ? before.ratings.map(x => [x.item_id, x.rating]) : []);
      const changed = !note || (note.comment || '') !== comment || ratings.some(x => beforeRating.get(x.item_id) !== x.rating);
      const now = ctx.clock.now();

      const noteId = tx(db, () => {
        const id = note ? note.id : Number(db.prepare(`INSERT INTO daily_notes (student_id, location_id, local_date, status, created_by, created_at, updated_at)
          VALUES (?,?,?,'draft',?,?,?)`).run(studentId, loc.id, date, req.user.id, now, now).lastInsertRowid);
        db.prepare('UPDATE daily_notes SET comment = ?, updated_at = ? WHERE id = ?').run(comment || null, now, id);
        // Rewrite the rating rows. Labels are copied in, so a posted note keeps
        // its wording whatever HQ changes later (DN-2).
        db.prepare('DELETE FROM daily_note_ratings WHERE note_id = ?').run(id);
        const put = db.prepare('INSERT INTO daily_note_ratings (note_id, item_id, label, position, rating) VALUES (?,?,?,?,?)');
        ratings.forEach((x, i) => put.run(id, x.item_id, x.label, i + 1, x.rating));
        if (wasPosted && changed) {
          db.prepare('UPDATE daily_notes SET edited_by = ?, edited_at = ? WHERE id = ?').run(req.user.id, now, id);
          audit.log(ctx, req.user, 'note.edit', { targetType: 'daily_note', targetId: id, locationId: loc.id,
            detail: { student_id: studentId, date, before, after: { comment: comment || null, ratings: ratings.map(x => ({ item_id: x.item_id, rating: x.rating })) } } });
        } else if (post && !wasPosted) {
          db.prepare("UPDATE daily_notes SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(req.user.id, now, id);
          audit.log(ctx, req.user, 'note.post', { targetType: 'daily_note', targetId: id, locationId: loc.id, detail: { student_id: studentId, date } });
        }
        return id;
      });

      // DN-5: posting tells every active parent, once. Edits don't notify again.
      const firstPost = post && !wasPosted;
      if (firstPost) {
        notify.send(ctx, notify.parentsOf(ctx, studentId), {
          kind: 'note', refType: 'daily_note', refId: noteId,
          title: `${student.name.split(' ')[0]}'s daily note from ${loc.name} is ready`,
          body: `${fmtDay(date)} · posted by ${req.user.name}. Open Notes to read it.`,
        });
      }
      res.json({ student: dayEntry(db, student, loc, date) });
    });

    // ---------- parents: browse posted notes (DN-5). Students are refused (D-2). ----------
    r.get('/feed', auth.requireRole('parent'), (req, res) => {
      const mine = auth.linkedStudentIds(ctx, req.user.id);
      let ids = mine;
      if (req.query.student) {
        const sid = Number(req.query.student);
        if (!mine.includes(sid)) throw forbidden();
        ids = [sid];
      }
      const from = req.query.from ? checkDate(req.query.from) : '0000-01-01';
      const to = req.query.to ? checkDate(req.query.to) : '9999-12-31';
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const rows = ids.length ? db.prepare(`${PARENT_NOTE}
        WHERE n.status = 'posted' AND n.student_id IN (${ids.map(() => '?').join(',')}) AND n.local_date BETWEEN ? AND ?
        ORDER BY n.local_date DESC, u.name, n.id LIMIT ?`).all(...ids, from, to, limit + 1) : [];
      const students = mine.length ? db.prepare(`SELECT id, name FROM users WHERE id IN (${mine.map(() => '?').join(',')}) ORDER BY name, id`).all(...mine) : [];
      res.json({ students, notes: rows.slice(0, limit).map(n => parentNote(db, n)), more: rows.length > limit });
    });

    // Today (in each student's home location zone): the posted note, if any.
    r.get('/today', auth.requireRole('parent'), (req, res) => {
      const students = [];
      for (const id of auth.linkedStudentIds(ctx, req.user.id)) {
        const s = db.prepare(`SELECT u.id, u.name, l.timezone FROM users u JOIN locations l ON l.id = u.location_id WHERE u.id = ?`).get(id);
        if (!s) continue;
        const date = time.localDate(s, ctx.clock.now());
        const visited = !!db.prepare('SELECT 1 FROM visits WHERE student_id = ? AND local_date = ?').get(id, date);
        const n = db.prepare(`${PARENT_NOTE}
          WHERE n.student_id = ? AND n.local_date = ? AND n.status = 'posted'`).get(id, date);
        students.push({ id: s.id, name: s.name, date, visited, note: n ? parentNote(db, n) : null });
      }
      students.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ students });
    });

    return r;
  },
  jobs: [],
};
