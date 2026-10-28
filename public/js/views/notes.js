/* Daily notes (PRD 6, DN-1..DN-5).
   Staff:   "Daily notes" - the day's attendance list; rate each item Needs work / Good / Great,
            add an optional comment, Post. Unfinished notes can be saved for later.
   Parents: "Notes" - posted notes by date for each student. Students don't see notes in v1 (D-2).
   HQ:      "Note checklist" - add, rename, reorder and retire the rating items.
   Home:    parents see today's note; staff see how many notes are left. */
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
        progress.replaceChildren(
          h('div', { class: 'row between' },
            h('div', null, h('div', { class: 'stat' }, posted + ' of ' + total), h('div', { class: 'stat-label' }, 'notes posted')),
            h('div', { class: left ? 'muted' : 'badge badge-ok' }, left ? left + ' still to write' : 'All done. Thank you!')),
          h('progress', { class: 'note-progress', max: total, value: posted, 'aria-hidden': 'true' }));
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
        const art = h('article', { class: 'card', id: 'dn-' + s.id, tabindex: '-1', 'aria-labelledby': 'dn-name-' + s.id }, head);

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

        const comment = h('textarea', { id: 'dn-c-' + s.id, maxlength: '2000', rows: '3', placeholder: 'Anything worth sharing with the family today?' });
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
            h('span', null, 'Comment ', h('span', { class: 'muted', style: 'font-weight:400' }, '(optional)')), comment),
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

  // ======================================================== Home cards
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
            h('div', { class: 'grow' }, h('strong', null, s.name), ratingSummary(n.ratings),
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
