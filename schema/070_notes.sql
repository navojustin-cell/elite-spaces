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
