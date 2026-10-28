/* Enrollment views (PRD 3, v1.1 fixed schedules): the family "Schedule" screen and Home cards.
   Parents: per student, the schedule held for each period, waitlist places, drop,
   and "Choose a schedule" (enroll, switch to, or join a waitlist; D-43, D-44).
   Students: their schedule and this week, read-only (students no longer request, D-48). */
(function () {
  'use strict';
  const { h } = App;
  const API = '/api/enrollment';
  const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const first = name => String(name || '').split(' ')[0];
  const times = s => App.hhmm(s.start_time) + '–' + App.hhmm(s.end_time);
  const daysOf = s => String(s.weekdays).split(',').map(Number).sort((a, b) => a - b).map(n => App.WEEKDAYS[n]).join(', ');
  const ordinal = n => { const sfx = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(App.now()); // YYYY-MM-DD
  const short = d => App.fmtDate(d, { weekday: undefined }); // "Nov 2"
  const dayDate = d => App.fmtDate(d).replace(',', ''); // "Mon Nov 23"
  const period = s => s.term_name + ' · ' + short(s.term_start) + ' – ' + short(s.term_end);
  const weekly = n => plural(n, 'day') + ' a week';

  const css = `
    .en-list > li { flex-wrap: wrap; }
    .en-list > li > .grow { flex: 1 1 11rem; }
    .en-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .en-day { margin: 1rem 0 .1rem; font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .en-weeknav { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .25rem; }
    .en-date { width: 3.2rem; flex: none; text-align: center; line-height: 1.2; }
    .en-date strong { display: block; }
    .en-pick { display: flex; flex-direction: column; align-items: flex-end; gap: .25rem; max-width: 100%; }
    .en-pick .btn { min-height: 44px; }
    .en-why { margin: .25rem 0 0; max-width: 22rem; }
  `;
  document.head.append(h('style', null, css));

  const STATUS = {
    upcoming: ['badge-accent', 'Upcoming'], attended: ['badge-ok', 'Attended'], absent: ['', 'Absent'],
    closed: ['badge-warn', 'Center closed'], paused: ['badge-warn', 'Paused'],
    not_started: ['', 'Not started'], // D-32: before the membership's start date, never absent
  };
  const badge = (cls, text) => h('span', { class: 'badge ' + cls }, text);

  // ---------- shared pieces ----------

  function membershipNotice(m, name) {
    if (m.can_add) return null;
    return h('div', { class: 'notice notice-warn', role: 'note' }, m.message || (first(name) + " can't add a schedule right now."));
  }

  // A lapsed membership, said to the student the same way on Home and Schedule
  // (the membership view's Home card uses these exact words).
  const lapsed = m => m.code === 'membership_inactive' || m.code === 'membership_expired';
  const notStarted = (m, tz) => m.status === 'active' && !lapsed(m) && m.start_date > todayIn(tz);
  const longDay = d => App.fmtDate(d, { weekday: undefined, year: 'numeric' });
  const lapsedText = (paused, place) => (paused ? 'Your membership isn\'t active, so your schedule is paused.' : 'Your membership isn\'t active.') +
    ` Ask a parent or the front desk at ${place} to renew it.`;

  // A membership is valid from start_date through expires_on (D-16, R6): past its
  // last day it is expired, before its first it hasn't started, whatever its status says.
  // The cap is days a week (D-43).
  function membershipLine(m, tz) {
    if (!m.status) return h('p', { class: 'muted small' }, 'No membership on file yet.');
    const expired = m.status === 'active' && m.code === 'membership_expired';
    const head = m.status !== 'active' ? 'Membership inactive' : expired ? 'Membership expired'
      : notStarted(m, tz) ? 'Membership starts ' + longDay(m.start_date) : 'Membership active';
    return h('p', { class: 'muted small' }, head + ' · up to ' + weekly(m.weekly_cap) + ' · ' +
      (expired ? 'last day was ' : 'valid through ') + longDay(m.expires_on));
  }

  // A schedule's upcoming date changes (D-46), one line each. A move is a skip
  // plus an add that names the date it replaces, shown once.
  function changeLines(changes) {
    const moved = new Set(changes.filter(c => c.kind === 'add' && c.moved_from).map(c => c.moved_from));
    return changes.filter(c => !(c.kind === 'skip' && moved.has(c.date))).map(c =>
      (c.kind === 'skip' ? 'No meeting ' + dayDate(c.date) : c.moved_from ? 'Moves ' + dayDate(c.moved_from) + ' → ' + dayDate(c.date) : 'Extra date ' + dayDate(c.date)) +
      (c.reason ? ' (' + c.reason + ')' : ''));
  }

  // What a date in the week is beyond its status: added or moved (D-46).
  const changeNote = o => o.change === 'moved' ? 'Moved from ' + App.WEEKDAYS[new Date(o.moved_from + 'T12:00:00Z').getUTCDay() || 7]
    : o.change === 'added' ? 'Added date' : null;

  // One week of dates with Previous / Next week controls.
  function weekCard(sched, onWeek, title, m) {
    const tz = sched.location.timezone;
    const today = todayIn(tz);
    const label = short(sched.from) + ' – ' + short(sched.to);
    const card = h('section', { class: 'card', 'aria-labelledby': 'en-week-h' },
      h('h2', { id: 'en-week-h' }, title || 'This week'),
      onWeek && h('div', { class: 'en-weeknav' },
        h('button', { class: 'btn btn-ghost', 'aria-label': 'Previous week', onclick: () => onWeek(addDays(sched.from, -7)) }, '‹ Prev'),
        h('span', { class: 'small', 'aria-live': 'polite' }, label),
        h('button', { class: 'btn btn-ghost', 'aria-label': 'Next week', onclick: () => onWeek(addDays(sched.from, 7)) }, 'Next ›')));
    if (!sched.occurrences.length) {
      card.append(h('p', { class: 'empty' }, 'No dates this week.'));
      return card;
    }
    const list = h('ul', { class: 'list' });
    for (const o of sched.occurrences) {
      const [cls, text] = STATUS[o.status] || ['', o.status];
      const detail = [changeNote(o), o.status === 'closed' && o.closure_reason ? 'Closed: ' + o.closure_reason
        : o.status === 'not_started' ? 'Membership starts ' + longDay(o.membership_starts)
        : o.status === 'attended' && o.check_in_at ? 'Checked in ' + App.fmtTime(o.check_in_at, tz) + (o.check_out_at ? ', out ' + App.fmtTime(o.check_out_at, tz) : '')
        : o.status === 'paused' ? (o.end_at <= App.now() ? 'Membership was paused'
          : m && notStarted(m, tz) ? 'Membership starts ' + longDay(m.start_date) : 'Paused until the membership is renewed') : null].filter(Boolean);
      list.append(h('li', null,
        h('div', { class: 'en-date' }, h('strong', null, o.date === today ? 'Today' : DAY[o.weekday].slice(0, 3)), h('span', { class: 'muted small' }, short(o.date))),
        h('div', { class: 'grow' }, h('div', null, h('strong', null, o.name)),
          h('div', { class: 'muted small' }, [times(o), ...detail].join(' · '))),
        badge(cls, text)));
    }
    card.append(list);
    return card;
  }

  function scheduleUrl(id, from) { return `${API}/students/${id}/schedule` + (from ? `?from=${from}&to=${addDays(from, 6)}` : ''); }

  // A held schedule's lines: days and time, its period, and any upcoming date change.
  const heldLines = e => [
    h('div', { class: 'muted small' }, daysOf(e) + ' · ' + times(e) + ' · ' + period(e)),
    ...changeLines(e.changes || []).map(c => h('div', { class: 'small' }, c)),
  ];

  function standing(s) {
    if (s.mine === 'enrolled') return badge('badge-ok', 'Enrolled');
    if (s.mine === 'paused') return badge('badge-warn', 'Paused');
    if (s.mine === 'waiting') return badge('badge-accent', ordinal(s.position) + ' in line');
    return null;
  }

  // ---------- parent actions ----------

  async function joinWaitlist(btn, student, s) {
    const out = await App.run(btn, () => App.api.post(API + '/waitlist', { studentId: student.id, sessionId: s.session_id }));
    if (!out) return;
    const name = first(student.name);
    App.toast(out.outcome === 'enrolled'
      ? `A seat was free: ${name} is enrolled in ${s.name}.`
      : `${name} is ${ordinal(out.position)} in line. ` + (out.keeps
        ? `${name} keeps ${out.keeps.name} until a seat opens, then moves over automatically.`
        : `We'll enroll ${name} automatically when a seat opens.`));
    App.refresh();
  }

  // Every question below is asked inline with App.confirm, in place of the
  // buttons that raised it (`el`), safe answer first.

  // A full schedule: offer its waitlist (EN-5).
  const offerWaitlist = (btn, message, student, s) => App.confirm({
    el: btn.parentNode, opener: btn, title: `${s.name} is full`, body: message,
    confirmLabel: `Add ${first(student.name)} to the waitlist`, cancelLabel: 'Don\'t join',
  });

  async function enrollIn(btn, student, s) {
    const name = first(student.name);
    // D-43: a switch ends the schedule held for this period, so it asks first and names it.
    if (s.switch_from && !(await App.confirm({
      el: btn.parentNode, opener: btn,
      title: `Switch ${name} to ${s.name}?`,
      body: `${s.switch_from.name} ends for ${name} now, and its seat goes to the next family on the waitlist.`,
      confirmLabel: `Switch to ${s.name}`, cancelLabel: `Keep ${s.switch_from.name}`,
    }))) return;
    btn.disabled = true;
    let full = null;
    try {
      const out = await App.api.post(API + '/enroll', { studentId: student.id, sessionId: s.session_id });
      App.toast(out.switched_from ? `${name} moved from ${out.switched_from.name} to ${s.name}.` : `${name} is enrolled in ${s.name}.`);
    } catch (e) {
      if (e.code === 'full') full = e.message; else App.toast(e.message, 'error');
    } finally { btn.disabled = false; }
    if (full && await offerWaitlist(btn, full, student, s)) await joinWaitlist(null, student, s);
    App.refresh();
  }

  // EN-6: the row turns into the question; the buttons name the schedule.
  async function dropEnrollment(btn, student, e) {
    const ok = await App.confirm({
      el: btn.parentNode, opener: btn, danger: true,
      title: `Drop ${first(student.name)} from ${e.name}?`,
      body: 'This ends all of its dates. The seat goes to the next family on the waitlist.',
      confirmLabel: 'Drop ' + e.name, cancelLabel: 'Keep ' + e.name,
    });
    if (!ok) return;
    const out = await App.run(btn, () => App.api.post(`${API}/enrollments/${e.id}/drop`));
    if (out) { App.toast(`Dropped ${e.name}.`); App.refresh(); }
  }

  async function leaveWaitlist(btn, student, w) {
    const ok = await App.confirm({
      el: btn.parentNode, opener: btn, danger: true,
      title: `Take ${first(student.name)} off the waitlist for ${w.name}?`, body: 'They\'ll lose their place in line.',
      confirmLabel: 'Leave the waitlist', cancelLabel: 'Keep their place',
    });
    if (!ok) return;
    const out = await App.run(btn, () => App.api.post(`${API}/waitlist/${w.id}/leave`));
    if (out) { App.toast('Removed from the waitlist.'); App.refresh(); }
  }

  function studentTabs(students, sel, onPick) {
    if (students.length < 2) return null;
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Choose a student' });
    students.forEach((s, i) => tabs.append(h('button', {
      role: 'tab', 'aria-selected': String(s.id === sel.id), tabindex: s.id === sel.id ? '0' : '-1',
      onclick: () => onPick(s.id),
      onkeydown: e => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { const n = students[(i + d + students.length) % students.length]; onPick(n.id); }
      },
    }, first(s.name))));
    return tabs;
  }

  // One row of "Choose a schedule": Enroll, Switch to this, or Join waitlist. A
  // blocked row's button is disabled and the reason shows under it (D-43).
  function pickRow(s, sel) {
    const name = first(sel.name);
    const open = s.seats_left > 0;
    const verb = !open ? 'Join waitlist' : s.switch_from ? 'Switch to this' : 'Enroll';
    const whyId = 'en-why-' + s.session_id;
    const why = !s.mine && s.block ? h('p', { class: 'small muted en-why', id: whyId }, s.block.message) : null;
    const action = standing(s) || h('div', { class: 'en-pick' }, h('button', {
      class: 'btn' + (open ? ' btn-primary' : ''), disabled: !s.can_add,
      'aria-label': (!open ? `Join the waitlist for ${s.name}` : s.switch_from ? `Switch ${name} to ${s.name}` : `Enroll ${name} in ${s.name}`),
      'aria-describedby': why ? whyId : null,
      onclick: ev => open ? enrollIn(ev.currentTarget, sel, s) : joinWaitlist(ev.currentTarget, sel, s),
    }, verb), why);
    const seats = open ? plural(s.seats_left, 'seat') + ' left' : 'Full' + (s.waiting ? ' · ' + s.waiting + ' waiting' : '');
    const left = s.dates_left === s.dates_total ? 'Starts ' + short(s.first_date) : `${s.dates_left} of ${s.dates_total} dates left`;
    return h('li', null,
      h('div', { class: 'grow' }, h('div', null, h('strong', null, s.name)),
        h('div', { class: 'muted small' }, daysOf(s) + ' · ' + times(s) + ' · ' + weekly(s.days_per_week)),
        h('div', { class: 'muted small' }, seats + ' · ' + left)),
      action);
  }

  // Schedules grouped by period (D-41).
  function byPeriod(schedules, row) {
    const out = [];
    let term = null, list = null;
    schedules.forEach(s => {
      if (s.term_name + s.term_start !== term) {
        term = s.term_name + s.term_start;
        list = h('ul', { class: 'list en-list' });
        out.push(h('h3', { class: 'en-day' }, period(s)), list);
      }
      list.append(row(s));
    });
    return out;
  }

  // ---------- parent screen ----------

  // #/schedule/enrollment/<id>, from an Inbox item (L35).
  const inboxRef = params => params[0] === 'enrollment' ? { id: Number(params[1]) } : null;

  async function renderParent(el, params) {
    const { students } = await App.api.get(API + '/students');
    el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Schedule'),
      h('p', null, 'Pick one schedule per period for each student. They attend every date it lists.'))));
    if (!students.length) {
      el.append(h('div', { class: 'card empty' }, 'Once your student\'s account is linked to yours, you can pick their schedule here.'));
      return;
    }
    const ref = inboxRef(params);
    const pick = !ref ? params[0] : (students.find(s => s.enrollments.some(e => e.id === ref.id)) || {}).id;
    const sel = students.find(s => String(s.id) === String(pick)) || students[0];
    const from = ref ? null : params[1] || null;
    const [cat, sched] = await Promise.all([App.api.get(`${API}/students/${sel.id}/catalog`), App.api.get(scheduleUrl(sel.id, from))]);
    const tz = cat.location.timezone;
    const tabs = studentTabs(students, sel, id => App.go('schedule', id));
    if (tabs) el.append(tabs);
    const name = first(sel.name);

    // The schedule held for each period
    const mine = h('section', { class: 'card', 'aria-labelledby': 'en-mine-h' },
      h('h2', { id: 'en-mine-h' }, name + '\'s schedule'), membershipLine(sel.membership, tz));
    // L52: point at "Choose a schedule" only when its buttons can work; otherwise its notice says why.
    if (!sel.enrollments.length) mine.append(h('p', { class: 'empty' }, sel.membership.can_add ? 'No schedule yet. Choose one under "Choose a schedule" below.' : 'No schedule yet.'));
    else mine.append(h('ul', { class: 'list en-list' }, sel.enrollments.map(e => h('li', null,
      h('div', { class: 'grow' }, h('div', null, h('strong', null, e.name)), ...heldLines(e)),
      e.status === 'paused' && badge('badge-warn', 'Paused'),
      h('button', { class: 'btn', onclick: ev => dropEnrollment(ev.currentTarget, sel, e), 'aria-label': `Drop ${e.name}` }, 'Drop')))));
    if (sel.enrollments.some(e => e.status === 'paused')) {
      mine.append(h('p', { class: 'muted small' }, notStarted(sel.membership, tz)
        ? `A paused schedule doesn't hold a seat. ${name}'s membership starts on ${longDay(sel.membership.start_date)}.`
        : 'A paused schedule doesn\'t hold a seat. It comes back once the membership is renewed and its days fit the weekly limit, if the seat is still free.'));
    }
    el.append(mine);

    // Waitlists (D-44): a family waits while keeping its current schedule.
    if (sel.waitlist.length) {
      el.append(h('section', { class: 'card', 'aria-labelledby': 'en-wait-h' },
        h('h2', { id: 'en-wait-h' }, 'Waitlists'),
        !sel.membership.can_add && h('div', { class: 'notice notice-warn small' }, `${name} keeps their place in line but will be skipped when a seat opens until this is sorted out: ${sel.membership.message}`),
        h('ul', { class: 'list en-list' }, sel.waitlist.map(w => h('li', null,
          h('div', { class: 'grow' }, h('div', null, h('strong', null, w.name)),
            h('div', { class: 'muted small' }, ordinal(w.position) + ' in line of ' + w.in_line + ' · ' + daysOf(w) + ' · ' + times(w)),
            h('div', { class: 'small' }, w.keeps ? `${name} keeps ${w.keeps.name} until a seat opens, then moves over automatically.`
              : `${name} is enrolled automatically when a seat opens, and you'll get a notification.`)),
          h('button', { class: 'btn', onclick: ev => leaveWaitlist(ev.currentTarget, sel, w), 'aria-label': `Leave the waitlist for ${w.name}` }, 'Leave'))))));
    }

    el.append(weekCard(sched, d => App.go('schedule', sel.id, d), from ? 'Week' : 'This week', sel.membership));

    // Choose a schedule
    const add = h('section', { class: 'card', 'aria-labelledby': 'en-add-h' },
      h('h2', { id: 'en-add-h' }, 'Choose a schedule'),
      h('p', { class: 'muted small' }, `Schedules at ${cat.location.name}. ${name} keeps one per period and attends every date it lists.`),
      membershipNotice(cat.membership, sel.name));
    if (!cat.schedules.length) add.append(h('p', { class: 'empty' }, 'No schedules are open right now. Check back when the next period is posted.'));
    add.append(...byPeriod(cat.schedules, s => pickRow(s, sel)));
    el.append(add);
  }

  // ---------- student screen ----------

  async function renderStudent(el, params) {
    const { students } = await App.api.get(API + '/students');
    const me = students[0];
    const from = inboxRef(params) ? null : params[1] || null;
    const sched = await App.api.get(scheduleUrl(me.id, from));
    const tz = me.location.timezone;
    el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'My schedule'),
      h('p', null, `Your schedule at ${me.location.name}.`))));
    if (lapsed(me.membership)) {
      el.append(h('div', { class: 'notice notice-warn', role: 'note' }, lapsedText(me.enrollments.some(e => e.status === 'paused'), me.location.name)));
    }

    el.append(weekCard(sched, d => App.go('schedule', me.id, d), from ? 'Week' : 'This week', me.membership));

    const mine = h('section', { class: 'card', 'aria-labelledby': 'en-mine-h' }, h('h2', { id: 'en-mine-h' }, 'Your schedule'), membershipLine(me.membership, tz));
    if (!me.enrollments.length) mine.append(h('p', { class: 'empty' }, 'Ask a parent to pick your schedule.'));
    else mine.append(h('ul', { class: 'list en-list' }, me.enrollments.map(e => h('li', null,
      h('div', { class: 'grow' }, h('div', null, h('strong', null, e.name)), ...heldLines(e)),
      e.status === 'paused' && badge('badge-warn', 'Paused')))));
    for (const w of me.waitlist) {
      mine.append(h('p', { class: 'small' }, badge('badge-accent', ordinal(w.position) + ' in line'), ' ', `${w.name}. You'll move over automatically when a seat opens.`));
    }
    el.append(mine);
  }

  App.register({
    id: 'schedule', title: 'Schedule', icon: '📅', roles: ['parent', 'student'], order: 20,
    render: (el, params) => (App.role() === 'parent' ? renderParent(el, params) : renderStudent(el, params)),
  });
  // Enrollments and waitlist promotions open Schedule from the Inbox on the student
  // they are about (L35): #/schedule/enrollment/<id>. Request items are no longer
  // sent (D-48); old ones still open Schedule.
  App.inboxLink('enrollment_request', 'schedule');
  App.inboxLink('enrollment', n => 'schedule/enrollment/' + n.ref_id);

  // ---------- Home card ----------

  App.card({
    id: 'enrollment-week', roles: ['parent', 'student'], order: 40,
    async render(box) {
      const { students } = await App.api.get(API + '/students');
      if (!students.length) return;
      const weeks = await Promise.all(students.map(s => App.api.get(scheduleUrl(s.id))));
      const card = h('section', { class: 'card', 'aria-labelledby': 'en-home-week-h' },
        h('div', { class: 'row between' }, h('h2', { id: 'en-home-week-h', style: 'margin:0' }, 'This week'),
          h('a', { class: 'btn btn-ghost', href: '#/schedule' }, 'Open schedule')));
      weeks.forEach((w, i) => {
        if (students.length > 1) card.append(h('h3', { class: 'en-day' }, first(students[i].name)));
        const rows = w.occurrences;
        const today = todayIn(w.location.timezone);
        if (!rows.length) {
          card.append(h('p', { class: 'muted small' }, App.role() !== 'parent' ? 'No dates this week. Ask a parent to pick your schedule.'
            : students[i].membership.can_add ? 'No dates this week. Choose a schedule in Schedule.' : 'No dates this week.')); // L52
          return;
        }
        card.append(h('ul', { class: 'list' }, rows.map(o => {
          const [cls, text] = STATUS[o.status] || ['', o.status];
          return h('li', null,
            h('div', { class: 'grow' }, h('strong', null, (o.date === today ? 'Today' : DAY[o.weekday].slice(0, 3)) + ' ' + times(o)),
              h('div', { class: 'muted small' }, [o.name, changeNote(o)].filter(Boolean).join(' · '))),
            badge(cls, text));
        })));
      });
      box.append(card);
    },
  });
})();
