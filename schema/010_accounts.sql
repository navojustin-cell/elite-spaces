-- Module: accounts (AC-1..AC-6, D-20, D-21). Additive only: private tables.

-- One-time invites for a family (D-20). A student invite points at the pending
-- student it created; a guardian invite gets its user_id when it is accepted.
-- Only a SHA-256 hash of the code is stored, never the code itself.
CREATE TABLE IF NOT EXISTS account_invites (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('student','guardian')),
  invited_by    INTEGER NOT NULL REFERENCES users(id),
  user_id       INTEGER REFERENCES users(id),
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  code_hash     TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS account_invites_user ON account_invites(kind, user_id);
CREATE INDEX IF NOT EXISTS account_invites_by ON account_invites(invited_by);

-- Staff and directors whose password was set for them (D-21) and is still the
-- temporary one. The row goes away when they choose their own.
CREATE TABLE IF NOT EXISTS account_temp_passwords (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  set_by        INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL
);
