'use strict';
// Demo daily notes and daily goals.
// Goals (D-50): about 70% of past visit days have 1-3 goals (subjects and texts from
// goals.js examples), about 15% are skipped, and the rest unanswered. On each
// location's most recent visit day the students there are set, skipped and
// unanswered in turn, so staff see all three. That needs three students: when the
// most recent day had fewer, the most recent day that had three or more is handed
// the three in turn as well.
// Notes: a posted note for most past visit days, so parents have a history to
// browse; some comments answer the day's goals (D-51). On each location's most
// recent visit day some notes are left unwritten and one is a saved draft, so staff
// have something to finish. Parents get the "note is ready" notification for each
// student's latest note.

const { DateTime } = require('luxon');
const time = require('../../time');
const notify = require('../../notify');
const goals = require('./goals');

const COMMENTS = [
  'Worked steadily through a full chapter of algebra.',
  'Great focus today. Finished the reading and started the essay outline.',
  'Took a while to settle in, then had a productive second hour.',
  'Helped another student find the library section they needed. Kind and calm all session.',
  'Spent a lot of time on the phone early on. We talked about it and the rest of the session went well.',
];
// Replies to the day's first goal, in the note's comment (D-51).
const REPLIES = [
  g => `Nice work on "${g.text}" today.`,
  g => `Good progress on "${g.text}". Keep going tomorrow.`,
  g => `You stuck with your ${g.label} goal ("${g.text}") all session.`,
];

module.exports = function seed(ctx, demo = {}) {
  const db = ctx.db;
  const items = db.prepare('SELECT id, label, position FROM note_items WHERE active = 1 ORDER BY position, id').all();
  let n = 11;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  const rating = () => { const r = rnd(); return r < 0.1 ? 1 : r < 0.5 ? 2 : 3; };

  const days = db.prepare(`SELECT v.student_id, v.location_id, v.local_date, MIN(v.check_in_at) AS first_in,
      MAX(COALESCE(v.check_out_at, v.check_in_at)) AS last_out, u.name
    FROM visits v JOIN users u ON u.id = v.student_id
    GROUP BY v.student_id, v.location_id, v.local_date ORDER BY v.local_date, u.name, v.student_id`).all();
  const staffAt = db.prepare("SELECT id, name FROM users WHERE role IN ('staff','director') AND location_id = ? AND active = 1 ORDER BY role DESC, id LIMIT 1");
  const today = new Map(db.prepare('SELECT id, timezone FROM locations').all().map(l => [l.id, time.localDate(l, demo.NOW || Date.now())]));
  const lastDay = new Map(); // location -> its most recent past visit day
  const visitors = new Map(); // 'location|date' -> how many students came
  for (const d of days) {
    if (d.local_date >= today.get(d.location_id)) continue;
    lastDay.set(d.location_id, d.local_date); // days are in date order
    const k = d.location_id + '|' + d.local_date;
    visitors.set(k, (visitors.get(k) || 0) + 1);
  }
  const goalDay = new Map(lastDay); // location -> the day that shows all three goal states
  for (const [k, n] of visitors) if (n >= 3) goalDay.set(Number(k.split('|')[0]), k.split('|')[1]); // in date order: the latest wins

  const insDay = db.prepare('INSERT INTO daily_goal_days (student_id, local_date, location_id, status, updated_at) VALUES (?,?,?,?,?)');
  const insGoal = db.prepare('INSERT INTO daily_goals (student_id, local_date, position, subject, text) VALUES (?,?,?,?,?)');
  const insNote = db.prepare(`INSERT INTO daily_notes (student_id, location_id, local_date, status, comment, created_by, created_at, updated_at, posted_by, posted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insRating = db.prepare('INSERT INTO daily_note_ratings (note_id, item_id, label, position, rating) VALUES (?,?,?,?,?)');
  const latest = new Map(); // student -> { noteId, posted_at, ... }
  const draftLeft = new Set();
  const turns = new Map(); // 'location|date' -> how many students that day has handed a goal status
  const tally = { set: 0, skipped: 0, none: 0 };
  let posted = 0;

  db.exec('BEGIN');
  for (const d of days) {
    if (d.local_date >= today.get(d.location_id)) continue; // today's goals and notes are the students' and staff's to write
    const recent = d.local_date === lastDay.get(d.location_id);

    // ---- the day's goals, set a few minutes after the first check-in
    let status;
    if (recent || d.local_date === goalDay.get(d.location_id)) {
      const k = d.location_id + '|' + d.local_date;
      const turn = turns.get(k) || 0;
      turns.set(k, turn + 1);
      status = ['set', 'skipped', 'none'][turn % 3];
    } else {
      const r = rnd();
      status = r < 0.7 ? 'set' : r < 0.85 ? 'skipped' : 'none';
    }
    tally[status]++;
    const dayGoals = [];
    if (status !== 'none') {
      insDay.run(d.student_id, d.local_date, d.location_id, status, d.first_in + 5 * 60000);
      if (status === 'set') {
        const count = 1 + Math.floor(rnd() * 3);
        const used = new Set();
        while (dayGoals.length < count) {
          const s = goals.SUBJECTS[Math.floor(rnd() * goals.SUBJECTS.length)];
          if (used.has(s.id)) continue;
          used.add(s.id);
          dayGoals.push({ subject: s.id, label: s.label, text: s.examples[Math.floor(rnd() * 3)] });
        }
        dayGoals.forEach((g, i) => insGoal.run(d.student_id, d.local_date, i + 1, g.subject, g.text));
      }
    }

    // ---- the day's note
    const staff = staffAt.get(d.location_id);
    if (!staff) continue;
    let noteStatus = 'posted';
    if (recent) {
      if (!draftLeft.has(d.location_id)) { noteStatus = 'draft'; draftLeft.add(d.location_id); }
      else if (rnd() < 0.5) continue; // not written yet
    }
    const at = d.last_out + 15 * 60000;
    const comment = dayGoals.length && rnd() < 0.4 ? REPLIES[Math.floor(rnd() * REPLIES.length)](dayGoals[0])
      : rnd() < 0.35 ? COMMENTS[Math.floor(rnd() * COMMENTS.length)] : null;
    const id = Number(insNote.run(d.student_id, d.location_id, d.local_date, noteStatus, comment, staff.id, at, at,
      noteStatus === 'posted' ? staff.id : null, noteStatus === 'posted' ? at : null).lastInsertRowid);
    items.forEach((it, i) => insRating.run(id, it.id, it.label, i + 1, noteStatus === 'draft' && i > 1 ? null : rating()));
    if (noteStatus === 'posted') {
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
  console.log(`  notes: ${posted} posted daily notes, ${draftLeft.size} drafts; goals ${tally.set} set, ${tally.skipped} skipped, ${tally.none} unanswered`);
};
