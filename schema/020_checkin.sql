-- Module: checkin (PRD 1, CI-1..CI-7). Additive only.
-- The visits table itself is core (000_core.sql); these indexes keep the
-- scan, the "in the building" list and the auto-checkout job fast (NF-6).
-- The app never reads the phone's location (NF-5, D-49), so there is no
-- coordinate column on purpose.

CREATE INDEX IF NOT EXISTS checkin_visits_student_day ON visits(student_id, local_date);
CREATE INDEX IF NOT EXISTS checkin_visits_location_day ON visits(location_id, local_date);
CREATE INDEX IF NOT EXISTS checkin_visits_open ON visits(check_out_at) WHERE check_out_at IS NULL;
CREATE INDEX IF NOT EXISTS checkin_enrollments_student ON enrollments(student_id, status);
-- "In the building" reads who checked a visit in or out by hand, and why, from
-- that visit's audit entries (CI-7, NF-2).
CREATE INDEX IF NOT EXISTS checkin_audit_target ON audit_log(target_type, target_id);
