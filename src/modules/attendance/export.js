'use strict';
// Attendance files (AT-3, AT-4): CSV and PDF built from a log (service.log).
// Times are the location's local time (AT-1). The CSV has stable column names
// and ISO dates; the PDF is laid out to hand to a homeschool evaluator as is.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { hundredths } = require('./service');
const { DateTime } = require('luxon');

// Every PDF is drawn in DejaVu Sans (fonts/LICENSE.txt), embedded in the file.
// pdfkit's built-in Helvetica has only the Windows-1252 characters, so names
// like "Nguyễn", "Łucja" or "Елена" would print as garbage.
const FONT = {
  body: fs.readFileSync(path.join(__dirname, 'fonts', 'DejaVuSans.ttf')),
  bold: fs.readFileSync(path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf')),
};

const FAMILY_COLUMNS = ['record', 'date', 'student', 'location', 'session', 'check_in', 'check_out', 'minutes', 'hours',
  'check_out_method', 'time_zone'];
// Directors and HQ also see who checked a student in or out by hand, and what still needs review.
const STAFF_COLUMNS = [...FAMILY_COLUMNS, 'checked_in_by', 'checked_out_by', 'needs_review'];

const METHOD = { scan: 'Scanned out', auto: 'Automatic (did not scan out)', staff: 'By staff' };

// Hours as every file prints them: a visit's own rounded hours, or a total that
// is the sum of those (service.totals, service.byStudent), so the columns add up.
const decimalHours = hours => hours.toFixed(2);
const visitHours = minutes => decimalHours(hundredths(minutes) / 100);
const duration = m => (Math.floor(m / 60) ? Math.floor(m / 60) + 'h ' : '') + (m % 60) + 'm';
const local = (ms, zone) => DateTime.fromMillis(ms, { zone, locale: 'en-US' });
const clock = (ms, zone) => local(ms, zone).toFormat('h:mm a');
const longDate = iso => DateTime.fromISO(iso, { locale: 'en-US' }).toFormat('ccc, LLL d, yyyy');
const hhmm = s => DateTime.fromFormat(s, 'HH:mm', { locale: 'en-US' }).toFormat('h:mm a');
const shortDate = iso => DateTime.fromISO(iso, { locale: 'en-US' }).toFormat('LLL d, yyyy');
const between = (from, to) => `between ${shortDate(from)} and ${shortDate(to)}`;

// A file-name-safe piece: "Leo García" -> "leo-garcia".
function slug(s, fallback) {
  const out = String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || fallback;
}

// ---------- CSV ----------

// One CSV cell. Text a spreadsheet would run as a formula gets a leading quote.
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Visits and absences in date order, then a total row. The total row carries
// what the file covers, so it still says so once it is saved or forwarded: the
// chosen date range ("2026-10-01 to 2026-10-09") in the date column, and `who`:
// the student (blank on a multi-student report), the location, and the session
// filter of a report.
function csv(log, { staff = false, who = {}, range } = {}) {
  const rows = [];
  for (const v of log.visits) {
    rows.push({ date: v.date, at: v.check_in_local, cells: ['visit', v.date, v.student_name, v.location_name, v.session_name || '',
      v.check_in_local, v.check_out_local || '', v.minutes ?? '', v.minutes == null ? '' : visitHours(v.minutes),
      v.checkout_method || '', v.timezone,
      ...(staff ? [v.checked_in_by_name || '', v.checked_out_by_name || '', v.needs_review ? 'yes' : 'no'] : [])] });
  }
  for (const a of log.absences) {
    rows.push({ date: a.date, at: a.start_time, cells: ['absent', a.date, a.student_name, a.location_name, a.session_name,
      '', '', '', '', '', a.timezone, ...(staff ? ['', '', ''] : [])] });
  }
  rows.sort((x, y) => x.date.localeCompare(y.date) || x.at.localeCompare(y.at));
  const total = ['total', `${range.from} to ${range.to}`, who.student || '', who.location || '', who.session || '', '', '', log.totals.minutes,
    decimalHours(log.totals.hours), '', '', ...(staff ? ['', '', ''] : [])];
  const lines = [(staff ? STAFF_COLUMNS : FAMILY_COLUMNS).join(','), ...rows.map(r => r.cells.map(cell).join(',')), total.map(cell).join(',')];
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // BOM so Excel reads names with accents correctly
}

// ---------- PDF ----------

const INK = '#1b1f2a', MUTED = '#5b6170', LINE = '#dedad0', SHADE = '#f0eee8';

// Builds a PDF in memory and resolves with its bytes.
function render(build, opts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(Object.assign({ size: 'LETTER', margin: 48, bufferPages: true }, opts));
    doc.registerFont('Body', FONT.body).registerFont('Bold', FONT.bold);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { build(doc); doc.end(); } catch (e) { reject(e); }
  });
}

// Text options with one glyph per letter. With ligatures ("ff" drawn as one
// glyph), some PDF readers copy, search and read aloud "staff" as "staf".
// fontkit writes into the features object, so each call gets its own.
const plain = (o = {}) => Object.assign({}, o, { features: { liga: false } });

const left = doc => doc.page.margins.left;
const innerWidth = doc => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const room = (doc, h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };

// A table with a shaded header row that repeats on every page. `keep` is room the
// last row needs below it (the closing note), so the two always share a page.
function table(doc, columns, rows, keep = 0) {
  const x0 = left(doc), width = innerWidth(doc);
  const widths = columns.map(c => c.w * width);
  const pad = 4;
  const header = () => {
    doc.font('Bold').fontSize(8.5);
    const hgt = Math.max(...columns.map((c, i) => doc.heightOfString(c.label, plain({ width: widths[i] - 2 * pad })))) + 2 * pad;
    room(doc, hgt + 20);
    const y = doc.y;
    doc.rect(x0, y, width, hgt).fill(SHADE).fillColor(INK);
    let x = x0;
    columns.forEach((c, i) => { doc.text(c.label, x + pad, y + pad, plain({ width: widths[i] - 2 * pad, align: c.align || 'left' })); x += widths[i]; });
    doc.y = y + hgt;
  };
  header();
  rows.forEach((row, r) => {
    doc.font('Body').fontSize(9);
    const hgt = Math.max(...columns.map((c, i) => doc.heightOfString(String(row[i] ?? ''), plain({ width: widths[i] - 2 * pad })))) + 2 * pad;
    const need = hgt + (r === rows.length - 1 ? keep : 0);
    if (doc.y + need > doc.page.height - doc.page.margins.bottom) { doc.addPage(); header(); doc.font('Body').fontSize(9); }
    const y = doc.y;
    let x = x0;
    doc.fillColor(INK);
    columns.forEach((c, i) => { doc.text(String(row[i] ?? ''), x + pad, y + pad, plain({ width: widths[i] - 2 * pad, align: c.align || 'left' })); x += widths[i]; });
    doc.moveTo(x0, y + hgt).lineTo(x0 + width, y + hgt).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.y = y + hgt;
  });
  doc.x = x0;
}

const NOTE_GAP = 14; // space above the closing note

// Title, labelled details, summary boxes, then each section as a table (or its
// empty sentence), a note, and "Page n of m" footers. The note never sits alone
// on a last page: the last section's final row (or its sentence, with its
// heading) moves to the next page with it.
function layout(doc, { title, details, summary, sections, note, footer }) {
  const x0 = left(doc), width = innerWidth(doc);
  doc.fillColor(INK).font('Bold').fontSize(18).text(title, x0, doc.y, plain());
  doc.moveDown(0.3);
  doc.fontSize(10);
  for (const [label, value] of details) doc.font('Bold').text(label + ': ', plain({ continued: true })).font('Body').text(value, plain());
  doc.moveDown(0.8);

  const boxW = width / summary.length, boxH = 46, y = doc.y;
  summary.forEach(([label, value], i) => {
    const x = x0 + i * boxW;
    doc.rect(x + 2, y, boxW - 4, boxH).lineWidth(0.75).strokeColor(LINE).stroke();
    doc.fillColor(INK).font('Bold').fontSize(15).text(value, x + 10, y + 8, plain({ width: boxW - 20, lineBreak: false }));
    doc.fillColor(MUTED).font('Body').fontSize(8.5).text(label, x + 10, y + 29, plain({ width: boxW - 20, lineBreak: false }));
  });
  doc.y = y + boxH + 6;

  const noteHeight = note ? NOTE_GAP + doc.font('Body').fontSize(8.5).heightOfString(note, plain({ width })) : 0;
  sections.forEach((s, i) => {
    const keep = i === sections.length - 1 ? noteHeight : 0;
    doc.moveDown(0.9);
    room(doc, 60 + (s.rows.length > 1 ? 0 : keep));
    doc.fillColor(INK).font('Bold').fontSize(12).text(s.heading, x0, doc.y, plain());
    doc.moveDown(0.3);
    if (s.rows.length) table(doc, s.columns, s.rows, keep);
    else doc.fillColor(MUTED).font('Body').fontSize(10).text(s.empty, x0, doc.y, plain({ width }));
  });
  if (note) {
    doc.y += NOTE_GAP;
    doc.fillColor(MUTED).font('Body').fontSize(8.5).text(note, x0, doc.y, plain({ width }));
  }

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not start a new page
    doc.fillColor(MUTED).font('Body').fontSize(8)
      .text(`${footer} · Page ${i + 1} of ${pages.count}`, x0, doc.page.height - 30, plain({ width, align: 'center', lineBreak: false }));
    doc.page.margins.bottom = bottom;
  }
}

const visitRow = (v, withStudent, withLocation) => [
  longDate(v.date),
  ...(withStudent ? [v.student_name] : []),
  ...(withLocation ? [v.location_name] : []),
  v.session_name || 'No session',
  clock(v.check_in_at, v.timezone),
  v.check_out_at == null ? 'Still here' : clock(v.check_out_at, v.timezone),
  v.minutes == null ? '' : duration(v.minutes),
  v.checkout_method ? METHOD[v.checkout_method] : '',
];
const absenceRow = (a, withStudent, withLocation) => [longDate(a.date), ...(withStudent ? [a.student_name] : []),
  ...(withLocation ? [a.location_name] : []), a.session_name, hhmm(a.start_time) + ' – ' + hhmm(a.end_time)];
// The hours box: decimal hours large, hours and minutes in the label.
const hoursBox = t => ['Total hours · ' + duration(t.minutes), decimalHours(t.hours)];
// "Oct 14, 2026, 10:30 PM PDT": a local time always names its zone.
const stamp = (ms, zone) => local(ms, zone).toFormat('LLL d, yyyy, h:mm a ZZZZ');
// Across every location there is no one local time, so each zone's is given with
// the locations in it: "Oct 14, 2026, 10:30 PM PDT (Arcadia, Irvine) · Oct 15, 2026, 1:30 AM EDT (Toronto)".
function stampEach(ms, locations) {
  const names = new Map(); // zone -> its locations, in the order given
  for (const l of locations) names.set(l.timezone, [...(names.get(l.timezone) || []), l.name]);
  return [...names].map(([zone, list]) => `${stamp(ms, zone)} (${list.join(', ')})`).join(' · ');
}

// AT-3: one student's attendance and hours log.
function familyPdf({ student, from, to, label, log, now }) {
  const loc = student.location;
  return render(doc => layout(doc, {
    title: 'Attendance and hours log',
    details: [
      ['Student', student.name],
      ['Location', loc.name + (loc.address ? ' (' + loc.address + ')' : '')],
      ['Dates', label],
      ['Generated', stamp(now, loc.timezone)],
    ],
    summary: [['Visits', String(log.totals.visits)], hoursBox(log.totals), ['Absences', String(log.totals.absences)]],
    sections: [
      { heading: 'Visits', empty: `No visits ${between(from, to)}.`,
        columns: [{ label: 'Date', w: 0.2 }, { label: 'Session', w: 0.22 }, { label: 'In', w: 0.1 }, { label: 'Out', w: 0.1 },
          { label: 'Total', w: 0.1 }, { label: 'Check-out', w: 0.28 }],
        rows: log.visits.map(v => visitRow(v, false, false)) },
      { heading: 'Absences', empty: 'No absences in this range.',
        columns: [{ label: 'Date', w: 0.3 }, { label: 'Session', w: 0.4 }, { label: 'Scheduled', w: 0.3 }],
        rows: log.absences.map(a => absenceRow(a, false)) },
    ],
    note: `Times are local time at ${loc.name} (${loc.timezone}). An absence is a scheduled session with no check-in; ` +
      'closure days and dates outside the term are not counted. "Automatic" means the student did not scan out and was ' +
      'checked out at the end of the session or at closing time.',
    footer: `ELITE Spaces · ${student.name} · ${label}`,
  }));
}

// AT-4: a director/HQ report for a location (or all), a session (or all) and a date range.
// Across all locations, the By student, Visits and Absences tables each have a Location column.
// `locations`: for an all-locations report, every location it covers, by name.
function reportPdf({ filters, label, log, byStudent, now, locations = [] }) {
  const all = !filters.location;
  return render(doc => layout(doc, {
    title: 'Attendance report',
    details: [
      ['Location', all ? 'All locations' : filters.location.name],
      ['Session', filters.session ? filters.session.label : 'All sessions'],
      ['Dates', label],
      ['Generated', all ? stampEach(now, locations) : stamp(now, filters.location.timezone)],
    ],
    summary: [['Visits', String(log.totals.visits)], hoursBox(log.totals), ['Students', String(log.totals.students)],
      ['Absences', String(log.totals.absences)], ['Needs review', String(log.totals.needs_review)]],
    sections: [
      { heading: 'By student', empty: 'No students in this report.',
        columns: [{ label: 'Student', w: all ? 0.26 : 0.46 }, ...(all ? [{ label: 'Location', w: 0.2 }] : []),
          { label: 'Visits', w: 0.18, align: 'right' }, { label: 'Hours', w: 0.18, align: 'right' }, { label: 'Absences', w: 0.18, align: 'right' }],
        rows: byStudent.map(s => [s.student_name, ...(all ? [s.location_name] : []), s.visits, decimalHours(s.hours), s.absences]) },
      { heading: 'Visits', empty: `No visits ${between(filters.from, filters.to)}.`,
        columns: [{ label: 'Date', w: 0.15 }, { label: 'Student', w: 0.15 }, ...(all ? [{ label: 'Location', w: 0.1 }] : []),
          { label: 'Session', w: all ? 0.14 : 0.17 }, { label: 'In', w: 0.09 }, { label: 'Out', w: 0.09 }, { label: 'Total', w: 0.08 },
          { label: 'Check-out', w: all ? 0.2 : 0.27 }],
        rows: log.visits.map(v => {
          const row = visitRow(v, true, all);
          if (v.checked_out_by_name) row[row.length - 1] += ' (' + v.checked_out_by_name + ')';
          if (v.needs_review) row[row.length - 1] += ' · needs review';
          return row;
        }) },
      { heading: 'Absences', empty: 'No absences in this range.',
        columns: [{ label: 'Date', w: all ? 0.2 : 0.25 }, { label: 'Student', w: all ? 0.2 : 0.25 }, ...(all ? [{ label: 'Location', w: 0.2 }] : []),
          { label: 'Session', w: all ? 0.2 : 0.25 }, { label: 'Scheduled', w: all ? 0.2 : 0.25 }],
        rows: log.absences.map(a => absenceRow(a, true, all)) },
    ],
    note: (all ? 'Times are local time at each location. ' : `Times are local time at ${filters.location.name} (${filters.location.timezone}). `) +
      'An absence is a scheduled session with no check-in; closure days and dates outside the term are not counted.',
    footer: `ELITE Spaces · Attendance report · ${label}`,
  }), { layout: 'landscape' });
}

module.exports = { csv, familyPdf, reportPdf, slug };
