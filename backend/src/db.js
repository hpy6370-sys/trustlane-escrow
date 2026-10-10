const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/**
 * Schema. Amounts are stored as TEXT (base-unit integers) because wei values do
 * not fit in SQLite's 64-bit INTEGER / REAL without losing precision.
 * Addresses are always stored lower-case.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  address       TEXT PRIMARY KEY,
  display_name  TEXT,
  email         TEXT,
  bio           TEXT,
  skills        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mirrors on-chain RoleGranted / RoleRevoked (fallback when RPC is unavailable)
CREATE TABLE IF NOT EXISTS user_roles (
  address    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','client','freelancer','arbiter')),
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (address, role)
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  address    TEXT PRIMARY KEY,
  message    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Off-chain documents whose keccak256 is anchored on-chain (terms, deliverables, evidence, rulings)
CREATE TABLE IF NOT EXISTS documents (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('terms','deliverable','evidence','dispute','ruling')),
  author     TEXT NOT NULL,
  title      TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escrows (
  id               INTEGER PRIMARY KEY,
  client           TEXT NOT NULL,
  freelancer       TEXT NOT NULL,
  token            TEXT NOT NULL,
  total            TEXT NOT NULL,
  released         TEXT NOT NULL DEFAULT '0',
  fees             TEXT NOT NULL DEFAULT '0',
  milestone_count  INTEGER NOT NULL,
  deadline         INTEGER NOT NULL,
  terms_hash       TEXT NOT NULL,
  status           TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  created_tx       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escrows_client ON escrows(client);
CREATE INDEX IF NOT EXISTS idx_escrows_freelancer ON escrows(freelancer);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);

CREATE TABLE IF NOT EXISTS milestones (
  escrow_id        INTEGER NOT NULL REFERENCES escrows(id),
  idx              INTEGER NOT NULL,
  amount           TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'Pending',
  deliverable_hash TEXT,
  updated_at       INTEGER,
  PRIMARY KEY (escrow_id, idx)
);

CREATE TABLE IF NOT EXISTS disputes (
  id               INTEGER PRIMARY KEY,
  escrow_id        INTEGER NOT NULL REFERENCES escrows(id),
  opened_by        TEXT NOT NULL,
  reason_hash      TEXT NOT NULL,
  arbiter          TEXT,
  status           TEXT NOT NULL,
  client_share_bps INTEGER,
  to_client        TEXT,
  to_freelancer    TEXT,
  ruling_hash      TEXT,
  evidence_count   INTEGER NOT NULL DEFAULT 0,
  opened_at        INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_disputes_arbiter ON disputes(arbiter);

CREATE TABLE IF NOT EXISTS evidence (
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  submitter  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  tx_hash    TEXT NOT NULL
);

-- Append-only log of every decoded contract event (the "event log" in the UI)
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number INTEGER NOT NULL,
  block_time   INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  contract     TEXT NOT NULL,
  name         TEXT NOT NULL,
  args         TEXT NOT NULL,
  escrow_id    INTEGER,
  actors       TEXT NOT NULL DEFAULT ',',
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_events_escrow ON events(escrow_id);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
