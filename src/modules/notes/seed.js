'use strict';
// Demo daily notes and weekly top 3 goals.
// Goals (D-57), last week and this week, only on days the student visited their home location
// before today (today's are the students' to answer): at the first visit of each week the student
// sets 3 goals in 3 different subjects, and at each later visit that week answers each open goal
// in turn Yes, Yes, Done, Yes, Change, ... so staff and parents see a mix. Done and Change bring
// the next goal (another subject than the other two open ones). When two or more students visited
// this week, the last of them by name has no goals this week, so staff see "No goals this week".
// Every text is written to the high-school standard: specific and finishable.
// Notes: a posted note for most past visit days, so parents have a history to
// browse; some comments answer the day's goals (D-51). On each location's most
// recent visit day some notes are left unwritten and one is a saved draft, so staff
// have something to finish. Parents get the "note is ready" notification for each
// student's latest note.

const { DateTime } = require('luxon');
const time = require('../../time');
const notify = require('../../notify');
const goals = require('./goals');
const week = require('./week');

const COMMENTS = [
  'Worked steadily through a full chapter of algebra.',
  'Great focus today. Finished the reading and started the essay outline.',
  'Took a while to settle in, then had a productive second hour.',
  'Helped another student find the library section they needed. Kind and calm all session.',
  'Spent a lot of time on the phone early on. We talked about it and the rest of the session went well.',
];
// Replies to the day's first goal, in the note's comment (D-51).
const REPLIES = [
  g => `Nice work on your ${g.subject_label} goal today: "${g.text}"`,
  g => `Good progress on "${g.text}" Keep going tomorrow.`,
  g => `You stuck with your ${g.subject_label} goal all session. Show me the finished work on Friday.`,
];
// Goal texts per subject: the examples students see, then a few more of the same standard.
const MORE = {
  math: ['Finish the Unit 2 review packet and correct every problem I got wrong.', 'Watch the lesson on quadratic equations and do problems 1 to 20.'],
  english: ['Revise my essay with the feedback from my teacher and fix the citations.'],
  science: ['Read Chapter 7 on cell division and take notes on each section.'],
  history: ['Write the two-page response on the causes of World War I and proofread it.'],
  language: ['Practice the Lesson 7 dialogue out loud and record myself reading it.'],
  art: ['Finish the color study for my landscape painting and photograph it for my portfolio.'],
  test_prep: ['Take the ACT reading practice test and go over every passage I missed.'],
  other: ['Plan every assignment for next week in my planner and email my mentor the list.'],
};
const TEXTS = new Map(goals.SUBJECTS.map(s => [s.id, [...s.examples, ...MORE[s.id]]]));
const SUBJECT_IDS = goals.SUBJECTS.map(s => s.id);
const CYCLE = ['yes', 'yes', 'done', 'yes', 'change'];

// Goals for last week and this week. Returns a tally for the log line.
function seedGoals(ctx, now) {
  const db = ctx.db;
  const days = db.prepare(`SELECT v.student_id, v.location_id, v.local_date, MIN(v.check_in_at) AS first_in, u.name, l.timezone
    FROM visits v JOIN users u ON u.id = v.student_id AND u.location_id = v.location_id JOIN locations l ON l.id = v.location_id
    GROUP BY v.student_id, v.local_date ORDER BY u.name, v.student_id, v.local_date`).all();
  const insWeek = db.prepare('INSERT INTO goal_weeks (student_id, location_id, week_start, created_at, updated_at) VALUES (?,?,?,?,?)');
  const insGoal = db.prepare("INSERT INTO week_goals (week_id, position, subject, text, status, created_on, created_at) VALUES (?,?,?,?,'open',?,?)");
  const close = db.prepare('UPDATE week_goals SET status = ?, done_on = ?, replaced_on = ?, replaced_by = ? WHERE id = ?');
  const insCheck = db.prepare('INSERT INTO goal_checks (goal_id, date, answer, answered_at) VALUES (?,?,?,?)');
  const touch = db.prepare('UPDATE goal_weeks SET updated_at = ? WHERE id = ?');
  const tally = { weeks: 0, yes: 0, done: 0, change: 0 };

  // student -> week_start -> [days], keeping only last week and this week, before today.
  const byStudent = new Map();
  for (const d of days) {
    const today = time.localDate({ timezone: d.timezone }, now), thisWeek = time.weekStart(today);
    const ws = time.weekStart(d.local_date);
    if (d.local_date >= today || (ws !== thisWeek && ws !== time.addDays(thisWeek, -7))) continue;
    if (!byStudent.has(d.student_id)) byStudent.set(d.student_id, { name: d.name, thisWeek, weeks: new Map() });
    const s = byStudent.get(d.student_id);
    if (!s.weeks.has(ws)) s.weeks.set(ws, []);
    s.weeks.get(ws).push(d);
  }
  const thisWeekers = [...byStudent.values()].filter(s => s.weeks.has(s.thisWeek)).map(s => s.name).sort();
  const noGoals = thisWeekers.length >= 2 ? thisWeekers[thisWeekers.length - 1] : null;

  let turn = 0, pick = 0;
  const nextText = subject => { const list = TEXTS.get(subject); return list[pick++ % list.length]; };
  [...byStudent.values()].forEach((s, k) => {
    for (const [ws, list] of s.weeks) {
      if (ws === s.thisWeek && s.name === noGoals) continue;
      const first = list[0], at = first.first_in + 5 * 60000;
      const weekId = Number(insWeek.run(first.student_id, first.location_id, ws, at, at).lastInsertRowid);
      tally.weeks++;
      // Three subjects, starting at a different one for each student.
      const open = [0, 1, 2].map(i => {
        const subject = SUBJECT_IDS[(k * 3 + i) % SUBJECT_IDS.length];
        const id = Number(insGoal.run(weekId, i + 1, subject, nextText(subject), first.local_date, at).lastInsertRowid);
        return { id, position: i + 1, subject };
      });
      for (const d of list.slice(1)) {
        const when = d.first_in + 4 * 60000;
        open.forEach((g, i) => {
          const answer = CYCLE[turn++ % CYCLE.length];
          tally[answer]++;
          insCheck.run(g.id, d.local_date, answer, when);
          if (answer === 'yes') return;
          const others = open.filter(x => x !== g).map(x => x.subject);
          const start = SUBJECT_IDS.indexOf(g.subject) + (answer === 'done' ? 0 : 1);
          const subject = [...Array(SUBJECT_IDS.length).keys()].map(n => SUBJECT_IDS[(start + n) % SUBJECT_IDS.length]).find(x => !others.includes(x));
          const id = Number(insGoal.run(weekId, g.position, subject, nextText(subject), d.local_date, when).lastInsertRowid);
          close.run(answer === 'done' ? 'done' : 'replaced', answer === 'done' ? d.local_date : null, answer === 'done' ? null : d.local_date, id, g.id);
          open[i] = { id, position: g.position, subject };
        });
        touch.run(when, weekId);
      }
    }
  });
  return tally;
}

module.exports = function seed(ctx, demo = {}) {
  const db = ctx.db;
  const NOW = demo.NOW || Date.now();
  const items = db.prepare('SELECT id, label, position FROM note_items WHERE active = 1 ORDER BY position, id').all();
  let n = 11;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  const rating = () => { const r = rnd(); return r < 0.1 ? 1 : r < 0.5 ? 2 : 3; };

  const days = db.prepare(`SELECT v.student_id, v.location_id, v.local_date, MIN(v.check_in_at) AS first_in,
      MAX(COALESCE(v.check_out_at, v.check_in_at)) AS last_out, u.name
    FROM visits v JOIN users u ON u.id = v.student_id
    GROUP BY v.student_id, v.location_id, v.local_date ORDER BY v.local_date, u.name, v.student_id`).all();
  const staffAt = db.prepare("SELECT id, name FROM users WHERE role IN ('staff','director') AND location_id = ? AND active = 1 ORDER BY role DESC, id LIMIT 1");
  const today = new Map(db.prepare('SELECT id, timezone FROM locations').all().map(l => [l.id, time.localDate(l, NOW)]));
  const lastDay = new Map(); // location -> its most recent past visit day
  for (const d of days) if (d.local_date < today.get(d.location_id)) lastDay.set(d.location_id, d.local_date); // days are in date order

  const insNote = db.prepare(`INSERT INTO daily_notes (student_id, location_id, local_date, status, comment, created_by, created_at, updated_at, posted_by, posted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insRating = db.prepare('INSERT INTO daily_note_ratings (note_id, item_id, label, position, rating) VALUES (?,?,?,?,?)');
  const latest = new Map(); // student -> { noteId, posted_at, ... }
  const draftLeft = new Set();
  let posted = 0;

  db.exec('BEGIN');
  const tally = seedGoals(ctx, NOW);
  for (const d of days) {
    if (d.local_date >= today.get(d.location_id)) continue; // today's notes are the staff's to write
    const recent = d.local_date === lastDay.get(d.location_id);
    const staff = staffAt.get(d.location_id);
    if (!staff) continue;
    let noteStatus = 'posted';
    if (recent) {
      if (!draftLeft.has(d.location_id)) { noteStatus = 'draft'; draftLeft.add(d.location_id); }
      else if (rnd() < 0.5) continue; // not written yet
    }
    const at = d.last_out + 15 * 60000;
    const dayGoals = week.goalsOn(db, d.student_id, d.local_date);
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
  console.log(`  notes: ${posted} posted daily notes, ${draftLeft.size} drafts; goals: ${tally.weeks} weeks of 3, daily answers ${tally.yes} yes, ${tally.done} done, ${tally.change} changed`);
};
