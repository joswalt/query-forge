-- DML Statement runs record Query History Entries (ticket 23). SQLite can't
-- alter a CHECK constraint, so the table is rebuilt to add status `partial`
-- and the DML columns. `entry_kind` defaults to `query`, so existing rows
-- come across as query entries with every DML column NULL. Copying in
-- `rowid` order keeps the `list` tie-break for same-millisecond rows.
-- Never stored: document ids, per-document messages, bodies.
CREATE TABLE query_history_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  profile_name TEXT NOT NULL,
  query_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'error', 'cancelled')),
  duration_ms INTEGER NOT NULL,
  row_count INTEGER,
  error_message TEXT,
  executed_at TEXT NOT NULL,
  entry_kind TEXT NOT NULL DEFAULT 'query' CHECK (entry_kind IN ('query', 'dml')),
  dml_verb TEXT CHECK (dml_verb IN ('DELETE', 'UPDATE')),
  database_name TEXT,
  container_name TEXT,
  written_count INTEGER,
  unchanged_count INTEGER,
  concurrent_change_count INTEGER,
  not_found_count INTEGER,
  expression_undefined_count INTEGER,
  failed_count INTEGER,
  not_attempted_count INTEGER,
  total_request_charge REAL,
  is_retry INTEGER CHECK (is_retry IN (0, 1))
);

INSERT INTO query_history_new
  (id, profile_id, profile_name, query_text, status, duration_ms, row_count, error_message, executed_at)
SELECT id, profile_id, profile_name, query_text, status, duration_ms, row_count, error_message, executed_at
FROM query_history
ORDER BY rowid;

DROP TABLE query_history;

ALTER TABLE query_history_new RENAME TO query_history;

CREATE INDEX idx_query_history_executed_at ON query_history (executed_at DESC);
