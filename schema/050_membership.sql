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
