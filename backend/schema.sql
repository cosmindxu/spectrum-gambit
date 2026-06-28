-- Spectral Gambit — D1 schema (also used verbatim by the local dev shim).

-- Correspondence (async human-vs-human) games. The full machine state
-- lives in `szx` (base64); turns are enforced by per-side tokens.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'h2h',
  status      TEXT NOT NULL DEFAULT 'waiting',   -- waiting | active | over
  turn        TEXT NOT NULL DEFAULT 'white',     -- white | black
  white_name  TEXT,
  black_name  TEXT,
  white_token TEXT,
  black_token TEXT,
  szx         TEXT,                              -- base64 .szx snapshot
  movelog     TEXT NOT NULL DEFAULT '[]',        -- JSON array of {san,side,...}
  result      TEXT,                              -- e.g. '1-0','0-1','1/2'
  created_at  INTEGER,
  updated_at  INTEGER
);

-- Engine-ladder results: one row per finished game vs the AI.
CREATE TABLE IF NOT EXISTS ladder (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  level      INTEGER NOT NULL,                   -- engine strength 1..5
  result     TEXT NOT NULL,                      -- win | loss | draw
  moves      INTEGER,
  assisted   INTEGER NOT NULL DEFAULT 0,         -- 1 = the AI companion played a move
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ladder_name  ON ladder(name);
CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at);

-- ===== AI Companion (MCP) =====
-- A companion session links the page (by opaque id) to the player's Claude
-- (paired by a short code). Chess positions are low-sensitivity; the pairing
-- code is the access gate.
CREATE TABLE IF NOT EXISTS companion_sessions (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  mcp_bound   INTEGER NOT NULL DEFAULT 0,   -- 1 once a Claude has paired
  created_at  INTEGER,
  last_seen   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companion_code ON companion_sessions(code);

-- latest position pushed by the page (one row per session)
CREATE TABLE IF NOT EXISTS companion_state (
  session_id  TEXT PRIMARY KEY,
  fen TEXT, pgn TEXT, side TEXT, eval INTEGER, level INTEGER,
  legal_moves TEXT,                         -- JSON array of SAN
  updated_at  INTEGER
);

-- latest suggestions written by Claude via the MCP server (one row per session)
CREATE TABLE IF NOT EXISTS companion_suggestions (
  session_id TEXT PRIMARY KEY,
  candidates TEXT,                          -- JSON [{san, rationale}]
  comment    TEXT,
  created_at INTEGER
);

-- play commands queued by Claude for the page to execute
CREATE TABLE IF NOT EXISTS companion_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,                 -- 'play'
  san        TEXT,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | done | dismissed
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companion_cmd ON companion_commands(session_id, status);

-- binds an MCP connection (Mcp-Session-Id) to a game session after pair(code)
CREATE TABLE IF NOT EXISTS companion_bindings (
  mcp_session TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  created_at  INTEGER
);
