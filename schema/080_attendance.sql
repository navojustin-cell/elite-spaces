-- Module: attendance (PRD 7, AT-1..AT-5). Additive only: new tables and indexes (D-55).
-- Totals and absences (D-15) are computed on every read from the core visits,
-- enrollments, terms and closures tables and the schedules' date changes
-- (sessions/dates.js). These indexes keep the director and HQ reports fast.

CREATE INDEX IF NOT EXISTS attendance_visits_day ON visits(local_date, location_id);
CREATE INDEX IF NOT EXISTS attendance_visits_session_day ON visits(session_id, local_date);
CREATE INDEX IF NOT EXISTS attendance_enrollments_session ON enrollments(session_id, weekday);

-- S-12 / D-53: one missed-day notice per student per location-local date, so the
-- job never sends twice. `sessions` lists what was missed, for the notice and Hours.
CREATE TABLE IF NOT EXISTS missed_day_notices (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES users(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  local_date  TEXT NOT NULL,
  sessions    TEXT NOT NULL,                   -- JSON [{session_id, name, start_time, end_time}]
  sent_at     INTEGER NOT NULL,
  notified    INTEGER NOT NULL DEFAULT 1 CHECK (notified IN (0,1)), -- 0 = seed placeholder: blocks the job, nobody was told
  UNIQUE (student_id, local_date)
);
