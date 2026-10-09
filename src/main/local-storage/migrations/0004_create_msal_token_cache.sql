-- MSAL token cache storage (spec.md Implementation Decisions: "every
-- secret (SQL credentials, Cosmos account keys, MSAL token cache)...
-- stored as Secret Ciphertext in SQLite"). Deliberately its own table, not
-- a reuse of connection_profiles.secret_ciphertext: that column already
-- means "this profile's account-key/password secret", so overloading it
-- for an Entra ID profile's token cache would make `hasSecret` report a
-- false "has credential" lock icon, make `revealSecret()` hand a cache
-- blob to a caller expecting a password, and make
-- `UpdateConnectionProfileRequest.secret = null` ("clear the stored
-- secret") silently destroy a signed-in session instead.
-- `profile_id` is the primary key, not merely indexed: a profile has at
-- most one token cache, mirroring one `PublicClientApplication` per
-- Connection Profile (entra-id-authenticator.ts).
CREATE TABLE msal_token_cache (
  profile_id TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
