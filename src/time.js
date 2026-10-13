'use strict';
// Location-local time helpers. Every location runs on its own time zone for
// sessions, closing times and QR rotation, so nothing here uses the server's zone.

const { DateTime } = require('luxon');

const local = (loc, ms) => DateTime.fromMillis(ms, { zone: loc.timezone });

// 'YYYY-MM-DD' in the location's zone.
const localDate = (loc, ms) => local(loc, ms).toISODate();

// ISO weekday in the location's zone, 1 = Monday.
const weekday = (loc, ms) => local(loc, ms).weekday;

// 'HH:MM' in the location's zone.
const localTime = (loc, ms) => local(loc, ms).toFormat('HH:mm');

// UTC ms for a local date + 'HH:MM' at the location.
function toMs(loc, isoDate, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromISO(isoDate, { zone: loc.timezone }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
}

// Weekday (1-7) of a 'YYYY-MM-DD' date.
const weekdayOfDate = isoDate => DateTime.fromISO(isoDate).weekday;

// 'YYYY-MM-DD' shifted by n days.
const addDays = (isoDate, n) => DateTime.fromISO(isoDate).plus({ days: n }).toISODate();

// Inclusive list of dates between two 'YYYY-MM-DD' strings.
function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Monday of the week containing isoDate.
const weekStart = isoDate => DateTime.fromISO(isoDate).startOf('week').toISODate();

// Great-circle distance in metres.
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { local, localDate, weekday, localTime, toMs, weekdayOfDate, addDays, datesBetween, weekStart, distanceM };
