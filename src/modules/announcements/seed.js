'use strict';
// Demo announcements: a few weeks of posts across audiences, one network post
// from HQ, a past emergency alert, one post still scheduled, a muted parent,
// and some reads so senders see real delivery and read numbers (AN-6).
const time = require('../../time');
const { createPost, publish } = require('./index');

module.exports = function seed(ctx, demo) {
  const db = ctx.db;
  const { irvine, arcadia, toronto } = demo.locations;
  const today = time.localDate(irvine, demo.NOW);
  const atIrvine = (daysBack, hhmm) => time.toMs(irvine, time.addDays(today, -daysBack), hhmm);
  const atToronto = (daysBack, hhmm) => time.toMs(toronto, time.addDays(time.localDate(toronto, demo.NOW), -daysBack), hhmm);

  // Maria Garcia prefers no announcement notifications; she still sees News.
  const garcia = demo.families[0].parent;
  db.prepare('INSERT OR REPLACE INTO announcement_prefs (user_id, muted, updated_at) VALUES (?, 1, ?)').run(garcia.id, demo.NOW);

  const post = (by, when, p) => {
    ctx.clock.set(Math.min(when, demo.NOW));
    const id = createPost(ctx, by, Object.assign({ type: 'announcement', sessionId: null, publishAt: when }, p));
    if (when <= demo.NOW) publish(ctx, id);
    return id;
  };

  post(demo.dirIrvine, atIrvine(9, '15:00'), {
    category: 'holiday', audience: 'families', locationIds: [irvine.id],
    title: 'Closed for Thanksgiving, Nov 26 and 27',
    body: 'ELITE Spaces Irvine will be closed Thursday, Nov 26 and Friday, Nov 27. Sessions on those days are cancelled, and your enrollment carries on the next week. Have a wonderful holiday!',
  });
  post(demo.hq, atIrvine(7, '09:00'), {
    category: 'news', audience: 'families', locationIds: [irvine.id, arcadia.id, toronto.id],
    title: 'Welcome to the fall term',
    body: 'Thank you for studying with ELITE Spaces this fall. Check in with the app when you arrive, and parents will get a note at the end of each day. We are glad you are here.',
  });
  post(demo.dirIrvine, atIrvine(5, '17:30'), {
    category: null, type: 'emergency', audience: 'everyone', locationIds: [irvine.id],
    title: 'Building closed early: power outage',
    body: 'We lost power and are closing at 6:00 PM today. Students, please pack up and head home or meet your ride out front. We will post here when power is back.',
  });
  post(demo.dirIrvine, atIrvine(4, '10:00'), {
    category: 'workshop', audience: 'parents', locationIds: [irvine.id],
    title: 'Parent workshop: college planning for homeschoolers',
    body: 'Join us Saturday, Oct 24 at 10:00 AM in the main study room. We will cover transcripts, testing timelines and how to describe a homeschool curriculum. Coffee provided.',
  });
  post(demo.dirIrvine, atIrvine(1, '16:15'), {
    category: 'session_offering', audience: 'session', sessionId: demo.sessions.pmMWF.id, locationIds: [irvine.id],
    title: 'Afternoon Study: the quiet room is open Fridays',
    body: 'Starting this Friday, the quiet room is reserved for Afternoon Study students who want a phone-free space. Just ask at the front desk.',
  });
  post(demo.dirToronto, atToronto(2, '11:00'), {
    category: 'event', audience: 'families', locationIds: [toronto.id],
    title: 'Study jam this Saturday',
    body: 'Bring a friend and your toughest problem sets. We will have snacks and quiet music from 1:00 to 4:00 PM.',
  });
  // Still waiting to go out: tomorrow at 9:00 AM Irvine time.
  post(demo.dirIrvine, time.toMs(irvine, time.addDays(today, 1), '09:00'), {
    category: 'event', audience: 'families', locationIds: [irvine.id],
    title: 'Pumpkin carving on Friday',
    body: 'Take a study break with us Friday at 3:30 PM. Pumpkins and tools provided. Students only need to bring their creativity.',
  });

  // Some families already read their notifications, so the numbers mean something.
  ctx.clock.set(demo.NOW);
  const readers = demo.families.slice(1).flatMap(f => [f.parent, ...f.students]).filter((_, i) => i % 2 === 0);
  const mark = db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND ref_type = 'announcement' AND read_at IS NULL AND created_at < ?");
  for (const u of readers) mark.run(demo.NOW - 3600000, u.id, demo.NOW - 2 * 86400000);
  ctx.clock.set(null);
};
