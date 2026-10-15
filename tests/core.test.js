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
  assert.equal(set.match(/^sid_4199=([^;]+)/)[1], r.body.token);
  const me = cookie => fetch(t.base + '/api/auth/me', { headers: { cookie } });
  assert.equal((await me('sid_4199=' + r.body.token)).status, 200);
  assert.equal((await me('sid=' + r.body.token)).status, 401, 'a cookie under another server\'s name is ignored');
  const out = await fetch(t.base + '/api/auth/logout', { method: 'POST', headers: { cookie: 'sid_4199=' + r.body.token } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /^sid_4199=;/);
  assert.equal((await me('sid_4199=' + r.body.token)).status, 401, 'signing out ends the session');
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
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
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
function shellTab(t, hash = '') {
  let cookie = '';
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
  const fire = type => (winOn[type] || []).forEach(fn => fn({ type }));
  const location = {
    _hash: hash,
    get hash() { return this._hash; },
    // Like a browser, setting the hash fires hashchange a moment later.
    set hash(v) { this._hash = v ? (String(v).startsWith('#') ? String(v) : '#' + v) : ''; track(new Promise(r => setImmediate(() => { fire('hashchange'); r(); }))); },
  };
  class EventSource { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } }
  // hold(match): the next matching request waits to be sent until release() (a slow network).
  let held = null;
  const send = (url, opts) => track(fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
    .then(async r => new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers })));
  const fetchAs = (url, opts = {}) => {
    if (!held || !held.match(url, opts)) return send(url, opts);
    const wait = held.wait;
    held = null;
    return wait.then(() => send(url, opts));
  };
  const hold = match => { let release; held = { match, wait: new Promise(r => { release = r; }) }; return release; };
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator: {}, location, EventSource,
    history: { replaceState(_s, _t, url) { location._hash = String(url).replace(/^[^#]*/, ''); } },
    addEventListener(type, fn) { (winOn[type] = winOn[type] || []).push(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
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
    App: win.App, win, doc, location, streams, settle, el, hold,
    main: () => doc.getElementById('main'),
    signIn(user) { const token = crypto.randomBytes(16).toString('hex'); t.ctx.sessions.set(token, user.id); cookie = 'sid=' + token; },
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
