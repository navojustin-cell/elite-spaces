/* ELITE Spaces client shell: sign-in, role-based navigation, hash router,
   notifications inbox, toasts and the dev bar. Module views register with
   App.register() from public/js/views/<module>.js. */
(function () {
  'use strict';

  const App = {
    me: null,        // { user, location, dev, now }
    views: [],
    unread: 0,
  };

  // ---------- helpers ----------
  // h('div', { class: 'card', onclick: fn }, 'text', childNode, [more])
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = c => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }
  App.h = h;
  App.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // JSON API. Throws Error with .status / .code / message on non-2xx.
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const e = new Error((data && data.message) || 'Request failed.');
      e.status = res.status; e.code = data && data.error;
      if (res.status === 401 && App.me) { App.me = null; render(); }
      throw e;
    }
    return data;
  }
  App.api = {
    get: u => api('GET', u), post: (u, b = {}) => api('POST', u, b), put: (u, b = {}) => api('PUT', u, b),
    patch: (u, b = {}) => api('PATCH', u, b), del: u => api('DELETE', u),
  };

  App.toast = (msg, kind) => {
    const t = h('div', { class: 'toast' + (kind === 'error' ? ' toast-error' : '') }, msg);
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
  };
  // Wrap an async action: shows errors as toasts, disables the button while running.
  App.run = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { App.toast(e.message, 'error'); } finally { if (btn) btn.disabled = false; }
  };

  // Times: always show in the relevant location's zone.
  App.tz = () => (App.me && App.me.location && App.me.location.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  App.fmtTime = (ms, tz) => ms == null ? '—' : new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || App.tz() }).format(ms);
  // A 'YYYY-MM-DD' string is a calendar date and always reads as that date. An
  // instant (ms) reads in opts.timeZone when the caller passes one (e.g. the
  // event's location, for HQ), otherwise in App.tz().
  App.fmtDate = (d, opts) => {
    const date = typeof d === 'string' ? new Date(d + 'T12:00:00Z') : new Date(d);
    return new Intl.DateTimeFormat('en-US', Object.assign({ weekday: 'short', month: 'short', day: 'numeric', timeZone: App.tz() },
      opts || {}, typeof d === 'string' ? { timeZone: 'UTC' } : {})).format(date);
  };
  App.fmtDateTime = (ms, tz) => ms == null ? '—' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || App.tz() }).format(ms);
  App.fmtDuration = mins => mins == null ? '—' : (Math.floor(mins / 60) ? Math.floor(mins / 60) + 'h ' : '') + (Math.round(mins % 60)) + 'm';
  App.hhmm = s => { const [hh, mm] = String(s).split(':').map(Number); return ((hh + 11) % 12 + 1) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (hh < 12 ? 'am' : 'pm'); };
  App.WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // The server's instant while the dev clock is pinned; otherwise this device's clock,
  // so a page left open never works from a stale time.
  App.now = () => (App.me && App.me.clock_fixed ? App.me.now : Date.now());
  App.role = () => App.me && App.me.user.role;
  App.isOps = () => ['staff', 'director', 'hq'].includes(App.role());

  // ---------- views ----------
  // App.register({ id, title, icon, roles: ['parent', ...], order, nav: true, render(el, params) })
  // roles may include 'staff' meaning staff+director+hq, 'director' meaning director+hq.
  const RANK = { staff: 1, director: 2, hq: 3 };
  App.allowed = (roles, role = App.role()) => !roles || roles.some(r => r === role || (RANK[r] && (RANK[role] || 0) >= RANK[r]));
  App.register = v => { App.views.push(Object.assign({ order: 50, nav: true }, v)); App.views.sort((a, b) => a.order - b.order); if (App.me) render(); };
  App.go = (id, ...params) => { location.hash = '#/' + [id, ...params].map(encodeURIComponent).join('/'); };
  App.refresh = () => render();

  // ---------- home (foundation view, filled by module cards) ----------
  // App.card({ id, roles, order, render(el) }) adds a card to the Home screen.
  // Each module contributes its own (today's check-in status, latest note, ...).
  App.cards = [];
  App.card = c => { App.cards.push(Object.assign({ order: 50 }, c)); App.cards.sort((a, b) => a.order - b.order); };
  App.register({
    id: 'home', title: 'Home', icon: '🏠', order: 0,
    async render(el) {
      const u = App.me.user;
      const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: App.tz() }).format(App.now()));
      el.append(h('div', { class: 'page-head' }, h('div', null,
        h('h1', null, (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') + ', ' + u.name.split(' ')[0]),
        h('p', null, App.fmtDate(App.now(), { weekday: 'long', month: 'long', day: 'numeric' })))));
      const cards = App.cards.filter(c => App.allowed(c.roles));
      if (!cards.length) return el.append(h('div', { class: 'card empty' }, 'Nothing to show yet.'));
      // Cards render independently; one failing card must not blank the page.
      await Promise.all(cards.map(async c => {
        const box = h('section', { class: 'home-card', 'data-card': c.id });
        el.append(box);
        try { await c.render(box); } catch (e) { box.replaceChildren(h('div', { class: 'notice notice-danger' }, e.message)); }
      }));
    },
  });

  // ---------- inbox (foundation view) ----------
  // A module says where a notification about one of its records opens:
  // App.inboxLink('daily_note', n => 'notes'). The route's view must be open to
  // the signed-in role, or the item stays plain text.
  const inboxLinks = {};
  App.inboxLink = (refType, route) => { inboxLinks[refType] = route; };
  function inboxRoute(n) {
    const fn = inboxLinks[n.ref_type];
    const route = fn && (typeof fn === 'function' ? fn(n) : fn);
    const view = route && App.views.find(v => v.id === String(route).split('/')[0]);
    return view && App.allowed(view.roles) ? String(route) : null;
  }
  App.register({
    id: 'inbox', title: 'Inbox', icon: '🔔', order: 90, nav: false,
    async render(el) {
      const { notifications } = await App.api.get('/api/notifications');
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Inbox'), h('p', null, 'Everything ELITE Spaces has sent you.')),
        notifications.some(n => !n.read_at) && h('button', { class: 'btn', onclick: async e => { await App.run(e.target, () => App.api.post('/api/notifications/read-all')); updateBell(); App.refresh(); } }, 'Mark all read')));
      if (!notifications.length) return el.append(h('div', { class: 'card empty' }, 'Nothing yet. Check-ins, notes and announcements will show up here.'));
      const list = h('ul', { class: 'list card' });
      for (const n of notifications) {
        const route = inboxRoute(n);
        const wrap = kids => (route ? h('a', { class: 'inbox-link', href: '#/' + route }, kids) : kids);
        const item = n.priority === 'emergency'
          ? h('li', null, wrap(h('div', { class: 'emergency grow' }, h('div', { class: 'label' }, 'Emergency alert'), h('strong', null, n.title), n.body && h('p', { style: 'margin:.25rem 0 0' }, n.body))))
          : h('li', null, wrap([h('div', { class: 'grow' }, h('div', null, !n.read_at && h('span', { class: 'badge badge-accent', style: 'margin-right:.4rem' }, 'New'), h('strong', null, n.title)),
            n.body && h('div', { class: 'muted small' }, n.body)), h('time', { class: 'muted small' }, App.fmtDateTime(n.created_at))]));
        list.append(item);
        if (!n.read_at) App.api.post('/api/notifications/' + n.id + '/read').catch(() => {});
      }
      el.append(list);
      setTimeout(updateBell, 300);
    },
  });

  async function updateBell() {
    if (!App.me) return;
    try {
      const { unread } = await App.api.get('/api/notifications');
      App.unread = unread;
      const c = document.querySelector('#bell .bell-count');
      if (c) { c.textContent = unread; c.hidden = !unread; }
      const b = document.getElementById('bell');
      if (b) b.setAttribute('aria-label', 'Inbox, ' + unread + ' unread');
    } catch (_) { /* signed out */ }
  }

  let stream = null;
  function listen() {
    if (stream) stream.close();
    stream = new EventSource('/api/notifications/stream');
    stream.onmessage = ev => {
      const n = JSON.parse(ev.data);
      updateBell();
      if (n.priority === 'emergency') showEmergency(n);
      else App.toast(n.title);
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try { new Notification(n.title, { body: n.body || '', tag: 'n' + n.id }); } catch (_) {}
      }
      recheckMe();
    };
  }
  // Something just happened to this account (a promotion, a new location...):
  // re-read who we are, and redraw only if the role or location changed.
  async function recheckMe() {
    try {
      const me = await App.api.get('/api/auth/me');
      const was = App.me;
      App.me = me;
      if (!was || me.user.role !== was.user.role || me.user.location_id !== was.user.location_id) render();
    } catch (_) { /* signed out: api() already redrew the sign-in screen */ }
  }
  function showEmergency(n) {
    const box = h('div', { class: 'emergency', role: 'alertdialog', 'aria-labelledby': 'em-t', style: 'position:fixed;inset:auto 12px 90px 12px;z-index:60;max-width:560px;margin:auto' },
      h('div', { class: 'label' }, 'Emergency alert'), h('h3', { id: 'em-t' }, n.title), n.body && h('p', null, n.body),
      h('button', { class: 'btn', onclick: () => box.remove() }, 'I have read this'));
    document.body.append(box);
    box.querySelector('button').focus();
  }

  // ---------- chrome ----------
  function renderChrome() {
    const top = document.getElementById('topbar'), nav = document.getElementById('nav');
    const u = App.me.user;
    top.hidden = false; nav.hidden = false;
    top.replaceChildren(
      h('div', { class: 'brand' }, 'ELITE Spaces', h('small', null, App.me.location ? App.me.location.name : 'All locations')),
      h('div', { class: 'spacer' }),
      h('button', { id: 'bell', 'aria-label': 'Inbox', onclick: () => App.go('inbox') }, '🔔', h('span', { class: 'bell-count', hidden: true }, '0')),
      h('button', { 'aria-label': 'Sign out ' + u.name, title: 'Sign out', onclick: signOut }, u.name.split(' ')[0] + ' ⏻'),
    );
    renderNav(nav, currentRoute().id);
    renderDevbar();
  }
  const navViews = () => App.views.filter(v => v.nav && App.allowed(v.roles));

  // A phone's bottom bar fits five tabs. With more, the first four stay and the
  // rest move under More (a small menu above the bar). Desktop's left rail shows
  // every tab, so there the extra links show and More hides (app.css).
  const NAV_MAX = 5;
  function renderNav(nav, cur) {
    const views = navViews();
    const link = (v, cls) => h('a', { href: '#/' + v.id, class: cls || null, 'aria-current': v.id === cur ? 'page' : null },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, v.icon || '•'), h('span', null, v.title));
    if (views.length <= NAV_MAX) return nav.replaceChildren(...views.map(v => link(v)));
    const main = views.slice(0, NAV_MAX - 1), rest = views.slice(NAV_MAX - 1);
    const here = rest.find(v => v.id === cur);
    const sheet = h('div', { class: 'nav-sheet', id: 'nav-sheet', hidden: true, onkeydown: e => { if (e.key === 'Escape') { close(); more.focus(); } } },
      rest.map(v => link(v)));
    const more = h('button', { type: 'button', class: 'nav-more', 'aria-expanded': 'false', 'aria-controls': 'nav-sheet',
      'aria-current': here ? 'page' : null, onclick: () => (sheet.hidden ? open() : close()) },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, here ? here.icon || '•' : '☰'), h('span', null, here ? here.title : 'More'));
    function open() {
      sheet.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      const first = sheet.querySelector('a');
      if (first) first.focus();
    }
    function close() { sheet.hidden = true; more.setAttribute('aria-expanded', 'false'); }
    nav.replaceChildren(...main.map(v => link(v)), ...rest.map(v => link(v, 'nav-extra')), more, sheet);
  }
  // A tap anywhere outside the nav closes an open More menu.
  document.addEventListener('click', e => {
    const sheet = document.getElementById('nav-sheet');
    if (sheet && !sheet.hidden && !e.target.closest('#nav')) {
      sheet.hidden = true;
      const more = document.querySelector('#nav .nav-more');
      if (more) more.setAttribute('aria-expanded', 'false');
    }
  });

  async function renderDevbar() {
    const bar = document.getElementById('devbar');
    if (!App.me || !App.me.dev) { bar.hidden = true; return; }
    bar.hidden = false;
    const clock = await App.api.get('/api/dev/clock');
    const input = h('input', { type: 'datetime-local', 'aria-label': 'Set demo clock', value: toLocalInput(clock.now) });
    bar.replaceChildren(
      h('strong', null, 'DEV'),
      h('span', null, 'Clock: ' + App.fmtDateTime(clock.now) + (clock.fixed ? ' (fixed)' : ' (live)')),
      input,
      h('button', { onclick: async () => { await App.api.post('/api/dev/clock', { now: new Date(input.value).getTime() }); await refreshMe(); } }, 'Set'),
      h('button', { onclick: async () => { await App.api.post('/api/dev/clock', { now: null }); await refreshMe(); } }, 'Live'),
      h('button', { onclick: async () => { const r = await App.api.post('/api/dev/run-jobs'); App.toast('Ran ' + r.ran.length + ' scheduled jobs'); updateBell(); App.refresh(); } }, 'Run scheduled jobs'),
      h('button', { onclick: signOut }, 'Switch user'),
    );
  }
  const toLocalInput = ms => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

  async function refreshMe() { App.me = await App.api.get('/api/auth/me'); render(); }

  // ---------- routing ----------
  function currentRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    return { id: parts[0], params: parts.slice(1) };
  }

  let renderSeq = 0;
  async function render() {
    const main = document.getElementById('main');
    if (!App.me) return renderSignIn(main);
    renderChrome();
    let { id, params } = currentRoute();
    let view = App.views.find(v => v.id === id && App.allowed(v.roles));
    if (!view) { view = navViews()[0] || App.views.find(v => v.id === 'inbox'); if (id !== view.id) { history.replaceState(null, '', '#/' + view.id); } }
    const seq = ++renderSeq;
    const el = h('div', { class: 'view view-' + view.id });
    main.replaceChildren(h('div', { class: 'empty', 'aria-busy': 'true' }, 'Loading…'));
    document.title = view.title + ' · ELITE Spaces';
    try {
      await view.render(el, params);
      if (seq === renderSeq) main.replaceChildren(el);
    } catch (e) {
      if (seq === renderSeq) main.replaceChildren(h('div', { class: 'notice notice-danger', role: 'alert' }, e.message || 'Could not load this page.'));
    }
  }
  window.addEventListener('hashchange', () => { render(); document.getElementById('main').focus({ preventScroll: true }); });

  // ---------- sign-in ----------
  async function renderSignIn(main) {
    document.getElementById('topbar').hidden = true;
    document.getElementById('nav').hidden = true;
    document.getElementById('devbar').hidden = true;
    document.title = 'Sign in · ELITE Spaces';
    const email = h('input', { type: 'email', autocomplete: 'username', required: true, id: 'si-email' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'si-pw' });
    const err = h('div', { role: 'alert' });
    const form = h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault();
      err.replaceChildren();
      try { await App.api.post('/api/auth/login', { email: email.value, password: pw.value }); await boot(); }
      catch (x) { err.replaceChildren(h('div', { class: 'notice notice-danger' }, x.message)); }
    } },
      err,
      h('label', { class: 'field' }, h('span', null, 'Email'), email),
      h('label', { class: 'field' }, h('span', null, 'Password'), pw),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'));
    const wrap = h('div', { class: 'signin' },
      h('div', { class: 'logo' }, 'ELITE Spaces'),
      h('p', { class: 'muted' }, 'Study sessions, check-in and daily updates for ELITE Spaces families and staff.'),
      form);
    App.signInExtras.forEach(fn => { try { fn(wrap); } catch (_) {} });
    main.replaceChildren(wrap);
    try {
      const { accounts } = await App.api.get('/api/dev/accounts');
      const groups = {};
      accounts.forEach(a => (groups[a.role] = groups[a.role] || []).push(a));
      const box = h('div', { class: 'card demo-list' }, h('h2', null, 'Demo accounts'), h('p', { class: 'muted small' }, 'Dev mode: sign in as anyone with one tap.'));
      for (const [role, list] of Object.entries(groups)) {
        box.append(h('h3', { style: 'text-transform:capitalize;margin-top:.75rem' }, role === 'hq' ? 'HQ admin' : role));
        list.forEach(a => box.append(h('button', { class: 'btn', onclick: async () => { await App.api.post('/api/dev/login-as', { userId: a.id }); await boot(); } },
          a.name, h('span', { class: 'muted small' }, a.location ? ' · ' + a.location : ''))));
      }
      wrap.append(box);
    } catch (_) { /* not dev mode */ }
  }
  // Modules may add to the sign-in screen (e.g. "Create a family account").
  App.signInExtras = [];

  async function signOut() {
    await App.api.post('/api/auth/logout').catch(() => {});
    App.me = null;
    if (stream) stream.close();
    location.hash = '';
    render();
  }

  async function boot() {
    try { App.me = await App.api.get('/api/auth/me'); } catch (_) { App.me = null; }
    render();
    if (App.me) { updateBell(); listen(); }
  }
  // Re-read the signed-in user and draw the app again, e.g. right after a module
  // signs someone in (family sign-up, accepting an invite). App.start() runs once.
  App.boot = boot;

  App.start = () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    boot();
  };

  window.App = App;
})();
