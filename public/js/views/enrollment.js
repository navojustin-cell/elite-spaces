/* Enrollment views (PRD 3): the family "Schedule" screen and Home cards.
   Parents: per student weekly sessions, add from the session list, waitlist
   places, drop, and approve or decline student requests.
   Students: their schedule, asking a parent for a session, and request status. */
(function () {
  'use strict';
  const { h } = App;
  const API = '/api/enrollment';
  const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const first = name => String(name || '').split(' ')[0];
  const times = s => App.hhmm(s.start_time) + '–' + App.hhmm(s.end_time);
  const slotText = s => DAY[s.weekday] + 's · ' + times(s);
  const ordinal = n => { const sfx = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (sfx[(v - 20) % 10] || sfx[v] || sfx[0]); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(App.now()); // YYYY-MM-DD

  const css = `
    .en-list > li { flex-wrap: wrap; }
    .en-list > li > .grow { flex: 1 1 11rem; }
    .en-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .en-day { margin: 1rem 0 .1rem; font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .en-weeknav { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .25rem; }
    .en-date { width: 3.2rem; flex: none; text-align: center; line-height: 1.2; }
    .en-date strong { display: block; }
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
    return h('div', { class: 'notice notice-warn', role: 'note' }, m.message || (first(name) + " can't add sessions right now."));
  }

  // A lapsed membership, said to the student the same way on Home and Schedule
  // (the membership view's Home card uses these exact words).
  const lapsed = m => m.code === 'membership_inactive' || m.code === 'membership_expired';
  const notStarted = m => m.code === 'membership_not_started';
  const longDay = d => App.fmtDate(d, { weekday: undefined, year: 'numeric' });
  const lapsedText = (paused, place) => (paused ? 'Your membership isn\'t active, so your sessions are paused.' : 'Your membership isn\'t active.') +
    ` Ask a parent or the front desk at ${place} to renew it.`;

  // The same reasons, said to the student (they can't drop or renew themselves).
  function studentNotice(m) {
    if (m.can_add) return null;
    if (lapsed(m)) return h('div', { class: 'notice notice-warn', role: 'note' }, 'Nothing new can be added until it\'s renewed. You can still ask; your parent will see this too.');
    const text = {
      membership_not_started: `Your membership starts on ${longDay(m.start_date)}. Sessions can be added from that day.`,
      weekly_cap: `You have ${m.used} weekly sessions, the most your membership allows. A parent can drop one to make room.`,
      no_membership: "You don't have a membership yet. A parent can set one up with the front desk.",
    }[m.code] || m.message;
    return h('div', { class: 'notice notice-warn', role: 'note' }, text + ' You can still ask; your parent will see this too.');
  }

  // A membership is valid from start_date through expires_on (D-16, R6): past its
  // last day it is expired, before its first it hasn't started, whatever its status says.
  function membershipLine(m) {
    if (!m.status) return h('p', { class: 'muted small' }, 'No membership on file yet.');
    const expired = m.status === 'active' && m.code === 'membership_expired';
    const head = m.status !== 'active' ? 'Membership inactive' : expired ? 'Membership expired'
      : notStarted(m) ? 'Membership starts ' + longDay(m.start_date) : 'Membership active';
    return h('p', { class: 'muted small' }, head + ' · ' + m.used + ' of ' + m.weekly_cap + ' weekly sessions in use · ' +
      (expired ? 'last day was ' : 'valid through ') + longDay(m.expires_on));
  }

  // One week of sessions with Previous / Next week controls.
  function weekCard(sched, onWeek, title, m) {
    const tz = sched.location.timezone;
    const today = todayIn(tz);
    const label = App.fmtDate(sched.from, { weekday: undefined }) + ' – ' + App.fmtDate(sched.to, { weekday: undefined });
    const card = h('section', { class: 'card', 'aria-labelledby': 'en-week-h' },
      h('h2', { id: 'en-week-h' }, title || 'This week'),
      onWeek && h('div', { class: 'en-weeknav' },
        h('button', { class: 'btn btn-ghost', 'aria-label': 'Previous week', onclick: () => onWeek(addDays(sched.from, -7)) }, '‹ Prev'),
        h('span', { class: 'small', 'aria-live': 'polite' }, label),
        h('button', { class: 'btn btn-ghost', 'aria-label': 'Next week', onclick: () => onWeek(addDays(sched.from, 7)) }, 'Next ›')));
    if (!sched.occurrences.length) {
      card.append(h('p', { class: 'empty' }, 'No sessions this week.'));
      return card;
    }
    const list = h('ul', { class: 'list' });
    for (const o of sched.occurrences) {
      const [cls, text] = STATUS[o.status] || ['', o.status];
      const detail = o.status === 'closed' && o.closure_reason ? 'Closed: ' + o.closure_reason
        : o.status === 'not_started' ? 'Membership starts ' + longDay(o.membership_starts)
        : o.status === 'attended' && o.check_in_at ? 'Checked in ' + App.fmtTime(o.check_in_at, tz) + (o.check_out_at ? ', out ' + App.fmtTime(o.check_out_at, tz) : '')
        : o.status === 'paused' ? (o.end_at <= App.now() ? 'Membership was paused'
          : m && notStarted(m) ? 'Membership starts ' + longDay(m.start_date) : 'Paused until the membership is renewed') : null;
      list.append(h('li', null,
        h('div', { class: 'en-date' }, h('strong', null, o.date === today ? 'Today' : DAY[o.weekday].slice(0, 3)), h('span', { class: 'muted small' }, App.fmtDate(o.date, { weekday: undefined }))),
        h('div', { class: 'grow' }, h('div', null, h('strong', null, o.name)),
          h('div', { class: 'muted small' }, times(o) + (detail ? ' · ' + detail : ''))),
        badge(cls, text)));
    }
    card.append(list);
    return card;
  }

  function scheduleUrl(id, from) { return `${API}/students/${id}/schedule` + (from ? `?from=${from}&to=${addDays(from, 6)}` : ''); }

  function groupByDay(slots, row) {
    const frag = [];
    let day = 0, list = null;
    for (const s of slots) {
      if (s.weekday !== day) {
        day = s.weekday;
        list = h('ul', { class: 'list en-list' });
        frag.push(h('h3', { class: 'en-day' }, DAY[day] + 's'), list);
      }
      list.append(row(s));
    }
    return frag;
  }

  function seatText(s, tz) {
    const starts = s.term_start > todayIn(tz) ? ' · starts ' + App.fmtDate(s.term_start, { weekday: undefined }) : '';
    const seats = s.seats_left > 0 ? plural(s.seats_left, 'seat') + ' left' : 'Full' + (s.waiting ? ' · ' + s.waiting + ' waiting' : '');
    return times(s) + ' · ' + seats + starts;
  }

  function standing(s) {
    if (s.mine === 'enrolled') return badge('badge-ok', 'Enrolled');
    if (s.mine === 'paused') return badge('badge-warn', 'Paused');
    if (s.mine === 'waiting') return badge('badge-accent', ordinal(s.position) + ' in line');
    return null;
  }

  // ---------- parent actions ----------

  async function joinWaitlist(btn, student, slot) {
    const out = await App.run(btn, () => App.api.post(API + '/waitlist', { studentId: student.id, sessionId: slot.session_id, weekday: slot.weekday }));
    if (!out) return;
    App.toast(out.outcome === 'enrolled'
      ? `A seat was free: ${first(student.name)} is enrolled in ${slot.name}.`
      : `${first(student.name)} is ${ordinal(out.position)} in line. We'll enroll them automatically when a seat opens.`);
    App.refresh();
  }

  // Every question below is asked inline with App.confirm, in place of the
  // buttons that raised it (`el`), safe answer first.

  // A full slot: offer its waitlist (EN-5).
  const offerWaitlist = (btn, message, student, slot) => App.confirm({
    el: btn.parentNode, opener: btn, title: `${slot.name} on ${DAY[slot.weekday]}s is full`, body: message,
    confirmLabel: `Add ${first(student.name)} to the waitlist`, cancelLabel: 'Don\'t join',
  });

  async function enrollIn(btn, student, slot) {
    btn.disabled = true;
    let full = null;
    try {
      await App.api.post(API + '/enroll', { studentId: student.id, sessionId: slot.session_id, weekday: slot.weekday });
      App.toast(`${first(student.name)} is enrolled: ${slot.name}, ${slotText(slot)}.`);
    } catch (e) {
      if (e.code === 'full') full = e.message; else App.toast(e.message, 'error');
    } finally { btn.disabled = false; }
    if (full && await offerWaitlist(btn, full, student, slot)) await joinWaitlist(null, student, slot);
    App.refresh();
  }

  // EN-6: the row turns into the question; the button names the day it drops.
  async function dropEnrollment(btn, student, e) {
    const days = DAY[e.weekday] + 's';
    const ok = await App.confirm({
      el: btn.parentNode, opener: btn, danger: true,
      title: `Drop ${first(student.name)} from ${e.name} on ${days}?`,
      body: `This ends the weekly spot (${times(e)}). The seat goes to the next family on the waitlist, and you can add it again later if there is room.`,
      confirmLabel: 'Drop ' + days, cancelLabel: 'Keep ' + days,
    });
    if (!ok) return;
    const out = await App.run(btn, () => App.api.post(`${API}/enrollments/${e.id}/drop`));
    if (out) { App.toast(`Dropped ${e.name} on ${days}.`); App.refresh(); }
  }

  async function leaveWaitlist(btn, student, w) {
    const ok = await App.confirm({
      el: btn.parentNode, opener: btn, danger: true,
      title: `Take ${first(student.name)} off the waitlist for ${w.name} on ${DAY[w.weekday]}s?`, body: 'They\'ll lose their place in line.',
      confirmLabel: 'Leave the waitlist', cancelLabel: 'Keep their place',
    });
    if (!ok) return;
    const out = await App.run(btn, () => App.api.post(`${API}/waitlist/${w.id}/leave`));
    if (out) { App.toast('Removed from the waitlist.'); App.refresh(); }
  }

  async function decide(btn, r, approve) {
    const name = first(r.student_name);
    if (!approve && !(await App.confirm({
      el: btn.parentNode, opener: btn,
      title: `Decline ${name}'s request for ${r.session_name} on ${DAY[r.weekday]}s?`, body: `${name} will be told.`,
      confirmLabel: `Decline ${name}'s request`, cancelLabel: 'Keep it waiting',
    }))) return;
    const out = await App.run(btn, () => App.api.post(`${API}/requests/${r.id}/${approve ? 'approve' : 'decline'}`));
    if (!out) return App.refresh();
    if (out.outcome === 'declined') App.toast(`Declined. ${name} has been told.`);
    else if (out.outcome === 'closed') App.toast(out.message); // the slot is gone; the center's reason, not a decline
    else if (out.outcome === 'enrolled') App.toast(`Approved. ${name} is enrolled in ${r.session_name}.`);
    else if (out.outcome === 'full') {
      const slot = { session_id: r.session_id, weekday: r.weekday, name: r.session_name };
      const student = { id: r.student_id, name: r.student_name };
      if (await offerWaitlist(btn, out.message, student, slot)) await joinWaitlist(null, student, slot);
    } else App.toast(`Approved, but ${name} couldn't be enrolled. ${out.message}`, 'error'); // nothing retries it (D-17, L29)
    App.refresh();
  }

  function requestRow(r) {
    const check = r.check || { ok: true };
    return h('li', null,
      h('div', { class: 'grow' },
        h('div', null, h('strong', null, `${first(r.student_name)} asked to join ${r.session_name}`)),
        h('div', { class: 'muted small' }, slotText(r) + ' · asked ' + App.fmtDateTime(r.created_at, r.timezone)),
        !check.ok && h('div', { class: 'notice notice-warn small', style: 'margin:.5rem 0 0' }, 'Approving won\'t enroll them: ' + check.message),
        check.ok && check.full && h('div', { class: 'notice small', style: 'margin:.5rem 0 0' }, check.message)),
      h('div', { class: 'en-actions' },
        h('button', { class: 'btn btn-primary', onclick: e => decide(e.currentTarget, r, true), 'aria-label': `Approve ${first(r.student_name)}'s request for ${r.session_name} on ${DAY[r.weekday]}s` }, 'Approve'),
        h('button', { class: 'btn', onclick: e => decide(e.currentTarget, r, false), 'aria-label': `Decline ${first(r.student_name)}'s request for ${r.session_name} on ${DAY[r.weekday]}s` }, 'Decline')));
  }

  function requestsCard(pending, title) {
    return h('section', { class: 'card', 'aria-labelledby': 'en-req-h' },
      h('h2', { id: 'en-req-h' }, title + ' (' + pending.length + ')'),
      h('ul', { class: 'list en-list' }, pending.map(requestRow)));
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

  // ---------- parent screen ----------

  // #/schedule/request/<id> or #/schedule/enrollment/<id>, from an Inbox item (L35).
  const inboxRef = params => (params[0] === 'request' || params[0] === 'enrollment') ? { kind: params[0], id: Number(params[1]) } : null;

  async function renderParent(el, params) {
    const [{ students }, { requests }] = await Promise.all([App.api.get(API + '/students'), App.api.get(API + '/requests')]);
    el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Schedule'),
      h('p', null, 'Weekly study sessions for your family. Each one repeats every week through the end of the term.'))));
    const pending = requests.filter(r => r.status === 'pending');
    if (pending.length) el.append(requestsCard(pending, 'Requests from your students'));
    if (!students.length) {
      el.append(h('div', { class: 'card empty' }, 'Once your student\'s account is linked to yours, you can pick their weekly sessions here.'));
      return;
    }
    const ref = inboxRef(params);
    const pick = !ref ? params[0] : ref.kind === 'request' ? (requests.find(r => r.id === ref.id) || {}).student_id
      : (students.find(s => s.enrollments.some(e => e.id === ref.id)) || {}).id;
    const sel = students.find(s => String(s.id) === String(pick)) || students[0];
    const from = ref ? null : params[1] || null;
    const [cat, sched] = await Promise.all([App.api.get(`${API}/students/${sel.id}/catalog`), App.api.get(scheduleUrl(sel.id, from))]);
    const tabs = studentTabs(students, sel, id => App.go('schedule', id));
    if (tabs) el.append(tabs);
    const name = first(sel.name);

    // Weekly sessions
    const mine = h('section', { class: 'card', 'aria-labelledby': 'en-mine-h' },
      h('h2', { id: 'en-mine-h' }, name + '\'s weekly sessions'), membershipLine(sel.membership));
    // L52: point at "Add a session" only when its buttons work; otherwise its notice says why.
    if (!sel.enrollments.length) mine.append(h('p', { class: 'empty' }, sel.membership.can_add ? 'No weekly sessions yet. Pick one under "Add a session" below.' : 'No weekly sessions yet.'));
    else mine.append(h('ul', { class: 'list en-list' }, sel.enrollments.map(e => h('li', null,
      h('div', { class: 'grow' }, h('div', null, h('strong', null, slotText(e))),
        h('div', { class: 'muted small' }, e.name + ' · ' + e.term_name + (e.session_status === 'cancelled' ? ' · cancelled by the center' : ''))),
      e.status === 'paused' && badge('badge-warn', 'Paused'),
      h('button', { class: 'btn', onclick: ev => dropEnrollment(ev.currentTarget, sel, e), 'aria-label': `Drop ${e.name} on ${DAY[e.weekday]}s` }, 'Drop')))));
    if (sel.enrollments.some(e => e.status === 'paused')) {
      mine.append(h('p', { class: 'muted small' }, notStarted(sel.membership)
        ? `Paused sessions don't hold a seat. ${name}'s membership starts on ${longDay(sel.membership.start_date)}.`
        : 'Paused sessions don\'t hold a seat. They come back once the membership is renewed, if the seat is still free.'));
    }
    el.append(mine);

    // Waitlists
    if (sel.waitlist.length) {
      el.append(h('section', { class: 'card', 'aria-labelledby': 'en-wait-h' },
        h('h2', { id: 'en-wait-h' }, 'Waitlists'),
        sel.membership.can_add
          ? h('p', { class: 'muted small' }, `When a seat opens, ${name} is enrolled automatically and you'll get a notification.`)
          : h('div', { class: 'notice notice-warn small' }, `${name} keeps their place in line but will be skipped when a seat opens until this is sorted out: ${sel.membership.message}`),
        h('ul', { class: 'list en-list' }, sel.waitlist.map(w => h('li', null,
          h('div', { class: 'grow' }, h('div', null, h('strong', null, w.name + ' · ' + slotText(w))),
            h('div', { class: 'muted small' }, ordinal(w.position) + ' in line of ' + w.in_line)),
          h('button', { class: 'btn', onclick: ev => leaveWaitlist(ev.currentTarget, sel, w), 'aria-label': `Leave the waitlist for ${w.name} on ${DAY[w.weekday]}s` }, 'Leave'))))));
    }

    el.append(weekCard(sched, d => App.go('schedule', sel.id, d), from ? 'Week' : 'This week', sel.membership));

    // Add a session
    const add = h('section', { class: 'card', 'aria-labelledby': 'en-add-h' },
      h('h2', { id: 'en-add-h' }, 'Add a session'),
      h('p', { class: 'muted small' }, `Open sessions at ${cat.location.name}. Pick a day and time; it repeats every week.`),
      membershipNotice(cat.membership, sel.name));
    if (!cat.slots.length) add.append(h('p', { class: 'empty' }, 'No sessions are open for enrollment right now. Check back when the next term is posted.'));
    add.append(...groupByDay(cat.slots, s => {
      const label = `${s.name}, ${slotText(s)}`;
      const action = standing(s) || h('button', {
        class: 'btn' + (s.seats_left > 0 ? ' btn-primary' : ''), disabled: !s.can_add,
        'aria-label': (s.seats_left > 0 ? `Enroll ${name} in ` : `Join the waitlist for `) + label,
        onclick: ev => s.seats_left > 0 ? enrollIn(ev.currentTarget, sel, s) : joinWaitlist(ev.currentTarget, sel, s),
      }, s.seats_left > 0 ? 'Enroll' : 'Join waitlist');
      return h('li', null,
        h('div', { class: 'grow' }, h('div', null, h('strong', null, s.name)), h('div', { class: 'muted small' }, seatText(s, cat.location.timezone)),
          s.mine === 'requested' && h('div', { class: 'small' }, badge('badge-accent', name + ' asked for this'))),
        action);
    }));
    el.append(add);
  }

  // ---------- student screen ----------

  const REQ_STATE = {
    pending: () => ['badge-accent', 'Waiting for a parent'],
    declined: r => (r.decided_by ? ['', 'Declined'] : ['', 'Closed']), // no decider: the slot was gone
    approved: r => r.outcome === 'enrolled' ? ['badge-ok', 'Approved · enrolled'] : r.outcome === 'full' ? ['badge-warn', 'Approved · session full'] : ['badge-warn', 'Approved · not enrolled'],
  };

  async function askToJoin(btn, s) {
    const out = await App.run(btn, () => App.api.post(API + '/requests', { sessionId: s.session_id, weekday: s.weekday }));
    if (out) { App.toast('Sent to your parent. You\'ll get a notification when they decide.'); App.refresh(); }
  }

  async function renderStudent(el, params) {
    const [{ students }, { requests }] = await Promise.all([App.api.get(API + '/students'), App.api.get(API + '/requests')]);
    const me = students[0];
    const from = inboxRef(params) ? null : params[1] || null;
    const [cat, sched] = await Promise.all([App.api.get(`${API}/students/${me.id}/catalog`), App.api.get(scheduleUrl(me.id, from))]);
    el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'My schedule'),
      h('p', null, `Your weekly sessions at ${me.location.name}.`))));
    if (lapsed(me.membership)) {
      el.append(h('div', { class: 'notice notice-warn', role: 'note' }, lapsedText(me.enrollments.some(e => e.status === 'paused'), me.location.name)));
    }

    el.append(weekCard(sched, d => App.go('schedule', me.id, d), from ? 'Week' : 'This week', me.membership));

    const mine = h('section', { class: 'card', 'aria-labelledby': 'en-mine-h' }, h('h2', { id: 'en-mine-h' }, 'Every week'), membershipLine(me.membership));
    if (!me.enrollments.length) mine.append(h('p', { class: 'empty' }, 'No weekly sessions yet. Ask a parent to add one below.'));
    else mine.append(h('ul', { class: 'list en-list' }, me.enrollments.map(e => h('li', null,
      h('div', { class: 'grow' }, h('div', null, h('strong', null, slotText(e))), h('div', { class: 'muted small' }, e.name)),
      e.status === 'paused' && badge('badge-warn', 'Paused')))));
    for (const w of me.waitlist) {
      mine.append(h('p', { class: 'small' }, badge('badge-accent', ordinal(w.position) + ' in line'), ' ', `${w.name}, ${slotText(w)}. You'll be added automatically when a seat opens.`));
    }
    el.append(mine);

    if (requests.length) {
      el.append(h('section', { class: 'card', 'aria-labelledby': 'en-myreq-h' }, h('h2', { id: 'en-myreq-h' }, 'Your requests'),
        h('ul', { class: 'list en-list' }, requests.map(r => {
          const [cls, text] = REQ_STATE[r.status](r);
          return h('li', null,
            h('div', { class: 'grow' }, h('div', null, h('strong', null, r.session_name)),
              h('div', { class: 'muted small' }, slotText(r) + (r.decided_by_name ? ' · ' + first(r.decided_by_name) : '')),
              (r.status === 'approved' && r.outcome !== 'enrolled' || r.status === 'declined' && !r.decided_by) && r.outcome_message && h('div', { class: 'small' }, r.outcome_message)),
            badge(cls, text));
        }))));
    }

    const add = h('section', { class: 'card', 'aria-labelledby': 'en-ask-h' },
      h('h2', { id: 'en-ask-h' }, 'Ask to join a session'),
      h('p', { class: 'muted small' }, 'Your parent gets your request and decides. Sessions repeat every week through the end of the term.'),
      studentNotice(cat.membership));
    if (!cat.slots.length) add.append(h('p', { class: 'empty' }, 'No sessions are open right now. Check back when the next term is posted.'));
    add.append(...groupByDay(cat.slots, s => h('li', null,
      h('div', { class: 'grow' }, h('div', null, h('strong', null, s.name)), h('div', { class: 'muted small' }, seatText(s, cat.location.timezone))),
      standing(s) || (s.mine === 'requested' ? badge('badge-accent', 'Asked') : h('button', {
        class: 'btn', onclick: ev => askToJoin(ev.currentTarget, s), 'aria-label': `Ask a parent for ${s.name}, ${slotText(s)}`,
      }, 'Ask to join')))));
    el.append(add);
  }

  App.register({
    id: 'schedule', title: 'Schedule', icon: '📅', roles: ['parent', 'student'], order: 20,
    render: (el, params) => (App.role() === 'parent' ? renderParent(el, params) : renderStudent(el, params)),
  });
  // Requests, answers, enrollments and waitlist promotions open Schedule from the
  // Inbox on the student they are about (L35): #/schedule/request/<id>, #/schedule/enrollment/<id>.
  App.inboxLink('enrollment_request', n => 'schedule/request/' + n.ref_id);
  App.inboxLink('enrollment', n => 'schedule/enrollment/' + n.ref_id);

  // ---------- Home cards ----------

  App.card({
    id: 'enrollment-requests', roles: ['parent'], order: 25,
    async render(box) {
      const { requests } = await App.api.get(API + '/requests');
      const pending = requests.filter(r => r.status === 'pending');
      if (pending.length) box.append(requestsCard(pending, 'Session requests'));
    },
  });

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
          card.append(h('p', { class: 'muted small' }, App.role() !== 'parent' ? 'No sessions this week. Ask a parent for one from Schedule.'
            : students[i].membership.can_add ? 'No sessions this week. Add one from Schedule.' : 'No sessions this week.')); // L52
          return;
        }
        card.append(h('ul', { class: 'list' }, rows.map(o => {
          const [cls, text] = STATUS[o.status] || ['', o.status];
          return h('li', null,
            h('div', { class: 'grow' }, h('strong', null, (o.date === today ? 'Today' : DAY[o.weekday].slice(0, 3)) + ' ' + times(o)),
              h('div', { class: 'muted small' }, o.name)),
            badge(cls, text));
        })));
      });
      box.append(card);
    },
  });
})();
