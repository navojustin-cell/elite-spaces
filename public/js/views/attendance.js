/* Attendance and hours (PRD 7).
   Parents: "Hours" - each student's visits, hours and absences by week, month or
   term (AT-1, AT-2), and a PDF or CSV log for any date range (AT-3).
   Directors and HQ: "Reports" - visits, hours and absences filtered by location,
   session and dates, with CSV and PDF downloads (AT-4). Staff don't get reports.
   Visit times always show in the location's own zone. */
(function () {
  'use strict';
  const { h } = App;
  const API = '/api/attendance';

  // A few layout rules app.css doesn't have.
  document.head.append(h('style', null, `
    .att-nav { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: 12px; }
    .att-nav .btn { min-width: 44px; padding: .55rem .8rem; font-size: 1.25rem; line-height: 1; }
    .att-nav-label { text-align: center; min-width: 0; }
    .att-nav-label h2 { margin: 0; }
    .att-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; text-align: center; }
    .att-stats > div { min-width: 0; overflow-wrap: anywhere; }
    .att-stats.att-four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (min-width: 560px) { .att-stats.att-four { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .att-range { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0 12px; }
    .att-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 12px; }
    .att-chips { margin-bottom: .85rem; }
    .att-chips .btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
    .att-auto { color: var(--warn); }
    .att-nowrap { white-space: nowrap; }
    .card > .att-list > li:first-child { padding-top: 0; }
    .card > .att-list > li:last-child { padding-bottom: 0; }
  `));

  const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  // Decimal hours always with two places, as the PDF and CSV print them: "8.50".
  // The server's hours are the sum of each visit's rounded hours, so they match the files' columns (L61).
  const hours = n => n.toFixed(2);
  const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const longDate = iso => App.fmtDate(iso, { weekday: undefined, year: 'numeric' });
  const first = name => String(name || '').split(' ')[0];

  // How a visit ended (AT-1), always as words, never color alone.
  const ENDED = {
    scan: ['Scanned out', 'badge-ok'],
    auto: ['Auto check-out', 'badge-warn'],
    staff: ['Checked out by staff', ''],
  };
  const endedBadge = v => {
    const [label, cls] = v.check_out_at == null ? ['In the building', 'badge-accent'] : (ENDED[v.checkout_method] || ['Checked out', '']);
    return h('span', { class: 'badge ' + cls }, label);
  };
  const timeSpan = v => App.fmtTime(v.check_in_at, v.timezone) + ' – ' + (v.check_out_at == null ? 'now' : App.fmtTime(v.check_out_at, v.timezone));

  const stat = (value, label) => h('div', null, h('div', { class: 'stat' }, value), h('div', { class: 'stat-label' }, label));

  // Fetches a CSV or PDF and saves it. Errors (a bad range, no access) come back as toasts via App.run.
  async function download(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = 'We couldn\'t create that file. Please try again.';
      try { msg = (await res.json()).message || msg; } catch (_) { /* not JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const name = ((res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'attendance';
    const a = h('a', { href: URL.createObjectURL(blob), download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    App.toast('Downloaded ' + name);
  }

  // Range shortcut chips plus labelled From / To date inputs.
  function rangePicker(presets, state, onChange) {
    const from = h('input', { type: 'date', value: state.from, required: true });
    const to = h('input', { type: 'date', value: state.to, required: true });
    const chips = presets.map(p => h('button', { type: 'button', class: 'btn', 'data-from': p.from, 'data-to': p.to,
      onclick: () => { from.value = p.from; to.value = p.to; changed(); } }, p.label));
    const mark = () => chips.forEach(c => c.setAttribute('aria-pressed', String(c.dataset.from === from.value && c.dataset.to === to.value)));
    const changed = () => { state.from = from.value; state.to = to.value; mark(); onChange(); };
    from.addEventListener('change', changed);
    to.addEventListener('change', changed);
    mark();
    return h('div', null,
      h('div', { class: 'row att-chips', role: 'group', 'aria-label': 'Quick ranges' }, chips),
      h('div', { class: 'att-range' },
        h('label', { class: 'field' }, h('span', null, 'From'), from),
        h('label', { class: 'field' }, h('span', null, 'To'), to)));
  }

  // ===================================================================== parent: Hours

  // Lives as long as the tab, but belongs to whoever chose it (`owner`, a user id).
  const hoursState = { owner: null, studentId: null, period: 'week', date: null, from: null, to: null };
  const PERIODS = [['week', 'Week'], ['month', 'Month'], ['term', 'Term']];

  App.register({
    id: 'hours', title: 'Hours', icon: '⏱️', roles: ['parent'], order: 40,
    async render(el) {
      // Someone else signed in on this tab: start from this week and this month.
      if (hoursState.owner !== App.me.user.id) {
        Object.assign(hoursState, { owner: App.me.user.id, studentId: null, period: 'week', date: null, from: null, to: null });
      }
      const { students } = await App.api.get(API + '/students');
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Hours'),
        h('p', null, 'Visits, study hours and absences, ready for your homeschool records.'))));
      if (!students.length) {
        el.append(h('div', { class: 'card empty' }, 'No students linked yet. Once you approve your student\'s account, their visits and hours will show up here.'));
        return;
      }
      let student = students.find(s => s.id === hoursState.studentId) || students[0];
      hoursState.studentId = student.id;

      const history = h('section', { id: 'att-history', role: 'tabpanel', 'aria-labelledby': 'att-tab-' + hoursState.period });
      const exportCard = h('section', { class: 'card', 'aria-labelledby': 'att-export-h' });

      if (students.length > 1) {
        const pickStudent = h('select', { id: 'att-student', onchange: () => {
          student = students.find(s => s.id === Number(pickStudent.value));
          hoursState.studentId = student.id;
          hoursState.date = null;
          drawHistory();
          drawExport();
        } }, students.map(s => h('option', { value: s.id, selected: s.id === student.id }, s.name)));
        el.append(h('label', { class: 'field' }, h('span', null, 'Student'), pickStudent));
      }

      const tabs = PERIODS.map(([k, label]) => h('button', { type: 'button', role: 'tab', id: 'att-tab-' + k, 'aria-controls': 'att-history',
        'aria-selected': String(k === hoursState.period), onclick: () => {
          hoursState.period = k;
          hoursState.date = null;
          tabs.forEach(t => t.setAttribute('aria-selected', String(t.id === 'att-tab-' + k)));
          history.setAttribute('aria-labelledby', 'att-tab-' + k);
          drawHistory();
        } }, label));
      el.append(h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Show hours by' }, tabs), history, exportCard);

      let seq = 0;
      async function drawHistory() {
        const mine = ++seq;
        history.replaceChildren(h('div', { class: 'empty', 'aria-busy': 'true' }, 'Loading…'));
        let data;
        try {
          data = await App.api.get(`${API}/students/${student.id}/history?` + qs({ period: hoursState.period, date: hoursState.date }));
        } catch (e) {
          if (mine === seq) history.replaceChildren(h('div', { class: 'notice notice-warn', role: 'alert' }, e.message));
          return;
        }
        if (mine !== seq) return;
        const p = data.period, t = data.totals, loc = data.student.location;
        const go = date => { hoursState.date = date; drawHistory(); };
        const nav = h('div', { class: 'att-nav' },
          h('button', { type: 'button', class: 'btn', 'aria-label': 'Previous ' + p.kind, disabled: !p.prev, onclick: () => go(p.prev) }, '‹'),
          h('div', { class: 'att-nav-label' }, h('h2', null, p.label), p.kind === 'term' && h('div', { class: 'muted small' }, p.dates)),
          h('button', { type: 'button', class: 'btn', 'aria-label': 'Next ' + p.kind, disabled: !p.next, onclick: () => go(p.next) }, '›'));

        const items = [
          ...data.visits.map(v => ({ date: v.date, at: v.check_in_local, el: visitItem(v) })),
          ...data.absences.map(a => ({ date: a.date, at: a.start_time, el: absenceItem(a) })),
        ].sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at));

        history.replaceChildren(
          nav,
          h('div', { class: 'card att-stats' }, stat(t.visits, t.visits === 1 ? 'visit' : 'visits'), stat(hours(t.hours), 'hours'),
            stat(t.absences, t.absences === 1 ? 'absence' : 'absences')),
          items.length
            ? h('div', { class: 'card' }, h('ul', { class: 'list att-list', 'aria-label': `${student.name}, ${p.label}` }, items.map(i => i.el)))
            : h('div', { class: 'card empty' }, h('p', null, `Nothing recorded for ${p.kind === 'week' ? 'the week of ' + p.label : p.label}.`),
              h('p', { class: 'small', style: 'margin:0' }, `Visits show up here as soon as ${first(student.name)} checks in. A missed session shows as an absence once it's over.`)),
          h('p', { class: 'muted small' }, `Times are ${loc.name} time. An absence is a scheduled session with no check-in; closure days don't count.`));
      }

      function visitItem(v) {
        return h('li', null,
          h('div', { class: 'grow' },
            h('div', null, h('strong', null, App.fmtDate(v.date)), ' · ', v.session_name || 'Visit'),
            h('div', { class: 'muted small' }, timeSpan(v) + (v.minutes != null ? ' · ' + App.fmtDuration(v.minutes) : '')),
            v.checkout_method === 'auto' && h('div', { class: 'small att-auto' }, 'Didn\'t scan out, so they were checked out automatically.')),
          endedBadge(v));
      }
      function absenceItem(a) {
        return h('li', null,
          h('div', { class: 'grow' },
            h('div', null, h('strong', null, App.fmtDate(a.date)), ' · ', a.session_name),
            h('div', { class: 'muted small' }, 'Scheduled ' + App.hhmm(a.start_time) + '–' + App.hhmm(a.end_time) + ' · no check-in')),
          h('span', { class: 'badge badge-danger' }, 'Absent'));
      }

      function drawExport() {
        if (!hoursState.from) {
          const month = student.presets.find(p => p.id === 'this_month') || student.presets[0];
          hoursState.from = month.from;
          hoursState.to = month.to;
        }
        const preview = h('p', { class: 'muted small', 'aria-live': 'polite' });
        let pseq = 0;
        const refresh = async () => {
          const mine = ++pseq;
          if (!hoursState.from || !hoursState.to) { preview.textContent = 'Choose a start date and an end date.'; return; }
          try {
            const log = await App.api.get(`${API}/students/${student.id}/log?` + qs({ from: hoursState.from, to: hoursState.to }));
            if (mine === pseq) preview.textContent = `${log.label}: ${count(log.totals.visits, 'visit', 'visits')} · ${hours(log.totals.hours)} hours · ${count(log.totals.absences, 'absence', 'absences')}`;
          } catch (e) { if (mine === pseq) preview.textContent = e.message; }
        };
        const file = ext => `${API}/students/${student.id}/log.${ext}?` + qs({ from: hoursState.from, to: hoursState.to });
        exportCard.replaceChildren(
          h('h2', { id: 'att-export-h' }, 'Download a log'),
          h('p', { class: 'muted' }, `${student.name}'s visits, times, hours and absences for the dates you choose. The PDF is ready to hand to an evaluator; the CSV opens in any spreadsheet.`),
          rangePicker(student.presets, hoursState, refresh),
          preview,
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: e => App.run(e.currentTarget, () => download(file('pdf'))) }, 'Download PDF'),
            h('button', { type: 'button', class: 'btn', onclick: e => App.run(e.currentTarget, () => download(file('csv'))) }, 'Download CSV')));
        refresh();
      }

      drawHistory();
      drawExport();
    },
  });

  // Home: this week's hours per student.
  App.card({
    id: 'attendance-hours', roles: ['parent'], order: 40,
    async render(box) {
      const { students } = await App.api.get(API + '/students');
      if (!students.length) { box.hidden = true; return; }
      box.append(h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Hours this week'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => App.go('hours') }, 'View hours')),
        h('ul', { class: 'list' }, students.map(s => h('li', null,
          h('div', { class: 'grow' }, h('strong', null, s.name),
            h('div', { class: 'muted small' }, s.week.totals.visits
              ? `${count(s.week.totals.visits, 'visit', 'visits')} · ${hours(s.week.totals.hours)} hours`
              : 'No visits yet this week')),
          h('div', { class: 'muted small' }, `${hours(s.month.totals.hours)} hours in ${s.month.label.split(' ')[0]}`))))));
    },
  });

  // ===================================================================== directors and HQ: Reports

  // The filters live as long as the tab, but belong to whoever chose them (`owner`, a user id).
  const repState = { owner: null, location: null, session: '', from: null, to: null, tab: 'students' };

  // When a report has no absences, the Absences tab says why, by where its range
  // stands against today (the report's `timing`): a session still ahead can't be missed.
  const NO_ABSENCES = {
    upcoming: 'No sessions in this range have happened yet, so nobody has missed one.',
    current: 'No absences so far. Every session that has ended had a check-in, or was a closure day.',
    past: 'No absences in this range. Every scheduled session had a check-in, or was a closure day.',
  };

  App.register({
    id: 'reports', title: 'Reports', icon: '📊', roles: ['director'], order: 40,
    async render(el) {
      const opts = await App.api.get(API + '/report/options');
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Attendance reports'),
        h('p', null, 'Visits, hours and absences by location, session and dates.'))));
      if (!opts.locations.length) {
        el.append(h('div', { class: 'card empty' }, 'There are no locations to report on yet.'));
        return;
      }
      // Someone else signed in on this tab (HQ after a director, or the other way): start over.
      if (repState.owner !== App.me.user.id) Object.assign(repState, { owner: App.me.user.id, location: null, tab: 'students' });
      // Start over too when the filters name a location this person can't report on
      // (a director moved to another location).
      const canReport = (opts.all_locations && repState.location === 'all') || opts.locations.some(l => String(l.id) === repState.location);
      if (!canReport) {
        Object.assign(repState, { location: opts.all_locations ? 'all' : String(opts.locations[0].id), session: '', from: null, to: null });
      }
      const locOf = () => opts.locations.find(l => String(l.id) === repState.location) || opts.locations[0];
      if (!repState.from) {
        const month = locOf().presets.find(p => p.id === 'this_month');
        repState.from = month.from;
        repState.to = month.to;
      }

      // A changed filter leaves the report on screen as it was until Show report: it
      // says it's out of date and its downloads wait, so a file is never a different
      // report from the one the filters name. `shown`: the filters of the report on screen.
      const status = h('div', { role: 'status' });
      let shown = null, downloads = [];
      const chosen = () => qs({ location: repState.location, session: repState.session, from: repState.from, to: repState.to });
      function markStale() {
        const stale = shown != null && shown !== chosen();
        downloads.forEach(b => { b.disabled = stale; });
        status.replaceChildren(stale ? h('div', { class: 'notice notice-warn' },
          'The filters have changed. Tap Show report to update the report and its downloads.') : '');
      }

      // With every location, each session says where it is: two locations can run one by the same name.
      const sessionOption = (s, loc) => h('option', { value: s.id },
        (loc ? loc.name + ' · ' : '') + s.label + (s.status === 'cancelled' ? ' (cancelled)' : ''));
      const pickSession = h('select', { id: 'rep-session', onchange: () => { repState.session = pickSession.value; markStale(); } });
      const fillSessions = () => {
        const options = repState.location === 'all'
          ? opts.locations.flatMap(l => l.sessions.map(s => sessionOption(s, l)))
          : locOf().sessions.map(s => sessionOption(s));
        pickSession.replaceChildren(h('option', { value: '' }, 'All sessions'), ...options);
        pickSession.value = repState.session;
        if (pickSession.value !== String(repState.session)) { repState.session = ''; pickSession.value = ''; }
      };
      fillSessions();

      // The range shortcuts are the chosen location's own (its week, month and term, by
      // its own date). A new location redraws them, and a shortcut that was chosen
      // stays chosen: "Fall 2026" becomes that location's Fall 2026.
      let presets = locOf().presets;
      const range = h('div', null, rangePicker(presets, repState, markStale));
      const redrawRange = () => {
        const was = presets.find(p => p.from === repState.from && p.to === repState.to);
        presets = locOf().presets;
        const same = was && presets.find(p => p.id === was.id);
        if (same) Object.assign(repState, { from: same.from, to: same.to });
        range.replaceChildren(rangePicker(presets, repState, markStale));
      };

      let locationField;
      if (opts.all_locations) {
        const pickLocation = h('select', { id: 'rep-location', onchange: () => {
          repState.location = pickLocation.value; repState.session = ''; fillSessions(); redrawRange(); markStale();
        } }, h('option', { value: 'all' }, 'All locations'), opts.locations.map(l => h('option', { value: l.id }, l.name)));
        pickLocation.value = repState.location;
        locationField = h('label', { class: 'field' }, h('span', null, 'Location'), pickLocation);
      } else {
        locationField = h('p', null, h('strong', null, 'Location: '), opts.locations[0].name);
      }

      const results = h('section', { 'aria-busy': 'false', 'aria-label': 'Report' });
      const form = h('form', { class: 'card', onsubmit: e => { e.preventDefault(); draw(); } },
        h('div', { class: 'att-filters' }, locationField, h('label', { class: 'field' }, h('span', null, 'Session'), pickSession)),
        range,
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Show report'));
      el.append(form, status, results);

      let seq = 0;
      async function draw() {
        const mine = ++seq;
        results.setAttribute('aria-busy', 'true');
        const filter = { location: repState.location, session: repState.session, from: repState.from, to: repState.to };
        let rep;
        try { rep = await App.api.get(API + '/report?' + qs(filter)); } catch (e) {
          if (mine === seq) {
            results.replaceChildren(h('div', { class: 'notice notice-warn', role: 'alert' }, e.message));
            results.setAttribute('aria-busy', 'false');
            shown = null; downloads = []; markStale();
          }
          return;
        }
        if (mine !== seq) return;
        results.setAttribute('aria-busy', 'false');
        const all = !rep.filters.location;
        const where = (all ? 'All locations' : rep.filters.location.name) + ' · ' + (rep.filters.session ? rep.filters.session.label : 'All sessions');
        const t = rep.totals;
        const file = ext => `${API}/report.${ext}?` + qs(filter);
        // App.run turns a button back on when it's done; a report gone out of date meanwhile turns it off again.
        const dl = (label, ext) => h('button', { type: 'button', class: 'btn',
          onclick: e => App.run(e.currentTarget, () => download(file(ext))).then(markStale) }, label);
        shown = qs(filter);
        downloads = [dl('Download CSV', 'csv'), dl('Download PDF', 'pdf')];
        // Staff and directors confirm automatic check-outs on In the building, at the location of
        // the visits. Across all locations: a link to each location that has some, with its count.
        const toBuilding = (id, label) => h('a', { href: '#/building/' + id }, label);
        let reviewAt;
        if (all) {
          const at = new Map(); // location id -> { name, n }
          for (const v of rep.visits.filter(x => x.needs_review)) {
            if (!at.has(v.location_id)) at.set(v.location_id, { name: v.location_name, n: 0 });
            at.get(v.location_id).n++;
          }
          const links = [...at].sort(([, a], [, b]) => a.name.localeCompare(b.name)).map(([id, l]) => [toBuilding(id, l.name), ` (${l.n})`]);
          reviewAt = ['In the building at ', links.map((l, i) => (i ? [', ', l] : l)), '.'];
        } else {
          reviewAt = ['the ', toBuilding(rep.filters.location.id, 'In the building'), ' list.'];
        }
        const panel = h('div', { id: 'rep-panel', role: 'tabpanel' });
        const TABS = [['students', 'By student'], ['visits', 'Visits'], ['absences', 'Absences']];
        const tabs = TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', id: 'rep-tab-' + k, 'aria-controls': 'rep-panel',
          'aria-selected': String(k === repState.tab), onclick: () => { repState.tab = k; showTab(); } }, label));
        const noVisits = `No visits between ${longDate(rep.filters.from)} and ${longDate(rep.filters.to)} for ${where}.`;

        const showTab = () => {
          tabs.forEach(b => b.setAttribute('aria-selected', String(b.id === 'rep-tab-' + repState.tab)));
          panel.setAttribute('aria-labelledby', 'rep-tab-' + repState.tab);
          if (repState.tab === 'students') {
            panel.replaceChildren(rep.by_student.length ? table(['Student', 'Visits', 'Hours', 'Absences'],
              rep.by_student.map(s => [s.student_name, s.visits, hours(s.hours), s.absences])) : h('div', { class: 'card empty' }, noVisits));
          } else if (repState.tab === 'visits') {
            panel.replaceChildren(rep.visits.length ? table(
              ['Date', 'Student', ...(all ? ['Location'] : []), 'Session', 'In', 'Out', 'Total', 'Check-out'],
              rep.visits.map(v => [App.fmtDate(v.date), v.student_name, ...(all ? [v.location_name] : []), v.session_name || 'Visit',
                App.fmtTime(v.check_in_at, v.timezone), v.check_out_at == null ? 'Still here' : App.fmtTime(v.check_out_at, v.timezone),
                v.minutes == null ? '' : App.fmtDuration(v.minutes),
                h('div', null, endedBadge(v), v.needs_review && h('span', { class: 'badge badge-warn', style: 'margin-left:.3rem' }, 'Needs review'),
                  (v.checked_in_by_name || v.checked_out_by_name) && h('div', { class: 'muted small' },
                    [v.checked_in_by_name && 'In: ' + v.checked_in_by_name, v.checked_out_by_name && 'Out: ' + v.checked_out_by_name].filter(Boolean).join(' · ')))]))
              : h('div', { class: 'card empty' }, noVisits));
          } else {
            panel.replaceChildren(rep.absences.length ? table(['Date', 'Student', ...(all ? ['Location'] : []), 'Session', 'Scheduled'],
              rep.absences.map(a => [App.fmtDate(a.date), a.student_name, ...(all ? [a.location_name] : []), a.session_name,
                App.hhmm(a.start_time) + '–' + App.hhmm(a.end_time)]))
              : h('div', { class: 'card empty' }, NO_ABSENCES[rep.timing]));
          }
        };

        results.replaceChildren(
          h('div', { class: 'page-head' }, h('div', null, h('h2', null, rep.label), h('p', { class: 'small' }, where)),
            h('div', { class: 'row' }, downloads)),
          h('div', { class: 'card att-stats att-four' }, stat(t.visits, t.visits === 1 ? 'visit' : 'visits'), stat(hours(t.hours), 'hours'),
            stat(t.students, t.students === 1 ? 'student' : 'students'), stat(t.absences, t.absences === 1 ? 'absence' : 'absences')),
          // A ternary, not &&: replaceChildren would print a bare false as the word "false".
          t.needs_review > 0 ? h('div', { class: 'notice notice-warn' }, h('strong', null, count(t.needs_review, 'visit needs', 'visits need') + ' review. '),
            'These students didn\'t scan out and were checked out automatically. Confirm or fix the times from ', reviewAt) : '',
          h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Report detail' }, tabs),
          panel);
        showTab();
        markStale();
      }

      // Dates, times and numbers stay on one line; a wide table scrolls inside its card.
      const ONE_LINE = ['Date', 'In', 'Out', 'Total', 'Visits', 'Hours', 'Absences', 'Scheduled'];
      function table(head, rows) {
        const cls = head.map(c => (ONE_LINE.includes(c) ? 'att-nowrap' : null));
        return h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, head.map((c, i) => h('th', { scope: 'col', class: cls[i] }, c)))),
          h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', { class: cls[i] }, c)))))));
      }

      draw();
    },
  });

  // Home: this week at a glance for directors and HQ.
  App.card({
    id: 'attendance-report', roles: ['director'], order: 40,
    async render(box) {
      const opts = await App.api.get(API + '/report/options');
      if (!opts.locations.length) { box.hidden = true; return; }
      const week = opts.locations[0].presets.find(p => p.id === 'this_week');
      const filters = { location: opts.all_locations ? 'all' : String(opts.locations[0].id), from: week.from, to: week.to };
      const rep = await App.api.get(API + '/report?' + qs(filters));
      const t = rep.totals;
      // Reports opens on what this card shows: the same location (or all), every session, this week.
      const open = () => {
        Object.assign(repState, filters, { owner: App.me.user.id, session: '', tab: 'students' });
        App.go('reports');
      };
      box.append(h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', null, h('h2', { style: 'margin:0' }, 'Attendance this week'),
            h('div', { class: 'muted small' }, (opts.all_locations ? 'All locations' : opts.locations[0].name) + ' · ' + rep.label)),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: open }, 'Open reports')),
        h('div', { class: 'att-stats', style: 'margin-top:.75rem' }, stat(t.visits, t.visits === 1 ? 'visit' : 'visits'),
          stat(hours(t.hours), 'hours'), stat(t.absences, t.absences === 1 ? 'absence' : 'absences')),
        t.needs_review > 0 && h('div', { class: 'notice notice-warn', style: 'margin:.75rem 0 0' },
          count(t.needs_review, 'visit needs', 'visits need') + ' review: the student didn\'t scan out.')));
    },
  });
})();
