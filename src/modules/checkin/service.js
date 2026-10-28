'use strict';
// Check-in rules shared by the routes and the auto-checkout job: the daily QR
// code (CI-1, D-12), scheduled-date matching (CI-3, D-13, D-47), visits, and the
// parent notification for every check-in and check-out (CI-6).
// There is no location check (D-49): nothing here reads coordinates (NF-5).

const crypto = require('crypto');
const time = require('../../time');
const notify = require('../../notify');
const dates = require('../sessions/dates');

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

// ---------- scheduled dates (CI-3, D-13, D-47) ----------

// The schedule fields sessions/dates.js reads, from a slotsOn() query row.
const schedOf = r => ({ id: r.session_id, weekdays: r.weekdays, term_start: r.term_start, term_end: r.term_end });

// Every enrolled slot that runs at `loc` on `date`: an active enrollment in an
// active schedule that meets that day (D-47: added dates in, skipped ones out,
// inside its term) and counts that day (D-42), not on a closure day.
// studentId narrows it to one student. `weekday` is the date's ISO weekday.
function slotsOn(ctx, loc, date, studentId = null) {
  if (ctx.db.prepare('SELECT 1 FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date)) return [];
  const rows = ctx.db.prepare(`SELECT e.student_id, u.name AS student_name, e.weekday AS enrolled_weekday, s.id AS session_id, s.name, s.weekdays,
        s.start_time, s.end_time, t.start_date AS term_start, t.end_date AS term_end
      FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id JOIN users u ON u.id = e.student_id
      WHERE e.status = 'active' AND s.status = 'active' AND s.location_id = ? AND u.active = 1 AND (? IS NULL OR e.student_id = ?)
      ORDER BY s.start_time, s.id`)
    .all(loc.id, studentId, studentId);
  if (!rows.length) return [];
  const ov = dates.overrides(ctx, [...new Set(rows.map(r => r.session_id))]);
  return rows.filter(r => dates.counts({ weekday: r.enrolled_weekday }, date) && dates.meets(schedOf(r), ov, date))
    .map(r => ({ student_id: r.student_id, student_name: r.student_name, weekday: time.weekdayOfDate(date), session_id: r.session_id, name: r.name,
      start_time: r.start_time, end_time: r.end_time, date, start_at: time.toMs(loc, date, r.start_time), end_at: time.toMs(loc, date, r.end_time) }));
}

// The student's schedules that would meet on `date` but were skipped (D-46), each with the
// date it moved to, if it moved (in its term), else null. For the no-session message (CI-3, SC-5).
function skippedOn(ctx, loc, studentId, date) {
  return ctx.db.prepare(`SELECT s.name, e.weekday AS enrolled_weekday,
        (SELECT a.date FROM session_dates a WHERE a.session_id = s.id AND a.kind = 'add' AND a.moved_from = d.date
          AND a.date BETWEEN t.start_date AND t.end_date) AS moved_to
      FROM session_dates d JOIN sessions s ON s.id = d.session_id JOIN terms t ON t.id = s.term_id
      JOIN enrollments e ON e.session_id = s.id AND e.student_id = ? AND e.status = 'active'
      WHERE d.kind = 'skip' AND d.date = ? AND s.status = 'active' AND s.location_id = ? AND d.date BETWEEN t.start_date AND t.end_date
      ORDER BY s.start_time, s.id`)
    .all(studentId, date, loc.id)
    .filter(r => dates.counts({ weekday: r.enrolled_weekday }, date))
    .map(r => ({ name: r.name, moved_to: r.moved_to }));
}

// The closure on `date` at `loc` (SC-3, D-19), or undefined.
const closureOn = (ctx, loc, date) => ctx.db.prepare('SELECT * FROM closures WHERE location_id = ? AND date = ?').get(loc.id, date);

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

// Membership must be active, started, and not past its last valid day (D-16, R6).
function membershipOk(ctx, studentId, today) {
  const m = ctx.db.prepare('SELECT status, start_date, expires_on FROM memberships WHERE student_id = ?').get(studentId);
  return !!m && m.status === 'active' && m.expires_on >= today && m.start_date <= today;
}

// The first day of an active membership that hasn't started yet (R6), or null.
function startsLater(ctx, studentId, today) {
  const m = ctx.db.prepare("SELECT start_date FROM memberships WHERE student_id = ? AND status = 'active' AND start_date > ? AND expires_on >= ?")
    .get(studentId, today, today);
  return m ? m.start_date : null;
}

// The enrolled slots a stay that began in a slot ending at `end` runs on into (R2). Back-to-back
// sessions are one visit: it runs on through each enrolled slot that day whose
// check-in window (D-13) has opened by the time the stay so far ends.
function stayAfter(ctx, loc, studentId, date, end) {
  const more = [];
  for (const s of slotsOn(ctx, loc, date, studentId)) { // ordered by start time
    if (s.start_at - EARLY_MS <= end && s.end_at > end) { more.push(s); end = s.end_at; }
  }
  return more;
}
// When that stay really ends: the end of the last back-to-back slot, or `end` itself.
function stayEnd(ctx, loc, studentId, date, end) {
  const more = stayAfter(ctx, loc, studentId, date, end);
  return more.length ? more[more.length - 1].end_at : end;
}

// A visit counts for a slot when it is linked to it or overlaps its hours: a staff
// check-in with no session (D-15a) or a back-to-back stay (R2). A visit still open
// overlaps every slot that hasn't ended.
const visitCovers = (v, s) => v.student_id === s.student_id && (v.session_id === s.session_id
  || (v.check_in_at < s.end_at && (v.check_out_at == null || v.check_out_at > s.start_at)));

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

// The slot a visit is in at `ms`: its own session, or during a back-to-back stay (R2) the latest slot it
// has run on into, once that slot has started or the one before it has ended. null for a visit with no session.
function slotIn(ctx, loc, v, ms) {
  let cur = visitSession(ctx, loc, v);
  if (!cur) return null;
  for (const s of stayAfter(ctx, loc, v.student_id, v.local_date, cur.end_at)) { // ordered by start time
    if (s.start_at > ms && cur.end_at >= ms) break;
    cur = s;
  }
  return cur;
}

// ---------- wording ----------

const firstName = name => String(name || '').split(' ')[0];
const clockTime = (loc, ms) => time.local(loc, ms).toFormat('h:mm a');
const minutes = (from, to) => Math.max(0, Math.round((to - from) / 60000));
const duration = mins => (Math.floor(mins / 60) ? Math.floor(mins / 60) + 'h ' : '') + (mins % 60) + 'm';
// "Mon, Nov 2" for a location-local date.
const dayName = (loc, date) => time.local(loc, time.toMs(loc, date, '12:00')).toFormat('ccc, LLL d');

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
  // A schedule skipped today (D-46) says so, and where it moved to (SC-5).
  const skipped = skippedOn(ctx, loc, studentId, time.localDate(loc, ms))[0];
  const why = skipped ? `${skipped.name} doesn't meet today${skipped.moved_to ? ` (moved to ${dayName(loc, skipped.moved_to)})` : ''}.`
    : "You don't have a session right now.";
  return why + (next ? ` Your next one is ${when(loc, next.start_at, ms)}.` : '') + ' Staff can check you in if needed.';
}

// A scan on a closure day (SC-3, D-19): the center is closed, so it says so, with the reason,
// instead of "no session right now", and doesn't offer a staff check-in.
function closedMessage(ctx, loc, studentId, ms, closure) {
  const next = nextSlot(ctx, loc, studentId, ms);
  return `${loc.name} is closed today${closure.reason ? ` (${closure.reason})` : ''}, so there are no sessions.`
    + (next ? ` Your next one is ${when(loc, next.start_at, ms)}.` : '');
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
  // Names the session the visit counted toward, as the check-in notice does.
  const session = visitSession(ctx, loc, visit);
  const total = (session ? session.name + '. ' : '') + 'Total time ' + duration(minutes(visit.check_in_at, visit.check_out_at)) + '.';
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
  // During a back-to-back stay (R2) a student here is in the slot the visit has run on into.
  const here = visits.filter(v => v.check_out_at == null).map(v => {
    const inNow = slotIn(ctx, loc, v, ms);
    return inNow ? Object.assign(row(v), { session_name: inNow.name, ends_at: inNow.end_at }) : row(v);
  });
  const hereIds = new Set(here.map(v => v.student_id));
  // Left = students who have gone, once each at their latest check-out; someone who came back in shows only under Here.
  const gone = new Set(hereIds);
  const left = visits.filter(v => v.check_out_at != null).sort((a, b) => b.check_out_at - a.check_out_at)
    .filter(v => !gone.has(v.student_id) && gone.add(v.student_id)).map(row);
  // A slot a visit today covers (linked or overlapping, D-15a and R2) is not expected; a
  // student still here covers every slot that hasn't ended.
  const visited = s => visits.some(v => visitCovers(v, s));
  const listed = new Set();
  const expected = [];
  for (const s of slotsOn(ctx, loc, today)) {
    if (s.end_at <= ms || listed.has(s.student_id) || visited(s)) continue;
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
  const closure = closureOn(ctx, loc, today);
  // The next slot skips any slot today's visits already cover (D-15a, R2).
  const next = nextSlot(ctx, loc, student.id, ms, s => s.date === today && visits.some(x => visitCovers(x, s)));
  // During a back-to-back stay (R2) the visit is in the slot it has run on into.
  const inNow = v && v.check_out_at == null ? slotIn(ctx, loc, v, ms) : null;
  return {
    id: student.id, name: student.name, location: publicLocation(loc),
    state: !v ? 'none' : v.check_out_at == null ? 'here' : 'left',
    // Sessions paused by a lapsed membership (MB-5), so the screen can say why none are coming up. A slot
    // left paused while the membership is valid (an ended term or over the cap, D-16a) is not that.
    paused: !membershipOk(ctx, student.id, today)
      && !!ctx.db.prepare("SELECT 1 FROM enrollments WHERE student_id = ? AND status = 'paused'").get(student.id),
    visit: v ? {
      id: v.id, check_in_at: v.check_in_at, check_out_at: v.check_out_at, checkin_method: v.checkin_method,
      checkout_method: v.checkout_method, session_name: inNow ? inNow.name : v.session_name,
      ends_at: inNow ? inNow.end_at : v.end_time ? time.toMs(loc, today, v.end_time) : null,
    } : null,
    // A membership that hasn't started yet (R6): its first day, so the card can say when check-in opens.
    starts_on: startsLater(ctx, student.id, today),
    // A closure today (SC-3, D-19), so the Check in screen can say the center is closed (L31).
    closed_today: closure ? { reason: closure.reason || null } : null,
    next: next ? {
      session_name: next.name, date: next.date, start_at: next.start_at, end_at: next.end_at,
      opens_at: next.start_at - EARLY_MS, when: when(loc, next.start_at, ms),
    } : null,
  };
}

// ---------- auto-checkout job (CI-5, D-14, NF-4) ----------

// Open visits past the earlier of their slot's end and the location's closing
// time are checked out at that time, flagged for review, and parents are told
// it was automatic. Each visit uses its own location's zone. A slot followed by
// back-to-back slots ends with the last of them (R2).
function autoCheckout(ctx) {
  const now = ctx.clock.now();
  const open = ctx.db.prepare(`SELECT v.*, s.end_time, u.name AS student_name FROM visits v
    LEFT JOIN sessions s ON s.id = v.session_id JOIN users u ON u.id = v.student_id WHERE v.check_out_at IS NULL`).all();
  let closed = 0;
  for (const v of open) {
    const loc = getLocation(ctx, v.location_id);
    const close = time.toMs(loc, v.local_date, loc.close_time);
    const slotEnd = v.end_time ? stayEnd(ctx, loc, v.student_id, v.local_date, time.toMs(loc, v.local_date, v.end_time)) : close;
    const cutoff = Math.max(Math.min(slotEnd, close), v.check_in_at);
    if (now < cutoff) continue;
    const r = ctx.db.prepare(`UPDATE visits SET check_out_at = ?, checkout_method = 'auto', flagged = 1, flag_reason = ?
      WHERE id = ? AND check_out_at IS NULL`).run(cutoff, FLAG_REASON, v.id);
    if (!r.changes) continue;
    closed++;
    const who = firstName(v.student_name);
    const why = slotEnd < close ? 'when the session ended' : `when ${loc.name} closed`;
    // Names the session the student was in at the cutoff, as the scan and staff check-out notices do.
    const session = slotIn(ctx, loc, v, cutoff);
    tellParents(ctx, { id: v.student_id }, v, {
      kind: 'checkout_auto',
      title: `${who} was checked out automatically · ${clockTime(loc, cutoff)}`,
      body: `${who} didn't scan out of ${session ? session.name + ' at ' : ''}${loc.name}, so the app checked them out ${why}. Total time ${duration(minutes(v.check_in_at, cutoff))}. Staff will review it.`,
    });
  }
  return closed;
}

module.exports = {
  EARLY_MS, FLAG_REASON, getLocation, getVisit, qrDay, currentCode, codeExpiresAt, checkCode,
  closureOn, slotsOn, skippedOn, slotNow, nextSlot, membershipOk, startsLater, stayAfter, stayEnd, visitCovers, openVisit, createVisit, closeVisit, lastCheckout, visitSession, slotIn,
  firstName, clockTime, minutes, duration, dayName, when, noSessionMessage, closedMessage, announceCheckin, announceCheckout,
  publicLocation, building, status, autoCheckout,
};
