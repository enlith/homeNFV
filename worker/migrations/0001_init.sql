-- Migration: 0001_init.sql
-- Initial schema for HomeNFV

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER DEFAULT 0,
  modified INTEGER,
  cached_in_r2 INTEGER DEFAULT 0,
  pending_sync INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_files_parent ON files(parent);
