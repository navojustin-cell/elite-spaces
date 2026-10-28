-- Module: sessions (PRD 2, SC-1..SC-4). Additive only.
-- Terms, closures, sessions, enrollments and the waitlist are core tables
-- (000_core.sql). These indexes keep a location's weekly schedule and term
-- lookups fast. Per-slot enrollment and waitlist counts use the indexes in
-- 040_enrollment.sql (session_id, weekday, status).

CREATE INDEX IF NOT EXISTS sessions_by_location ON sessions(location_id, status);
CREATE INDEX IF NOT EXISTS sessions_terms_by_location ON terms(location_id, start_date);

-- R8: editing a session's times applies from the edit date (location-local)
-- forward; past occurrences keep the times they had. Each row holds the times a
-- session had up to and including `until_date`, back to the previous row's
-- until_date (or to the start, for the earliest row). Dates after the latest
-- row use the sessions row. A session never edited has no rows. Attendance and
-- absences read it through src/modules/sessions/times.js.
CREATE TABLE IF NOT EXISTS session_times (
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  until_date  TEXT NOT NULL,                 -- 'YYYY-MM-DD', last local date with these times
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  changed_at  INTEGER NOT NULL,              -- when the edit that ended these times was made
  PRIMARY KEY (session_id, until_date)
);

-- v1.1 (D-46): one schedule's own date changes. 'skip' cancels one meeting date of
-- this schedule only. 'add' makes an extra meeting date, at the times the schedule
-- has that day (D-34). A move is a skip and an add written together; the add
-- carries moved_from. Closures stay location-wide (closures table).
-- Only today or later can be changed, so past dates never change.
CREATE TABLE IF NOT EXISTS session_dates (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  date        TEXT NOT NULL,                 -- 'YYYY-MM-DD', location-local
  kind        TEXT NOT NULL CHECK (kind IN ('skip','add')),
  moved_from  TEXT,                          -- on an 'add' made by a move: the date it replaces
  reason      TEXT,                          -- shown to families, up to 120 chars
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, date)
);
CREATE INDEX IF NOT EXISTS session_dates_by_date ON session_dates(date);
