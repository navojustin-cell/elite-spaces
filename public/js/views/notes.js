/* Daily notes (PRD 6, DN-1..DN-5) and weekly top 3 goals (S-8, D-57, D-51).
   Staff:    "Daily notes" - the day's attendance list; each card shows the student's goals this week with
             that day's answers, then rate each item Needs work / Good / Great, add an optional comment
             (where staff reply to the goals), Post. Unfinished notes can be saved for later.
   Parents:  "Notes" - posted notes by date for each student, with the goals as of that day.
             Home shows each student's goals this week; "See updates" (#/week-goals/<id>) lists every
             daily Yes / Done / Change. Students don't see notes in v1 (D-2).
   Students: "My goals" (#/goals, not in the nav) - after checking in: set 3 goals for the week, one step
             at a time ("Goal 1 of 3"), then each later day answer Yes / Done / Change for each goal.
   HQ:       "Note checklist" - add, rename, reorder and retire the rating items.
   Home:     parents see today's note and this week's goals; staff see how many notes are left;
             students see this week's goals. */
(function () {
  'use strict';
  const { h } = App;
  const WORDS = { 1: 'Needs work', 2: 'Good', 3: 'Great' };
  const BADGE = { 1: 'badge badge-warn', 2: 'badge', 3: 'badge badge-ok' };
  const STATUS = { none: ['Not started', 'badge'], draft: ['Saved, not posted', 'badge badge-warn'], posted: ['Posted', 'badge badge-ok'] };

  document.head.append(h('style', null, `
    .note-rate { display: grid; gap: .4rem; padding: .65rem 0; border-top: 1px solid var(--line); }
    .note-rates { margin-top: .75rem; }
    .note-rate-label { font-weight: 600; }
    .note-scale { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
    .note-scale .btn { padding: .45rem .3rem; font-size: .95rem; line-height: 1.15; white-space: normal; }
    .note-head { display: flex; gap: .75rem; align-items: flex-start; }
    .note-head h2 { margin: 0; font-size: 1.1rem; }
    .note-head .grow { flex: 1; min-width: 0; }
    .note-summary { display: flex; flex-wrap: wrap; gap: .3rem 1rem; margin: .6rem 0 0; padding: 0; list-style: none; font-size: .92rem; }
    .note-comment { margin: .6rem 0 0; padding: .6rem .8rem; background: var(--surface-2); border-radius: var(--radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
    .note-progress { display: block; width: 100%; height: 10px; margin-top: .5rem; accent-color: var(--ok); }
    .note-controls { align-items: flex-end; margin-bottom: 12px; }
    .note-controls .field { margin: 0; }
    .note-actions { margin-top: .5rem; }
    .note-hint { min-height: 3em; }
    /* The hint's longest wordings sit hidden in the same grid cell as the live text, so the
       card is as tall as the longest hint at any width and never changes height as it changes. */
    .note-hint { display: grid; grid-template-columns: minmax(0, 1fr); }
    .note-hint > span, .note-hint::before, .note-hint::after { grid-area: 1 / 1; min-width: 0; overflow-wrap: anywhere; }
    .note-hint::before { content: attr(data-fit-list); visibility: hidden; }
    .note-hint::after { content: attr(data-fit-ready); visibility: hidden; }
    .note-move { min-width: 44px; min-height: 44px; }
    .note-item-body { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .note-item-edit { display: flex; gap: .5rem; flex: 1 1 15rem; min-width: 0; }
    .note-item-edit input { flex: 1 1 6rem; min-width: 0; min-height: 44px; padding: .55rem .7rem; border-radius: var(--radius-sm);
      border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; }
    article.card:focus { outline: 3px solid var(--focus); outline-offset: 2px; }
    .note-goals { margin-top: .6rem; }
    .note-goals-label { margin: 0 0 .3rem; font-size: .9rem; font-weight: 600; }
    .note-goal-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; }
    .note-goal-list li { overflow-wrap: anywhere; }
    .note-goal-list .badge { margin-right: .4rem; }
    .note-goal-list .goal-answer { margin: 0 0 0 .4rem; }
    /* Students' goal screens: phone first, one column, 44px+ targets (NF-7). */
    .goal-label { display: block; font-weight: 600; font-size: .95rem; margin: .75rem 0 .35rem; }
    .goal-subjects { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; }
    .goal-subjects .btn, .goal-answers .btn { min-height: 48px; padding: .45rem .5rem; white-space: normal; }
    .goal-used { font-weight: 400; font-size: .8rem; }
    .goal-tip { margin: .75rem 0 0; padding: .55rem .75rem; background: var(--accent-soft); color: var(--text); border-radius: var(--radius-sm); }
    .goal-examples { display: grid; gap: .4rem; }
    .goal-examples .btn { min-height: 44px; white-space: normal; text-align: left; justify-content: flex-start; }
    .goal-editor textarea { display: block; width: 100%; min-height: 96px; padding: .55rem .7rem; border-radius: var(--radius-sm);
      border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; resize: vertical; }
    .goal-editor textarea[aria-invalid="true"] { border: 2px solid var(--danger); }
    .goal-error { color: var(--danger); font-weight: 600; margin: .35rem 0 0; }
    .goal-error:empty { display: none; }
    .goal-dots { display: flex; gap: .35rem; margin: .4rem 0 .5rem; }
    .goal-dot { flex: 1; height: 6px; border-radius: 3px; background: var(--line); }
    .goal-dot.on { background: var(--ok); }
    .goal-nav { display: grid; gap: .5rem; margin-top: 1rem; }
    .goal-text { margin: .45rem 0 .6rem; overflow-wrap: anywhere; }
    .goal-q { font-weight: 600; margin: 0 0 .4rem; }
    .goal-answers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
    .goal-form { margin-top: .85rem; padding-top: .75rem; border-top: 1px solid var(--line); }
    .goal-form h3 { margin: 0; font-size: 1.05rem; }
    .goal-same { margin: .4rem 0 0; }
    .goal-own { color: var(--text); font-weight: 600; margin: .35rem 0 0; }
    .goal-own:empty { display: none; }
    /* Focus moves to these on a new step or form; the sticky top bar must not cover them. */
    .goal-steps, .goal-form h3, #goal-done { scroll-margin-top: 84px; }
    h2:focus, h3:focus { outline: 3px solid var(--focus); outline-offset: 2px; }
    @media (min-width: 700px) {
      .note-rate { grid-template-columns: minmax(10rem, 1fr) minmax(0, 1.7fr); align-items: center; gap: 1rem; }
    }
  `));

  const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  const first = name => name.split(' ')[0];
  const listWords = a => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  const dateIn = (tz, ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const todayIn = tz => dateIn(tz, App.now());
  // The day a note was posted ("Thu, Oct 15") when that isn't the visit's own day; null when it is.
  const postedDay = (ms, tz, day) => (dateIn(tz, ms) === day ? null : App.fmtDate(ms, { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }));
  // "Afternoon Study, 1:02–3:58 PM"; a student still in the building reads "since 1:02 PM".
  const visitText = (v, tz) => (v.session_name || 'Visit') + ', ' +
    (v.check_out_at ? App.fmtTime(v.check_in_at, tz) + '–' + App.fmtTime(v.check_out_at, tz) : 'since ' + App.fmtTime(v.check_in_at, tz));
  const ratingSummary = ratings => h('ul', { class: 'note-summary' }, ratings.map(r =>
    h('li', null, r.label + ': ', h('strong', null, WORDS[r.rating] || 'Not rated'))));
  // A day's answer to "Still working on this?" (D-57), as staff and parents read it.
  const ANSWER = { yes: ['Still working on it', 'badge'], done: ['Done today', 'badge badge-ok'], change: ['Changed today', 'badge badge-warn'] };
  // Goals: a subject badge, the student's own words, then that day's answer when there is one. The
  // hidden comma and period keep them apart for screen readers ("Math, Finish ... . Done today").
  const goalList = items => h('ul', { class: 'note-goal-list' }, items.map(g =>
    h('li', null, h('span', { class: 'badge badge-accent' }, g.subject_label), h('span', { class: 'sr-only' }, ', '), g.text,
      g.answer && [h('span', { class: 'sr-only' }, '. '), h('span', { class: ANSWER[g.answer][1] + ' goal-answer' }, ANSWER[g.answer][0])])));
  // Parents see the week's goals as they stood on the note's day; a week with none shows nothing.
  const parentGoals = (name, items) => items && items.length
    ? h('div', { class: 'note-goals' }, h('h3', { class: 'note-goals-label' }, first(name) + "'s goals this week"), goalList(items))
    : null;
  // "Mon, Oct 26 – Sun, Nov 1"
  const weekText = w => App.fmtDate(w.week_start) + ' – ' + App.fmtDate(w.week_end);

  // ======================================================== staff: Daily notes
  // Unsaved edits per (location, date, student), so leaving the screen doesn't lose them.
  const unsaved = new Map();
  let hqLocation = null;

  App.register({
    id: 'daily-notes', title: 'Daily notes', icon: '📝', roles: ['staff'], order: 30,
    async render(el, params) {
      const isHq = App.role() === 'hq';
      let [date, locParam] = params;
      if (date === 'today') date = undefined; // each location's own today (L46)
      let hqLocations = [];
      if (isHq) {
        const { locations } = await App.api.get('/api/locations');
        const open = locations.filter(l => l.active);
        if (!open.length) {
          el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Daily notes'))),
            h('div', { class: 'card empty' }, 'There are no locations yet. Daily notes appear here once a location has students checking in.'));
          return;
        }
        locParam = locParam || hqLocation || String(open[0].id);
        hqLocation = locParam;
        hqLocations = open;
      }
      const q = new URLSearchParams();
      if (date) q.set('date', date);
      if (locParam) q.set('location', locParam);
      const data = await App.api.get('/api/notes/day?' + q);
      const tz = data.location.timezone;
      const isToday = data.date === data.today;
      const go = d => App.go('daily-notes', d, ...(isHq ? [data.location.id] : []));
      const students = data.students;
      const open = new Set(); // posted notes opened for editing

      el.append(h('div', { class: 'page-head' }, h('div', null,
        h('h1', null, 'Daily notes'),
        h('p', null, (isToday ? 'Today, ' : '') + App.fmtDate(data.date, { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + data.location.name))));

      // ---- day and location pickers
      const dateInput = h('input', { type: 'date', id: 'dn-date', value: data.date, max: data.today });
      dateInput.addEventListener('change', () => { if (dateInput.value) go(dateInput.value); });
      let locSelect = null;
      if (isHq) {
        locSelect = h('select', { id: 'dn-loc' }, hqLocations.map(l => h('option', { value: l.id, selected: l.id === data.location.id }, l.name)));
        // A past day stays chosen; today becomes the new location's today, which may be another date (L46).
        locSelect.addEventListener('change', () => { hqLocation = locSelect.value; App.go('daily-notes', isToday ? 'today' : data.date, locSelect.value); });
      }
      el.append(h('div', { class: 'row note-controls' },
        isHq && h('label', { class: 'field' }, h('span', null, 'Location'), locSelect),
        h('label', { class: 'field' }, h('span', null, 'Day'), dateInput),
        !isToday && h('button', { class: 'btn', type: 'button', onclick: () => go(data.today) }, 'Back to today')));

      if (!students.length) {
        el.append(h('div', { class: 'card empty' }, isToday
          ? 'Nobody has checked in yet today. Students show up here as soon as they check in.'
          : 'Nobody checked in on ' + App.fmtDate(data.date) + ', so there are no notes to write for that day.'));
        return;
      }

      // ---- progress
      const progress = h('div', { class: 'card', 'aria-live': 'polite' });
      const list = h('div', { class: 'note-list' });
      el.append(progress, list);

      function drawProgress() {
        const posted = students.filter(s => s.status === 'posted').length, total = students.length, left = total - posted;
        const withGoals = students.filter(s => s.goals.length).length;
        progress.replaceChildren(
          h('div', { class: 'row between' },
            h('div', null, h('div', { class: 'stat' }, posted + ' of ' + total), h('div', { class: 'stat-label' }, 'notes posted')),
            h('div', { class: left ? 'muted' : 'badge badge-ok' }, left ? left + ' still to write' : 'All done. Thank you!')),
          h('progress', { class: 'note-progress', max: total, value: posted, 'aria-hidden': 'true' }),
          h('p', { class: 'muted small', style: 'margin:.5rem 0 0' },
            'Goals this week: ' + withGoals + ' set · ' + (total - withGoals) + ' not set'));
      }
      function drawList() {
        students.sort((a, b) => (a.status === 'posted') - (b.status === 'posted') || a.name.localeCompare(b.name));
        list.replaceChildren(...students.map(card));
        drawProgress();
      }
      const redraw = s => { const old = document.getElementById('dn-' + s.id); if (old) old.replaceWith(card(s)); };
      // Fetch one student's row again and redraw the list, keeping focus on that card.
      async function reload(s) {
        const fresh = await App.api.get('/api/notes/day?' + new URLSearchParams({ date: data.date, location: data.location.id }));
        const now = fresh.students.find(x => x.id === s.id);
        if (!now) return;
        Object.assign(s, now);
        drawList();
        const target = document.getElementById('dn-' + s.id);
        if (target) target.focus();
      }

      function card(s) {
        const key = data.location.id + '|' + data.date + '|' + s.id;
        const posted = s.status === 'posted';
        const [statusText, statusClass] = STATUS[s.status];
        const head = h('div', { class: 'note-head' },
          h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(s.name)),
          h('div', { class: 'grow' }, h('h2', { id: 'dn-name-' + s.id }, s.name),
            h('div', { class: 'muted small' }, s.visits.map(v => visitText(v, tz)).join('; '))),
          h('span', { class: statusClass }, statusText));
        // The student's goals sit between the visit line and the ratings, so staff write the note with them in view (D-51).
        const goals = h('div', { class: 'note-goals' }, h('h3', { class: 'note-goals-label' }, 'Goals this week'),
          s.goals.length ? goalList(s.goals) : h('span', { class: 'badge' }, 'No goals this week'));
        const art = h('article', { class: 'card', id: 'dn-' + s.id, tabindex: '-1', 'aria-labelledby': 'dn-name-' + s.id }, head, goals);

        // A posted note shows as a summary until someone chooses to edit it.
        if (posted && !open.has(s.id) && !unsaved.has(key)) {
          const n = s.note;
          const day = postedDay(n.posted_at, tz, data.date);
          art.append(ratingSummary(s.ratings));
          if (s.comment) art.append(h('p', { class: 'note-comment' }, s.comment));
          art.append(
            h('p', { class: 'muted small', style: 'margin:.6rem 0 0' }, 'Posted ' + (day ? day + ', ' : '') + App.fmtTime(n.posted_at, tz) + ' by ' + n.posted_by_name +
              (n.edited_at ? ' · Edited ' + App.fmtDateTime(n.edited_at, tz) + ' by ' + n.edited_by_name : '')),
            h('div', { class: 'row note-actions' }, h('button', { class: 'btn', type: 'button', 'aria-label': 'Edit note for ' + s.name,
              onclick: () => { open.add(s.id); redraw(s); focusFirstChoice(s); } }, 'Edit note')));
          return art;
        }

        // The form. Ratings start blank (DN-4); posting needs every item rated.
        const ed = unsaved.get(key) || { ratings: Object.fromEntries(s.ratings.map(r => [r.item_id, r.rating])), comment: s.comment || '' };
        const keep = () => unsaved.set(key, ed);
        // The hint sits below the buttons, so it never pushes Post note or Save changes. It also
        // reserves the height of its two longest wordings (every item named, and "Ready to ..."),
        // which every other wording fits inside, so the card's height stays put as it changes,
        // even at 320px where a hint runs to several lines.
        const verb = posted ? 'save' : 'post';
        const ready = posted ? 'Ready to save. Parents see the change but are not notified again.' : 'Ready to post. Parents get a notification.';
        const hintText = h('span');
        const hint = h('p', { class: 'muted small note-hint', 'aria-live': 'polite', style: 'margin:.25rem 0 0',
          'data-fit-list': 'Rate ' + listWords(s.ratings.map(r => r.label)) + ' to ' + verb + '.', 'data-fit-ready': ready }, hintText);
        const postBtn = h('button', { class: 'btn btn-primary', type: 'button' }, posted ? 'Save changes' : 'Post note');
        const refresh = () => {
          const missing = s.ratings.filter(r => ed.ratings[r.item_id] == null).map(r => r.label);
          postBtn.disabled = missing.length > 0;
          hintText.textContent = missing.length === s.ratings.length ? 'Rate each item to ' + verb + '.'
            : missing.length ? 'Rate ' + listWords(missing) + ' to ' + verb + '.'
            : posted ? (unsaved.has(key) ? ready : '')
            : ready;
        };

        const rates = h('div', { class: 'note-rates' }, s.ratings.map(r => {
          const labelId = 'dn-' + s.id + '-item-' + r.item_id;
          const btns = [1, 2, 3].map(v => {
            const b = h('button', { type: 'button', class: 'btn' + (ed.ratings[r.item_id] === v ? ' btn-primary' : ''),
              'aria-pressed': String(ed.ratings[r.item_id] === v), 'data-v': v }, WORDS[v]);
            // Tapping the chosen rating again clears it; posting still needs every item rated.
            b.addEventListener('click', () => {
              const chosen = ed.ratings[r.item_id] === v ? null : v;
              ed.ratings[r.item_id] = chosen; keep();
              btns.forEach(x => { const on = Number(x.dataset.v) === chosen; x.classList.toggle('btn-primary', on); x.setAttribute('aria-pressed', String(on)); });
              refresh();
            });
            return b;
          });
          return h('div', { class: 'note-rate', role: 'group', 'aria-labelledby': labelId },
            h('span', { class: 'note-rate-label', id: labelId }, r.label), h('div', { class: 'note-scale' }, btns));
        }));

        const comment = h('textarea', { id: 'dn-c-' + s.id, maxlength: '2000', rows: '3', placeholder: "How did today's goals go?" });
        comment.value = ed.comment;
        comment.addEventListener('input', () => { ed.comment = comment.value; keep(); refresh(); });

        const save = async (btn, post) => App.run(btn, async () => {
          const body = { ratings: ed.ratings, comment: ed.comment, post };
          if (isHq) body.location_id = data.location.id;
          let r;
          try {
            r = await App.api.put('/api/notes/students/' + s.id + '/' + data.date, body);
          } catch (e) {
            // Refused: the note or the checklist may have changed since this screen
            // loaded. Redraw the card as it is now (unsaved edits stay), then show why.
            await reload(s).catch(() => {});
            throw e;
          }
          unsaved.delete(key);
          open.delete(s.id);
          Object.assign(s, r.student);
          if (posted) App.toast('Saved changes to ' + first(s.name) + "'s note.");
          else if (post) App.toast('Posted ' + first(s.name) + "'s note. Parents have been notified.");
          else App.toast('Saved ' + first(s.name) + "'s note for later. Parents can't see it yet.");
          drawList();
          // After posting, move straight on to the next student still to do.
          const next = post && !posted ? students.find(x => x.status !== 'posted') : s;
          const target = next && document.getElementById('dn-' + next.id);
          if (target) target.focus();
        });
        // Post note posts; Save changes edits a posted note and sends no `post` (the server
        // refuses post: true or false on a posted note, as only a stale screen sends those).
        postBtn.addEventListener('click', () => save(postBtn, posted ? undefined : true));

        const actions = h('div', { class: 'row note-actions' },
          posted
            ? h('button', { class: 'btn', type: 'button', onclick: () => { unsaved.delete(key); open.delete(s.id); redraw(s); } }, 'Cancel')
            : h('button', { class: 'btn', type: 'button', onclick: e => save(e.currentTarget, false) }, 'Save for later'),
          postBtn);
        art.append(rates,
          h('label', { class: 'field', for: 'dn-c-' + s.id, style: 'margin:.75rem 0 0' },
            h('span', null, 'Comment ', h('span', { class: 'muted', style: 'font-weight:400' }, "(optional) · reply to today's goals or anything else")), comment),
          actions, hint);
        refresh();
        return art;
      }
      function focusFirstChoice(s) {
        const b = document.querySelector('#dn-' + s.id + ' .note-scale .btn');
        if (b) b.focus();
      }

      drawList();
    },
  });

  // ======================================================== parents: Notes
  function parentNoteCard(n, showName) {
    const tz = n.timezone;
    const day = postedDay(n.posted_at, tz, n.local_date);
    return h('article', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { style: 'margin:0' }, App.fmtDate(n.local_date, { weekday: 'long', month: 'short', day: 'numeric' })),
        showName && h('span', { class: 'badge badge-accent' }, first(n.student_name))),
      h('p', { class: 'muted small', style: 'margin:.25rem 0 .5rem' }, [n.location_name, ...n.visits.map(v => visitText(v, tz))].join(' · ')),
      parentGoals(n.student_name, n.goals),
      h('ul', { class: 'list' }, n.ratings.map(r => h('li', null, h('span', { class: 'grow' }, r.label),
        h('span', { class: BADGE[r.rating] || 'badge' }, r.word || 'Not rated')))),
      n.comment && h('div', null, h('div', { class: 'muted small', style: 'margin-top:.5rem' }, 'Comment from ' + first(n.posted_by_name || 'staff')),
        h('p', { class: 'note-comment', style: 'margin-top:.25rem' }, n.comment)),
      h('p', { class: 'muted small', style: 'margin:.6rem 0 0' }, 'Posted by ' + n.posted_by_name + (day ? ' on ' + day : '') + ' at ' + App.fmtTime(n.posted_at, tz) +
        (n.edited_at ? ' · Edited ' + App.fmtDateTime(n.edited_at, tz) : '')));
  }

  App.register({
    id: 'notes', title: 'Notes', icon: '📝', roles: ['parent'], order: 30,
    async render(el, params) {
      let student = params[0] && params[0] !== 'all' ? params[0] : '';
      let to = params[1] || '';
      // A "note is ready" notification opens #/notes/note/<id>: that student's notes, from the note's day.
      if (student === 'note') {
        const { note } = await App.api.get('/api/notes/note/' + encodeURIComponent(to));
        student = String(note.student_id);
        to = note.local_date;
        history.replaceState(null, '', '#/notes/' + student + '/' + to);
      }
      const query = upTo => {
        const q = new URLSearchParams({ limit: '20' });
        if (student) q.set('student', student);
        if (upTo) q.set('to', upTo);
        return App.api.get('/api/notes/feed?' + q);
      };
      const data = await query(to);
      const many = data.students.length > 1;

      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Notes'),
        h('p', null, 'A short note from staff for each day your student visits.'))));

      if (!data.students.length) {
        el.append(h('div', { class: 'card empty' }, "Once your student's account is linked to yours, their daily notes will show up here."));
        return;
      }

      const dateInput = h('input', { type: 'date', id: 'pn-date', value: to, max: todayIn(App.tz()) });
      dateInput.addEventListener('change', () => App.go('notes', student || 'all', ...(dateInput.value ? [dateInput.value] : [])));
      let pick = null;
      if (many) {
        pick = h('select', { id: 'pn-student' }, h('option', { value: 'all' }, 'All students'),
          data.students.map(s => h('option', { value: s.id, selected: String(s.id) === student }, s.name)));
        pick.addEventListener('change', () => App.go('notes', pick.value, ...(to ? [to] : [])));
      }
      el.append(h('div', { class: 'row note-controls' },
        many && h('label', { class: 'field' }, h('span', null, 'Student'), pick),
        h('label', { class: 'field' }, h('span', null, 'Show notes up to'), dateInput),
        to && h('button', { class: 'btn', type: 'button', onclick: () => App.go('notes', student || 'all') }, 'Show latest')));

      const list = h('div', { 'aria-live': 'polite' });
      el.append(list);
      if (!data.notes.length) {
        const who = student ? first(data.students.find(s => String(s.id) === student).name) : 'your student';
        list.append(h('div', { class: 'card empty' }, to
          ? 'No notes on or before ' + App.fmtDate(to, { month: 'long', day: 'numeric', year: 'numeric' }) + '. Try a later date.'
          : 'No notes yet. Staff post a short note at the end of each day ' + who + ' visits.'));
        return;
      }

      const shown = new Set();
      const add = notes => notes.forEach(n => { if (!shown.has(n.id)) { shown.add(n.id); list.append(parentNoteCard(n, many && !student)); } });
      add(data.notes);
      let last = data.notes[data.notes.length - 1].local_date;
      if (data.more) {
        const more = h('button', { class: 'btn btn-block', type: 'button' }, 'Show older notes');
        more.addEventListener('click', () => App.run(more, async () => {
          const page = await query(last);
          add(page.notes);
          if (page.notes.length) last = page.notes[page.notes.length - 1].local_date;
          if (!page.more) more.remove();
        }));
        el.append(more);
      }
    },
  });

  // ======================================================== HQ: Note checklist
  let focusAfter = null;

  App.register({
    id: 'note-checklist', title: 'Note checklist', icon: '☑️', roles: ['hq'], order: 85,
    async render(el) {
      const { items } = await App.api.get('/api/notes/items');
      const active = items.filter(i => i.active), retired = items.filter(i => !i.active);
      const change = (btn, fn, msg, focusId) => App.run(btn, async () => { await fn(); App.toast(msg); focusAfter = focusId; App.refresh(); });
      const move = (btn, idx, by) => {
        const ids = active.map(i => i.id);
        [ids[idx], ids[idx + by]] = [ids[idx + by], ids[idx]];
        const it = active[idx];
        change(btn, () => App.api.put('/api/notes/items/order', { ids: ids.concat(retired.map(i => i.id)) }),
          'Moved "' + it.label + '" ' + (by < 0 ? 'up' : 'down') + '.', 'nc-' + (by < 0 ? 'up' : 'down') + '-' + it.id);
      };

      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Note checklist'),
        h('p', null, 'Staff rate every student on these items each day, at every location, as Needs work, Good or Great.'))),
      h('div', { class: 'notice' }, 'Changes apply to notes written from now on. Notes already posted keep the wording they were written with.'));

      const inUse = h('ol', { class: 'list note-checklist' }, active.map((it, idx) => {
        const input = h('input', { id: 'nc-label-' + it.id, value: it.label, maxlength: '80', 'aria-label': 'Wording for item ' + (idx + 1) });
        const form = h('form', { class: 'note-item-edit', onsubmit: e => {
          e.preventDefault();
          if (input.value.trim() === it.label) return App.toast('No change to save.');
          change(form.querySelector('button'), () => App.api.patch('/api/notes/items/' + it.id, { label: input.value }),
            'Renamed to "' + input.value.trim().replace(/\s+/g, ' ') + '".', 'nc-label-' + it.id);
        } }, input, h('button', { class: 'btn', type: 'submit', 'aria-label': 'Rename item ' + (idx + 1) }, 'Rename'));
        return h('li', { style: 'align-items:flex-start' },
          h('span', { class: 'avatar', 'aria-hidden': 'true' }, idx + 1),
          h('div', { class: 'note-item-body' }, form, h('div', { class: 'row' },
            h('button', { class: 'btn note-move', type: 'button', id: 'nc-up-' + it.id, 'aria-label': 'Move "' + it.label + '" up', disabled: idx === 0,
              onclick: e => move(e.currentTarget, idx, -1) }, '↑'),
            h('button', { class: 'btn note-move', type: 'button', id: 'nc-down-' + it.id, 'aria-label': 'Move "' + it.label + '" down', disabled: idx === active.length - 1,
              onclick: e => move(e.currentTarget, idx, 1) }, '↓'),
            h('button', { class: 'btn', type: 'button', 'aria-label': 'Retire "' + it.label + '"', disabled: active.length === 1,
              title: active.length === 1 ? 'The checklist needs at least one item.' : null,
              onclick: e => change(e.currentTarget, () => App.api.patch('/api/notes/items/' + it.id, { active: false }),
                'Retired "' + it.label + '". You can restore it below.', 'nc-restore-' + it.id) }, 'Retire'))));
      }));
      el.append(h('section', { class: 'card', 'aria-labelledby': 'nc-inuse' }, h('h2', { id: 'nc-inuse' }, 'In use'), inUse));

      const newLabel = h('input', { id: 'nc-new', maxlength: '80', required: true, placeholder: 'For example: Asked for help when stuck' });
      const addForm = h('form', { onsubmit: e => {
        e.preventDefault();
        change(addForm.querySelector('button'), () => App.api.post('/api/notes/items', { label: newLabel.value }),
          'Added "' + newLabel.value.trim().replace(/\s+/g, ' ') + '" to the end of the checklist.', 'nc-new');
      } },
        h('label', { class: 'field', for: 'nc-new' }, h('span', null, 'New item'), newLabel,
          h('div', { class: 'hint' }, 'Keep it short. Staff see it next to the Needs work, Good and Great buttons.')),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add item'));
      el.append(h('section', { class: 'card', 'aria-labelledby': 'nc-add' }, h('h2', { id: 'nc-add' }, 'Add an item'), addForm));

      el.append(h('section', { class: 'card', 'aria-labelledby': 'nc-retired' }, h('h2', { id: 'nc-retired' }, 'Retired'),
        retired.length
          ? h('ul', { class: 'list' }, retired.map(it => h('li', null, h('span', { class: 'grow' }, it.label),
            h('button', { class: 'btn', type: 'button', id: 'nc-restore-' + it.id, 'aria-label': 'Restore "' + it.label + '"',
              onclick: e => change(e.currentTarget, () => App.api.patch('/api/notes/items/' + it.id, { active: true }),
                'Restored "' + it.label + '". It is back at its old place in the list.', 'nc-label-' + it.id) }, 'Restore'))))
          : h('p', { class: 'muted', style: 'margin:0' }, 'Nothing retired. A retired item drops off new notes but stays on notes already posted.')));

      if (focusAfter) {
        const id = focusAfter;
        focusAfter = null;
        setTimeout(() => { const t = document.getElementById(id); if (t && !t.disabled) t.focus(); }, 0);
      }
    },
  });

  // ======================================================== students: My goals (#/goals)
  // One goal's editor: subject buttons, the tip, one or two examples to tap, and the text box.
  // A subject another open goal uses is shown but can't be picked (D-57), with the tip to put
  // more than one thing in that goal. Errors show right under the subject buttons or the text
  // box, and never clear what was typed. `g` is { subject, text }; `changed` runs after each edit.
  function goalEditor(base, meta, g, taken, changed = () => {}) {
    const subjErr = h('p', { class: 'goal-error', id: base + '-subject-err', 'aria-live': 'polite' });
    const textErr = h('p', { class: 'goal-error', id: base + '-text-err', 'aria-live': 'polite' });
    const text = h('textarea', { id: base + '-text', rows: '3', maxlength: String(meta.text_max), 'aria-describedby': base + '-text-err' });
    text.value = g.text;
    const clear = field => {
      (field === 'subject' ? subjErr : textErr).textContent = '';
      if (field === 'text') text.setAttribute('aria-invalid', 'false');
    };
    // While the box holds an example word for word, a nudge to make it the student's own.
    const own = h('p', { class: 'goal-own', id: base + '-own', 'aria-live': 'polite' });
    const nudge = () => {
      const s = meta.subjects.find(x => x.id === g.subject);
      own.textContent = s && s.examples.includes(g.text.trim()) ? "Now make it yours: change the chapter, unit or assignment to the one you're doing." : '';
    };
    text.addEventListener('input', () => { g.text = text.value; clear('text'); nudge(); changed(); });
    const examples = h('div');
    const chips = meta.subjects.map(s => h('button', {
      type: 'button', class: 'btn' + (g.subject === s.id ? ' btn-primary' : ''), 'data-subject': s.id,
      'aria-pressed': String(g.subject === s.id), disabled: taken.has(s.id),
      onclick: () => { g.subject = s.id; mark(); drawExamples(); clear('subject'); nudge(); changed(); },
    }, s.label, taken.has(s.id) && h('span', { class: 'goal-used' }, ' · ' + taken.get(s.id))));
    function mark() {
      chips.forEach(b => { const on = b.dataset.subject === g.subject; b.classList.toggle('btn-primary', on); b.setAttribute('aria-pressed', String(on)); });
    }
    // Tapping an example fills the text box, so the student tweaks it instead of typing from scratch.
    function drawExamples() {
      const s = meta.subjects.find(x => x.id === g.subject);
      examples.replaceChildren(...(s ? [
        h('p', { class: 'goal-label', id: base + '-ex' }, 'Tap an example, then make it yours'),
        h('div', { class: 'goal-examples', role: 'group', 'aria-labelledby': base + '-ex' }, s.examples.map(x =>
          h('button', { type: 'button', class: 'btn', onclick: () => { g.text = x; text.value = x; clear('text'); nudge(); changed(); text.focus(); } }, x))),
      ] : []));
    }
    drawExamples();
    nudge();
    const kids = [h('p', { class: 'goal-label', id: base + '-subject-label' }, 'Pick a subject'),
      h('div', { class: 'goal-subjects', role: 'group', 'aria-labelledby': base + '-subject-label', 'aria-describedby': base + '-subject-err' }, chips),
      subjErr,
      taken.size > 0 && h('p', { class: 'muted small goal-same' }, 'Doing more than one thing in a subject? Put it all in that goal.'),
      h('p', { class: 'goal-tip' }, meta.tip),
      examples,
      h('label', { class: 'goal-label', for: base + '-text' }, 'Your goal ', h('span', { class: 'muted', style: 'font-weight:400' }, '(up to 3 sentences)')),
      text, textErr, own];
    const el = h('div', { class: 'goal-editor' }, kids);
    // Shows a refusal next to its field and moves focus there.
    function show(field, message) {
      if (field === 'subject') {
        subjErr.textContent = message;
        const b = chips.find(x => !x.disabled);
        if (b) b.focus();
      } else {
        textErr.textContent = message;
        text.setAttribute('aria-invalid', 'true');
        text.focus();
      }
    }
    return { el, show };
  }
  // A student's own goals: each open one says where it stands today, and finished ones say
  // which day they were done ("✓ Done Fri"), so finishing a goal shows.
  const MINE = { yes: 'Still working on it', fresh: 'New today', ask: 'Not answered yet' };
  const goalLine = (g, chip, cls) => h('li', null, h('span', { class: 'badge badge-accent' }, g.subject_label), h('span', { class: 'sr-only' }, ', '), g.text,
    h('span', { class: 'sr-only' }, '. '), h('span', { class: cls + ' goal-answer' }, chip));
  const myGoalList = items => h('ul', { class: 'note-goal-list' }, items.map(g =>
    goalLine(g, MINE[g.answer === 'yes' ? 'yes' : g.asks ? 'ask' : 'fresh'], 'badge')));
  const doneList = items => h('ul', { class: 'note-goal-list' }, items.map(g =>
    goalLine(g, '✓ Done ' + App.fmtDate(g.done_on, { weekday: 'short', month: undefined, day: undefined }), 'badge badge-ok')));
  const doneCard = items => h('section', { class: 'card', 'aria-labelledby': 'goal-done-h' }, h('h2', { id: 'goal-done-h' }, 'Done this week'), doneList(items));

  // Which field a refusal from the server belongs to.
  const fieldOf = code => (code === 'bad_subject' || code === 'same_subject' ? 'subject' : code === 'goal_text' ? 'text' : null);

  // The half-set week, kept on this device per student and week until it's saved, so leaving
  // the screen or reloading never loses it. Kept in memory too, for a browser that blocks storage.
  const drafts = new Map();
  const draftStore = {
    get(k) {
      if (drafts.has(k)) return drafts.get(k);
      try { return JSON.parse(window.localStorage.getItem(k)); } catch (_) { return null; }
    },
    set(k, v) { drafts.set(k, v); try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* memory only */ } },
    del(k) { drafts.delete(k); try { window.localStorage.removeItem(k); } catch (_) { /* memory only */ } },
    // Drops this student's drafts from other weeks, so none outlives its week on a shared device.
    prune(prefix, k) {
      try {
        const ls = window.localStorage;
        for (let i = ls.length - 1; i >= 0; i--) { const d = ls.key(i); if (d && d.startsWith(prefix) && d !== k) ls.removeItem(d); }
      } catch (_) { /* memory only */ }
    },
  };
  const blank = () => [0, 1, 2].map(() => ({ subject: '', text: '' }));
  // A stored draft, or null when it isn't one this screen wrote.
  const readDraft = d => (d && Array.isArray(d.picks) && d.picks.length === 3 && Number.isInteger(d.step) && d.step >= 0 && d.step < 3 &&
    d.picks.every(x => x && typeof x.subject === 'string' && typeof x.text === 'string')
    ? { step: d.step, picks: d.picks.map(x => ({ subject: x.subject, text: x.text })) } : null);

  // Setting the week: 3 short steps, "Goal 1 of 3", each checked by the server before the next.
  function setFlow(el, meta, wk) {
    const key = 'elite.goals.' + App.me.user.id + '.' + wk.week_start;
    draftStore.prune('elite.goals.' + App.me.user.id + '.', key);
    const saved = readDraft(draftStore.get(key));
    const picks = saved ? saved.picks : blank();
    let step = saved ? saved.step : 0;
    const keep = () => draftStore.set(key, { step, picks });
    const box = h('section', { class: 'card goal-steps', 'aria-labelledby': 'goal-step' });
    el.append(box);
    function draw(moved, errField, errMessage) {
      const n = step + 1, last = n === picks.length, p = picks[step];
      keep();
      const taken = new Map(picks.map((x, i) => [x.subject, 'Goal ' + (i + 1)]).filter(([sub], i) => sub && i !== step));
      const ed = goalEditor('goal', meta, p, taken, keep);
      const next = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block' }, last ? 'Save my 3 goals' : 'Next');
      next.addEventListener('click', () => App.run(next, async () => {
        if (!p.subject) return ed.show('subject', 'Pick a subject.');
        const c = await App.api.post('/api/notes/goals/check-text', { subject: p.subject, text: p.text });
        if (!c.ok) return ed.show('text', c.message);
        if (!last) { step++; return draw(true); }
        try {
          await App.api.put('/api/notes/goals/week', { goals: picks.map(x => ({ subject: x.subject, text: x.text })) });
        } catch (e) {
          // "Goal 2: ..." names the step; go back to it and show the reason by its field.
          const m = /^Goal (\d): (.*)$/.exec(e.message || '');
          if (!m || !fieldOf(e.code)) throw e;
          step = Number(m[1]) - 1;
          return draw(true, fieldOf(e.code), m[2]);
        }
        draftStore.del(key);
        App.toast("You're set for today.");
        App.go('home');
      }));
      const title = h('h2', { id: 'goal-step', tabindex: '-1' }, 'Goal ' + n + ' of ' + picks.length);
      // replaceChildren (unlike h) would print a false as text, so the parts are filtered first.
      const kids = [title,
        h('div', { class: 'goal-dots', 'aria-hidden': 'true' }, picks.map((_, i) => h('span', { class: 'goal-dot' + (i <= step ? ' on' : '') }))),
        n === 1 && h('p', { class: 'muted', style: 'margin:0' }, 'Pick 3 things to finish this week, each in a different subject. Your mentors will check in on them.'),
        ed.el,
        h('div', { class: 'goal-nav' }, next,
          step > 0 && h('button', { type: 'button', class: 'btn btn-block', onclick: () => { step--; draw(true); } }, 'Back'))];
      box.replaceChildren(...kids.filter(Boolean));
      // A new step starts at the top of its card, clear of the sticky top bar (scroll-margin-top).
      if (moved && box.scrollIntoView) box.scrollIntoView({ block: 'start' });
      if (errField) ed.show(errField, errMessage);
      else if (moved) title.focus({ preventScroll: true });
    }
    draw(false);
  }

  // Not checked in yet: the next step, one tap away.
  const checkInButton = () => h('a', { class: 'btn btn-primary btn-lg btn-block', href: '#/checkin', style: 'margin-bottom:12px' }, 'Go to Check in');

  // The daily update: one card per open goal, "Still working on this?" with Yes, Done and Change.
  // Each goal is answered on its own; there is no button that answers them all (D-57). A goal
  // added today isn't asked about; it can only be changed. Below: the goals done this week.
  function updateFlow(el, meta, wk) {
    const status = h('div', { role: 'status', 'aria-live': 'polite' });
    const list = h('div'), doneBox = h('div');
    el.append(status, ...(wk.checked_in ? [] : [checkInButton()]), list, doneBox);
    let form = null; // { id, answer, draft } while a Done or Change form is open
    function draw() {
      const left = wk.goals.filter(g => g.asks).length;
      status.replaceChildren(!wk.checked_in ? h('p', { class: 'notice' }, 'Check in to update your goals today.')
        : wk.state === 'done' ? h('p', { class: 'notice notice-ok', id: 'goal-done', tabindex: '-1' }, h('span', { 'aria-hidden': 'true' }, '✓ '), "You're set for today.")
          : h('p', { class: 'notice' }, 'Still working on these? Answer each goal. ' + left + ' to go.'));
      list.replaceChildren(...wk.goals.map(card));
      doneBox.replaceChildren(...(wk.done.length ? [doneCard(wk.done)] : []));
    }
    // After an answer: say so when the day is done, else move on to the next goal still asked about.
    function after(was, id) {
      draw();
      if (wk.state === 'done' && was !== 'done') {
        App.toast("You're set for today.");
        return focusId('goal-done');
      }
      const nextAsk = wk.goals.find(g => g.asks);
      focusFirst(nextAsk ? nextAsk.id : id);
    }
    const focusId = id => { const t = document.getElementById(id); if (t) t.focus(); };
    // A goal card's first answer button: Yes, or Change on a goal added today.
    const focusFirst = id => focusId(document.getElementById('goal-yes-' + id) ? 'goal-yes-' + id : 'goal-change-' + id);
    const send = answer => App.api.post('/api/notes/goals/week/check', { answers: [answer] });

    function card(g) {
      const qId = 'goal-q-' + g.id, subjId = 'goal-subj-' + g.id;
      const art = h('article', { class: 'card', id: 'goal-card-' + g.id },
        h('div', { class: 'row between' }, h('span', { class: 'badge badge-accent', id: subjId }, g.subject_label),
          h('span', { class: 'muted small' }, 'Goal ' + g.position)),
        h('p', { class: 'goal-text' }, g.text));
      if (!wk.checked_in) return art;
      const fresh = !g.asks && !g.answer; // added today: nothing to ask yet
      const q = g.answer === 'yes' ? '✓ Still working on it' : fresh ? 'New today. Want to change it?' : 'Still working on this?';
      const yes = h('button', { type: 'button', id: 'goal-yes-' + g.id, class: 'btn' + (g.answer === 'yes' ? ' btn-primary' : ''), 'aria-pressed': String(g.answer === 'yes') }, 'Yes');
      yes.addEventListener('click', () => App.run(yes, async () => {
        const was = wk.state;
        wk = await send({ goalId: g.id, answer: 'yes' });
        form = null;
        after(was, g.id);
      }));
      // Change starts from the goal as it is, so a small fix isn't a fresh start; Done starts empty.
      const open = answer => () => {
        form = { id: g.id, answer, draft: answer === 'change' ? { subject: g.subject, text: g.text } : { subject: '', text: '' } };
        draw(); focusId('goal-form-' + g.id);
      };
      const chosen = answer => !!(form && form.id === g.id && form.answer === answer);
      const pick = (answer, label) => h('button', { type: 'button', id: 'goal-' + answer + '-' + g.id, class: 'btn' + (chosen(answer) ? ' btn-primary' : ''),
        'aria-pressed': String(chosen(answer)), onclick: open(answer) }, label);
      art.append(h('p', { class: 'goal-q', id: qId }, q),
        h('div', { class: 'goal-answers', role: 'group', 'aria-labelledby': qId + ' ' + subjId },
          fresh ? [pick('change', 'Change')] : [yes, pick('done', 'Done'), pick('change', 'Change')]));
      if (form && form.id === g.id) art.append(nextGoalForm(g));
      return art;
    }

    // Done and Change both need the next goal, which takes this one's place (same rules as setting).
    function nextGoalForm(g) {
      const f = form;
      const taken = new Map(wk.goals.filter(x => x.id !== g.id).map(x => [x.subject, 'Goal ' + x.position]));
      const ed = goalEditor('goal-' + g.id, meta, f.draft, taken);
      const save = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block' }, 'Save new goal');
      save.addEventListener('click', () => App.run(save, async () => {
        if (!f.draft.subject) return ed.show('subject', 'Pick a subject.');
        const was = wk.state;
        try {
          wk = await send({ goalId: g.id, answer: f.answer, subject: f.draft.subject, text: f.draft.text });
        } catch (e) {
          if (!fieldOf(e.code)) throw e;
          return ed.show(fieldOf(e.code), e.message);
        }
        form = null;
        after(was, wk.goals.find(x => x.position === g.position).id);
      }));
      return h('div', { class: 'goal-form' },
        h('h3', { id: 'goal-form-' + g.id, tabindex: '-1' }, f.answer === 'done' ? "Nice work! What's your next goal?" : "What's your new goal?"),
        ed.el,
        h('div', { class: 'goal-nav' }, save,
          h('button', { type: 'button', class: 'btn btn-block', onclick: () => { form = null; draw(); focusFirst(g.id); } }, 'Cancel')));
    }
    draw();
  }

  App.register({
    id: 'goals', title: 'My goals', icon: '🎯', roles: ['student'], order: 16, nav: false,
    async render(el) {
      const [meta, wk] = await Promise.all([App.api.get('/api/notes/goals/subjects'), App.api.get('/api/notes/goals/week')]);
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'My goals'), h('p', null, 'This week: ' + weekText(wk)))));
      if (wk.state !== 'set') return updateFlow(el, meta, wk);
      if (!wk.checked_in) {
        el.append(h('div', { class: 'card empty' }, 'Check in first, then set your 3 goals for this week.'), checkInButton());
        return;
      }
      setFlow(el, meta, wk);
    },
  });

  // ======================================================== Home cards
  // Students: this week's goals, or the ask to set them (D-57).
  async function goalsCard(el) {
    const g = await App.api.get('/api/notes/goals/week');
    const card = h('section', { class: 'card', 'aria-labelledby': 'home-goals' }, h('h2', { id: 'home-goals' }, "This week's goals"));
    if (g.state === 'set') {
      card.append(h('p', null, 'Set your 3 goals for this week.'), g.checked_in
        ? h('a', { class: 'btn btn-primary btn-lg btn-block', href: '#/goals' }, 'Set my 3 goals')
        : h('p', { class: 'muted small', style: 'margin:0' }, "You'll set them after you check in."));
    } else {
      card.append(myGoalList(g.goals));
      if (g.done.length) card.append(h('h3', { class: 'note-goals-label', style: 'margin-top:.75rem' }, 'Done this week'), doneList(g.done));
      card.append(...(g.checked_in && g.state === 'update'
        ? [h('p', { style: 'margin:.75rem 0 .5rem' }, 'Still working on these?'), h('a', { class: 'btn btn-primary btn-lg btn-block', href: '#/goals' }, 'Update my goals')]
        : [g.checked_in && h('p', { class: 'notice notice-ok', style: 'margin:.75rem 0 .5rem' }, h('span', { 'aria-hidden': 'true' }, '✓ '), "You're set for today."),
          h('div', { class: 'row', style: 'margin-top:.75rem' }, h('a', { class: 'btn', href: '#/goals' }, 'See my goals'))]).filter(Boolean));
    }
    el.replaceChildren(card);
  }
  App.card({ id: 'notes-goals', roles: ['student'], order: 15, render: goalsCard });

  // Parents: each student's goals this week with today's answers, any time (D-57).
  const todaysAnswers = w => w.goals.filter(g => g.status === 'open')
    .map(g => Object.assign({}, g, { answer: (w.checks.find(c => c.goal_id === g.id && c.date === w.today) || {}).answer }));
  App.card({
    id: 'notes-week-goals', roles: ['parent'], order: 31,
    async render(el) {
      const { students } = await App.api.get('/api/notes/today');
      if (!students.length) return;
      const weeks = await Promise.all(students.map(s => App.api.get('/api/notes/goals/student/' + s.id)));
      el.append(h('section', { class: 'card', 'aria-labelledby': 'home-week-goals' }, h('h2', { id: 'home-week-goals' }, "This week's goals"),
        h('ul', { class: 'list' }, weeks.map(w => h('li', { style: 'align-items:flex-start' },
          h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(w.student.name)),
          h('div', { class: 'grow' }, h('strong', null, w.student.name),
            w.goals.length ? goalList(todaysAnswers(w)) : h('div', { class: 'muted small' }, first(w.student.name) + " hasn't set this week's goals yet."),
            w.goals.length > 0 && h('a', { class: 'btn', style: 'margin-top:.5rem', href: '#/week-goals/' + w.student.id,
              'aria-label': 'See updates for ' + w.student.name }, 'See updates')))))));
    },
  });

  // Parents: one student's week, read-only: the goals now, and every daily answer by day.
  const SAID = { yes: 'Still working on it', done: 'Done', change: 'Changed' };
  App.register({
    id: 'week-goals', title: 'Goals this week', icon: '🎯', roles: ['parent'], order: 32, nav: false,
    async render(el, params) {
      const w = await App.api.get('/api/notes/goals/student/' + encodeURIComponent(params[0] || ''));
      const who = first(w.student.name);
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, who + "'s goals"), h('p', null, 'This week: ' + weekText(w)))));
      if (!w.goals.length) {
        el.append(h('div', { class: 'card empty' }, who + " hasn't set this week's goals yet. Students set 3 goals at their first check-in of the week."));
        return;
      }
      const byId = new Map(w.goals.map(g => [g.id, g]));
      el.append(h('section', { class: 'card', 'aria-labelledby': 'wg-now' }, h('h2', { id: 'wg-now' }, 'Working on now'), goalList(todaysAnswers(w))));
      const days = [...new Set(w.checks.map(c => c.date))];
      el.append(h('section', { class: 'card', 'aria-labelledby': 'wg-days' }, h('h2', { id: 'wg-days' }, 'Daily updates'),
        days.length ? days.map(d => h('div', { class: 'note-goals' }, h('h3', { class: 'note-goals-label' }, App.fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })),
          h('ul', { class: 'note-goal-list' }, w.checks.filter(c => c.date === d).map(c => {
            const g = byId.get(c.goal_id), next = c.answer !== 'yes' && byId.get(g.replaced_by);
            return h('li', null, h('span', { class: 'badge badge-accent' }, g.subject_label), h('span', { class: 'sr-only' }, ', '), g.text,
              h('span', { class: 'sr-only' }, '. '), h('span', { class: (ANSWER[c.answer][1]) + ' goal-answer' }, SAID[c.answer]),
              next && h('div', { class: 'muted small' }, 'Next goal: ' + next.subject_label + ', ' + next.text));
          }))))
          : h('p', { class: 'muted', style: 'margin:0' }, 'No daily updates yet. ' + who + ' answers at each check-in after the first one this week.')),
        h('a', { class: 'btn', href: '#/home' }, 'Back to Home'));
    },
  });

  App.card({
    id: 'notes-today', roles: ['parent'], order: 30,
    async render(el) {
      const { students } = await App.api.get('/api/notes/today');
      if (!students.length) return;
      el.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, "Today's notes"), h('a', { class: 'btn btn-ghost', href: '#/notes' }, 'All notes')),
        h('ul', { class: 'list' }, students.map(s => {
          const n = s.note;
          if (!n) {
            // "Wasn't in" only once the day's last session has ended (in the location's zone, worked out by the server).
            const who = first(s.name);
            const why = s.in_building || s.session_later ? 'No note yet. Notes post after ' + who + "'s session."
              : s.visited ? 'No note yet. Notes usually post by the end of the day.'
              : s.session_today ? who + " wasn't in today, so there's no note."
              : who + " has no session today, so there's no note.";
            return h('li', null, h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(s.name)),
              h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, why)));
          }
          return h('li', { style: 'align-items:flex-start' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(s.name)),
            h('div', { class: 'grow' }, h('strong', null, s.name), parentGoals(s.name, n.goals), ratingSummary(n.ratings),
              n.comment && h('p', { class: 'note-comment' }, n.comment.length > 160 ? n.comment.slice(0, 157) + '…' : n.comment),
              h('div', { class: 'muted small', style: 'margin-top:.4rem' }, 'Posted by ' + n.posted_by_name + ' at ' + App.fmtTime(n.posted_at, n.timezone) +
                (n.edited_at ? ' · Edited' : ''))));
        }))));
    },
  });

  App.card({
    id: 'notes-progress', roles: ['staff'], order: 30,
    async render(el) {
      if (App.role() === 'hq') {
        const { items } = await App.api.get('/api/notes/items');
        const active = items.filter(i => i.active);
        el.append(h('div', { class: 'card' }, h('h2', null, 'Daily note checklist'),
          h('p', { class: 'muted' }, 'Staff rate every student on ' + active.length + ' item' + (active.length === 1 ? '' : 's') + ': ' + active.map(i => i.label).join(', ') + '.'),
          h('a', { class: 'btn', href: '#/note-checklist' }, 'Edit checklist')));
        return;
      }
      const d = await App.api.get('/api/notes/day');
      const left = d.total - d.posted;
      el.append(h('div', { class: 'card' }, h('h2', null, 'Daily notes'),
        d.total
          ? [h('div', { class: 'stat' }, d.posted + ' of ' + d.total), h('div', { class: 'stat-label' }, 'notes posted today'),
            h('p', { class: 'muted', style: 'margin:.5rem 0 .75rem' }, left ? left + ' still to write.' : 'All done for today. Thank you!')]
          : h('p', { class: 'muted' }, 'Nobody has checked in yet today. Notes open up as students arrive.'),
        h('a', { class: left ? 'btn btn-primary' : 'btn', href: '#/daily-notes' }, left ? 'Write notes' : 'Open daily notes')));
    },
  });

  // A "note is ready" notification opens the parent's Notes at that note's day.
  App.inboxLink('daily_note', n => 'notes/note/' + n.ref_id);
})();
