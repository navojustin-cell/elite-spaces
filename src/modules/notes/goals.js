'use strict';
// Weekly top 3 goals (S-8, D-57): the subject list, the example goals and the checks.
// Fixed in code: HQ can't edit them. The ids match the CHECK in
// schema/070_notes.sql (week_goals.subject).
//
// checkGoalText is the one place goal text is judged. Every route that takes goal text
// (setting the week, a Change, the next goal after Done, the step check) goes through it,
// so a later AI goal coach can replace or wrap it and its message shows in the same place.

const { bad } = require('../../errors');

const GOALS_PER_WEEK = 3;
const TEXT_MAX = 500;
const MIN_WORDS = 6;
const MAX_SENTENCES = 3;
// Shown above the examples, and the refusal for a goal that is too short (D-57).
const TIP = "Say what you'll finish: the chapter, the assignment or the problems.";
const SAME_SUBJECT = 'Pick a different subject for each goal. Doing more than one thing in a subject? Put it all in that goal.';

// Each example models a good goal for a high schooler: specific, and something they can finish this week.
const SUBJECTS = [
  { id: 'math', label: 'Math', examples: ['Finish the Chapter 5 practice problems and check my answers with the key.',
    'Redo the quiz problems I missed and write down what I got wrong.'] },
  { id: 'english', label: 'English', examples: ['Read chapters 6 to 8 of my novel and write a paragraph on each.',
    'Write the full first draft of my essay, from the introduction to the conclusion.'] },
  { id: 'science', label: 'Science', examples: ["Finish the lab report for this week's experiment, with the data table and graph.",
    'Make flashcards for the Chapter 4 vocabulary and learn every one of them.'] },
  { id: 'history', label: 'History', examples: ['Read Unit 3 and answer all of the review questions at the end.',
    'Finish the outline and source list for my research paper.'] },
  { id: 'language', label: 'Language', examples: ['Finish Unit 4 in my Spanish course and pass the unit quiz.',
    'Learn the 25 vocabulary words for Lesson 6 and quiz myself twice.'] },
  { id: 'art', label: 'Art', examples: ['Finish the shading on my still-life drawing for my portfolio.',
    'Sketch three thumbnail ideas for my next portfolio piece.'] },
  { id: 'test_prep', label: 'Test prep', examples: ['Do one full timed SAT math section and review every question I missed.'] },
  { id: 'other', label: 'Other', examples: ['Finish the draft of my college application essay and send it to my mentor.'] },
];
const LABELS = new Map(SUBJECTS.map(s => [s.id, s.label]));
const subjectLabel = id => LABELS.get(id) || id;
const words = text => text.split(/\s+/).filter(Boolean).length;
// "Finish my essay draft. Study for Friday's vocab test." is 2; "3.5" or "Ch.5" doesn't end one.
const sentences = text => text.split(/[.!?]+(?=\s|$)/).filter(s => s.trim()).length;

// Judges one goal's text: { ok, message }. `subject` is for a future coach; today's rules don't use it.
function checkGoalText(text, { subject } = {}) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (words(t) < MIN_WORDS) return { ok: false, message: TIP };
  if (sentences(t) > MAX_SENTENCES) return { ok: false, message: `Keep it to ${MAX_SENTENCES} sentences or fewer.` };
  if (t.length > TEXT_MAX) return { ok: false, message: `Keep it to ${TEXT_MAX} characters or fewer.` };
  return { ok: true, message: '' };
}

// One goal from a body, checked and trimmed: { subject, text }. `prefix` names it in a list ("Goal 2: ").
function readGoal(g, prefix = '') {
  const subject = g && typeof g.subject === 'string' ? g.subject : '';
  if (!LABELS.has(subject)) throw bad('bad_subject', prefix + 'Pick a subject.');
  const text = g && typeof g.text === 'string' ? g.text.trim() : '';
  const check = checkGoalText(text, { subject });
  if (!check.ok) throw bad('goal_text', prefix + check.message);
  return { subject, text };
}

// The week's goals from the body: exactly 3, each checked, each a different subject.
function readWeek(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length !== GOALS_PER_WEEK) throw bad('three_goals', `Set ${GOALS_PER_WEEK} goals for this week.`);
  const out = list.map((g, i) => readGoal(g, `Goal ${i + 1}: `));
  out.forEach((g, i) => {
    if (out.findIndex(x => x.subject === g.subject) !== i) throw bad('same_subject', `Goal ${i + 1}: ${SAME_SUBJECT}`);
  });
  return out;
}

module.exports = { SUBJECTS, GOALS_PER_WEEK, TEXT_MAX, MAX_SENTENCES, TIP, SAME_SUBJECT, subjectLabel, checkGoalText, readGoal, readWeek };
