'use strict';
// Injectable clock. Production reads the real time; tests and the dev panel set
// a fixed instant so time-of-day rules (QR rotation, auto-checkout, expiry) can
// be exercised deterministically.

function createClock(fixed) {
  let override = fixed == null ? null : Number(fixed);
  return {
    now: () => (override == null ? Date.now() : override),
    set: ms => { override = ms == null ? null : Number(ms); },
    advance: ms => { override = (override == null ? Date.now() : override) + ms; },
    isFixed: () => override != null,
  };
}

module.exports = { createClock };
