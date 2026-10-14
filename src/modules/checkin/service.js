'use strict';
// Check-in rules shared by the routes and the auto-checkout job: the daily QR
// code (CI-1, D-12), enrolled-slot matching (CI-3, D-13), visits, and the
// parent notification for every check-in and check-out (CI-6).
// Scan coordinates never reach this file: the scan route checks the radius
// and drops them (NF-5, D-23).

const crypto = require('crypto');
const time = require('../../time');
const notify = require('../../notify');

const EARLY_MS = 30 * 60000;            // D-13: check-in opens 30 minutes before a slot starts
const LOOKAHEAD_DAYS = 14;              // how far ahead "your next session" looks
const FLAG_REASON = 'Did not scan out'; // D-14

const getLocation = (ctx, id) => ctx.db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(id) || 0);
const getVisit = (ctx, id) => ctx.db.prepare('SELECT * FROM visits WHERE id = ?').get(Number(id) || 0);

// ---------- QR code (CI-1, D-12, NF-4) ----------

const rotateAt = loc => String(loc.qr_rotate_at || '04:00').padStart(5, '0');

// The "QR day" flips at qr_rotate_at in the location's zone; before that the
// previous day's code is still the current one.
function qrDay(loc, ms) {
  const date = time.localDate(loc, ms);
  return time.localTime(loc, ms) < rotateAt(loc) ? time.addDays(date, -1) : date;
}
const codeOn = (loc, day) => crypto.createHmac('sha256', loc.qr_secret).update(loc.id + '|' + day).digest('hex').slice(0, 20);

// Read-only helper (exported for other modules): the code valid at `ms`.
function currentCode(ctx, loc, ms = ctx.clock.now()) {
  return codeOn(loc, qrDay(loc, ms));
}
// When the current code stops working.
const codeExpiresAt = (loc, ms) => time.toMs(loc, time.addDays(qrDay(loc, ms), 1), rotateAt(loc));

// Compares byte lengths, not character lengths: timingSafeEqual throws on
// buffers of different sizes, and 'é' is one character but two bytes.
function sameCode(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// 'ok' for the current code, 'expired' for the previous day's, 'bad' otherwise.
function checkCode(loc, given, ms) {
  const day = qrDay(loc, ms);
  if (sameCode(given, codeOn(loc, day))) return 'ok';
  return sameCode(given, codeOn(loc, time.addDays(day, -1))) ? 'expired' : 'bad';
}

// ---------- enrolled slots (CI-3, D-10, D-13) ----------

// Every enrolled slot that runs at `loc` on `date`: an active enrollment in an
// active session, on that weekday, inside the session's term, and not on a
// closure day. studentId narrows it to one student.
function slotsOn(ctx, loc, date, studentId = null) {
  if (ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date)) return [];
  return ctx.db.prepare(`SELECT e.student_id, u.name AS student_name, e.weekday, s.id AS session_id, s.name, s.start_time, s.end_time
      FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id JOIN users u ON u.id = e.student_id
      WHERE e.status = 'active' AND e.weekday = ? AND s.status = 'active' AND s.location_id = ?
        AND t.start_date <= ? AND t.end_date >= ? AND u.active = 1 AND (? IS NULL OR e.student_id = ?)
      ORDER BY s.start_time, s.id`)
    .all(time.weekdayOfDate(date), loc.id, date, date, studentId, studentId)
    .map(r => Object.assign(r, { date, start_at: time.toMs(loc, date, r.start_time), end_at: time.toMs(loc, date, r.end_time) }));
}

// The slot whose check-in window (30 minutes before start until the end) holds `ms`.
function slotNow(ctx, loc, studentId, ms) {
  return slotsOn(ctx, loc, time.localDate(loc, ms), studentId)
    .find(s => ms >= s.start_at - EARLY_MS && ms <= s.end_at) || null;
}

// The student's next slot that has not ended yet, optionally skipping some.
function nextSlot(ctx, loc, studentId, ms, skip = () => false) {
  const has = ctx.db.prepare(`SELECT 1 FROM enrollments e JOIN sessions s ON s.id = e.session_id
    WHERE e.student_id = ? AND e.status = 'active' AND s.location_id = ? LIMIT 1`).get(studentId, loc.id);
  if (!has) return null;
  const today = time.localDate(loc, ms);
  for (let k = 0; k <= LOOKAHEAD_DAYS; k++) {
    const hit = slotsOn(ctx, loc, time.addDays(today, k), studentId).find(s => s.end_at > ms && !skip(s));
    if (hit) return hit;
  }
  return null;
}

// Membership must be active and not past its last valid day (D-16).
function membershipOk(ctx, studentId, today) {
  const m = ctx.db.prepare('SELECT status, expires_on FROM memberships WHERE student_id = ?').get(studentId);
  return !!m && m.status === 'active' && m.expires_on >= today;
}

// ---------- visits ----------

function openVisit(ctx, studentId, locId, date) {
  return ctx.db.prepare(`SELECT * FROM visits WHERE student_id = ? AND location_id = ? AND local_date = ? AND check_out_at IS NULL
    ORDER BY check_in_at DESC, id DESC LIMIT 1`).get(studentId, locId, date);
}

function createVisit(ctx, { student, loc, slot, ms, method, staff = null }) {
  const id = ctx.db.prepare(`INSERT INTO visits (student_id, location_id, session_id, weekday, local_date, check_in_at, checkin_method, checked_in_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(student.id, loc.id, slot ? slot.session_id : null, slot ? slot.weekday : null,
    time.localDate(loc, ms), ms, method, staff ? staff.id : null).lastInsertRowid;
  return getVisit(ctx, id);
}

function closeVisit(ctx, visit, { ms, method, staff = null }) {
  ctx.db.prepare('UPDATE visits SET check_out_at = ?, checkout_method = ?, checked_out_by = ? WHERE id = ? AND check_out_at IS NULL')
    .run(ms, method, staff ? staff.id : null, visit.id);
  return getVisit(ctx, visit.id);
}

// The student's latest finished visit that day, for the "check back in?" question.
function lastCheckout(ctx, studentId, locId, date) {
  return ctx.db.prepare(`SELECT * FROM visits WHERE student_id = ? AND location_id = ? AND local_date = ? AND check_out_at IS NOT NULL
    ORDER BY check_out_at DESC, id DESC LIMIT 1`).get(studentId, locId, date);
}

// The session a visit counted toward, with that day's start and end, or null.
function visitSession(ctx, loc, v) {
  const s = v.session_id ? ctx.db.prepare('SELECT id, name, start_time, end_time FROM sessions WHERE id = ?').get(v.session_id) : null;
  return s ? { id: s.id, name: s.name, start_at: time.toMs(loc, v.local_date, s.start_time), end_at: time.toMs(loc, v.local_date, s.end_time) } : null;
}

// ---------- wording ----------

const firstName = name => String(name || '').split(' ')[0];
const clockTime = (loc, ms) => time.local(loc, ms).toFormat('h:mm a');
const minutes = (from, to) => Math.max(0, Math.round((to - from) / 60000));
const duration = mins => (Math.floor(mins / 60) ? Math.floor(mins / 60) + 'h ' : '') + (mins % 60) + 'm';

// "today at 1:00 PM", "tomorrow at 1:00 PM" or "Fri, Oct 16 at 1:00 PM".
function when(loc, ms, now) {
  const d = time.localDate(loc, ms), today = time.localDate(loc, now);
  const day = d === today ? 'today' : d === time.addDays(today, 1) ? 'tomorrow' : time.local(loc, ms).toFormat('ccc, LLL d');
  return day + ' at ' + clockTime(loc, ms);
}

// Why a scan found no slot right now, and what to do next (CI-3).
function noSessionMessage(ctx, loc, studentId, ms) {
  const next = nextSlot(ctx, loc, studentId, ms);
  if (next && time.localDate(loc, next.start_at) === time.localDate(loc, ms)) {
    return `Check-in for your ${clockTime(loc, next.start_at)} session opens at ${clockTime(loc, next.start_at - EARLY_MS)}. Staff can check you in if needed.`;
  }
  return "You don't have a session right now." + (next ? ` Your next one is ${when(loc, next.start_at, ms)}.` : '')
    + ' Staff can check you in if needed.';
}

// ---------- parent notifications (CI-6) ----------

function tellParents(ctx, student, visit, msg) {
  notify.send(ctx, notify.parentsOf(ctx, student.id), Object.assign({ refType: 'visit', refId: visit.id }, msg));
}

function announceCheckin(ctx, { student, loc, visit, slot, staff = null }) {
  const who = firstName(student.name), at = clockTime(loc, visit.check_in_at);
  const parts = [];
  if (slot) parts.push(`${slot.name}, until ${clockTime(loc, slot.end_at)}.`);
  if (staff) parts.push(`Checked in by ${staff.name}.`);
  tellParents(ctx, student, visit, {
    kind: 'checkin',
    title: staff ? `${who} was checked in by staff at ${loc.name} · ${at}` : `${who} checked in at ${loc.name} · ${at}`,
    body: parts.join(' ') || null,
  });
}

function announceCheckout(ctx, { student, loc, visit, staff = null }) {
  const who = firstName(student.name), at = clockTime(loc, visit.check_out_at);
  const total = 'Total time ' + duration(minutes(visit.check_in_at, visit.check_out_at)) + '.';
  tellParents(ctx, student, visit, {
    kind: 'checkout',
    title: staff ? `${who} was checked out by staff at ${loc.name} · ${at}` : `${who} checked out of ${loc.name} · ${at}`,
    body: staff ? `${total} Checked out by ${staff.name}.` : total,
  });
}

// ---------- read models ----------

const publicLocation = loc => ({ id: loc.id, name: loc.name, timezone: loc.timezone, close_time: loc.close_time });

// Who checked a visit in or out by hand, and the reason they gave (saved with
// the audit entry), so staff rows can say "Checked in by Chris Ortiz · Phone is dead".
const reasonOf = action => `(SELECT json_extract(a.detail, '$.reason') FROM audit_log a
    WHERE a.target_type = 'visit' AND a.target_id = v.id AND a.action = '${action}' ORDER BY a.id DESC LIMIT 1)`;
const BY_SQL = `ib.name AS checked_in_by_name, ob.name AS checked_out_by_name,
    ${reasonOf('checkin.manual_checkin')} AS checkin_reason, ${reasonOf('checkin.manual_checkout')} AS checkout_reason`;
const BY_JOIN = 'LEFT JOIN users ib ON ib.id = v.checked_in_by LEFT JOIN users ob ON ob.id = v.checked_out_by';
const byFields = v => ({
  checked_in_by_name: v.checked_in_by_name, checkin_reason: v.checkin_reason,
  checked_out_by_name: v.checked_out_by_name, checkout_reason: v.checkout_reason,
});

// Staff "In the building" (CI-7): who is here, who is expected and has not
// arrived, who has left today, and flagged visits still waiting for review.
function building(ctx, loc, ms) {
  const today = time.localDate(loc, ms);
  const visits = ctx.db.prepare(`SELECT v.*, u.name AS student_name, s.name AS session_name, s.end_time, ${BY_SQL}
    FROM visits v JOIN users u ON u.id = v.student_id LEFT JOIN sessions s ON s.id = v.session_id ${BY_JOIN}
    WHERE v.location_id = ? AND v.local_date = ? ORDER BY v.check_in_at, v.id`).all(loc.id, today);
  const row = v => Object.assign({
    visit_id: v.id, student_id: v.student_id, name: v.student_name, session_name: v.session_name,
    check_in_at: v.check_in_at, check_out_at: v.check_out_at, checkin_method: v.checkin_method,
    checkout_method: v.checkout_method, ends_at: v.end_time ? time.toMs(loc, today, v.end_time) : null, flagged: !!v.flagged,
  }, byFields(v));
  const here = visits.filter(v => v.check_out_at == null).map(row);
  const hereIds = new Set(here.map(v => v.student_id));
  // Left = students who have gone; someone who came back in shows only under Here.
  const left = visits.filter(v => v.check_out_at != null && !hereIds.has(v.student_id)).map(row)
    .sort((a, b) => b.check_out_at - a.check_out_at);
  const visitedSlot = new Set(visits.map(v => v.student_id + ':' + v.session_id));
  const listed = new Set();
  const expected = [];
  for (const s of slotsOn(ctx, loc, today)) {
    if (s.end_at <= ms || hereIds.has(s.student_id) || listed.has(s.student_id) || visitedSlot.has(s.student_id + ':' + s.session_id)) continue;
    listed.add(s.student_id);
    expected.push({ student_id: s.student_id, name: s.student_name, session_id: s.session_id, session_name: s.name, start_at: s.start_at, end_at: s.end_at,
      membership_active: membershipOk(ctx, s.student_id, today) });
  }
  const needsReview = ctx.db.prepare(`SELECT v.*, u.name AS student_name, s.name AS session_name, ${BY_SQL} FROM visits v
    JOIN users u ON u.id = v.student_id LEFT JOIN sessions s ON s.id = v.session_id ${BY_JOIN}
    WHERE v.location_id = ? AND v.flagged = 1 AND v.reviewed_by IS NULL ORDER BY v.check_in_at DESC, v.id DESC LIMIT 100`).all(loc.id)
    .map(v => Object.assign({
      visit_id: v.id, student_id: v.student_id, name: v.student_name, session_name: v.session_name, local_date: v.local_date,
      check_in_at: v.check_in_at, check_out_at: v.check_out_at, checkin_method: v.checkin_method, checkout_method: v.checkout_method,
      flag_reason: v.flag_reason,
    }, byFields(v)));
  return { location: publicLocation(loc), today, now: ms, here, expected, left, needs_review: needsReview };
}

// A student's status today, for the parent and student Home cards.
function status(ctx, student, ms) {
  const loc = student && getLocation(ctx, student.location_id);
  if (!loc) return null;
  const today = time.localDate(loc, ms);
  const visits = ctx.db.prepare(`SELECT v.*, s.name AS session_name, s.end_time FROM visits v LEFT JOIN sessions s ON s.id = v.session_id
    WHERE v.student_id = ? AND v.location_id = ? AND v.local_date = ? ORDER BY v.check_in_at DESC, v.id DESC`).all(student.id, loc.id, today);
  const v = visits[0];
  const visited = new Set(visits.map(x => x.session_id));
  const next = nextSlot(ctx, loc, student.id, ms, s => s.date === today && visited.has(s.session_id));
  return {
    id: student.id, name: student.name, location: publicLocation(loc),
    state: !v ? 'none' : v.check_out_at == null ? 'here' : 'left',
    // Sessions paused by a lapsed membership (MB-5), so the screen can say why none are coming up.
    paused: !!ctx.db.prepare("SELECT 1 FROM enrollments WHERE student_id = ? AND status = 'paused'").get(student.id),
    visit: v ? {
      id: v.id, check_in_at: v.check_in_at, check_out_at: v.check_out_at, checkin_method: v.checkin_method,
      checkout_method: v.checkout_method, session_name: v.session_name, ends_at: v.end_time ? time.toMs(loc, today, v.end_time) : null,
    } : null,
    next: next ? {
      session_name: next.name, date: next.date, start_at: next.start_at, end_at: next.end_at,
      opens_at: next.start_at - EARLY_MS, when: when(loc, next.start_at, ms),
    } : null,
  };
}

// ---------- auto-checkout job (CI-5, D-14, NF-4) ----------

// Open visits past the earlier of their slot's end and the location's closing
// time are checked out at that time, flagged for review, and parents are told
// it was automatic. Each visit uses its own location's zone.
function autoCheckout(ctx) {
  const now = ctx.clock.now();
  const open = ctx.db.prepare(`SELECT v.*, s.end_time, u.name AS student_name FROM visits v
    LEFT JOIN sessions s ON s.id = v.session_id JOIN users u ON u.id = v.student_id WHERE v.check_out_at IS NULL`).all();
  let closed = 0;
  for (const v of open) {
    const loc = getLocation(ctx, v.location_id);
    const close = time.toMs(loc, v.local_date, loc.close_time);
    const slotEnd = v.end_time ? time.toMs(loc, v.local_date, v.end_time) : close;
    const cutoff = Math.max(Math.min(slotEnd, close), v.check_in_at);
    if (now < cutoff) continue;
    const r = ctx.db.prepare(`UPDATE visits SET check_out_at = ?, checkout_method = 'auto', flagged = 1, flag_reason = ?
      WHERE id = ? AND check_out_at IS NULL`).run(cutoff, FLAG_REASON, v.id);
    if (!r.changes) continue;
    closed++;
    const who = firstName(v.student_name);
    const why = slotEnd < close ? 'when the session ended' : `when ${loc.name} closed`;
    tellParents(ctx, { id: v.student_id }, v, {
      kind: 'checkout_auto',
      title: `${who} was checked out automatically · ${clockTime(loc, cutoff)}`,
      body: `${who} didn't scan out of ${loc.name}, so the app checked them out ${why}. Total time ${duration(minutes(v.check_in_at, cutoff))}. Staff will review it.`,
    });
  }
  return closed;
}

module.exports = {
  EARLY_MS, FLAG_REASON, getLocation, getVisit, qrDay, currentCode, codeExpiresAt, checkCode,
  slotsOn, slotNow, nextSlot, membershipOk, openVisit, createVisit, closeVisit, lastCheckout, visitSession,
  firstName, clockTime, minutes, duration, when, noSessionMessage, announceCheckin, announceCheckout,
  publicLocation, building, status, autoCheckout,
};
