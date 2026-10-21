'use strict';
// Attendance and hours (PRD 7): what every visit shows (AT-1), history by week,
// month or term with computed absences (AT-2, D-15), family CSV/PDF exports
// (AT-3), director/HQ reports (AT-4), and who may see what (NF-1).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { test, makeApp, assert, at, ROOT } = require('./lib');

const LA = 'America/Los_Angeles', TOR = 'America/Toronto';
const A = '/api/attendance';

// ISO weekday of a 'YYYY-MM-DD' date (1 = Monday).
const weekdayOf = d => new Date(d + 'T12:00:00Z').getUTCDay() || 7;

// A PDF's objects in file order: { id, dict, data } with each stream inflated.
function pdfObjects(buf) {
  const s = buf.toString('latin1');
  const objs = [];
  const re = /(\d+) 0 obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const at = re.lastIndex, end = s.indexOf('endobj', at), so = s.indexOf('stream', at);
    if (so === -1 || so > end) { objs.push({ id: Number(m[1]), dict: s.slice(at, end) }); re.lastIndex = end; continue; }
    const dict = s.slice(at, so), begin = so + (s.startsWith('stream\r\n', so) ? 8 : 7);
    const len = Number(/\/Length (\d+)/.exec(dict)[1]);
    let data = Buffer.from(s.slice(begin, begin + len), 'latin1');
    if (dict.includes('/FlateDecode')) data = zlib.inflateSync(data);
    objs.push({ id: Number(m[1]), dict, data });
    re.lastIndex = begin + len;
  }
  return objs;
}

// A font's ToUnicode CMap as pdfkit writes it (bfrange arrays): code -> text.
function toUnicode(cmap) {
  const map = new Map();
  const text = hex => String.fromCharCode(...hex.split(/\s+/).filter(Boolean).map(u => parseInt(u, 16)));
  for (const r of cmap.matchAll(/<([0-9a-f]+)> <[0-9a-f]+> \[([^\]]*)\]/gi)) {
    [...r[2].matchAll(/<([^>]*)>/g)].forEach((e, i) => map.set(parseInt(r[1], 16) + i, text(e[1])));
  }
  return map;
}

// The text a PDF shows, in drawing order, whitespace collapsed. pdfkit writes
// text as hex inside TJ arrays in Flate streams: 2-byte glyph codes read
// through the font's ToUnicode map for an embedded font, WinAnsi bytes for a
// built-in one (Helvetica).
// `only` picks which objects' streams to read (default: all).
function pdfText(buf, only = () => true) {
  const objs = pdfObjects(buf);
  const byId = new Map(objs.map(o => [o.id, o]));
  const unicode = new Map(); // font object id -> its ToUnicode map
  for (const o of objs) {
    const ref = /\/ToUnicode (\d+) 0 R/.exec(o.dict);
    if (ref) unicode.set(o.id, toUnicode(byId.get(Number(ref[1])).data.toString('latin1')));
  }
  const fonts = new Map(); // resource name (F1) -> ToUnicode map, or undefined for a built-in font
  for (const o of objs) for (const r of o.dict.matchAll(/\/(F\d+) (\d+) 0 R/g)) fonts.set(r[1], unicode.get(Number(r[2])));
  const dec = new TextDecoder('windows-1252');
  const out = [];
  for (const o of objs) {
    if (!o.data || !only(o)) continue;
    let font;
    for (const t of o.data.toString('latin1').matchAll(/\/(F\d+) [\d.]+ Tf|\[(.*?)\] TJ/g)) {
      if (t[1]) { font = fonts.get(t[1]); continue; }
      out.push([...t[2].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => (font
        ? (x[1].match(/.{4}/g) || []).map(c => font.get(parseInt(c, 16)) ?? '�').join('')
        : dec.decode(Buffer.from(x[1], 'hex')))).join(''));
    }
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

// Each page's text in page order: the page's own content stream, footer included.
function pdfPages(buf) {
  const objs = pdfObjects(buf);
  const byId = new Map(objs.map(o => [o.id, o]));
  const kids = /\/Kids \[([^\]]*)\]/.exec(objs.find(o => /\/Type \/Pages\b/.test(o.dict)).dict)[1];
  return [...kids.matchAll(/(\d+) 0 R/g)].map(k => Number(/\/Contents (\d+) 0 R/.exec(byId.get(Number(k[1])).dict)[1]))
    .map(id => pdfText(buf, o => o.id === id));
}

// What each glyph code of every embedded font stands for (its ToUnicode entries).
const pdfGlyphs = buf => pdfObjects(buf).filter(o => o.data && o.data.includes('beginbfrange'))
  .flatMap(o => [...toUnicode(o.data.toString('latin1')).values()]);

// Every font a PDF uses, as "Subtype BaseFont" without the subset tag.
const pdfFonts = buf => [...new Set(pdfObjects(buf).filter(o => /\/Type \/Font\b/.test(o.dict) && !/CIDFontType/.test(o.dict))
  .map(o => /\/Subtype \/(\w+)/.exec(o.dict)[1] + ' ' + /\/BaseFont \/(?:[A-Z]{6}\+)?([\w-]+)/.exec(o.dict)[1]))].sort();

// RFC 4180 CSV -> rows of cells.
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// One Irvine location with a Fall term and an afternoon Mon/Wed/Fri session
// (1-4pm). One family whose student holds all three weekly slots since Mon Sep 28.
async function world({ term } = {}) {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Irvine', timezone: LA });
  const fall = t.fx.term(loc, term);
  const pm = t.fx.session(loc, { term: fall, name: 'Afternoon Study', weekdays: '1,3,5', start: '13:00', end: '16:00' });
  const fam = t.fx.family(loc);
  const kid = rename(t, fam.student, 'Maya Johnson');
  const slots = {};
  for (const wd of [1, 3, 5]) slots[wd] = enrollSince(t, kid, pm, wd, at(LA, '2026-09-28', '08:00'));
  // A visit to the afternoon session: visit('2026-10-12', '13:02', '15:58')
  const visit = (date, inAt, outAt, o = {}) => {
    const { checked_in_by = null, checked_out_by = null, flag_reason = null, ...extra } = o.extra || {};
    const v = t.fx.visit(o.student || kid, o.location || loc, Object.assign({
      session: o.session === undefined ? pm : o.session, weekday: weekdayOf(date), local_date: date,
      check_in_at: at(o.zone || LA, date, inAt), check_out_at: outAt ? at(o.zone || LA, date, outAt) : null,
      checkout_method: outAt ? 'scan' : null,
    }, extra));
    t.db.prepare('UPDATE visits SET checked_in_by = ?, checked_out_by = ?, flag_reason = ? WHERE id = ?')
      .run(checked_in_by, checked_out_by, flag_reason, v.id);
    return v;
  };
  return { t, loc, term: fall, pm, fam, kid, parent: fam.parent, slots, visit };
}

function rename(t, u, name) {
  t.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
  return Object.assign({}, u, { name });
}
function enrollSince(t, student, session, weekday, createdAt) {
  const e = t.fx.enroll(student, session, weekday);
  t.db.prepare('UPDATE enrollments SET created_at = ? WHERE id = ?').run(createdAt, e.id);
  return e;
}
const closure = (t, loc, date) => t.db.prepare('INSERT INTO closures (location_id, date, reason) VALUES (?,?,?)').run(loc.id, date, 'Closed');
// What a staff change to a membership leaves in the core tables at `when`: the
// record rewritten, and an audit row with the record before and after (MB-2, NF-2).
// The clock moves to `when` too, so the slot changes the membership module makes
// in the same request (setSlots) are stamped at that instant in the status log (D-26).
function staffSetsMembership(t, student, changes, when) {
  t.clock.set(when);
  const keep = m => ({ status: m.status, weekly_cap: m.weekly_cap, start_date: m.start_date, expires_on: m.expires_on });
  const m = t.db.prepare('SELECT * FROM memberships WHERE student_id = ?').get(student.id);
  const after = Object.assign(keep(m), changes);
  t.db.prepare('UPDATE memberships SET status = ?, weekly_cap = ?, start_date = ?, expires_on = ?, updated_at = ? WHERE id = ?')
    .run(after.status, after.weekly_cap, after.start_date, after.expires_on, when, m.id);
  t.db.prepare(`INSERT INTO audit_log (action, target_type, target_id, location_id, detail, at) VALUES ('membership.update', 'membership', ?, ?, ?, ?)`)
    .run(m.id, student.location_id, JSON.stringify({ student_id: student.id, before: keep(m), after }), when);
}
// MB-5: the membership module pauses a student's slots, or brings some back.
const setSlots = (t, status, slots) => slots.forEach(e => t.db.prepare('UPDATE enrollments SET status = ? WHERE id = ?').run(status, e.id));
const pick = (rows, keys) => rows.map(r => Object.fromEntries(keys.map(k => [k, r[k]])));

// ---------------------------------------------------------------- AT-1

test(['AT-1'], 'every visit shows check-in, check-out, total minutes, session and how check-out happened', async () => {
  const w = await world();
  const staff = rename(w.t, w.t.fx.staff(w.loc), 'Chris Ortiz');
  w.visit('2026-10-12', '13:02', '15:58');
  w.visit('2026-10-09', '13:00', '16:00', { extra: { checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' } });
  w.visit('2026-10-07', '13:10', '15:40', { extra: { checkout_method: 'staff', checked_out_by: staff.id } });

  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=month&date=2026-10-14`);
  assert.equal(r.status, 200);
  assert.deepEqual(pick(r.body.visits, ['date', 'session_name', 'check_in_local', 'check_out_local', 'minutes', 'checkout_method', 'timezone']), [
    { date: '2026-10-07', session_name: 'Afternoon Study', check_in_local: '13:10', check_out_local: '15:40', minutes: 150, checkout_method: 'staff', timezone: LA },
    { date: '2026-10-09', session_name: 'Afternoon Study', check_in_local: '13:00', check_out_local: '16:00', minutes: 180, checkout_method: 'auto', timezone: LA },
    { date: '2026-10-12', session_name: 'Afternoon Study', check_in_local: '13:02', check_out_local: '15:58', minutes: 176, checkout_method: 'scan', timezone: LA },
  ]);
  assert.equal(r.body.visits[0].checked_out_by_name, 'Chris Ortiz');
  assert.equal(r.body.visits[1].check_in_at, at(LA, '2026-10-09', '13:00'));
  assert.equal(r.body.totals.minutes, 506);
  assert.equal(r.body.totals.hours, 8.43);
  assert.equal(r.body.totals.visits, 3);
});

test(['AT-1'], 'a visit still in progress has no check-out, total or method yet', async () => {
  const w = await world();
  w.t.clock.set(at(LA, '2026-10-14', '14:00'));
  w.visit('2026-10-14', '12:58', null);
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=week`);
  assert.equal(r.status, 200);
  assert.deepEqual(pick(r.body.visits, ['date', 'check_in_local', 'check_out_local', 'minutes', 'checkout_method']),
    [{ date: '2026-10-14', check_in_local: '12:58', check_out_local: null, minutes: null, checkout_method: null }]);
  assert.equal(r.body.totals.minutes, 0);
});

test(['AT-1', 'AT-3'], 'times are the location\'s own local time: a Toronto visit reads 9:05, not Los Angeles or UTC time', async () => {
  const t = await makeApp();
  const tor = t.fx.location({ name: 'Toronto', timezone: TOR, lat: 43.65, lng: -79.38 });
  const morning = t.fx.session(tor, { name: 'Morning Focus', weekdays: '1,3,5', start: '09:00', end: '11:30' });
  const fam = t.fx.family(tor);
  const kid = rename(t, fam.student, 'Noah Roy');
  t.fx.visit(kid, tor, { session: morning, weekday: 1, local_date: '2026-10-12', check_in_at: at(TOR, '2026-10-12', '09:05'),
    check_out_at: at(TOR, '2026-10-12', '11:25'), checkout_method: 'scan' });

  const r = await t.as(fam.parent).get(`${A}/students/${kid.id}/history?period=week&date=2026-10-12`);
  assert.deepEqual(pick(r.body.visits, ['check_in_local', 'check_out_local', 'minutes', 'timezone']),
    [{ check_in_local: '09:05', check_out_local: '11:25', minutes: 140, timezone: TOR }]);

  const csv = await t.as(fam.parent).get(`${A}/students/${kid.id}/log.csv?from=2026-10-12&to=2026-10-12`);
  assert.deepEqual(parseCsv(csv.body)[1], ['visit', '2026-10-12', 'Noah Roy', 'Toronto', 'Morning Focus', '09:05', '11:25', '140', '2.33', 'scan', TOR]);
  const pdf = await t.as(fam.parent).get(`${A}/students/${kid.id}/log.pdf?from=2026-10-12&to=2026-10-12`);
  assert.ok(pdfText(pdf.body).includes('Mon, Oct 12, 2026 Morning Focus 9:05 AM 11:25 AM 2h 20m Scanned out'), pdfText(pdf.body));
});

// ---------------------------------------------------------------- AT-2

test(['AT-2'], 'week view: Monday to Sunday around the date, with previous and next weeks but never a future one', async () => {
  const w = await world();
  w.visit('2026-10-11', '13:00', '15:00', { session: null });   // Sunday before: last week
  w.visit('2026-10-12', '13:02', '15:58');
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-14`);
  assert.equal(r.status, 200);
  const { kind, from, to, label, prev, next } = r.body.period;
  assert.deepEqual({ kind, from, to, label, prev, next },
    { kind: 'week', from: '2026-10-12', to: '2026-10-18', label: 'Oct 12 – Oct 18, 2026', prev: '2026-10-05', next: null });
  assert.deepEqual(r.body.visits.map(v => v.date), ['2026-10-12']);

  const earlier = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`);
  assert.deepEqual([earlier.body.period.from, earlier.body.period.to, earlier.body.period.next], ['2026-10-05', '2026-10-11', '2026-10-12']);
  assert.deepEqual(earlier.body.visits.map(v => v.date), ['2026-10-11']);

  const dflt = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history`);
  assert.equal(dflt.body.period.kind, 'week');
  assert.equal(dflt.body.period.from, '2026-10-12');
});

test(['AT-2'], 'month view: the calendar month with its totals', async () => {
  const w = await world();
  w.visit('2026-09-30', '13:00', '16:00');
  w.visit('2026-10-02', '13:00', '15:30');
  w.visit('2026-10-12', '13:00', '14:00');
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=month&date=2026-10-14`);
  const { from, to, label, prev, next } = r.body.period;
  assert.deepEqual({ from, to, label, prev, next }, { from: '2026-10-01', to: '2026-10-31', label: 'October 2026', prev: '2026-09-01', next: null });
  assert.deepEqual(r.body.visits.map(v => v.date), ['2026-10-02', '2026-10-12']);
  assert.equal(r.body.totals.visits, 2);
  assert.equal(r.body.totals.minutes, 210);
  assert.equal(r.body.totals.hours, 3.5);

  const sept = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=month&date=2026-09-15`);
  assert.deepEqual([sept.body.period.from, sept.body.period.to, sept.body.period.next], ['2026-09-01', '2026-09-30', '2026-10-01']);
  assert.deepEqual(sept.body.visits.map(v => v.date), ['2026-09-30']);
});

test(['AT-2'], 'term view: the location\'s current term, with the earlier term one step back', async () => {
  const w = await world();
  w.t.fx.term(w.loc, { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' });
  w.visit('2026-08-10', '13:00', '16:00', { session: null });
  w.visit('2026-09-30', '13:00', '16:00');
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=term`);
  assert.equal(r.status, 200);
  const { from, to, label, prev, next } = r.body.period;
  assert.deepEqual({ from, to, label, prev, next }, { from: '2026-08-17', to: '2026-12-18', label: 'Fall 2026', prev: '2026-06-15', next: null });
  assert.deepEqual(r.body.visits.map(v => v.date), ['2026-09-30']);

  const summer = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=term&date=2026-06-15`);
  assert.deepEqual([summer.body.period.label, summer.body.period.next], ['Summer 2026', '2026-08-17']);
  assert.deepEqual(summer.body.visits.map(v => v.date), ['2026-08-10']);

  const bad = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=year`);
  assert.equal(bad.status, 400);
});

test(['AT-2'], 'a location with no term yet says so instead of failing', async () => {
  const t = await makeApp();
  const loc = t.fx.location({ name: 'Arcadia' });
  const fam = t.fx.family(loc);
  const r = await t.as(fam.parent).get(`${A}/students/${fam.student.id}/history?period=term`);
  assert.equal(r.status, 404);
  assert.match(r.body.message, /Arcadia hasn't set up a term yet/);
});

test(['AT-2'], 'absences (D-15): an enrolled session with no visit counts; attended and closure days do not; computed live', async () => {
  const w = await world();
  w.visit('2026-10-05', '13:00', '16:00');   // Mon attended
  closure(w.t, w.loc, '2026-10-09');           // Fri closed
  const url = `${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`;
  const r = await w.t.as(w.parent).get(url);
  assert.deepEqual(pick(r.body.absences, ['date', 'session_name', 'start_time', 'end_time']),
    [{ date: '2026-10-07', session_name: 'Afternoon Study', start_time: '13:00', end_time: '16:00' }]);
  assert.equal(r.body.totals.absences, 1);
  assert.equal(r.body.totals.visits, 1);

  // Never stored: a visit recorded later (a staff fix) clears it on the next read.
  w.visit('2026-10-07', '13:30', '15:00');
  const again = await w.t.as(w.parent).get(url);
  assert.deepEqual(again.body.absences, []);
  assert.equal(again.body.totals.absences, 0);
});

// Staff checking a student in with no session right now ("check in anyway") records
// a visit with no session. When it covers an enrolled session, the student was there.
test(['AT-2', 'AT-3', 'AT-4'], 'a staff check-in with no session that covers an enrolled session clears that day\'s absence in history, files and reports', async () => {
  const w = await world();
  const staff = rename(w.t, w.t.fx.staff(w.loc), 'Chris Ortiz');
  const director = w.t.fx.director(w.loc);
  // Wed Oct 7: checked in by staff at noon with no session, out at 4pm. Mon Oct 5 and Fri Oct 9 she missed.
  w.visit('2026-10-07', '12:00', '16:00', { session: null,
    extra: { checkin_method: 'staff', checked_in_by: staff.id, checkout_method: 'staff', checked_out_by: staff.id } });
  const p = w.t.as(w.parent);
  const missed = ['2026-10-05', '2026-10-09'];

  const h = await p.get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`);
  assert.equal(h.status, 200);
  assert.deepEqual(pick(h.body.visits, ['date', 'session_name', 'check_in_local', 'check_out_local', 'minutes', 'checkout_method']),
    [{ date: '2026-10-07', session_name: null, check_in_local: '12:00', check_out_local: '16:00', minutes: 240, checkout_method: 'staff' }]);
  assert.deepEqual(h.body.absences.map(a => a.date), missed);
  assert.deepEqual([h.body.totals.visits, h.body.totals.minutes, h.body.totals.absences], [1, 240, 2]);

  const q = 'from=2026-10-05&to=2026-10-09';
  const csv = await p.get(`${A}/students/${w.kid.id}/log.csv?${q}`);
  assert.equal(csv.status, 200);
  assert.deepEqual(parseCsv(csv.body).slice(1), [
    ['absent', '2026-10-05', 'Maya Johnson', 'Irvine', 'Afternoon Study', '', '', '', '', '', LA],
    ['visit', '2026-10-07', 'Maya Johnson', 'Irvine', '', '12:00', '16:00', '240', '4.00', 'staff', LA],
    ['absent', '2026-10-09', 'Maya Johnson', 'Irvine', 'Afternoon Study', '', '', '', '', '', LA],
    ['total', '2026-10-05 to 2026-10-09', 'Maya Johnson', 'Irvine', '', '', '', '240', '4.00', '', ''],
  ]);

  const pdf = pdfText((await p.get(`${A}/students/${w.kid.id}/log.pdf?${q}`)).body);
  assert.ok(pdf.includes('1 Visits 4.00 Total hours · 4h 0m 2 Absences'), pdf);
  assert.ok(pdf.includes('Wed, Oct 7, 2026 No session 12:00 PM 4:00 PM 4h 0m By staff'), pdf);
  assert.ok(pdf.includes('Fri, Oct 9, 2026 Afternoon Study 1:00 PM – 4:00 PM'), pdf);
  assert.ok(!pdf.includes('Wed, Oct 7, 2026 Afternoon Study'), pdf);

  const d = w.t.as(director);
  const rep = await d.get(`${A}/report?${q}`);
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.body.absences.map(a => [a.date, a.student_name]), missed.map(x => [x, 'Maya Johnson']));
  assert.deepEqual([rep.body.totals.visits, rep.body.totals.minutes, rep.body.totals.absences], [1, 240, 2]);
  assert.deepEqual(rep.body.by_student.map(s => [s.student_name, s.visits, s.minutes, s.absences]), [['Maya Johnson', 1, 240, 2]]);
  const rcsv = parseCsv((await d.get(`${A}/report.csv?${q}`)).body);
  assert.deepEqual(rcsv.filter(x => x[0] === 'absent').map(x => x[1]), missed);
});

test(['AT-2'], 'another visit clears an absence only if it overlaps the session at that location: a check-in with no session, or (R2) a visit for another enrolled session that runs into it', async () => {
  const w = await world();
  const lunch = w.t.fx.session(w.loc, { term: w.term, name: 'Lunch Club', weekdays: '1', start: '12:00', end: '13:30' });
  enrollSince(w.t, w.kid, lunch, 1, at(LA, '2026-09-28', '08:00'));
  const arcadia = w.t.fx.location({ name: 'Arcadia', lat: 34.14, lng: -118.03 });
  w.visit('2026-10-05', '12:00', '16:00', { session: null, location: arcadia }); // at another location
  w.visit('2026-10-07', '16:00', '17:00', { session: null });  // came just as the session ended
  w.visit('2026-10-09', '10:00', '13:00', { session: null });  // left just as it began
  w.visit('2026-10-12', '12:00', '13:30', { session: lunch }); // Lunch Club, which runs into the afternoon session: one visit for both (R2)
  w.visit('2026-10-14', '12:30', null, { session: null });     // still here at 4:30pm
  w.t.clock.set(at(LA, '2026-10-14', '16:30'));
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log?from=2026-10-05&to=2026-10-14`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.absences.map(a => [a.date, a.session_name]), [
    ['2026-10-05', 'Lunch Club'], ['2026-10-05', 'Afternoon Study'], ['2026-10-07', 'Afternoon Study'],
    ['2026-10-09', 'Afternoon Study']]);
  assert.equal(r.body.totals.absences, 4);
});

test(['AT-2'], 'absences count only sessions that have ended, and only after the family enrolled', async () => {
  const w = await world();
  const url = d => `${A}/students/${w.kid.id}/history?period=week&date=${d}`;
  // Wed Oct 14, 10:00: Monday is over; today's 1-4pm session hasn't happened; Friday is ahead.
  assert.deepEqual((await w.t.as(w.parent).get(url('2026-10-14'))).body.absences.map(a => a.date), ['2026-10-12']);
  w.t.clock.set(at(LA, '2026-10-14', '16:30'));
  assert.deepEqual((await w.t.as(w.parent).get(url('2026-10-14'))).body.absences.map(a => a.date), ['2026-10-12', '2026-10-14']);
  // Enrolled Mon Sep 28 at 8am: the week before has nothing to miss; that week has all three.
  assert.deepEqual((await w.t.as(w.parent).get(url('2026-09-23'))).body.absences, []);
  assert.deepEqual((await w.t.as(w.parent).get(url('2026-09-30'))).body.absences.map(a => a.date), ['2026-09-28', '2026-09-30', '2026-10-02']);
});

test(['AT-2'], 'absences stop at the end of the term and at the day a slot was dropped', async () => {
  const w = await world({ term: { name: 'Short term', start: '2026-08-17', end: '2026-10-07' } });
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-10-05', '2026-10-07']);

  const w2 = await world();
  w2.t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(at(LA, '2026-10-06', '12:00'), w2.slots[3].id);
  const r2 = await w2.t.as(w2.parent).get(`${A}/students/${w2.kid.id}/history?period=week&date=2026-10-07`);
  assert.deepEqual(r2.body.absences.map(a => a.date), ['2026-10-05', '2026-10-09']);
});

test(['AT-2'], 'absences around an expired membership (D-15, D-16): misses before it lapsed still count; the paused weeks never do, even after renewal', async () => {
  const w = await world();
  const { t, kid } = w;
  const all = Object.values(w.slots);
  t.fx.membership(kid, { expires: '2026-10-02' });   // the last valid day is Fri Oct 2
  w.visit('2026-09-30', '13:00', '16:00');
  // Just after midnight the expiry job pauses all three slots.
  t.clock.set(at(LA, '2026-10-03', '00:05'));
  setSlots(t, 'paused', all);
  const url = `${A}/students/${kid.id}/log?from=2026-09-28&to=2026-10-16`;
  t.clock.set(at(LA, '2026-10-08', '18:00'));
  const paused = await t.as(w.parent).get(url);
  assert.deepEqual(paused.body.absences.map(a => a.date), ['2026-09-28', '2026-10-02']);
  assert.equal(paused.body.totals.absences, 2);

  // Renewed Mon Oct 12 at 9am: the slots come back, and Maya comes that afternoon.
  staffSetsMembership(t, kid, { expires_on: '2027-06-30' }, at(LA, '2026-10-12', '09:00'));
  setSlots(t, 'active', all);
  w.visit('2026-10-12', '13:00', '16:00');
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const back = await t.as(w.parent).get(url);
  assert.deepEqual(back.body.absences.map(a => a.date), ['2026-09-28', '2026-10-02', '2026-10-14', '2026-10-16']);
  assert.equal(back.body.totals.absences, 4);
  const week = await t.as(w.parent).get(`${A}/students/${kid.id}/history?period=week&date=2026-10-07`);
  assert.deepEqual(week.body.absences, []);
});

test(['AT-2'], 'absences around a membership set inactive (D-15, D-16): count up to that moment; a slot still paused after reactivation adds none', async () => {
  const w = await world();
  const { t, kid } = w;
  w.visit('2026-09-30', '13:00', '16:00');
  // Staff set it inactive on Wed Oct 7 at 2pm, in the middle of that afternoon's session.
  // That session began while the slot was active, so it counts like the ones before (D-26).
  staffSetsMembership(t, kid, { status: 'inactive' }, at(LA, '2026-10-07', '14:00'));
  setSlots(t, 'paused', Object.values(w.slots));
  const url = `${A}/students/${kid.id}/log?from=2026-09-28&to=2026-10-16`;
  t.clock.set(at(LA, '2026-10-08', '12:00'));
  assert.deepEqual((await t.as(w.parent).get(url)).body.absences.map(a => a.date), ['2026-09-28', '2026-10-02', '2026-10-05', '2026-10-07']);

  // Active again Fri Oct 9 at 8am with a weekly limit of 2: Monday and Wednesday
  // come back; Friday stays paused (over the limit), so its Oct 9 and Oct 16 are not absences.
  staffSetsMembership(t, kid, { status: 'active', weekly_cap: 2 }, at(LA, '2026-10-09', '08:00'));
  setSlots(t, 'active', [w.slots[1], w.slots[3]]);
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const r = await t.as(w.parent).get(url);
  assert.deepEqual(r.body.absences.map(a => [a.date, a.session_name]), [['2026-09-28', 'Afternoon Study'], ['2026-10-02', 'Afternoon Study'],
    ['2026-10-05', 'Afternoon Study'], ['2026-10-07', 'Afternoon Study'], ['2026-10-12', 'Afternoon Study'], ['2026-10-14', 'Afternoon Study']]);
  assert.equal(r.body.totals.absences, 6);
});

test(['AT-2'], 'a slot kept paused over the weekly limit adds no absences until it comes back, as the status log records it (D-16a, D-26)', async () => {
  const w = await world();
  const { t, kid } = w;
  // Inactive Wed Oct 7 at 2pm. Active again Fri Oct 9 at 8am with a weekly limit of 2:
  // Monday and Wednesday come back, Friday is kept paused.
  staffSetsMembership(t, kid, { status: 'inactive' }, at(LA, '2026-10-07', '14:00'));
  setSlots(t, 'paused', Object.values(w.slots));
  staffSetsMembership(t, kid, { status: 'active', weekly_cap: 2 }, at(LA, '2026-10-09', '08:00'));
  setSlots(t, 'active', [w.slots[1], w.slots[3]]);
  // Tue Oct 13 at 9am the limit goes back to 3, and Friday comes back.
  staffSetsMembership(t, kid, { weekly_cap: 3 }, at(LA, '2026-10-13', '09:00'));
  setSlots(t, 'active', [w.slots[5]]);
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const r = await t.as(w.parent).get(`${A}/students/${kid.id}/log?from=2026-10-05&to=2026-10-16`);
  // Wed Oct 7 began before the pause, so it was missed. Fri Oct 9 was on hold, not missed,
  // though the membership was valid that day. Fri Oct 16 was missed.
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14', '2026-10-16']);
  assert.equal(r.body.totals.absences, 5);
  // The director's report counts the same weeks.
  const rep = await t.as(t.fx.director(w.loc)).get(`${A}/report?from=2026-10-05&to=2026-10-16`);
  assert.deepEqual(rep.body.absences.map(a => a.date), ['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14', '2026-10-16']);
});

test(['AT-2'], 'a slot paused with nothing in the status log (data from before the log) stops counting when the membership last lapsed', async () => {
  const w = await world();
  const { t } = w;
  const fam = t.fx.family(w.loc);
  const leo = rename(t, fam.student, 'Leo Garcia');
  // Imported already paused, so no status change was ever logged for it.
  const mon = t.fx.enroll(leo, w.pm, 1, { status: 'paused' });
  t.db.prepare('UPDATE enrollments SET created_at = ? WHERE id = ?').run(at(LA, '2026-09-28', '08:00'), mon.id);
  staffSetsMembership(t, leo, { status: 'inactive' }, at(LA, '2026-10-07', '14:00'));
  staffSetsMembership(t, leo, { status: 'active' }, at(LA, '2026-10-09', '08:00')); // valid again; the slot stays paused
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const r = await t.as(fam.parent).get(`${A}/students/${leo.id}/log?from=2026-09-28&to=2026-10-16`);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-09-28', '2026-10-05']);
});

test(['AT-2'], 'a slot with nothing in the status log that came back after a lapse: the membership\'s history alone says which weeks were paused, each judged when it began (D-16, D-26)', async () => {
  const w = await world();
  const { t, kid } = w;
  // Paused and restored before the status log existed, so the slots read active throughout.
  // Inactive Wed Oct 7 at 2pm and active again Mon Oct 12 at 2pm, both partway through a session:
  // Wednesday began while valid, so it's missed; Monday began while not valid, so it isn't.
  staffSetsMembership(t, kid, { status: 'inactive' }, at(LA, '2026-10-07', '14:00'));
  staffSetsMembership(t, kid, { status: 'active' }, at(LA, '2026-10-12', '14:00'));
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const r = await t.as(w.parent).get(`${A}/students/${kid.id}/log?from=2026-10-05&to=2026-10-16`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-10-05', '2026-10-07', '2026-10-14', '2026-10-16']);
});

// D-32: a membership is not active before its start date, so nothing before it is missed.
test(['AT-2'], 'a membership renewed on Oct 14 to start Mon Nov 2: no absences before Nov 2, even for slots left active, and the weeks from Nov 2 count (D-32)', async () => {
  const w = await world();
  const { t, kid } = w;
  const all = Object.values(w.slots);
  t.fx.membership(kid, { expires: '2026-10-05' }); // the last valid day is Mon Oct 5
  t.clock.set(at(LA, '2026-10-06', '00:05'));
  setSlots(t, 'paused', all);
  // Wed Oct 14 at 10am staff renew it from Mon Nov 2; the slots read active from then on
  // (as a save before this rule left them), though the membership hasn't started.
  staffSetsMembership(t, kid, { start_date: '2026-11-02', expires_on: '2027-06-30' }, at(LA, '2026-10-14', '10:00'));
  setSlots(t, 'active', all);
  t.clock.set(at(LA, '2026-11-06', '17:00'));
  const url = `${A}/students/${kid.id}/log?from=2026-09-28&to=2026-11-06`;
  const r = await t.as(w.parent).get(url);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05', '2026-11-02', '2026-11-04', '2026-11-06']);
  const rep = await t.as(t.fx.director(w.loc)).get(`${A}/report?from=2026-10-12&to=2026-10-30`);
  assert.deepEqual(rep.body.absences, []);
});

test(['AT-2'], 'a membership set up with a start date after the slots were made counts no absences before that day, and counts the start date itself (D-32)', async () => {
  const w = await world();
  const { t, kid } = w;
  t.fx.membership(kid, { start: '2026-10-12', expires: '2027-06-30' }); // no change logged: the record alone says when it starts
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const r = await t.as(w.parent).get(`${A}/students/${kid.id}/log?from=2026-09-28&to=2026-10-16`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-10-12', '2026-10-14', '2026-10-16']);
  assert.equal(r.body.totals.absences, 3);
});

test(['AT-2'], 'a start date moved ahead and then back: only the days it was really not started go uncounted (D-32)', async () => {
  const w = await world();
  const { t, kid } = w;
  // Mon Oct 5 at 8am the start moves to Nov 2; Mon Oct 12 at 9am it moves back to Oct 12.
  staffSetsMembership(t, kid, { start_date: '2026-11-02' }, at(LA, '2026-10-05', '08:00'));
  staffSetsMembership(t, kid, { start_date: '2026-10-12' }, at(LA, '2026-10-12', '09:00'));
  t.clock.set(at(LA, '2026-10-16', '17:00'));
  const r = await t.as(w.parent).get(`${A}/students/${kid.id}/log?from=2026-09-28&to=2026-10-16`);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-12', '2026-10-14', '2026-10-16']);
});

// D-26: the enrollment schedule judges each week by the slot's state when it began,
// so a session that was under way when the slot was paused is absent if missed.
test(['AT-2', 'AT-3', 'AT-4'], 'a membership set inactive at 2pm during a 1-4pm session she missed: that day is absent once the session ends, in history, files and reports (D-15, D-26)', async () => {
  const w = await world();
  const { t, kid } = w;
  staffSetsMembership(t, kid, { status: 'inactive' }, at(LA, '2026-10-07', '14:00'));
  setSlots(t, 'paused', Object.values(w.slots));
  const p = t.as(w.parent), d = t.as(t.fx.director(w.loc));
  const week = `${A}/students/${kid.id}/history?period=week&date=2026-10-07`;
  const q = 'from=2026-10-05&to=2026-10-09';

  // 2:30pm: the session is still on, so it isn't missed yet.
  t.clock.set(at(LA, '2026-10-07', '14:30'));
  assert.deepEqual((await p.get(week)).body.absences.map(a => a.date), ['2026-10-05']);

  // Saturday: Wednesday ended with no visit, so it's an absence. Friday began paused, so it isn't.
  t.clock.set(at(LA, '2026-10-10', '09:00'));
  const missed = ['2026-10-05', '2026-10-07'];
  const h = await p.get(week);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.absences.map(a => [a.date, a.session_name]), missed.map(x => [x, 'Afternoon Study']));
  assert.equal(h.body.totals.absences, 2);
  const csv = parseCsv((await p.get(`${A}/students/${kid.id}/log.csv?${q}`)).body);
  assert.deepEqual(csv.filter(x => x[0] === 'absent').map(x => x[1]), missed);
  const pdf = pdfText((await p.get(`${A}/students/${kid.id}/log.pdf?${q}`)).body);
  assert.ok(pdf.includes('Wed, Oct 7, 2026 Afternoon Study 1:00 PM – 4:00 PM'), pdf);
  assert.ok(!pdf.includes('Fri, Oct 9, 2026'), pdf);
  const rep = await d.get(`${A}/report?${q}`);
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.body.absences.map(a => [a.date, a.student_name]), missed.map(x => [x, 'Maya Johnson']));
  assert.deepEqual(rep.body.by_student.map(s => [s.student_name, s.visits, s.absences]), [['Maya Johnson', 0, 2]]);
});

// A drop is different: the slot ends then, and the schedule shows no week it didn't last through.
test(['AT-2'], 'a slot dropped at 2pm during a 1-4pm session owes no absence for that day', async () => {
  const w = await world();
  w.t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(at(LA, '2026-10-07', '14:00'), w.slots[3].id);
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.absences.map(a => a.date), ['2026-10-05', '2026-10-09']);
});

test(['AT-2', 'NF-1'], 'the Hours list shows each linked student with this week\'s and this month\'s totals and range shortcuts', async () => {
  const w = await world();
  const second = rename(w.t, w.t.fx.user('student', { location: w.loc }), 'Ava Johnson');
  w.t.fx.link(w.parent, second);
  const other = w.t.fx.family(w.loc);
  w.visit('2026-10-02', '13:00', '16:00');
  w.visit('2026-10-12', '13:02', '15:58');
  w.visit('2026-10-12', '13:00', '16:00', { student: other.student });

  const r = await w.t.as(w.parent).get(`${A}/students`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.students.map(s => s.name), ['Ava Johnson', 'Maya Johnson']);
  const maya = r.body.students[1];
  assert.equal(maya.location.name, 'Irvine');
  assert.equal(maya.today, '2026-10-14');
  assert.deepEqual([maya.week.from, maya.week.to, maya.week.totals.visits, maya.week.totals.minutes], ['2026-10-12', '2026-10-18', 1, 176]);
  assert.deepEqual([maya.month.label, maya.month.totals.visits, maya.month.totals.minutes], ['October 2026', 2, 356]);
  assert.deepEqual(maya.presets.map(p => [p.id, p.from, p.to]), [
    ['this_week', '2026-10-12', '2026-10-18'], ['this_month', '2026-10-01', '2026-10-31'],
    ['last_month', '2026-09-01', '2026-09-30'], ['this_term', '2026-08-17', '2026-12-18']]);
  assert.equal(r.body.students[0].week.totals.visits, 0);
});

// ---------------------------------------------------------------- AT-3

// Fri Oct 2 scanned out, Mon Oct 5 automatic, Wed Oct 7 missed, Fri Oct 9 checked out by staff.
async function exportWorld() {
  const w = await world();
  const staff = rename(w.t, w.t.fx.staff(w.loc), 'Chris Ortiz');
  w.visit('2026-10-02', '13:02', '15:58');
  w.visit('2026-10-05', '13:00', '16:00', { extra: { checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' } });
  w.visit('2026-10-09', '13:15', '15:15', { extra: { checkout_method: 'staff', checked_out_by: staff.id } });
  return Object.assign(w, { staff });
}

test(['AT-3'], 'CSV export: a downloadable file with one row per visit and absence, then the total hours', async () => {
  const w = await exportWorld();
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.csv?from=2026-10-01&to=2026-10-09`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="attendance-maya-johnson-2026-10-01-to-2026-10-09.csv"');
  assert.deepEqual(parseCsv(r.body), [
    ['record', 'date', 'student', 'location', 'session', 'check_in', 'check_out', 'minutes', 'hours', 'check_out_method', 'time_zone'],
    ['visit', '2026-10-02', 'Maya Johnson', 'Irvine', 'Afternoon Study', '13:02', '15:58', '176', '2.93', 'scan', LA],
    ['visit', '2026-10-05', 'Maya Johnson', 'Irvine', 'Afternoon Study', '13:00', '16:00', '180', '3.00', 'auto', LA],
    ['absent', '2026-10-07', 'Maya Johnson', 'Irvine', 'Afternoon Study', '', '', '', '', '', LA],
    ['visit', '2026-10-09', 'Maya Johnson', 'Irvine', 'Afternoon Study', '13:15', '15:15', '120', '2.00', 'staff', LA],
    // The file says which dates it covers, so it still does once saved or forwarded.
    ['total', '2026-10-01 to 2026-10-09', 'Maya Johnson', 'Irvine', '', '', '', '476', '7.93', '', ''],
  ]);
});

test(['AT-3'], 'PDF export: student, location, dates, totals, one row per visit and the absences', async () => {
  const w = await exportWorld();
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.pdf?from=2026-10-01&to=2026-10-09`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="attendance-maya-johnson-2026-10-01-to-2026-10-09.pdf"');
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(r.body);
  for (const want of [
    'Attendance and hours log', 'Student: Maya Johnson', 'Location: Irvine', 'Dates: Oct 1 – Oct 9, 2026',
    '3 Visits 7.93 Total hours · 7h 56m 1 Absences',
    'Fri, Oct 2, 2026 Afternoon Study 1:02 PM 3:58 PM 2h 56m Scanned out',
    'Mon, Oct 5, 2026 Afternoon Study 1:00 PM 4:00 PM 3h 0m Automatic (did not scan out)',
    'Fri, Oct 9, 2026 Afternoon Study 1:15 PM 3:15 PM 2h 0m By staff',
    'Absences Date Session Scheduled Wed, Oct 7, 2026 Afternoon Study 1:00 PM – 4:00 PM',
  ]) assert.ok(text.includes(want), `missing "${want}" in: ${text}`);
});

test(['AT-3', 'AT-4'], 'PDFs print names outside Windows-1252 (Vietnamese, Polish, Czech, Greek, Cyrillic) exactly as typed, in fonts embedded in the file', async () => {
  const w = await exportWorld();
  rename(w.t, w.kid, 'Nguyễn Thị Ánh');
  rename(w.t, w.staff, 'Zoë Šťastná');
  w.t.db.prepare('UPDATE locations SET name = ? WHERE id = ?').run('Łódź Study Hall', w.loc.id);
  w.t.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run('Ελληνικά и Русский', w.pm.id);
  const q = 'from=2026-10-01&to=2026-10-09';

  const fam = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.pdf?${q}`);
  assert.equal(fam.status, 200);
  // Both weights of the one Unicode font, embedded; no built-in (WinAnsi-only) font anywhere.
  assert.deepEqual(pdfFonts(fam.body), ['Type0 DejaVuSans', 'Type0 DejaVuSans-Bold']);
  // One glyph per letter: no ligature stands for "ff", which some readers copy, search and read aloud as "f".
  assert.deepEqual(pdfGlyphs(fam.body).filter(g => [...g].length !== 1), []);
  const text = pdfText(fam.body);
  for (const want of [
    'Student: Nguyễn Thị Ánh', 'Location: Łódź Study Hall',
    'Fri, Oct 9, 2026 Ελληνικά и Русский 1:15 PM 3:15 PM 2h 0m By staff',
    'Absences Date Session Scheduled Wed, Oct 7, 2026 Ελληνικά и Русский 1:00 PM – 4:00 PM',
    'Times are local time at Łódź Study Hall (America/Los_Angeles).',
    'ELITE Spaces · Nguyễn Thị Ánh · Oct 1 – Oct 9, 2026 · Page 1 of 1',
  ]) assert.ok(text.includes(want), `missing "${want}" in: ${text}`);

  const rep = await w.t.as(w.t.fx.director(w.loc)).get(`${A}/report.pdf?session=${w.pm.id}&${q}`);
  assert.equal(rep.status, 200);
  assert.deepEqual(pdfFonts(rep.body), ['Type0 DejaVuSans', 'Type0 DejaVuSans-Bold']);
  assert.deepEqual(pdfGlyphs(rep.body).filter(g => [...g].length !== 1), []);
  const rtext = pdfText(rep.body);
  for (const want of [
    'Location: Łódź Study Hall', 'Session: Ελληνικά и Русский · Mon/Wed/Fri 1:00 PM–4:00 PM',
    'Nguyễn Thị Ánh 3 7.93 1',
    'Fri, Oct 9, 2026 Nguyễn Thị Ánh Ελληνικά и Русский 1:15 PM 3:15 PM 2h 0m By staff (Zoë Šťastná)',
    'Wed, Oct 7, 2026 Nguyễn Thị Ánh Ελληνικά и Русский 1:00 PM – 4:00 PM',
  ]) assert.ok(rtext.includes(want), `missing "${want}" in: ${rtext}`);
});

test(['AT-3'], 'an empty range still exports: header and a zero total in the CSV, a plain sentence in the PDF', async () => {
  const w = await world();
  const csv = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.csv?from=2026-09-01&to=2026-09-07`);
  assert.equal(csv.status, 200);
  assert.deepEqual(parseCsv(csv.body).slice(1), [['total', '2026-09-01 to 2026-09-07', 'Maya Johnson', 'Irvine', '', '', '', '0', '0.00', '', '']]);
  const pdf = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.pdf?from=2026-09-01&to=2026-09-07`);
  const text = pdfText(pdf.body);
  assert.ok(text.includes('No visits between Sep 1, 2026 and Sep 7, 2026.'), text);
  assert.ok(text.includes('No absences in this range.'), text);
});

// However many rows come before it, the closing note ("Times are local time at ...")
// shares its page with the last row of the table above it, or with the last section's
// heading and sentence: a last page holding only the note (or the end of it) looks like a stray sheet.
test(['AT-3'], 'a PDF\'s closing note is never left alone or split onto the last page, after a table of absences or after "No absences"', async () => {
  const w = await world();
  const p = w.t.as(w.parent);
  const NOTE = 'Times are local time at Irvine';
  const lonely = [];
  // Maya enrolled Mon Sep 28. Sep 1 - Oct 9 has her six missed afternoons, so the note
  // follows the absences table; Sep 1-27 has none, so it follows "No absences in this
  // range." With 17-20 and 23-25 visits above them, page 1 ends right where the note goes.
  for (let n = 1; n <= 25; n++) {
    w.visit(`2026-09-${String(1 + n).padStart(2, '0')}`, '13:00', '15:00', { session: null });
    if (n < 17 || n === 21 || n === 22) continue;
    const q = n <= 20 ? 'from=2026-09-01&to=2026-10-09' : 'from=2026-09-01&to=2026-09-27';
    const pages = pdfPages((await p.get(`${A}/students/${w.kid.id}/log.pdf?${q}`)).body);
    assert.ok(pages[0].startsWith('Attendance and hours log'), pages[0]);
    // The note starts on the last page, whole, below something else: not alone, not split.
    const last = pages[pages.length - 1];
    if (!(last.indexOf(NOTE) > 0)) lonely.push(`${n} visits, ${q}: ${pages.slice(-2).join(' | ')}`);
  }
  assert.deepEqual(lonely, []);
});

test(['AT-3'], 'CSV cells are quoted, and text that looks like a spreadsheet formula is defused', async () => {
  const w = await world();
  rename(w.t, w.kid, 'Leo "Lion" O\'Neil, Jr.');
  w.t.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run('=HYPERLINK("http://x")', w.pm.id);
  w.visit('2026-10-12', '13:00', '16:00');
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.csv?from=2026-10-12&to=2026-10-12`);
  assert.ok(r.body.includes('"Leo ""Lion"" O\'Neil, Jr."'), r.body);
  const row = parseCsv(r.body)[1];
  assert.equal(row.length, 11);
  assert.equal(row[2], 'Leo "Lion" O\'Neil, Jr.');
  assert.equal(row[4], '\'=HYPERLINK("http://x")');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="attendance-leo-lion-o-neil-jr-2026-10-12-to-2026-10-12.csv"');
});

test(['AT-3'], 'the export range must be two real dates in order, at most a year apart', async () => {
  const w = await world();
  const p = w.t.as(w.parent);
  const base = `${A}/students/${w.kid.id}`;
  for (const [q, code] of [['from=2026-10-09&to=2026-10-01', 'bad_range'], ['to=2026-10-01', 'bad_date'], ['from=2026-02-30&to=2026-03-01', 'bad_date'],
    ['from=2025-01-01&to=2026-10-01', 'range_too_long']]) {
    for (const ext of ['', '.csv', '.pdf']) {
      const r = await p.get(`${base}/log${ext}?${q}`);
      assert.equal(r.status, 400, `${ext} ${q}`);
      assert.equal(r.body.error, code, `${ext} ${q}`);
    }
  }
  const ok = await p.get(`${base}/log?from=2026-10-01&to=2026-10-31`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.label, 'Oct 1 – Oct 31, 2026');
});

test(['AT-3', 'NF-1'], 'an export holds only that student: a sibling\'s and another family\'s visits and absences stay out', async () => {
  const w = await world();
  const other = w.t.fx.family(w.loc);
  const sib = w.t.fx.user('student', { location: w.loc });
  w.t.fx.link(w.parent, sib);
  // The sibling and the other family's student also hold the Wednesday afternoon slot, and also missed Wed Oct 7.
  for (const s of [other.student, sib]) enrollSince(w.t, s, w.pm, 3, at(LA, '2026-09-28', '08:00'));
  w.visit('2026-10-12', '13:00', '16:00');
  w.visit('2026-10-12', '13:05', '16:00', { student: other.student });
  w.visit('2026-10-12', '13:10', '16:00', { student: sib });
  const r = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.csv?from=2026-10-12&to=2026-10-12`);
  const rows = parseCsv(r.body);
  assert.deepEqual(rows.map(x => x[0]), ['record', 'visit', 'total']);
  assert.equal(rows[1][5], '13:00');
  const j = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log?from=2026-10-12&to=2026-10-12`);
  assert.deepEqual(j.body.visits.map(v => v.student_id), [w.kid.id]);

  // Absences: Maya missed Mon Oct 5, Wed Oct 7 and Fri Oct 9, and only hers show.
  const p = w.t.as(w.parent);
  const mine = [['2026-10-05', w.kid.id], ['2026-10-07', w.kid.id], ['2026-10-09', w.kid.id]];
  const week = await p.get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`);
  assert.deepEqual(week.body.absences.map(a => [a.date, a.student_id]), mine);
  assert.equal(week.body.totals.absences, 3);
  const q = 'from=2026-10-05&to=2026-10-12';
  const log = await p.get(`${A}/students/${w.kid.id}/log?${q}`);
  assert.deepEqual(log.body.absences.map(a => [a.date, a.student_id]), mine);
  assert.equal(log.body.totals.absences, 3);
  const csv = parseCsv((await p.get(`${A}/students/${w.kid.id}/log.csv?${q}`)).body);
  assert.deepEqual(csv.filter(x => x[0] === 'absent').map(x => [x[1], x[2]]),
    [['2026-10-05', 'Maya Johnson'], ['2026-10-07', 'Maya Johnson'], ['2026-10-09', 'Maya Johnson']]);
  const pdf = pdfText((await p.get(`${A}/students/${w.kid.id}/log.pdf?${q}`)).body);
  assert.ok(pdf.includes('1 Visits 3.00 Total hours · 3h 0m 3 Absences'), pdf);
  assert.equal(pdf.split('Wed, Oct 7, 2026 Afternoon Study 1:00 PM – 4:00 PM').length - 1, 1, pdf);
});

// ---------------------------------------------------------------- AT-4

// Irvine: afternoon Mon/Wed/Fri (Maya) and Morning Focus Tue 9:30-12 (Ben).
// Arcadia: Zoe, whose Mon Oct 5 visit and Wed Oct 7 absence must never show in Irvine's report.
async function reportWorld() {
  const w = await world();
  const t = w.t;
  const am = t.fx.session(w.loc, { term: w.term, name: 'Morning Focus', weekdays: '2,4', start: '09:30', end: '12:00' });
  const ben = rename(t, t.fx.family(w.loc).student, 'Ben Cole');
  enrollSince(t, ben, am, 2, at(LA, '2026-09-28', '08:00'));
  const staff = rename(t, t.fx.staff(w.loc), 'Chris Ortiz');
  const director = t.fx.director(w.loc);
  const arcadia = t.fx.location({ name: 'Arcadia', lat: 34.14, lng: -118.03 });
  const arcSession = t.fx.session(arcadia, { name: 'Arcadia Study' });
  const zoe = rename(t, t.fx.family(arcadia).student, 'Zoe Park');
  enrollSince(t, zoe, arcSession, 3, at(LA, '2026-09-28', '08:00'));
  w.visit('2026-10-05', '13:00', '16:00');
  w.visit('2026-10-07', '13:00', '16:00', { extra: { checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' } });
  w.visit('2026-10-06', '09:30', '12:00', { student: ben, session: am, extra: { checkin_method: 'staff', checked_in_by: staff.id, checkout_method: 'staff', checked_out_by: staff.id } });
  w.visit('2026-10-05', '13:00', '15:00', { student: zoe, location: arcadia, session: arcSession });
  return Object.assign(w, { am, ben, staff, director, arcadia, arcSession, zoe, hq: t.fx.hq() });
}

test(['AT-4'], 'a director\'s report: their location\'s visits, totals, needs-review count, absences and per-student hours', async () => {
  const w = await reportWorld();
  const r = await w.t.as(w.director).get(`${A}/report?from=2026-10-05&to=2026-10-09`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filters.location.name, 'Irvine');
  assert.equal(r.body.filters.session, null);
  assert.equal(r.body.label, 'Oct 5 – Oct 9, 2026');
  assert.deepEqual(r.body.visits.map(v => [v.date, v.student_name, v.session_name, v.checkout_method, v.needs_review]), [
    ['2026-10-05', 'Maya Johnson', 'Afternoon Study', 'scan', false],
    ['2026-10-06', 'Ben Cole', 'Morning Focus', 'staff', false],
    ['2026-10-07', 'Maya Johnson', 'Afternoon Study', 'auto', true],
  ]);
  assert.equal(r.body.visits[1].checked_in_by_name, 'Chris Ortiz');
  assert.deepEqual(r.body.totals, { visits: 3, minutes: 510, hours: 8.5, absences: 1, students: 2, needs_review: 1 });
  assert.deepEqual(r.body.absences.map(a => [a.date, a.student_name]), [['2026-10-09', 'Maya Johnson']]);
  assert.deepEqual(r.body.by_student.map(s => [s.student_name, s.visits, s.minutes, s.hours, s.absences]),
    [['Ben Cole', 1, 150, 2.5, 0], ['Maya Johnson', 2, 360, 6, 1]]);

  // Once staff confirm the automatic check-out, it no longer needs review.
  w.t.db.prepare('UPDATE visits SET reviewed_by = ? WHERE flagged = 1').run(w.staff.id);
  const after = await w.t.as(w.director).get(`${A}/report?from=2026-10-05&to=2026-10-09`);
  assert.equal(after.body.totals.needs_review, 0);
});

test(['AT-4'], 'filtering by session narrows visits, absences and totals to that session', async () => {
  const w = await reportWorld();
  const r = await w.t.as(w.director).get(`${A}/report?location=${w.loc.id}&session=${w.am.id}&from=2026-10-05&to=2026-10-09`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filters.session.label, 'Morning Focus · Tue/Thu 9:30 AM–12:00 PM');
  assert.deepEqual(r.body.visits.map(v => v.student_name), ['Ben Cole']);
  assert.deepEqual(r.body.absences, []);
  assert.deepEqual([r.body.totals.visits, r.body.totals.minutes, r.body.totals.absences], [1, 150, 0]);
  const pm = await w.t.as(w.director).get(`${A}/report?session=${w.pm.id}&from=2026-10-05&to=2026-10-09`);
  assert.deepEqual([pm.body.totals.visits, pm.body.totals.absences], [2, 1]);
});

// A staff check-in with no session that covers the afternoon session counts as
// attending it (EN-7), so the session's report shows that visit and its hours,
// as the schedule and the absences already do. Ava, who only missed, is a student
// of the report too.
test(['AT-4'], 'a session report includes staff check-ins with no session that cover it, and counts students who only missed', async () => {
  const w = await reportWorld();
  const { t } = w;
  const ava = rename(t, t.fx.family(w.loc).student, 'Ava Diaz');
  enrollSince(t, ava, w.pm, 3, at(LA, '2026-09-28', '08:00')); // Wednesdays; never came
  closure(t, w.loc, '2026-10-02');
  const byStaff = { checkin_method: 'staff', checked_in_by: w.staff.id, checkout_method: 'staff', checked_out_by: w.staff.id };
  const noSession = (student, date, inAt, outAt, location = w.loc) => w.visit(date, inAt, outAt, { student, location, session: null, extra: byStaff });
  noSession(w.kid, '2026-10-09', '12:30', '16:30'); // a dead phone: covers Friday's 1-4pm
  noSession(w.ben, '2026-10-02', '13:00', '16:00'); // a closure day: no session that day
  noSession(w.ben, '2026-10-05', '09:00', '11:00'); // a Monday, but not during the session
  noSession(w.ben, '2026-10-06', '14:00', '15:00'); // during the hours, but a Tuesday
  noSession(w.zoe, '2026-10-09', '13:00', '16:00', w.arcadia); // another location
  const summer = t.fx.session(w.loc, { term: t.fx.term(w.loc, { name: 'Summer 2026', start: '2026-06-15', end: '2026-08-14' }),
    name: 'Summer Study', weekdays: '1,3,5', start: '13:00', end: '16:00' });
  const q = 'from=2026-10-02&to=2026-10-09';

  const want = [
    ['2026-10-05', 'Maya Johnson', 'Afternoon Study', 180, 'scan'],
    ['2026-10-07', 'Maya Johnson', 'Afternoon Study', 180, 'auto'],
    ['2026-10-09', 'Maya Johnson', null, 240, 'staff'],
  ];
  for (const [who, url] of [['director', `${A}/report?session=${w.pm.id}&${q}`], ['hq', `${A}/report?location=all&session=${w.pm.id}&${q}`]]) {
    const r = await t.as(w[who]).get(url);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.visits.map(v => [v.date, v.student_name, v.session_name, v.minutes, v.checkout_method]), want, who);
    assert.deepEqual(r.body.absences.map(a => [a.date, a.student_name]), [['2026-10-07', 'Ava Diaz']], who);
    assert.deepEqual(r.body.totals, { visits: 3, minutes: 600, hours: 10, absences: 1, students: 2, needs_review: 1 }, who);
    assert.deepEqual(r.body.by_student.map(s => [s.student_name, s.visits, s.minutes, s.absences]),
      [['Ava Diaz', 0, 0, 1], ['Maya Johnson', 3, 600, 0]], who);
  }

  const csv = parseCsv((await t.as(w.director).get(`${A}/report.csv?session=${w.pm.id}&${q}`)).body);
  assert.deepEqual(csv.filter(x => x[0] !== 'record').map(x => [x[0], x[1], x[2], x[4], x[7], x[11]]), [
    ['visit', '2026-10-05', 'Maya Johnson', 'Afternoon Study', '180', ''],
    ['visit', '2026-10-07', 'Maya Johnson', 'Afternoon Study', '180', ''],
    ['absent', '2026-10-07', 'Ava Diaz', 'Afternoon Study', '', ''],
    ['visit', '2026-10-09', 'Maya Johnson', '', '240', 'Chris Ortiz'],
    ['total', '2026-10-02 to 2026-10-09', '', 'Afternoon Study · Mon/Wed/Fri 1:00 PM–4:00 PM', '600', ''],
  ]);

  const pdf = pdfText((await t.as(w.director).get(`${A}/report.pdf?session=${w.pm.id}&${q}`)).body);
  for (const want of ['3 Visits 10.00 Total hours · 10h 0m 2 Students 1 Absences 1 Needs review', 'Ava Diaz 0 0.00 1', 'Maya Johnson 3 10.00 0',
    'Fri, Oct 9, 2026 Maya Johnson No session 12:30 PM 4:30 PM 4h 0m By staff (Chris Ortiz)']) assert.ok(pdf.includes(want), `missing "${want}" in: ${pdf}`);
  assert.ok(!pdf.includes('Ben Cole') && !pdf.includes('Zoe Park'), pdf);

  // The same hours in another term's session: not covered, so nothing to report.
  const other = await t.as(w.director).get(`${A}/report?session=${summer.id}&${q}`);
  assert.deepEqual([other.body.visits, other.body.absences, other.body.totals.students], [[], [], 0]);
});

// SC-3: a closure is one location's. Arcadia closing Fri Oct 9 leaves Irvine's Friday
// an ordinary day: Maya's missed afternoon there is still an absence, and Ben's staff
// check-in with no session that afternoon still counts for Irvine's session (D-15a).
// At Arcadia the closure holds: Zoe's Friday slot isn't missed and her check-in covers nothing.
test(['AT-2', 'AT-3', 'AT-4'], 'a closure at one location leaves another location\'s day alone: its absences, files and session reports still count that date', async () => {
  const w = await reportWorld();
  const { t } = w;
  closure(t, w.arcadia, '2026-10-09');
  enrollSince(t, w.zoe, w.arcSession, 5, at(LA, '2026-09-28', '08:00')); // Zoe holds Arcadia's Friday too
  const arcStaff = t.fx.staff(w.arcadia);
  w.visit('2026-10-09', '13:00', '16:00', { student: w.ben, session: null,
    extra: { checkin_method: 'staff', checked_in_by: w.staff.id, checkout_method: 'staff', checked_out_by: w.staff.id } });
  w.visit('2026-10-09', '13:00', '16:00', { student: w.zoe, location: w.arcadia, session: null,
    extra: { checkin_method: 'staff', checked_in_by: arcStaff.id, checkout_method: 'staff', checked_out_by: arcStaff.id } });
  const q = 'from=2026-10-05&to=2026-10-09';
  const missed = ['2026-10-09'];

  // Maya's parent: history, the log and both files.
  const p = t.as(w.parent);
  const h = await p.get(`${A}/students/${w.kid.id}/history?period=week&date=2026-10-07`);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.absences.map(a => [a.date, a.session_name, a.location_id]), [['2026-10-09', 'Afternoon Study', w.loc.id]]);
  assert.equal(h.body.totals.absences, 1);
  const l = await p.get(`${A}/students/${w.kid.id}/log?${q}`);
  assert.deepEqual(l.body.absences.map(a => a.date), missed);
  assert.equal(l.body.totals.absences, 1);
  const csv = parseCsv((await p.get(`${A}/students/${w.kid.id}/log.csv?${q}`)).body);
  assert.deepEqual(csv.filter(x => x[0] === 'absent'), [['absent', '2026-10-09', 'Maya Johnson', 'Irvine', 'Afternoon Study', '', '', '', '', '', LA]]);
  const pdf = pdfText((await p.get(`${A}/students/${w.kid.id}/log.pdf?${q}`)).body);
  assert.ok(pdf.includes('2 Visits 6.00 Total hours · 6h 0m 1 Absences'), pdf);
  assert.ok(pdf.includes('Absences Date Session Scheduled Fri, Oct 9, 2026 Afternoon Study 1:00 PM – 4:00 PM'), pdf);

  // The Irvine director's report, for the location and for the afternoon session.
  const d = t.as(w.director);
  const rep = await d.get(`${A}/report?${q}`);
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.body.absences.map(a => [a.date, a.student_name]), [['2026-10-09', 'Maya Johnson']]);
  assert.deepEqual(rep.body.by_student.map(s => [s.student_name, s.visits, s.absences]), [['Ben Cole', 2, 0], ['Maya Johnson', 2, 1]]);
  const ses = await d.get(`${A}/report?session=${w.pm.id}&${q}`);
  assert.equal(ses.status, 200);
  assert.deepEqual(ses.body.visits.map(v => [v.date, v.student_name, v.session_name, v.minutes, v.checked_in_by_name]), [
    ['2026-10-05', 'Maya Johnson', 'Afternoon Study', 180, null],
    ['2026-10-07', 'Maya Johnson', 'Afternoon Study', 180, null],
    ['2026-10-09', 'Ben Cole', null, 180, 'Chris Ortiz'],
  ]);
  assert.deepEqual(ses.body.absences.map(a => [a.date, a.student_name]), [['2026-10-09', 'Maya Johnson']]);
  assert.deepEqual([ses.body.totals.visits, ses.body.totals.minutes, ses.body.totals.absences], [3, 540, 1]);
  const scsv = parseCsv((await d.get(`${A}/report.csv?session=${w.pm.id}&${q}`)).body);
  assert.deepEqual(scsv.filter(x => x[1] === '2026-10-09').map(x => [x[0], x[2], x[4], x[7]]),
    [['visit', 'Ben Cole', '', '180'], ['absent', 'Maya Johnson', 'Afternoon Study', '']]);

  // Arcadia, where the closure is: Zoe's Friday is no absence, and her check-in that day covers no session.
  const hq = t.as(w.hq);
  const all = await hq.get(`${A}/report?location=all&${q}`);
  assert.deepEqual(all.body.absences.map(a => [a.date, a.student_name]), [['2026-10-07', 'Zoe Park'], ['2026-10-09', 'Maya Johnson']]);
  const arc = await hq.get(`${A}/report?location=${w.arcadia.id}&session=${w.arcSession.id}&${q}`);
  assert.equal(arc.status, 200);
  assert.deepEqual(arc.body.visits.map(v => [v.date, v.student_name, v.session_name]), [['2026-10-05', 'Zoe Park', 'Arcadia Study']]);
  assert.deepEqual(arc.body.absences.map(a => [a.date, a.student_name]), [['2026-10-07', 'Zoe Park']]);
});

test(['AT-4'], 'HQ reports on all locations at once or on any single one', async () => {
  const w = await reportWorld();
  const hq = w.t.as(w.hq);
  const all = await hq.get(`${A}/report?location=all&from=2026-10-05&to=2026-10-09`);
  assert.equal(all.status, 200);
  assert.equal(all.body.filters.location, null);
  assert.deepEqual(all.body.visits.map(v => v.student_name).sort(), ['Ben Cole', 'Maya Johnson', 'Maya Johnson', 'Zoe Park']);
  const dflt = await hq.get(`${A}/report?from=2026-10-05&to=2026-10-09`);
  assert.equal(dflt.body.totals.visits, 4);
  const arc = await hq.get(`${A}/report?location=${w.arcadia.id}&from=2026-10-05&to=2026-10-09`);
  assert.deepEqual(arc.body.visits.map(v => [v.student_name, v.location_name]), [['Zoe Park', 'Arcadia']]);
  assert.deepEqual([arc.body.totals.visits, arc.body.totals.minutes], [1, 120]);
  const wrong = await hq.get(`${A}/report?location=${w.arcadia.id}&session=${w.am.id}&from=2026-10-05&to=2026-10-09`);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'session_location');
  const missing = await hq.get(`${A}/report?location=99999&from=2026-10-05&to=2026-10-09`);
  assert.equal(missing.status, 404);
});

test(['AT-4'], 'report options: a director gets their own location and sessions; HQ gets every location', async () => {
  const w = await reportWorld();
  const d = await w.t.as(w.director).get(`${A}/report/options`);
  assert.equal(d.status, 200);
  assert.equal(d.body.all_locations, false);
  assert.deepEqual(d.body.locations.map(l => l.name), ['Irvine']);
  assert.deepEqual(d.body.locations[0].sessions.map(s => s.label), ['Afternoon Study · Mon/Wed/Fri 1:00 PM–4:00 PM', 'Morning Focus · Tue/Thu 9:30 AM–12:00 PM']);
  assert.equal(d.body.locations[0].today, '2026-10-14');
  assert.deepEqual(d.body.locations[0].presets.find(p => p.id === 'this_week'), { id: 'this_week', label: 'This week', from: '2026-10-12', to: '2026-10-18' });
  const h = await w.t.as(w.hq).get(`${A}/report/options`);
  assert.equal(h.body.all_locations, true);
  assert.deepEqual(h.body.locations.map(l => [l.name, l.sessions.length]), [['Arcadia', 1], ['Irvine', 2]]);
});

test(['AT-4'], 'report CSV: the family columns plus who checked students in or out and what needs review', async () => {
  const w = await reportWorld();
  const r = await w.t.as(w.director).get(`${A}/report.csv?from=2026-10-05&to=2026-10-09`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="attendance-report-irvine-2026-10-05-to-2026-10-09.csv"');
  assert.deepEqual(parseCsv(r.body), [
    ['record', 'date', 'student', 'location', 'session', 'check_in', 'check_out', 'minutes', 'hours', 'check_out_method', 'time_zone', 'checked_in_by', 'checked_out_by', 'needs_review'],
    ['visit', '2026-10-05', 'Maya Johnson', 'Irvine', 'Afternoon Study', '13:00', '16:00', '180', '3.00', 'scan', LA, '', '', 'no'],
    ['visit', '2026-10-06', 'Ben Cole', 'Irvine', 'Morning Focus', '09:30', '12:00', '150', '2.50', 'staff', LA, 'Chris Ortiz', 'Chris Ortiz', 'no'],
    ['visit', '2026-10-07', 'Maya Johnson', 'Irvine', 'Afternoon Study', '13:00', '16:00', '180', '3.00', 'auto', LA, '', '', 'yes'],
    ['absent', '2026-10-09', 'Maya Johnson', 'Irvine', 'Afternoon Study', '', '', '', '', '', LA, '', '', ''],
    // The total row carries the report's filters: dates, location and session.
    ['total', '2026-10-05 to 2026-10-09', '', 'Irvine', 'All sessions', '', '', '510', '8.50', '', '', '', '', ''],
  ]);
  const s = await w.t.as(w.director).get(`${A}/report.csv?session=${w.am.id}&from=2026-10-05&to=2026-10-09`);
  assert.equal(s.headers.get('content-disposition'), 'attachment; filename="attendance-report-irvine-morning-focus-2026-10-05-to-2026-10-09.csv"');
  assert.deepEqual(parseCsv(s.body).map(x => x[2]), ['student', 'Ben Cole', '']);
  assert.deepEqual(parseCsv(s.body).pop().slice(0, 5), ['total', '2026-10-05 to 2026-10-09', '', 'Irvine', 'Morning Focus · Tue/Thu 9:30 AM–12:00 PM']);
  const all = parseCsv((await w.t.as(w.hq).get(`${A}/report.csv?location=all&from=2026-10-05&to=2026-10-09`)).body).pop();
  assert.deepEqual(all.slice(0, 5), ['total', '2026-10-05 to 2026-10-09', '', 'All locations', 'All sessions']);
});

test(['AT-4'], 'report PDF: filters, totals including needs review, per-student hours, visits and absences', async () => {
  const w = await reportWorld();
  const r = await w.t.as(w.director).get(`${A}/report.pdf?from=2026-10-05&to=2026-10-09`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="attendance-report-irvine-2026-10-05-to-2026-10-09.pdf"');
  const text = pdfText(r.body);
  for (const want of [
    'Attendance report', 'Location: Irvine', 'Session: All sessions', 'Dates: Oct 5 – Oct 9, 2026',
    '3 Visits 8.50 Total hours · 8h 30m 2 Students 1 Absences 1 Needs review',
    'Ben Cole 1 2.50 0', 'Maya Johnson 2 6.00 1',
    'Tue, Oct 6, 2026 Ben Cole Morning Focus 9:30 AM 12:00 PM 2h 30m By staff (Chris Ortiz)',
    'Wed, Oct 7, 2026 Maya Johnson Afternoon Study 1:00 PM 4:00 PM 3h 0m Automatic (did not scan out) · needs review',
    'Fri, Oct 9, 2026 Maya Johnson Afternoon Study 1:00 PM – 4:00 PM',
  ]) assert.ok(text.includes(want), `missing "${want}" in: ${text}`);
  assert.ok(!text.includes('Zoe Park'));
  const all = pdfText((await w.t.as(w.hq).get(`${A}/report.pdf?location=all&from=2026-10-05&to=2026-10-09`)).body);
  assert.ok(all.includes('Location: All locations'), all);
  assert.ok(all.includes('Mon, Oct 5, 2026 Zoe Park Arcadia Arcadia Study 1:00 PM 3:00 PM 2h 0m Scanned out'), all);
});

// Across all locations, the PDF says where each absence and each student is, as its
// Visits table, the screen's Absences tab and every CSV row do.
test(['AT-4'], 'an all-locations report PDF names the location of every absence and of every student', async () => {
  const w = await reportWorld();
  // Maya also came to Arcadia once (Thu Oct 8, no session), so her row names both locations.
  w.visit('2026-10-08', '10:00', '11:00', { location: w.arcadia, session: null });
  const q = 'location=all&from=2026-10-05&to=2026-10-09';
  const text = pdfText((await w.t.as(w.hq).get(`${A}/report.pdf?${q}`)).body);
  for (const want of [
    'By student Student Location Visits Hours Absences Ben Cole Irvine 1 2.50 0 Maya Johnson Arcadia, Irvine 3 7.00 1 Zoe Park Arcadia 1 2.00 1',
    'Absences Date Student Location Session Scheduled Wed, Oct 7, 2026 Zoe Park Arcadia Arcadia Study 1:00 PM – 4:00 PM ' +
      'Fri, Oct 9, 2026 Maya Johnson Irvine Afternoon Study 1:00 PM – 4:00 PM',
  ]) assert.ok(text.includes(want), `missing "${want}" in: ${text}`);
  const csv = parseCsv((await w.t.as(w.hq).get(`${A}/report.csv?${q}`)).body);
  assert.deepEqual(csv.filter(x => x[0] === 'absent').map(x => [x[1], x[2], x[3]]),
    [['2026-10-07', 'Zoe Park', 'Arcadia'], ['2026-10-09', 'Maya Johnson', 'Irvine']]);
});

// A session is at one location, so a session chosen with all locations makes the report that location's.
test(['AT-4'], 'HQ choosing one session with all locations gets a report that names the session\'s location: PDF, CSV and file names', async () => {
  const w = await reportWorld();
  const hq = w.t.as(w.hq);
  const q = `location=all&session=${w.pm.id}&from=2026-10-05&to=2026-10-09`;
  const label = 'Afternoon Study · Mon/Wed/Fri 1:00 PM–4:00 PM';
  const r = await hq.get(`${A}/report?${q}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.filters.location.name, r.body.filters.session.label], ['Irvine', label]);

  const pdf = await hq.get(`${A}/report.pdf?${q}`);
  assert.equal(pdf.headers.get('content-disposition'), 'attachment; filename="attendance-report-irvine-afternoon-study-2026-10-05-to-2026-10-09.pdf"');
  const text = pdfText(pdf.body);
  assert.ok(text.includes(`Location: Irvine Session: ${label} Dates: Oct 5 – Oct 9, 2026`), text);
  assert.ok(!text.includes('All locations'), text);

  const csv = await hq.get(`${A}/report.csv?${q}`);
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="attendance-report-irvine-afternoon-study-2026-10-05-to-2026-10-09.csv"');
  assert.deepEqual(parseCsv(csv.body).pop().slice(0, 5), ['total', '2026-10-05 to 2026-10-09', '', 'Irvine', label]);
});

// 10:30pm Wednesday in California is already Thursday in Toronto, and 5:30am Thursday in UTC.
test(['AT-3', 'AT-4'], 'every PDF says when it was made in a named local zone: across all locations, each zone\'s own time with its locations, never UTC', async () => {
  const w = await reportWorld();
  const tor = w.t.fx.location({ name: 'Toronto', timezone: TOR, lat: 43.65, lng: -79.38 });
  w.t.clock.set(at(LA, '2026-10-14', '22:30'));
  const q = 'from=2026-10-05&to=2026-10-09';
  const pdf = async (who, url) => pdfText((await w.t.as(who).get(url)).body);

  const all = await pdf(w.hq, `${A}/report.pdf?location=all&${q}`);
  assert.ok(all.includes('Generated: Oct 14, 2026, 10:30 PM PDT (Arcadia, Irvine) · Oct 15, 2026, 1:30 AM EDT (Toronto) '), all);
  assert.ok(!/UTC|GMT/.test(all), all);
  // One location: its own time, as its visit times are.
  assert.ok((await pdf(w.hq, `${A}/report.pdf?location=${tor.id}&${q}`)).includes('Generated: Oct 15, 2026, 1:30 AM EDT '));
  assert.ok((await pdf(w.director, `${A}/report.pdf?${q}`)).includes('Generated: Oct 14, 2026, 10:30 PM PDT '));
  assert.ok((await pdf(w.parent, `${A}/students/${w.kid.id}/log.pdf?${q}`)).includes('Generated: Oct 14, 2026, 10:30 PM PDT '));
});

// D-15 counts only sessions that have ended, so the screen needs to know whether a
// range has begun before it says nobody missed anything.
test(['AT-4'], 'a report says whether its range is still ahead, under way or over, by each location\'s own date', async () => {
  const w = await reportWorld();
  const tor = w.t.fx.location({ name: 'Toronto', timezone: TOR, lat: 43.65, lng: -79.38 });
  const timing = async (who, q) => {
    const r = await w.t.as(who).get(`${A}/report?${q}`);
    assert.equal(r.status, 200, q);
    return r.body.timing;
  };
  // Wed Oct 14, 10am in Irvine.
  assert.equal(await timing(w.director, 'from=2026-10-05&to=2026-10-13'), 'past');
  assert.equal(await timing(w.director, 'from=2026-10-12&to=2026-10-18'), 'current');
  assert.equal(await timing(w.director, 'from=2026-10-14&to=2026-10-14'), 'current');
  assert.equal(await timing(w.director, 'from=2026-10-15&to=2026-10-21'), 'upcoming');
  // 10:30pm in Irvine is Thursday in Toronto. A range from Thursday is still ahead in
  // Irvine but under way in Toronto, so across all locations it has begun.
  w.t.clock.set(at(LA, '2026-10-14', '22:30'));
  assert.equal(await timing(w.director, 'from=2026-10-15&to=2026-10-21'), 'upcoming');
  assert.equal(await timing(w.hq, `location=${tor.id}&from=2026-10-15&to=2026-10-21`), 'current');
  assert.equal(await timing(w.hq, 'location=all&from=2026-10-15&to=2026-10-21'), 'current');
  // A range ending Wednesday is over in Toronto, not yet in Irvine, so not yet across all locations.
  assert.equal(await timing(w.hq, `location=${tor.id}&from=2026-10-12&to=2026-10-14`), 'past');
  assert.equal(await timing(w.director, 'from=2026-10-12&to=2026-10-14'), 'current');
  assert.equal(await timing(w.hq, 'location=all&from=2026-10-12&to=2026-10-14'), 'current');
});

// ---------------------------------------------------------------- AT-4: the Reports screen in a browser tab

// Just enough DOM for public/js/app.js and the attendance view. As in a browser,
// replaceChildren/append turn anything that isn't a node into text (false -> "false").
class FakeNode {
  constructor(tag, data = '') { Object.assign(this, { tag, data, childNodes: [], attrs: new Map(), on: {}, parentNode: null }); }
  get textContent() { return this.tag ? this.childNodes.map(c => c.textContent).join('') : this.data; }
  set textContent(s) { this.replaceChildren(String(s)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  get id() { return this.getAttribute('id') ?? ''; }
  get dataset() { return Object.fromEntries([...this.attrs].filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])); }
  addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
  dispatch(type) { for (const fn of this.on[type] || []) fn({ type, target: this, currentTarget: this, preventDefault() {} }); }
  click() { this.dispatch('click'); }
  append(...kids) {
    for (const k of kids) {
      const n = k instanceof FakeNode ? k : new FakeNode(null, String(k));
      n.remove();
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(k) { this.append(k); return k; }
  replaceChildren(...kids) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; this.picked = undefined; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; }
  all() { return this.childNodes.flatMap(c => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  // An <input> keeps what was typed; a <select> shows the option set by value (none if no option matches), else its first.
  get value() {
    if (this.tag !== 'select') return this.typed ?? this.getAttribute('value') ?? '';
    const opts = this.all().filter(o => o.tag === 'option');
    const own = o => o.getAttribute('value') ?? o.textContent;
    if (this.picked !== undefined) return this.picked ? own(this.picked) : '';
    const o = opts.find(x => x.getAttribute('selected') !== null) || opts[0];
    return o ? own(o) : '';
  }
  set value(v) {
    if (this.tag !== 'select') { this.typed = String(v); return; }
    this.picked = this.all().find(o => o.tag === 'option' && (o.getAttribute('value') ?? o.textContent) === String(v)) || null;
  }
}

// One browser tab running the real client code (read from ROOT, so the mutation
// runner's copy is the one exercised) against the test server. Like a real tab,
// the view's module state outlives a sign-out and the next person's sign-in.
function browserTab(t) {
  let cookie = '';
  const requests = [], pending = new Set(), ids = {};
  const fetchAs = (url, opts = {}) => {
    const p = fetch(t.base + url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { cookie }) }))
      .then(async r => {
        const body = await r.arrayBuffer();
        requests.push({ url, status: r.status });
        return new Response(body, { status: r.status, headers: r.headers });
      });
    pending.add(p);
    const done = () => pending.delete(p);
    p.then(done, done);
    return p;
  };
  const document = {
    head: new FakeNode('head'), body: new FakeNode('body'), addEventListener() {},
    createElement: tag => new FakeNode(tag), createTextNode: s => new FakeNode(null, String(s)),
    getElementById: id => (ids[id] = ids[id] || new FakeNode('div')),
  };
  const win = { document, Node: FakeNode, fetch: fetchAs, Response, URL, console, navigator: {}, location: { hash: '' },
    history: { replaceState() {} }, addEventListener() {}, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
  win.window = win;
  vm.createContext(win);
  for (const f of ['public/js/app.js', 'public/js/views/attendance.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  // Waits until every request has answered and the view has drawn what came back.
  const settle = async () => {
    do {
      await Promise.allSettled([...pending]);
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    } while (pending.size);
  };
  return {
    requests, settle, toasts: () => document.getElementById('toasts'), hash: () => win.location.hash,
    // As App.boot() does after a sign-in, App.me says who is signed in.
    signIn(user) {
      const token = crypto.randomBytes(16).toString('hex');
      t.ctx.sessions.set(token, user.id);
      cookie = 'sid=' + token;
      win.App.me = { user: { id: user.id, role: user.role, name: user.name, location_id: user.location_id } };
    },
    async open(id) {
      const el = new FakeNode('div');
      await win.App.views.find(v => v.id === id).render(el);
      await settle();
      return el;
    },
    // A Home card, as Home draws it.
    async card(id) {
      const box = new FakeNode('section');
      await win.App.cards.find(c => c.id === id).render(box);
      await settle();
      return box;
    },
  };
}
const words = n => n.all().filter(c => !c.tag).map(c => c.data).join(' ').replace(/\s+/g, ' ').trim();
const byId = (root, id) => root.find(n => n.getAttribute('id') === id);
const field = (root, label) => root.find(n => n.tag === 'label' && n.childNodes[0] && n.childNodes[0].textContent === label).childNodes[1];
const button = (root, label) => root.find(n => n.tag === 'button' && n.textContent === label);
const reportBox = root => root.find(n => n.tag === 'section' && n.getAttribute('aria-label') === 'Report');

test(['AT-4'], 'Reports in a tab HQ used first: the director who signs in next gets their own location, all sessions and this month, and every report and download is theirs', async () => {
  const w = await reportWorld();
  const tab = browserTab(w.t);
  const R = `${A}/report`;

  // HQ narrows the report to Arcadia, Arcadia's session and one week, and shows it.
  tab.signIn(w.hq);
  const hq = await tab.open('reports');
  const pickLoc = byId(hq, 'rep-location');
  pickLoc.value = String(w.arcadia.id);
  pickLoc.dispatch('change');
  const pickSes = byId(hq, 'rep-session');
  pickSes.value = String(w.arcSession.id);
  pickSes.dispatch('change');
  for (const [label, d] of [['From', '2026-10-05'], ['To', '2026-10-09']]) {
    const input = field(hq, label);
    input.value = d;
    input.dispatch('change');
  }
  hq.find(n => n.tag === 'form').dispatch('submit');
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?location=${w.arcadia.id}&session=${w.arcSession.id}&from=2026-10-05&to=2026-10-09`, status: 200 });
  assert.equal(words(reportBox(hq)), 'Oct 5 – Oct 9, 2026 Arcadia · Arcadia Study · Mon/Wed/Fri 1:00 PM–4:00 PM Download CSV Download PDF ' +
    '1 visit 2.00 hours 1 student 1 absence By student Visits Absences Student Visits Hours Absences Zoe Park 1 2.00 1');

  // Same tab ("Switch user"): the Irvine director signs in and opens Reports.
  tab.signIn(w.director);
  const view = await tab.open('reports');
  const mine = `location=${w.loc.id}&from=2026-10-01&to=2026-10-31`;
  assert.deepEqual(tab.requests.slice(-2), [{ url: `${R}/options`, status: 200 }, { url: `${R}?${mine}`, status: 200 }]);
  assert.match(words(view), /Location: Irvine/);
  assert.equal(byId(view, 'rep-session').value, '');
  assert.deepEqual([field(view, 'From').value, field(view, 'To').value], ['2026-10-01', '2026-10-31']);
  const box = reportBox(view);
  assert.ok(!box.find(n => n.getAttribute('role') === 'alert'), words(box));
  // This month so far: Maya missed Fri Oct 2, Fri Oct 9 and Mon Oct 12; Ben missed Tue Oct 13.
  const head = 'Oct 1 – Oct 31, 2026 Irvine · All sessions Download CSV Download PDF 3 visits 8.50 hours 2 students 4 absences ';
  const byStudent = 'By student Visits Absences Student Visits Hours Absences Ben Cole 1 2.50 1 Maya Johnson 2 6.00 3';
  assert.equal(words(box), head + '1 visit needs review. These students didn\'t scan out and were checked out automatically. ' +
    'Confirm or fix the times from the In the building list. ' + byStudent);

  // Show report and both downloads ask for the director's own location too.
  for (const [label, url] of [['Download CSV', `${R}.csv?${mine}`], ['Download PDF', `${R}.pdf?${mine}`]]) {
    button(box, label).click();
    await tab.settle();
    assert.deepEqual(tab.requests.at(-1), { url, status: 200 }, label);
  }
  assert.deepEqual(tab.toasts().childNodes.map(n => n.textContent), [
    'Downloaded attendance-report-irvine-2026-10-01-to-2026-10-31.csv', 'Downloaded attendance-report-irvine-2026-10-01-to-2026-10-31.pdf']);

  // Staff confirm the automatic check-out; the next report has nothing to review, and says nothing about it.
  w.t.db.prepare('UPDATE visits SET reviewed_by = ? WHERE flagged = 1').run(w.staff.id);
  view.find(n => n.tag === 'form').dispatch('submit');
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?${mine}`, status: 200 });
  assert.equal(words(reportBox(view)), head + byStudent);
});

const STALE = 'The filters have changed. Tap Show report to update the report and its downloads.';
const statusOf = view => words(view.find(n => n.getAttribute('role') === 'status'));
const submit = view => view.find(n => n.tag === 'form').dispatch('submit');
function choose(view, values) {
  for (const [label, v] of Object.entries(values)) {
    const input = label === 'Session' ? byId(view, 'rep-session') : label === 'Location' ? byId(view, 'rep-location') : field(view, label);
    input.value = v;
    input.dispatch('change');
  }
}

test(['AT-4'], 'Reports: a changed filter marks the report out of date and holds its downloads until Show report; "no absences" says whether the range has begun; review links to In the building', async () => {
  const w = await reportWorld();
  const tab = browserTab(w.t);
  const R = `${A}/report`;
  tab.signIn(w.director);
  const view = await tab.open('reports');
  // Whether each download button is held: [CSV, PDF].
  const held = () => ['Download CSV', 'Download PDF'].map(l => button(reportBox(view), l).disabled === true);
  const month = `location=${w.loc.id}&from=2026-10-01&to=2026-10-31`;
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?${month}`, status: 200 });
  assert.deepEqual([statusOf(view), held()], ['', [false, false]]);
  // The review notice opens In the building at the report's location.
  const link = reportBox(view).find(n => n.tag === 'a');
  assert.deepEqual([link.textContent, link.getAttribute('href')], ['In the building', `#/building/${w.loc.id}`]);

  // Another session: out of date, downloads held, nothing fetched. Back to all sessions: current again.
  const asked = tab.requests.length;
  choose(view, { Session: String(w.am.id) });
  assert.deepEqual([statusOf(view), held()], [STALE, [true, true]]);
  choose(view, { Session: '' });
  assert.deepEqual([statusOf(view), held()], ['', [false, false]]);
  // Dates typed or picked from a shortcut, the same.
  choose(view, { From: '2026-10-05' });
  assert.deepEqual([statusOf(view), held()], [STALE, [true, true]]);
  button(view, 'This month').click();
  assert.deepEqual([statusOf(view), held()], ['', [false, false]]);
  await tab.settle();
  assert.equal(tab.requests.length, asked);

  // A download under way when the dates change: it's the report it was asked for, and its button comes back held.
  button(reportBox(view), 'Download CSV').click();
  button(view, 'This week').click();
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}.csv?${month}`, status: 200 });
  assert.deepEqual([statusOf(view), held()], [STALE, [true, true]]);

  // Show report: this week's report, current, and its downloads are this week's.
  submit(view);
  await tab.settle();
  const week = `location=${w.loc.id}&from=2026-10-12&to=2026-10-18`;
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?${week}`, status: 200 });
  assert.deepEqual([statusOf(view), held()], ['', [false, false]]);
  button(reportBox(view), 'Download PDF').click();
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}.pdf?${week}`, status: 200 });

  // No absences (Wed Oct 14, 10am): a range still ahead hasn't happened; today's is only
  // "so far" (Maya's 1pm session hasn't ended); an earlier week's Morning Focus had every check-in.
  const absences = async values => {
    choose(view, values);
    submit(view);
    await tab.settle();
    button(reportBox(view), 'Absences').click();
    return words(byId(view, 'rep-panel'));
  };
  assert.equal(await absences({ Session: '', From: '2026-10-19', To: '2026-10-25' }),
    'No sessions in this range have happened yet, so nobody has missed one.');
  assert.equal(await absences({ From: '2026-10-14', To: '2026-10-14' }),
    'No absences so far. Every session that has ended had a check-in, or was a closure day.');
  assert.equal(await absences({ Session: String(w.am.id), From: '2026-10-05', To: '2026-10-09' }),
    'No absences in this range. Every scheduled session had a check-in, or was a closure day.');
});

test(['AT-4'], 'Reports: HQ signing in after a director starts over on all locations; each session names its location; the Home card opens Reports on what it shows', async () => {
  const w = await reportWorld();
  const tab = browserTab(w.t);
  const R = `${A}/report`;
  const filters = view => [byId(view, 'rep-location').value, byId(view, 'rep-session').value, field(view, 'From').value, field(view, 'To').value];

  // The Irvine director narrows the report to Morning Focus, Oct 5-9, and the Visits tab.
  tab.signIn(w.director);
  const d = await tab.open('reports');
  choose(d, { Session: String(w.am.id), From: '2026-10-05', To: '2026-10-09' });
  submit(d);
  await tab.settle();
  button(reportBox(d), 'Visits').click();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?location=${w.loc.id}&session=${w.am.id}&from=2026-10-05&to=2026-10-09`, status: 200 });

  // Same tab: HQ signs in, and gets all locations, all sessions, this month and By student.
  tab.signIn(w.hq);
  const view = await tab.open('reports');
  assert.deepEqual(tab.requests.slice(-2), [{ url: `${R}/options`, status: 200 }, { url: `${R}?location=all&from=2026-10-01&to=2026-10-31`, status: 200 }]);
  assert.deepEqual(filters(view), ['all', '', '2026-10-01', '2026-10-31']);
  assert.equal(byId(view, 'rep-tab-students').getAttribute('aria-selected'), 'true');
  // Across all locations, the review notice opens In the building at Irvine, where the visit
  // to review is, not at the first location (Arcadia).
  const link = reportBox(view).find(n => n.tag === 'a');
  assert.deepEqual([link.textContent, link.getAttribute('href')], ['Irvine', `#/building/${w.loc.id}`]);

  // With all locations, every session says where it is; with one location chosen, it needn't.
  const sessions = () => byId(view, 'rep-session').all().filter(n => n.tag === 'option').map(o => o.textContent);
  assert.deepEqual(sessions(), ['All sessions', 'Arcadia · Arcadia Study · Mon/Wed/Fri 1:00 PM–4:00 PM',
    'Irvine · Afternoon Study · Mon/Wed/Fri 1:00 PM–4:00 PM', 'Irvine · Morning Focus · Tue/Thu 9:30 AM–12:00 PM']);
  choose(view, { Location: String(w.arcadia.id) });
  assert.deepEqual(sessions(), ['All sessions', 'Arcadia Study · Mon/Wed/Fri 1:00 PM–4:00 PM']);
  // A new location leaves the report on screen out of date too, until Show report.
  assert.equal(statusOf(view), STALE);
  submit(view);
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?location=${w.arcadia.id}&from=2026-10-01&to=2026-10-31`, status: 200 });
  assert.equal(statusOf(view), '');

  // Home: the card is all locations this week, and Open reports opens exactly that.
  const card = await tab.card('attendance-report');
  assert.match(words(card), /^Attendance this week All locations · Oct 12 – Oct 18, 2026 Open reports /);
  button(card, 'Open reports').click();
  assert.equal(tab.hash(), '#/reports');
  const opened = await tab.open('reports');
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?location=all&from=2026-10-12&to=2026-10-18`, status: 200 });
  assert.deepEqual(filters(opened), ['all', '', '2026-10-12', '2026-10-18']);
});

test(['AT-4'], 'Reports across all locations: the review notice links to In the building at each location with visits to review, with its count; one session chosen names its location in the heading and files', async () => {
  const w = await reportWorld();
  // Besides Maya's on Wed Oct 7 at Irvine: Zoe's at Arcadia that day and Ben's at Irvine on Tue Oct 13.
  const auto = { checkout_method: 'auto', flagged: 1, flag_reason: 'Did not scan out' };
  w.visit('2026-10-07', '13:00', '16:00', { student: w.zoe, location: w.arcadia, session: w.arcSession, extra: auto });
  w.visit('2026-10-13', '09:30', '12:00', { student: w.ben, session: w.am, extra: auto });
  const tab = browserTab(w.t);
  const R = `${A}/report`;
  tab.signIn(w.hq);
  const view = await tab.open('reports');
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?location=all&from=2026-10-01&to=2026-10-31`, status: 200 });
  const notice = () => reportBox(view).find(n => n.getAttribute('class') === 'notice notice-warn');
  const links = () => notice().all().filter(n => n.tag === 'a').map(a => [a.textContent, a.getAttribute('href')]);
  assert.equal(notice().textContent, '3 visits need review. These students didn\'t scan out and were checked out automatically. ' +
    'Confirm or fix the times from In the building at Arcadia (1), Irvine (2).');
  assert.deepEqual(links(), [['Arcadia', `#/building/${w.arcadia.id}`], ['Irvine', `#/building/${w.loc.id}`]]);

  // One session, location still "All locations": the report is Irvine's, and so are its links and files.
  choose(view, { Session: String(w.pm.id), From: '2026-10-05', To: '2026-10-09' });
  submit(view);
  await tab.settle();
  const q = `location=all&session=${w.pm.id}&from=2026-10-05&to=2026-10-09`;
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?${q}`, status: 200 });
  assert.match(words(reportBox(view)), /^Oct 5 – Oct 9, 2026 Irvine · Afternoon Study · Mon\/Wed\/Fri 1:00 PM–4:00 PM Download CSV Download PDF /);
  assert.deepEqual(links(), [['In the building', `#/building/${w.loc.id}`]]);
  for (const [label, url] of [['Download CSV', `${R}.csv?${q}`], ['Download PDF', `${R}.pdf?${q}`]]) {
    button(reportBox(view), label).click();
    await tab.settle();
    assert.deepEqual(tab.requests.at(-1), { url, status: 200 }, label);
  }
  assert.deepEqual(tab.toasts().childNodes.map(n => n.textContent), [
    'Downloaded attendance-report-irvine-afternoon-study-2026-10-05-to-2026-10-09.csv',
    'Downloaded attendance-report-irvine-afternoon-study-2026-10-05-to-2026-10-09.pdf']);
});

test(['AT-4'], 'Reports: a director moved to another location while signed in starts over there, not on the old location\'s filters', async () => {
  const w = await reportWorld();
  const tab = browserTab(w.t);
  const R = `${A}/report`;
  tab.signIn(w.director);
  const before = await tab.open('reports');
  choose(before, { Session: String(w.am.id), From: '2026-10-05', To: '2026-10-09' });
  submit(before);
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${R}?location=${w.loc.id}&session=${w.am.id}&from=2026-10-05&to=2026-10-09`, status: 200 });

  // HQ moves them to Arcadia; the app re-reads who they are and redraws.
  w.t.db.prepare('UPDATE users SET location_id = ? WHERE id = ?').run(w.arcadia.id, w.director.id);
  tab.signIn(Object.assign({}, w.director, { location_id: w.arcadia.id }));
  const after = await tab.open('reports');
  assert.deepEqual(tab.requests.slice(-2), [{ url: `${R}/options`, status: 200 }, { url: `${R}?location=${w.arcadia.id}&from=2026-10-01&to=2026-10-31`, status: 200 }]);
  assert.match(words(after), /Location: Arcadia/);
  assert.equal(byId(after, 'rep-session').value, '');
});

// ---------------------------------------------------------------- AT-2, AT-3: the Hours screen in a browser tab

test(['AT-2', 'AT-3'], 'Hours: another parent signing in on the same tab starts on their own student, this week and this month', async () => {
  const w = await world();
  const other = w.t.fx.family(w.loc);
  const S = `${A}/students`;
  const tab = browserTab(w.t);
  tab.signIn(w.parent);
  const mine = await tab.open('hours');
  button(mine, 'Month').click();
  choose(mine, { From: '2026-09-28', To: '2026-10-09' });
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${S}/${w.kid.id}/log?from=2026-09-28&to=2026-10-09`, status: 200 });

  tab.signIn(other.parent);
  const asked = tab.requests.length;
  const theirs = await tab.open('hours');
  assert.deepEqual(tab.requests.slice(asked).map(r => `${r.status} ${r.url}`).sort(),
    [`200 ${S}`, `200 ${S}/${other.student.id}/history?period=week`, `200 ${S}/${other.student.id}/log?from=2026-10-01&to=2026-10-31`].sort());
  assert.equal(byId(theirs, 'att-tab-week').getAttribute('aria-selected'), 'true');
  assert.deepEqual([field(theirs, 'From').value, field(theirs, 'To').value], ['2026-10-01', '2026-10-31']);
});

test(['AT-2', 'AT-3'], 'Hours in a browser tab: a parent of two picks a student, pages through week, month and term, and downloads that student\'s log for the dates chosen', async () => {
  const w = await world();
  const ava = rename(w.t, w.t.fx.user('student', { location: w.loc }), 'Ava Johnson');
  w.t.fx.link(w.parent, ava);
  w.visit('2026-10-13', '09:30', '12:00', { student: ava, session: null });
  // Maya: Mon Sep 28 missed, Wed Sep 30 2h 30m, Fri Oct 2 2h 56m, Oct 5/7/9 missed, Mon Oct 12 3h.
  w.visit('2026-09-30', '13:00', '15:30');
  w.visit('2026-10-02', '13:02', '15:58');
  w.visit('2026-10-12', '13:00', '16:00');
  const S = `${A}/students`;
  const tab = browserTab(w.t);
  const after = i => tab.requests.slice(i).map(r => `${r.status} ${r.url}`).sort();
  const act = async fn => { const i = tab.requests.length; fn(); await tab.settle(); return after(i); };

  tab.signIn(w.parent);
  const view = await tab.open('hours');
  const history = byId(view, 'att-history');
  const shown = () => ({
    label: words(history.find(n => n.getAttribute('class') === 'att-nav-label')),
    totals: words(history.find(n => /\batt-stats\b/.test(n.getAttribute('class') || ''))),
  });
  const preview = () => words(view.find(n => n.getAttribute('aria-live') === 'polite'));

  // Ava sorts first, so she shows first: this week, and this month's log preview.
  assert.deepEqual(after(0), [`200 ${S}`, `200 ${S}/${ava.id}/history?period=week`, `200 ${S}/${ava.id}/log?from=2026-10-01&to=2026-10-31`].sort());
  assert.equal(field(view, 'Student').value, String(ava.id));
  assert.deepEqual(shown(), { label: 'Oct 12 – Oct 18, 2026', totals: '1 visit 2.50 hours 0 absences' });
  assert.equal(preview(), 'Oct 1 – Oct 31, 2026: 1 visit · 2.50 hours · 0 absences');

  // Picking Maya redraws her history and her log preview.
  const pick = field(view, 'Student');
  assert.deepEqual(await act(() => { pick.value = String(w.kid.id); pick.dispatch('change'); }),
    [`200 ${S}/${w.kid.id}/history?period=week`, `200 ${S}/${w.kid.id}/log?from=2026-10-01&to=2026-10-31`].sort());
  assert.equal(words(history), '‹ Oct 12 – Oct 18, 2026 › 1 visit 3.00 hours 0 absences ' +
    'Mon, Oct 12 · Afternoon Study 1:00 PM – 4:00 PM · 3h 0m Scanned out ' +
    'Times are Irvine time. An absence is a scheduled session with no check-in; closure days don\'t count.');
  assert.equal(preview(), 'Oct 1 – Oct 31, 2026: 2 visits · 5.93 hours · 3 absences');

  // Month, the month before, term, and back to week: each asks for that period.
  assert.deepEqual(await act(() => button(view, 'Month').click()), [`200 ${S}/${w.kid.id}/history?period=month`]);
  assert.deepEqual(shown(), { label: 'October 2026', totals: '2 visits 5.93 hours 3 absences' });
  assert.equal(button(view, 'Month').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await act(() => view.find(n => n.getAttribute('aria-label') === 'Previous month').click()),
    [`200 ${S}/${w.kid.id}/history?period=month&date=2026-09-01`]);
  assert.deepEqual(shown(), { label: 'September 2026', totals: '1 visit 2.50 hours 1 absence' });
  assert.deepEqual(await act(() => button(view, 'Term').click()), [`200 ${S}/${w.kid.id}/history?period=term`]);
  assert.deepEqual(shown(), { label: 'Fall 2026 Aug 17 – Dec 18, 2026', totals: '3 visits 8.43 hours 4 absences' });
  assert.deepEqual(await act(() => button(view, 'Week').click()), [`200 ${S}/${w.kid.id}/history?period=week`]);
  assert.deepEqual(shown(), { label: 'Oct 12 – Oct 18, 2026', totals: '1 visit 3.00 hours 0 absences' });

  // Her own dates, then both downloads for exactly those dates.
  assert.deepEqual(await act(() => {
    for (const [label, d] of [['From', '2026-09-28'], ['To', '2026-10-09']]) {
      const input = field(view, label);
      input.value = d;
      input.dispatch('change');
    }
  }), [`200 ${S}/${w.kid.id}/log?from=2026-09-28&to=2026-10-31`, `200 ${S}/${w.kid.id}/log?from=2026-09-28&to=2026-10-09`].sort());
  assert.equal(preview(), 'Sep 28 – Oct 9, 2026: 2 visits · 5.43 hours · 4 absences');
  const range = 'from=2026-09-28&to=2026-10-09';
  assert.deepEqual(await act(() => button(view, 'Download PDF').click()), [`200 ${S}/${w.kid.id}/log.pdf?${range}`]);
  assert.deepEqual(await act(() => button(view, 'Download CSV').click()), [`200 ${S}/${w.kid.id}/log.csv?${range}`]);
  assert.deepEqual(tab.toasts().childNodes.map(n => n.textContent), [
    'Downloaded attendance-maya-johnson-2026-09-28-to-2026-10-09.pdf', 'Downloaded attendance-maya-johnson-2026-09-28-to-2026-10-09.csv']);
});

// ---------------------------------------------------------------- NF-1

test(['NF-1'], 'a parent cannot see or export another family\'s student, even with a pending link', async () => {
  const w = await world();
  w.visit('2026-10-12', '13:00', '16:00');
  const strangers = w.t.fx.family(w.loc);
  const stranger = strangers.parent;
  const pending = w.t.fx.user('parent', { location: w.loc });
  w.t.fx.link(pending, w.kid, 'pending');
  const q = 'from=2026-10-01&to=2026-10-31';
  for (const who of [stranger, pending]) {
    for (const url of [`/students/${w.kid.id}/history`, `/students/${w.kid.id}/history?period=term`, `/students/${w.kid.id}/log?${q}`,
      `/students/${w.kid.id}/log.csv?${q}`, `/students/${w.kid.id}/log.pdf?${q}`]) {
      const r = await w.t.as(who).get(A + url);
      assert.equal(r.status, 403, url);
      assert.equal(r.body.error, 'forbidden', url);
    }
    const list = await w.t.as(who).get(`${A}/students`);
    assert.equal(list.status, 200);
    assert.ok(!list.body.students.some(s => s.id === w.kid.id));
  }
  assert.equal((await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log.csv?${q}`)).status, 200);

  // The other family's student holds the same Wednesday slot. Each parent's own
  // records carry only their own student's absences, never the other family's.
  const theirs = rename(w.t, strangers.student, 'Zoe Park');
  enrollSince(w.t, theirs, w.pm, 3, at(LA, '2026-09-28', '08:00'));
  const week = 'period=week&date=2026-10-07', range = 'from=2026-10-05&to=2026-10-09';
  for (const [parent, kid, name, dates] of [[stranger, theirs, 'Zoe Park', ['2026-10-07']],
    [w.parent, w.kid, 'Maya Johnson', ['2026-10-05', '2026-10-07', '2026-10-09']]]) {
    const p = w.t.as(parent);
    const own = dates.map(d => [d, kid.id]);
    const h = await p.get(`${A}/students/${kid.id}/history?${week}`);
    assert.equal(h.status, 200);
    assert.deepEqual(h.body.absences.map(a => [a.date, a.student_id]), own, name);
    const l = await p.get(`${A}/students/${kid.id}/log?${range}`);
    assert.deepEqual(l.body.absences.map(a => [a.date, a.student_id]), own, name);
    const csv = parseCsv((await p.get(`${A}/students/${kid.id}/log.csv?${range}`)).body);
    assert.deepEqual(csv.filter(x => x[0] === 'absent').map(x => [x[1], x[2]]), dates.map(d => [d, name]));
    const pdf = pdfText((await p.get(`${A}/students/${kid.id}/log.pdf?${range}`)).body);
    assert.ok(pdf.includes(`Student: ${name}`), pdf);
    assert.ok(pdf.includes(`Total hours · 0m ${dates.length} Absences`), pdf);
  }
});

test(['NF-1'], 'family routes are for parents: students, staff, directors, HQ and signed-out visitors are refused', async () => {
  const w = await world();
  const q = 'from=2026-10-01&to=2026-10-31';
  const urls = ['/students', `/students/${w.kid.id}/history`, `/students/${w.kid.id}/log?${q}`, `/students/${w.kid.id}/log.csv?${q}`,
    `/students/${w.kid.id}/log.pdf?${q}`];
  for (const who of [w.kid, w.t.fx.staff(w.loc), w.t.fx.director(w.loc), w.t.fx.hq()]) {
    for (const url of urls) assert.equal((await w.t.as(who).get(A + url)).status, 403, `${who.role} ${url}`);
  }
  for (const url of urls) assert.equal((await w.t.anon.get(A + url)).status, 401, url);
});

test(['NF-1'], 'reports are for directors and HQ: staff, parents, students and signed-out visitors are refused', async () => {
  const w = await reportWorld();
  const q = 'from=2026-10-05&to=2026-10-09';
  const urls = ['/report/options', `/report?${q}`, `/report.csv?${q}`, `/report.pdf?${q}`];
  for (const who of [w.staff, w.parent, w.kid]) {
    for (const url of urls) {
      const r = await w.t.as(who).get(A + url);
      assert.equal(r.status, 403, `${who.role} ${url}`);
      assert.equal(r.body.error, 'forbidden');
    }
  }
  for (const url of urls) assert.equal((await w.t.anon.get(A + url)).status, 401, url);
});

test(['NF-1'], 'a director cannot report on another location, on all locations, or on another location\'s session', async () => {
  const w = await reportWorld();
  const d = w.t.as(w.director);
  const q = 'from=2026-10-05&to=2026-10-09';
  for (const ext of ['', '.csv', '.pdf']) {
    for (const filter of [`location=${w.arcadia.id}`, 'location=all', `session=${w.arcSession.id}`, `location=${w.loc.id}&session=${w.arcSession.id}`]) {
      const r = await d.get(`${A}/report${ext}?${filter}&${q}`);
      assert.equal(r.status, 403, `${ext} ${filter}`);
      assert.equal(r.body.error, 'forbidden', `${ext} ${filter}`);
    }
  }
  const opts = await d.get(`${A}/report/options`);
  assert.ok(opts.body.locations.every(l => l.id === w.loc.id));
  const own = await d.get(`${A}/report?location=${w.loc.id}&${q}`);
  assert.equal(own.status, 200);
  assert.ok(own.body.visits.every(v => v.location_id === w.loc.id));
  // The Arcadia director sees Arcadia only.
  const arcDirector = w.t.fx.director(w.arcadia);
  const arc = await w.t.as(arcDirector).get(`${A}/report?${q}`);
  assert.deepEqual(arc.body.visits.map(v => v.student_name), ['Zoe Park']);
  assert.deepEqual(arc.body.absences.map(a => [a.date, a.student_name]), [['2026-10-07', 'Zoe Park']]);

  // Absences too: Zoe missed Arcadia's Wed Oct 7 session. Irvine's report, its
  // per-student totals and both files leave her out; HQ's all-locations report has her.
  for (const filter of ['', `location=${w.loc.id}&`]) {
    const r = await d.get(`${A}/report?${filter}${q}`);
    assert.deepEqual(r.body.absences.map(a => [a.date, a.student_name, a.location_id]), [['2026-10-09', 'Maya Johnson', w.loc.id]], filter);
    assert.equal(r.body.totals.absences, 1, filter);
    assert.deepEqual(r.body.by_student.map(s => [s.student_name, s.absences]), [['Ben Cole', 0], ['Maya Johnson', 1]], filter);
  }
  const csv = parseCsv((await d.get(`${A}/report.csv?${q}`)).body);
  assert.deepEqual(csv.filter(x => x[0] === 'absent').map(x => [x[1], x[2], x[3]]), [['2026-10-09', 'Maya Johnson', 'Irvine']]);
  assert.ok(!csv.some(x => x.includes('Zoe Park')));
  const pdf = pdfText((await d.get(`${A}/report.pdf?${q}`)).body);
  assert.ok(pdf.includes('2 Students 1 Absences'), pdf);
  assert.ok(!pdf.includes('Zoe Park') && !pdf.includes('Arcadia'), pdf);
  const all = await w.t.as(w.hq).get(`${A}/report?location=all&${q}`);
  assert.deepEqual(all.body.absences.map(a => [a.date, a.student_name]), [['2026-10-07', 'Zoe Park'], ['2026-10-09', 'Maya Johnson']]);
  assert.deepEqual(all.body.by_student.map(s => [s.student_name, s.absences]), [['Ben Cole', 0], ['Maya Johnson', 1], ['Zoe Park', 1]]);
});

// ---------------------------------------------------------------- Round-1 sweep rules (R2, R8) and the report chips (S8)

test(['AT-2', 'AT-4'], 'R2: back-to-back sessions are one visit, and it counts for every enrolled slot it overlaps at that location that day', async () => {
  const w = await world();
  const evening = w.t.fx.session(w.loc, { term: w.term, name: 'Evening Study', weekdays: '1', start: '16:00', end: '19:00' });
  enrollSince(w.t, w.kid, evening, 1, at(LA, '2026-09-28', '08:00'));
  // Ben holds only the afternoon slot on Mondays.
  const ben = rename(w.t, w.t.fx.family(w.loc).student, 'Ben Cole');
  enrollSince(w.t, ben, w.pm, 1, at(LA, '2026-09-28', '08:00'));
  // Kai held both Monday slots, but his evening one ended Wed Sep 30, and his
  // evening one again from Oct 6 on: neither was his on Oct 5.
  const kai = rename(w.t, w.t.fx.family(w.loc).student, 'Kai Lee');
  enrollSince(w.t, kai, w.pm, 1, at(LA, '2026-09-28', '08:00'));
  const kaiOld = enrollSince(w.t, kai, evening, 1, at(LA, '2026-09-28', '08:00'));
  w.t.db.prepare("UPDATE enrollments SET status = 'dropped', ended_at = ? WHERE id = ?").run(at(LA, '2026-09-30', '12:00'), kaiOld.id);
  enrollSince(w.t, kai, evening, 1, at(LA, '2026-10-06', '08:00'));
  const director = w.t.fx.director(w.loc);
  w.visit('2026-10-05', '12:55', '18:55');                   // Maya stays from the afternoon through the evening
  w.visit('2026-10-12', '13:00', '15:30');                   // and leaves before the evening one week later
  w.visit('2026-10-05', '13:00', '17:00', { student: ben }); // Ben stays past his session
  w.visit('2026-10-05', '13:00', '17:30', { student: kai }); // so does Kai
  w.visit('2026-10-12', '13:00', '18:50', { student: kai }); // and on Oct 12 he holds the evening slot too

  const log = await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log?from=2026-10-05&to=2026-10-12`);
  assert.deepEqual(log.body.absences.map(a => [a.date, a.session_name]),
    [['2026-10-07', 'Afternoon Study'], ['2026-10-09', 'Afternoon Study'], ['2026-10-12', 'Evening Study']]);
  // The evening session's report lists Maya's visit, which covered it, and Kai's on Oct 12; Ben was
  // never enrolled there, and on Oct 5 Kai's evening slot had ended and not yet started again.
  const rep = await w.t.as(director).get(`${A}/report?session=${evening.id}&from=2026-10-05&to=2026-10-12`);
  assert.equal(rep.status, 200);
  assert.deepEqual(rep.body.visits.map(v => [v.date, v.student_name, v.session_name, v.minutes]),
    [['2026-10-05', 'Maya Johnson', 'Afternoon Study', 360], ['2026-10-12', 'Kai Lee', 'Afternoon Study', 350]]);
  assert.deepEqual(rep.body.absences.map(a => [a.date, a.student_name]), [['2026-10-12', 'Maya Johnson']]);
  assert.deepEqual(rep.body.by_student.map(s => [s.student_name, s.visits, s.absences]), [['Kai Lee', 1, 0], ['Maya Johnson', 1, 1]]);
});

// Fix list Oct 21, item 1: a visit still open (no check-out yet) has lasted only until now, and never
// past the time auto-checkout will close it (D-14). It covers a later session only once that session
// has begun, and only while the stay runs on back to back (R2, D-28).
test(['AT-2', 'AT-4'], 'an open visit covers only sessions already under way, never a later one, in absences and session reports', async () => {
  const w = await world(); // Maya: Afternoon Study Mon/Wed/Fri 13:00-16:00
  const director = w.t.fx.director(w.loc);
  const morning = w.t.fx.session(w.loc, { term: w.term, name: 'Morning Focus', weekdays: '3', start: '09:30', end: '12:00' });
  const midday = w.t.fx.session(w.loc, { term: w.term, name: 'Midday Lab', weekdays: '3', start: '12:00', end: '13:00' });
  enrollSince(w.t, w.kid, morning, 3, at(LA, '2026-09-28', '08:00'));
  const ben = rename(w.t, w.t.fx.family(w.loc).student, 'Ben Cole'); // Morning Focus then Midday Lab, back to back
  enrollSince(w.t, ben, morning, 3, at(LA, '2026-09-28', '08:00'));
  enrollSince(w.t, ben, midday, 3, at(LA, '2026-09-28', '08:00'));
  const d = '2026-10-14';
  w.visit(d, '09:55', null, { session: morning });                // Maya scanned in for Morning Focus, still in
  w.visit(d, '09:55', null, { session: morning, student: ben });  // so did Ben
  const report = async s => (await w.t.as(director).get(`${A}/report?session=${s.id}&from=${d}&to=${d}`)).body.visits.map(v => v.student_name);
  const absent = async () => (await w.t.as(w.parent).get(`${A}/students/${w.kid.id}/log?from=${d}&to=${d}`)).body.absences.map(a => a.session_name);
  // 11:00: neither visit covers a session that hasn't started.
  w.t.clock.set(at(LA, d, '11:00'));
  assert.deepEqual(await report(w.pm), []);
  assert.deepEqual(await report(midday), []);
  // 12:30: Ben's stay runs on into Midday Lab, which has begun (R2).
  w.t.clock.set(at(LA, d, '12:30'));
  assert.deepEqual(await report(midday), ['Ben Cole']);
  assert.deepEqual(await report(w.pm), []);
  // 5pm with auto-checkout not yet run: Maya's visit closes at 12:00 (Afternoon Study's check-in window
  // opened only at 12:30), so she missed Afternoon Study; Ben's covered Midday Lab to its end.
  w.t.clock.set(at(LA, d, '17:00'));
  assert.deepEqual(await absent(), ['Afternoon Study']);
  assert.deepEqual(await report(w.pm), []);
  assert.deepEqual(await report(midday), ['Ben Cole']);
});

test(['AT-2', 'AT-4'], 'R8: after a session\'s times change, past dates keep the times they had for absences, overlaps and the hours shown', async () => {
  const w = await world();
  const director = w.t.fx.director(w.loc);
  // Leo enrolled on Mon Oct 5 at 2pm, with that day's 1-4pm session already under way.
  const leoFam = w.t.fx.family(w.loc), leo = rename(w.t, leoFam.student, 'Leo Garcia');
  enrollSince(w.t, leo, w.pm, 1, at(LA, '2026-10-05', '14:00'));
  w.visit('2026-10-12', '13:02', '15:58', { student: leo });
  // Ava has held Mondays since Sep 28: she missed Sep 28, came Oct 5, and on Oct 12 staff checked her in with no session.
  const avaFam = w.t.fx.family(w.loc), ava = rename(w.t, avaFam.student, 'Ava Brown');
  enrollSince(w.t, ava, w.pm, 1, at(LA, '2026-09-28', '08:00'));
  w.visit('2026-10-05', '13:00', '16:00', { student: ava });
  w.visit('2026-10-12', '13:05', '14:50', { student: ava, session: null, extra: { checkin_method: 'staff', checkout_method: 'staff' } });
  // Tue Oct 13: the director moves the session to 3-6pm from that day on, as the sessions module records it.
  w.t.clock.set(at(LA, '2026-10-13', '10:00'));
  w.t.db.prepare("UPDATE sessions SET start_time = '15:00', end_time = '18:00' WHERE id = ?").run(w.pm.id);
  w.t.db.prepare("INSERT INTO session_times (session_id, until_date, start_time, end_time, changed_at) VALUES (?, '2026-10-12', '13:00', '16:00', ?)")
    .run(w.pm.id, w.t.clock.now());
  // Another session's own history never applies to this one.
  const other = w.t.fx.session(w.loc, { term: w.term, name: 'Morning Focus', weekdays: '2', start: '09:30', end: '12:00' });
  w.t.db.prepare("INSERT INTO session_times (session_id, until_date, start_time, end_time, changed_at) VALUES (?, '2026-12-31', '09:00', '11:00', ?)")
    .run(other.id, w.t.clock.now());
  w.t.clock.set(at(LA, '2026-10-19', '19:00'));

  const abs = async (fam, s) => (await w.t.as(fam.parent).get(`${A}/students/${s.id}/log?from=2026-09-28&to=2026-10-19`))
    .body.absences.map(a => [a.date, a.start_time, a.end_time]);
  // Oct 5 was never owed (he enrolled after 1pm); Oct 19 is under the new hours.
  assert.deepEqual(await abs(leoFam, leo), [['2026-10-19', '15:00', '18:00']]);
  // Sep 28 shows the hours it had; the staff check-in on Oct 12 overlapped that day's 1-4pm.
  assert.deepEqual(await abs(avaFam, ava), [['2026-09-28', '13:00', '16:00'], ['2026-10-19', '15:00', '18:00']]);
  // A report on the session lists that staff check-in, by the hours the session had on Oct 12.
  const rep = await w.t.as(director).get(`${A}/report?session=${w.pm.id}&from=2026-10-12&to=2026-10-12`);
  assert.deepEqual(rep.body.visits.map(v => [v.student_name, v.session_name, v.check_in_local]).sort(),
    [['Ava Brown', null, '13:05'], ['Leo Garcia', 'Afternoon Study', '13:02']]);
  assert.deepEqual(rep.body.absences.map(a => [a.student_name, a.start_time]), [['Maya Johnson', '13:00']]);
});

test(['AT-4'], 'Reports: HQ choosing another location gets that location\'s range shortcuts, and a chosen shortcut becomes the same one there (its own term and week)', async () => {
  const w = await reportWorld();
  // Toronto's Fall 2026 starts later than the Los Angeles terms.
  const tor = w.t.fx.location({ name: 'Toronto', timezone: TOR, lat: 43.65, lng: -79.38 });
  w.t.fx.term(tor, { start: '2026-09-08' });
  // Sun Oct 18, 10:30pm in Los Angeles is already Mon Oct 19 in Toronto.
  w.t.clock.set(Date.UTC(2026, 9, 19, 5, 30));
  const tab = browserTab(w.t);
  tab.signIn(w.hq);
  const view = await tab.open('reports');
  const range = () => [field(view, 'From').value, field(view, 'To').value];
  const chip = label => view.find(n => n.tag === 'button' && n.textContent === label && n.getAttribute('data-from'));

  chip('Fall 2026').click();
  assert.deepEqual(range(), ['2026-08-17', '2026-12-18']);
  choose(view, { Location: String(tor.id) });
  assert.deepEqual(range(), ['2026-09-08', '2026-12-18'], 'Fall 2026 is now Toronto\'s Fall 2026');
  assert.equal(chip('Fall 2026').getAttribute('aria-pressed'), 'true');
  chip('This week').click();
  assert.deepEqual(range(), ['2026-10-19', '2026-10-25'], 'this week is Toronto\'s week');
  submit(view);
  await tab.settle();
  assert.deepEqual(tab.requests.at(-1), { url: `${A}/report?location=${tor.id}&from=2026-10-19&to=2026-10-25`, status: 200 });
  // Back to Arcadia: its own week, which has not turned over yet.
  choose(view, { Location: String(w.arcadia.id) });
  assert.deepEqual(range(), ['2026-10-12', '2026-10-18']);
  // Dates typed by hand stay as typed when the location changes.
  choose(view, { From: '2026-10-01', To: '2026-10-02' });
  choose(view, { Location: String(tor.id) });
  assert.deepEqual(range(), ['2026-10-01', '2026-10-02']);
});

// L61: each visit's hours are rounded once; every hours total is the sum of the
// visit hours it covers, so the hours column adds up to the total in the CSV, the
// PDF and every screen. Minutes stay exact.
test(['AT-1', 'AT-3', 'AT-4'], 'hours add up: per-visit and per-student hours sum to the printed total in the CSV, PDF, reports and screens', async () => {
  const w = await reportWorld();
  const t = w.t;
  t.clock.set(at(LA, '2026-10-16', '17:00')); // Fri Oct 16
  // Maya: three 181-minute visits this week (3.0167 hours each). Ben and Ava: one each.
  for (const d of ['2026-10-12', '2026-10-14', '2026-10-16']) w.visit(d, '13:00', '16:01');
  const ava = rename(t, t.fx.family(w.loc).student, 'Ava Diaz');
  w.visit('2026-10-16', '13:00', '16:01', { student: w.ben, session: null });
  w.visit('2026-10-16', '13:00', '16:01', { student: ava, session: null });
  const sum = list => Math.round(list.reduce((s, x) => s + Number(x), 0) * 100) / 100;
  const S = `${A}/students/${w.kid.id}`, range = 'from=2026-10-12&to=2026-10-16';

  // The family CSV: 3.02 + 3.02 + 3.02 = 9.06, and the total row says 9.06 (543 minutes).
  const rows = parseCsv((await t.as(w.parent).get(`${S}/log.csv?${range}`)).body);
  const visits = rows.filter(r => r[0] === 'visit'), total = rows.at(-1);
  assert.deepEqual(visits.map(r => [r[7], r[8]]), [['181', '3.02'], ['181', '3.02'], ['181', '3.02']]);
  assert.deepEqual([total[0], total[7], total[8]], ['total', '543', '9.06']);
  assert.equal(sum(visits.map(r => r[8])).toFixed(2), total[8]);
  // The same total in the log, the week's history, the Home totals and the PDF.
  const log = await t.as(w.parent).get(`${S}/log?${range}`);
  assert.deepEqual([log.body.totals.minutes, log.body.totals.hours], [543, 9.06]);
  assert.equal((await t.as(w.parent).get(`${S}/history?period=week`)).body.totals.hours, 9.06);
  assert.equal((await t.as(w.parent).get(`${A}/students`)).body.students[0].week.totals.hours, 9.06);
  assert.ok(pdfText((await t.as(w.parent).get(`${S}/log.pdf?${range}`)).body).includes('3 Visits 9.06 Total hours · 9h 3m'));

  // The director's report: per-student hours add up to the total, and Maya's matches her own log.
  const rep = await t.as(w.director).get(`${A}/report?from=2026-10-16&to=2026-10-16`);
  assert.deepEqual(rep.body.by_student.map(s => [s.student_name, s.minutes, s.hours]),
    [['Ava Diaz', 181, 3.02], ['Ben Cole', 181, 3.02], ['Maya Johnson', 181, 3.02]]);
  assert.deepEqual([rep.body.totals.minutes, rep.body.totals.hours], [543, 9.06]);
  const week = await t.as(w.director).get(`${A}/report?${range}`);
  assert.equal(week.body.by_student.find(s => s.student_name === 'Maya Johnson').hours, log.body.totals.hours);
  assert.equal(sum(week.body.by_student.map(s => s.hours)), week.body.totals.hours);
  assert.equal(week.body.totals.hours, 15.1); // five visits of 3.02; 905 minutes alone would round to 15.08
  const repRows = parseCsv((await t.as(w.director).get(`${A}/report.csv?${range}`)).body);
  assert.equal(sum(repRows.filter(r => r[0] === 'visit').map(r => r[8])).toFixed(2), repRows.at(-1)[8]);
  assert.equal(repRows.at(-1)[8], '15.10');
  const pdf = pdfText((await t.as(w.director).get(`${A}/report.pdf?${range}`)).body);
  for (const want of ['15.10 Total hours · 15h 5m', 'Ava Diaz 1 3.02', 'Ben Cole 1 3.02', 'Maya Johnson 3 9.06']) assert.ok(pdf.includes(want), want + ' in ' + pdf);

  // The screens show the server's hours, not hours worked out again from minutes.
  const tab = browserTab(t);
  tab.signIn(w.parent);
  const hours = await tab.open('hours');
  assert.match(words(byId(hours, 'att-history')), /3 visits 9\.06 hours/);
  tab.signIn(w.director);
  const reports = await tab.open('reports');
  // This month: Maya 3.00 + 3.00 + 3 x 3.02 = 15.06 (903 minutes alone: 15.05); with Ben's 5.52 and Ava's 3.02, 23.60.
  assert.match(words(reportBox(reports)), /^Oct 1 – Oct 31, 2026 .* 8 visits 23\.60 hours .* Ava Diaz 1 3\.02 0 Ben Cole 2 5\.52 1 Maya Johnson 5 15\.06 2$/);
});
