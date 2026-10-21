/* Installable-app service worker: caches the shell so the app opens fast
   (API calls always go to the network), shows web push notifications, and
   opens the app at the right screen when one is tapped. */
const CACHE = 'elite-spaces-v3';
const SHELL = ['/', '/css/app.css', '/js/app.js', '/icon.svg', '/icons/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

// A push from src/push.js: { id, title, body, tag, url, emergency, requireInteraction }.
// One tag per notification, so the same item shown by an open page replaces it
// instead of showing twice. Emergency alerts stay until someone acts on them.
self.addEventListener('push', e => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch (_) { n = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(n.title || 'ELITE Spaces', {
    body: n.body || '',
    tag: n.tag || (n.id ? 'n' + n.id : undefined),
    icon: '/icons/icon-192.png',
    requireInteraction: !!n.requireInteraction,
    data: { url: n.url || '/#/inbox' },
  }));
});

// Tapping a notification: focus an open copy of the app and move it to the
// item (the Inbox sends it on to the item's own screen), or open the app there.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/#/inbox', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus().then(c => (c || open).navigate(url)).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
