-- Core tables shared by every module. These are the cross-module contract:
-- modules read and write them directly. A module that needs more columns or
-- private tables adds them in its own schema/<NNN>_<module>.sql file.
-- Times are UTC epoch milliseconds (INTEGER). Dates that belong to a location
-- (local_date, closures, terms) are 'YYYY-MM-DD' in that location's time zone.
-- Weekdays are ISO: 1 = Monday ... 7 = Sunday.

CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL,                 -- IANA, e.g. America/Los_Angeles
  address       TEXT,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  geofence_m    INTEGER NOT NULL DEFAULT 150,  -- CI-2 radius
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
-- Each (session, weekday) pair is one weekly slot; capacity applies per slot.
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

-- Recurring enrollment in one weekly slot for the rest of the term (EN-1).
CREATE TABLE IF NOT EXISTS enrollments (
  id            INTEGER PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES users(id),
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  weekday       INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','paused','dropped')),
  source        TEXT NOT NULL CHECK (source IN ('parent','request','waitlist','staff')),
  created_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_live
  ON enrollments(student_id, session_id, weekday) WHERE status IN ('active','paused');

CREATE TABLE IF NOT EXISTS visits (
  id              INTEGER PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES users(id),
  location_id     INTEGER NOT NULL REFERENCES locations(id),
  session_id      INTEGER REFERENCES sessions(id),
  weekday         INTEGER,
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
