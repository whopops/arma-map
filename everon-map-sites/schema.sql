-- The database tables. src/worker.js creates them itself on first use, so running this is optional.

CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, created INTEGER NOT NULL, briefing TEXT);
CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, token TEXT NOT NULL, room TEXT NOT NULL, ip TEXT NOT NULL,
  addr_key TEXT NOT NULL, name TEXT NOT NULL, lname TEXT NOT NULL, color TEXT NOT NULL, joined INTEGER NOT NULL,
  last_seen INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS players_room_name ON players (room, lname);
CREATE INDEX IF NOT EXISTS players_last_seen ON players (last_seen);
CREATE INDEX IF NOT EXISTS players_addr_key ON players (addr_key);
CREATE TABLE IF NOT EXISTS items (player_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL,
  PRIMARY KEY (player_id, id));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_room_seq ON events (room, seq);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS removed (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bans (ip TEXT PRIMARY KEY, until INTEGER, names TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, until INTEGER NOT NULL, seen INTEGER NOT NULL,
  addr_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_failures (addr_key TEXT PRIMARY KEY, count INTEGER NOT NULL, first INTEGER NOT NULL,
  locked_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_recent (at INTEGER NOT NULL);
