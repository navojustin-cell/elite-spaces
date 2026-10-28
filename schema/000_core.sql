-- Core tables shared by every module. These are the cross-module contract:
-- modules read and write them directly. A module that needs more fields or
-- private tables adds new tables in its own schema/<NNN>_<module>.sql file.
-- Schema files hold new tables and indexes only, never ALTER TABLE (D-55):
-- src/db.js re-runs every schema file on each open. CREATE TABLE IF NOT EXISTS
-- never changes an existing database, so these columns stay as they are; v1.1
-- gives some of them a new meaning, noted beside them.
-- Times are UTC epoch milliseconds (INTEGER). Dates that belong to a location
-- (local_date, closures, terms) are 'YYYY-MM-DD' in that location's time zone.
-- Weekdays are ISO: 1 = Monday ... 7 = Sunday.

CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL,                 -- IANA, e.g. America/Los_Angeles
  address       TEXT,
  -- lat, lng, geofence_m: unused since v1.1 (S-5, D-49). Kept so existing databases
  -- still open. New locations store 0, 0 and 150.
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  geofence_m    INTEGER NOT NULL DEFAULT 150,
  qr_rotate_at  TEXT NOT NULL DEFAULT '04:00', -- CI-1 local rotation time
  open_time     TEXT NOT NULL DEFAULT '09:00',
  close_time    TEXT NOT NULL DEFAULT '20:00', -- CI-5 closing time
  qr_secret     TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('student','parent','staff','director','hq')),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  phone         TEXT,
  password_hash TEXT,                          -- NULL until an invited user activates
  location_id   INTEGER REFERENCES locations(id), -- home location; NULL for hq
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- A student may have several parents; a parent several students.
-- A student cannot use the app until at least one link is 'active'.
CREATE TABLE IF NOT EXISTS family_links (
  parent_id     INTEGER NOT NULL REFERENCES users(id),
  student_id    INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  PRIMARY KEY (parent_id, student_id)
);

CREATE TABLE IF NOT EXISTS memberships (
  id            INTEGER PRIMARY KEY,
  student_id    INTEGER NOT NULL UNIQUE REFERENCES users(id),
  status        TEXT NOT NULL CHECK (status IN ('active','inactive')),
  weekly_cap    INTEGER NOT NULL,
  start_date    TEXT NOT NULL,
  expires_on    TEXT NOT NULL,                 -- last valid day, inclusive
  updated_by    INTEGER REFERENCES users(id),
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terms (
  id            INTEGER PRIMARY KEY,
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  name          TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closures (
  id            INTEGER PRIMARY KEY,
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  date          TEXT NOT NULL,
  reason        TEXT,
  created_by    INTEGER REFERENCES users(id),
  UNIQUE (location_id, date)
);

-- A session is a recurring study block, e.g. Mon/Wed/Fri 13:00-16:00.
-- A session is a schedule (D-41): fixed weekdays and times for the whole of its
-- term (its period, a month or a semester). capacity is seats per meeting date.
-- Single-date changes are in session_dates (030_sessions.sql).
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  term_id       INTEGER NOT NULL REFERENCES terms(id),
  name          TEXT NOT NULL,
  weekdays      TEXT NOT NULL,                 -- comma list of ISO weekdays, e.g. '1,3,5'
  start_time    TEXT NOT NULL,                 -- 'HH:MM' local
  end_time      TEXT NOT NULL,
  capacity      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL
);

-- Enrollment in one schedule for the rest of its period (EN-1).
-- source keeps 'request' so v1 rows stay valid; v1.1 writes only 'parent',
-- 'waitlist' and 'staff' (the v1.1 migration uses 'staff').
CREATE TABLE IF NOT EXISTS enrollments (
  id            INTEGER PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES users(id),
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  weekday       INTEGER NOT NULL,              -- 0 = the whole schedule (v1.1, D-42). 1-7 = a v1 per-weekday row, which counts only on that weekday. Nothing writes 1-7 after v1.1.
  status        TEXT NOT NULL CHECK (status IN ('active','paused','dropped')),
  source        TEXT NOT NULL CHECK (source IN ('parent','request','waitlist','staff')),
  created_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_live
  ON enrollments(student_id, session_id, weekday) WHERE status IN ('active','paused');

-- Per-schedule waitlist (EN-5, D-44). Shared because membership renewal (D-16) can put a
-- student back at the front. Order: priority DESC, created_at ASC, id ASC.
CREATE TABLE IF NOT EXISTS waitlist (
  id            INTEGER PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES users(id),
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  weekday       INTEGER NOT NULL,              -- 0 = the whole schedule (v1.1, D-42). 1-7 = a v1 per-weekday row.
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','enrolled','removed')),
  priority      INTEGER NOT NULL DEFAULT 0,    -- 1 = front of the line (renewed membership)
  created_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_one_waiting
  ON waitlist(student_id, session_id, weekday) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS visits (
  id              INTEGER PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES users(id),
  location_id     INTEGER NOT NULL REFERENCES locations(id),
  session_id      INTEGER REFERENCES sessions(id),
  weekday         INTEGER,                     -- the ISO weekday of local_date. Informational only.
  local_date      TEXT NOT NULL,
  check_in_at     INTEGER NOT NULL,
  check_out_at    INTEGER,
  checkin_method  TEXT NOT NULL CHECK (checkin_method IN ('scan','staff')),
  checkout_method TEXT CHECK (checkout_method IN ('scan','auto','staff')),
  flagged         INTEGER NOT NULL DEFAULT 0,
  flag_reason     TEXT,
  reviewed_by     INTEGER REFERENCES users(id),
  checked_in_by   INTEGER REFERENCES users(id),
  checked_out_by  INTEGER REFERENCES users(id)
);

-- In-app inbox. Every notification the app "sends" lands here; push delivery
-- is simulated in v1 (see docs/decisions.md).
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  ref_type      TEXT,
  ref_id        INTEGER,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','emergency')),
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  read_at       INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);

-- Every staff edit is logged (privacy and safety requirement).
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  actor_id      INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     INTEGER,
  location_id   INTEGER,
  detail        TEXT,                          -- JSON
  at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
