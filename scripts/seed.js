'use strict';
// Demo data: 3 locations in 2 time zones, staff, families (incl. a two-guardian
// student, an expiring membership, an inactive one, a pending student link),
// sessions with one nearly-full slot, enrollments, and three weeks of past visits.
// Every demo account's password is demo1234 (local test value only).
//
//   npm run seed             rebuild data/elite-spaces.db
// After the core data, each module's src/modules/<name>/seed.js (if present)
// runs as seed(ctx, demo) to add its own rows.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB = process.env.ELITE_DB || path.join(__dirname, '..', 'data', 'elite-spaces.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
fs.mkdirSync(path.dirname(DB), { recursive: true });

const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const time = require('../src/time');
const MODULES = require('../src/modules');

const { ctx } = createApp({ dbFile: DB });
const db = ctx.db;
const NOW = Date.now();
const PW = hashPassword('demo1234');
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);

db.exec('BEGIN');

const loc = (name, timezone, lat, lng, address) => {
  const id = ins(`INSERT INTO locations (name, timezone, address, lat, lng, qr_secret, created_at) VALUES (?,?,?,?,?,?,?)`,
    name, timezone, address, lat, lng, crypto.randomBytes(16).toString('hex'), NOW);
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
};
const user = (role, name, email, location, { pw = true, phone = null } = {}) => {
  const id = ins('INSERT INTO users (role, name, email, phone, password_hash, location_id, created_at) VALUES (?,?,?,?,?,?,?)',
    role, name, email, phone, pw ? PW : null, location ? location.id : null, NOW);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const link = (p, s, status = 'active') => db.prepare('INSERT INTO family_links (parent_id, student_id, status, created_at, approved_at) VALUES (?,?,?,?,?)')
  .run(p.id, s.id, status, NOW, status === 'active' ? NOW : null);
const today = l => time.localDate(l, NOW);
const membership = (s, cap, status, expires, by) => db.prepare(`INSERT INTO memberships (student_id, status, weekly_cap, start_date, expires_on, updated_by, updated_at)
  VALUES (?,?,?,?,?,?,?)`).run(s.id, status, cap, '2026-08-17', expires, by.id, NOW);

const irvine = loc('Irvine', 'America/Los_Angeles', 33.6846, -117.8265, '2 Park Plaza, Irvine, CA');
const arcadia = loc('Arcadia', 'America/Los_Angeles', 34.1397, -118.0353, '150 E Huntington Dr, Arcadia, CA');
const toronto = loc('Toronto', 'America/Toronto', 43.6532, -79.3832, '100 Queen St W, Toronto, ON');

const hq = user('hq', 'Morgan Lee', 'hq@elitespaces.test', null);
const dirIrvine = user('director', 'Dana Park', 'director.irvine@elitespaces.test', irvine);
const staffIrvine = user('staff', 'Chris Ortiz', 'staff.irvine@elitespaces.test', irvine);
user('staff', 'Sam Rivera', 'sam.irvine@elitespaces.test', irvine);
user('director', 'Priya Shah', 'director.arcadia@elitespaces.test', arcadia);
user('staff', 'Jordan Wu', 'staff.arcadia@elitespaces.test', arcadia);
const dirToronto = user('director', 'Alex Tremblay', 'director.toronto@elitespaces.test', toronto);
user('staff', 'Riley Martin', 'staff.toronto@elitespaces.test', toronto);

const term = (l) => db.prepare('SELECT * FROM terms WHERE id = ?').get(
  ins('INSERT INTO terms (location_id, name, start_date, end_date) VALUES (?,?,?,?)', l.id, 'Fall 2026', '2026-08-17', '2026-12-18'));
const tI = term(irvine), tA = term(arcadia), tT = term(toronto);
db.prepare('INSERT INTO closures (location_id, date, reason, created_by) VALUES (?,?,?,?)').run(irvine.id, '2026-11-26', 'Thanksgiving', dirIrvine.id);
db.prepare('INSERT INTO closures (location_id, date, reason, created_by) VALUES (?,?,?,?)').run(irvine.id, '2026-11-27', 'Thanksgiving', dirIrvine.id);

const session = (l, t, name, weekdays, start, end, capacity, by) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(
  ins('INSERT INTO sessions (location_id, term_id, name, weekdays, start_time, end_time, capacity, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    l.id, t.id, name, weekdays, start, end, capacity, by.id, NOW));
const morning = session(irvine, tI, 'Morning Focus', '1,2,3,4,5', '09:30', '12:00', 24, dirIrvine);
const pmMWF = session(irvine, tI, 'Afternoon Study', '1,3,5', '13:00', '16:00', 30, dirIrvine);
const pmTTh = session(irvine, tI, 'Afternoon Study', '2,4', '13:00', '16:00', 30, dirIrvine);
const small = session(irvine, tI, 'Quiet Room', '2,4', '16:30', '18:30', 2, dirIrvine);
session(arcadia, tA, 'Afternoon Study', '1,3,5', '13:00', '15:30', 20, dirIrvine);
const torMorning = session(toronto, tT, 'Morning Focus', '1,3,5', '09:00', '11:30', 18, dirToronto);

const fam = [];
const family = (parentName, email, kids, l = irvine) => {
  const p = user('parent', parentName, email, l, { phone: '555-0100' });
  const ss = kids.map(([name, cap, status, expires, pw = true]) => {
    const s = user('student', name, email.replace('@', '.' + name.split(' ')[0].toLowerCase() + '@'), l, { pw });
    link(p, s);
    membership(s, cap, status, expires, staffIrvine);
    return s;
  });
  fam.push({ parent: p, students: ss });
  return { parent: p, students: ss };
};
const expSoon = time.addDays(today(irvine), 10);
const garcia = family('Maria Garcia', 'garcia@family.test', [['Leo Garcia', 4, 'active', '2027-06-30'], ['Sofia Garcia', 3, 'active', '2027-06-30']]);
const nguyen = family('Thanh Nguyen', 'nguyen@family.test', [['Anh Nguyen', 3, 'active', '2027-06-30']]);
const patel = family('Ravi Patel', 'patel@family.test', [['Isha Patel', 3, 'active', expSoon]]);
const kim = family('Grace Kim', 'kim@family.test', [['Daniel Kim', 3, 'inactive', '2026-09-30']]);
const johnson = family('Erin Johnson', 'johnson@family.test', [['Maya Johnson', 4, 'active', '2027-06-30']]);
// second guardian for Maya
const mark = user('parent', 'Mark Johnson', 'mark.johnson@family.test', irvine);
link(mark, johnson.students[0]);
// a family whose student invite is still pending parent approval
const chen = user('parent', 'Wei Chen', 'chen@family.test', irvine);
const chenKid = user('student', 'Lily Chen', 'chen.lily@family.test', irvine);
link(chen, chenKid, 'pending');
membership(chenKid, 3, 'active', '2027-06-30', staffIrvine);
const tor = family('Sophie Roy', 'roy@family.test', [['Noah Roy', 3, 'active', '2027-06-30']], toronto);

// The demo enrollments date from before the three weeks of visit history below,
// so a week a student missed shows as absent (D-15) in Schedule and Hours.
const ENROLLED_AT = NOW - 22 * 864e5;
const enroll = (s, sess, wd) => ins("INSERT INTO enrollments (student_id, session_id, weekday, status, source, created_at) VALUES (?,?,?,'active','parent',?)", s.id, sess.id, wd, ENROLLED_AT);
const plan = [
  [garcia.students[0], [[pmMWF, 1], [pmMWF, 3], [pmMWF, 5], [small, 2]]],
  [garcia.students[1], [[morning, 2], [morning, 4], [small, 4]]],
  [nguyen.students[0], [[pmMWF, 1], [pmMWF, 3], [pmTTh, 2]]],
  [patel.students[0], [[morning, 1], [morning, 3], [small, 2]]],
  [johnson.students[0], [[pmTTh, 2], [pmTTh, 4], [morning, 5], [small, 4]]],
  [tor.students[0], [[torMorning, 1], [torMorning, 3], [torMorning, 5]]],
];
for (const [s, slots] of plan) for (const [sess, wd] of slots) enroll(s, sess, wd);
// Daniel Kim's membership lapsed: his enrollment is paused, not deleted (MB-5).
ins("INSERT INTO enrollments (student_id, session_id, weekday, status, source, created_at) VALUES (?,?,?,'paused','parent',?)", kim.students[0].id, pmMWF.id, 1, ENROLLED_AT);

// Three weeks of past visits. Most check out by scan; some forget (auto); a few miss.
let seed = 7;
const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
for (const [s, slots] of plan) {
  const l = db.prepare('SELECT l.* FROM locations l JOIN users u ON u.location_id = l.id WHERE u.id = ?').get(s.id);
  const t = today(l);
  for (let back = 21; back >= 1; back--) {
    const d = time.addDays(t, -back);
    const wd = time.weekdayOfDate(d);
    for (const [sess, swd] of slots) {
      if (swd !== wd) continue;
      if (db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(l.id, d)) continue;
      const r = rnd();
      if (r < 0.1) continue; // absent
      const inAt = time.toMs(l, d, sess.start_time) + Math.round(rnd() * 15 - 5) * 60000;
      const end = time.toMs(l, d, sess.end_time);
      const auto = r > 0.92;
      const outAt = auto ? end : end - Math.round(rnd() * 20) * 60000;
      ins(`INSERT INTO visits (student_id, location_id, session_id, weekday, local_date, check_in_at, check_out_at, checkin_method, checkout_method, flagged, flag_reason)
        VALUES (?,?,?,?,?,?,?,'scan',?,?,?)`, s.id, l.id, sess.id, wd, d, inAt, outAt, auto ? 'auto' : 'scan', auto ? 1 : 0, auto ? 'Did not scan out' : null);
    }
  }
}

db.exec('COMMIT');

const demo = { NOW, locations: { irvine, arcadia, toronto }, hq, dirIrvine, staffIrvine, dirToronto, families: fam, sessions: { morning, pmMWF, pmTTh, small, torMorning }, extra: { mark, chen, chenKid } };
for (const m of MODULES) {
  const f = path.join(__dirname, '..', 'src', 'modules', m.name, 'seed.js');
  if (fs.existsSync(f)) require(f)(ctx, demo);
}

const count = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Seeded ${DB}\n  ${count('locations')} locations, ${count('users')} users, ${count('sessions')} sessions, ${count('enrollments')} enrollments, ${count('visits')} visits`);
console.log('  Every demo password: demo1234   (dev mode also offers one-tap sign-in)');
