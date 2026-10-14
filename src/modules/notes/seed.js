'use strict';
// Demo daily notes: a posted note for most past visit days, so parents have a
// history to browse. On each location's most recent visit day some notes are
// left unwritten and one is a saved draft, so staff have something to finish.
// Parents get the "note is ready" notification for each student's latest note.

const { DateTime } = require('luxon');
const time = require('../../time');
const notify = require('../../notify');

const COMMENTS = [
  'Worked steadily through a full chapter of algebra.',
  'Great focus today. Finished the reading and started the essay outline.',
  'Took a while to settle in, then had a productive second hour.',
  'Helped another student find the library section they needed. Kind and calm all session.',
  'Spent a lot of time on the phone early on. We talked about it and the rest of the session went well.',
];

module.exports = function seed(ctx) {
  const db = ctx.db;
  const items = db.prepare('SELECT id, label, position FROM note_items WHERE active = 1 ORDER BY position, id').all();
  let n = 11;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  const rating = () => { const r = rnd(); return r < 0.1 ? 1 : r < 0.5 ? 2 : 3; };

  const days = db.prepare(`SELECT v.student_id, v.location_id, v.local_date, MAX(COALESCE(v.check_out_at, v.check_in_at)) AS last_out
    FROM visits v
    GROUP BY v.student_id, v.location_id, v.local_date ORDER BY v.local_date, v.student_id`).all();
  const staffAt = db.prepare("SELECT id, name FROM users WHERE role IN ('staff','director') AND location_id = ? AND active = 1 ORDER BY role DESC, id LIMIT 1");
  const today = new Map(db.prepare('SELECT id, timezone FROM locations').all().map(l => [l.id, time.localDate(l, Date.now())]));
  const lastDay = new Map(); // location -> its most recent past visit day
  for (const d of days) if (d.local_date < today.get(d.location_id)) lastDay.set(d.location_id, d.local_date); // days are in date order

  const insNote = db.prepare(`INSERT INTO daily_notes (student_id, location_id, local_date, status, comment, created_by, created_at, updated_at, posted_by, posted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insRating = db.prepare('INSERT INTO daily_note_ratings (note_id, item_id, label, position, rating) VALUES (?,?,?,?,?)');
  const latest = new Map(); // student -> { noteId, posted_at, ... }
  const draftLeft = new Set();
  let posted = 0;

  db.exec('BEGIN');
  for (const d of days) {
    if (d.local_date >= today.get(d.location_id)) continue; // today's notes are for staff to write
    const staff = staffAt.get(d.location_id);
    if (!staff) continue;
    const recent = d.local_date === lastDay.get(d.location_id);
    let status = 'posted';
    if (recent) {
      if (!draftLeft.has(d.location_id)) { status = 'draft'; draftLeft.add(d.location_id); }
      else if (rnd() < 0.5) continue; // not written yet
    }
    const at = d.last_out + 15 * 60000;
    const comment = rnd() < 0.35 ? COMMENTS[Math.floor(rnd() * COMMENTS.length)] : null;
    const id = Number(insNote.run(d.student_id, d.location_id, d.local_date, status, comment, staff.id, at, at,
      status === 'posted' ? staff.id : null, status === 'posted' ? at : null).lastInsertRowid);
    items.forEach((it, i) => insRating.run(id, it.id, it.label, i + 1, status === 'draft' && i > 1 ? null : rating()));
    if (status === 'posted') {
      posted++;
      latest.set(d.student_id, { id, at, date: d.local_date, location_id: d.location_id, staff });
    }
  }
  db.exec('COMMIT');

  // The "note is ready" notification for each student's most recent note.
  const name = id => db.prepare('SELECT name FROM users WHERE id = ?').get(id).name;
  const locName = id => db.prepare('SELECT name FROM locations WHERE id = ?').get(id).name;
  const fmtDay = d => DateTime.fromISO(d).toFormat('ccc, LLL d');
  for (const [studentId, x] of latest) {
    ctx.clock.set(x.at);
    notify.send(ctx, notify.parentsOf(ctx, studentId), {
      kind: 'note', refType: 'daily_note', refId: x.id,
      title: `${name(studentId).split(' ')[0]}'s daily note from ${locName(x.location_id)} is ready`,
      body: `${fmtDay(x.date)} · posted by ${x.staff.name}. Open Notes to read it.`,
    });
  }
  ctx.clock.set(null);
  console.log(`  notes: ${posted} posted daily notes, ${draftLeft.size} drafts`);
};
