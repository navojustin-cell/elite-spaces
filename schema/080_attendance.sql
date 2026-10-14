-- Module: attendance (PRD 7, AT-1..AT-4). Additive only.
-- Attendance stores nothing of its own: it reads the core visits, enrollments,
-- terms and closures tables, and totals and absences (D-15) are computed on
-- every read. These indexes keep the director and HQ reports fast.

CREATE INDEX IF NOT EXISTS attendance_visits_day ON visits(local_date, location_id);
CREATE INDEX IF NOT EXISTS attendance_visits_session_day ON visits(session_id, local_date);
CREATE INDEX IF NOT EXISTS attendance_enrollments_session ON enrollments(session_id, weekday);
