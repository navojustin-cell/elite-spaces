-- Module: enrollment (PRD 3, EN-1..EN-7, NF-3, D-17, D-18). Additive only.
-- Enrollments and the per-slot waitlist are core tables (000_core.sql).

-- Student requests (EN-3, D-17). Every active linked parent is notified and the
-- first parent to decide settles it. An approval then runs the same membership
-- and seat checks as a direct enrollment; `outcome` records what happened.
CREATE TABLE IF NOT EXISTS enrollment_requests (
  id              INTEGER PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES users(id),
  session_id      INTEGER NOT NULL REFERENCES sessions(id),
  weekday         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  outcome         TEXT CHECK (outcome IN ('enrolled','blocked','full')),
  outcome_message TEXT,
  decided_by      INTEGER REFERENCES users(id),
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS enrollment_requests_one_pending
  ON enrollment_requests(student_id, session_id, weekday) WHERE status = 'pending';

-- Seat counts and the waitlist line are read on every enroll, drop and job run.
CREATE INDEX IF NOT EXISTS enrollment_seats ON enrollments(session_id, weekday, status);
CREATE INDEX IF NOT EXISTS enrollment_waitlist_line ON waitlist(session_id, weekday, status);

-- Every change to an enrollment's status, with when it happened (EN-7, D-15,
-- D-16, D-26). Pauses begin and end in the membership module, drops in the
-- enrollment and sessions modules, so this log is how the schedule and the
-- attendance report tell a week the student missed (absent) from a week the
-- spot was on hold (paused). The trigger below writes every row, whichever
-- module made the change, stamped with the app clock (app_now(), registered on
-- every connection by src/db.js). It is TEMP because the clock function exists
-- only on the app's own connections; every schema file re-runs on each open.
CREATE TABLE IF NOT EXISTS enrollment_status_log (
  id            INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS enrollment_status_log_by_enrollment ON enrollment_status_log(enrollment_id, at);

CREATE TEMP TRIGGER IF NOT EXISTS enrollment_status_logger AFTER UPDATE OF status ON enrollments
  WHEN OLD.status <> NEW.status BEGIN
    INSERT INTO enrollment_status_log (enrollment_id, from_status, to_status, at) VALUES (NEW.id, OLD.status, NEW.status, app_now());
  END;
