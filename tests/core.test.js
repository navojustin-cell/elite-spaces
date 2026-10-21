'use strict';
// Foundation: sign-in, scope rules, notifications inbox, location time helpers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { test, makeApp, assert, load, at, ROOT } = require('./lib');

test('CORE', 'login works with the right password and returns the user', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const p = t.fx.family(loc).parent;
  const ok = await t.anon.post('/api/auth/login', { email: p.email, password: 'demo1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.id, p.id);
  const bad = await t.anon.post('/api/auth/login', { email: p.email, password: 'nope' });
  assert.equal(bad.status, 401);
});

test('CORE', 'a student whose parent link is still pending cannot sign in or use a session', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const { student } = t.fx.family(loc, { linked: false });
  const r = await t.anon.post('/api/auth/login', { email: student.email, password: 'demo1234' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'link_pending');
  const me = await t.as(student).get('/api/auth/me');
  assert.equal(me.status, 401);
});

test('CORE', 'inactive accounts cannot sign in', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const s = t.fx.staff(loc, { active: 0 });
  const r = await t.anon.post('/api/auth/login', { email: s.email, password: 'demo1234' });
  assert.equal(r.status, 403);
});

test('CORE', 'scope: staff see only their own location\'s students; parents only their own; hq everyone', async () => {
  const t = await makeApp();
  const auth = load('src/auth.js');
  const a = t.fx.location(), b = t.fx.location();
  const fa = t.fx.family(a), fb = t.fx.family(b);
  const staffA = t.fx.staff(a), dirA = t.fx.director(a), hq = t.fx.hq();
  assert.equal(auth.canSeeStudent(t.ctx, staffA, fa.student.id), true);
  assert.equal(auth.canSeeStudent(t.ctx, staffA, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, dirA, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, fa.parent, fa.student.id), true);
  assert.equal(auth.canSeeStudent(t.ctx, fa.parent, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, fa.student, fa.student.id), true);
  assert.equal(auth.canSeeStudent(t.ctx, fa.student, fb.student.id), false);
  assert.equal(auth.canSeeStudent(t.ctx, hq, fb.student.id), true);
});

test('CORE', 'role ladder: director passes a staff gate, staff fails a director gate, families fail both', async () => {
  const auth = load('src/auth.js');
  assert.equal(auth.atLeast({ role: 'director' }, 'staff'), true);
  assert.equal(auth.atLeast({ role: 'hq' }, 'director'), true);
  assert.equal(auth.atLeast({ role: 'staff' }, 'director'), false);
  assert.equal(auth.atLeast({ role: 'parent' }, 'staff'), false);
  assert.equal(auth.atLeast({ role: 'student' }, 'staff'), false);
  assert.equal(auth.canManageLocation({ role: 'director', location_id: 1 }, 2), false);
  assert.equal(auth.canManageLocation({ role: 'hq', location_id: null }, 2), true);
});

test('CORE', 'notifications inbox: each user sees only their own, and can mark them read', async () => {
  const t = await makeApp();
  const notify = load('src/notify.js');
  const loc = t.fx.location();
  const f1 = t.fx.family(loc), f2 = t.fx.family(loc);
  notify.send(t.ctx, notify.parentsOf(t.ctx, f1.student.id), { kind: 'test', title: 'Hello' });
  const mine = await t.as(f1.parent).get('/api/notifications');
  assert.equal(mine.body.notifications.length, 1);
  assert.equal(mine.body.unread, 1);
  const theirs = await t.as(f2.parent).get('/api/notifications');
  assert.equal(theirs.body.notifications.length, 0);
  await t.as(f1.parent).post('/api/notifications/' + mine.body.notifications[0].id + '/read');
  assert.equal((await t.as(f1.parent).get('/api/notifications')).body.unread, 0);
});

test('CORE', 'time helpers use the location\'s zone, not the server\'s', async () => {
  const time = load('src/time.js');
  const la = { timezone: 'America/Los_Angeles' }, to = { timezone: 'America/Toronto' };
  const ms = at('America/Los_Angeles', '2026-10-14', '22:30'); // 01:30 next day in Toronto
  assert.equal(time.localDate(la, ms), '2026-10-14');
  assert.equal(time.localDate(to, ms), '2026-10-15');
  assert.equal(time.weekday(la, ms), 3);
  assert.equal(time.weekday(to, ms), 4);
  assert.equal(time.localTime(to, ms), '01:30');
});

test('CORE', 'unknown API paths return JSON 404 and errors never leak a stack', async () => {
  const t = await makeApp();
  const r = await t.anon.get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
});

test('CORE', "the sign-in cookie carries the app's own name, so local servers on other ports never share or end each other's sessions", async () => {
  const t = await makeApp({ cookieName: 'sid_4199' });
  const loc = t.fx.location();
  const p = t.fx.family(loc).parent;
  const r = await t.anon.post('/api/auth/login', { email: p.email, password: 'demo1234' });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie') || '';
  assert.match(set, /^sid_4199=[0-9a-f]{48};/);
  const token = set.match(/^sid_4199=([^;]+)/)[1];
  assert.equal(r.body.token, undefined, 'the session lives only in the httpOnly cookie, never in the body (L64)');
  const me = cookie => fetch(t.base + '/api/auth/me', { headers: { cookie } });
  assert.equal((await me('sid_4199=' + token)).status, 200);
  assert.equal((await me('sid=' + token)).status, 401, 'a cookie under another server\'s name is ignored');
  const out = await fetch(t.base + '/api/auth/logout', { method: 'POST', headers: { cookie: 'sid_4199=' + token } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /^sid_4199=;/);
  assert.equal((await me('sid_4199=' + token)).status, 401, 'signing out ends the session');
});

test('CORE', '/api/auth/me says whether the clock is pinned, so the app knows whether to trust its own clock', async () => {
  const t = await makeApp();
  const p = t.fx.family(t.fx.location()).parent;
  const pinned = await t.as(p).get('/api/auth/me');
  assert.deepEqual([pinned.body.now, pinned.body.clock_fixed], [t.clock.now(), true]);
  t.clock.set(null);
  const live = await t.as(p).get('/api/auth/me');
  assert.equal(live.body.clock_fixed, false);
  assert.ok(Math.abs(live.body.now - Date.now()) < 5000);
});

// ---------------------------------------------------------------- the shell (public/js/app.js) in a browser tab

// Just enough DOM for the shell. Elements live in one tree under <html>; focus,
// events (which bubble) and isConnected work as in a browser, and a removed
// element loses focus to <body>.
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null, style: {} }); }
  querySelectorAll(tag) { return this.findAll(n => n.tag === tag); }
  querySelector(tag) { return this.find(n => n.tag === tag) || null; }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  get id() { return this.getAttribute('id') || ''; }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get cls() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.doc.documentElement; }
  addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
  dispatch(type, props) {
    const ev = Object.assign({ type, target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } }, props);
    for (let n = this; n && !ev.stopped; n = n.parentNode) { ev.currentTarget = n; for (const fn of n.on[type] || []) fn(ev); }
  }
  click() { this.dispatch('click'); }
  focus() { this.doc.focused = this; }
  adopt(kids) { return kids.map(k => { const n = k instanceof El ? k : new El(this.doc, null, String(k)); n.remove(); n.parentNode = this; return n; }); }
  append(...kids) { this.childNodes.push(...this.adopt(kids)); }
  appendChild(k) { this.append(k); return k; }
  prepend(...kids) { this.childNodes.unshift(...this.adopt(kids)); }
  after(...kids) { const p = this.parentNode, ns = p.adopt(kids); p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, ...ns); }
  replaceChildren(...kids) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  all() { return this.childNodes.flatMap(c => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
}

// One browser tab running the real shell (read from ROOT, so the mutation runner's
// copy is the one exercised) against the test server, opened at address `hash`.
// Tabs given the same `jar` share the sign-in cookie, as tabs in one browser do.
function shellTab(t, hash = '', extras = {}, jar = { cookie: '' }) {
  const pending = new Set(), streams = [];
  const track = p => { pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };
  const doc = { title: '', hidden: false, on: {}, addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); } };
  const el = (tag, attrs = {}) => { const n = new El(doc, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  doc.documentElement = el('html');
  doc.head = el('head');
  doc.body = el('body');
  doc.documentElement.append(doc.head, doc.body);
  const shell = el('div', { id: 'shell' });
  shell.append(el('nav', { id: 'nav', 'aria-label': 'Main', hidden: '' }), el('main', { id: 'main', tabindex: '-1' }));
  doc.body.append(el('div', { id: 'devbar', hidden: '' }), el('header', { id: 'topbar', hidden: '' }),
    el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }), shell);
  Object.assign(doc, {
    createElement: tag => new El(doc, tag), createTextNode: s => new El(doc, null, String(s)),
    getElementById: id => doc.documentElement.find(n => n.id === id) || null,
  });
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused && doc.focused.isConnected ? doc.focused : doc.body) });
  const winOn = {};
  const fire = (type, props) => (winOn[type] || []).forEach(fn => fn(Object.assign({ type }, props)));
  const location = {
    _hash: hash,
    get hash() { return this._hash; },
    // Like a browser, setting the hash fires hashchange a moment later.
    set hash(v) { this._hash = v ? (String(v).startsWith('#') ? String(v) : '#' + v) : ''; track(new Promise(r => setImmediate(() => { fire('hashchange'); r(); }))); },
  };
  class EventSource { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } }
  // hold(match): the next matching request waits to be sent until release() (a slow network).
  let held = null;
  // Like a browser, a Set-Cookie answer (sign-in, sign-out) changes the cookie every tab sends.
  const send = (url, opts) => track(fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie: jar.cookie }) }))
    .then(async r => {
      const set = r.headers.get('set-cookie');
      if (set) jar.cookie = set.split(';')[0];
      return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
    }));
  const fetchAs = (url, opts = {}) => {
    if (!held || !held.match(url, opts)) return send(url, opts);
    const wait = held.wait;
    held = null;
    return wait.then(() => send(url, opts));
  };
  const hold = match => { let release; held = { match, wait: new Promise(r => { release = r; }) }; return release; };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator: {}, location, EventSource, atob,
    history: { replaceState(_s, _t, url) { location._hash = String(url).replace(/^[^#]*/, ''); } },
    addEventListener(type, fn) { (winOn[type] = winOn[type] || []).push(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  Object.assign(win, extras);
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8'), win, { filename: 'public/js/app.js' });
  // Waits until every request has answered and the shell has drawn what came back.
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    App: win.App, win, doc, location, streams, settle, el, hold, track, fire,
    main: () => doc.getElementById('main'),
    signIn(user) { const token = crypto.randomBytes(16).toString('hex'); t.ctx.sessions.set(token, user.id); jar.cookie = 'sid=' + token; },
    async start() { win.App.start(); await settle(); },
    async go(to) { location.hash = to; await settle(); },
  };
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const byTag = (root, tag) => root.findAll(n => n.tag === tag);

test(['CORE', 'NF-7'], 'App.confirm asks inline: a labelled alertdialog with the safe button first and focused; Escape cancels, and focus goes back to the opener', async () => {
  const t = await makeApp();
  const tab = shellTab(t);
  const main = tab.main();
  const row = tab.el('div'), opener = tab.el('button');
  row.append(opener, 'Sam Lee');
  main.append(row);
  opener.focus();
  const ask = () => tab.App.confirm({ anchor: row, title: 'Deactivate Sam?', body: 'Sam can no longer sign in. You can reactivate them later.',
    confirmLabel: 'Deactivate Sam', cancelLabel: 'Keep active', danger: true });

  let answer = ask();
  const box = main.childNodes[1];
  assert.equal(box && box.getAttribute('role'), 'alertdialog', 'the box opens right after the anchor');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Deactivate Sam?');
  assert.equal(tab.doc.getElementById(box.getAttribute('aria-describedby')).textContent, 'Sam can no longer sign in. You can reactivate them later.');
  const buttons = byTag(box, 'button');
  assert.deepEqual(buttons.map(b => b.textContent), ['Keep active', 'Deactivate Sam'], 'the safe button comes first');
  assert.ok(buttons[1].cls.includes('btn-danger'));
  assert.equal(tab.doc.activeElement, buttons[0], 'focus starts on the safe button');
  tab.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(await answer, false, 'Escape cancels');
  assert.equal(box.isConnected, false);
  assert.equal(tab.doc.activeElement, opener, 'focus returns to the opener after cancel');

  answer = ask();
  byTag(main.childNodes[1], 'button')[1].click();
  assert.equal(await answer, true);
  assert.equal(main.childNodes.length, 1);
  assert.equal(tab.doc.activeElement, opener, 'focus returns to the opener after confirm');

  // el: the box takes over a slot and gives its content back. Safari never focused
  // the tapped button, so the caller names the opener.
  const slot = tab.el('div'), a = tab.el('button'), b = tab.el('button');
  slot.append(a, b);
  main.append(slot);
  tab.doc.body.focus();
  answer = tab.App.confirm({ el: slot, opener: b, title: 'Reset the password?', confirmLabel: 'Reset password', cancelLabel: 'Keep password' });
  assert.equal(slot.childNodes.length, 1);
  assert.equal(slot.childNodes[0].getAttribute('role'), 'alertdialog');
  assert.equal(slot.childNodes[0].getAttribute('aria-describedby'), null, 'no body, nothing to describe it');
  assert.ok(byTag(slot, 'button')[1].cls.includes('btn-primary'));
  assert.equal(tab.doc.activeElement, byTag(slot, 'button')[0]);
  byTag(slot, 'button')[0].click();
  assert.equal(await answer, false);
  assert.equal(slot.childNodes.length, 2);
  assert.ok(slot.childNodes[0] === a && slot.childNodes[1] === b, 'the slot gets its own content back');
  assert.equal(tab.doc.activeElement, b);
});

// A parent with three unread items (one an emergency), one read item, and Inbox
// links registered the way modules register them.
async function inboxWorld() {
  const t = await makeApp();
  const notify = load('src/notify.js');
  const fam = t.fx.family(t.fx.location());
  const send = (o, at) => { t.clock.set(at); return notify.send(t.ctx, [fam.parent.id], o)[0]; };
  const day = Date.UTC(2026, 9, 13, 17, 0);
  const old = send({ kind: 'note', title: 'Old note', refType: 'daily_note', refId: 1 }, day);
  t.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(day, old.id);
  const closure = send({ kind: 'closure', title: 'Closed Monday', refType: 'closure', refId: 3 }, day + 1800e3);
  const visit = send({ kind: 'checkin', title: 'Maya checked in', body: 'Irvine, 1:02 PM', refType: 'visit', refId: 42 }, day + 3600e3);
  const alarm = send({ kind: 'emergency', title: 'Building closed', body: 'Pick up by 3 PM.', refType: 'announcement', refId: 7, priority: 'emergency' }, day + 7200e3);
  const tab = shellTab(t);
  const App = tab.App;
  App.register({ id: 'news', title: 'News', roles: ['parent'], render(el) { el.append('news'); } });
  App.register({ id: 'ops', title: 'Ops', roles: ['staff'], render(el) { el.append('ops'); } });
  App.inboxLink('visit', n => 'news/' + n.ref_id);
  App.inboxLink('announcement', '#/news'); // two modules, one ref type: the first the role can open wins
  App.inboxLink('announcement', 'ops');
  App.inboxLink('closure', 'ops'); // a staff-only screen: a parent's item stays plain
  App.inboxLink('daily_note', () => { throw new Error('a broken route'); });
  tab.signIn(fam.parent);
  return { t, fam, tab, App, send, old, closure, visit, alarm };
}
const bellOf = tab => {
  const b = tab.doc.getElementById('bell'), c = b.find(n => n.cls.includes('bell-count'));
  return { label: b.getAttribute('aria-label'), count: c.hidden ? 0 : Number(c.textContent) };
};
const inboxItems = tab => byTag(tab.main(), 'li').map(li => {
  const box = li.childNodes[0], time = box.find(n => n.tag === 'time');
  return { text: words(box.childNodes[0]), when: time ? words(time) : null, href: box.tag === 'a' ? box.getAttribute('href') : null,
    urgent: box.cls.includes('emergency'), isNew: !!box.find(n => n.cls.includes('badge-new')) };
});

test(['CORE'], 'Inbox: the bell always counts the items shown New, emergencies show New and their time, and items about a screen link to it', async () => {
  const w = await inboxWorld();
  const { tab, t } = w;
  await tab.start();
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 3 unread', count: 3 });
  await tab.go('#/news');
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 3 unread', count: 3 }, 'moving between pages keeps the count');

  await tab.go('#/inbox');
  const when = ms => w.App.fmtDateTime(ms);
  assert.deepEqual(inboxItems(tab), [
    { text: 'Emergency alert New Building closed Pick up by 3 PM.', when: when(w.alarm.created_at), href: '#/news', urgent: true, isNew: true },
    { text: 'New Maya checked in Irvine, 1:02 PM', when: when(w.visit.created_at), href: '#/news/42', urgent: false, isNew: true },
    { text: 'New Closed Monday', when: when(w.closure.created_at), href: null, urgent: false, isNew: true },
    { text: 'Old note', when: when(w.old.created_at), href: null, urgent: false, isNew: false },
  ]);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 3 unread', count: 3 }, 'opening the Inbox does not drop the bell below what it shows as New');
  assert.equal(t.fx.notifications(w.fam.parent).filter(n => !n.read_at).length, 0, 'what the Inbox showed is read on the server');

  // Something new arrives while the Inbox is open: the list is drawn again.
  const late = w.send({ kind: 'checkout', title: 'Maya checked out', refType: 'visit', refId: 43 }, Date.UTC(2026, 9, 13, 21, 0));
  tab.streams.at(-1).onmessage({ data: JSON.stringify(late) });
  await tab.settle();
  assert.deepEqual(inboxItems(tab).filter(i => i.isNew).map(i => i.text), ['New Maya checked out']);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 1 unread', count: 1 });
  assert.deepEqual(tab.doc.getElementById('toasts').childNodes.map(n => n.textContent), ['Maya checked out']);

  // Leaving shows them read: the bell drops, and the Inbox has nothing New.
  await tab.go('#/home');
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 0 unread', count: 0 });
  await tab.go('#/inbox');
  assert.deepEqual(inboxItems(tab).filter(i => i.isNew), []);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 0 unread', count: 0 });
});

test(['CORE'], 'Inbox: a bell refresh that lands after the Inbox drew leaves the bell matching the New tags', async () => {
  const w = await inboxWorld();
  const { tab } = w;
  await tab.start();
  // Something arrives on Home; the bell's request for the new count is slow to go out.
  const release = tab.hold((url, opts) => url === '/api/notifications' && (opts.method || 'GET') === 'GET');
  const late = w.send({ kind: 'checkout', title: 'Maya checked out', refType: 'visit', refId: 43 }, Date.UTC(2026, 9, 13, 21, 0));
  tab.streams.at(-1).onmessage({ data: JSON.stringify(late) });
  await tab.go('#/inbox');
  assert.equal(inboxItems(tab).filter(i => i.isNew).length, 4);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 4 unread', count: 4 });
  release(); // the server now says 0 unread: the Inbox marked them read
  await tab.settle();
  assert.equal(inboxItems(tab).filter(i => i.isNew).length, 4);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 4 unread', count: 4 });
});

test(['CORE'], 'Inbox: Mark all read clears every New tag and the bell together', async () => {
  const w = await inboxWorld();
  const { tab } = w;
  await tab.start();
  await tab.go('#/inbox');
  assert.equal(inboxItems(tab).filter(i => i.isNew).length, 3);
  byTag(tab.main(), 'button').find(b => b.textContent === 'Mark all read').click();
  await tab.settle();
  assert.deepEqual(inboxItems(tab).filter(i => i.isNew), []);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 0 unread', count: 0 });
  assert.ok(!byTag(tab.main(), 'button').some(b => b.textContent === 'Mark all read'));
});

test(['CORE', 'NF-7'], 'navigation: Home is the current page right after sign-in, and More keeps saying it opens the menu when it shows the current page', async () => {
  const t = await makeApp();
  const p = t.fx.family(t.fx.location()).parent;
  const tab = shellTab(t);
  for (const [i, title] of ['Schedule', 'Hours', 'Notes', 'Family', 'News'].entries()) {
    tab.App.register({ id: title.toLowerCase(), title, roles: ['parent'], order: 10 + i, render(el) { el.append(title); } });
  }
  // A screen that moves to another route as it draws, as the scan link lands on Check in.
  tab.App.register({ id: 'scan', title: 'Check in', nav: false, render(el) { tab.win.history.replaceState(null, '', '#/notes'); el.append('scanned'); } });
  tab.signIn(p);
  await tab.start();
  const nav = tab.doc.getElementById('nav');
  const current = () => [...new Set(nav.findAll(n => n.tag === 'a' && n.getAttribute('aria-current') === 'page').map(a => a.getAttribute('href')))];
  const more = () => nav.find(n => n.cls.includes('nav-more'));
  assert.equal(tab.location.hash, '#/home');
  assert.deepEqual(current(), ['#/home'], 'Home is marked current on the first draw after sign-in');
  assert.equal(more().getAttribute('aria-label'), 'More pages');

  await tab.go('#/news');
  assert.deepEqual(current(), ['#/news']);
  assert.equal(words(more()), '• News', 'More shows the page it holds');
  assert.equal(more().getAttribute('aria-label'), 'More pages, current: News');
  assert.equal(more().getAttribute('aria-current'), 'page');

  await tab.go('#/scan/1/abc');
  assert.equal(tab.location.hash, '#/notes');
  assert.deepEqual(current(), ['#/notes'], 'the page it moved to is marked current');
});

test(['CORE', 'NF-7'], 'sign-in: the logo is the page heading, and a scan link says signing in finishes the check-in', async () => {
  const t = await makeApp();
  const plain = shellTab(t);
  await plain.start();
  assert.deepEqual(byTag(plain.main(), 'h1').map(words), ['ELITE Spaces']);
  assert.ok(!words(plain.main()).includes('finish checking in'));

  const scan = shellTab(t, '#/scan/1/abc123');
  await scan.start();
  assert.deepEqual(byTag(scan.main(), 'h1').map(words), ['ELITE Spaces']);
  assert.match(words(scan.main()), /^ELITE Spaces Sign in to finish checking in Your scan goes through as soon as you sign in\. /);
  assert.equal(scan.location.hash, '#/scan/1/abc123', 'the scan link is kept for after sign-in');
});

test('CORE', 'dev mode is off unless ELITE_DEV=1 is set explicitly (R9), and off means no dev endpoints', async () => {
  const { devFromEnv } = load('src/app.js');
  assert.equal(devFromEnv({}), false, 'no ELITE_DEV: dev mode off');
  assert.equal(devFromEnv({ ELITE_DEV: '' }), false);
  assert.equal(devFromEnv({ ELITE_DEV: '0' }), false);
  assert.equal(devFromEnv({ ELITE_DEV: 'true' }), false, 'only ELITE_DEV=1 turns it on');
  assert.equal(devFromEnv({ ELITE_DEV: '1' }), true);
  // server.js decides dev mode through devFromEnv(process.env), not its own fail-open check.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /const DEV = devFromEnv\(process\.env\);/);
  assert.doesNotMatch(server, /ELITE_DEV\s*!==/);

  const t = await makeApp();
  const hq = t.fx.hq();
  assert.equal((await t.anon.get('/api/dev/accounts')).status, 404, 'signed out, no account list');
  assert.equal((await t.anon.post('/api/dev/login-as', { userId: hq.id })).status, 404, 'signed out, no sign-in as HQ');
  assert.equal((await t.as(hq).post('/api/dev/clock', { now: 0 })).status, 404);
  assert.equal((await t.as(hq).post('/api/dev/run-jobs')).status, 404);
  assert.equal((await t.as(hq).get('/api/auth/me')).body.dev, false);

  const d = await makeApp({ dev: true });
  assert.equal((await d.anon.get('/api/dev/accounts')).status, 200, 'with dev mode on, the demo helpers are there');
});

// ---------------------------------------------------------------- hosting (render.yaml, docs/deploy.md)

test('CORE', 'GET /healthz answers 200 {ok:true} with no sign-in, for the host\'s health check', async () => {
  const t = await makeApp();
  const r = await t.anon.get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('CORE', 'the sign-in cookie is Secure when the request came over HTTPS through the host\'s proxy, and stays plain over local HTTP', async () => {
  const t = await makeApp();
  const p = t.fx.family(t.fx.location()).parent;
  const login = proto => fetch(t.base + '/api/auth/login', { method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, proto ? { 'x-forwarded-proto': proto } : {}),
    body: JSON.stringify({ email: p.email, password: 'demo1234' }) });
  const flags = r => (r.headers.get('set-cookie') || '').split(';').map(x => x.trim().toLowerCase());
  const https = await login('https');
  assert.equal(https.status, 200);
  assert.ok(flags(https).includes('secure'), 'HTTPS: Secure');
  assert.ok(flags(https).includes('httponly'));
  assert.equal((await https.json()).token, undefined, 'no token in the body (L64)');
  assert.ok(!flags(await login(null)).includes('secure'), 'plain local HTTP keeps working');
  assert.ok(!flags(await login('http')).includes('secure'));
});

test('CORE', 'a first boot on an empty database makes the schema and nothing else; demo data only with ELITE_SEED_DEMO=1, and only into a database with no accounts', async () => {
  const { createApp, needsDemoSeed } = load('src/app.js');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'elite-boot-'));
  const file = path.join(dir, 'fresh.db');
  assert.equal(needsDemoSeed(file, {}), false, 'not asked for: never');
  assert.equal(needsDemoSeed(file, { ELITE_SEED_DEMO: '1' }), true, 'asked for, and no database yet');
  const { ctx } = createApp({ dbFile: file });
  const count = tbl => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;
  for (const tbl of ['users', 'locations', 'notifications', 'push_subscriptions', 'settings']) assert.equal(count(tbl), 0, tbl + ' starts empty');
  assert.equal(needsDemoSeed(file, { ELITE_SEED_DEMO: '0' }), false);
  assert.equal(needsDemoSeed(file, { ELITE_SEED_DEMO: '1' }), true, 'schema only, no accounts: the demo may go in');
  ctx.db.prepare("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('hq', 'A', 'a@x.test', 'x', 0)").run();
  assert.equal(needsDemoSeed(file, { ELITE_SEED_DEMO: '1' }), false, 'a database with accounts is never seeded over');
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  // server.js seeds only through this check, before the app opens the database.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(needsDemoSeed\(DB, process\.env\)\) \{/);
  assert.ok(server.indexOf('needsDemoSeed(DB') < server.indexOf('createApp({'));
});

// ---------------------------------------------------------------- web push (src/push.js, public/sw.js)

const EP = n => 'https://fcm.googleapis.com/fcm/send/device-' + n;
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const SUB = n => ({ endpoint: EP(n), keys: KEYS });
const subsOf = (t, u) => t.db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(u.id).map(r => r.endpoint);
// The push sender, faked through ctx so no test touches the network. fail: endpoint -> status code, or 'throw'.
function fakePush(t, fail = {}) {
  const sent = [];
  t.ctx.pushSender = (sub, payload, options) => {
    sent.push({ endpoint: sub.endpoint, keys: sub.keys, payload: JSON.parse(payload), options });
    const f = fail[sub.endpoint];
    if (f === 'throw') throw new Error('boom');
    return f ? Promise.reject(Object.assign(new Error('push failed'), { statusCode: f })) : Promise.resolve({ statusCode: 201 });
  };
  return sent;
}

test(['CORE', 'NF-1'], 'push subscriptions: signed-in users only, each manages only their own, and only real push services over https, with keys', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const a = t.fx.family(loc).parent, b = t.fx.family(loc).parent;
  assert.equal((await t.anon.get('/api/push/key')).status, 401);
  assert.equal((await t.anon.post('/api/push/subscribe', SUB(1))).status, 401);
  assert.equal((await t.anon.post('/api/push/unsubscribe', { endpoint: EP(1) })).status, 401);
  assert.equal((await t.as(a).post('/api/push/subscribe', SUB(1))).status, 200);
  assert.equal((await t.as(a).post('/api/push/subscribe', SUB(1))).status, 200, 'subscribing again is fine');
  assert.deepEqual(subsOf(t, a), [EP(1)]);
  const theirs = await t.as(b).post('/api/push/unsubscribe', { endpoint: EP(1) });
  assert.deepEqual([theirs.status, theirs.body.removed], [200, 0], "nobody removes another user's subscription");
  assert.deepEqual(subsOf(t, a), [EP(1)]);
  for (const body of [
    { endpoint: 'https://evil.test/collect', keys: KEYS },
    { endpoint: 'https://fcm.googleapis.com.evil.test/x', keys: KEYS },
    { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: KEYS },
    { endpoint: EP(2) },
    { endpoint: EP(2), keys: { p256dh: 'not base64!', auth: KEYS.auth } },
    {},
  ]) {
    const r = await t.as(b).post('/api/push/subscribe', body);
    assert.deepEqual([r.status, r.body.error], [400, 'bad_subscription'], JSON.stringify(body));
  }
  assert.deepEqual(subsOf(t, b), []);
  for (const ep of ['https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-by3p.notify.windows.com/w/?token=abc']) {
    assert.equal((await t.as(b).post('/api/push/subscribe', { endpoint: ep, keys: KEYS })).status, 200, ep);
  }
  const own = await t.as(a).post('/api/push/unsubscribe', { endpoint: EP(1) });
  assert.equal(own.body.removed, 1);
  assert.deepEqual(subsOf(t, a), []);
  // The endpoint is the device: the same browser signed in as someone else moves to that account.
  await t.as(a).post('/api/push/subscribe', SUB(3));
  await t.as(b).post('/api/push/subscribe', SUB(3));
  assert.deepEqual(subsOf(t, a), []);
  assert.ok(subsOf(t, b).includes(EP(3)));
});

test('CORE', 'VAPID keys: from the environment when set; otherwise made once and kept in settings so a restart keeps them; only the public key is handed out', async () => {
  const t = await makeApp();
  const push = load('src/push.js');
  const p = t.fx.family(t.fx.location()).parent;
  const r = await t.as(p).get('/api/push/key');
  assert.equal(r.status, 200);
  const row = k => (t.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
  assert.ok(row('vapid_public_key') && row('vapid_private_key'));
  assert.equal(r.body.publicKey, row('vapid_public_key'));
  assert.ok(!JSON.stringify(r.body).includes(row('vapid_private_key')), 'the private key never leaves the server');
  const before = [row('vapid_public_key'), row('vapid_private_key')];
  delete t.ctx.vapid; // a restart: same database, nothing in memory
  const again = push.vapid(t.ctx, {});
  assert.deepEqual([again.publicKey, again.privateKey], before);
  assert.deepEqual([row('vapid_public_key'), row('vapid_private_key')], before);

  const t2 = await makeApp();
  const env = { VAPID_PUBLIC_KEY: 'PUB', VAPID_PRIVATE_KEY: 'PRIV', VAPID_SUBJECT: 'mailto:ops@elite.test' };
  assert.deepEqual({ ...push.vapid(t2.ctx, env) }, { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:ops@elite.test' });
  assert.equal(t2.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'vapid%'").get().n, 0, 'nothing generated when the environment has keys');
});

test(['CORE', 'NF-1'], "notify.send() also pushes each notification to that user's own browsers: a tag per notification, a link to it, normal urgency; emergencies are urgent and stay on screen", async () => {
  const t = await makeApp();
  const notify = load('src/notify.js'), push = load('src/push.js');
  const loc = t.fx.location();
  const f1 = t.fx.family(loc), f2 = t.fx.family(loc);
  const sent = fakePush(t);
  await t.as(f1.parent).post('/api/push/subscribe', SUB('a1'));
  await t.as(f1.parent).post('/api/push/subscribe', SUB('a2')); // a second phone
  await t.as(f1.student).post('/api/push/subscribe', SUB('s1'));
  await t.as(f2.parent).post('/api/push/subscribe', SUB('b1'));
  const off = t.fx.user('parent', { location: loc, active: 0 });
  t.db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?,?,?,?)').run(off.id, EP('off'), JSON.stringify(KEYS), 0);

  const [row] = notify.send(t.ctx, [f1.parent.id, off.id], { kind: 'checkin', title: 'Maya checked in', body: 'Irvine, 1:02 PM', refType: 'visit', refId: 9 });
  assert.equal(sent.length, 0, 'nothing goes out inside the request that sent it');
  await push.flush(t.ctx);
  assert.deepEqual(sent.map(s => s.endpoint).sort(), [EP('a1'), EP('a2')], 'only that user\'s browsers, and never an inactive account\'s');
  assert.deepEqual(sent[0].payload, { id: row.id, title: 'Maya checked in', body: 'Irvine, 1:02 PM', tag: 'n' + row.id,
    url: '/#/inbox/' + row.id, emergency: false, requireInteraction: false });
  assert.deepEqual(sent[0].keys, KEYS);
  assert.equal(sent[0].options.urgency, 'normal');
  const v = push.vapid(t.ctx);
  assert.deepEqual(sent[0].options.vapidDetails, { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey });

  sent.length = 0;
  const [alarm] = notify.send(t.ctx, [f2.parent.id], { kind: 'emergency', title: 'Building closed', body: 'Pick up by 3 PM.', refType: 'announcement', refId: 7, priority: 'emergency' });
  await push.flush(t.ctx);
  assert.deepEqual(sent.map(s => s.endpoint), [EP('b1')]);
  assert.equal(sent[0].options.urgency, 'high');
  assert.equal(sent[0].payload.requireInteraction, true);
  assert.equal(sent[0].payload.tag, 'n' + alarm.id);
});

test('CORE', 'push failures never reach the caller: a gone subscription (404/410) is dropped, other errors keep it, and one broken send does not stop the rest', async () => {
  const t = await makeApp();
  const notify = load('src/notify.js'), push = load('src/push.js');
  const p = t.fx.family(t.fx.location()).parent;
  for (const n of ['gone', 'expired', 'down', 'throws', 'ok']) await t.as(p).post('/api/push/subscribe', SUB(n));
  const sent = fakePush(t, { [EP('gone')]: 410, [EP('expired')]: 404, [EP('down')]: 500, [EP('throws')]: 'throw' });
  const rows = notify.send(t.ctx, [p.id], { kind: 'x', title: 'Hi' });
  assert.equal(rows.length, 1, 'send() returns as usual');
  await push.flush(t.ctx);
  assert.deepEqual(sent.map(s => s.endpoint), [EP('gone'), EP('expired'), EP('down'), EP('throws'), EP('ok')]);
  assert.deepEqual(subsOf(t, p), [EP('down'), EP('throws'), EP('ok')]);
});

test('CORE', 'a notification whose write was rolled back is never pushed', async () => {
  const t = await makeApp();
  const notify = load('src/notify.js'), push = load('src/push.js'), db = load('src/db.js');
  const p = t.fx.family(t.fx.location()).parent;
  await t.as(p).post('/api/push/subscribe', SUB(1));
  const sent = fakePush(t);
  assert.throws(() => db.tx(t.db, () => { notify.send(t.ctx, [p.id], { kind: 'x', title: 'Never happened' }); throw new Error('rolled back'); }));
  await push.flush(t.ctx);
  assert.equal(t.fx.notifications(p).length, 0);
  assert.equal(sent.length, 0);
});

test(['CORE', 'NF-8'], 'service worker: a push shows its title and body under its own tag (emergencies stay on screen), and a tap focuses the open app at that item or opens it there', async () => {
  const on = {}, shown = [], opened = [], navigated = [];
  let windows = [];
  const self = {
    addEventListener: (type, fn) => { on[type] = fn; }, location: { origin: 'https://app.test' }, skipWaiting() {},
    registration: { showNotification: (title, o) => { shown.push(Object.assign({ title }, o)); return Promise.resolve(); } },
    clients: { matchAll: async () => windows, openWindow: async url => { opened.push(url); }, claim: async () => {} },
  };
  const sw = { self, URL, caches: {}, fetch() {} };
  vm.createContext(sw);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'), sw, { filename: 'public/sw.js' });
  const run = async (type, ev) => { let p; on[type](Object.assign({ waitUntil: x => { p = x; } }, ev)); await p; };
  const data = o => ({ json: () => o, text: () => JSON.stringify(o) });
  await run('push', { data: data({ id: 5, title: 'Maya checked in', body: 'Irvine, 1:02 PM', tag: 'n5', url: '/#/inbox/5', emergency: false, requireInteraction: false }) });
  await run('push', { data: data({ id: 6, title: 'Building closed', body: 'Pick up by 3 PM.', tag: 'n6', url: '/#/inbox/6', emergency: true, requireInteraction: true }) });
  assert.deepEqual(shown.map(s => [s.title, s.body, s.tag, s.requireInteraction, s.data.url]), [
    ['Maya checked in', 'Irvine, 1:02 PM', 'n5', false, '/#/inbox/5'],
    ['Building closed', 'Pick up by 3 PM.', 'n6', true, '/#/inbox/6'],
  ]);
  const note = url => ({ data: { url }, close() { this.closed = true; } });
  const n5 = note('/#/inbox/5');
  await run('notificationclick', { notification: n5 });
  assert.ok(n5.closed);
  assert.deepEqual(opened, ['https://app.test/#/inbox/5'], 'no app open: open it at the item');
  const app = { url: 'https://app.test/#/home', focus() { this.focused = true; return Promise.resolve(this); }, navigate(u) { navigated.push(u); return Promise.resolve(this); } };
  windows = [app];
  await run('notificationclick', { notification: note('/#/inbox/6') });
  assert.ok(app.focused);
  assert.deepEqual(navigated, ['https://app.test/#/inbox/6'], 'the open app moves to the item');
  assert.equal(opened.length, 1, 'no second window');
});

// ---------------------------------------------------------------- the shell: push, onboarding, focus, titles

const memStore = (m = new Map()) => ({ getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } });
const blockedStore = () => ({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
// A browser that can do web push: Notification permission, a service worker
// registration with a push manager, storage and the bits iPhone detection reads.
function pushBrowser({ permission = 'default', answer = 'granted', ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', touch = 0,
  standalone, displayStandalone = false, storage, session, push = true, existing = null } = {}) {
  const calls = { ask: 0, subscribe: [], unsubscribed: 0 };
  let current = null;
  const sub = (n, key) => ({ endpoint: EP(n), options: { applicationServerKey: key ? key.buffer : null },
    toJSON() { return { endpoint: this.endpoint, keys: KEYS }; },
    async unsubscribe() { calls.unsubscribed++; if (current === this) current = null; return true; } });
  if (existing) current = sub(existing.n, existing.key);
  const reg = { pushManager: { getSubscription: async () => current,
    subscribe: async o => { calls.subscribe.push(o); current = sub('tab', o.applicationServerKey); return current; } } };
  const state = { permission };
  const win = {
    navigator: { userAgent: ua, standalone, maxTouchPoints: touch,
      serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg, register: async () => reg } },
    matchMedia: () => ({ matches: displayStandalone }),
    localStorage: storage || memStore(), sessionStorage: session || memStore(),
  };
  if (push) {
    Object.assign(win, { PushManager: function PushManager() {},
      Notification: { get permission() { return state.permission; }, requestPermission: async () => { calls.ask++; state.permission = answer; return answer; } } });
  }
  return { win, calls };
}
const bannerOf = tab => tab.main().find(n => n.cls.includes('notify-banner')) || null;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test(['CORE', 'NF-8'], 'notification onboarding: parents and students get a Home banner, permission is asked only on a tap and then this device is subscribed; staff get no banner', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const fam = t.fx.family(loc);
  const b = pushBrowser();
  const tab = shellTab(t, '', b.win);
  tab.signIn(fam.parent);
  await tab.start();
  const box = bannerOf(tab);
  assert.ok(box, 'the banner is on Home');
  assert.equal(box.getAttribute('aria-labelledby'), 'notify-t');
  assert.equal(words(byTag(box, 'h2')[0]), 'Get alerts on this device');
  assert.deepEqual(byTag(box, 'button').map(words), ['Turn on notifications', 'No thanks']);
  assert.equal(b.calls.ask, 0, 'nothing asks for permission before a tap');
  byTag(box, 'button')[0].click();
  await tab.settle();
  assert.equal(b.calls.ask, 1);
  assert.deepEqual(subsOf(t, fam.parent), [EP('tab')], 'this device now gets the parent\'s notifications');
  const key = (t.db.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get() || {}).value;
  assert.deepEqual([...b.calls.subscribe[0].applicationServerKey], [...Buffer.from(key, 'base64url')]);
  assert.equal(b.calls.subscribe[0].userVisibleOnly, true);
  assert.equal(bannerOf(tab), null);
  assert.equal(tab.doc.activeElement.tag, 'h1', 'focus goes to the page heading, not the top of the page');
  assert.deepEqual(tab.doc.getElementById('toasts').childNodes.map(words), ['Notifications are on for this device.']);

  const st = shellTab(t, '', pushBrowser().win);
  st.signIn(fam.student);
  await st.start();
  assert.ok(bannerOf(st), 'students get it too');
  const sf = shellTab(t, '', pushBrowser().win);
  sf.signIn(t.fx.staff(loc));
  await sf.start();
  assert.ok(byTag(sf.main(), 'h1').length, 'staff Home drew');
  assert.equal(bannerOf(sf), null, 'staff do not');
});

test(['CORE', 'NF-8'], 'notification onboarding never nags: once per session, No thanks hides it on this device for good, a refusal is never asked again, and blocked storage still works', async () => {
  const t = await makeApp();
  const fam = t.fx.family(t.fx.location());
  const open = async (storage, session, opts = {}) => {
    const b = pushBrowser(Object.assign({ storage, session }, opts));
    const tab = shellTab(t, '', b.win);
    tab.signIn(fam.parent);
    await tab.start();
    return { tab, b };
  };
  const device = new Map(), s1 = new Map();
  // Leaving Home ends it for this session, a reload in the same session too; a new session shows it again.
  let { tab } = await open(memStore(device), memStore(s1));
  assert.ok(bannerOf(tab));
  await tab.go('#/inbox');
  await tab.go('#/home');
  assert.equal(bannerOf(tab), null, 'not again after leaving Home');
  ({ tab } = await open(memStore(device), memStore(s1)));
  assert.equal(bannerOf(tab), null, 'not again on a reload in the same session');
  ({ tab } = await open(memStore(device), memStore()));
  assert.ok(bannerOf(tab), 'a new session shows it again, since it was never dismissed');
  byTag(bannerOf(tab), 'button').find(x => words(x) === 'No thanks').click();
  await tab.settle();
  assert.equal(bannerOf(tab), null);
  assert.equal(tab.doc.activeElement.tag, 'h1');
  ({ tab } = await open(memStore(device), memStore()));
  assert.equal(bannerOf(tab), null, 'dismissed on this device: never again');

  // A refusal: no subscription, and nobody asks again.
  const device2 = new Map();
  let b;
  ({ tab, b } = await open(memStore(device2), memStore(), { answer: 'denied' }));
  byTag(bannerOf(tab), 'button')[0].click();
  await tab.settle();
  assert.equal(b.calls.ask, 1);
  assert.match(words(bannerOf(tab)), /Notifications stay off/);
  assert.deepEqual(subsOf(t, fam.parent), []);
  await tab.App.refresh();
  await tab.settle();
  assert.equal(bannerOf(tab), null, 'not offered again on the next draw');
  ({ tab, b } = await open(memStore(device2), memStore(), { permission: 'default' }));
  assert.equal(bannerOf(tab), null, 'nor in a later session');
  assert.equal(b.calls.ask, 0);

  // Storage blocked (private mode): Home still draws, and No thanks still hides it for this visit.
  ({ tab } = await open(blockedStore(), blockedStore()));
  assert.ok(byTag(tab.main(), 'h1').length);
  assert.ok(bannerOf(tab));
  byTag(bannerOf(tab), 'button').find(x => words(x) === 'No thanks').click();
  await tab.settle();
  await tab.go('#/inbox');
  await tab.go('#/home');
  assert.equal(bannerOf(tab), null);
});

test(['CORE', 'NF-8'], 'notification onboarding on an iPhone: Safari (not installed) shows the Add to Home Screen steps instead of asking; the installed app offers to turn notifications on', async () => {
  const t = await makeApp();
  const fam = t.fx.family(t.fx.location());
  const open = async opts => { const b = pushBrowser(opts); const tab = shellTab(t, '', b.win); tab.signIn(fam.parent); await tab.start(); return { tab, b }; };
  // iPhone Safari has no web push outside the installed app (an iPad reports itself as a Mac with touch).
  for (const opts of [{ ua: IPHONE, push: false }, { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', touch: 5, push: false }]) {
    const { tab } = await open(opts);
    const box = bannerOf(tab);
    assert.ok(box, opts.ua);
    assert.equal(words(byTag(box, 'h2')[0]), 'Get alerts on your iPhone');
    assert.deepEqual(byTag(box, 'li').map(words), [
      'Tap the Share button (the square with an arrow) in Safari.',
      'Choose Add to Home Screen, then tap Add.',
      'Open ELITE Spaces from the new icon on your Home Screen and sign in.',
      'Tap Turn on notifications.',
    ]);
    assert.deepEqual(byTag(box, 'button').map(words), ['Got it, hide this']);
    byTag(box, 'button')[0].click();
    assert.equal(bannerOf(tab), null);
  }
  for (const opts of [{ ua: IPHONE, standalone: true }, { ua: IPHONE, displayStandalone: true }]) {
    const { tab, b } = await open(opts);
    assert.deepEqual(byTag(bannerOf(tab), 'button').map(words), ['Turn on notifications', 'No thanks'], JSON.stringify(opts));
    assert.equal(b.calls.ask, 0);
  }
});

test(['CORE', 'NF-8'], 'push on this device follows the account: notifications already allowed subscribe at sign-in without asking, a changed server key resubscribes, and signing out stops them', async () => {
  const t = await makeApp();
  const push = load('src/push.js');
  const fam = t.fx.family(t.fx.location());
  const b = pushBrowser({ permission: 'granted' });
  const tab = shellTab(t, '', b.win);
  tab.signIn(fam.parent);
  await tab.start();
  assert.equal(b.calls.ask, 0);
  assert.deepEqual(subsOf(t, fam.parent), [EP('tab')]);
  assert.equal(bannerOf(tab), null, 'already on: no banner');
  const out = tab.doc.getElementById('topbar').find(n => n.tag === 'button' && /^Sign out/.test(n.getAttribute('aria-label') || ''));
  out.click();
  await tab.settle();
  assert.deepEqual(subsOf(t, fam.parent), [], 'signed out: this device stops getting them');

  const key = Uint8Array.from(Buffer.from(push.vapid(t.ctx).publicKey, 'base64url'));
  const same = pushBrowser({ permission: 'granted', existing: { n: 'same', key } });
  const tab2 = shellTab(t, '', same.win);
  tab2.signIn(fam.parent);
  await tab2.start();
  assert.deepEqual(subsOf(t, fam.parent), [EP('same')], 'the existing subscription is reused');
  assert.equal(same.calls.unsubscribed, 0);

  const stale = pushBrowser({ permission: 'granted', existing: { n: 'old', key: new Uint8Array([4, 1, 2, 3]) } });
  const tab3 = shellTab(t, '', stale.win);
  tab3.signIn(fam.student);
  await tab3.start();
  assert.equal(stale.calls.unsubscribed, 1, 'made with another key: replaced');
  assert.deepEqual(subsOf(t, fam.student), [EP('tab')]);
});

test(['CORE', 'NF-7'], 'Inbox: after Mark all read, focus goes to the Inbox heading, not the top of the page', async () => {
  const w = await inboxWorld();
  const { tab } = w;
  await tab.start();
  await tab.go('#/inbox');
  byTag(tab.main(), 'button').find(b => b.textContent === 'Mark all read').click();
  await tab.settle();
  assert.equal(tab.doc.activeElement.tag, 'h1');
  assert.equal(words(tab.doc.activeElement), 'Inbox');
  assert.equal(tab.doc.activeElement.getAttribute('tabindex'), '-1');
});

test(['CORE', 'NF-8'], "a tapped push opens #/inbox/<id>: the Inbox sends it on to that item's screen and marks only it read; an item with no screen stays in the Inbox", async () => {
  const w = await inboxWorld();
  const { tab, t } = w;
  await tab.start();
  await tab.go('#/inbox/' + w.visit.id);
  assert.equal(tab.location.hash, '#/news/42');
  assert.equal(words(tab.main()), 'news');
  assert.deepEqual(t.fx.notifications(w.fam.parent).filter(n => !n.read_at).map(n => n.id).sort((x, y) => x - y), [w.closure.id, w.alarm.id]);
  await tab.go('#/inbox/' + w.closure.id); // the closure screen is staff-only here
  assert.equal(tab.location.hash, '#/inbox/' + w.closure.id);
  assert.equal(inboxItems(tab).length, 4);
});

test(['CORE'], 'Inbox links work for every ref type modules send, whichever registers first, the link or the view it opens (L35)', async () => {
  const t = await makeApp();
  const notify = load('src/notify.js');
  const fam = t.fx.family(t.fx.location());
  const tab = shellTab(t);
  const App = tab.App;
  const types = { visit: 'hours', closure: 'schedule', session: 'schedule', enrollment: n => 'schedule/' + n.ref_id,
    enrollment_request: 'schedule', membership: 'family', announcement: n => 'news/' + n.ref_id,
    daily_note: n => 'notes/note/' + n.ref_id, user: 'family', location: 'family' };
  for (const [type, route] of Object.entries(types)) App.inboxLink(type, route);
  for (const id of ['hours', 'schedule', 'family', 'news', 'notes']) App.register({ id, title: id, roles: ['parent'], render(el) { el.append(id); } });
  Object.keys(types).forEach((type, i) => notify.send(t.ctx, [fam.parent.id], { kind: type, title: 'About ' + type, refType: type, refId: i + 1 }));
  tab.signIn(fam.parent);
  await tab.start();
  await tab.go('#/inbox');
  assert.deepEqual(Object.fromEntries(inboxItems(tab).map(i => [i.text.replace(/^New About /, ''), i.href])), {
    visit: '#/hours', closure: '#/schedule', session: '#/schedule', enrollment: '#/schedule/4', enrollment_request: '#/schedule',
    membership: '#/family', announcement: '#/news/7', daily_note: '#/notes/note/8', user: '#/family', location: '#/family',
  });
});

test(['CORE', 'NF-7'], 'sign-in: the tab title names the screen, following a panel a module opens in place of the form (create an account, an invite code)', async () => {
  const t = await makeApp({ dev: true });
  const observers = [];
  class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.off = true; } }
  const tab = shellTab(t, '', { MutationObserver });
  const changed = () => observers.filter(o => !o.off).forEach(o => o.fn([]));
  let openPanel, back;
  tab.App.signInExtras.push(wrap => {
    const form = wrap.find(n => n.tag === 'form');
    const panel = tab.el('div');
    form.after(panel);
    openPanel = heading => { form.style.display = 'none'; panel.replaceChildren(...(heading ? [tab.App.h('h2', null, heading)] : [])); };
    back = () => { form.style.display = ''; panel.replaceChildren(); };
  });
  await tab.start();
  assert.equal(tab.doc.title, 'Sign in · ELITE Spaces');
  assert.ok(byTag(tab.main(), 'h2').some(n => words(n) === 'Demo accounts'));
  openPanel(null);
  changed();
  assert.equal(tab.doc.title, 'Sign in · ELITE Spaces', 'a panel still loading keeps the title, never the demo list heading');
  openPanel('Create your family account');
  changed();
  assert.equal(tab.doc.title, 'Create your family account · ELITE Spaces');
  back();
  changed();
  assert.equal(tab.doc.title, 'Sign in · ELITE Spaces');
  openPanel('Open your invite');
  changed();
  assert.equal(tab.doc.title, 'Open your invite · ELITE Spaces');
  tab.signIn(t.fx.family(t.fx.location()).parent);
  tab.App.boot();
  await tab.settle();
  changed();
  assert.equal(tab.doc.title, 'Home · ELITE Spaces', 'once signed in, the sign-in screen no longer sets the title');
});

// ---------------------------------------------------------------- one account per browser (fix list 2026-10-21 item 3)

const signedInAs = tab => {
  const top = tab.doc.getElementById('topbar');
  const out = top.find(n => n.tag === 'button' && /^Sign out /.test(n.getAttribute('aria-label') || ''));
  return top.hidden || !out ? null : out.getAttribute('aria-label').replace(/^Sign out /, '');
};
const toastsOf = tab => tab.doc.getElementById('toasts').childNodes.map(words);
// A page holding a form, which notes whom it was drawn for.
function deskView(tab, drawn) {
  const { h } = tab.App;
  tab.App.register({ id: 'desk', title: 'Desk', roles: ['staff', 'parent'], order: 5, render(el) {
    drawn.push(tab.App.me.user.name);
    el.append(h('h1', null, 'Desk'), h('form', null, h('input', { 'aria-label': 'Note' })));
  } });
}

test(['CORE'], 'another tab signs in as someone else: back in view or focused (or hearing from the old account), this tab is drawn again for the account signed in now, drops the half-typed form and the open question, and says who is signed in', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const dana = t.fx.staff(loc, { name: 'Dana Park' }), chris = t.fx.staff(loc, { name: 'Chris Ortiz' }), pat = t.fx.director(loc, { name: 'Pat Lee' });
  const tab = shellTab(t, '#/desk');
  const drawn = [];
  deskView(tab, drawn);
  tab.signIn(dana);
  // The window gets focus while the tab is still reading who is signed in: that read decides, nothing is "switched".
  const release = tab.hold(url => url === '/api/auth/me');
  tab.App.start();
  tab.fire('focus');
  await tab.settle();
  release();
  await tab.settle();
  assert.equal(signedInAs(tab), 'Dana Park');
  assert.deepEqual(drawn, ['Dana Park']);
  assert.deepEqual(toastsOf(tab), []);

  const input = tab.main().find(n => n.tag === 'input');
  input.value = 'Half-typed for Dana';
  const question = tab.App.confirm({ anchor: input, title: 'Save the note?', confirmLabel: 'Save note', cancelLabel: 'Keep editing' });
  const answerNow = () => Promise.race([question, new Promise(r => setImmediate(() => r('unanswered')))]);
  assert.equal(await answerNow(), 'unanswered');

  // Another tab signs in as Pat: the cookie every tab sends is now Pat's. This tab comes back into view.
  tab.signIn(pat);
  tab.doc.hidden = false;
  tab.doc.on.visibilitychange.forEach(fn => fn({ type: 'visibilitychange' }));
  await tab.settle();
  assert.equal(signedInAs(tab), 'Pat Lee');
  assert.deepEqual(drawn, ['Dana Park', 'Pat Lee']);
  assert.equal(input.isConnected, false, "Dana's half-typed form is gone");
  assert.notEqual(tab.main().find(n => n.tag === 'input'), input, 'a fresh form, drawn for Pat');
  assert.equal(await answerNow(), false, 'the question asked for Dana is answered No, so nothing is saved');
  assert.deepEqual(toastsOf(tab), ["You're now signed in as Pat Lee."]);

  // Focus: nothing changed, nothing is drawn again; then a switch to Chris.
  tab.fire('focus');
  await tab.settle();
  assert.deepEqual(drawn, ['Dana Park', 'Pat Lee'], 'same account: no redraw');
  tab.signIn(chris);
  tab.fire('focus');
  await tab.settle();
  assert.equal(signedInAs(tab), 'Chris Ortiz');
  assert.deepEqual(toastsOf(tab).slice(-1), ["You're now signed in as Chris Ortiz."]);

  // Back to Dana (same role and location as Chris), noticed through a notification arriving on the open stream.
  tab.signIn(dana);
  tab.streams.at(-1).onmessage({ data: JSON.stringify({ id: 1, title: 'Closed Monday' }) });
  await tab.settle();
  assert.equal(signedInAs(tab), 'Dana Park');
  assert.deepEqual(drawn.slice(-1), ['Dana Park']);
  assert.deepEqual(toastsOf(tab).slice(-1), ["You're now signed in as Dana Park."]);

  // Signed out underneath (a 401): the sign-in screen, and the old account's notification stream is closed.
  const live = tab.streams.at(-1);
  t.ctx.sessions.clear();
  await tab.App.refreshBell();
  await tab.settle();
  assert.equal(signedInAs(tab), null);
  assert.equal(live.closed, true, "no more of Dana's notifications in this tab");
});

test(['CORE'], 'after a pause, the next page opens only once the tab has checked who is signed in, so it is never drawn for the old account', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const dana = t.fx.staff(loc, { name: 'Dana Park' }), chris = t.fx.staff(loc, { name: 'Chris Ortiz' });
  let later = 0;
  class LaterDate extends Date { static now() { return Date.now() + later; } }
  const tab = shellTab(t, '#/desk', { Date: LaterDate });
  const drawn = [];
  deskView(tab, drawn);
  tab.App.register({ id: 'roster', title: 'Roster', roles: ['staff'], render(el) { drawn.push('roster for ' + tab.App.me.user.name); el.append('roster'); } });
  tab.signIn(dana);
  await tab.start();
  tab.signIn(chris); // another tab, while this one sat open
  later = 6000;
  await tab.go('#/roster');
  assert.deepEqual(drawn, ['Dana Park', 'roster for Chris Ortiz']);
  assert.equal(signedInAs(tab), 'Chris Ortiz');
  assert.deepEqual(toastsOf(tab), ["You're now signed in as Chris Ortiz."]);
});

test(['CORE'], 'a refusal (403) checks once who is signed in: the same account just sees the refusal; after a switch the app is drawn again for the new account, with no error about the old page', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const dana = t.fx.staff(loc, { name: 'Dana Park' }), parent = t.fx.family(loc).parent;
  const tab = shellTab(t, '#/desk');
  const drawn = [];
  deskView(tab, drawn);
  // What a module's scope check answers when the signed-in account may not do something.
  const send = tab.win.fetch;
  let meReads = 0;
  tab.win.fetch = (url, opts) => {
    if (url === '/api/auth/me') meReads++;
    if (url !== '/api/desk/save') return send(url, opts);
    return tab.track(Promise.resolve(new Response(JSON.stringify({ error: 'forbidden', message: 'You do not have access to that.' }),
      { status: 403, headers: { 'content-type': 'application/json' } })));
  };
  tab.signIn(dana);
  await tab.start();
  const save = () => tab.App.run(null, () => tab.App.api.post('/api/desk/save', { note: 'x' }));
  meReads = 0;
  await save();
  await tab.settle();
  assert.equal(meReads, 1, 'checked once');
  assert.deepEqual(toastsOf(tab), ['You do not have access to that.']);
  assert.deepEqual(drawn, ['Dana Park'], 'same account: not drawn again');

  tab.signIn(parent); // another tab signed in as a parent
  await save();
  await tab.settle();
  assert.equal(signedInAs(tab), parent.name);
  assert.deepEqual(drawn, ['Dana Park', parent.name]);
  assert.deepEqual(toastsOf(tab), ['You do not have access to that.', "You're now signed in as " + parent.name + '.']);
});

// Two tabs in one browser share a cookie jar and can reach each other by
// BroadcastChannel or, where there is none, by storage events.
function channelBus() {
  const open = [];
  return class BroadcastChannel {
    constructor(name) { this.name = name; open.push(this); }
    postMessage(data) { for (const c of open) if (c !== this && c.name === this.name && c.onmessage) setImmediate(() => c.onmessage({ data })); }
    close() {}
  };
}
function storageBus() {
  const m = new Map(), tabs = [];
  const storeFor = () => {
    const s = { getItem: k => (m.has(k) ? m.get(k) : null),
      setItem(k, v) { m.set(k, String(v)); for (const x of tabs) if (x.store !== s) setImmediate(() => x.tab.fire('storage', { key: k, newValue: String(v) })); } };
    return s;
  };
  return { storeFor, tabs };
}

test(['CORE'], 'signing in or out in one tab redraws the other tabs at once (BroadcastChannel, or a storage event without it), and a tab signed out elsewhere stops showing the old account', async () => {
  const t = await makeApp();
  const loc = t.fx.location();
  const dana = t.fx.staff(loc, { name: 'Dana Park' }), chris = t.fx.staff(loc, { name: 'Chris Ortiz' });
  const settleAll = async (...tabs) => { for (let i = 0; i < 3; i++) for (const x of tabs) await x.settle(); };
  for (const transport of ['BroadcastChannel', 'storage']) {
    const jar = { cookie: '' };
    let a, b;
    if (transport === 'BroadcastChannel') {
      const BroadcastChannel = channelBus();
      a = shellTab(t, '', { BroadcastChannel }, jar);
      b = shellTab(t, '', { BroadcastChannel }, jar);
    } else {
      const bus = storageBus();
      const sa = bus.storeFor(), sb = bus.storeFor();
      a = shellTab(t, '', { localStorage: sa }, jar);
      b = shellTab(t, '', { localStorage: sb }, jar);
      bus.tabs.push({ store: sa, tab: a }, { store: sb, tab: b });
    }
    a.signIn(dana);
    await a.start();
    await b.start();
    assert.deepEqual([signedInAs(a), signedInAs(b)], ['Dana Park', 'Dana Park'], transport);

    // Tab b signs out.
    b.doc.getElementById('topbar').find(n => n.tag === 'button' && /^Sign out/.test(n.getAttribute('aria-label') || '')).click();
    await settleAll(a, b);
    assert.equal(signedInAs(a), null, transport + ': tab a shows the sign-in screen');
    assert.ok(byTag(a.main(), 'form').length, transport);
    assert.deepEqual(toastsOf(a), ["You're signed out."], transport);
    assert.ok(a.streams.length && a.streams.every(s => s.closed), transport + ": no more of Dana's notifications in tab a");

    // Tab b signs in as Chris with the form.
    b.doc.getElementById('si-email').value = chris.email;
    b.doc.getElementById('si-pw').value = 'demo1234';
    b.main().find(n => n.tag === 'form').dispatch('submit');
    await settleAll(a, b);
    assert.deepEqual([signedInAs(a), signedInAs(b)], ['Chris Ortiz', 'Chris Ortiz'], transport);
    assert.deepEqual(toastsOf(a).slice(-1), ["You're now signed in as Chris Ortiz."], transport);
    assert.deepEqual(toastsOf(b), [], transport + ': the tab that signed in has nothing to explain');
  }
});

// ---------------------------------------------------------------- home-screen icons (fix list 2026-10-21 item 2)

// Width, height and transparency from a PNG's own header.
function pngInfo(file) {
  const b = fs.readFileSync(file);
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file + ' is a PNG');
  assert.equal(b.toString('latin1', 12, 16), 'IHDR', file);
  return { size: b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), opaque: [0, 2].includes(b[25]) && !b.includes(Buffer.from('tRNS')), bytes: b };
}

test(['CORE', 'NF-8'], 'home-screen icons: the head names a 180px opaque apple-touch-icon PNG (also at the site root), the manifest lists 192 and 512 PNGs plus a full-bleed maskable one and keeps the SVG, and pushes show the 192 PNG', async () => {
  const pub = rel => path.join(ROOT, 'public', rel.replace(/^\//, ''));
  const html = fs.readFileSync(pub('index.html'), 'utf8');
  const links = html.match(/<link rel="apple-touch-icon"[^>]*>/g) || [];
  assert.equal(links.length, 1);
  const attr = (tag, k) => (tag.match(new RegExp(' ' + k + '="([^"]*)"')) || [])[1];
  assert.equal(attr(links[0], 'sizes'), '180x180');
  const touch = attr(links[0], 'href');
  assert.match(touch, /\.png$/);
  const touchPng = pngInfo(pub(touch));
  assert.equal(touchPng.size, '180x180');
  assert.ok(touchPng.opaque, 'no transparency: iOS rounds the corners itself');

  const { icons } = JSON.parse(fs.readFileSync(pub('manifest.webmanifest'), 'utf8'));
  const pngs = icons.filter(i => i.type === 'image/png');
  for (const i of pngs) assert.equal(pngInfo(pub(i.src)).size, i.sizes, i.src + ' is the size the manifest says');
  const purposes = i => (i.purpose || 'any').split(/\s+/);
  assert.deepEqual(pngs.filter(i => purposes(i).includes('any')).map(i => i.sizes).sort(), ['192x192', '512x512']);
  const maskable = icons.filter(i => purposes(i).includes('maskable'));
  assert.deepEqual(maskable.map(i => [i.type, i.sizes]), [['image/png', '512x512']], 'one maskable icon, and it is the PNG');
  assert.ok(pngInfo(pub(maskable[0].src)).opaque, 'maskable art is full-bleed');
  assert.ok(icons.some(i => i.src === '/icon.svg' && i.type === 'image/svg+xml'), 'the SVG stays');

  // Served as PNGs, and an iPhone asking the site root gets the same icon.
  const t = await makeApp();
  for (const src of [touch, ...pngs.map(i => i.src)]) {
    const r = await t.anon.get(src);
    assert.deepEqual([r.status, r.headers.get('content-type')], [200, 'image/png'], src);
    assert.ok(Buffer.compare(r.body, pngInfo(pub(src)).bytes) === 0, src);
  }
  const root = await t.anon.get('/apple-touch-icon.png');
  assert.deepEqual([root.status, root.headers.get('content-type')], [200, 'image/png']);
  assert.ok(Buffer.compare(root.body, touchPng.bytes) === 0, '/apple-touch-icon.png is the 180px icon');

  // The service worker's notifications use the 192px PNG.
  const on = {}, shown = [];
  const self = { addEventListener: (type, fn) => { on[type] = fn; }, location: { origin: 'https://app.test' },
    registration: { showNotification: (title, o) => { shown.push(o); return Promise.resolve(); } }, clients: {} };
  const sw = { self, URL, caches: {}, fetch() {} };
  vm.createContext(sw);
  vm.runInContext(fs.readFileSync(pub('sw.js'), 'utf8'), sw, { filename: 'public/sw.js' });
  let p;
  on.push({ data: { json: () => ({ id: 5, title: 'Maya checked in' }) }, waitUntil: x => { p = x; } });
  await p;
  assert.equal(shown[0].icon, '/icons/icon-192.png');
  assert.equal(pngInfo(pub(shown[0].icon)).size, '192x192');
});

// ---------------------------------------------------------------- security headers (fix list 2026-10-21 item 11)

test('CORE', 'every response carries the security headers (no sniffing, no framing, a strict referrer) and never names the server software; HSTS only over HTTPS', async () => {
  const t = await makeApp();
  const p = t.fx.family(t.fx.location()).parent;
  const plain = (url, headers = {}) => fetch(t.base + url, { headers });
  const answers = {
    'the app page': await plain('/'),
    'a static file': await plain('/css/app.css'),
    'the root icon': await plain('/apple-touch-icon.png'),
    'an API answer': await t.as(p).get('/api/notifications'),
    'a sign-in refusal': await plain('/api/auth/me'),
    'an unknown API path': await plain('/api/nope'),
    'bad JSON': await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }),
    'the health check': await plain('/healthz'),
  };
  assert.equal(answers['bad JSON'].status, 400);
  for (const [what, r] of Object.entries(answers)) {
    const hd = k => r.headers.get(k);
    assert.deepEqual({
      nosniff: hd('x-content-type-options'), frame: hd('x-frame-options'), csp: hd('content-security-policy'),
      referrer: hd('referrer-policy'), poweredBy: hd('x-powered-by'), hsts: hd('strict-transport-security'),
    }, { nosniff: 'nosniff', frame: 'DENY', csp: "frame-ancestors 'none'", referrer: 'strict-origin-when-cross-origin', poweredBy: null, hsts: null }, what);
  }
  for (const url of ['/', '/healthz', '/api/auth/me']) {
    assert.equal((await plain(url, { 'x-forwarded-proto': 'https' })).headers.get('strict-transport-security'), 'max-age=31536000', 'HTTPS through the host: ' + url);
    assert.equal((await plain(url, { 'x-forwarded-proto': 'http' })).headers.get('strict-transport-security'), null, 'plain HTTP: ' + url);
  }
});
