-- Membership module (MB-4, MB-5, D-16). Additive only: the membership record
-- itself is the core 'memberships' table.
--
-- One row per notice already sent for a given expiry date, so the scheduled
-- jobs never send the same reminder twice. Keyed by expires_on: a renewal
-- (new end date) starts a fresh set of reminders.
CREATE TABLE IF NOT EXISTS membership_notices (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES users(id),
  expires_on  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('remind14', 'remind3', 'expired')),
  sent_at     INTEGER NOT NULL,
  UNIQUE (student_id, expires_on, kind)
);

-- D-32: a membership saved with a start date still ahead. Its sessions stay
-- paused until that date; the daily job then brings them back (D-16a) and
-- removes the row, so it runs once. Any later save that makes the membership
-- valid or ends it removes the row too.
CREATE TABLE IF NOT EXISTS membership_starts (
  student_id  INTEGER PRIMARY KEY REFERENCES users(id),
  start_date  TEXT NOT NULL,
  set_at      INTEGER NOT NULL
);
