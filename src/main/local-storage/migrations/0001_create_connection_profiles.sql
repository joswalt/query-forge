CREATE TABLE connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  secret_ciphertext BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
