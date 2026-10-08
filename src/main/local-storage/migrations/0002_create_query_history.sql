-- Query History Entry (GLOSSARY.md) storage. `profile_id` is intentionally
-- not a FOREIGN KEY: a Connection Profile may be deleted (user story 5)
-- while its history should remain readable (user story 50), so
-- `profile_name` is denormalized at record time rather than joined.
-- `query_text` is nullable: whether it is populated is a Preferences-level
-- opt-in (user story 53), not a schema-level one — withheld by default.
CREATE TABLE query_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  profile_name TEXT NOT NULL,
  query_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'cancelled')),
  duration_ms INTEGER NOT NULL,
  row_count INTEGER,
  error_message TEXT,
  executed_at TEXT NOT NULL
);

CREATE INDEX idx_query_history_executed_at ON query_history (executed_at DESC);
