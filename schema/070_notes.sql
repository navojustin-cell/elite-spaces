-- Daily notes (PRD 6, DN-1..DN-5). Additive only: private tables for the notes module.

-- The rating checklist, the same at every location (DN-2). HQ can rename, add,
-- reorder and retire items; retired items stay (active = 0) so old notes and the
-- audit log still make sense.
CREATE TABLE IF NOT EXISTS note_items (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  position    INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  INTEGER
);
-- The four PRD items (D-8). OR IGNORE keeps HQ's edits, because every schema
-- file re-applies each time the database opens.
INSERT OR IGNORE INTO note_items (id, label, position) VALUES
  (1, 'On time', 1),
  (2, 'Focused', 2),
  (3, 'Respectful of others / not distracting', 3),
  (4, 'Productive use of time', 4);

-- One note per student per location-local date (DN-1). A 'draft' is staff-only;
-- a 'posted' note is what parents see (DN-5).
CREATE TABLE IF NOT EXISTS daily_notes (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES users(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  local_date  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  comment     TEXT,                                -- optional (DN-3)
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  posted_by   INTEGER REFERENCES users(id),
  posted_at   INTEGER,
  edited_by   INTEGER REFERENCES users(id),
  edited_at   INTEGER,                             -- last change after posting ("Edited" marker)
  UNIQUE (student_id, local_date)
);
CREATE INDEX IF NOT EXISTS daily_notes_location_date ON daily_notes(location_id, local_date);

-- One rating per checklist item. The label is copied in so a posted note keeps
-- the wording it was written with, whatever HQ changes later (DN-2).
CREATE TABLE IF NOT EXISTS daily_note_ratings (
  note_id     INTEGER NOT NULL REFERENCES daily_notes(id),
  item_id     INTEGER NOT NULL REFERENCES note_items(id),
  label       TEXT NOT NULL,
  position    INTEGER NOT NULL,
  rating      INTEGER CHECK (rating IN (1, 2, 3)), -- 1 Needs work, 2 Good, 3 Great (D-8); NULL = not rated yet (DN-4)
  PRIMARY KEY (note_id, item_id)
);

-- S-8 / D-57: a student's top 3 goals for one week, Monday to Sunday by their home
-- location's date (NF-4). No row = not set yet. Only the student writes them, after a
-- check-in that day. Subjects and example goals are fixed in code (src/modules/notes/goals.js).
-- These replace v1.1's daily_goal_days/daily_goals (D-50): databases from before are demo
-- data and are reseeded (docs/deploy.md). Nothing here is ever deleted or overwritten:
-- the full dated history is kept for a later counselor summary (docs/open-items.md).
CREATE TABLE IF NOT EXISTS goal_weeks (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES users(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  week_start  TEXT NOT NULL,                       -- the Monday, location-local
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (student_id, week_start)
);
-- One goal. A week always has exactly 3 open goals, one per position, each a different
-- subject. Done or Change closes a goal (done_on / replaced_on, location-local dates) and
-- its replacement takes the same position; replaced_by points at that replacement.
CREATE TABLE IF NOT EXISTS week_goals (
  id          INTEGER PRIMARY KEY,
  week_id     INTEGER NOT NULL REFERENCES goal_weeks(id),
  position    INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  subject     TEXT NOT NULL CHECK (subject IN ('math','english','science','history','language','art','test_prep','other')),
  text        TEXT NOT NULL,                       -- 6+ words, up to 3 sentences and 500 characters
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','replaced')),
  created_on  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  done_on     TEXT,
  replaced_on TEXT,
  replaced_by INTEGER REFERENCES week_goals(id)
);
CREATE INDEX IF NOT EXISTS week_goals_week ON week_goals(week_id, position);
-- "Still working on this?": one answer per goal per location-local day. Answering again
-- that day replaces the answer.
CREATE TABLE IF NOT EXISTS goal_checks (
  goal_id     INTEGER NOT NULL REFERENCES week_goals(id),
  date        TEXT NOT NULL,
  answer      TEXT NOT NULL CHECK (answer IN ('yes','done','change')),
  answered_at INTEGER NOT NULL,
  UNIQUE (goal_id, date)
);
