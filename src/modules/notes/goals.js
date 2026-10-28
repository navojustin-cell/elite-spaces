'use strict';
// Daily goals (S-8, D-50): the subject list, the example goals and the validation.
// Fixed in code: HQ can't edit them in v1.1. The ids match the CHECK in
// schema/070_notes.sql (daily_goals.subject).

const { bad } = require('../../errors');

const MAX_GOALS = 3;
const TEXT_MAX = 280;

const SUBJECTS = [
  { id: 'math', label: 'Math', examples: ['Finish the practice set for my current lesson', 'Review for my next quiz', 'Take notes on the new lesson video'] },
  { id: 'english', label: 'English', examples: ['Write the first draft of my essay', 'Read the next two chapters and note the main themes', 'Revise a paragraph for grammar'] },
  { id: 'science', label: 'Science', examples: ['Finish my lab write-up', "Study this chapter's vocabulary", 'Watch the lesson video and answer the review questions'] },
  { id: 'history', label: 'History', examples: ['Read the next section and write a summary', "Make a timeline of the events I'm studying", 'Prepare notes for my essay'] },
  { id: 'language', label: 'Language', examples: ['Practice 20 vocabulary flashcards', 'Finish the next unit in my course', 'Write five sentences using new grammar'] },
  { id: 'art', label: 'Art', examples: ['Sketch three studies for my project', 'Finish shading my current piece', 'Plan my next portfolio piece'] },
  { id: 'test_prep', label: 'Test prep', examples: ['Do one timed practice section', 'Review the questions I missed last time', 'Learn five new test vocabulary words'] },
  { id: 'other', label: 'Other', examples: ['Plan my assignments for the week', 'Work on my project', 'Catch up on work I missed'] },
];
const LABELS = new Map(SUBJECTS.map(s => [s.id, s.label]));
const subjectLabel = id => LABELS.get(id) || id;

// The body's goals, checked and trimmed: [{ subject, text }], 1-3 of them.
function validate(raw) {
  const goals = Array.isArray(raw) ? raw : [];
  if (!goals.length) throw bad('no_goals', 'Add at least one goal, or skip today.');
  if (goals.length > MAX_GOALS) throw bad('too_many_goals', `Set up to ${MAX_GOALS} goals for today.`);
  return goals.map((g, i) => {
    const subject = g && typeof g.subject === 'string' ? g.subject : '';
    if (!LABELS.has(subject)) throw bad('bad_subject', `Choose a subject for goal ${i + 1}.`);
    const text = g && typeof g.text === 'string' ? g.text.trim() : '';
    if (!text) throw bad('goal_text', `Write what you're working on for goal ${i + 1}.`);
    if (text.length > TEXT_MAX) throw bad('goal_text', `Keep goal ${i + 1} to ${TEXT_MAX} characters or fewer.`);
    return { subject, text };
  });
}

module.exports = { SUBJECTS, MAX_GOALS, TEXT_MAX, subjectLabel, validate };
