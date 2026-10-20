/* Sessions module views (SC-1..SC-4, NF-4).
   - "Sessions" screen (staff read-only; directors and HQ edit): the term, its
     closures and a weekly schedule with enrolled / capacity / waiting per day.
   - Home card for staff, directors and HQ: today's sessions at the location.
   All times are the location's own local times, labelled with its zone. */
(function () {
  'use strict';
  const { h } = App;
  const LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const CSS = `
    .sx-week { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
    .sx-day { background: var(--surface-2); border-radius: var(--radius-sm); padding: 10px; min-width: 0; }
    .sx-day h3 { font-size: .95rem; margin: 0 0 .5rem; display: flex; gap: .4rem; align-items: center; }
    .sx-slot { display: block; width: 100%; text-align: left; font: inherit; color: var(--text); background: var(--surface);
      border: 1px solid var(--line); border-radius: var(--radius-sm); padding: .6rem .7rem; margin-top: .5rem; min-height: 44px; overflow-wrap: anywhere; }
    .sx-day h3 + .sx-slot { margin-top: 0; }
    button.sx-slot { cursor: pointer; }
    button.sx-slot:hover { border-color: var(--brand); }
    .sx-meta { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin-top: .25rem; }
    .sx-days { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0 .75rem; }
    .sx-pair { display: grid; gap: 0 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .sx-count { font-weight: 700; white-space: nowrap; }
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
  const isoWeekday = d => (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7 + 1;
  function zoneName(tz) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(App.now()).find(p => p.type === 'timeZoneName').value;
    } catch (_) { return tz; }
  }
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint && h('div', { class: 'hint' }, hint));
  // Enrollments a day or session ends: active and paused alike (D-26).
  const ends = x => x.enrolled + (x.paused || 0);

  // ---------- the Sessions screen ----------
  App.register({
    id: 'sessions', title: 'Sessions', icon: '🗓️', roles: ['staff'], order: 70,
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
          el.append(h('div', { class: 'page-head' }, h('h1', null, 'Sessions')),
            h('div', { class: 'card empty' }, 'No locations yet. Once a location exists, its weekly sessions are built here.'));
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

      function draw() {
        const d = ui.data, loc = d.location, t = term();
        const head = h('div', { class: 'page-head' },
          h('div', null, h('h1', null, 'Sessions'),
            h('p', null, `${loc.name} · all times are ${loc.name} time (${zoneName(loc.timezone)})`)),
          editor && t && h('button', { class: 'btn btn-primary', onclick: () => open({ type: 'session', session: null }) }, '+ New session'));
        const parts = [head];
        if (hq) {
          const sel = h('select', { id: 'sx-loc', onchange: e => App.go('sessions', e.target.value) },
            locations.map(l => h('option', { value: l.id, selected: l.id === locId }, l.name)));
          parts.push(h('div', { class: 'card' }, field('Location', sel)));
        }
        if (ui.panel) parts.push(panel(ui.panel));
        parts.push(termCard(t));
        if (t) parts.push(weekCard(t));
        el.replaceChildren(...parts);
      }

      // ----- term + closures -----
      function termCard(t) {
        const d = ui.data;
        const card = h('section', { class: 'card', 'aria-labelledby': 'sx-term-h' });
        if (!t) {
          card.append(h('h2', { id: 'sx-term-h' }, 'Term'),
            h('p', { class: 'muted' }, editor
              ? 'No terms yet. Add one first (for example, Fall 2026 from Aug 17 to Dec 18), then build its weekly sessions.'
              : 'No terms yet. Your director sets the term and its sessions here.'),
            editor && h('button', { class: 'btn btn-primary', onclick: () => open({ type: 'term', term: null }) }, 'Add a term'));
          return card;
        }
        const pickTerm = d.terms.length > 1 && field('Showing term',
          h('select', { id: 'sx-term', onchange: e => { ui.termId = Number(e.target.value); draw(); } },
            d.terms.map(x => h('option', { value: x.id, selected: x.id === t.id }, `${x.name} (${shortDate(x.start_date)} – ${shortDate(x.end_date, true)})`))));
        card.append(
          h('div', { class: 'row between' },
            h('div', null, h('h2', { id: 'sx-term-h' }, t.name), h('p', { class: 'muted', style: 'margin:0' }, `${shortDate(t.start_date, true)} – ${shortDate(t.end_date, true)}`)),
            editor && h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: () => open({ type: 'term', term: t }) }, 'Edit term'),
              h('button', { class: 'btn', onclick: () => open({ type: 'term', term: null }) }, 'Add a term'))),
          pickTerm || '');

        const closures = d.closures.filter(c => c.date >= t.start_date && c.date <= t.end_date);
        const confirmHost = h('div');
        card.append(h('div', { class: 'row between', style: 'margin-top:1rem' },
          h('h3', { style: 'margin:0' }, 'Closures'),
          editor && h('button', { class: 'btn', onclick: () => open({ type: 'closure' }) }, 'Add a closure')), confirmHost);
        if (!closures.length) {
          card.append(h('p', { class: 'muted' }, editor
            ? 'No closures this term. Add holidays here and families enrolled that day are told right away.'
            : 'No closures this term.'));
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
                body: 'Families enrolled that day are told their sessions meet as usual.', confirmLabel: 'Reopen this day', cancelLabel: 'Keep closed' });
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

      // ----- weekly schedule -----
      function weekCard(t) {
        const d = ui.data;
        const sessions = d.sessions.filter(s => s.term_id === t.id);
        const card = h('section', { class: 'card', 'aria-labelledby': 'sx-week-h' },
          h('h2', { id: 'sx-week-h' }, 'Weekly schedule'),
          h('p', { class: 'muted small' }, 'Seats are counted per day. Inside, students choose their own spot.'));
        if (!sessions.length) {
          card.append(h('p', { class: 'muted' }, editor
            ? `No sessions in ${t.name} yet. Add the first one, for example Mon/Wed/Fri 1–4pm.`
            : `No sessions in ${t.name} yet. Your director adds them here.`));
          return card;
        }
        const inTerm = d.today >= t.start_date && d.today <= t.end_date;
        const todayWd = isoWeekday(d.today);
        const days = [1, 2, 3, 4, 5, 6, 7].filter(n => n <= 5 || sessions.some(s => s.weekdays.includes(n)));
        const week = h('div', { class: 'sx-week' });
        for (const day of days) {
          const col = h('div', { class: 'sx-day' },
            h('h3', null, LONG[day], inTerm && day === todayWd && h('span', { class: 'badge badge-accent' }, 'Today')));
          const here = sessions.filter(s => s.weekdays.includes(day)).sort((a, b) => a.start_time.localeCompare(b.start_time));
          if (!here.length) col.append(h('p', { class: 'muted small', style: 'margin:0' }, 'No sessions'));
          for (const s of here) {
            const slot = s.slots.find(x => x.weekday === day) || { enrolled: 0, waiting: 0 };
            const kids = [
              // L41: the day is part of the button's name, so Mon/Wed/Fri buttons don't all sound alike.
              h('span', { class: 'sr-only' }, LONG[day] + ': '),
              h('strong', null, s.name),
              h('div', { class: 'muted small' }, span(s)),
              h('div', { class: 'sx-meta small' },
                h('span', null, `${slot.enrolled} of ${s.capacity} enrolled`),
                slot.enrolled >= s.capacity && h('span', { class: 'badge badge-warn' }, 'Full'),
                slot.waiting > 0 && h('span', { class: 'badge badge-accent' }, `${slot.waiting} waiting`)),
            ];
            col.append(editor
              ? h('button', { type: 'button', class: 'sx-slot', onclick: () => open({ type: 'session', session: s }) }, kids)
              : h('div', { class: 'sx-slot' }, kids));
          }
          week.append(col);
        }
        card.append(week);
        if (editor) card.append(h('p', { class: 'muted small', style: 'margin:.75rem 0 0' }, 'Select a session to change or cancel it.'));
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
        const boxes = [1, 2, 3, 4, 5, 6, 7].map(d => h('input', { type: 'checkbox', value: d, checked: s ? s.weekdays.includes(d) : false }));
        const lenHint = h('p', { class: 'muted small', style: 'margin:-.4rem 0 .85rem', 'aria-live': 'polite' });
        const dropWarn = h('div', { 'aria-live': 'polite' });
        const confirmHost = h('div');
        const chosen = () => boxes.filter(b => b.checked).map(b => Number(b.value));
        // Days being taken off that still have families on them.
        const losing = () => !s ? [] : s.slots.filter(x => !chosen().includes(x.weekday) && (ends(x) || x.waiting));
        function refresh() {
          const len = start.value && end.value ? mins(end.value) - mins(start.value) : null;
          lenHint.textContent = len == null ? 'Sessions run 2 to 3 hours.'
            : len <= 0 ? 'The end time needs to be after the start time.'
              : `This session is ${fmtLen(len).trim()}. Sessions run 2 to 3 hours.`;
          const lost = losing();
          dropWarn.replaceChildren(lost.length ? h('div', { class: 'notice notice-warn' },
            `Taking off ${lost.map(x => LONG[x.weekday]).join(' and ')} ends ${spots(lost.reduce((n, x) => n + ends(x), 0), lost.reduce((n, x) => n + x.waiting, 0))} for that day. Those families will be told.`) : '');
        }
        [start, end].forEach(i => i.addEventListener('input', refresh));
        boxes.forEach(b => b.addEventListener('change', refresh));
        refresh();

        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, s ? 'Save changes' : 'Create session');
        const form = h('form', { onsubmit: async e => {
          e.preventDefault();
          const body = { name: name.value, weekdays: chosen(), start_time: start.value, end_time: end.value, capacity: Number(cap.value) };
          const lost = losing();
          if (lost.length && !(await App.confirm({ el: confirmHost, opener: save,
            title: `Stop meeting on ${lost.map(x => LONG[x.weekday]).join(' and ')}?`,
            body: 'Enrollments and waitlist spots for that day end, and those families are told. This can\'t be undone.',
            confirmLabel: 'End that day and save', cancelLabel: 'Keep that day', danger: true,
          }))) return;
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
          h('h2', null, s ? 'Change ' + s.name : 'New session in ' + t.name),
          field('Name', name, 'What families see, like "Afternoon Study".'),
          h('fieldset', null, h('legend', null, 'Days it meets'),
            h('div', { class: 'sx-days' }, boxes.map((b, i) => h('label', { class: 'check' }, b, LONG[i + 1])))),
          h('div', { class: 'sx-pair' }, field('Starts', start), field('Ends', end)),
          lenHint,
          field('Seats per day', cap, 'How many students fit on each day. Students choose their own spot inside.'),
          dropWarn,
          s && h('p', { class: 'muted small' }, 'Enrolled families are told when the name, time or seats change.'),
          confirmHost,
          h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
        box.append(form);

        if (s) {
          const cancelHost = h('div');
          const enrolled = s.slots.reduce((n, x) => n + ends(x), 0), waiting = s.slots.reduce((n, x) => n + x.waiting, 0);
          const kill = h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
            const ok = await App.confirm({ el: cancelHost, opener: kill, title: `Cancel ${s.name}?`,
              body: `This ends ${spots(enrolled, waiting)}, and those families are told. This can't be undone.`,
              confirmLabel: 'Cancel session', cancelLabel: 'Keep session', danger: true,
            });
            if (!ok) return;
            await App.run(kill, async () => {
              const r = await App.api.post('/api/sessions/' + s.id + '/cancel');
              App.toast(`${s.name} is cancelled.` + told(r.notified));
              await reload();
            });
          } }, 'Cancel this session');
          box.append(h('div', { style: 'border-top:1px solid var(--line);margin-top:1rem;padding-top:1rem' },
            h('h3', null, 'Cancel this session'),
            h('p', { class: 'muted small' }, 'For a one-day closure, add a closure instead. That keeps everyone enrolled.'),
            cancelHost, kill));
        }
      }

      function termForm(box, t) {
        const name = h('input', { id: 'sx-tname', required: true, maxlength: 80, value: t ? t.name : '' });
        const start = h('input', { id: 'sx-tstart', type: 'date', required: true, value: t ? t.start_date : '' });
        const end = h('input', { id: 'sx-tend', type: 'date', required: true, value: t ? t.end_date : '' });
        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, t ? 'Save term' : 'Add term');
        box.append(h('form', { onsubmit: async e => {
          e.preventDefault();
          const body = { name: name.value, start_date: start.value, end_date: end.value };
          await App.run(save, async () => {
            if (t) App.toast('Term saved.' + told((await App.api.put('/api/sessions/terms/' + t.id, body)).notified));
            else {
              ui.termId = (await App.api.post('/api/sessions/terms', Object.assign({ location_id: locId }, body))).term.id;
              App.toast(`${body.name.trim()} added.`);
            }
            await reload();
          });
        } },
          h('h2', null, t ? 'Edit ' + t.name : 'Add a term'),
          field('Name', name, 'For example, Spring 2027.'),
          h('div', { class: 'sx-pair' }, field('First day', start), field('Last day', end)),
          h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'))));
      }

      function closureForm(box) {
        const t = term(), loc = ui.data.location, today = ui.data.today;
        // Closures are for today or later (R3), inside the term.
        const date = h('input', { id: 'sx-cdate', type: 'date', required: true, min: t.start_date > today ? t.start_date : today, max: t.end_date });
        const reason = h('input', { id: 'sx-creason', maxlength: 120, placeholder: 'For example, Thanksgiving' });
        const confirmHost = h('div');
        const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Close this day');
        box.append(h('form', { onsubmit: async e => {
          e.preventDefault();
          const day = date.value;
          const ok = await App.confirm({ el: confirmHost, opener: save, title: `Close ${loc.name} on ${longDate(day)}?`,
            body: 'Sessions that day are cancelled and every family enrolled that day is told now. Enrollments stay as they are.',
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

  // L35: closure and session notices open the family's Schedule (enrollment's view),
  // or this Sessions screen for staff; the first one the role can open wins.
  for (const refType of ['closure', 'session']) {
    App.inboxLink(refType, 'schedule');
    App.inboxLink(refType, 'sessions');
  }

  // ---------- Home card: today's sessions ----------
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
          h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, "Today's sessions"),
            h('a', { class: 'btn btn-ghost', href: '#/sessions' + (hq ? '/' + locId : '') }, 'Full schedule')));
        if (hq) {
          card.append(field('Location', h('select', { id: 'sx-home-loc', onchange: e => { locId = Number(e.target.value); draw(); } },
            locations.map(l => h('option', { value: l.id, selected: l.id === locId }, l.name)))));
        }
        if (d.closure) {
          card.append(h('div', { class: 'notice notice-warn', style: 'margin-top:.75rem' },
            `${d.location.name} is closed today${d.closure.reason ? ' (' + d.closure.reason + ')' : ''}. Sessions are cancelled.`));
        }
        if (!d.sessions.length) {
          card.append(h('p', { class: 'muted', style: 'margin:.75rem 0 0' }, `No sessions meet at ${d.location.name} today.`));
        } else {
          const list = h('ul', { class: 'list' });
          for (const s of d.sessions) {
            list.append(h('li', null,
              h('div', { class: 'grow' }, h('strong', null, s.name),
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
