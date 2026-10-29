'use strict';
// Weekly top 3 goals (S-8, D-57): reading and writing a student's week.
//
// A week is Monday to Sunday by the student's home location's date (NF-4). At their first
// check-in of the week the student sets exactly 3 goals, each a different subject. At every
// later check-in that week each open goal is asked "Still working on this?" on its own: Yes,
// Done or Change. Done and Change both need the next goal (same rules), which takes the old
// one's place, so the week always has exactly 3 open goals. One answer per goal per day;
// answering again that day replaces it. Nothing is deleted or overwritten: closed goals stay
// with their dates and replaced_by, and every answer keeps its date and time.

const time = require('../../time');
const { tx } = require('../../db');
const { bad, conflict, notFound } = require('../../errors');
const goals = require('./goals');

const ANSWERS = ['yes', 'done', 'change'];

const home = (db, studentId) => db.prepare(`SELECT l.id, l.name, l.timezone FROM users u JOIN locations l ON l.id = u.location_id
  WHERE u.id = ?`).get(studentId);
const weekOf = (db, studentId, date) => db.prepare('SELECT * FROM goal_weeks WHERE student_id = ? AND week_start = ?')
  .get(studentId, time.weekStart(date));
const shape = g => ({
  id: g.id, week_id: g.week_id, position: g.position, subject: g.subject, subject_label: goals.subjectLabel(g.subject), text: g.text,
  status: g.status, created_on: g.created_on, done_on: g.done_on, replaced_on: g.replaced_on, replaced_by: g.replaced_by,
});

// The goals of the week holding `date`, as they stood that day: each goal added by then and
// not closed before it. A goal closed that day keeps its status (done or replaced); one closed
// later reads as open. `answer` is that day's answer, or null.
function goalsOn(db, studentId, date) {
  const w = weekOf(db, studentId, date);
  if (!w) return [];
  return db.prepare(`SELECT g.*, c.answer FROM week_goals g LEFT JOIN goal_checks c ON c.goal_id = g.id AND c.date = ?
    WHERE g.week_id = ? AND g.created_on <= ? AND COALESCE(g.done_on, g.replaced_on, '9999-12-31') >= ?
    ORDER BY g.position, g.id`).all(date, w.id, date, date)
    .map(g => Object.assign(shape(g), { status: (g.done_on || g.replaced_on) === date ? g.status : 'open', answer: g.answer || null }));
}

// The week's goals at the end of `date`, for staff and parents (D-57). `goals`: the ones open then
// (normally exactly 3), with that day's answer; a goal closed on a later day reads as open.
// `earlier`: the week's goals done or changed on or before `date`, newest close first, each with
// the day it closed (`closed_on`) and the subject of the goal that took its place.
function goalsAt(db, studentId, date) {
  const w = weekOf(db, studentId, date);
  if (!w) return { goals: [], earlier: [] };
  const earlier = db.prepare(`SELECT g.*, COALESCE(g.done_on, g.replaced_on) AS closed_on, n.subject AS next_subject
    FROM week_goals g LEFT JOIN week_goals n ON n.id = g.replaced_by
    WHERE g.week_id = ? AND COALESCE(g.done_on, g.replaced_on) <= ? ORDER BY closed_on DESC, g.position, g.id`).all(w.id, date)
    .map(g => Object.assign(shape(g), { closed_on: g.closed_on, replaced_by_label: goals.subjectLabel(g.next_subject) }));
  return { goals: goalsOn(db, studentId, date).filter(g => g.status === 'open'), earlier };
}

// The signed-in student's week today. state: 'set' (no 3 goals yet), 'update' (an open goal from
// an earlier day has no answer today) or 'done'. A goal added today isn't asked about until tomorrow.
// `done` lists the week's finished goals.
function studentWeek(db, user, now) {
  const loc = home(db, user.id);
  if (!loc) throw notFound('No home location.');
  const today = time.localDate(loc, now), start = time.weekStart(today);
  const checkedIn = !!db.prepare('SELECT 1 FROM visits WHERE student_id = ? AND location_id = ? AND local_date = ?').get(user.id, loc.id, today);
  const open = goalsOn(db, user.id, today).filter(g => g.status === 'open')
    .map(g => Object.assign(g, { asks: g.created_on < today && !g.answer }));
  const state = open.length < goals.GOALS_PER_WEEK ? 'set' : open.some(g => g.asks) ? 'update' : 'done';
  // The goals finished so far this week, so the student sees what they got done.
  const w = weekOf(db, user.id, today);
  const done = w ? db.prepare("SELECT * FROM week_goals WHERE week_id = ? AND status = 'done' ORDER BY done_on, position, id").all(w.id).map(shape) : [];
  return { loc, body: { today, week_start: start, week_end: time.addDays(start, 6), checked_in: checkedIn, state, goals: open, done } };
}

const noVisit = () => bad('no_visit_today', 'Check in first, then set your goals.');

// Sets the week's 3 goals. Only while the week has none: after that a goal changes through Change.
function setWeek(ctx, user, body) {
  const db = ctx.db;
  const { loc, body: wk } = studentWeek(db, user, ctx.clock.now());
  if (!wk.checked_in) throw noVisit();
  if (wk.state !== 'set') throw conflict('already_set', "You already set this week's goals. Tap Change on a goal to swap it.");
  const list = goals.readWeek(body.goals);
  const now = ctx.clock.now();
  tx(db, () => {
    const weekId = Number(db.prepare(`INSERT INTO goal_weeks (student_id, location_id, week_start, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(user.id, loc.id, wk.week_start, now, now).lastInsertRowid);
    const put = db.prepare("INSERT INTO week_goals (week_id, position, subject, text, status, created_on, created_at) VALUES (?,?,?,?,'open',?,?)");
    list.forEach((g, i) => put.run(weekId, i + 1, g.subject, g.text, wk.today, now));
  });
}

// Today's answers: [{ goalId, answer: 'yes'|'done'|'change', subject?, text? }], each goal on its own.
// Done and Change carry the next goal. The 3 open goals must stay 3 different subjects.
function answer(ctx, user, body) {
  const db = ctx.db;
  const { body: wk } = studentWeek(db, user, ctx.clock.now());
  if (!wk.checked_in) throw noVisit();
  if (wk.state === 'set') throw conflict('not_set', 'Set your 3 goals for this week first.');
  const raw = Array.isArray(body.answers) ? body.answers : [];
  if (!raw.length) throw bad('no_answers', 'Answer Yes, Done or Change for a goal.');
  const open = new Map(wk.goals.map(g => [g.id, g]));
  const seen = new Set();
  const plan = raw.map(a => {
    const g = open.get(Number(a && a.goalId));
    if (!g) throw bad('unknown_goal', "That goal isn't one of this week's open goals. Reload and try again.");
    if (seen.has(g.id)) throw bad('twice', 'Answer each goal once.');
    seen.add(g.id);
    if (!ANSWERS.includes(a.answer)) throw bad('bad_answer', 'Answer Yes, Done or Change.');
    return { g, answer: a.answer, next: a.answer === 'yes' ? null : goals.readGoal(a, '', a.answer === 'change' ? g : null) };
  });
  const subjects = wk.goals.map(g => { const p = plan.find(x => x.g.id === g.id); return p && p.next ? p.next.subject : g.subject; });
  if (new Set(subjects).size !== subjects.length) throw bad('same_subject', goals.SAME_SUBJECT);
  const now = ctx.clock.now(), today = wk.today;
  tx(db, () => {
    const check = db.prepare(`INSERT INTO goal_checks (goal_id, date, answer, answered_at) VALUES (?,?,?,?)
      ON CONFLICT(goal_id, date) DO UPDATE SET answer = excluded.answer, answered_at = excluded.answered_at`);
    const add = db.prepare("INSERT INTO week_goals (week_id, position, subject, text, status, created_on, created_at) VALUES (?,?,?,?,'open',?,?)");
    for (const p of plan) {
      check.run(p.g.id, today, p.answer, now);
      if (!p.next) continue;
      const nextId = Number(add.run(p.g.week_id, p.g.position, p.next.subject, p.next.text, today, now).lastInsertRowid);
      if (p.answer === 'done') db.prepare("UPDATE week_goals SET status = 'done', done_on = ?, replaced_by = ? WHERE id = ?").run(today, nextId, p.g.id);
      else db.prepare("UPDATE week_goals SET status = 'replaced', replaced_on = ?, replaced_by = ? WHERE id = ?").run(today, nextId, p.g.id);
    }
    db.prepare('UPDATE goal_weeks SET updated_at = ? WHERE id = ?').run(now, plan[0].g.week_id);
  });
}

// A student's current week for a parent or staff (read-only): every goal of the week with its
// dates, and every daily answer, newest day first.
function history(db, student, now) {
  const loc = home(db, student.id);
  if (!loc) throw notFound('No home location.');
  const today = time.localDate(loc, now), start = time.weekStart(today);
  const w = weekOf(db, student.id, today);
  const list = w ? db.prepare('SELECT * FROM week_goals WHERE week_id = ? ORDER BY position, id').all(w.id).map(shape) : [];
  const checks = w ? db.prepare(`SELECT c.goal_id, c.date, c.answer, c.answered_at FROM goal_checks c JOIN week_goals g ON g.id = c.goal_id
    WHERE g.week_id = ? ORDER BY c.date DESC, g.position, g.id`).all(w.id) : [];
  return { student: { id: student.id, name: student.name }, timezone: loc.timezone, today, week_start: start, week_end: time.addDays(start, 6),
    goals: list, checks };
}

module.exports = { goalsOn, goalsAt, studentWeek, setWeek, answer, history };
