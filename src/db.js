'use strict';
// SQLite via Node's built-in driver. Synchronous by design: a request handler
// that does its check and its write without an `await` in between cannot be
// interleaved with another request, and tx() makes multi-statement writes atomic.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_DIR = path.join(__dirname, '..', 'schema');

// `now` is the app clock. SQL reads it as app_now(), so a schema trigger can
// stamp a change with the same instant the app uses (tests and the dev bar move it).
function open(file, now = Date.now) {
  const db = new DatabaseSync(file || ':memory:');
  db.function('app_now', () => now());
  db.exec('PRAGMA foreign_keys = ON');
  if (file && file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  // Schema files apply in name order: 000_core.sql first, then one per module.
  for (const f of fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));
  }
  return db;
}

// Run fn inside one IMMEDIATE transaction. Nested calls join the outer one.
function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, tx };
