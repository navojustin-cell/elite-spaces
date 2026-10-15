/* Announcements and emergency alerts (PRD 5, AN-1..AN-6).
   - News (#/news): the caller's feed, pinned emergency alerts, scheduled posts and
     delivery/read numbers for senders, and the family mute setting. #/news/<id>
     (from an Inbox item) brings that post into view.
   - #/news/new: compose an announcement (audience, schedule, review step).
   - #/news/emergency: the separate emergency alert flow with a confirm step.
   - Home card: active emergency alerts and the latest announcement. */
(function () {
  'use strict';
  const { h } = App;
  const API = '/api/announcements';
  const EMERGENCY_MAX = 300;

  // Only what app.css cannot express: honoring [hidden] on .field/.check (their
  // display rule overrides it), keeping line breaks in messages, the small numbers
  // row, and a darker red for alerts in dark mode (white on the dark-mode --danger
  // token is too low-contrast).
  if (!document.getElementById('ann-style')) {
    document.head.append(h('style', { id: 'ann-style' }, `
      .view-news [hidden] { display: none !important; }
      .view-news .check input { flex: none; }
      .ann-body { white-space: pre-wrap; overflow-wrap: anywhere; margin: .35rem 0 .5rem; }
      .ann-meta { font-size: .85rem; color: var(--muted); margin: 0; }
      .emergency .ann-meta, .emergency .stat-label { color: #fff; }
      .emergency .ann-stats { border-top-color: rgba(255,255,255,.4); }
      .emergency .btn { background: #fff; color: #7a1009; border-color: #fff; }
      .ann-stats { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; align-items: center; margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--line); }
      .ann-stats b { display: block; font-size: 1.15rem; line-height: 1.1; }
      .ann-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
      .ann-actions .btn { flex: 1 1 auto; }
      .ann-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-bottom: .25rem; }
      .ann-head h3 { margin: 0; flex: 1 1 100%; }
      .view-news [data-target] { box-shadow: 0 0 0 3px var(--focus); }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .emergency.ann-alert, :root:not([data-theme="light"]) .btn-danger.ann-danger { background: #8f1d14; border-color: #ff8b80; } }
      :root[data-theme="dark"] .emergency.ann-alert, :root[data-theme="dark"] .btn-danger.ann-danger { background: #8f1d14; border-color: #ff8b80; }
    `));
  }

  // ---------- small helpers ----------
  const count = (k, one, many) => k + ' ' + (k === 1 ? one : (many || one + 's'));
  const andList = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  const days = s => String(s.weekdays).split(',').map(d => App.WEEKDAYS[Number(d)]).join('/');
  // The term, when known, tells same-named sessions in different terms apart.
  const sessionLabel = s => s.name + ' · ' + days(s) + ' ' + App.hhmm(s.start_time) + '–' + App.hhmm(s.end_time) + (s.term_name ? ' · ' + s.term_name : '');
  const isComposer = () => App.allowed(['director']);
  const isFamily = () => ['parent', 'student'].includes(App.role());
  const zoneName = tz => {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(App.now()).find(x => x.type === 'timeZoneName');
      return p ? p.value : tz;
    } catch (_) { return tz; }
  };
  const localDate = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const nextDay = d => new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const wallTime = v => App.fmtDate(v.slice(0, 10), { weekday: 'long', month: 'long', day: 'numeric' }) + ' at ' + App.hhmm(v.slice(11, 16));

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode: drafts just are not kept */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  const draftKey = () => 'elite.announcements.draft.' + App.me.user.id;
  const hiddenKey = () => 'elite.announcements.hidden.' + App.me.user.id;

  function audienceText(p) {
    if (p.audience === 'session') return p.session ? 'Families in ' + sessionLabel(p.session) : 'Families in one session';
    return { families: 'All families', parents: 'Parents only', students: 'Students only', everyone: 'Everyone at the location' }[p.audience] || '';
  }

  function fromText(p) {
    const who = p.sender.role === 'hq' ? 'ELITE HQ' : p.sender.name;
    const where = App.role() === 'hq' && p.location_count > 1 ? p.location_count + ' locations' : p.locations.map(l => l.name).join(', ');
    return [who, where].filter(Boolean).join(', ');
  }

  // v1 has no reply thread, so every post tells families where to take questions.
  function contactLine(p) {
    const l = p.locations[0];
    if (!l || !isFamily()) return null;
    return h('p', { class: 'ann-meta' }, 'Questions? Ask the ' + l.name + ' front desk' + (l.address ? ' at ' + l.address : '') + '.');
  }

  // Delivered counts a notification delivered, or (for someone with notifications
  // off) the post seen in News; Read counts a post seen in News, opened from the
  // Inbox or acknowledged on the alert pop-up. Both are out of Sent to (AN-6).
  function statsBlock(p) {
    const box = h('div', { class: 'ann-stats' });
    const live = h('span', { class: 'sr-only', 'aria-live': 'polite' });
    const item = (n, label) => h('div', null, h('b', null, String(n)), h('span', { class: 'stat-label' }, label));
    const fill = s => box.replaceChildren(...[
      item(s.recipients, 'Sent to'),
      item(s.delivered, 'Delivered'),
      item(s.read, 'Read'),
      s.muted && item(s.muted, 'Notifications off'),
      h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': 'Refresh numbers for ' + p.title, onclick: e => App.run(e.currentTarget, async () => {
        const fresh = await App.api.get(API + '/' + p.id + '/stats');
        fill(fresh);
        live.textContent = 'Updated: ' + fresh.read + ' of ' + fresh.recipients + ' have read it.';
      }) }, 'Refresh numbers'),
      live,
    ].filter(Boolean));
    fill(p.stats);
    return box;
  }

  // One post, as its readers see it. Emergency alerts are red, labeled and iconed (AN-5).
  // target: the post an Inbox item opened, focusable so the view can bring it into view.
  function postCard(p, { pinned = false, onHide = null, target = false } = {}) {
    const meta = h('p', { class: 'ann-meta' }, fromText(p) + ' · ' + (p.when_text || App.fmtDateTime(p.published_at || p.publish_at, p.tz)));
    const at = target ? { tabindex: '-1', 'data-target': '' } : {};
    if (p.type === 'emergency') {
      return h('article', Object.assign({ class: 'emergency ann-alert', 'aria-label': 'Emergency alert: ' + p.title }, at),
        h('div', { class: 'label' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), pinned ? 'Emergency alert · active now' : 'Emergency alert'),
        h('h3', { style: 'margin:.2rem 0 0' }, p.title),
        h('p', { class: 'ann-body' }, p.body),
        meta,
        contactLine(p),
        App.isOps() && h('p', { class: 'ann-meta' }, 'Sent to everyone at the location. Nobody can mute emergency alerts.'),
        p.stats && statsBlock(p),
        onHide && h('div', { style: 'margin-top:.6rem' }, h('button', { class: 'btn', type: 'button', onclick: onHide, 'aria-label': 'Hide this alert from Home' }, 'Hide from Home')));
    }
    return h('article', Object.assign({ class: 'card', 'aria-label': p.title }, at),
      h('div', { class: 'ann-head' },
        p.category_label && h('span', { class: 'badge' }, p.category_label),
        p.unread && h('span', { class: 'badge badge-accent' }, 'New'),
        h('h3', null, p.title)),
      h('p', { class: 'ann-body' }, p.body),
      meta,
      App.isOps() && h('p', { class: 'ann-meta' }, 'Sent to: ' + audienceText(p)),
      contactLine(p),
      p.stats && statsBlock(p));
  }

  // ---------- News feed ----------
  // focusId: the post an Inbox item opened (#/news/<id>).
  async function renderFeed(el, focusId = null) {
    const f = await App.api.get(API + '/feed' + (focusId ? '?limit=100' : ''));
    const place = App.me.location ? App.me.location.name : 'every ELITE Spaces location';
    el.append(h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'News'), h('p', null, isFamily() ? 'Announcements from ' + place + '.' : 'Announcements and alerts for ' + place + '.')),
      isComposer() && h('div', { class: 'ann-actions' },
        h('a', { class: 'btn btn-primary', href: '#/news/new' }, 'New announcement'),
        h('a', { class: 'btn btn-danger ann-danger', href: '#/news/emergency' }, h('span', { 'aria-hidden': 'true' }, '⚠'), 'Send emergency alert'))));

    const found = !focusId || [...f.active_emergencies, ...f.posts].some(p => p.id === focusId);
    if (!found) el.append(h('div', { class: 'notice', role: 'status' }, 'That announcement is no longer in your News. Here is everything that is.'));

    for (const p of f.active_emergencies) el.append(postCard(p, { pinned: true, target: p.id === focusId }));

    if (f.scheduled.length) {
      const list = h('ul', { class: 'list' });
      for (const p of f.scheduled) {
        const cancel = h('button', { class: 'btn', type: 'button', 'aria-label': 'Cancel scheduled post: ' + p.title }, 'Cancel');
        cancel.addEventListener('click', async () => {
          const ok = await App.confirm({ anchor: cancel, opener: cancel, title: 'Cancel "' + p.title + '"?',
            body: 'It will not be sent, and families will never see it.', confirmLabel: 'Cancel post', cancelLabel: 'Keep scheduled', danger: true });
          if (ok) App.run(cancel, async () => { await App.api.del(API + '/' + p.id); App.toast('Scheduled post cancelled.'); App.refresh(); });
        });
        list.append(h('li', null,
          h('div', { class: 'grow' },
            h('strong', null, p.title),
            h('div', { class: 'muted small' }, 'Goes out ' + App.fmtDateTime(p.publish_at, p.tz) + ' (' + (p.locations[0] ? p.locations[0].name + ' time' : 'local time') + ')'),
            h('div', { class: 'muted small' }, (p.category_label ? p.category_label + ' · ' : '') + audienceText(p) + (App.role() === 'hq' ? ' · ' + fromText(p) : ''))),
          cancel));
      }
      el.append(h('section', { class: 'card', 'aria-labelledby': 'ann-sched' }, h('h2', { id: 'ann-sched' }, 'Scheduled'), list));
    }

    const pinnedIds = new Set(f.active_emergencies.map(p => p.id));
    const posts = f.posts.filter(p => !pinnedIds.has(p.id));
    const feed = h('section', { 'aria-labelledby': 'ann-feed' }, h('h2', { id: 'ann-feed', class: 'sr-only' }, 'All posts'));
    if (!posts.length && !pinnedIds.size) {
      feed.append(h('div', { class: 'card empty' }, isComposer()
        ? 'Nothing posted yet. Use New announcement to share events, workshops, holidays or session news with families.'
        : 'No announcements yet. When ' + (App.me.location ? App.me.location.name : 'your location') + ' shares news, like events, workshops or closures, it will show up here.'));
    }
    for (const p of posts) feed.append(postCard(p, { target: p.id === focusId }));
    el.append(feed);

    // The view goes on screen right after this returns; then bring the opened post into view.
    const target = focusId && el.querySelector('[data-target]');
    if (target) setTimeout(() => { if (target.isConnected) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); } }, 0);

    // Seeing a post in News counts as reading it (AN-6), and the bell drops to match.
    const reads = [...f.active_emergencies, ...f.posts].filter(p => p.unread).map(p => App.api.post(API + '/' + p.id + '/read').catch(() => {}));
    if (reads.length) Promise.all(reads).then(() => App.refreshBell());

    if (isFamily()) {
      const cb = h('input', { type: 'checkbox', id: 'ann-notify', checked: !f.muted });
      cb.addEventListener('change', async () => {
        const on = cb.checked;
        const ok = await App.run(cb, async () => { await App.api.put(API + '/prefs', { muted: !on }); return true; });
        if (!ok) { cb.checked = !on; return; }
        App.toast(on ? 'You will get a notification for new announcements.' : 'Announcement notifications are off. Emergency alerts will still reach you.');
      });
      el.append(h('section', { class: 'card', 'aria-labelledby': 'ann-prefs' },
        h('h2', { id: 'ann-prefs' }, 'Notifications'),
        h('label', { class: 'check', for: 'ann-notify' }, cb, h('span', null, 'Notify me about new announcements')),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Emergency alerts always reach you, even with this off. Every announcement stays here in News either way.')));
    }
  }

  // ---------- compose (announcement or emergency) ----------
  async function renderCompose(el, emergency) {
    el.append(h('div', { class: 'page-head' },
      h('div', null,
        h('h1', null, emergency ? 'Send an emergency alert' : 'New announcement'),
        h('p', null, emergency ? 'For urgent safety news only.' : 'Share news with families. You can review it before it goes out.')),
      h('a', { class: 'btn btn-ghost', href: '#/news' }, '← Back to News')));
    if (!isComposer()) {
      el.append(h('div', { class: 'notice' }, 'Only directors and HQ can post announcements. Ask your director if something needs to go out.'));
      return;
    }
    const isHq = App.role() === 'hq';
    const [opts, locRes] = await Promise.all([App.api.get(API + '/options'), App.api.get('/api/locations')]);
    // Closed locations are listed too: HQ can still send them alerts and posts (R5).
    const locations = locRes.locations.slice().sort((a, b) => a.id - b.id);
    const draft = emergency ? {} : store.get(draftKey(), {});

    const form = h('form', { class: 'card', novalidate: true });
    const review = h('section', { class: 'card', hidden: true, 'aria-labelledby': 'ann-review-h' });

    // Locations (HQ only; a director always posts to their own location).
    const locMode = { all: h('input', { type: 'radio', name: 'ann-locmode', value: 'all', checked: draft.locMode !== 'some' }),
      some: h('input', { type: 'radio', name: 'ann-locmode', value: 'some', checked: draft.locMode === 'some' }) };
    const locChecks = locations.map(l => ({ l, input: h('input', { type: 'checkbox', value: String(l.id), checked: (draft.locIds || []).includes(l.id) }) }));
    const locList = h('div', { style: 'padding-left:1.75rem' }, locChecks.map(c => h('label', { class: 'check' }, c.input,
      h('span', null, c.l.name, !c.l.active && h('span', { class: 'muted small' }, ' (closed)')))));
    const locField = isHq && h('fieldset', null, h('legend', null, 'Which locations?'),
      h('label', { class: 'check' }, locMode.all, h('span', null, 'All locations (' + locations.length + ')')),
      h('label', { class: 'check' }, locMode.some, h('span', null, 'Choose locations')),
      locList);
    const chosenLocIds = () => locMode.all.checked ? locations.map(l => l.id) : locChecks.filter(c => c.input.checked).map(c => c.l.id);

    // Audience (AN-4). Emergency alerts have no audience: they go to everyone (AN-5).
    const AUD = [['families', 'All families', 'parents and students'], ['parents', 'Parents only'], ['students', 'Students only'], ['session', 'Families in one session', 'its students and their parents']];
    const audIn = {};
    const audField = !emergency && h('fieldset', null, h('legend', null, 'Who should get this?'),
      AUD.map(([v, label, hint]) => {
        audIn[v] = h('input', { type: 'radio', name: 'ann-aud', value: v, checked: (draft.audience || 'families') === v });
        return h('label', { class: 'check' }, audIn[v], h('span', null, label, hint && h('span', { class: 'muted small' }, ' (' + hint + ')')));
      }));
    const audience = () => emergency ? 'everyone' : (Object.keys(audIn).find(k => audIn[k].checked) || 'families');
    const sessionSel = h('select', { id: 'ann-session' },
      h('option', { value: '' }, opts.sessions.length ? 'Choose a session' : 'No sessions yet'),
      opts.sessions.map(s => h('option', { value: String(s.id), selected: String(draft.sessionId) === String(s.id) },
        (isHq ? s.location_name + ' · ' : '') + sessionLabel(s) + ' · ' + count(s.enrolled, 'student') + ' enrolled')));
    const sessionField = !emergency && h('label', { class: 'field', for: 'ann-session' }, h('span', null, 'Session'), sessionSel);
    const chosenSession = () => opts.sessions.find(s => String(s.id) === sessionSel.value) || null;

    const catSel = h('select', { id: 'ann-cat' }, Object.entries(opts.categories).map(([k, label]) =>
      h('option', { value: k, selected: (draft.category || 'news') === k }, label)));
    const catField = !emergency && h('label', { class: 'field', for: 'ann-cat' }, h('span', null, 'Kind of post'), catSel);

    const max = emergency ? opts.emergency_max || EMERGENCY_MAX : opts.body_max;
    const title = h('input', { id: 'ann-title', type: 'text', maxlength: String(opts.title_max), required: true, autocomplete: 'off',
      placeholder: emergency ? 'e.g. Building closed: power outage' : 'e.g. Pumpkin carving on Friday', value: draft.title || '' });
    const body = h('textarea', { id: 'ann-body', maxlength: String(max), required: true, 'aria-describedby': 'ann-body-hint',
      placeholder: emergency ? 'Say what happened and exactly what families should do now.' : 'Add the details families need: what, when and where.' });
    body.value = draft.body || '';
    const bodyHint = h('div', { class: 'hint', id: 'ann-body-hint' });
    const updateHint = () => { bodyHint.textContent = (max - body.value.length) + ' characters left' + (emergency ? '. Keep it short and clear.' : ''); };
    body.addEventListener('input', updateHint);
    updateHint();

    // When (AN-3). No scheduling for emergencies.
    const whenNow = h('input', { type: 'radio', name: 'ann-when', value: 'now', checked: draft.when !== 'later' });
    const whenLater = h('input', { type: 'radio', name: 'ann-when', value: 'later', checked: draft.when === 'later' });
    const atInput = h('input', { id: 'ann-at', type: 'datetime-local', value: draft.at || '', 'aria-describedby': 'ann-at-hint' });
    const atHint = h('div', { class: 'hint', id: 'ann-at-hint' });
    const atField = h('label', { class: 'field', for: 'ann-at', style: 'padding-left:1.75rem;margin:0' }, h('span', null, 'Date and time'), atInput, atHint);
    const whenField = !emergency && h('fieldset', null, h('legend', null, 'When should it go out?'),
      h('label', { class: 'check' }, whenNow, h('span', null, 'Send now')),
      h('label', { class: 'check' }, whenLater, h('span', null, 'Schedule for later')),
      atField);

    // The schedule time is wall-clock time at the post's location (the first one, for HQ).
    const zoneLoc = () => {
      const s = audience() === 'session' && chosenSession();
      if (s) return { name: s.location_name, timezone: s.timezone };
      if (!isHq) return App.me.location;
      const ids = chosenLocIds();
      return locations.find(l => ids.includes(l.id)) || locations[0] || null;
    };

    function sync() {
      if (locField) locList.hidden = !locMode.some.checked;
      if (locField) locField.hidden = audience() === 'session';
      if (sessionField) sessionField.hidden = audience() !== 'session';
      if (whenField) {
        atField.hidden = !whenLater.checked;
        const z = zoneLoc();
        if (whenLater.checked && !atInput.value && z) atInput.value = nextDay(localDate(App.now(), z.timezone)) + 'T09:00';
        atHint.textContent = z ? z.name + ' time (' + zoneName(z.timezone) + ').' : '';
      }
      if (!emergency) store.set(draftKey(), {
        locMode: locMode.some.checked ? 'some' : 'all', locIds: locChecks.filter(c => c.input.checked).map(c => c.l.id),
        audience: audience(), sessionId: sessionSel.value, category: catSel.value, title: title.value, body: body.value,
        when: whenLater.checked ? 'later' : 'now', at: atInput.value,
      });
    }
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);

    const payload = () => {
      const b = { title: title.value.trim(), body: body.value.trim() };
      if (emergency) b.type = 'emergency';
      else {
        b.category = catSel.value;
        b.audience = audience();
        if (b.audience === 'session') b.session_id = Number(sessionSel.value) || null;
        if (whenLater.checked) b.publish_at = atInput.value.slice(0, 16);
      }
      if (isHq && audience() !== 'session') b.locations = locMode.all.checked ? 'all' : chosenLocIds();
      return b;
    };

    // Problems we can name before asking the server; the server checks everything again.
    const firstProblem = b => {
      if (isHq && b.locations && b.locations !== 'all' && !b.locations.length) return 'Choose at least one location.';
      if (!emergency && b.audience === 'session' && !b.session_id) return 'Choose a session.';
      if (!b.title) return 'Add a title.';
      if (!b.body) return 'Add a message.';
      if (!emergency && whenLater.checked && !b.publish_at) return 'Pick a date and time, or choose Send now.';
      return null;
    };

    const submit = h('button', { class: 'btn btn-block ' + (emergency ? 'btn-danger ann-danger' : 'btn-primary'), type: 'submit' },
      emergency ? 'Review alert' : 'Review');

    form.append(...[
      emergency && h('div', { class: 'notice notice-danger' },
        'An emergency alert goes out right away to everyone at ' + (isHq ? 'the locations you pick' : App.me.location.name) +
        ': parents, students and staff. It cannot be scheduled, and nobody can mute it.'),
      locField, audField, sessionField, catField,
      h('label', { class: 'field', for: 'ann-title' }, h('span', null, emergency ? 'Headline' : 'Title'), title),
      h('label', { class: 'field', for: 'ann-body' }, h('span', null, emergency ? 'What should people do?' : 'Message'), body, bodyHint),
      whenField, submit,
    ].filter(Boolean));

    form.addEventListener('submit', e => {
      e.preventDefault();
      const b = payload();
      const problem = firstProblem(b);
      if (problem) return App.toast(problem, 'error');
      App.run(submit, async () => {
        const pv = await App.api.post(API + '/preview', b);
        showReview(b, pv);
      });
    });

    function showReview(b, pv) {
      const s = audience() === 'session' && chosenSession();
      const where = andList(pv.locations);
      const breakdown = andList([pv.parents && count(pv.parents, 'parent'), pv.students && count(pv.students, 'student'),
        pv.staff && count(pv.staff, 'staff member')].filter(Boolean));
      const preview = {
        id: 0, type: emergency ? 'emergency' : 'announcement', title: b.title, body: b.body, audience: b.audience || 'everyone',
        category_label: emergency ? null : opts.categories[b.category], session: s || null, unread: false, stats: null,
        sender: { name: App.me.user.name, role: App.role() }, locations: pv.locations.map(name => ({ name })), location_count: pv.locations.length,
        published_at: App.now(), tz: (zoneLoc() || {}).timezone,
        when_text: b.publish_at ? wallTime(b.publish_at) : 'Just now',
      };
      const back = h('button', { class: 'btn', type: 'button', onclick: () => { review.hidden = true; form.hidden = false; title.focus(); } },
        emergency ? 'Go back and edit' : 'Edit');
      const send = h('button', { class: 'btn ' + (emergency ? 'btn-danger ann-danger' : 'btn-primary'), type: 'button' },
        emergency ? [h('span', { 'aria-hidden': 'true' }, '⚠'), 'Send alert now'] : (b.publish_at ? 'Schedule post' : 'Post now'));
      send.addEventListener('click', () => App.run(send, async () => {
        const r = await App.api.post(API + (emergency ? '/emergency' : ''), b);
        if (!emergency) store.del(draftKey());
        App.toast(emergency ? 'Emergency alert sent to ' + count(r.recipients, 'person', 'people') + '.'
          : r.recipients == null ? 'Scheduled for ' + wallTime(b.publish_at) + '.'
            : 'Posted. ' + count(r.notified, 'person', 'people') + ' notified.');
        App.go('news');
      }));
      const heading = h('h2', { id: 'ann-review-h', tabindex: '-1' }, emergency ? 'Send this alert now?' : 'Review before sending');
      review.replaceChildren(...[
        heading,
        emergency
          ? h('p', null, 'It goes to ' + count(pv.recipients, 'person', 'people') + ' at ' + where + ' right away' + (breakdown ? ': ' + breakdown : '') + '. ',
            h('strong', null, 'It cannot be muted, scheduled or taken back.'))
          : h('p', null, (b.publish_at ? 'If it went out now, it would reach ' : 'This will reach ') + count(pv.recipients, 'person', 'people') +
            (s ? ' in ' + sessionLabel(s) : '') + ' at ' + where + (breakdown ? ': ' + breakdown : '') + '.'),
        !emergency && pv.muted > 0 && h('p', { class: 'muted small' }, count(pv.muted, 'of them has', 'of them have') +
          ' turned off announcement notifications. They will still see it in News.'),
        !pv.recipients && h('div', { class: 'notice notice-warn' }, s ? 'Nobody is enrolled in this session right now.' : 'Nobody matches this audience right now.',
          b.publish_at ? ' Who gets it is checked again when it goes out.' : ''),
        b.publish_at && h('p', null, 'It will go out on ' + wallTime(b.publish_at) + ', ' + (zoneLoc() ? zoneLoc().name + ' time' : 'local time') + '.'),
        h('h3', null, 'What people will see'),
        postCard(preview),
        h('div', { class: 'ann-actions' }, send, back),
      ].filter(Boolean));
      form.hidden = true;
      review.hidden = false;
      heading.focus();
    }

    el.append(form, review);
    sync();
  }

  // The News feed and the Home card on screen now, kept current by the live updates below.
  let feedBox = null, homeBox = null;

  App.register({
    id: 'news', title: 'News', icon: '📣', order: 50,
    async render(el, params) {
      const mode = params && params[0];
      feedBox = null;
      if (mode === 'new') return renderCompose(el, false);
      if (mode === 'emergency') return renderCompose(el, true);
      feedBox = el;
      return renderFeed(el, /^\d+$/.test(mode || '') ? Number(mode) : null);
    },
  });

  // ---------- Home: active emergency alerts and the latest announcement ----------
  App.card({
    id: 'announcements', order: 1,
    async render(el) {
      homeBox = el;
      return renderHomeCard(el);
    },
  });

  async function renderHomeCard(el) {
    const f = await App.api.get(API + '/feed?limit=10');
    const hidden = store.get(hiddenKey(), []);
    for (const p of f.active_emergencies) {
      if (hidden.includes(p.id)) continue;
      const banner = postCard(p, { pinned: true, onHide: () => {
        store.set(hiddenKey(), [...store.get(hiddenKey(), []), p.id].slice(-50));
        banner.remove();
        App.toast('Alert hidden from Home. It stays in News.');
      } });
      el.append(banner);
    }
    const latest = f.posts.find(p => p.type !== 'emergency');
    const where = App.me.location ? App.me.location.name : 'your locations';
    el.append(h('section', { class: 'card', 'aria-labelledby': 'home-news-h' },
      h('div', { class: 'row between' },
        h('h2', { id: 'home-news-h', style: 'margin:0' }, 'Latest news'),
        h('a', { class: 'btn btn-ghost', href: '#/news' }, 'See all news')),
      latest
        ? h('div', { style: 'margin-top:.5rem' },
          h('div', { class: 'ann-head' }, latest.category_label && h('span', { class: 'badge' }, latest.category_label),
            latest.unread && h('span', { class: 'badge badge-accent' }, 'New'), h('h3', null, latest.title)),
          h('p', { class: 'ann-body' }, latest.body.length > 200 ? latest.body.slice(0, 197).trimEnd() + '…' : latest.body),
          h('p', { class: 'ann-meta' }, fromText(latest) + ' · ' + App.fmtDateTime(latest.published_at, latest.tz)))
        : h('p', { class: 'muted', style: 'margin:.5rem 0 0' }, 'No announcements yet. News from ' + where + ' will show up here.'),
      isComposer() && h('div', { class: 'ann-actions', style: 'margin-top:.75rem' },
        h('a', { class: 'btn btn-primary', href: '#/news/new' }, 'New announcement'),
        h('a', { class: 'btn btn-danger ann-danger', href: '#/news/emergency' }, h('span', { 'aria-hidden': 'true' }, '⚠'), 'Send emergency alert'))));
  }

  // ---------- live updates (AN-5, AN-6) ----------
  // The shell pops up every emergency alert that streams in (showEmergency in
  // app.js, a .emergency alertdialog on <body>) and removes it when the person
  // taps "I have read this". Watching for that pop-up keeps the pinned alerts on
  // Home and News current without a reload, and the tap counts as reading the
  // alert, so the sender's read count includes it and the bell drops.
  let redraws = 0;
  async function redrawLive() {
    const seq = ++redraws;
    for (const [box, draw] of [[homeBox, renderHomeCard], [feedBox, renderFeed]]) {
      if (!box || !box.isConnected) continue;
      const fresh = h('div');
      try { await draw(fresh); } catch (_) { continue; } // keep what is on screen
      if (seq !== redraws || !box.isConnected) continue;
      // Focus inside the old content would drop to the top of the page; it goes to the page heading.
      const hadFocus = box.contains(document.activeElement);
      box.replaceChildren(...fresh.childNodes);
      if (hadFocus) focusHeading();
    }
  }
  function focusHeading() {
    const head = document.querySelector('#main h1');
    if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
  }
  // The pop-up carries the notification it shows, so exactly that alert is marked
  // read, even when two alerts share a title.
  async function acknowledge(popup) {
    const id = Number(popup.getAttribute('data-notification-id'));
    if (!id) return;
    try { await App.api.post('/api/notifications/' + id + '/read'); } catch (_) { /* signed out: nothing to count */ }
  }
  const isAlertPopup = n => n.nodeType === 1 && n.matches('.emergency[role="alertdialog"]');
  new MutationObserver(records => {
    if (!App.me) return;
    const arrived = records.some(r => [...r.addedNodes].some(isAlertPopup));
    const acknowledged = records.flatMap(r => [...r.removedNodes].filter(isAlertPopup));
    if (acknowledged.length) Promise.all(acknowledged.map(acknowledge)).then(() => { App.refreshBell(); return redrawLive(); });
    else if (arrived) redrawLive();
  }).observe(document.body, { childList: true });

  // An announcement or alert in the Inbox opens that post in News.
  App.inboxLink('announcement', n => (n.ref_id ? 'news/' + n.ref_id : 'news'));
})();
