-- Saved Query (GLOSSARY.md) storage (user story 51: "save frequently used
-- queries and associate them with a connection or database type"). Mirrors
-- query_history's choice to denormalize rather than FOREIGN KEY `profile_id`:
-- deleting a Connection Profile (user story 5) must not cascade-delete a
-- user's saved queries, and `database_kind` lets a query stay associated
-- with "azure-sql" or "cosmos-db" generically even after its originating
-- profile is gone (or when it was never tied to one profile in particular).
CREATE TABLE saved_queries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_text TEXT NOT NULL,
  profile_id TEXT,
  database_kind TEXT CHECK (database_kind IN ('cosmos-db', 'azure-sql')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_saved_queries_updated_at ON saved_queries (updated_at DESC);
