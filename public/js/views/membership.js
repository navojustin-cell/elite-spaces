/* Membership views (MB-1..MB-5).
   - Staff, directors and HQ: "Members" - every student at the location with their membership
     state, an "Ending soon" filter, and an edit screen (#/members/<studentId>) with the change history.
   - Parents and students: a Home card with status, weekly limit, last day and a renewal warning.
   The weekly limit is days a week (D-43): a schedule fits when it meets no more days a week than the limit. */
(function () {
  'use strict';
  const { h } = App;

  // The filter tabs stay one row of one-line tabs; on a phone the row (.tabs) scrolls sideways.
  document.head.append(h('style', null, `
    .mb-tabs button { flex: none; white-space: nowrap; padding-left: .6rem; padding-right: .6rem; }
  `));

  // ---------- shared wording ----------
  const STATE = {
    active: { label: 'Active', badge: 'badge-ok' },
    upcoming: { label: 'Not started yet', badge: 'badge-warn' },
    ending: { label: 'Ends soon', badge: 'badge-warn' },
    expired: { label: 'Expired', badge: 'badge-danger' },
    inactive: { label: 'Inactive', badge: 'badge-danger' },
    none: { label: 'No membership', badge: '' },
  };
  const stateOf = m => (m ? m.state : 'none');
  const fullDate = d => App.fmtDate(d, { year: 'numeric' });
  // Before its start date a membership isn't active yet (R6), so its badge names the day it starts.
  const badge = m => { const s = STATE[stateOf(m)]; return h('span', { class: 'badge ' + s.badge }, stateOf(m) === 'upcoming' ? 'Starts ' + fullDate(m.start_date) : s.label); };
  const first = name => String(name || '').split(' ')[0];
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const daysWeek = n => plural(n, 'day', 'days') + ' a week';
  const perWeek = cap => 'Up to ' + daysWeek(cap);
  // "A", "A and B", "A, B and C": schedules named in a sentence.
  const listOf = xs => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
  const names = xs => listOf(xs.map(x => x.name));
  const isAre = xs => (xs.length === 1 ? ' is' : ' are');
  const itThem = xs => (xs.length === 1 ? 'it' : 'them');
  const dayChips = w => String(w).split(',').map(d => App.WEEKDAYS[Number(d)]).join(', ');
  const pausedOf = x => (x.schedules || []).filter(e => e.status === 'paused');
  const activeOf = x => (x.schedules || []).filter(e => e.status === 'active');
  const inDays = d => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days');
  const STATUS_WORD = { active: 'Active', inactive: 'Inactive' };
  // A labelled field whose hint is read as its description, not as part of its name.
  const field = (id, label, input, hint) => h('div', { class: 'field' },
    h('span', null, h('label', { for: id }, label)), input, hint && h('div', { class: 'hint', id: id + '-hint' }, hint));

  // ---------- Home card: parents and students (MB-3) ----------
  function familyItem(x, self) {
    const m = x.membership;
    const desk = 'the front desk' + (x.location ? ' at ' + x.location.name : '');
    const who = self ? 'Your' : first(x.student.name) + '\'s';
    const box = h('div', { class: 'grow' },
      h('div', { class: 'row between' }, h('strong', null, x.student.name), badge(m)));
    if (!m) {
      box.append(h('p', { class: 'muted small', style: 'margin:.25rem 0 0' },
        'No membership on file yet. ' + (self ? 'Ask a parent or ' + desk + ' to set it up.' : 'Ask ' + desk + ' to set it up.')));
      return box;
    }
    box.append(h('p', { class: 'muted small', style: 'margin:.25rem 0 0' },
      perWeek(m.weekly_cap), h('br'), (m.renewal_needed && m.state !== 'ending' ? 'Last day: ' : 'Valid through ') + fullDate(m.expires_on)));
    const renew = self ? 'Ask a parent or ' + desk + ' to renew it.' : 'Renew with ' + desk + ' to ';
    if (m.state === 'upcoming') {
      box.append(h('div', { class: 'notice notice-warn', style: 'margin:.6rem 0 0' },
        who + ' membership starts ' + fullDate(m.start_date) + '. ' + (self ? 'You' : first(x.student.name)) +
        ' can enroll in a schedule and check in from that day.'));
    } else if (m.state === 'ending') {
      box.append(h('div', { class: 'notice notice-warn', style: 'margin:.6rem 0 0' },
        who + ' membership ends ' + inDays(m.days_left) + ' (' + fullDate(m.expires_on) + '). ' +
        (self ? renew : renew + 'keep ' + first(x.student.name) + '\'s schedule.')));
    } else if (m.state === 'expired' || m.state === 'inactive') {
      const paused = pausedOf(x);
      // A student hears the same words here as on their Schedule (views/enrollment.js).
      box.append(h('div', { class: 'notice notice-danger', style: 'margin:.6rem 0 0' }, self
        ? (paused.length ? 'Your membership isn\'t active, so your schedule is paused. ' : 'Your membership isn\'t active. ') + renew
        : who + ' membership ' + (m.state === 'expired' ? 'ended on ' + fullDate(m.expires_on) : 'isn\'t active right now') + '. ' +
          (paused.length ? names(paused) + isAre(paused) + ' paused and saved. ' : '') +
          renew + (paused.length ? 'bring ' + itThem(paused) + ' back.' : 'enroll in a schedule again.')));
    }
    return box;
  }

  App.card({
    id: 'membership', roles: ['parent', 'student'], order: 40,
    async render(box) {
      const { members } = await App.api.get('/api/membership/mine');
      const self = App.role() === 'student';
      const card = h('div', { class: 'card' }, h('h2', null, self ? 'Your membership' : 'Membership'));
      if (!members.length) {
        card.append(h('p', { class: 'muted', style: 'margin:0' },
          'Once your student\'s account is approved, their membership shows up here.'));
      } else {
        card.append(h('ul', { class: 'list' }, members.map(x => h('li', null, familyItem(x, self)))));
      }
      box.append(card);
    },
  });

  // ---------- Members: staff, directors, HQ (MB-1, MB-2) ----------
  App.register({
    id: 'members', title: 'Members', icon: '🪪', roles: ['staff'], order: 60,
    render(el, params) { return params[0] ? renderEdit(el, Number(params[0])) : renderRoster(el); },
  });

  // Membership notices in the Inbox open Members for staff and Home (the membership card) for families.
  App.inboxLink('membership', 'members');
  App.inboxLink('membership', 'home');

  // Screen state kept while moving between the roster and an edit screen.
  let filter = 'all', query = '', hqLocation = null;

  const FILTERS = [
    ['all', 'All', () => true, null],
    ['ending', 'Ending soon', s => stateOf(s.membership) === 'ending', 'No memberships end in the next 14 days.'],
    ['off', 'Not active', s => ['upcoming', 'expired', 'inactive'].includes(stateOf(s.membership)), 'Every membership here is active.'],
    ['none', 'No membership', s => !s.membership, 'Every student here has a membership.'],
  ];

  async function renderRoster(el) {
    const isHq = App.role() === 'hq';
    let locations = [];
    if (isHq) {
      locations = (await App.api.get('/api/locations')).locations;
      if (!locations.length) {
        el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Members'))),
          h('div', { class: 'card empty' }, 'No locations yet. Add a location first, then its students show up here.'));
        return;
      }
      if (!locations.some(l => l.id === hqLocation)) hqLocation = locations[0].id;
    }
    const data = await App.api.get('/api/membership/roster' + (isHq ? '?location_id=' + hqLocation : ''));
    el.append(h('div', { class: 'page-head' }, h('div', null,
      h('h1', null, 'Members'),
      h('p', null, 'Membership status, weekly limits and last days for students at ' + data.location.name + '.'))));

    const controls = h('div', { class: 'card' });
    if (isHq) {
      const pick = h('select', { id: 'mb-loc', onchange: () => { hqLocation = Number(pick.value); App.refresh(); } },
        locations.map(l => h('option', { value: l.id, selected: l.id === hqLocation }, l.name)));
      controls.append(field('mb-loc', 'Location', pick));
    }
    const search = h('input', { type: 'search', id: 'mb-search', value: query, autocomplete: 'off', placeholder: 'Student or parent name' });
    controls.append(field('mb-search', 'Find a student', search));

    const tabs = h('div', { class: 'tabs mb-tabs', role: 'tablist', 'aria-label': 'Show' });
    const panel = h('div', { id: 'mb-panel', role: 'tabpanel', class: 'card' });

    const draw = () => {
      const [, , test, emptyText] = FILTERS.find(f => f[0] === filter);
      tabs.replaceChildren(...FILTERS.map(([key, label, fn]) => h('button', {
        type: 'button', role: 'tab', id: 'mb-tab-' + key, 'aria-selected': String(key === filter), 'aria-controls': 'mb-panel',
        onclick: () => { filter = key; draw(); },
      }, label + ' (' + data.students.filter(fn).length + ')')));
      panel.setAttribute('aria-labelledby', 'mb-tab-' + filter);
      const q = query.trim().toLowerCase();
      let rows = data.students.filter(test)
        .filter(s => !q || s.name.toLowerCase().includes(q) || s.parents.some(p => p.toLowerCase().includes(q)));
      if (filter === 'ending') rows = rows.slice().sort((a, b) => a.membership.days_left - b.membership.days_left);
      if (!rows.length) {
        panel.className = 'card empty';
        panel.replaceChildren(q ? 'No students match "' + query.trim() + '".'
          : emptyText || 'No students at ' + data.location.name + ' yet. Students show up once a parent adds them to their family.');
        return;
      }
      panel.className = 'card';
      // position:relative keeps the visually hidden header text inside the scroll box. On a phone the
      // table is wider than the screen, so the box takes focus and arrow keys scroll it.
      const title = 'Memberships at ' + data.location.name;
      panel.replaceChildren(h('div', { class: 'table-wrap', style: 'position:relative', tabindex: '0', role: 'region', 'aria-label': title }, h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, title),
        h('thead', null, h('tr', null,
          ['Student', 'Membership', 'Weekly limit', 'Valid through', 'Schedule'].map(t => h('th', { scope: 'col' }, t)),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', null, rows.map(s => rosterRow(s))))));
    };
    search.addEventListener('input', () => { query = search.value; draw(); });
    draw();
    el.append(controls, tabs, panel);
  }

  // An account no parent has approved yet, in the People screen's words (views/accounts.js).
  const ACCOUNT = { awaiting_approval: 'Waiting for parent approval', invited: 'Invited, not set up yet' };

  function rosterRow(s) {
    const m = s.membership;
    const note = !m ? null
      : m.state === 'upcoming' ? 'Not active until then'
        : m.state === 'ending' ? 'Ends ' + inDays(m.days_left)
          : m.state === 'expired' ? 'Ended ' + App.fmtDate(m.expires_on)
            : null;
    // The Schedule column: each schedule held or paused, by name and days; a paused one says so.
    const held = s.schedules.length
      ? s.schedules.map(e => h('div', null, e.name + ' · ' + dayChips(e.weekdays),
        e.status === 'paused' && [' ', h('span', { class: 'badge badge-warn' }, 'Paused')]))
      : 'None';
    return h('tr', null,
      h('td', null, h('strong', null, s.name),
        h('div', { class: 'muted small' }, s.account === 'active' ? (s.parents.length > 1 ? 'Parents: ' : 'Parent: ') + s.parents.join(', ') : ACCOUNT[s.account])),
      h('td', null, badge(m), note && h('div', { class: 'muted small' }, note)),
      h('td', null, m ? daysWeek(m.weekly_cap) : '—'),
      h('td', null, m ? fullDate(m.expires_on) : '—'),
      h('td', null, held),
      h('td', null, h('a', { class: 'btn', href: '#/members/' + s.id, 'aria-label': (m ? 'Edit membership for ' : 'Set up a membership for ') + s.name },
        m ? 'Edit' : 'Set up')));
  }

  // ---------- one student's membership ----------
  function changeText(x) {
    const a = x.after || {}, b = x.before;
    if (!b) {
      return 'set up the membership: ' + STATUS_WORD[a.status] + ', ' + daysWeek(a.weekly_cap) + ', ' +
        fullDate(a.start_date) + ' through ' + fullDate(a.expires_on) + '.';
    }
    const parts = [];
    if (b.status !== a.status) parts.push('status from ' + STATUS_WORD[b.status] + ' to ' + STATUS_WORD[a.status]);
    if (b.weekly_cap !== a.weekly_cap) parts.push('weekly limit from ' + daysWeek(b.weekly_cap) + ' to ' + daysWeek(a.weekly_cap));
    if (b.start_date !== a.start_date) parts.push('start date from ' + fullDate(b.start_date) + ' to ' + fullDate(a.start_date));
    if (b.expires_on !== a.expires_on) parts.push('last day from ' + fullDate(b.expires_on) + ' to ' + fullDate(a.expires_on));
    return 'changed ' + parts.join('; ') + '.';
  }

  function savedText(r, name) {
    if (!r.changed && !r.paused && !r.restored && !r.waitlisted) return 'Nothing changed.';
    const out = ['Membership saved.'];
    if (r.paused) out.push(plural(r.paused, 'schedule', 'schedules') + ' paused.');
    if (r.restored) out.push(plural(r.restored, 'schedule', 'schedules') + ' back on.');
    if (r.waitlisted) out.push(plural(r.waitlisted, 'schedule was', 'schedules were') + ' full, so ' + name + ' is first on the waitlist.');
    if (r.kept_paused) out.push(plural(r.kept_paused, 'schedule stays', 'schedules stay') + ' paused because of the weekly limit.');
    if (r.paused || r.restored || r.waitlisted) out.push('The family has been told.');
    return out.join(' ');
  }

  async function renderEdit(el, id) {
    const data = await App.api.get('/api/membership/student/' + id);
    const m = data.membership, s = data.student, name = first(s.name), tz = data.location.timezone;

    el.append(h('p', { style: 'margin:0 0 .5rem' }, h('a', { class: 'btn btn-ghost', href: '#/members' }, '← All members')),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, s.name), h('p', null, 'Membership at ' + data.location.name))));

    // Where things stand today.
    const now = h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Right now'), badge(m)));
    if (!m) {
      now.append(h('p', { class: 'muted', style: 'margin:.5rem 0 0' }, name + ' has no membership yet, so they can\'t enroll in a schedule. Set one up below.'));
    } else {
      now.append(h('p', { style: 'margin:.5rem 0 0' }, perWeek(m.weekly_cap) + ' · ' + fullDate(m.start_date) + ' through ' + fullDate(m.expires_on)));
      const notes = [];
      if (m.state === 'upcoming') notes.push('Not active until ' + fullDate(m.start_date) + ', so ' + name + ' can\'t enroll in a schedule or check in before then.');
      if (m.state === 'ending') notes.push('Ends ' + inDays(m.days_left) + '.');
      if (m.state === 'expired') notes.push('Ended on ' + fullDate(m.expires_on) + '.');
      const held = activeOf(data), paused = pausedOf(data);
      notes.push(held.length ? 'Holds ' + listOf(held.map(e => e.name + ' (' + daysWeek(e.days_per_week) + ')')) + '.' : 'No schedule right now.');
      if (paused.length) notes.push(names(paused) + isAre(paused) + (m.state === 'upcoming'
        ? ' paused until the membership starts.' : m.renewal_needed && m.state !== 'ending'
        ? ' paused until the membership is active again.'
        : ' paused because ' + (paused.length === 1 ? 'it meets' : 'they meet') + ' more days a week than the weekly limit. Raising the limit brings ' + itThem(paused) + ' back.'));
      now.append(h('p', { class: 'muted small', style: 'margin:.25rem 0 0' }, notes.join(' ')));
    }

    // The form.
    const status = m ? m.status : 'active';
    const radio = (value, label, hint) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'mb-status', value, checked: status === value }),
      h('span', null, h('strong', null, label), h('span', { class: 'muted small' }, ' · ' + hint)));
    const cap = h('input', { type: 'number', id: 'mb-cap', min: 1, max: 14, step: 1, inputmode: 'numeric', required: true,
      value: m ? m.weekly_cap : 3, 'aria-describedby': 'mb-cap-hint' });
    const start = h('input', { type: 'date', id: 'mb-start', required: true, value: m ? m.start_date : data.today });
    const end = h('input', { type: 'date', id: 'mb-end', required: true, value: m ? m.expires_on : '', 'aria-describedby': 'mb-end-hint' });
    const effect = h('div', { 'aria-live': 'polite' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save membership');

    const form = h('form', { class: 'card', 'aria-labelledby': 'mb-form-title' },
      h('h2', { id: 'mb-form-title' }, m ? 'Update membership' : 'Set up membership'),
      h('fieldset', null, h('legend', null, 'Status'),
        radio('active', 'Active', 'can enroll and keep a schedule'),
        radio('inactive', 'Inactive', 'the schedule is paused and saved')),
      field('mb-cap', 'Weekly limit (days a week)', cap, 'The most days a week ' + name + '\'s schedule can meet.'),
      field('mb-start', 'Start date', start),
      field('mb-end', 'Last day', end, 'The membership is valid through the end of this day.'),
      effect,
      h('div', { class: 'row' }, save, h('a', { class: 'btn btn-ghost', href: '#/members' }, 'Cancel')),
      h('p', { class: 'muted small', style: 'margin:.75rem 0 0' }, 'ELITE Spaces doesn\'t keep payment details. Billing stays in your usual system.'));

    // Say what saving will do to the student's schedules before it happens (MB-5, D-16a, D-27).
    const held = activeOf(data), paused = pausedOf(data);
    const top = held.filter(e => e.days_per_week === data.held_days)[0];
    const preview = () => {
      const st = form.querySelector('input[name="mb-status"]:checked').value;
      // D-32: a start date still ahead means not active yet; paused schedules come back on that day.
      const later = st === 'active' && start.value > data.today;
      const valid = st === 'active' && !!end.value && end.value >= data.today && !later;
      let label = m ? 'Save membership' : 'Set up membership';
      effect.replaceChildren();
      if (st === 'active' && end.value && end.value < data.today) {
        effect.append(h('div', { class: 'notice notice-warn' }, 'That last day has already passed, so the membership will show as expired. Choose a later last day to renew it.'));
      }
      const limit = Number(cap.value) || 0;
      if (valid && m && limit && limit < data.held_days && limit < m.weekly_cap) {
        // D-27: the weekly limit is a hard cap, so saving this is refused.
        effect.append(h('div', { class: 'notice notice-danger' }, name + ' holds ' + (top ? top.name : 'a schedule') + ' (' + daysWeek(data.held_days) +
          '), so the weekly limit can\'t go below ' + data.held_days + '. A parent can switch to a schedule with fewer days, or drop it, first.'));
      } else if (!valid && held.length) {
        effect.append(h('div', { class: 'notice notice-warn' }, 'Saving pauses ' + name + '\'s ' + (held.length === 1 ? 'schedule, ' : 'schedules, ') +
          names(held) + '. ' + (held.length === 1 ? 'It\'s kept and comes' : 'They\'re kept and come') + ' back ' +
          (later ? 'on ' + fullDate(start.value) + ', when the membership starts' : 'when the membership is active again') + '. The family gets a notification.'));
        label = 'Save and pause ' + plural(held.length, 'schedule', 'schedules');
      } else if (later && paused.length) {
        effect.append(h('div', { class: 'notice notice-warn' }, name + '\'s ' + (paused.length === 1 ? 'paused schedule, ' : 'paused schedules, ') +
          names(paused) + ', ' + (paused.length === 1 ? 'stays' : 'stay') + ' paused until the membership starts on ' + fullDate(start.value) + '. ' +
          (paused.length === 1 ? 'It comes back that day if its days fit' : 'They come back that day if their days fit') +
          ' the weekly limit, and the family gets a notification then.'));
      } else if (valid && paused.length) {
        // D-16a: a paused schedule comes back only if its days a week fit the limit; the rest stay paused and saved.
        const back = paused.filter(e => !limit || e.days_per_week <= limit), kept = paused.filter(e => !back.includes(e));
        if (!back.length) {
          effect.append(h('div', { class: 'notice notice-warn' }, names(kept) + (kept.length === 1 ? ' meets ' + daysWeek(kept[0].days_per_week) + ', more'
            : ' meet more days a week') + ' than a weekly limit of ' + limit + ', so ' + (kept.length === 1 ? 'it stays' : 'they stay') +
            ' paused and saved. Raising the limit brings ' + itThem(kept) + ' back.'));
        } else {
          effect.append(h('div', { class: 'notice notice-ok' }, 'Saving brings back ' + name + '\'s ' + (back.length === 1 ? 'paused schedule, ' : 'paused schedules, ') +
            names(back) + '. ' + (back.length === 1 ? 'If it has' : 'If one has') + ' filled up since, ' + name + ' goes first on its waitlist. ' +
            (kept.length ? names(kept) + (kept.length === 1 ? ' stays' : ' stay') + ' paused and saved, because the weekly limit is ' + daysWeek(limit) + '. ' : '') +
            'The family gets a notification.'));
          label = 'Save and restore ' + plural(back.length, 'schedule', 'schedules');
        }
      }
      save.textContent = label;
    };
    form.addEventListener('input', preview);
    form.addEventListener('change', preview);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const r = await App.run(save, () => App.api.put('/api/membership/student/' + id, {
        status: form.querySelector('input[name="mb-status"]:checked').value,
        weekly_cap: Number(cap.value), start_date: start.value, expires_on: end.value,
      }));
      if (!r) return;
      App.toast(savedText(r, name));
      App.refresh();
    });
    preview();

    // Who changed what (NF-2).
    const hist = h('div', { class: 'card' }, h('h2', null, 'Change history'));
    if (!data.history.length) {
      hist.append(h('p', { class: 'muted', style: 'margin:0' }, 'No changes made in the app yet. Every change staff make here is saved with their name.'));
    } else {
      hist.append(h('ul', { class: 'list' }, data.history.map(x => h('li', null,
        h('div', { class: 'grow' }, h('strong', null, x.actor || 'Someone'), ' ', changeText(x)),
        h('time', { class: 'muted small' }, App.fmtDateTime(x.at, tz))))));
    }

    el.append(now, form, hist);
  }
})();
