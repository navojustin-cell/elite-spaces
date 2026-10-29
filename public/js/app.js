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
      if (res.status === 401 && App.me) boot({ me: null });
      // Refused: another tab may have signed in as someone else. Check once; if
      // so, the app is drawn again for that account and this error says nothing.
      if (res.status === 403 && App.me && await checkAccount()) e.accountChanged = true;
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
  // A disabled button loses focus to <body>; if the keyboard was on it and it is still on
  // the page, focus goes back to it, so a refused save keeps the user's place (NF-7).
  App.run = async (btn, fn) => {
    const had = !!btn && document.activeElement === btn;
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { if (!e.accountChanged) App.toast(e.message, 'error'); } finally {
      if (btn) {
        btn.disabled = false;
        if (had && btn.isConnected && (!document.activeElement || document.activeElement === document.body)) btn.focus();
      }
    }
  };

  // Ask before a consequential action, inline, never with window.confirm:
  //   if (!(await App.confirm({ anchor: row, title: 'Deactivate Sam?', body: 'Sam can no longer sign in.',
  //     confirmLabel: 'Deactivate Sam', cancelLabel: 'Keep active', danger: true }))) return;
  // anchor: the box opens right after this element. el: the box takes over this
  // element's content while open, and the content comes back after. With neither,
  // it opens right after the focused element (the button tapped). The safe button
  // comes first and gets focus, Escape picks it, and either answer returns focus
  // to the opener: `opener` if given, else whatever had focus, else the anchor
  // (Safari doesn't focus a tapped button). Resolves true or false.
  let confirmSeq = 0, closeConfirm = null;
  App.confirm = ({ anchor, el, opener, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) => new Promise(resolve => {
    const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    opener = opener || focused || anchor;
    if (closeConfirm) closeConfirm(false, false); // one confirm at a time
    const n = ++confirmSeq;
    const before = el ? [...el.childNodes] : null;
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, cancelLabel);
    const ok = h('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onclick: () => close(true) }, confirmLabel);
    const box = h('div', { class: 'confirm' + (danger ? ' confirm-danger' : ''), role: 'alertdialog',
      'aria-labelledby': 'confirm-t' + n, 'aria-describedby': body ? 'confirm-b' + n : null,
      onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } } },
      h('p', { class: 'confirm-title', id: 'confirm-t' + n }, title || confirmLabel),
      body && h('div', { class: 'confirm-body', id: 'confirm-b' + n }, body),
      h('div', { class: 'row' }, cancel, ok));
    function close(answer, refocus = true) {
      closeConfirm = null;
      if (before) el.replaceChildren(...before); else box.remove();
      if (refocus && opener && opener.isConnected && opener.focus) opener.focus();
      resolve(answer);
    }
    closeConfirm = close;
    const main = document.getElementById('main');
    const after = anchor || (focused && main.contains(focused) ? focused : null);
    if (el) el.replaceChildren(box); else if (after) after.after(box); else main.prepend(box);
    cancel.focus();
  });

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
      const banner = notifyBanner();
      if (banner) el.append(banner);
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
  // A module says where a notification about one of its records opens, by the
  // notification's ref_type: App.inboxLink('daily_note', 'notes'), or a function
  // of the notification, n => 'notes/' + n.ref_id. Several modules may register
  // the same ref type: the first route whose view the signed-in role can open
  // wins, and with none the item stays plain text.
  const inboxLinks = {};
  App.inboxLink = (refType, route) => { (inboxLinks[refType] = inboxLinks[refType] || []).push(route); };
  function inboxRoute(n) {
    for (const r of inboxLinks[n.ref_type] || []) {
      let route;
      try { route = typeof r === 'function' ? r(n) : r; } catch (_) { continue; }
      if (!route) continue;
      route = String(route).replace(/^#?\/?/, '');
      const view = App.views.find(v => v.id === route.split('/')[0]);
      if (view && App.allowed(view.roles)) return route;
    }
    return null;
  }
  // The bell always counts exactly the items this Inbox marks New. Opening the
  // Inbox tells the server those items are read, and they show as read (and the
  // bell drops) the next time the list is drawn: on leaving the Inbox, on Mark
  // all read, or when something new arrives while it's open.
  let inboxReads = null;
  App.register({
    id: 'inbox', title: 'Inbox', icon: '🔔', order: 90, nav: false,
    async render(el, params) {
      const { notifications } = await App.api.get('/api/notifications');
      // #/inbox/<id> (a tapped push notification): go on to that item's own screen.
      const target = params && params[0] && notifications.find(n => String(n.id) === params[0]);
      const targetRoute = target && inboxRoute(target);
      if (targetRoute) {
        if (!target.read_at) await App.api.post('/api/notifications/' + target.id + '/read').catch(() => {});
        history.replaceState(null, '', '#/' + targetRoute);
        App.refresh();
        return;
      }
      const fresh = notifications.filter(n => !n.read_at);
      setBell(fresh.length);
      if (fresh.length) inboxReads = Promise.allSettled(fresh.map(n => App.api.post('/api/notifications/' + n.id + '/read')));
      el.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Inbox'), h('p', null, 'Everything ELITE Spaces has sent you.')),
        fresh.length > 0 && h('button', { class: 'btn', type: 'button', onclick: e => App.run(e.currentTarget, async () => {
          await inboxReads;
          await App.api.post('/api/notifications/read-all');
          await App.refresh();
          focusHeading(); // the button is gone: focus goes to the Inbox heading, not the top of the page
        }) }, 'Mark all read')));
      if (!notifications.length) return el.append(h('div', { class: 'card empty' }, 'Nothing yet. Check-ins, notes and announcements will show up here.'));
      el.append(h('ul', { class: 'list card' }, notifications.map(inboxItem)));
    },
  });
  // Every item shows New (while unread), its title, body and when it came.
  // Emergency alerts look like one; items about a screen open it.
  function inboxItem(n) {
    const urgent = n.priority === 'emergency';
    const route = inboxRoute(n);
    const kids = [
      h('div', { class: 'grow' },
        urgent && h('div', { class: 'label' }, 'Emergency alert'),
        h('div', null, !n.read_at && h('span', { class: 'badge badge-new' }, 'New'), h('strong', null, n.title)),
        n.body && h('div', { class: urgent ? 'small' : 'muted small' }, n.body)),
      h('time', { class: urgent ? 'small' : 'muted small', datetime: new Date(n.created_at).toISOString() }, App.fmtDateTime(n.created_at)),
      route && h('span', { class: 'inbox-go', 'aria-hidden': 'true' }, '›'),
    ];
    const cls = (urgent ? 'emergency ' : '') + (route ? 'inbox-link' : 'inbox-row');
    return h('li', null, route ? h('a', { class: cls, href: '#/' + route }, kids) : h('div', { class: cls }, kids));
  }

  let bellBtn = null, bellCount = null;
  function setBell(n) {
    App.unread = n;
    if (bellCount) { bellCount.textContent = String(n); bellCount.hidden = !n; }
    if (bellBtn) bellBtn.setAttribute('aria-label', 'Inbox, ' + n + ' unread');
  }
  // Re-read the unread count, except on the Inbox, which sets the bell from what it shows.
  async function updateBell() {
    if (!App.me) return;
    try {
      const { unread } = await App.api.get('/api/notifications');
      if (shown !== 'inbox') setBell(unread);
    } catch (_) { /* signed out */ }
  }
  // For views: call after marking something read so the bell drops right away.
  App.refreshBell = updateBell;

  let stream = null;
  function listen() {
    if (stream) stream.close();
    stream = new EventSource('/api/notifications/stream');
    stream.onmessage = ev => {
      const n = JSON.parse(ev.data);
      if (shown === 'inbox') App.refresh(); else updateBell();
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
      if (meId(me) !== meId(was)) return accountChanged(me); // another tab signed in as someone else
      App.me = me;
      checkedAt = Date.now();
      if (!was || me.user.role !== was.user.role || me.user.location_id !== was.user.location_id) render();
    } catch (_) { /* signed out: api() already redrew the sign-in screen */ }
  }
  // The pop-up carries its notification id, so "I have read this" marks exactly
  // this alert read (the announcements view acknowledges it). Closing it puts focus
  // back where it was before it opened, or on the page heading if that is gone.
  function showEmergency(n) {
    const before = document.activeElement !== document.body ? document.activeElement : null;
    const close = () => {
      box.remove();
      if (before && before.isConnected) return before.focus();
      const head = document.querySelector('#main h1');
      if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
    };
    const box = h('div', { class: 'emergency', role: 'alertdialog', 'aria-labelledby': 'em-t', 'data-notification-id': n.id, style: 'position:fixed;inset:auto 12px 90px 12px;z-index:60;max-width:560px;margin:auto' },
      h('div', { class: 'label' }, 'Emergency alert'), h('h3', { id: 'em-t' }, n.title), n.body && h('p', null, n.body),
      h('button', { class: 'btn', onclick: close }, 'I have read this'));
    document.body.append(box);
    box.querySelector('button').focus();
  }

  // Moves focus to the page's heading (after the control that had it is gone).
  function focusHeading() {
    const head = document.getElementById('main').querySelector('h1');
    if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
  }

  // ---------- web push (src/push.js, public/sw.js) ----------
  // This browser's push subscription, saved on the server for whoever is signed
  // in. Permission is never asked here: only a tap on the Home banner asks.
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const keyBytes = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const swReady = () => Promise.race([navigator.serviceWorker.ready,
    new Promise((_, no) => setTimeout(() => no(new Error("This browser couldn't start notifications. Try again from the installed app.")), 10000))]);
  async function pushSubscribe() {
    const reg = await swReady();
    const key = keyBytes((await App.api.get('/api/push/key')).publicKey);
    let sub = await reg.pushManager.getSubscription();
    const old = sub && sub.options && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (old && (old.length !== key.length || old.some((b, i) => b !== key[i]))) { await sub.unsubscribe(); sub = null; } // the server's key changed
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await App.api.post('/api/push/subscribe', sub.toJSON());
  }
  // Signing out: this device stops getting that account's notifications.
  async function pushForget() {
    try {
      const reg = pushSupported() && await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await App.api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    } catch (_) { /* best effort */ }
  }

  // ---------- notification onboarding (Home, family roles) ----------
  // A banner that offers to turn on notifications. On an iPhone in Safari (not
  // the installed app) it shows how to add the app to the Home Screen instead,
  // because iPhone web push only works from the installed app. "No thanks"
  // hides it on this device for good. Otherwise it shows in one session at most:
  // once someone leaves Home it is gone until their next visit to the app.
  const NOTIFY_DISMISSED = 'elite.notify.dismissed', NOTIFY_SESSION = 'elite.notify.shown';
  const store = kind => ({
    get: k => { try { return window[kind].getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { window[kind].setItem(k, v); } catch (_) { /* storage blocked: this page load still remembers */ } },
  });
  const local = store('localStorage'), session = store('sessionStorage');
  let bannerState = null; // null: not shown yet this session; 'showing': on Home now; 'done'
  const isIPhone = () => { const ua = navigator.userAgent || ''; return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); };
  const installed = () => navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  function notifyBanner() {
    if (!['parent', 'student'].includes(App.role())) return null;
    if (bannerState === 'done' || local.get(NOTIFY_DISMISSED) || session.get(NOTIFY_SESSION)) return null;
    const walkthrough = isIPhone() && !installed();
    if (!walkthrough && !(pushSupported() && Notification.permission === 'default')) return null;
    bannerState = 'showing';
    const box = h('section', { class: 'card notify-banner', 'aria-labelledby': 'notify-t' });
    const finish = () => { local.set(NOTIFY_DISMISSED, '1'); bannerState = 'done'; };
    const dismiss = () => { finish(); box.remove(); focusHeading(); };
    if (walkthrough) {
      box.append(h('h2', { id: 'notify-t' }, 'Get alerts on your iPhone'),
        h('p', null, 'iPhone shows notifications only from the ELITE Spaces app on your Home Screen. To add it:'),
        h('ol', { class: 'notify-steps' },
          h('li', null, 'Tap the Share button (the square with an arrow) in Safari.'),
          h('li', null, 'Choose Add to Home Screen, then tap Add.'),
          h('li', null, 'Open ELITE Spaces from the new icon on your Home Screen and sign in.'),
          h('li', null, 'Tap Turn on notifications.')),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: dismiss }, 'Got it, hide this')));
      return box;
    }
    const on = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => App.run(on, async () => {
      const answer = await Notification.requestPermission();
      finish(); // asked once on this device: never again
      if (answer !== 'granted') {
        box.replaceChildren(h('p', { role: 'status' }, "Notifications stay off. You can turn them on later in this browser's settings."));
        return;
      }
      await pushSubscribe();
      box.remove();
      focusHeading();
      App.toast('Notifications are on for this device.');
    }) }, 'Turn on notifications');
    box.append(h('h2', { id: 'notify-t' }, 'Get alerts on this device'),
      h('p', null, 'Know right away about check-ins, daily notes and emergency alerts, even when the app is closed.'),
      h('div', { class: 'row' }, on, h('button', { type: 'button', class: 'btn', onclick: dismiss }, 'No thanks')));
    return box;
  }

  // ---------- chrome ----------
  function renderChrome(cur) {
    const top = document.getElementById('topbar'), nav = document.getElementById('nav');
    const u = App.me.user;
    top.hidden = false; nav.hidden = false;
    bellCount = h('span', { class: 'bell-count' });
    bellBtn = h('button', { id: 'bell', onclick: () => App.go('inbox') }, '🔔', bellCount);
    setBell(App.unread);
    top.replaceChildren(
      h('div', { class: 'brand' }, 'ELITE Spaces', h('small', null, App.me.location ? App.me.location.name : 'All locations')),
      h('div', { class: 'spacer' }),
      bellBtn,
      // The name starts with the visible first name (WCAG 2.5.3 Label in Name).
      h('button', { 'aria-label': u.name + ', sign out', title: 'Sign out', onclick: signOut }, u.name.split(' ')[0] + ' ⏻'),
    );
    renderNav(nav, cur);
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
    // Relabeled to the page it holds, the button still says it opens the menu. Its
    // name starts with the words it shows (WCAG 2.5.3 Label in Name).
    const more = h('button', { type: 'button', class: 'nav-more', 'aria-expanded': 'false', 'aria-controls': 'nav-sheet',
      'aria-label': here ? here.title + ', more pages' : 'More pages',
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

  let renderSeq = 0, shown = null, shownHash = ''; // shown: the id of the view on screen; shownHash: its address
  async function render() {
    const main = document.getElementById('main');
    if (!App.me) { shown = null; shownHash = location.hash; return renderSignIn(main); }
    let { id, params } = currentRoute();
    let view = App.views.find(v => v.id === id && App.allowed(v.roles));
    if (!view) { view = navViews()[0] || App.views.find(v => v.id === 'inbox'); if (id !== view.id) { history.replaceState(null, '', '#/' + view.id); } }
    shown = view.id;
    shownHash = location.hash;
    if (view.id !== 'home' && bannerState === 'showing') { bannerState = 'done'; session.set(NOTIFY_SESSION, '1'); }
    // Leaving the Inbox: once its items are read on the server, the bell drops to match.
    if (view.id !== 'inbox' && inboxReads) { const reads = inboxReads; inboxReads = null; reads.then(updateBell); }
    renderChrome(view.id);
    const seq = ++renderSeq;
    const el = h('div', { class: 'view view-' + view.id });
    main.replaceChildren(h('div', { class: 'empty', 'aria-busy': 'true' }, 'Loading…'));
    document.title = view.title + ' · ELITE Spaces';
    try {
      await view.render(el, params);
      if (seq === renderSeq) {
        main.replaceChildren(el);
        // A view may move to another route as it draws (a scan link lands on Check in).
        const now = currentRoute().id;
        if (now !== view.id) renderNav(document.getElementById('nav'), now);
      }
    } catch (e) {
      if (seq === renderSeq) main.replaceChildren(h('div', { class: 'notice notice-danger', role: 'alert' }, e.message || 'Could not load this page.'));
    }
  }
  window.addEventListener('hashchange', async () => {
    // "Skip to content" (index.html, href="#main") only moves focus: the address goes back to
    // the page on screen, which stays as it is (a half-done form isn't lost).
    if (location.hash === '#main') {
      history.replaceState(null, '', shownHash || '#/');
      document.getElementById('main').focus();
      return;
    }
    // After a pause, make sure this tab still acts as the account it shows before drawing the next page.
    if (App.me && Date.now() - checkedAt > RECHECK_MS && await checkAccount()) return;
    render(); document.getElementById('main').focus({ preventScroll: true });
    // A new page starts at its top, not where the last one was scrolled to.
    if (window.scrollTo) window.scrollTo(0, 0);
  });

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
      try { await App.api.post('/api/auth/login', { email: email.value, password: pw.value }); await boot({ announce: true }); }
      catch (x) { err.replaceChildren(h('div', { class: 'notice notice-danger' }, x.message)); }
    } },
      err,
      h('label', { class: 'field' }, h('span', null, 'Email'), email),
      h('label', { class: 'field' }, h('span', null, 'Password'), pw),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'));
    // A phone camera opened a check-in link (#/scan/...): after sign-in the same route finishes the scan.
    const scanning = /^#\/scan\//.test(location.hash);
    const wrap = h('div', { class: 'signin' },
      h('h1', { class: 'logo' }, 'ELITE Spaces'),
      scanning
        ? h('div', { class: 'notice' }, h('strong', null, 'Sign in to finish checking in'), h('div', { class: 'small' }, 'Your scan goes through as soon as you sign in.'))
        : h('p', { class: 'muted' }, 'Study sessions, check-in and daily updates for ELITE Spaces families and staff.'),
      form);
    App.signInExtras.forEach(fn => { try { fn(wrap); } catch (_) {} });
    main.replaceChildren(wrap);
    // The tab title names the screen: "Sign in", or the heading of the panel a
    // module opened in its place (Create your family account, Open your invite...).
    let demo = null;
    const retitle = () => {
      if (!wrap.isConnected) return false;
      const head = form.style && form.style.display === 'none'
        ? [...wrap.querySelectorAll('h2')].find(x => !form.contains(x) && !(demo && demo.contains(x))) : null;
      const text = head ? head.textContent.trim() : '';
      document.title = (text || 'Sign in') + ' · ELITE Spaces';
      return true;
    };
    retitle();
    if (window.MutationObserver) {
      const watch = new MutationObserver(() => { if (!retitle()) watch.disconnect(); });
      watch.observe(wrap, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    try {
      const { accounts } = await App.api.get('/api/dev/accounts');
      const groups = {};
      accounts.forEach(a => (groups[a.role] = groups[a.role] || []).push(a));
      const box = demo = h('div', { class: 'card demo-list' }, h('h2', null, 'Demo accounts'), h('p', { class: 'muted small' }, 'Dev mode: sign in as anyone with one tap.'));
      for (const [role, list] of Object.entries(groups)) {
        box.append(h('h3', { style: 'text-transform:capitalize;margin-top:.75rem' }, role === 'hq' ? 'HQ admin' : role));
        list.forEach(a => box.append(h('button', { class: 'btn', onclick: async () => { await App.api.post('/api/dev/login-as', { userId: a.id }); await boot({ announce: true }); } },
          a.name, h('span', { class: 'muted small' }, a.location ? ' · ' + a.location : ''))));
      }
      wrap.append(box);
    } catch (_) { /* not dev mode */ }
  }
  // Modules may add to the sign-in screen (e.g. "Create a family account").
  App.signInExtras = [];

  async function signOut() {
    await pushForget();
    await App.api.post('/api/auth/logout').catch(() => {});
    App.me = null;
    if (stream) stream.close();
    location.hash = '';
    render();
    tellOtherTabs();
  }

  // me: who is signed in, when the caller already knows; otherwise it is read.
  // announce: this tab just signed someone in, so other open tabs are told.
  let booting = 0;
  async function boot({ me, announce = false } = {}) {
    const before = meId(App.me);
    if (me === undefined) {
      booting++;
      try { me = await App.api.get('/api/auth/me'); } catch (_) { me = null; } finally { booting--; }
    }
    App.me = me;
    checkedAt = Date.now();
    App.unread = 0; // a new sign-in never shows the last person's count
    render();
    if (App.me) {
      updateBell(); listen();
      // Notifications already allowed here: make sure this account gets them on this device.
      if (pushSupported() && Notification.permission === 'granted') pushSubscribe().catch(() => {});
    } else if (stream) { stream.close(); stream = null; } // no more of the old account's notifications here
    if (announce && meId(App.me) !== before) tellOtherTabs();
  }
  // Re-read the signed-in user and draw the app again, e.g. right after a module
  // signs someone in (family sign-up, accepting an invite). App.start() runs once.
  App.boot = () => boot({ announce: true });

  // ---------- one account per browser ----------
  // Every tab shares the sign-in cookie, so a sign-in, sign-out or switch in
  // another tab changes who this tab's requests act as. This tab checks who is
  // signed in when it comes back into view, before drawing a page after a pause,
  // and after a refusal (403), and other tabs tell it at once when they sign in
  // or out. When the account changed, the whole app is drawn again for the one
  // signed in now: anything typed for the old account is dropped, never sent.
  const RECHECK_MS = 5000;
  let checkedAt = 0, checking = null;
  const meId = me => (me ? me.user.id : null);
  // Resolves true when the account changed (and the app was drawn again).
  function checkAccount() {
    if (!checking) checking = (async () => {
      let me;
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (res.status === 401) me = null; else if (res.ok) me = await res.json(); else return false;
      } catch (_) { return false; }
      checkedAt = Date.now();
      // While this tab is itself reading who is signed in (starting up, signing in), that read has the final word.
      if (booting || meId(me) === meId(App.me)) return false;
      await accountChanged(me);
      return true;
    })().finally(() => { checking = null; });
    return checking;
  }
  async function accountChanged(me) {
    if (closeConfirm) closeConfirm(false, false); // a question asked for the old account is answered No
    await boot({ me });
    App.toast(me ? "You're now signed in as " + me.user.name + '.' : "You're signed out.");
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAccount(); });
  window.addEventListener('focus', () => checkAccount());
  // Telling the other tabs: BroadcastChannel, or a storage event where there is none.
  const ACCOUNT_KEY = 'elite.account';
  let channel = null;
  try {
    if (typeof BroadcastChannel === 'function') { channel = new BroadcastChannel(ACCOUNT_KEY); channel.onmessage = () => checkAccount(); }
  } catch (_) { channel = null; }
  window.addEventListener('storage', e => { if (e.key === ACCOUNT_KEY) checkAccount(); });
  function tellOtherTabs() {
    if (channel) { try { channel.postMessage('changed'); return; } catch (_) { /* fall back to storage */ } }
    local.set(ACCOUNT_KEY, Date.now() + ':' + Math.random());
  }

  App.start = () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    boot();
  };

  window.App = App;
})();
