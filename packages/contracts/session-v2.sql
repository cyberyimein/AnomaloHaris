PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 2,
    title TEXT NOT NULL DEFAULT 'Untitled conversation',
    search_mode TEXT NOT NULL DEFAULT 'diy',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    active_leaf_entry_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_entries (
    entry_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    parent_entry_id TEXT REFERENCES session_entries(entry_id) ON DELETE SET NULL,
    run_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'compaction', 'system', 'event')),
    role TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_resources (
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    PRIMARY KEY(session_id, resource_type, resource_name)
);

CREATE TABLE IF NOT EXISTS web_traces (
    trace_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    run_id TEXT,
    tool_call_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished', 'error', 'stopped')),
    start_entry_id TEXT,
    last_entry_id TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    error_code TEXT
);

CREATE TABLE IF NOT EXISTS run_checkpoints (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_entries_session_created
    ON session_entries(session_id, created_at, entry_id);
CREATE INDEX IF NOT EXISTS idx_session_entries_parent
    ON session_entries(parent_entry_id);
CREATE INDEX IF NOT EXISTS idx_session_runs_session_started
    ON runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status
    ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_checkpoints_session
    ON run_checkpoints(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_traces_session_created
    ON web_traces(session_id, created_at DESC);
