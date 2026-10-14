-- Module: announcements (PRD 5, AN-1..AN-6). Additive only: private tables.
-- Times are UTC epoch ms, like the core schema.

-- One row per announcement or emergency alert.
-- type 'announcement' has a category and an audience (AN-1, AN-4);
-- type 'emergency' has no category and always goes to 'everyone' (AN-5).
-- status: 'scheduled' until the publish job (or an immediate post) sends it,
-- then 'published' exactly once; a scheduled post can be 'cancelled' instead.
CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('announcement','emergency')),
  category      TEXT CHECK (category IN ('event','workshop','holiday','session_offering','news')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('families','parents','students','session','everyone')),
  session_id    INTEGER REFERENCES sessions(id),
  status        TEXT NOT NULL CHECK (status IN ('scheduled','published','cancelled')),
  publish_at    INTEGER NOT NULL,
  published_at  INTEGER,
  cancelled_at  INTEGER,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS announcements_due ON announcements(status, publish_at);

-- The location(s) a post was sent to: one for a director, any set for HQ (AN-2).
CREATE TABLE IF NOT EXISTS announcement_locations (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  location_id     INTEGER NOT NULL REFERENCES locations(id),
  PRIMARY KEY (announcement_id, location_id)
);
CREATE INDEX IF NOT EXISTS announcement_locations_loc ON announcement_locations(location_id);

-- Who the post was for, fixed when it is published: the sender's "Sent to"
-- number and the people its delivery and read counts are taken over (AN-6).
-- Muted users are recipients too: they see the post in the feed but get no
-- notification. A family member's News feed shows these posts, plus any later
-- all-families, parents-only or students-only post (or alert) at their own
-- location that includes their role, so a family that joins later still sees it.
CREATE TABLE IF NOT EXISTS announcement_recipients (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS announcement_recipients_user ON announcement_recipients(user_id);

-- Who has seen a post in News (or tapped "I have read this" on an alert), one
-- row per person per post. Muted recipients have no notification row to mark,
-- so this is what counts their reads (AN-6).
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  read_at         INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

-- Per-user setting: muted = 1 turns off notifications for normal
-- announcements. Emergency alerts ignore it (AN-5).
CREATE TABLE IF NOT EXISTS announcement_prefs (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  muted         INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
