-- Module: sessions (PRD 2, SC-1..SC-4). Additive only.
-- Terms, closures, sessions, enrollments and the waitlist are core tables
-- (000_core.sql). These indexes keep a location's weekly schedule and term
-- lookups fast. Per-slot enrollment and waitlist counts use the indexes in
-- 040_enrollment.sql (session_id, weekday, status).

CREATE INDEX IF NOT EXISTS sessions_by_location ON sessions(location_id, status);
CREATE INDEX IF NOT EXISTS sessions_terms_by_location ON terms(location_id, start_date);
