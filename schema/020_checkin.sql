-- Module: checkin (PRD 1, CI-1..CI-7). Additive only.
-- The visits table itself is core (000_core.sql); these indexes keep the
-- scan, the "in the building" list and the auto-checkout job fast (NF-6).
-- Scan coordinates are never stored anywhere (NF-5, D-23), so there is no
-- column for them on purpose.

CREATE INDEX IF NOT EXISTS checkin_visits_student_day ON visits(student_id, local_date);
CREATE INDEX IF NOT EXISTS checkin_visits_location_day ON visits(location_id, local_date);
CREATE INDEX IF NOT EXISTS checkin_visits_open ON visits(check_out_at) WHERE check_out_at IS NULL;
CREATE INDEX IF NOT EXISTS checkin_enrollments_student ON enrollments(student_id, status);
