'use strict';
// Enrollment rules (PRD 3, docs/enrollment-flow.png):
//   student request -> parent approves? (no -> declined, student notified)
//   -> check membership (active, not expired, under weekly cap) -> fail = blocked
//   -> seat open? yes = enrolled (recurring weekly slot, family notified); full = offer the waitlist.
// A slot is (session, weekday) (D-10). Every write runs synchronously inside one
// transaction (src/db.js tx), so two families racing for the last seat cannot
// both pass the seat check (NF-3).

const { DateTime } = require('luxon');
const { tx } = require('../../db');
const time = require('../../time');
const auth = require('../../auth');
const notify = require('../../notify');
const sessionTimes = require('../sessions/times');
const { bad, forbidden, notFound, conflict } = require('../../errors');

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const firstName = u => String(u.name).split(' ')[0];
const hm = s => { const [h, m] = s.split(':').map(Number); return ((h + 11) % 12 + 1) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm'); };
const when = (s, wd) => `${DAYS[wd]}s ${hm(s.start_time)}–${hm(s.end_time)}`;
const longDate = d => DateTime.fromISO(d).toFormat('LLL d, yyyy');
const LINE_ORDER = 'ORDER BY priority DESC, created_at, id'; // D-18: first come, first served; renewals jump ahead

const getLocation = (ctx, id) => ctx.db.prepare('SELECT id, name, timezone FROM locations WHERE id = ?').get(id);
const today = (ctx, loc) => time.localDate(loc, ctx.clock.now());

function getStudent(ctx, id) {
  const s = ctx.db.prepare('SELECT id, role, name, location_id, active FROM users WHERE id = ?').get(Number(id));
  if (!s || s.role !== 'student') throw notFound('No such student.');
  return s;
}

// Only an active linked parent acts for a student (EN-2, EN-6, NF-1).
function assertParentOf(ctx, user, studentId) {
  if (!auth.linkedStudentIds(ctx, user.id).includes(Number(studentId))) throw forbidden();
}

// ---------- slots, seats and the line ----------

// Loads a slot for this student and refuses ones they cannot take: another
// location (D-1), a day the session doesn't meet (EN-1: weekly slots only),
// a cancelled session, or a term that is over.
function loadSlot(ctx, student, sessionId, weekday) {
  const session = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(sessionId));
  if (!session) throw notFound('That session no longer exists.');
  if (session.location_id !== student.location_id) {
    throw conflict('not_home_location', `${firstName(student)} can only enroll in sessions at their home location.`);
  }
  const wd = Number(weekday);
  if (!session.weekdays.split(',').map(Number).includes(wd)) throw bad('bad_weekday', 'Pick one of the days this session meets.');
  if (session.status !== 'active') throw conflict('session_cancelled', 'That session has been cancelled.');
  const loc = getLocation(ctx, session.location_id);
  const term = ctx.db.prepare('SELECT * FROM terms WHERE id = ?').get(session.term_id);
  if (term.end_date < today(ctx, loc)) throw conflict('term_over', `${term.name} has ended.`);
  return { session, weekday: wd, loc, term };
}

const seatsTaken = (ctx, sessionId, weekday) => ctx.db.prepare(
  "SELECT COUNT(*) AS n FROM enrollments WHERE session_id = ? AND weekday = ? AND status = 'active'").get(sessionId, weekday).n;

const liveEnrollment = (ctx, studentId, sessionId, weekday) => ctx.db.prepare(
  "SELECT * FROM enrollments WHERE student_id = ? AND session_id = ? AND weekday = ? AND status IN ('active','paused')").get(studentId, sessionId, weekday);

const waitingRow = (ctx, studentId, sessionId, weekday) => ctx.db.prepare(
  "SELECT * FROM waitlist WHERE student_id = ? AND session_id = ? AND weekday = ? AND status = 'waiting'").get(studentId, sessionId, weekday);

const line = (ctx, sessionId, weekday) => ctx.db.prepare(
  `SELECT * FROM waitlist WHERE session_id = ? AND weekday = ? AND status = 'waiting' ${LINE_ORDER}`).all(sessionId, weekday);

const position = (ctx, w) => line(ctx, w.session_id, w.weekday).findIndex(x => x.id === w.id) + 1;

// Weekly slots a student holds (D-3): active enrollments in active sessions of
// the current and every upcoming term, whichever term a new slot is in. Paused
// and dropped ones, and ones whose term is over, hold nothing.
const capUsed = (ctx, studentId, d) => ctx.db.prepare(
  `SELECT COUNT(*) AS n FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
   WHERE e.student_id = ? AND e.status = 'active' AND s.status = 'active' AND t.end_date >= ?`).get(studentId, d).n;

// ---------- the membership check (EN-4) ----------

// Active, started and not expired as of the location's local date (D-16, R6:
// valid from start_date through expires_on), under the weekly cap.
// The same answer for every slot, so the catalog can show it before the server is asked.
function eligibility(ctx, student, loc) {
  const name = firstName(student);
  const m = ctx.db.prepare('SELECT status, weekly_cap, start_date, expires_on FROM memberships WHERE student_id = ?').get(student.id);
  if (!m) return { ok: false, code: 'no_membership', membership: null, used: 0, message: `${name} doesn't have a membership yet. The front desk can set one up.` };
  const d = today(ctx, loc);
  const used = capUsed(ctx, student.id, d);
  const out = { membership: m, used };
  if (m.status !== 'active') return Object.assign(out, { ok: false, code: 'membership_inactive', message: `${name}'s membership is inactive, so new sessions can't be added. The front desk can reactivate it.` });
  if (m.start_date > d) return Object.assign(out, { ok: false, code: 'membership_not_started', message: `${name}'s membership starts on ${longDate(m.start_date)}. Sessions can be added from that day.` });
  if (m.expires_on < d) return Object.assign(out, { ok: false, code: 'membership_expired', message: `${name}'s membership expired on ${longDate(m.expires_on)}. Once the front desk renews it, you can add sessions again.` });
  if (used >= m.weekly_cap) {
    return Object.assign(out, { ok: false, code: 'weekly_cap', message: `${name} already has ${used} weekly session${used === 1 ? '' : 's'}, the most the membership allows. Drop one to add another.` });
  }
  return Object.assign(out, { ok: true, code: 'ok', message: null });
}

// The same answer said to the student (L54): second person, and only what a
// parent or the front desk can do about it, never "drop one" or "join the waitlist".
function forStudent(check) {
  const m = check.membership;
  return {
    no_membership: "You don't have a membership yet. A parent can set one up with the front desk.",
    membership_inactive: "Your membership is inactive, so new sessions can't be added. A parent or the front desk can reactivate it.",
    membership_not_started: m && `Your membership starts on ${longDate(m.start_date)}. A parent can add sessions from that day.`,
    membership_expired: m && `Your membership expired on ${longDate(m.expires_on)}. Once it's renewed, a parent can add sessions again.`,
    weekly_cap: `You already have ${check.used} weekly session${check.used === 1 ? '' : 's'}, the most your membership allows. A parent can drop one to make room, then add this one.`,
  }[check.code];
}

// ---------- taking a seat ----------

function seat(ctx, student, slot, source, actor) {
  const now = ctx.clock.now();
  const { session, weekday } = slot;
  const paused = liveEnrollment(ctx, student.id, session.id, weekday);
  let id;
  if (paused) { // a paused spot (D-16) comes back instead of a second row
    ctx.db.prepare("UPDATE enrollments SET status = 'active' WHERE id = ?").run(paused.id);
    id = paused.id;
  } else {
    id = Number(ctx.db.prepare('INSERT INTO enrollments (student_id, session_id, weekday, status, source, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(student.id, session.id, weekday, 'active', source, actor ? actor.id : null, now).lastInsertRowid);
  }
  ctx.db.prepare("UPDATE waitlist SET status = 'enrolled', resolved_at = ? WHERE student_id = ? AND session_id = ? AND weekday = ? AND status = 'waiting'")
    .run(now, student.id, session.id, weekday);
  // A request for a slot the student now holds is settled.
  ctx.db.prepare(`UPDATE enrollment_requests SET status = 'approved', outcome = 'enrolled', decided_by = ?, decided_at = ?
    WHERE student_id = ? AND session_id = ? AND weekday = ? AND status = 'pending'`).run(actor ? actor.id : null, now, student.id, session.id, weekday);
  // One approved earlier that couldn't enroll them then (full, or blocked) now
  // says enrolled, not "full, join the waitlist" (L30).
  ctx.db.prepare(`UPDATE enrollment_requests SET outcome = 'enrolled', outcome_message = NULL
    WHERE student_id = ? AND session_id = ? AND weekday = ? AND status = 'approved' AND outcome IN ('full','blocked')`).run(student.id, session.id, weekday);
  return ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id);
}

const family = (ctx, studentId) => notify.parentsOf(ctx, studentId).concat(studentId);

function notifyEnrolled(ctx, recipients, student, slot, enrollment) {
  notify.send(ctx, recipients, {
    kind: 'enrollment_confirmed',
    title: `${firstName(student)} is enrolled in ${slot.session.name} at ${slot.loc.name}`,
    body: `${when(slot.session, slot.weekday)}, every week through ${longDate(slot.term.end_date)}.`,
    refType: 'enrollment', refId: enrollment.id,
  });
}

// EN-5 / D-18: fill free seats from the line, earliest eligible first. Anyone
// ahead who fails a check is skipped but keeps their place. Runs on every drop
// and as a scheduled job over every slot with a line.
function promoteSlot(ctx, sessionId, weekday) {
  const session = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session || session.status !== 'active') return [];
  const loc = getLocation(ctx, session.location_id);
  const term = ctx.db.prepare('SELECT * FROM terms WHERE id = ?').get(session.term_id);
  if (term.end_date < today(ctx, loc)) return [];
  const slot = { session, weekday, loc, term };
  const promoted = [];
  for (const w of line(ctx, sessionId, weekday)) {
    if (seatsTaken(ctx, sessionId, weekday) >= session.capacity) break;
    const student = ctx.db.prepare('SELECT id, role, name, location_id, active FROM users WHERE id = ?').get(w.student_id);
    if (!student.active || student.location_id !== session.location_id) continue;
    if (!eligibility(ctx, student, loc).ok) continue;
    const e = seat(ctx, student, slot, 'waitlist', null);
    notify.send(ctx, family(ctx, student.id), {
      kind: 'waitlist_promoted',
      title: `A seat opened: ${firstName(student)} is now enrolled in ${session.name}`,
      body: `${when(session, weekday)} at ${loc.name}, every week through ${longDate(term.end_date)}.`,
      refType: 'enrollment', refId: e.id,
    });
    promoted.push(e);
  }
  return promoted;
}

function promoteAll(ctx) {
  const slots = ctx.db.prepare("SELECT DISTINCT session_id, weekday FROM waitlist WHERE status = 'waiting'").all();
  let n = 0;
  for (const s of slots) n += tx(ctx.db, () => promoteSlot(ctx, s.session_id, s.weekday)).length;
  return n;
}

// Why a spot is paused (MB-5). With the membership lapsed it waits for a
// renewal; with the membership valid it was kept paused at renewal because it
// would go over the weekly limit (D-16a), and comes back if the limit goes up.
function pausedMessage(ctx, student, session, loc) {
  const m = ctx.db.prepare('SELECT status, start_date, expires_on FROM memberships WHERE student_id = ?').get(student.id);
  const d = today(ctx, loc);
  if (m && m.status === 'active' && m.start_date > d) { // R6: not started yet, so not over any limit
    return `${firstName(student)}'s spot in ${session.name} is paused because the membership doesn't start until ${longDate(m.start_date)}.`;
  }
  const valid = !!m && m.status === 'active' && m.expires_on >= d;
  return valid
    ? `${firstName(student)}'s spot in ${session.name} is paused because it would go over the membership's weekly limit. It stays saved, and the front desk can bring it back if the limit goes up.`
    : `${firstName(student)}'s spot in ${session.name} is paused until the membership is renewed.`;
}

// The shared part of the flow: membership check, then seat open? Returns an
// outcome instead of throwing so promotions made along the way are kept.
function attempt(ctx, actor, student, slot, source, recipients) {
  const { session, weekday } = slot;
  const live = liveEnrollment(ctx, student.id, session.id, weekday);
  if (live) {
    throw conflict('already_enrolled', live.status === 'paused'
      ? pausedMessage(ctx, student, session, slot.loc)
      : `${firstName(student)} is already enrolled in ${session.name} on ${DAYS[weekday]}s.`);
  }
  const check = eligibility(ctx, student, slot.loc);
  if (!check.ok) return { outcome: 'blocked', code: check.code, message: check.message };
  promoteSlot(ctx, session.id, weekday); // the line is served before anyone new
  const promoted = liveEnrollment(ctx, student.id, session.id, weekday); // they were already in line
  if (promoted) return { outcome: 'enrolled', enrollment: promoted };
  if (seatsTaken(ctx, session.id, weekday) >= session.capacity) {
    const w = waitingRow(ctx, student.id, session.id, weekday);
    return {
      outcome: 'full', code: 'full', waiting: line(ctx, session.id, weekday).length,
      message: w
        ? `${session.name} on ${DAYS[weekday]}s is still full. ${firstName(student)} is number ${position(ctx, w)} on the waitlist.`
        : `${session.name} on ${DAYS[weekday]}s is full. Join the waitlist and ${firstName(student)} will be enrolled automatically when a seat opens.`,
    };
  }
  const enrollment = seat(ctx, student, slot, source, actor);
  notifyEnrolled(ctx, recipients, student, slot, enrollment);
  return { outcome: 'enrolled', enrollment };
}

// ---------- parent actions ----------

// EN-2: a parent enrolls a linked student in a weekly slot.
function enroll(ctx, actor, body) {
  assertParentOf(ctx, actor, body.studentId);
  const student = getStudent(ctx, body.studentId);
  return tx(ctx.db, () => {
    const slot = loadSlot(ctx, student, body.sessionId, body.weekday);
    return attempt(ctx, actor, student, slot, 'parent', family(ctx, student.id));
  });
}

// EN-5: join a full slot's line. Runs the same membership and cap checks (D-18).
function joinWaitlist(ctx, actor, body) {
  assertParentOf(ctx, actor, body.studentId);
  const student = getStudent(ctx, body.studentId);
  return tx(ctx.db, () => {
    const slot = loadSlot(ctx, student, body.sessionId, body.weekday);
    const { session, weekday } = slot;
    if (liveEnrollment(ctx, student.id, session.id, weekday)) throw conflict('already_enrolled', `${firstName(student)} already has a spot in ${session.name} on ${DAYS[weekday]}s.`);
    const w = waitingRow(ctx, student.id, session.id, weekday);
    if (w) throw conflict('already_waiting', `${firstName(student)} is already number ${position(ctx, w)} on this waitlist.`);
    const check = eligibility(ctx, student, slot.loc);
    if (!check.ok) return { outcome: 'blocked', code: check.code, message: check.message };
    const id = Number(ctx.db.prepare('INSERT INTO waitlist (student_id, session_id, weekday, created_by, created_at) VALUES (?,?,?,?,?)')
      .run(student.id, session.id, weekday, actor.id, ctx.clock.now()).lastInsertRowid);
    promoteSlot(ctx, session.id, weekday); // a seat may already be free
    const e = liveEnrollment(ctx, student.id, session.id, weekday);
    if (e) return { outcome: 'enrolled', enrollment: e };
    const row = ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
    return { outcome: 'waitlisted', waitlist: row, position: position(ctx, row) };
  });
}

function leaveWaitlist(ctx, actor, id) {
  const w = ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(Number(id));
  if (!w) throw notFound('That waitlist spot no longer exists.');
  assertParentOf(ctx, actor, w.student_id);
  if (w.status !== 'waiting') throw conflict('not_waiting', 'That student is no longer on this waitlist.');
  ctx.db.prepare("UPDATE waitlist SET status = 'removed', resolved_at = ? WHERE id = ?").run(ctx.clock.now(), w.id);
  return ctx.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(w.id);
}

// EN-6 / EN-7: drop any time, no cutoff or penalty. The seat goes to the line.
function drop(ctx, actor, id) {
  const e0 = ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(id));
  if (!e0) throw notFound('That enrollment no longer exists.');
  assertParentOf(ctx, actor, e0.student_id);
  return tx(ctx.db, () => {
    const e = ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e0.id);
    if (e.status === 'dropped') throw conflict('not_enrolled', 'That session was already dropped.');
    ctx.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(ctx.clock.now(), e.id);
    promoteSlot(ctx, e.session_id, e.weekday);
    return ctx.db.prepare('SELECT * FROM enrollments WHERE id = ?').get(e.id);
  });
}

// ---------- student requests (EN-3, D-17) ----------

const getRequest = (ctx, id) => ctx.db.prepare('SELECT * FROM enrollment_requests WHERE id = ?').get(Number(id));

function createRequest(ctx, actor, body) {
  const student = getStudent(ctx, actor.id);
  return tx(ctx.db, () => {
    const slot = loadSlot(ctx, student, body.sessionId, body.weekday);
    const { session, weekday } = slot;
    if (liveEnrollment(ctx, student.id, session.id, weekday)) throw conflict('already_enrolled', `You already have a spot in ${session.name} on ${DAYS[weekday]}s.`);
    if (waitingRow(ctx, student.id, session.id, weekday)) throw conflict('already_waiting', `You're already on the waitlist for ${session.name} on ${DAYS[weekday]}s.`);
    if (ctx.db.prepare("SELECT 1 FROM enrollment_requests WHERE student_id = ? AND session_id = ? AND weekday = ? AND status = 'pending'").get(student.id, session.id, weekday)) {
      throw conflict('already_requested', 'You already asked for this one. A parent will see it in their Schedule.');
    }
    const id = Number(ctx.db.prepare('INSERT INTO enrollment_requests (student_id, session_id, weekday, created_at) VALUES (?,?,?,?)')
      .run(student.id, session.id, weekday, ctx.clock.now()).lastInsertRowid);
    notify.send(ctx, notify.parentsOf(ctx, student.id), {
      kind: 'enrollment_request',
      title: `${firstName(student)} asked to join ${session.name}`,
      body: `${when(session, weekday)} at ${slot.loc.name}. Approve or decline it in Schedule.`,
      refType: 'enrollment_request', refId: id,
    });
    return getRequest(ctx, id);
  });
}

// A pending request whose slot is gone (the session was cancelled, its day was
// removed, or its term is over) can never be approved. It is closed with the
// real reason: status 'declined' with no parent as decider (decided_by NULL),
// the reason in outcome_message, and the student told why. Nobody says a parent
// declined it. Runs as a job, and before requests are listed or decided.
function goneReason(ctx, r) {
  const session = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.session_id);
  if (session.status !== 'active') return `The center cancelled ${session.name}.`;
  if (!session.weekdays.split(',').map(Number).includes(r.weekday)) return `${session.name} no longer meets on ${DAYS[r.weekday]}s.`;
  const term = ctx.db.prepare('SELECT name, end_date FROM terms WHERE id = ?').get(session.term_id);
  if (term.end_date < today(ctx, getLocation(ctx, session.location_id))) return `${term.name} has ended.`;
  return null;
}

function closeRequest(ctx, r, reason) {
  const session = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.session_id);
  ctx.db.prepare("UPDATE enrollment_requests SET status = 'declined', decided_by = NULL, decided_at = ?, outcome_message = ? WHERE id = ?")
    .run(ctx.clock.now(), reason, r.id);
  notify.send(ctx, [r.student_id], {
    kind: 'enrollment_request_closed',
    title: `Your request for ${session.name} on ${DAYS[r.weekday]}s was closed`,
    body: `${reason} Your request can't go ahead, so it was closed. You can ask for a different session in Schedule.`,
    refType: 'enrollment_request', refId: r.id,
  });
}

// Closes every gone request among `studentIds` (every student when omitted).
function closeGoneRequests(ctx, studentIds) {
  return tx(ctx.db, () => {
    const rows = studentIds
      ? studentIds.length ? ctx.db.prepare(`SELECT * FROM enrollment_requests WHERE status = 'pending' AND student_id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds) : []
      : ctx.db.prepare("SELECT * FROM enrollment_requests WHERE status = 'pending'").all();
    let n = 0;
    for (const r of rows) {
      const reason = goneReason(ctx, r);
      if (reason) { closeRequest(ctx, r, reason); n++; }
    }
    return n;
  });
}

function decide(ctx, actor, id, approve) {
  const r0 = getRequest(ctx, id);
  if (!r0) throw notFound('That request no longer exists.');
  assertParentOf(ctx, actor, r0.student_id);
  return tx(ctx.db, () => {
    const r = getRequest(ctx, r0.id);
    if (r.status === 'declined' && r.decided_by == null) {
      throw conflict('already_decided', `This request was already closed: ${r.outcome_message}`);
    }
    if (r.status !== 'pending') {
      const who = r.decided_by ? ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(r.decided_by).name : 'Someone';
      throw conflict('already_decided', `${firstName({ name: who })} already ${r.status} this request.`);
    }
    const now = ctx.clock.now();
    const student = getStudent(ctx, r.student_id);
    const gone = goneReason(ctx, r);
    if (gone) {
      closeRequest(ctx, r, gone);
      return {
        request: getRequest(ctx, r.id), outcome: 'closed', code: 'request_closed',
        message: `${gone} ${firstName(student)}'s request can't go ahead, so it was closed, and ${firstName(student)} has been told why.`,
      };
    }
    const session = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.session_id);
    const by = firstName(actor);
    if (!approve) {
      ctx.db.prepare("UPDATE enrollment_requests SET status = 'declined', decided_by = ?, decided_at = ? WHERE id = ?").run(actor.id, now, r.id);
      notify.send(ctx, [student.id], {
        kind: 'enrollment_request_declined',
        title: `${by} declined your request for ${session.name}`,
        body: `${when(session, r.weekday)}. Talk with ${by} if you'd like to ask again.`,
        refType: 'enrollment_request', refId: r.id,
      });
      return { request: getRequest(ctx, r.id), outcome: 'declined' };
    }
    ctx.db.prepare("UPDATE enrollment_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(actor.id, now, r.id);
    const slot = loadSlot(ctx, student, r.session_id, r.weekday);
    const out = attempt(ctx, actor, student, slot, 'request', notify.parentsOf(ctx, student.id));
    // out.message is the parent's (the reply); the student is told in their own
    // words, never to drop or join a waitlist, which only a parent can do (L54).
    const waiting = out.outcome === 'full' && waitingRow(ctx, student.id, session.id, r.weekday);
    const fullTail = waiting
      ? `You're number ${position(ctx, waiting)} on its waitlist and will be enrolled automatically when a seat opens.`
      : 'A parent can add you to the waitlist.';
    const toStudent = out.outcome === 'blocked' ? forStudent(eligibility(ctx, student, slot.loc))
      : out.outcome === 'full' ? `${session.name} on ${DAYS[r.weekday]}s is full. ${fullTail}` : null;
    ctx.db.prepare('UPDATE enrollment_requests SET outcome = ?, outcome_message = ? WHERE id = ?').run(out.outcome, toStudent, r.id);
    // Nothing retries a blocked approval (D-17), so nothing says "yet" (L29).
    const titles = {
      enrolled: `${by} approved your request: you're enrolled in ${session.name}`,
      blocked: `${by} approved your request, but you couldn't be enrolled`,
      full: `${by} approved your request, but ${session.name} is full`,
    };
    const bodies = {
      enrolled: `${when(session, r.weekday)} at ${slot.loc.name}, every week through ${longDate(slot.term.end_date)}.`,
      blocked: toStudent,
      full: `${when(session, r.weekday)}. ${fullTail}`,
    };
    notify.send(ctx, [student.id], {
      kind: 'enrollment_request_approved', title: titles[out.outcome], body: bodies[out.outcome],
      refType: 'enrollment_request', refId: r.id,
    });
    // The parents keep a record of a blocked approval too (L29): their Inbox, and
    // Schedule until the student holds that slot. An enrolled one is told by notifyEnrolled.
    if (out.outcome === 'blocked') {
      notify.send(ctx, notify.parentsOf(ctx, r.student_id), {
        kind: 'enrollment_request_blocked',
        title: `${by} approved ${firstName(student)}'s request for ${session.name}, but ${firstName(student)} couldn't be enrolled`,
        body: `${when(session, r.weekday)}. ${out.message}`,
        refType: 'enrollment_request', refId: r.id,
      });
    }
    return Object.assign({ request: getRequest(ctx, r.id) }, out);
  });
}

// Requests a parent (pending for linked students, plus the last 14 days of
// decisions) or a student (their own) can see. Pending ones carry a pre-check
// so the parent knows before approving whether it will go through; an approved
// one that was blocked carries the same check, so Schedule can say what is in
// the way now (L29).
function listRequests(ctx, user) {
  const ids = user.role === 'parent' ? auth.linkedStudentIds(ctx, user.id) : [user.id];
  if (!ids.length) return [];
  closeGoneRequests(ctx, ids);
  const since = ctx.clock.now() - 14 * 864e5;
  const rows = ctx.db.prepare(`SELECT r.*, u.name AS student_name, s.name AS session_name, s.start_time, s.end_time, s.location_id,
      d.name AS decided_by_name
    FROM enrollment_requests r JOIN users u ON u.id = r.student_id JOIN sessions s ON s.id = r.session_id
    LEFT JOIN users d ON d.id = r.decided_by
    WHERE r.student_id IN (${ids.map(() => '?').join(',')}) AND (r.status = 'pending' OR r.decided_at >= ?)
    ORDER BY r.status = 'pending' DESC, r.created_at DESC, r.id DESC`).all(...ids, since);
  return rows.map(r => {
    const out = Object.assign({}, r, { timezone: getLocation(ctx, r.location_id).timezone });
    if (r.status === 'pending' || r.outcome === 'blocked') out.check =precheck(ctx, getStudent(ctx, r.student_id), r.session_id, r.weekday);
    return out;
  });
}

function precheck(ctx, student, sessionId, weekday) {
  let slot;
  try { slot = loadSlot(ctx, student, sessionId, weekday); } catch (e) { return { ok: false, code: e.code, message: e.message }; }
  const c = eligibility(ctx, student, slot.loc);
  if (!c.ok) return { ok: false, code: c.code, message: c.message };
  const full = seatsTaken(ctx, sessionId, slot.weekday) >= slot.session.capacity;
  return { ok: true, code: full ? 'full' : 'ok', full, message: full ? `${slot.session.name} is full right now. Approving lets you add ${firstName(student)} to the waitlist.` : null };
}

// ---------- reads ----------

// Membership summary for display (MB-3 is the membership module's; this is the
// part enrollment needs: can this student add a session right now, and why not).
function membershipSummary(ctx, student, loc) {
  const c = eligibility(ctx, student, loc);
  return {
    status: c.membership ? c.membership.status : null,
    weekly_cap: c.membership ? c.membership.weekly_cap : 0,
    start_date: c.membership ? c.membership.start_date : null,
    expires_on: c.membership ? c.membership.expires_on : null,
    used: c.used, can_add: c.ok, code: c.code, message: c.message,
  };
}

const slotCols = `s.name, s.start_time, s.end_time, s.status AS session_status, s.location_id,
  t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end`;

// One student's weekly sessions and waitlist spots in current and upcoming terms.
function studentDetail(ctx, student) {
  const loc = getLocation(ctx, student.location_id);
  const d = today(ctx, loc);
  const enrollments = ctx.db.prepare(`SELECT e.id, e.session_id, e.weekday, e.status, e.source, e.created_at, ${slotCols}
    FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN terms t ON t.id = s.term_id
    WHERE e.student_id = ? AND e.status IN ('active','paused') AND t.end_date >= ?
    ORDER BY e.weekday, s.start_time, s.name`).all(student.id, d);
  const waitlist = ctx.db.prepare(`SELECT w.id, w.session_id, w.weekday, w.priority, w.created_at, ${slotCols}
    FROM waitlist w JOIN sessions s ON s.id = w.session_id JOIN terms t ON t.id = s.term_id
    WHERE w.student_id = ? AND w.status = 'waiting' AND t.end_date >= ?
    ORDER BY w.weekday, s.start_time`).all(student.id, d)
    .map(w => Object.assign(w, { position: position(ctx, w), in_line: line(ctx, w.session_id, w.weekday).length }));
  return {
    id: student.id, name: student.name, location: loc,
    membership: membershipSummary(ctx, student, loc), enrollments, waitlist,
  };
}

function familyStudents(ctx, user) {
  const ids = user.role === 'parent' ? auth.linkedStudentIds(ctx, user.id) : [user.id];
  return ids.map(id => studentDetail(ctx, getStudent(ctx, id))).sort((a, b) => a.name.localeCompare(b.name));
}

// The catalog: every weekly slot at the student's home location (D-1) in the
// current or an upcoming term, with seats left, line length, where this
// student stands, and can_add: whether Enroll / Join waitlist will get past the
// membership check (the one enroll, the waitlist and approvals all run).
function catalog(ctx, student) {
  const loc = getLocation(ctx, student.location_id);
  const d = today(ctx, loc);
  const sessions = ctx.db.prepare(`SELECT s.*, t.name AS term_name, t.start_date AS term_start, t.end_date AS term_end
    FROM sessions s JOIN terms t ON t.id = s.term_id
    WHERE s.location_id = ? AND s.status = 'active' AND t.end_date >= ?`).all(loc.id, d);
  const pending = new Set(ctx.db.prepare("SELECT session_id || ':' || weekday AS k FROM enrollment_requests WHERE student_id = ? AND status = 'pending'")
    .all(student.id).map(r => r.k));
  const membership = membershipSummary(ctx, student, loc);
  const slots = [];
  for (const s of sessions) {
    for (const wd of s.weekdays.split(',').map(Number)) {
      const taken = seatsTaken(ctx, s.id, wd);
      const live = liveEnrollment(ctx, student.id, s.id, wd);
      const w = !live && waitingRow(ctx, student.id, s.id, wd);
      slots.push({
        session_id: s.id, weekday: wd, name: s.name, start_time: s.start_time, end_time: s.end_time,
        term_name: s.term_name, term_start: s.term_start, term_end: s.term_end,
        capacity: s.capacity, seats_left: Math.max(0, s.capacity - taken), waiting: line(ctx, s.id, wd).length,
        mine: live ? live.status === 'active' ? 'enrolled' : 'paused' : w ? 'waiting' : pending.has(s.id + ':' + wd) ? 'requested' : null,
        enrollment_id: live ? live.id : null, position: w ? position(ctx, w) : null,
        can_add: membership.can_add && !live && !w,
      });
    }
  }
  slots.sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time) || a.name.localeCompare(b.name));
  return { student: { id: student.id, name: student.name }, location: loc, membership, slots };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Pauses begin and end in the membership module (D-16). Every status change is
// logged as it happens by the trigger in schema/040_enrollment.sql (D-26).
// The status an enrollment had at instant t, from its logged changes (oldest
// first). Before the first change it had that change's old status; with none
// logged it has had its current one all along.
function statusAt(e, changes, t) {
  let s = changes.length ? changes[0].from_status : e.status;
  for (const c of changes) if (c.at <= t) s = c.to_status;
  return s;
}

// D-32: the membership record in force at instant t, rebuilt from its audit rows
// (D-26) the way attendance rebuilds validity: before a change, the record it
// replaced. null before the record existed, or with none on file.
function membershipAt(ctx, studentId) {
  const m = ctx.db.prepare('SELECT id, status, start_date, expires_on FROM memberships WHERE student_id = ?').get(studentId);
  if (!m) return () => null;
  const changes = ctx.db.prepare("SELECT at, detail FROM audit_log WHERE target_type = 'membership' AND target_id = ? ORDER BY at, id")
    .all(m.id).map(r => Object.assign({ at: r.at }, JSON.parse(r.detail || '{}'))).filter(c => 'before' in c);
  return t => { for (const c of changes) if (t < c.at) return c.before; return m; };
}

// EN-7: every weekly occurrence in [from, to] with its status. Absent is
// computed here (D-15), never stored, and carries no penalty. Each week is
// judged by the enrollment's status when it started: paused then is paused
// (even if the membership has since been renewed), active then and missed is
// absent (even if the spot is paused now). Each date uses the session times it
// had that day (D-34), and a week before the membership's start date is
// not_started, never absent (D-32).
function schedule(ctx, student, q) {
  const loc = getLocation(ctx, student.location_id);
  const from = q.from || time.weekStart(today(ctx, loc));
  const to = q.to || time.addDays(from, 6);
  if (!ISO.test(from) || !ISO.test(to) || !DateTime.fromISO(from).isValid || !DateTime.fromISO(to).isValid || from > to) {
    throw bad('bad_range', 'Pick a start date on or before the end date.');
  }
  // A year at most (366 days counting both ends), measured without stepping
  // through the days, so 0001-01-01 to 9999-12-31 is refused at once.
  if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > 365) throw bad('bad_range', 'Pick a range of a year or less.');
  const now = ctx.clock.now();
  const enrollments = ctx.db.prepare(`SELECT e.*, ${slotCols} FROM enrollments e JOIN sessions s ON s.id = e.session_id
    JOIN terms t ON t.id = s.term_id WHERE e.student_id = ? ORDER BY e.id`).all(student.id);
  const closures = new Map(ctx.db.prepare('SELECT date, reason FROM closures WHERE location_id = ? AND date BETWEEN ? AND ?')
    .all(loc.id, from, to).map(c => [c.date, c.reason]));
  const visits = ctx.db.prepare('SELECT * FROM visits WHERE student_id = ? AND local_date BETWEEN ? AND ?').all(student.id, from, to);
  const changes = new Map(enrollments.map(e => [e.id, []]));
  for (const c of ctx.db.prepare(`SELECT l.enrollment_id, l.from_status, l.to_status, l.at FROM enrollment_status_log l
    JOIN enrollments e ON e.id = l.enrollment_id WHERE e.student_id = ? ORDER BY l.at, l.id`).all(student.id)) changes.get(c.enrollment_id).push(c);
  const hist = sessionTimes.history(ctx);
  const membership = membershipAt(ctx, student.id);
  const out = [], seen = new Set();
  for (const e of enrollments) {
    const lo = from > e.term_start ? from : e.term_start;
    const hi = to < e.term_end ? to : e.term_end;
    if (lo > hi) continue;
    for (const d of time.datesBetween(lo, hi)) {
      if (time.weekdayOfDate(d) !== e.weekday) continue;
      const hours = sessionTimes.timesOn(hist, e.session_id, d, e);
      const start = time.toMs(loc, d, hours.start_time), end = time.toMs(loc, d, hours.end_time);
      const during = x => x.check_in_at < end && (x.check_out_at == null || x.check_out_at > start);
      const own = visits.find(x => x.local_date === d && (x.session_id === e.session_id
        || (x.session_id == null && during(x))));
      // It counts if they came, or were enrolled from its start to its end.
      const began = e.created_at <= start || !!own;
      const lasted = e.ended_at == null || e.ended_at >= end || (!!own && e.ended_at > start);
      if (!began || !lasted) continue;
      // D-28: one visit through back-to-back sessions counts for every enrolled slot
      // it overlaps there, as attendance counts it.
      const v = own || visits.find(x => x.local_date === d && x.session_id != null && x.location_id === e.location_id && during(x));
      // Cancelling a session ends its enrollments then (ended_at), so `lasted` stops
      // the weeks after it and the ones before stand. With no end on record there
      // is nothing to go on, so only weeks they came to are shown.
      if (e.session_status !== 'active' && e.ended_at == null && !v) continue;
      if (seen.has(d + ':' + e.session_id)) continue; // a slot dropped and taken again
      seen.add(d + ':' + e.session_id);
      const m = membership(start);
      // L33: a spot paused when this occurrence began but restored before it ends
      // (a renewal mid-session) is on again: upcoming while it runs, check-in
      // works. Once it has ended unattended it stays paused, never absent.
      const ch = changes.get(e.id);
      const held = statusAt(e, ch, start) === 'paused' && (now >= end || statusAt(e, ch, now) === 'paused');
      const status = v ? 'attended' : closures.has(d) ? 'closed' : m && d < m.start_date ? 'not_started'
        : held ? 'paused' : now < end ? 'upcoming' : 'absent';
      out.push({
        date: d, weekday: e.weekday, session_id: e.session_id, enrollment_id: e.id, name: e.name,
        start_time: hours.start_time, end_time: hours.end_time, start_at: start, end_at: end, status,
        membership_starts: status === 'not_started' ? m.start_date : null,
        closure_reason: closures.get(d) || null,
        check_in_at: v ? v.check_in_at : null, check_out_at: v ? v.check_out_at : null,
      });
    }
  }
  out.sort((a, b) => a.start_at - b.start_at || a.name.localeCompare(b.name));
  return { student: { id: student.id, name: student.name }, location: loc, from, to, occurrences: out };
}

module.exports = {
  getStudent, enroll, joinWaitlist, leaveWaitlist, drop, createRequest, decide, listRequests,
  familyStudents, catalog, schedule, promoteAll, closeGoneRequests,
};
