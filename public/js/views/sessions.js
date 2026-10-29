/* Sessions module views (SC-1..SC-5, NF-4).
   - "Schedules" screen (staff read-only; directors and HQ edit): the period, its
     closures and the list of schedules in it (D-41), each with its seats, waiting
     line, days a week and next date change. A schedule's panel edits it and its
     dates: skip, move or add one date, and undo (D-46).
   - Home card for staff, directors and HQ: today's schedules at the location.
   The screens say "Schedule" and "Period"; the API keeps session and term.
   All times are the location's own local times, labelled with its zone. */
(function () {
  'use strict';
  const { h } = App;
  const LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const CSS = `
    .sx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .sx-slot { display: block; width: 100%; text-align: left; font: inherit; color: var(--text); background: var(--surface);
      border: 1px solid var(--line); border-radius: var(--radius-sm); padding: .6rem .7rem; min-height: 44px; overflow-wrap: anywhere; }
    button.sx-slot { cursor: pointer; }
    button.sx-slot:hover { border-color: var(--brand); }
    .sx-meta { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-top: .25rem; }
    .sx-days { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0 .75rem; }
    .sx-pair { display: grid; gap: 0 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .sx-count { font-weight: 700; white-space: nowrap; }
    .sx-month { font-size: .95rem; margin: 1rem 0 .25rem; }
    .sx-date { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; justify-content: space-between; padding: .4rem 0; border-top: 1px solid var(--line); }
    .sx-date .sx-acts { display: flex; flex-wrap: wrap; gap: .4rem; }
    .sx-date form { flex-basis: 100%; }
  `;
  function style() {
    if (!document.getElementById('sx-style')) document.head.append(h('style', { id: 'sx-style' }, CSS));
  }

  // ---------- small helpers ----------
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const told = n => n ? ` We let ${plural(n, 'person', 'people')} know.` : '';
  // "3 enrollments and 1 waitlist spot", leaving out whatever is zero.
  const spots = (enrolled, waiting) => [enrolled && plural(enrolled, 'enrollment', 'enrollments'), waiting && plural(waiting, 'waitlist spot', 'waitlist spots')]
    .filter(Boolean).join(' and ') || 'no enrollments';
  const span = s => App.hhmm(s.start_time) + ' – ' + App.hhmm(s.end_time);
  const mins = v => { const [hh, mm] = String(v).split(':').map(Number); return hh * 60 + mm; };
  const fmtLen = m => (Math.floor(m / 60) ? Math.floor(m / 60) + ' h' : '') + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  const shortDate = (d, year) => App.fmtDate(d, { weekday: undefined, year: year ? 'numeric' : undefined });
  const longDate = d => App.fmtDate(d, { weekday: 'long', month: 'long' });
  const dayDate = d => App.fmtDate(d);                          // "Mon, Nov 23"
  const bare = d => App.fmtDate(d).replace(',', '');            // "Mon Nov 23"
  const monthName = d => App.fmtDate(d, { weekday: undefined, day: undefined, month: 'long', year: 'numeric' });
  function zoneName(tz) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(App.now()).find(p => p.type === 'timeZoneName').value;
    } catch (_) { return tz; }
  }
  // The first and last day of the month `add` months after the one holding `iso`.
  function monthOf(iso, add) {
    const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1 + add;
    const first = new Date(Date.UTC(y, m, 1)), last = new Date(Date.UTC(y, m + 1, 0));
    return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
  }
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint && h('div', { class: 'hint' }, hint));
  // Enrollments a cancel ends: active and paused alike (D-26).
  const ends = s => s.enrolled + (s.paused || 0);
  // "18 families are told now."
  const tellLine = s => ends(s) ? `${plural(ends(s), 'family is', 'families are')} told now.` : 'Nobody is enrolled yet, so nobody is told.';
  // The next date change, in words: "Moves Mon Nov 23 → Tue Nov 24".
  function nextChange(s) {
    const c = s.changes && s.changes[0];
    if (!c) return null;
    if (c.kind === 'add' && c.moved_from) return `Moves ${bare(c.moved_from)} → ${bare(c.date)}`;
    const to = c.kind === 'skip' && s.changes.find(x => x.kind === 'add' && x.moved_from === c.date);
    if (to) return `Moves ${bare(c.date)} → ${bare(to.date)}`;
    return c.kind === 'skip' ? `Skips ${bare(c.date)}` : `Adds ${bare(c.date)}`;
  }

  // ---------- the Schedules screen ----------
  App.register({
    id: 'sessions', title: 'Schedules', icon: '🗓️', roles: ['staff'], order: 70,
    async render(el, params) {
      style();
      const hq = App.role() === 'hq';
      const editor = App.allowed(['director']);
      let locations = [];
      let locId = App.me.user.location_id;
      if (hq) {
        locations = (await App.api.get('/api/locations')).locations;
        locId = Number(params[0]) || (locations[0] && locations[0].id);
        if (!locId) {
          el.append(h('div', { class: 'page-head' }, h('h1', null, 'Schedules')),
            h('div', { class: 'card empty' }, 'No locations yet. Once a location exists, its schedules are built here.'));
          return;
        }
      }

      const ui = { data: null, termId: null, panel: null };
      const term = () => ui.data.terms.find(t => t.id === ui.termId) || null;
      async function load() {
        ui.data = await App.api.get('/api/sessions?location_id=' + locId);
        if (!term()) {
          const t = ui.data.today, terms = ui.data.terms;
          const pick = terms.find(x => x.start_date <= t && t <= x.end_date) || terms.find(x => x.start_date > t) || terms[terms.length - 1];
          ui.termId = pick ? pick.id : null;
        }
      }
      const open = panel => { ui.panel = panel; draw(); const f = el.querySelector('[data-panel] input, [data-panel] select'); if (f) f.focus(); };
      const close = () => { ui.panel = null; draw(); };
      const reload = async () => { ui.panel = null; await load(); draw(); };
      // After a date change: fresh counts and changes, with the same schedule's panel still open.
      const reopen = async id => {
        await load();
        const s = ui.data.sessions.find(x => x.id === id);
        ui.panel = s ? { type: 'session', session: s } : null;
        draw();
      };

      function draw() {
        const d = ui.data, loc = d.location, t = term();
        const head = h('div', { class: 'page-head' },
          h('div', null, h('h1', null, 'Schedules'),
            h('p', null, `${loc.name} · all times are ${loc.name} time (${zoneName(loc.timezone)})`)),
          editor && t && h('button', { class: 'btn btn-primary', onclick: () => open({ type: 'session', session: null }) }, '+ New schedule'));
        const parts = [head];
        if (hq) {
          const sel = h('select', { id: 'sx-loc', onchange: e => App.go('sessions', e.target.value) },
            locations.map(l => h('option', { value: l.id, selected: l.id === locId }, l.name)));
          parts.push(h('div', { class: 'card' }, field('Location', sel)));
        }
        if (ui.panel) parts.push(panel(ui.panel));
        parts.push(termCard(t));
        if (t) parts.push(listCard(t));
        el.replaceChildren(...parts);
      }

      // ----- period + closures -----
      function termCard(t) {
        const d = ui.data;
        const card = h('section', { class: 'card', 'aria-labelledby': 'sx-term-h' });
        if (!t) {
          card.append(h('h2', { id: 'sx-term-h' }, 'Period'),
            h('p', { class: 'muted' }, editor
              ? 'No periods yet. Add one first (a month or a semester, for example Fall 2026 from Aug 17 to Dec 18), then publish its schedules.'
              : 'No periods yet. Your director sets the period and its schedules here.'),
            editor && h('button', { class: 'btn btn-primary', onclick: () => open({ type: 'term', term: null }) }, 'Add a period'));
          return card;
        }
        const pickTerm = d.terms.length > 1 && field('Showing period',
          h('select', { id: 'sx-term', onchange: e => { ui.termId = Number(e.target.value); ui.panel = null; draw(); } }, // a panel belongs to the period it opened in
            d.terms.map(x => h('option', { value: x.id, selected: x.id === t.id }, `${x.name} (${shortDate(x.start_date)} – ${shortDate(x.end_date, true)})`))));
        card.append(
          h('div', { class: 'row between' },
            h('div', null, h('h2', { id: 'sx-term-h' }, t.name), h('p', { class: 'muted', style: 'margin:0' }, `Period · ${shortDate(t.start_date, true)} – ${shortDate(t.end_date, true)}`)),
            editor && h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: () => open({ type: 'term', term: t }) }, 'Edit period'),
              h('button', { class: 'btn', onclick: () => open({ type: 'term', term: null }) }, 'Add a period'))),
          pickTerm || '');

        const closures = d.closures.filter(c => c.date >= t.start_date && c.date <= t.end_date);
        const confirmHost = h('div');
        card.append(h('div', { class: 'row between', style: 'margin-top:1rem' },
          h('h3', { style: 'margin:0' }, 'Closures'),
          editor && h('button', { class: 'btn', onclick: () => open({ type: 'closure' }) }, 'Add a closure')), confirmHost);
        if (!closures.length) {
          card.append(h('p', { class: 'muted' }, editor
            ? 'No closures this period. Add holidays here and families meeting that day are told right away.'
            : 'No closures this period.'));
          return card;
        }
        const list = h('ul', { class: 'list' });
        for (const c of closures) {
          const past = c.date < d.today;
          list.append(h('li', null,
            h('div', { class: 'grow' }, h('strong', null, longDate(c.date)), past && h('span', { class: 'badge', style: 'margin-left:.4rem' }, 'Past'),
              h('div', { class: 'muted small' }, c.reason || 'Closed')),
            editor && !past && h('button', { class: 'btn', 'aria-label': 'Reopen ' + longDate(c.date), onclick: async e => {
              const btn = e.currentTarget;
              const ok = await App.confirm({ el: confirmHost, opener: btn, title: `Reopen ${d.location.name} on ${longDate(c.date)}?`,
                body: 'Families meeting that day are told their schedules meet as usual.', confirmLabel: 'Reopen this day', cancelLabel: 'Keep closed' });
              if (!ok) return;
              await App.run(btn, async () => {
                const r = await App.api.del('/api/sessions/closures/' + c.id);
                App.toast(`${longDate(c.date)} is open again.` + told(r.notified));
                await reload();
              });
            } }, 'Reopen')));
        }
        card.append(list);
        return card;
      }

      // ----- the period's schedules -----
      function listCard(t) {
        const d = ui.data;
        const sessions = d.sessions.filter(s => s.term_id === t.id).sort((a, b) => a.start_time.localeCompare(b.start_time) || a.name.localeCompare(b.name));
        const card = h('section', { class: 'card', 'aria-labelledby': 'sx-list-h' },
          h('h2', { id: 'sx-list-h' }, 'Schedules'),
          h('p', { class: 'muted small' }, 'Seats are counted per date. Inside, students choose their own spot.'));
        if (!sessions.length) {
          card.append(h('p', { class: 'muted' }, editor
            ? `No schedules in ${t.name} yet. Publish the first one, for example Mornings MWF 9:00–12:00.`
            : `No schedules in ${t.name} yet. Your director publishes them here.`));
          return card;
        }
        const list = h('ul', { class: 'sx-list' });
        for (const s of sessions) {
          const change = nextChange(s);
          const kids = [
            h('strong', null, s.name),
            h('div', { class: 'sx-meta small' },
              s.weekdays.map(n => h('span', { class: 'badge', title: LONG[n] }, SHORT[n])),
              h('span', { class: 'muted' }, span(s))),
            h('div', { class: 'sx-meta small' },
              h('span', null, `${s.enrolled} of ${s.capacity} seats`),
              s.enrolled >= s.capacity && h('span', { class: 'badge badge-warn' }, 'Full'),
              s.waiting > 0 && h('span', { class: 'badge badge-accent' }, `${s.waiting} waiting`),
              h('span', { class: 'muted' }, plural(s.days_per_week, 'day a week', 'days a week'))),
            change && h('div', { class: 'small' }, change),
          ];
          list.append(h('li', null, editor
            ? h('button', { type: 'button', class: 'sx-slot', onclick: () => open({ type: 'session', session: s }) }, kids)
            : h('div', { class: 'sx-slot' }, kids)));
        }
        card.append(list);
        if (editor) card.append(h('p', { class: 'muted small', style: 'margin:.75rem 0 0' }, 'Select a schedule to change it, change one of its dates, or cancel it.'));
        return card;
      }

      // ----- panels -----
      function panel(p) {
        const box = h('section', { class: 'card', 'data-panel': p.type });
        if (p.type === 'session') sessionForm(box, p.session);
        if (p.type === 'term') termForm(box, p.term);
        if (p.type === 'closure') closureForm(box);
        return box;
      }

      function sessionForm(box, s) {
        const t = term();
        const name = h('input', { id: 'sx-name', required: true, maxlength: 80, autocomplete: 'off', value: s ? s.name : '' });
        const start = h('input', { id: 'sx-start', type: 'time', required: true, step: 300, value: s ? s.start_time : '13:00' });
        const end = h('input', { id: 'sx-end', type: 'time', required: true, step: 300, value: s ? s.end_time : '16:00' });
        const cap = h('input', { id: 'sx-cap', type: 'number', required: true, min: 1, max: 1000, step: 1, inputmode: 'numeric', value: s ? s.capacity : 20 });
        const locked = !!(s && s.days_locked);
        // D-45: once families are enrolled or waiting the days are fixed.
        const boxes = [1, 2, 3, 4, 5, 6, 7].map(d => h('input', { type: 'checkbox', value: d, checked: s ? s.weekdays.includes(d) : false, disabled: locked,
          'aria-describedby': locked ? 'sx-days-locked' : null }));
        const lenHint = h('p', { class: 'muted small', style: 'margin:-.4rem 0 .85rem', 'aria-live': 'polite' });
        const chosen = () => boxes.filter(b => b.checked).map(b => Number(b.value));
        function refresh() {
          const len = start.value && end.value ? mins(end.value) - mins(start.value) : null;
          lenHint.textContent = len == null ? 'Schedules run 2 to 3 hours.'
            : len <= 0 ? 'The end time needs to be after the start time.'
              : `This schedule is ${fmtLen(len).trim()}. Schedules run 2 to 3 hours.`;
        }
        [start, end].forEach(i => i.addEventListener('input', refresh));
        refresh();

        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, s ? 'Save changes' : 'Publish schedule');
        const form = h('form', { onsubmit: async e => {
          e.preventDefault();
          const body = { name: name.value, weekdays: chosen(), start_time: start.value, end_time: end.value, capacity: Number(cap.value) };
          await App.run(save, async () => {
            if (s) {
              const r = await App.api.put('/api/sessions/' + s.id, body);
              App.toast('Saved.' + told(r.notified));
            } else {
              await App.api.post('/api/sessions', Object.assign({ location_id: locId, term_id: t.id }, body));
              App.toast(`${body.name.trim()} added to ${t.name}.`);
            }
            await reload();
          });
        } },
          h('h2', null, s ? 'Change ' + s.name : 'New schedule in ' + t.name),
          field('Name', name, 'What families see, like "Mornings MWF".'),
          h('fieldset', null, h('legend', null, 'Days it meets'),
            h('div', { class: 'sx-days' }, boxes.map((b, i) => h('label', { class: 'check' }, b, LONG[i + 1]))),
            locked && h('p', { id: 'sx-days-locked', class: 'muted small' },
              'Families are enrolled or waiting, so the days are fixed. Use Skip, Move or Add a date below for single weeks, or cancel this schedule and publish a new one.')),
          h('div', { class: 'sx-pair' }, field('Starts', start), field('Ends', end)),
          lenHint,
          field('Seats', cap, 'How many students fit on each date. Students choose their own spot inside.'),
          s && h('p', { class: 'muted small' }, 'Enrolled families are told when the name, time or seats change.'),
          h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
        box.append(form);
        if (!s) return;

        box.append(datesSection(s));

        const cancelHost = h('div');
        const kill = h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
          const ok = await App.confirm({ el: cancelHost, opener: kill, title: `Cancel ${s.name}?`,
            body: `This ends ${spots(ends(s), s.waiting)}, and those families are told. This can't be undone.`,
            confirmLabel: 'Cancel schedule', cancelLabel: 'Keep schedule', danger: true,
          });
          if (!ok) return;
          await App.run(kill, async () => {
            const r = await App.api.post('/api/sessions/' + s.id + '/cancel');
            App.toast(`${s.name} is cancelled.` + told(r.notified));
            await reload();
          });
        } }, 'Cancel this schedule');
        box.append(h('div', { style: 'border-top:1px solid var(--line);margin-top:1rem;padding-top:1rem' },
          h('h3', null, 'Cancel this schedule'),
          h('p', { class: 'muted small' }, 'For one date, use Skip or Move above. For a holiday at the whole center, add a closure. Both keep everyone enrolled.'),
          cancelHost, kill));
      }

      // ----- one schedule's dates (D-46) -----
      function datesSection(s) {
        const sec = h('section', { 'aria-labelledby': 'sx-dates-h', style: 'border-top:1px solid var(--line);margin-top:1rem;padding-top:1rem' });
        const body = h('div', null, h('p', { class: 'muted small' }, 'Loading dates…'));
        const addHost = h('div');
        const addBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
          addHost.replaceChildren(dateForm({ action: 'add', s, opener: addBtn, onDone: () => addHost.replaceChildren() }));
          const f = addHost.querySelector('[data-date] input');
          if (f) f.focus();
        } }, 'Add a date');
        sec.append(h('div', { class: 'row between' }, h('h3', { id: 'sx-dates-h', style: 'margin:0' }, 'Dates'), addBtn), addHost, body);
        App.api.get('/api/sessions/' + s.id + '/dates').then(r => body.replaceChildren(...dateList(s, r)), e => {
          body.replaceChildren(h('p', { class: 'muted small' }, e.message || 'The dates could not load.'));
        });
        return sec;
      }

      function dateList(s, r) {
        const out = [h('p', { class: 'muted small' }, `Every date of ${r.term.name}. Skip or move a date for one week; families enrolled in ${s.name} are told.`)];
        const movedTo = new Map(r.dates.filter(x => x.moved_from).map(x => [x.moved_from, x.date]));
        let month = null, list = null;
        for (const d of r.dates) {
          const m = d.date.slice(0, 7);
          if (m !== month) {
            month = m;
            list = h('ul', { class: 'sx-list', style: 'gap:0' });
            out.push(h('h4', { class: 'sx-month' }, monthName(d.date)), list);
          }
          list.append(dateRow(s, d, movedTo.get(d.date)));
        }
        return out;
      }

      function dateRow(s, d, movedTo) {
        const li = h('li', { class: 'sx-date' });
        const badge = d.kind === 'added' ? h('span', { class: 'badge badge-accent' }, d.moved_from ? 'Moved here from ' + bare(d.moved_from) : 'Added date')
          : d.kind === 'skipped' ? h('span', { class: 'badge badge-warn' }, movedTo ? 'Moved to ' + bare(movedTo) : 'Skipped')
            : d.kind === 'closed' ? h('span', { class: 'badge' }, 'Center closed')
              : null;
        li.append(h('div', { class: 'grow' },
          h('span', { class: d.past ? 'muted' : null }, dayDate(d.date)), ' ', badge || '', d.past && h('span', { class: 'badge', style: 'margin-left:.4rem' }, 'Past'),
          d.reason && h('div', { class: 'muted small' }, d.reason)));
        if (d.past || !editor) return li;
        const host = h('div', { style: 'flex-basis:100%' });
        const acts = h('div', { class: 'sx-acts' });
        if (d.kind === 'regular') {
          const skip = h('button', { class: 'btn', type: 'button', 'aria-label': 'Skip ' + dayDate(d.date), onclick: async () => {
            // An optional reason (families see it, 3.1), right above the question.
            const reason = h('input', { id: 'sx-skip-reason', maxlength: 120, placeholder: 'For example, Staff training day' });
            const why = field('Reason (optional)', reason, 'Families see this.');
            host.replaceChildren(why);
            const ok = await App.confirm({ anchor: why, opener: skip, title: `Skip ${s.name} on ${dayDate(d.date)}?`,
              body: `${tellLine(s)} Their other dates go ahead as usual.`, confirmLabel: 'Skip this date', cancelLabel: 'Keep this date' });
            host.replaceChildren();
            if (!ok) return;
            await App.run(skip, async () => {
              const r = await App.api.post('/api/sessions/' + s.id + '/dates', { action: 'skip', date: d.date, reason: reason.value });
              App.toast(`${s.name} doesn't meet ${dayDate(d.date)}.` + told(r.notified));
              await reopen(s.id);
            });
          } }, 'Skip');
          const move = h('button', { class: 'btn', type: 'button', 'aria-label': 'Move ' + dayDate(d.date), onclick: () => {
            host.replaceChildren(dateForm({ action: 'move', s, from: d.date, opener: move, onDone: () => host.replaceChildren() }));
            const f = host.querySelector('[data-date] input');
            if (f) f.focus();
          } }, 'Move…');
          acts.append(skip, move);
        }
        if (d.kind === 'added' || d.kind === 'skipped') {
          const undo = h('button', { class: 'btn', type: 'button', 'aria-label': 'Undo the change on ' + dayDate(d.date), onclick: async () => {
            const pair = d.kind === 'added' ? d.moved_from : movedTo;
            const ok = await App.confirm({ el: host, opener: undo, title: `Undo the change on ${dayDate(d.date)}?`,
              body: (pair ? `This also undoes ${dayDate(pair)}. ` : '') + tellLine(s), confirmLabel: 'Undo change', cancelLabel: 'Keep change' });
            if (!ok) return;
            await App.run(undo, async () => {
              const r = await App.api.del('/api/sessions/' + s.id + '/dates/' + d.date);
              App.toast('Change undone.' + told(r.notified));
              await reopen(s.id);
            });
          } }, 'Undo');
          acts.append(undo);
        }
        li.append(acts, host);
        return li;
      }

      // Move one date (from -> a date input) or add one: a date, an optional reason, then confirm.
      function dateForm({ action, s, from, opener, onDone }) {
        const t = term(), today = ui.data.today;
        const min = t.start_date > today ? t.start_date : today;
        const id = 'sx-' + action + '-date';
        const date = h('input', { id, type: 'date', required: true, min, max: t.end_date });
        const reason = h('input', { id: 'sx-' + action + '-reason', maxlength: 120, placeholder: 'For example, Staff training day' });
        const confirmHost = h('div');
        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, action === 'move' ? 'Move this date' : 'Add this date');
        const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { onDone(); if (opener) opener.focus(); } }, 'Cancel');
        return h('form', { 'data-date': action, onsubmit: async e => {
          e.preventDefault();
          const day = date.value;
          if (!day) return;
          const ok = await App.confirm(action === 'move'
            ? { el: confirmHost, opener: save, title: `Move ${s.name} to ${dayDate(day)}?`,
              body: `It no longer meets ${dayDate(from)}. ${tellLine(s)}`, confirmLabel: 'Move and tell families', cancelLabel: 'Keep the date' }
            : { el: confirmHost, opener: save, title: `Add ${dayDate(day)} to ${s.name}?`,
              body: `${span(s)}, the schedule's usual time. ${tellLine(s)}`, confirmLabel: 'Add and tell families', cancelLabel: "Don't add" });
          if (!ok) return;
          await App.run(save, async () => {
            const b = action === 'move' ? { action, date: from, to: day, reason: reason.value } : { action, date: day, reason: reason.value };
            const r = await App.api.post('/api/sessions/' + s.id + '/dates', b);
            App.toast((action === 'move' ? `${s.name} moves to ${dayDate(day)}.` : `${s.name} also meets ${dayDate(day)}.`) + told(r.notified));
            await reopen(s.id);
          });
        } },
          h('h4', { style: 'margin:.5rem 0' }, action === 'move' ? `Move ${dayDate(from)}` : 'Add a date'),
          h('div', { class: 'sx-pair' },
            field(action === 'move' ? 'New date' : 'Date', date, `Inside ${t.name}, today or later. It meets at ${span(s)}.`),
            field('Reason (optional)', reason, 'Families see this.')),
          confirmHost,
          h('div', { class: 'row' }, save, cancel));
      }

      function termForm(box, t) {
        const name = h('input', { id: 'sx-tname', required: true, maxlength: 80, value: t ? t.name : '' });
        const start = h('input', { id: 'sx-tstart', type: 'date', required: true, value: t ? t.start_date : '' });
        const end = h('input', { id: 'sx-tend', type: 'date', required: true, value: t ? t.end_date : '' });
        const fill = add => { const [a, b] = monthOf(ui.data.today, add); start.value = a; end.value = b; };
        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, t ? 'Save period' : 'Add period');
        box.append(h('form', { onsubmit: async e => {
          e.preventDefault();
          const body = { name: name.value, start_date: start.value, end_date: end.value };
          await App.run(save, async () => {
            if (t) App.toast('Period saved.' + told((await App.api.put('/api/sessions/terms/' + t.id, body)).notified));
            else {
              ui.termId = (await App.api.post('/api/sessions/terms', Object.assign({ location_id: locId }, body))).term.id;
              App.toast(`${body.name.trim()} added.`);
            }
            await reload();
          });
        } },
          h('h2', null, t ? 'Edit ' + t.name : 'Add a period'),
          h('p', { class: 'muted small' }, 'A period is a month or a semester. Periods at one location can\'t overlap.'),
          field('Name', name, 'For example, November 2026 or Spring 2027.'),
          !t && h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => fill(0) }, 'This month'),
            h('button', { class: 'btn', type: 'button', onclick: () => fill(1) }, 'Next month')),
          h('div', { class: 'sx-pair' }, field('First day', start), field('Last day', end)),
          h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'))));
      }

      function closureForm(box) {
        const t = term(), loc = ui.data.location, today = ui.data.today;
        // Closures are for today or later (R3), inside the period.
        const date = h('input', { id: 'sx-cdate', type: 'date', required: true, min: t.start_date > today ? t.start_date : today, max: t.end_date });
        const reason = h('input', { id: 'sx-creason', maxlength: 120, placeholder: 'For example, Thanksgiving' });
        const confirmHost = h('div');
        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Close this day');
        box.append(h('form', { onsubmit: async e => {
          e.preventDefault();
          const day = date.value;
          const ok = await App.confirm({ el: confirmHost, opener: save, title: `Close ${loc.name} on ${longDate(day)}?`,
            body: 'Every schedule that day is cancelled and every family meeting that day is told now. Enrollments stay as they are.',
            confirmLabel: 'Close and tell families', cancelLabel: 'Keep it open',
          });
          if (!ok) return;
          await App.run(save, async () => {
            const r = await App.api.post('/api/sessions/closures', { location_id: locId, date: day, reason: reason.value });
            App.toast(`${loc.name} is closed ${longDate(day)}.` + told(r.notified));
            await reload();
          });
        } },
          h('h2', null, 'Add a closure'),
          h('p', { class: 'muted small' }, `Closures fall inside ${t.name} (${shortDate(t.start_date)} – ${shortDate(t.end_date, true)}), today or later.`),
          h('div', { class: 'sx-pair' }, field('Date', date), field('Reason (optional)', reason, 'Families see this.')),
          confirmHost,
          // L39: 'Cancel', not 'Close', beside 'Close this day': this one only shuts the form.
          h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
      }

      await load();
      draw();
    },
  });

  // L35: closure and schedule notices open the family's Schedule (enrollment's view),
  // or this Schedules screen for staff; the first one the role can open wins. A schedule
  // notice opens the tab of the student who holds that schedule (#/schedule/session/<id>).
  for (const refType of ['closure', 'session']) {
    App.inboxLink(refType, refType === 'session' ? n => 'schedule/session/' + n.ref_id : 'schedule');
    App.inboxLink(refType, 'sessions');
  }

  // ---------- Home card: today's schedules ----------
  App.card({
    id: 'sessions-today', roles: ['staff'], order: 40,
    async render(box) {
      style();
      const hq = App.role() === 'hq';
      let locId = App.me.user.location_id;
      let locations = [];
      if (hq) {
        locations = (await App.api.get('/api/locations')).locations;
        if (!locations.length) return;
        locId = locations[0].id;
      }
      async function draw() {
        const d = await App.api.get('/api/sessions/today?location_id=' + locId);
        const tz = d.location.timezone;
        const card = h('div', { class: 'card' },
          h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, "Today's schedules"),
            h('a', { class: 'btn btn-ghost', href: '#/sessions' + (hq ? '/' + locId : '') }, 'All schedules')));
        if (hq) {
          card.append(field('Location', h('select', { id: 'sx-home-loc', onchange: e => { locId = Number(e.target.value); draw(); } },
            locations.map(l => h('option', { value: l.id, selected: l.id === locId }, l.name)))));
        }
        if (d.closure) {
          card.append(h('div', { class: 'notice notice-warn', style: 'margin-top:.75rem' },
            `${d.location.name} is closed today${d.closure.reason ? ' (' + d.closure.reason + ')' : ''}. Schedules are cancelled.`));
        }
        if (!d.sessions.length) {
          card.append(h('p', { class: 'muted', style: 'margin:.75rem 0 0' }, `No schedules meet at ${d.location.name} today.`));
        } else {
          const list = h('ul', { class: 'list' });
          for (const s of d.sessions) {
            list.append(h('li', null,
              h('div', { class: 'grow' }, h('strong', null, s.name), s.added && h('span', { class: 'badge badge-accent', style: 'margin-left:.4rem' }, 'Added today'),
                h('div', { class: 'muted small' }, `${App.fmtTime(s.starts_at, tz)} – ${App.fmtTime(s.ends_at, tz)}`)),
              h('div', { style: 'text-align:right' },
                h('div', { class: 'sx-count' }, `${s.enrolled} of ${s.capacity}`),
                h('div', { class: 'muted small' }, s.enrolled >= s.capacity ? 'Full' : 'enrolled'),
                s.waiting > 0 && h('span', { class: 'badge badge-accent' }, `${s.waiting} waiting`))));
          }
          card.append(list);
        }
        box.replaceChildren(card);
      }
      await draw();
    },
  });
})();
