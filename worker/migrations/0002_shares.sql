-- Migration: 0002_shares.sql
-- File sharing via unique links

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
