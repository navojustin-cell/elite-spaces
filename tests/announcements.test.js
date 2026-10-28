'use strict';
// Announcements and emergency alerts (PRD 5, AN-1..AN-6) and their scope rules (NF-1).
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, makeApp, assert, load, at, ROOT } = require('./lib');

const LA = 'America/Los_Angeles';
const TO = 'America/Toronto';
const API = '/api/announcements';

// Two locations in two zones, each with a director, staff and two families, plus HQ.
async function world() {
  const t = await makeApp();
  const A = t.fx.location({ name: 'Irvine' });
  const B = t.fx.location({ name: 'Toronto', timezone: TO, lat: 43.6532, lng: -79.3832 });
  return {
    t, A, B,
    hq: t.fx.hq(),
    dirA: t.fx.director(A), staffA: t.fx.staff(A),
    dirB: t.fx.director(B), staffB: t.fx.staff(B),
    famA: t.fx.family(A), famA2: t.fx.family(A),
    famB: t.fx.family(B),
  };
}

const post = (over = {}) => Object.assign({ category: 'event', title: 'Fall open house', body: 'Come see the new study rooms on Friday.', audience: 'families' }, over);
const alert = (over = {}) => Object.assign({ title: 'Power outage', body: 'The building is closed for the rest of today. Please head home safely.' }, over);

// User ids that got a notification for announcement `id`, sorted.
const notified = (t, id) => t.db.prepare("SELECT user_id FROM notifications WHERE ref_type = 'announcement' AND ref_id = ? ORDER BY user_id")
  .all(id).map(r => r.user_id);
const sorted = (...users) => users.map(u => u.id).sort((x, y) => x - y);
const countAnnouncements = t => t.db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
const feedIds = async (t, u) => (await t.as(u).get(API + '/feed')).body.posts.map(p => p.id);

// ---------------------------------------------------------------- AN-1

test(['AN-1'], 'a director posts to their own location with a category, and only families there are notified', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post({ category: 'workshop' }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  const row = w.t.db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  assert.equal(row.type, 'announcement');
  assert.equal(row.category, 'workshop');
  assert.equal(row.status, 'published');
  assert.equal(row.created_by, w.dirA.id);
  assert.deepEqual(w.t.db.prepare('SELECT location_id FROM announcement_locations WHERE announcement_id = ?').all(id).map(x => x.location_id), [w.A.id]);
  // All families at Irvine: both parents and both students. Not Toronto, not staff.
  assert.deepEqual(notified(w.t, id), sorted(w.famA.parent, w.famA.student, w.famA2.parent, w.famA2.student));
  assert.equal(r.body.recipients, 4);
  assert.equal(r.body.notified, 4);
  assert.equal(r.body.announcement.category_label, 'Workshop');
});

test(['AN-1'], 'every PRD category is accepted, and anything else is refused', async () => {
  const w = await world();
  for (const c of ['event', 'workshop', 'holiday', 'session_offering', 'news']) {
    const r = await w.t.as(w.dirA).post(API, post({ category: c }));
    assert.equal(r.status, 201, c);
    assert.equal(r.body.announcement.category, c);
  }
  const before = countAnnouncements(w.t);
  for (const c of ['party', undefined, '', 'toString']) {
    const r = await w.t.as(w.dirA).post(API, post({ category: c }));
    assert.equal(r.status, 400, String(c));
    assert.equal(r.body.error, 'category');
  }
  assert.equal(countAnnouncements(w.t), before);
});

test(['AN-1'], 'a post needs a title and a message', async () => {
  const w = await world();
  const noTitle = await w.t.as(w.dirA).post(API, post({ title: '   ' }));
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.body.error, 'title');
  const noBody = await w.t.as(w.dirA).post(API, post({ body: '' }));
  assert.equal(noBody.status, 400);
  assert.equal(noBody.body.error, 'body');
  const tooLong = await w.t.as(w.dirA).post(API, post({ title: 'x'.repeat(121) }));
  assert.equal(tooLong.status, 400);
  assert.equal(countAnnouncements(w.t), 0);
});

test(['AN-1', 'NF-1'], 'staff, parents and students cannot post announcements', async () => {
  const w = await world();
  for (const u of [w.staffA, w.famA.parent, w.famA.student]) {
    const r = await w.t.as(u).post(API, post());
    assert.equal(r.status, 403, u.role);
  }
  assert.equal(countAnnouncements(w.t), 0);
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test(['AN-1', 'NF-1'], 'a director cannot post to another location, directly or through a session there', async () => {
  const w = await world();
  const sB = w.t.fx.session(w.B);
  const direct = await w.t.as(w.dirA).post(API, post({ locations: [w.B.id] }));
  assert.equal(direct.status, 403);
  const both = await w.t.as(w.dirA).post(API, post({ locations: [w.A.id, w.B.id] }));
  assert.equal(both.status, 403);
  const viaSession = await w.t.as(w.dirA).post(API, post({ audience: 'session', session_id: sB.id }));
  assert.equal(viaSession.status, 403);
  assert.equal(countAnnouncements(w.t), 0);
  // Naming their own location explicitly is fine.
  const own = await w.t.as(w.dirA).post(API, post({ locations: [w.A.id] }));
  assert.equal(own.status, 201);
  assert.ok(!notified(w.t, own.body.announcement.id).includes(w.famB.parent.id));
});

test(['AN-1', 'AN-5'], 'a wrongly typed category, title or message is refused with a 400, never a server error', async () => {
  const w = await world();
  const cases = [
    [API, post({ category: ['event'] }), 'category'],
    [API, post({ category: { toString: 1 } }), 'category'],
    [API, post({ title: { toString: 1 } }), 'title'],
    [API, post({ title: ['Fall open house'] }), 'title'],
    [API, post({ body: { toString: 1 } }), 'body'],
    [API, post({ body: true }), 'body'],
    [API + '/emergency', alert({ title: { toString: 1 } }), 'title'],
    [API + '/emergency', alert({ body: ['Leave now'] }), 'body'],
  ];
  for (const [url, b, field] of cases) {
    const r = await w.t.as(w.dirA).post(url, b);
    assert.equal(r.status, 400, url + ' ' + JSON.stringify(b));
    assert.equal(r.body.error, field, url + ' ' + JSON.stringify(b));
  }
  assert.equal(countAnnouncements(w.t), 0);
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  // A number is still fine as text.
  const n = await w.t.as(w.dirA).post(API, post({ title: 2026 }));
  assert.equal(n.status, 201);
  assert.equal(n.body.announcement.title, '2026');
});

test(['AN-1', 'AN-2', 'AN-4'], 'location and session ids must be numbers or text; anything else is refused, not coerced', async () => {
  const w = await world();
  const sA = w.t.fx.session(w.A);
  const hqBad = [[{ toString: 1 }], [[w.A.id]], [true], [w.A.id, {}]];
  for (const locations of hqBad) {
    for (const url of [API, API + '/preview']) {
      const r = await w.t.as(w.hq).post(url, post({ locations }));
      assert.equal(r.status, 400, url + ' ' + JSON.stringify(locations));
      assert.equal(r.body.error, 'locations');
    }
    const em = await w.t.as(w.hq).post(API + '/emergency', alert({ locations }));
    assert.equal(em.status, 400, 'emergency ' + JSON.stringify(locations));
  }
  // A director's own location wrapped in an array or object is not their location.
  for (const locations of [[{ toString: 1 }], [[w.A.id]], [{ toString: 1 }, w.A.id]]) {
    for (const url of [API, API + '/preview']) {
      assert.equal((await w.t.as(w.dirA).post(url, post({ locations }))).status, 403, url + ' ' + JSON.stringify(locations));
    }
    assert.equal((await w.t.as(w.dirA).post(API + '/emergency', alert({ locations }))).status, 403, JSON.stringify(locations));
  }
  for (const session_id of [{ toString: 1 }, [sA.id]]) {
    for (const url of [API, API + '/preview']) {
      const r = await w.t.as(w.dirA).post(url, post({ audience: 'session', session_id }));
      assert.equal(r.status, 400, url + ' ' + JSON.stringify(session_id));
      assert.equal(r.body.error, 'session');
    }
  }
  assert.equal(countAnnouncements(w.t), 0);
  // Ids sent as text still work.
  const hq = await w.t.as(w.hq).post(API, post({ locations: [String(w.B.id)] }));
  assert.equal(hq.status, 201);
  assert.deepEqual(notified(w.t, hq.body.announcement.id), sorted(w.famB.parent, w.famB.student));
  const viaSession = await w.t.as(w.dirA).post(API, post({ audience: 'session', session_id: String(sA.id) }));
  assert.equal(viaSession.status, 201);
  assert.equal(viaSession.body.announcement.session.id, sA.id);
});

test(['AN-1', 'AN-5'], 'a director naming their own location more than once still posts there, once', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post({ locations: [w.A.id, w.A.id] }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  assert.deepEqual(w.t.db.prepare('SELECT location_id FROM announcement_locations WHERE announcement_id = ?').all(id).map(x => x.location_id), [w.A.id]);
  assert.deepEqual(notified(w.t, id), sorted(w.famA.parent, w.famA.student, w.famA2.parent, w.famA2.student));
  const em = await w.t.as(w.dirA).post(API + '/emergency', alert({ locations: [w.A.id, String(w.A.id)] }));
  assert.equal(em.status, 201);
  assert.equal(em.body.recipients, 6);
  // Adding another location to the list is still refused, and so is an empty list.
  assert.equal((await w.t.as(w.dirA).post(API, post({ locations: [w.A.id, w.A.id, w.B.id] }))).status, 403);
  assert.equal((await w.t.as(w.dirA).post(API, post({ locations: [] }))).status, 403);
  assert.equal(countAnnouncements(w.t), 2);
});

// ---------------------------------------------------------------- AN-2

test(['AN-2'], 'HQ posts to every location at once', async () => {
  const w = await world();
  const r = await w.t.as(w.hq).post(API, post({ locations: 'all', category: 'news' }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  assert.deepEqual(w.t.db.prepare('SELECT location_id FROM announcement_locations WHERE announcement_id = ? ORDER BY location_id').all(id).map(x => x.location_id),
    [w.A.id, w.B.id].sort((x, y) => x - y));
  assert.deepEqual(notified(w.t, id), sorted(w.famA.parent, w.famA.student, w.famA2.parent, w.famA2.student, w.famB.parent, w.famB.student));
  assert.deepEqual(r.body.announcement.locations.map(l => l.name).sort(), ['Irvine', 'Toronto']);
});

test(['AN-2'], 'HQ posts to a chosen set of locations only', async () => {
  const w = await world();
  const C = w.t.fx.location({ name: 'Arcadia' });
  const famC = w.t.fx.family(C);
  const r = await w.t.as(w.hq).post(API, post({ locations: [C.id, w.B.id] }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  assert.deepEqual(notified(w.t, id), sorted(w.famB.parent, w.famB.student, famC.parent, famC.student));
  assert.deepEqual(await feedIds(w.t, w.famA.parent), []);
  assert.deepEqual(await feedIds(w.t, famC.student), [id]);
});

test(['AN-2'], 'HQ has to pick at least one real location', async () => {
  const w = await world();
  for (const locations of [undefined, [], [987654], 'some']) {
    const r = await w.t.as(w.hq).post(API, post({ locations }));
    assert.equal(r.status, 400, JSON.stringify(locations));
    assert.equal(r.body.error, 'locations');
  }
  assert.equal(countAnnouncements(w.t), 0);
});

test(['AN-2', 'AN-5'], 'HQ still reaches a location marked closed: alerts and posts, to it alone or to all locations (R5)', async () => {
  const w = await world();
  w.t.db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(w.B.id);
  const pv = await w.t.as(w.hq).post(API + '/preview', alert({ type: 'emergency', locations: [w.B.id] }));
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.deepEqual(pv.body.locations, ['Toronto']);
  assert.equal(pv.body.recipients, 4);
  const sos = await w.t.as(w.hq).post(API + '/emergency', alert({ locations: [w.B.id] }));
  assert.equal(sos.status, 201, JSON.stringify(sos.body));
  assert.deepEqual(notified(w.t, sos.body.announcement.id), sorted(w.famB.parent, w.famB.student, w.staffB, w.dirB));
  const pvAll = await w.t.as(w.hq).post(API + '/preview', alert({ type: 'emergency', locations: 'all' }));
  assert.deepEqual(pvAll.body.locations, ['Irvine', 'Toronto'], '"All locations" includes the closed one');
  const r = await w.t.as(w.hq).post(API, post({ locations: 'all', category: 'news' }));
  assert.equal(r.status, 201);
  assert.deepEqual(notified(w.t, r.body.announcement.id),
    sorted(w.famA.parent, w.famA.student, w.famA2.parent, w.famA2.student, w.famB.parent, w.famB.student));
  const unknown = await w.t.as(w.hq).post(API + '/emergency', alert({ locations: [w.B.id, 987654] }));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'locations');
});

// ---------------------------------------------------------------- AN-3

test(['AN-3'], 'publishing sends one in-app notification per recipient and keeps the post in the News feed', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post({ title: 'Pumpkin carving Friday' }));
  const id = r.body.announcement.id;
  const rows = w.t.fx.notifications(w.famA.parent);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'announcement');
  assert.equal(rows[0].ref_type, 'announcement');
  assert.equal(rows[0].ref_id, id);
  assert.equal(rows[0].priority, 'normal');
  assert.equal(rows[0].title, 'Pumpkin carving Friday');
  assert.ok(rows[0].body.startsWith('From Irvine'));
  assert.ok(rows[0].delivered_at);
  // Reading the inbox does not remove the post from News.
  await w.t.as(w.famA.parent).post('/api/notifications/read-all');
  const feed = await w.t.as(w.famA.parent).get(API + '/feed');
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.posts.map(p => p.id), [id]);
  assert.equal(feed.body.posts[0].title, 'Pumpkin carving Friday');
  assert.equal(feed.body.posts[0].unread, false);
  assert.equal(feed.body.posts[0].tz, LA);
});

test(['AN-3'], 'a post scheduled for later is held until its time, then the job sends it exactly once', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-14T15:00' }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  const due = at(LA, '2026-10-14', '15:00');
  let row = w.t.db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.publish_at, due);
  assert.equal(r.body.recipients, null);
  assert.deepEqual(notified(w.t, id), []);
  assert.deepEqual(await feedIds(w.t, w.famA.parent), []);
  // The sender sees it waiting, not as sent; staff at the location do not see it yet.
  const mine = await w.t.as(w.dirA).get(API + '/feed');
  assert.deepEqual(mine.body.scheduled.map(p => p.id), [id]);
  assert.deepEqual(mine.body.posts, []);
  assert.deepEqual(await feedIds(w.t, w.staffA), []);

  w.t.clock.set(due - 60000);
  w.t.jobs();
  assert.deepEqual(notified(w.t, id), []);

  w.t.clock.set(due);
  w.t.jobs();
  w.t.jobs();
  w.t.clock.set(due + 3600000);
  w.t.jobs();
  assert.deepEqual(notified(w.t, id), sorted(w.famA.parent, w.famA.student, w.famA2.parent, w.famA2.student));
  row = w.t.db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  assert.equal(row.status, 'published');
  assert.equal(row.published_at, due);
  assert.equal(w.t.fx.notifications(w.famA.parent)[0].created_at, due);
  assert.deepEqual(await feedIds(w.t, w.famA.parent), [id]);
  assert.deepEqual((await w.t.as(w.dirA).get(API + '/feed')).body.scheduled, []);
});

test(['AN-3'], 'a schedule time is read in the location\'s own time zone', async () => {
  const w = await world();
  const r = await w.t.as(w.dirB).post(API, post({ publish_at: '2026-10-14T18:30' }));
  assert.equal(r.status, 201);
  assert.equal(w.t.db.prepare('SELECT publish_at FROM announcements WHERE id = ?').get(r.body.announcement.id).publish_at, at(TO, '2026-10-14', '18:30'));
  assert.equal(r.body.announcement.tz, TO);
});

test(['AN-3'], 'a schedule time that has already passed is refused instead of sent', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-14T08:00' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'publish_at');
  const junk = await w.t.as(w.dirA).post(API, post({ publish_at: 'tomorrow' }));
  assert.equal(junk.status, 400);
  assert.equal(countAnnouncements(w.t), 0);
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test(['AN-3'], 'the review step refuses a schedule time that has already passed, with the same message as sending', async () => {
  const w = await world();
  const past = post({ publish_at: '2026-10-14T08:00' });
  const review = await w.t.as(w.dirA).post(API + '/preview', past);
  assert.equal(review.status, 400);
  assert.equal(review.body.error, 'publish_at');
  assert.equal(review.body.message, 'That time has already passed. Pick a later time, or send it now.');
  const send = await w.t.as(w.dirA).post(API, past);
  assert.equal(send.status, 400);
  assert.equal(review.body.message, send.body.message);
  // Read in the location's own zone: 12:30 is still ahead in Irvine (10:00 now) but past in Toronto (13:00 now).
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', post({ publish_at: '2026-10-14T12:30' }))).status, 200);
  assert.equal((await w.t.as(w.dirB).post(API + '/preview', post({ publish_at: '2026-10-14T12:30' }))).status, 400);
  const junk = await w.t.as(w.dirA).post(API + '/preview', post({ publish_at: 'tomorrow' }));
  assert.equal(junk.status, 400);
  assert.equal(junk.body.error, 'publish_at');
  // A later time, or none, reviews fine; an emergency alert has no schedule, so its review ignores one.
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', post({ publish_at: '2026-10-14T15:00' }))).status, 200);
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', post())).status, 200);
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', alert({ type: 'emergency', publish_at: '2026-10-14T08:00' }))).status, 200);
  assert.equal(countAnnouncements(w.t), 0);
});

test(['AN-3'], 'a schedule time must be a real clock time within the next year', async () => {
  const w = await world();
  const now = w.t.clock.now();
  const DAY = 24 * 3600000;
  for (const publish_at of ['2026-10-14T25:00', '2026-10-14T24:00', '2026-10-14T23:60', '2026-10-14T19:99',
    1e300, now + 366 * DAY, '2027-10-20T09:00', { toString: 1 }]) {
    const r = await w.t.as(w.dirA).post(API, post({ publish_at }));
    assert.equal(r.status, 400, JSON.stringify(publish_at));
    assert.equal(r.body.error, 'publish_at', JSON.stringify(publish_at));
  }
  assert.equal(countAnnouncements(w.t), 0);
  // The last minute of the day, and a date well inside the year, are fine.
  const late = await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-14T23:59' }));
  assert.equal(late.status, 201);
  assert.equal(w.t.db.prepare('SELECT publish_at FROM announcements WHERE id = ?').get(late.body.announcement.id).publish_at, at(LA, '2026-10-14', '23:59'));
  const nextFall = await w.t.as(w.dirA).post(API, post({ publish_at: '2027-10-01T09:00' }));
  assert.equal(nextFall.status, 201);
  assert.equal(w.t.db.prepare('SELECT publish_at FROM announcements WHERE id = ?').get(nextFall.body.announcement.id).publish_at, at(LA, '2027-10-01', '09:00'));
  const ms = await w.t.as(w.dirA).post(API, post({ publish_at: now + 300 * DAY }));
  assert.equal(ms.status, 201);
  assert.equal(w.t.db.prepare("SELECT COUNT(*) AS n FROM announcements WHERE status = 'scheduled'").get().n, 3);
});

test(['AN-3'], 'publishing a post a second time sends nothing more', async () => {
  const w = await world();
  const mod = load('src/modules/announcements/index.js');
  const r = await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-14T12:00' }));
  const id = r.body.announcement.id;
  w.t.clock.set(at(LA, '2026-10-14', '12:00'));
  const first = mod.publish(w.t.ctx, id);
  assert.equal(first.recipients, 4);
  assert.equal(mod.publish(w.t.ctx, id), null);
  assert.equal(notified(w.t, id).length, 4);
});

test(['AN-3'], 'the sender can cancel a scheduled post, and it never goes out', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-15T09:00' }));
  const id = r.body.announcement.id;
  const del = await w.t.as(w.dirA).del(API + '/' + id);
  assert.equal(del.status, 200);
  assert.equal(w.t.db.prepare('SELECT status FROM announcements WHERE id = ?').get(id).status, 'cancelled');
  w.t.clock.set(at(LA, '2026-10-15', '10:00'));
  w.t.jobs();
  assert.deepEqual(notified(w.t, id), []);
  assert.deepEqual(await feedIds(w.t, w.famA.parent), []);
  const again = await w.t.as(w.dirA).del(API + '/' + id);
  assert.equal(again.status, 409);
});

test(['AN-3'], 'a post that has already gone out cannot be cancelled', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API, post());
  const del = await w.t.as(w.dirA).del(API + '/' + r.body.announcement.id);
  assert.equal(del.status, 409);
  assert.equal(del.body.error, 'not_scheduled');
  assert.equal(w.t.db.prepare('SELECT status FROM announcements WHERE id = ?').get(r.body.announcement.id).status, 'published');
});

// ---------------------------------------------------------------- AN-4

test(['AN-4'], 'parents only reaches parents; students only reaches students', async () => {
  const w = await world();
  const p = await w.t.as(w.dirA).post(API, post({ audience: 'parents' }));
  assert.equal(p.status, 201);
  assert.deepEqual(notified(w.t, p.body.announcement.id), sorted(w.famA.parent, w.famA2.parent));
  const s = await w.t.as(w.dirA).post(API, post({ audience: 'students' }));
  assert.equal(s.status, 201);
  assert.deepEqual(notified(w.t, s.body.announcement.id), sorted(w.famA.student, w.famA2.student));
  const bad = await w.t.as(w.dirA).post(API, post({ audience: 'everyone' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'audience');
});

test(['AN-4'], 'a session audience reaches its actively enrolled students and their active parents only', async () => {
  const w = await world();
  const { t, A } = w;
  const s = t.fx.session(A, { name: 'Afternoon Study' });
  const other = t.fx.session(A, { name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const guardian2 = t.fx.user('parent', { location: A });
  t.fx.link(guardian2, w.famA.student);                         // second guardian: included
  const pendingParent = t.fx.user('parent', { location: A });
  t.fx.link(pendingParent, w.famA.student, 'pending');          // link not approved: excluded
  t.fx.enroll(w.famA.student, s, 1);
  t.fx.enroll(w.famA.student, s, 3);                            // two slots, one notification
  t.fx.enroll(w.famA2.student, s, 5, { status: 'paused' });     // paused: excluded
  const famA3 = t.fx.family(A);
  t.fx.enroll(famA3.student, s, 1, { status: 'dropped' });      // dropped: excluded
  const famA4 = t.fx.family(A);
  t.fx.enroll(famA4.student, other, 2);                         // other session: excluded
  const r = await t.as(w.dirA).post(API, post({ audience: 'session', session_id: s.id, category: 'session_offering' }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  assert.deepEqual(notified(t, id), sorted(w.famA.parent, guardian2, w.famA.student));
  assert.equal(r.body.announcement.session.id, s.id);
  assert.equal(r.body.announcement.session.term_name, 'Fall 2026', 'a sent post names its session\'s term');
  assert.deepEqual(await feedIds(t, w.famA2.parent), []);
  assert.deepEqual(await feedIds(t, famA4.student), []);
  assert.deepEqual(await feedIds(t, guardian2), [id]);
  const none = await t.as(w.dirA).post(API, post({ audience: 'session' }));
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'session');
});

test(['AN-4'], 'students whose parent has not approved them, and deactivated accounts, are left out', async () => {
  const w = await world();
  const pending = w.t.fx.family(w.A, { linked: false });
  const gone = w.t.fx.family(w.A);
  w.t.db.prepare('UPDATE users SET active = 0 WHERE id IN (?, ?)').run(gone.parent.id, gone.student.id);
  const r = await w.t.as(w.dirA).post(API, post());
  const ids = notified(w.t, r.body.announcement.id);
  assert.ok(!ids.includes(pending.student.id));
  assert.ok(!ids.includes(gone.parent.id));
  assert.ok(!ids.includes(gone.student.id));
  // The parent of the pending student is still a family at this location.
  assert.ok(ids.includes(pending.parent.id));
  assert.equal(ids.length, 5);
});

test(['AN-4', 'NF-1'], 'a parent who joins later, with no students set up yet, sees the location\'s all-families and parents-only posts', async () => {
  const w = await world();
  const { t, A } = w;
  const byId = ids => [...ids].sort((x, y) => x - y);
  const s = t.fx.session(A);
  t.fx.enroll(w.famA.student, s, 1);
  const families = (await t.as(w.dirA).post(API, post({ title: 'Open house' }))).body.announcement.id;
  const parents = (await t.as(w.dirA).post(API, post({ audience: 'parents', title: 'Parent night' }))).body.announcement.id;
  const students = (await t.as(w.dirA).post(API, post({ audience: 'students', title: 'Study jam' }))).body.announcement.id;
  const session = (await t.as(w.dirA).post(API, post({ audience: 'session', session_id: s.id }))).body.announcement.id;
  const atB = (await t.as(w.dirB).post(API, post())).body.announcement.id;
  const em = (await t.as(w.dirA).post(API + '/emergency', alert())).body.announcement.id;
  const network = (await t.as(w.hq).post(API, post({ locations: 'all', audience: 'parents', title: 'Welcome' }))).body.announcement.id;
  t.clock.advance(60000);

  // Signed up just now at Irvine: no students, no enrollment, never a recipient.
  const newParent = t.fx.user('parent', { location: A });
  const feed = (await t.as(newParent).get(API + '/feed')).body;
  assert.deepEqual(byId(feed.posts.map(p => p.id)), byId([families, parents, em, network]));
  assert.deepEqual(feed.active_emergencies.map(p => p.id), [em]);
  assert.ok(feed.posts.every(p => p.unread), 'all new to them');
  assert.ok(!feed.posts.some(p => [students, session, atB].includes(p.id)));
  const net = feed.posts.find(p => p.id === network);
  assert.deepEqual(net.locations.map(l => l.name), ['Irvine']);
  // Home's card reads the same feed.
  const home = (await t.as(newParent).get(API + '/feed?limit=10')).body;
  assert.ok(home.posts.some(p => p.id === families));
  // Seeing a post is recorded for them, but it was never sent to them: the sender's numbers stay as sent.
  const before = (await t.as(w.dirA).get(API + '/' + families + '/stats')).body;
  assert.equal((await t.as(newParent).post(API + '/' + families + '/read')).status, 200);
  assert.deepEqual((await t.as(w.dirA).get(API + '/' + families + '/stats')).body, before);
  assert.equal((await t.as(newParent).get(API + '/feed')).body.posts.find(p => p.id === families).unread, false);
  assert.equal((await t.as(newParent).post(API + '/' + students + '/read')).status, 404);

  // A student approved later sees all-families and students-only posts, not parents-only ones.
  const late = t.fx.family(A, { linked: false });
  t.db.prepare("UPDATE family_links SET status = 'active' WHERE student_id = ?").run(late.student.id);
  assert.deepEqual(byId(await feedIds(t, late.student)), byId([families, students, em]));
  // Toronto's families see none of Irvine's posts.
  const newB = t.fx.user('parent', { location: w.B });
  assert.deepEqual(byId(await feedIds(t, newB)), byId([atB, network]));
});

test(['AN-4'], 'preview says who a post would reach without sending anything', async () => {
  const w = await world();
  await w.t.as(w.famA2.parent).put(API + '/prefs', { muted: true });
  const r = await w.t.as(w.dirA).post(API + '/preview', post());
  assert.equal(r.status, 200);
  assert.deepEqual(
    { recipients: r.body.recipients, notified: r.body.notified, muted: r.body.muted, parents: r.body.parents, students: r.body.students, staff: r.body.staff, locations: r.body.locations },
    { recipients: 4, notified: 3, muted: 1, parents: 2, students: 2, staff: 0, locations: ['Irvine'] });
  const em = await w.t.as(w.dirA).post(API + '/preview', alert({ type: 'emergency' }));
  assert.equal(em.body.recipients, 6);
  assert.equal(em.body.staff, 2);
  assert.equal(em.body.muted, 0);
  assert.equal(countAnnouncements(w.t), 0);
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

// ---------------------------------------------------------------- mute + AN-5

test(['AN-3', 'AN-5'], 'muted users get no notification for announcements but still see them in News', async () => {
  const w = await world();
  const m = await w.t.as(w.famA.parent).put(API + '/prefs', { muted: true });
  assert.equal(m.status, 200);
  assert.equal((await w.t.as(w.famA.parent).get(API + '/feed')).body.muted, true);
  const r = await w.t.as(w.dirA).post(API, post());
  const id = r.body.announcement.id;
  assert.deepEqual(notified(w.t, id), sorted(w.famA.student, w.famA2.parent, w.famA2.student));
  assert.equal(r.body.recipients, 4);
  assert.equal(r.body.notified, 3);
  assert.deepEqual(await feedIds(w.t, w.famA.parent), [id]);
  // Turning notifications back on applies to the next post.
  await w.t.as(w.famA.parent).put(API + '/prefs', { muted: false });
  const r2 = await w.t.as(w.dirA).post(API, post({ title: 'Second' }));
  assert.ok(notified(w.t, r2.body.announcement.id).includes(w.famA.parent.id));
  const bad = await w.t.as(w.famA.parent).put(API + '/prefs', { muted: 'yes' });
  assert.equal(bad.status, 400);
});

test(['AN-5'], 'an emergency alert reaches everyone at the location, ignoring audience and mute', async () => {
  const w = await world();
  await w.t.as(w.famA.parent).put(API + '/prefs', { muted: true });
  await w.t.as(w.staffA).put(API + '/prefs', { muted: true });
  const r = await w.t.as(w.dirA).post(API + '/emergency', alert({ audience: 'parents' }));
  assert.equal(r.status, 201);
  const id = r.body.announcement.id;
  assert.deepEqual(notified(w.t, id), sorted(w.famA.parent, w.famA.student, w.famA2.parent, w.famA2.student, w.staffA, w.dirA));
  const n = w.t.fx.notifications(w.famA.parent, 'emergency_alert');
  assert.equal(n.length, 1);
  assert.equal(n[0].priority, 'emergency');
  assert.ok(n[0].body.startsWith('Emergency alert from Irvine'));
  const row = w.t.db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  assert.equal(row.type, 'emergency');
  assert.equal(row.audience, 'everyone');
  assert.equal(row.category, null);
  assert.equal(row.status, 'published');
  assert.equal(r.body.recipients, 6);
  assert.equal(r.body.notified, 6);
});

test(['AN-5'], 'an emergency alert goes out now, even if a schedule time is sent, and stays short', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API + '/emergency', alert({ publish_at: '2026-10-14T18:00' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.announcement.status, 'published');
  assert.equal(notified(w.t, r.body.announcement.id).length, 6);
  const long = await w.t.as(w.dirA).post(API + '/emergency', alert({ body: 'x'.repeat(301) }));
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'body');
  const ok = await w.t.as(w.dirA).post(API + '/emergency', alert({ body: 'x'.repeat(300) }));
  assert.equal(ok.status, 201);
});

test(['AN-5', 'NF-1'], 'staff and families cannot send emergency alerts, and a director only for their own location', async () => {
  const w = await world();
  for (const u of [w.staffA, w.famA.parent, w.famA.student]) {
    const r = await w.t.as(u).post(API + '/emergency', alert());
    assert.equal(r.status, 403, u.role);
  }
  const other = await w.t.as(w.dirA).post(API + '/emergency', alert({ locations: [w.B.id] }));
  assert.equal(other.status, 403);
  assert.equal(countAnnouncements(w.t), 0);
  assert.equal(w.t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test(['AN-5', 'AN-2'], 'HQ sends an emergency alert to any location it picks', async () => {
  const w = await world();
  const r = await w.t.as(w.hq).post(API + '/emergency', alert({ locations: [w.B.id] }));
  assert.equal(r.status, 201);
  assert.deepEqual(notified(w.t, r.body.announcement.id), sorted(w.famB.parent, w.famB.student, w.staffB, w.dirB));
  assert.ok(w.t.fx.notifications(w.famB.parent)[0].body.startsWith('Emergency alert from ELITE HQ'));
  const all = await w.t.as(w.hq).post(API + '/emergency', alert({ locations: 'all' }));
  assert.equal(notified(w.t, all.body.announcement.id).length, 10);
});

test(['AN-5'], 'an emergency alert is pinned for everyone at the location for a day, then drops off', async () => {
  const w = await world();
  const r = await w.t.as(w.dirA).post(API + '/emergency', alert());
  const id = r.body.announcement.id;
  await w.t.as(w.dirA).post(API, post());
  w.t.clock.advance(3600000);
  for (const u of [w.famA.parent, w.famA.student, w.staffA, w.hq]) {
    const f = await w.t.as(u).get(API + '/feed');
    assert.deepEqual(f.body.active_emergencies.map(p => p.id), [id], u.role);
    assert.equal(f.body.active_emergencies[0].type, 'emergency');
  }
  const elsewhere = await w.t.as(w.famB.parent).get(API + '/feed');
  assert.deepEqual(elsewhere.body.active_emergencies, []);
  w.t.clock.advance(24 * 3600000);
  const later = await w.t.as(w.famA.parent).get(API + '/feed');
  assert.deepEqual(later.body.active_emergencies, []);
  assert.ok(later.body.posts.some(p => p.id === id), 'the alert stays in the feed history');
});

// ---------------------------------------------------------------- AN-6

test(['AN-6'], 'the sender and HQ see delivered and read counts taken from the notifications', async () => {
  const w = await world();
  await w.t.as(w.famA2.student).put(API + '/prefs', { muted: true });
  const r = await w.t.as(w.dirA).post(API, post());
  const id = r.body.announcement.id;
  let s = await w.t.as(w.dirA).get(API + '/' + id + '/stats');
  assert.equal(s.status, 200);
  assert.deepEqual(s.body, { recipients: 4, delivered: 3, read: 0, muted: 1 });
  // Read in News, and read from the inbox: both count.
  assert.equal((await w.t.as(w.famA.parent).post(API + '/' + id + '/read')).status, 200);
  const inbox = await w.t.as(w.famA.student).get('/api/notifications');
  await w.t.as(w.famA.student).post('/api/notifications/' + inbox.body.notifications[0].id + '/read');
  await w.t.as(w.famA.parent).post(API + '/' + id + '/read'); // reading twice counts once
  s = await w.t.as(w.hq).get(API + '/' + id + '/stats');
  assert.deepEqual(s.body, { recipients: 4, delivered: 3, read: 2, muted: 1 });
  // The same numbers ride along on the sender's feed, and nobody else's.
  const mine = (await w.t.as(w.dirA).get(API + '/feed')).body.posts[0];
  assert.deepEqual(mine.stats, { recipients: 4, delivered: 3, read: 2, muted: 1 });
  const parentView = (await w.t.as(w.famA.parent).get(API + '/feed')).body.posts[0];
  assert.equal(parentView.stats, null);
  assert.equal((await w.t.as(w.staffA).get(API + '/feed')).body.posts[0].stats, null);
});

test(['AN-6'], 'a recipient with notifications off who sees the post in News counts as delivered and read', async () => {
  const w = await world();
  await w.t.as(w.famA2.parent).put(API + '/prefs', { muted: true });
  const id = (await w.t.as(w.dirA).post(API, post())).body.announcement.id;
  const stats = async () => (await w.t.as(w.dirA).get(API + '/' + id + '/stats')).body;
  assert.deepEqual(await stats(), { recipients: 4, delivered: 3, read: 0, muted: 1 });
  // News shows it to them as new, so the app records seeing it (there is no notification to mark).
  assert.equal((await w.t.as(w.famA2.parent).get(API + '/feed')).body.posts[0].unread, true);
  assert.equal((await w.t.as(w.famA2.parent).post(API + '/' + id + '/read')).status, 200);
  assert.deepEqual(await stats(), { recipients: 4, delivered: 4, read: 1, muted: 1 });
  assert.equal((await w.t.as(w.famA2.parent).get(API + '/feed')).body.posts[0].unread, false);
  assert.equal(w.t.fx.notifications(w.famA2.parent).length, 0, 'still no notification');
  // Once everyone has read it, read and delivered both reach everyone it was sent to.
  for (const u of [w.famA.parent, w.famA.student, w.famA2.student, w.famA2.parent]) await w.t.as(u).post(API + '/' + id + '/read');
  assert.deepEqual(await stats(), { recipients: 4, delivered: 4, read: 4, muted: 1 });
});

test(['AN-5', 'AN-6'], '"I have read this" on the emergency pop-up counts toward the sender\'s read number', async () => {
  const w = await world();
  const id = (await w.t.as(w.dirA).post(API + '/emergency', alert())).body.announcement.id;
  const stats = async () => (await w.t.as(w.dirA).get(API + '/' + id + '/stats')).body;
  assert.deepEqual(await stats(), { recipients: 6, delivered: 6, read: 0, muted: 0 });
  // The pop-up holds the streamed notification row; its id marks the alert read.
  const n = w.t.fx.notifications(w.famA.parent, 'emergency_alert')[0];
  assert.equal((await w.t.as(w.famA.parent).post('/api/notifications/' + n.id + '/read')).status, 200);
  assert.deepEqual(await stats(), { recipients: 6, delivered: 6, read: 1, muted: 0 });
  // Marked by the alert's own id (seen in News) counts the same way.
  assert.equal((await w.t.as(w.staffA).post(API + '/' + id + '/read')).status, 200);
  assert.deepEqual(await stats(), { recipients: 6, delivered: 6, read: 2, muted: 0 });
  // The pinned alert is no longer new for those two, and still is for everyone else.
  assert.equal((await w.t.as(w.famA.parent).get(API + '/feed')).body.active_emergencies[0].unread, false);
  assert.equal((await w.t.as(w.staffA).get(API + '/feed')).body.active_emergencies[0].unread, false);
  assert.equal((await w.t.as(w.famA2.parent).get(API + '/feed')).body.active_emergencies[0].unread, true);
});

test(['AN-6', 'NF-1'], 'only the sender or HQ can see delivery numbers', async () => {
  const w = await world();
  const dirA2 = w.t.fx.director(w.A);
  const r = await w.t.as(w.dirA).post(API, post());
  const id = r.body.announcement.id;
  for (const u of [w.dirB, dirA2, w.staffA, w.famA.parent, w.famA.student]) {
    const s = await w.t.as(u).get(API + '/' + id + '/stats');
    assert.equal(s.status, 403, u.role);
  }
  assert.equal((await w.t.as(w.hq).get(API + '/' + id + '/stats')).status, 200);
  assert.equal((await w.t.as(w.dirA).get(API + '/987654/stats')).status, 404);
});

// ---------------------------------------------------------------- NF-1

test(['NF-1'], 'a family member\'s feed holds only the posts sent to them', async () => {
  const w = await world();
  const { t, A } = w;
  const s = t.fx.session(A);
  t.fx.enroll(w.famA.student, s, 1);
  const toParents = (await t.as(w.dirA).post(API, post({ audience: 'parents' }))).body.announcement.id;
  const toSession = (await t.as(w.dirA).post(API, post({ audience: 'session', session_id: s.id }))).body.announcement.id;
  const atB = (await t.as(w.dirB).post(API, post())).body.announcement.id;
  assert.deepEqual((await feedIds(t, w.famA.parent)).sort(), [toParents, toSession].sort());
  assert.deepEqual(await feedIds(t, w.famA.student), [toSession]);
  assert.deepEqual(await feedIds(t, w.famA2.parent), [toParents]);
  assert.deepEqual(await feedIds(t, w.famA2.student), []);
  assert.deepEqual(await feedIds(t, w.famB.parent), [atB]);
  // Signed out: nothing at all.
  assert.equal((await t.anon.get(API + '/feed')).status, 401);
});

test(['NF-1'], 'staff and directors see their own location\'s posts, never another location\'s; HQ sees all', async () => {
  const w = await world();
  const a = (await w.t.as(w.dirA).post(API, post({ audience: 'parents' }))).body.announcement.id;
  const b = (await w.t.as(w.dirB).post(API, post())).body.announcement.id;
  assert.deepEqual(await feedIds(w.t, w.staffA), [a]);
  assert.deepEqual(await feedIds(w.t, w.dirA), [a]);
  assert.deepEqual(await feedIds(w.t, w.staffB), [b]);
  assert.deepEqual((await feedIds(w.t, w.hq)).sort(), [a, b].sort());
});

test(['NF-1'], 'a network post shows a location only its own name', async () => {
  const w = await world();
  const id = (await w.t.as(w.hq).post(API, post({ locations: 'all' }))).body.announcement.id;
  const fa = (await w.t.as(w.famA.parent).get(API + '/feed')).body.posts.find(p => p.id === id);
  assert.deepEqual(fa.locations.map(l => l.name), ['Irvine']);
  const sb = (await w.t.as(w.staffB).get(API + '/feed')).body.posts.find(p => p.id === id);
  assert.deepEqual(sb.locations.map(l => l.name), ['Toronto']);
  assert.equal(sb.tz, TO);
  const h = (await w.t.as(w.hq).get(API + '/feed')).body.posts.find(p => p.id === id);
  assert.equal(h.locations.length, 2);
});

test(['NF-1'], 'a director sees only their own scheduled posts; HQ sees every one', async () => {
  const w = await world();
  const a = (await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-15T09:00' }))).body.announcement.id;
  const b = (await w.t.as(w.dirB).post(API, post({ publish_at: '2026-10-15T09:00' }))).body.announcement.id;
  assert.deepEqual((await w.t.as(w.dirA).get(API + '/feed')).body.scheduled.map(p => p.id), [a]);
  assert.deepEqual((await w.t.as(w.dirB).get(API + '/feed')).body.scheduled.map(p => p.id), [b]);
  assert.deepEqual((await w.t.as(w.staffA).get(API + '/feed')).body.scheduled, []);
  assert.deepEqual((await w.t.as(w.famA.parent).get(API + '/feed')).body.scheduled, []);
  assert.equal((await w.t.as(w.hq).get(API + '/feed')).body.scheduled.length, 2);
});

test(['NF-1'], 'only the sender or HQ can cancel a scheduled post', async () => {
  const w = await world();
  const dirA2 = w.t.fx.director(w.A);
  const id = (await w.t.as(w.dirA).post(API, post({ publish_at: '2026-10-15T09:00' }))).body.announcement.id;
  for (const u of [w.dirB, dirA2, w.staffA, w.famA.parent]) {
    const r = await w.t.as(u).del(API + '/' + id);
    assert.equal(r.status, 403, u.role);
  }
  assert.equal(w.t.db.prepare('SELECT status FROM announcements WHERE id = ?').get(id).status, 'scheduled');
  assert.equal((await w.t.as(w.hq).del(API + '/' + id)).status, 200);
  assert.equal(w.t.db.prepare('SELECT status FROM announcements WHERE id = ?').get(id).status, 'cancelled');
});

test(['NF-1'], 'compose options list only the director\'s own sessions; staff and families are refused', async () => {
  const w = await world();
  const sA = w.t.fx.session(w.A, { name: 'Afternoon Study' });
  const sB = w.t.fx.session(w.B, { name: 'Morning Focus' });
  w.t.fx.enroll(w.famA.student, sA, 1);
  w.t.fx.enroll(w.famA.student, sA, 3);
  w.t.fx.enroll(w.famA2.student, sA, 5);
  const a = await w.t.as(w.dirA).get(API + '/options');
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.sessions.map(s => s.id), [sA.id]);
  assert.equal(a.body.sessions[0].enrolled, 2);
  assert.deepEqual(Object.keys(a.body.categories), ['event', 'workshop', 'holiday', 'session_offering', 'news']);
  const h = await w.t.as(w.hq).get(API + '/options');
  assert.deepEqual(h.body.sessions.map(s => s.id).sort(), [sA.id, sB.id].sort());
  for (const u of [w.staffA, w.famA.parent, w.famA.student]) {
    assert.equal((await w.t.as(u).get(API + '/options')).status, 403, u.role);
  }
});

test(['AN-4'], 'the session picker lists sessions of current and upcoming terms only, each with its term', async () => {
  const w = await world();
  const { t } = w;
  const spring26 = t.fx.term(w.A, { name: 'Spring 2026', start: '2026-01-05', end: '2026-05-29' });
  const fall26 = t.fx.term(w.A, { name: 'Fall 2026' });
  const spring27 = t.fx.term(w.A, { name: 'Spring 2027', start: '2027-01-04', end: '2027-05-28' });
  const [old, now, next] = [spring26, fall26, spring27].map(term => t.fx.session(w.A, { term, name: 'Afternoon Study', weekdays: '1,3' }));
  const a = await t.as(w.dirA).get(API + '/options');
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.sessions.map(s => s.id), [now.id, next.id], 'the ended Spring 2026 session is left out');
  assert.deepEqual(a.body.sessions.map(s => s.term_name), ['Fall 2026', 'Spring 2027']);
  assert.ok(!a.body.sessions.some(s => s.id === old.id));

  // A term is over once the location's own date passes its end: at 10 pm Oct 14 in
  // Irvine it is already Oct 15 in Toronto.
  const endsA = t.fx.session(w.A, { term: t.fx.term(w.A, { name: 'Short term', start: '2026-09-01', end: '2026-10-14' }), name: 'Last day A' });
  const endsB = t.fx.session(w.B, { term: t.fx.term(w.B, { name: 'Short term', start: '2026-09-01', end: '2026-10-14' }), name: 'Last day B' });
  t.clock.set(at(LA, '2026-10-14', '22:00'));
  const ids = (await t.as(w.hq).get(API + '/options')).body.sessions.map(s => s.id);
  assert.ok(ids.includes(endsA.id), 'Irvine\'s term ends today there, so it is still listed');
  assert.ok(!ids.includes(endsB.id), 'Toronto\'s term ended yesterday there');
});

test(['NF-1'], 'preview is refused for staff and families, and for another location\'s audience', async () => {
  const w = await world();
  const sB = w.t.fx.session(w.B);
  for (const u of [w.staffA, w.famA.parent, w.famA.student]) {
    assert.equal((await w.t.as(u).post(API + '/preview', post())).status, 403, u.role);
  }
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', post({ locations: [w.B.id] }))).status, 403);
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', post({ audience: 'session', session_id: sB.id }))).status, 403);
  assert.equal((await w.t.as(w.dirA).post(API + '/preview', alert({ type: 'emergency', locations: [w.B.id] }))).status, 403);
  const hq = await w.t.as(w.hq).post(API + '/preview', post({ audience: 'session', session_id: sB.id }));
  assert.equal(hq.status, 200);
  assert.deepEqual(hq.body.locations, ['Toronto']);
});

test(['NF-1'], 'marking a post read works only for posts you were sent', async () => {
  const w = await world();
  const id = (await w.t.as(w.dirA).post(API, post({ audience: 'parents' }))).body.announcement.id;
  for (const u of [w.famB.parent, w.famA.student, w.staffB]) {
    const r = await w.t.as(u).post(API + '/' + id + '/read');
    assert.equal(r.status, 404, u.role);
  }
  assert.equal(w.t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE ref_id = ? AND read_at IS NOT NULL").get(id).n, 0);
  const ok = await w.t.as(w.famA.parent).post(API + '/' + id + '/read');
  assert.equal(ok.status, 200);
  assert.ok(w.t.fx.notifications(w.famA.parent)[0].read_at);
  assert.equal(w.t.fx.notifications(w.famA2.parent)[0].read_at, null);
});

test(['NF-1'], 'the mute setting is per person and needs a signed-in user', async () => {
  const w = await world();
  assert.equal((await w.t.anon.put(API + '/prefs', { muted: true })).status, 401);
  await w.t.as(w.famA.parent).put(API + '/prefs', { muted: true });
  assert.deepEqual(w.t.db.prepare('SELECT user_id, muted FROM announcement_prefs').all().map(r => [r.user_id, r.muted]), [[w.famA.parent.id, 1]]);
  assert.equal((await w.t.as(w.famA2.parent).get(API + '/feed')).body.muted, false);
});

test(['NF-1'], 'every route refuses a signed-out caller', async () => {
  const w = await world();
  const routes = [['get', '/feed'], ['get', '/options'], ['post', '/preview'], ['post', ''], ['post', '/emergency'],
    ['del', '/1'], ['get', '/1/stats'], ['post', '/1/read'], ['put', '/prefs']];
  for (const [m, p] of routes) {
    const r = await w.t.anon[m](API + p, ...(m === 'get' || m === 'del' ? [] : [{}]));
    assert.equal(r.status, 401, m + ' ' + p);
  }
});

// ---------------------------------------------------------------- who looks after a scheduled post (L42, L58, L43)

const statusOf = (t, id) => t.db.prepare('SELECT status FROM announcements WHERE id = ?').get(id).status;
const scheduledIds = async (t, u) => (await t.as(u).get(API + '/feed')).body.scheduled.map(p => p.id);

test(['AN-3', 'NF-1'], 'a director moved to another location hands their scheduled post to the old location\'s director, shown with its location and zone', async () => {
  const w = await world();
  const { t } = w;
  const id = (await t.as(w.dirB).post(API, post({ publish_at: '2026-10-20T09:00' }))).body.announcement.id;
  const dirB2 = t.fx.director(w.B);
  // While its sender is still Toronto's director, it stays theirs alone.
  assert.deepEqual(await scheduledIds(t, dirB2), []);
  assert.equal((await t.as(dirB2).del(API + '/' + id)).status, 403);
  // HQ makes the sender director of Irvine.
  t.db.prepare('UPDATE users SET location_id = ? WHERE id = ?').run(w.A.id, w.dirB.id);
  assert.deepEqual(await scheduledIds(t, w.dirB), [], 'it no longer shows on their new location\'s News');
  assert.equal((await t.as(w.dirB).del(API + '/' + id)).status, 403);
  assert.equal((await t.as(w.dirB).get(API + '/' + id + '/stats')).status, 403);
  assert.deepEqual(await scheduledIds(t, w.dirA), [], 'nor on the new location director\'s');
  const [card] = (await t.as(dirB2).get(API + '/feed')).body.scheduled;
  assert.equal(card.id, id, 'Toronto\'s director now looks after it');
  assert.deepEqual([card.zone_name, card.tz, card.locations.map(l => l.name)], ['Toronto', TO, ['Toronto']]);
  assert.ok(card.stats, 'with its numbers');
  assert.equal((await t.as(dirB2).get(API + '/' + id + '/stats')).status, 200);
  assert.equal((await t.as(dirB2).del(API + '/' + id)).status, 200);
  assert.equal(statusOf(t, id), 'cancelled');
});

test(['AN-3', 'NF-1'], 'a director who is deactivated or made staff hands their scheduled post to the location\'s director, and it goes out under the location\'s name', async () => {
  const w = await world();
  const { t } = w;
  const before = (await t.as(w.dirA).post(API, post({ title: 'Sent before' }))).body.announcement.id;
  const later = (await t.as(w.dirA).post(API, post({ title: 'Later', publish_at: '2026-10-15T09:00' }))).body.announcement.id;
  const dirA2 = t.fx.director(w.A);
  // Made staff: no longer a director, so the post passes on.
  t.db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(w.dirA.id);
  assert.deepEqual(await scheduledIds(t, dirA2), [later]);
  t.db.prepare("UPDATE users SET role = 'director', active = 0 WHERE id = ?").run(w.dirA.id);
  assert.deepEqual(await scheduledIds(t, dirA2), [later], 'deactivated: it passes on too');
  assert.equal((await t.as(dirA2).get(API + '/' + later + '/stats')).status, 200);
  for (const u of [w.dirB, w.staffA]) assert.equal((await t.as(u).del(API + '/' + later)).status, 403, 'not another location\'s director or staff');
  assert.deepEqual(await scheduledIds(t, w.dirB), []);

  t.clock.set(at(LA, '2026-10-15', '09:01'));
  t.jobs();
  assert.equal(statusOf(t, later), 'published');
  const posts = (await t.as(w.famA.parent).get(API + '/feed')).body.posts;
  const sentLater = posts.find(p => p.id === later), sentBefore = posts.find(p => p.id === before);
  assert.deepEqual(sentLater.sender, { name: null, role: 'director' }, 'no departed director\'s name on it');
  assert.deepEqual(sentLater.locations.map(l => l.name), ['Irvine']);
  assert.equal(sentBefore.sender.name, w.dirA.name, 'a post sent while they were director keeps their name');
});

test(['AN-2', 'NF-1'], 'HQ\'s scheduled posts stay with HQ when the HQ account that made them is deactivated', async () => {
  const w = await world();
  const { t } = w;
  const hq2 = t.fx.hq();
  const id = (await t.as(w.hq).post(API, post({ locations: [w.A.id], publish_at: '2026-10-20T09:00' }))).body.announcement.id;
  t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(w.hq.id);
  assert.deepEqual(await scheduledIds(t, w.dirA), []);
  assert.equal((await t.as(w.dirA).del(API + '/' + id)).status, 403);
  assert.deepEqual(await scheduledIds(t, hq2), [id]);
  t.clock.set(at(LA, '2026-10-20', '09:00'));
  t.jobs();
  const sent = (await t.as(w.famA.parent).get(API + '/feed')).body.posts.find(p => p.id === id);
  assert.equal(sent.sender.role, 'hq');
});

test(['AN-2', 'AN-3'], 'an HQ post scheduled for several locations shows its time in the zone it was entered in, naming that location', async () => {
  const w = await world();
  const { t } = w;
  // Calgary has a higher id than Toronto but sorts first by name.
  const C = t.fx.location({ name: 'Calgary', timezone: 'America/Edmonton' });
  const r = await t.as(w.hq).post(API, post({ locations: [C.id, w.B.id], publish_at: '2026-10-20T09:00' }));
  assert.equal(r.status, 201);
  const due = at(TO, '2026-10-20', '09:00');
  for (const card of [r.body.announcement, (await t.as(w.hq).get(API + '/feed')).body.scheduled[0]]) {
    assert.equal(card.publish_at, due);
    assert.deepEqual([card.zone_name, card.tz], ['Toronto', TO]);
    assert.deepEqual(card.locations.map(l => l.name), ['Calgary', 'Toronto']);
  }
  // Once sent, each family sees its own location's zone as before.
  t.clock.set(due);
  t.jobs();
  const sent = (await t.as(w.hq).get(API + '/feed')).body.posts[0];
  assert.equal(sent.zone_name, null);
});

test(['AN-3', 'AN-4', 'NF-1'], 'the feed names every location a parent hears from: their home and each linked student\'s', async () => {
  const w = await world();
  const { t } = w;
  t.fx.link(w.famA.parent, w.famB.student);
  const mine = async u => (await t.as(u).get(API + '/feed')).body.my_locations;
  assert.deepEqual(await mine(w.famA.parent), ['Irvine', 'Toronto']);
  assert.deepEqual(await mine(w.famA2.parent), ['Irvine']);
  assert.deepEqual(await mine(w.famB.student), ['Toronto']);
  assert.deepEqual(await mine(w.staffB), ['Toronto']);
  assert.equal(await mine(w.hq), null);
});

// ---------------------------------------------------------------- the emergency pop-up in a browser tab

// Just enough DOM for public/js/app.js and the announcements view. Elements live
// in one tree under <html>; focus, events (which bubble), isConnected and a
// MutationObserver on <body> work as in a browser, and a removed element loses
// focus to <body>.
class El {
  constructor(doc, tag, data = '') { Object.assign(this, { doc, tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get nodeType() { return this.tag ? 1 : 3; }
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
  // A control that becomes disabled loses focus to <body>, as in a browser.
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = !!v; if (v && this.doc.focused === this) this.doc.focused = null; }
  adopt(kids) {
    const ns = kids.map(k => { const n = k instanceof El ? k : new El(this.doc, null, String(k)); n.remove(); n.parentNode = this; return n; });
    this.doc.changed(this, ns, []);
    return ns;
  }
  append(...kids) { this.childNodes.push(...this.adopt(kids)); }
  appendChild(k) { this.append(k); return k; }
  prepend(...kids) { this.childNodes.unshift(...this.adopt(kids)); }
  after(...kids) { const p = this.parentNode, ns = p.adopt(kids); p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, ...ns); }
  replaceChildren(...kids) {
    const old = this.childNodes;
    old.forEach(c => { c.parentNode = null; });
    this.childNodes = [];
    this.doc.changed(this, [], old);
    this.append(...kids);
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes = p.childNodes.filter(c => c !== this);
    this.parentNode = null;
    this.doc.changed(p, [], [this]);
  }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  all() { return this.childNodes.flatMap(c => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
  // One compound selector: tag, #id, .class, [attr] and [attr="value"] parts.
  matches(sel) {
    return !!this.tag && (sel.match(/\[[^\]]+\]|[#.]?[\w-]+/g) || []).every(p => {
      if (p[0] === '#') return this.id === p.slice(1);
      if (p[0] === '.') return this.cls.includes(p.slice(1));
      if (p[0] === '[') { const [, k, v] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p); return v === undefined ? this.attrs.has(k) : this.getAttribute(k) === v; }
      return this.tag === p;
    });
  }
  // Descendant selectors made of compound parts: '#main h1', 'button'.
  querySelector(sel) {
    const parts = sel.trim().split(/\s+/);
    const walk = (root, i) => {
      for (const n of root.all()) {
        if (!n.matches(parts[i])) continue;
        const got = i === parts.length - 1 ? n : walk(n, i + 1);
        if (got) return got;
      }
      return null;
    };
    return walk(this, 0);
  }
}

// One browser tab running the real shell and announcements view (read from ROOT,
// so the mutation runner's copy is the one exercised) against the test server.
function alertTab(t, hash = '') {
  let cookie = '';
  const pending = new Set(), streams = [], observers = [];
  const track = p => { pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };
  const doc = { title: '', hidden: false, on: {}, addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); },
    // Child list changes reach observers a moment later, as in a browser.
    changed(target, addedNodes, removedNodes) {
      for (const o of observers) if (o.target === target) track(Promise.resolve().then(() => o.cb([{ addedNodes, removedNodes }])));
    } };
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
    querySelector: sel => doc.documentElement.querySelector(sel),
  });
  Object.defineProperty(doc, 'activeElement', { get: () => (doc.focused && doc.focused.isConnected ? doc.focused : doc.body) });
  const winOn = {};
  const fire = type => (winOn[type] || []).forEach(fn => fn({ type }));
  const location = {
    _hash: hash,
    get hash() { return this._hash; },
    set hash(v) { this._hash = v ? (String(v).startsWith('#') ? String(v) : '#' + v) : ''; track(new Promise(r => setImmediate(() => { fire('hashchange'); r(); }))); },
  };
  class EventSource { constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; } }
  class MutationObserver { constructor(cb) { this.cb = cb; } observe(target) { observers.push({ target, cb: this.cb }); } }
  const fetchAs = (url, opts = {}) => track(fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
    .then(async r => new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers })));
  const win = { document: doc, Node: El, fetch: fetchAs, Response, URL, console, navigator: {}, location, EventSource, MutationObserver,
    history: { replaceState(_s, _t, url) { location._hash = String(url).replace(/^[^#]*/, ''); } },
    addEventListener(type, fn) { (winOn[type] = winOn[type] || []).push(fn); },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/announcements.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  // Waits until every request has answered and the page has drawn what came back.
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    App: win.App, doc, settle,
    main: () => doc.getElementById('main'),
    signIn(user) { const token = crypto.randomBytes(16).toString('hex'); t.ctx.sessions.set(token, user.id); cookie = 'sid=' + token; },
    async start() { win.App.start(); await settle(); },
    async go(to) { location.hash = to; await settle(); },
    // Notifications stream in, as the server pushes them to an open app.
    async arrive(...rows) { for (const n of rows) streams.at(-1).onmessage({ data: JSON.stringify(n) }); await settle(); },
    popups: () => doc.body.childNodes.filter(n => n.tag && n.getAttribute('role') === 'alertdialog'),
  };
}
const bellOf = tab => {
  const b = tab.doc.getElementById('bell'), c = b.find(n => n.cls.includes('bell-count'));
  return { label: b.getAttribute('aria-label'), count: c.hidden ? 0 : Number(c.textContent) };
};
const readButton = popup => popup.find(n => n.tag === 'button' && n.textContent === 'I have read this');
const readAt = (t, n) => t.db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(n.id).read_at;

test(['AN-5', 'AN-6'], '"I have read this" marks exactly the alert on that pop-up read when two alerts share a title, and the bell drops right away', async () => {
  const w = await world();
  const { t } = w;
  const parent = w.famA.parent;
  const tab = alertTab(t);
  tab.signIn(parent);
  await tab.start();
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 0 unread', count: 0 });
  const navLink = tab.doc.getElementById('nav').find(n => n.tag === 'a' && n.getAttribute('href') === '#/news');
  navLink.focus();

  // Two alerts with the same title, ten minutes apart; both pop up.
  const older = (await t.as(w.dirA).post(API + '/emergency', alert())).body.announcement.id;
  t.clock.set(t.clock.now() + 10 * 60e3);
  const newer = (await t.as(w.dirA).post(API + '/emergency', alert())).body.announcement.id;
  const [nOld, nNew] = t.fx.notifications(parent, 'emergency_alert');
  assert.deepEqual([nOld.ref_id, nNew.ref_id], [older, newer]);
  await tab.arrive(nOld, nNew);
  const [first, second] = tab.popups();
  assert.equal(tab.popups().length, 2);
  assert.deepEqual([first, second].map(p => p.find(n => n.tag === 'h3').textContent), ['Power outage', 'Power outage']);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 2 unread', count: 2 });
  assert.equal(tab.doc.activeElement, readButton(second), 'the newest pop-up has focus');

  // Acknowledging the older pop-up marks the older alert read, and only it.
  readButton(first).click();
  await tab.settle();
  assert.deepEqual(tab.popups(), [second]);
  assert.ok(readAt(t, nOld), 'the older alert is read');
  assert.equal(readAt(t, nNew), null, 'the newer alert with the same title is still unread');
  const reads = async id => (await t.as(w.dirA).get(API + '/' + id + '/stats')).body.read;
  assert.deepEqual([await reads(older), await reads(newer)], [1, 0]);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 1 unread', count: 1 }, 'the bell drops without a reload');
  assert.equal(tab.doc.activeElement, navLink, 'focus goes back to what had it before that pop-up opened');

  // The newer one: what had focus before it (the older pop-up's button) is gone, so focus goes to the page heading.
  readButton(second).click();
  await tab.settle();
  assert.deepEqual(tab.popups(), []);
  assert.ok(readAt(t, nNew));
  assert.deepEqual([await reads(older), await reads(newer)], [1, 1]);
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 0 unread', count: 0 });
  const focused = tab.doc.activeElement;
  assert.equal(focused.tag, 'h1');
  assert.ok(focused.isConnected && tab.main().contains(focused));
  assert.equal(focused.getAttribute('tabindex'), '-1', 'the heading can take focus');
});

test(['AN-5', 'NF-7'], 'on News, closing the pop-up puts focus on the page heading when the control that had it was redrawn, and it stays there', async () => {
  const w = await world();
  const { t } = w;
  const tab = alertTab(t, '#/news');
  tab.signIn(w.famA.parent);
  await tab.start();
  const box = tab.doc.getElementById('ann-notify');
  assert.ok(box, 'the notification setting is on News');
  box.focus();
  await t.as(w.dirA).post(API + '/emergency', alert());
  await tab.arrive(t.fx.notifications(w.famA.parent, 'emergency_alert')[0]);
  assert.equal(box.isConnected, false, 'the alert arriving redrew News');
  readButton(tab.popups()[0]).click();
  await tab.settle();
  const focused = tab.doc.activeElement;
  assert.equal(focused.tag, 'h1');
  assert.equal(focused.textContent, 'News');
  assert.ok(focused.isConnected, 'focus is on the heading News shows now, not lost to the top of the page');
  assert.equal(focused.getAttribute('tabindex'), '-1', 'the heading can take focus');
});

test(['AN-6'], 'opening News marks its new posts read and the bell drops right away, without a reload', async () => {
  const w = await world();
  const { t } = w;
  await t.as(w.dirA).post(API, post());
  const tab = alertTab(t);
  tab.signIn(w.famA.parent);
  await tab.start();
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 1 unread', count: 1 });
  await tab.go('#/news');
  assert.ok(t.fx.notifications(w.famA.parent, 'announcement')[0].read_at, 'seeing it in News marks it read');
  assert.deepEqual(bellOf(tab), { label: 'Inbox, 0 unread', count: 0 });
});

// ---------------------------------------------------------------- the compose screen in a browser tab

const optionTexts = sel => sel.findAll(n => n.tag === 'option' && n.getAttribute('value')).map(n => n.textContent);

test(['AN-4'], 'the compose session picker tells same-named sessions apart by term and leaves out ended terms', async () => {
  const w = await world();
  const { t } = w;
  for (const [name, start, end] of [['Spring 2026', '2026-01-05', '2026-05-29'], ['Fall 2026', '2026-08-17', '2026-12-18'], ['Spring 2027', '2027-01-04', '2027-05-28']]) {
    t.fx.session(w.A, { term: t.fx.term(w.A, { name, start, end }), name: 'Afternoon Study', weekdays: '1,3' });
  }
  const tab = alertTab(t);
  tab.signIn(w.dirA);
  await tab.start();
  await tab.go('#/news/new');
  assert.deepEqual(optionTexts(tab.doc.getElementById('ann-session')), [
    'Afternoon Study · Mon/Wed 1pm–4pm · Fall 2026 · 0 students enrolled',
    'Afternoon Study · Mon/Wed 1pm–4pm · Spring 2027 · 0 students enrolled']);
});

test(['AN-2', 'AN-5'], 'HQ\'s alert screen lists a closed location, marked closed, and counts it in "All locations" (R5)', async () => {
  const w = await world();
  const { t } = w;
  t.db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(w.B.id);
  const tab = alertTab(t);
  tab.signIn(w.hq);
  await tab.start();
  await tab.go('#/news/emergency');
  const labels = tab.main().findAll(n => n.tag === 'label' && n.cls.includes('check')).map(n => n.textContent);
  assert.ok(labels.includes('All locations (2)'), JSON.stringify(labels));
  assert.ok(labels.includes('Toronto (closed)'), JSON.stringify(labels));
  assert.ok(labels.includes('Irvine'), JSON.stringify(labels));
});

test(['AN-2'], 'HQ\'s composer lists locations by name, as on Locations, and still names the zone the server times a post by (fix list 10)', async () => {
  const w = await world();
  const { t } = w;
  // Added last, so by id it would come last; by name it comes first.
  t.fx.location({ name: 'Anaheim' });
  const tab = alertTab(t);
  tab.signIn(w.hq);
  await tab.start();
  await tab.go('#/news/new');
  const main = tab.main();
  const fieldset = main.find(n => n.tag === 'fieldset' && n.find(c => c.tag === 'legend' && c.textContent === 'Which locations?'));
  const names = fieldset.findAll(n => n.tag === 'label' && n.find(c => c.tag === 'input' && c.getAttribute('type') === 'checkbox')).map(textOf);
  assert.deepEqual(names, ['Anaheim', 'Irvine', 'Toronto']);
  // A schedule time is read at the post's lowest-numbered location (parsePublishAt), so the hint names Irvine.
  main.find(n => n.tag === 'input' && n.getAttribute('name') === 'ann-when' && n.getAttribute('value') === 'later').checked = true;
  main.find(n => n.tag === 'form').dispatch('change');
  assert.ok(tab.doc.getElementById('ann-at-hint').textContent.startsWith('Irvine time ('), tab.doc.getElementById('ann-at-hint').textContent);
});

// ---------------------------------------------------------------- the review step, News and Home as each viewer sees them

const textOf = n => n.textContent;
const articles = root => root.findAll(n => n.tag === 'article');
// Fills the compose form and asks for the review step.
async function review(tab, { title = 'Fall open house', body = 'Come see the new study rooms on Friday.', allLocations = false } = {}) {
  const main = tab.main();
  if (allLocations) main.find(n => n.tag === 'input' && n.getAttribute('name') === 'ann-locmode' && n.getAttribute('value') === 'all').checked = true;
  tab.doc.getElementById('ann-title').value = title;
  tab.doc.getElementById('ann-body').value = body;
  main.find(n => n.tag === 'form').dispatch('submit');
  await tab.settle();
  return main.find(n => n.tag === 'section' && n.getAttribute('aria-labelledby') === 'ann-review-h');
}

test(['AN-1', 'AN-4'], 'the review step shows the post as families get it: their front desk, and no staff-only "Sent to" line', async () => {
  const w = await world();
  const { t } = w;
  t.db.prepare("UPDATE locations SET address = '1 Main St' WHERE id = ?").run(w.A.id);
  const tab = alertTab(t);
  tab.signIn(w.dirA);
  await tab.start();
  await tab.go('#/news/new');
  const box = await review(tab);
  assert.ok(box && !box.hidden, 'the review step is on screen');
  assert.ok(box.find(n => n.tag === 'h3' && n.textContent === 'What families will see'));
  const [card] = articles(box);
  assert.ok(textOf(card).includes('Questions? Ask the Irvine front desk at 1 Main St.'), textOf(card));
  assert.ok(!textOf(card).includes('Sent to'), textOf(card));
  assert.ok(textOf(card).includes(w.dirA.name + ', Irvine · Just now'), textOf(card));
});

test(['AN-2', 'AN-5'], 'HQ\'s alert review for several locations shows one location\'s family copy, not HQ\'s own view', async () => {
  const w = await world();
  const { t } = w;
  const tab = alertTab(t);
  tab.signIn(w.hq);
  await tab.start();
  await tab.go('#/news/emergency');
  const box = await review(tab, { title: 'Power outage', body: 'Head home safely.', allLocations: true });
  const [card] = articles(box);
  assert.ok(textOf(card).includes('ELITE HQ, Irvine · Just now'), textOf(card));
  assert.ok(!textOf(card).includes('2 locations'), textOf(card));
  assert.ok(textOf(card).includes('Questions? Ask the Irvine front desk.'), textOf(card));
  assert.ok(!textOf(card).includes('Sent to everyone'), textOf(card));
  assert.ok(textOf(box).includes('As families at Irvine see it.'), textOf(box));
});

test(['AN-5'], 'an alert HQ sent to several locations names them on News for HQ, and counts them for a location\'s staff', async () => {
  const w = await world();
  const { t } = w;
  await t.as(w.hq).post(API + '/emergency', alert({ locations: [w.A.id, w.B.id] }));
  await t.as(w.dirA).post(API + '/emergency', alert({ title: 'Fire drill' }));
  const lines = async u => {
    const tab = alertTab(t, '#/news');
    tab.signIn(u);
    await tab.start();
    return tab.main().findAll(n => n.tag === 'p' && n.textContent.startsWith('Sent to everyone')).map(textOf);
  };
  assert.deepEqual(await lines(w.hq), ['Sent to everyone at the location. Nobody can mute emergency alerts.',
    'Sent to everyone at Irvine and Toronto. Nobody can mute emergency alerts.']);
  assert.deepEqual(await lines(w.staffA), ['Sent to everyone at the location. Nobody can mute emergency alerts.',
    'Sent to everyone at 2 locations. Nobody can mute emergency alerts.']);
});

test(['AN-6', 'NF-7'], '"Refresh numbers" updates a post\'s numbers and keeps focus on that post\'s Refresh button (fix list 17)', async () => {
  const w = await world();
  const { t } = w;
  const id = (await t.as(w.dirA).post(API, post())).body.announcement.id;
  await t.as(w.dirA).post(API, post({ title: 'Book swap' }));
  const tab = alertTab(t, '#/news');
  tab.signIn(w.dirA);
  await tab.start();
  const refresh = () => tab.main().find(n => n.tag === 'button' && n.getAttribute('aria-label') === 'Refresh numbers for Fall open house');
  const readCount = () => {
    const box = refresh().parentNode;
    const cell = box.childNodes.find(n => n.tag === 'div' && n.textContent.endsWith('Read'));
    return cell.childNodes[0].textContent;
  };
  assert.equal(readCount(), '0');
  await t.as(w.famA.parent).post(API + '/' + id + '/read');
  refresh().focus();
  refresh().click();
  await tab.settle();
  assert.equal(readCount(), '1', 'the numbers are fresh');
  const focused = tab.doc.activeElement;
  assert.ok(focused.isConnected, 'focus did not drop to the top of the page');
  assert.equal(focused, refresh(), 'focus is on that post\'s Refresh button');
});

test(['AN-5'], 'Home\'s "Hide from Home" button has an accessible name that starts with its visible words', async () => {
  const w = await world();
  const { t } = w;
  await t.as(w.dirA).post(API + '/emergency', alert());
  const tab = alertTab(t);
  tab.signIn(w.famA.parent);
  await tab.start();
  const btn = tab.main().find(n => n.tag === 'button' && n.textContent === 'Hide from Home');
  assert.ok(btn, 'the alert is pinned on Home');
  assert.equal(btn.getAttribute('aria-label'), 'Hide from Home: Power outage');
});

test(['AN-2', 'AN-3'], 'News shows an HQ scheduled post at the time HQ entered, naming the zone it was entered in', async () => {
  const w = await world();
  const { t } = w;
  const C = t.fx.location({ name: 'Calgary', timezone: 'America/Edmonton' });
  await t.as(w.hq).post(API, post({ title: 'Winter break', locations: [C.id, w.B.id], publish_at: '2026-10-20T09:00' }));
  const tab = alertTab(t, '#/news');
  tab.signIn(w.hq);
  await tab.start();
  const sched = tab.main().find(n => n.tag === 'section' && n.getAttribute('aria-labelledby') === 'ann-sched');
  assert.ok(textOf(sched).includes('Goes out Oct 20, 9:00 AM (Toronto time)'), textOf(sched));
});

test(['AN-3', 'AN-4'], 'a parent with students at two locations sees News and Home name both', async () => {
  const w = await world();
  const { t } = w;
  t.fx.link(w.famA.parent, w.famB.student);
  const tab = alertTab(t, '#/news');
  tab.signIn(w.famA.parent);
  await tab.start();
  assert.ok(textOf(tab.main()).includes('Announcements from Irvine and Toronto.'), textOf(tab.main()));
  assert.ok(textOf(tab.main()).includes('When Irvine and Toronto share news'), textOf(tab.main()));
  await tab.go('#/home');
  assert.ok(textOf(tab.main()).includes('News from Irvine and Toronto will show up here.'), textOf(tab.main()));
});

test(['AN-3'], 'Home\'s Latest news shows a new announcement as soon as it arrives, and other notices leave it be', async () => {
  const w = await world();
  const { t } = w;
  const tab = alertTab(t);
  tab.signIn(w.famA.parent);
  await tab.start();
  const card = () => tab.main().find(n => n.tag === 'section' && n.getAttribute('aria-labelledby') === 'home-news-h');
  assert.ok(textOf(card()).includes('No announcements yet.'));
  await t.as(w.dirA).post(API, post({ title: 'Pumpkin carving' }));
  await tab.arrive(t.fx.notifications(w.famA.parent, 'announcement')[0]);
  const shown = card();
  assert.ok(textOf(shown).includes('Pumpkin carving'), textOf(shown));
  // A notice that brings no new post (a check-in, say) does not redraw it.
  tab.App.toast('Sam checked in');
  await tab.settle();
  assert.equal(card(), shown);
  assert.ok(shown.isConnected);
});
