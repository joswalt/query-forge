/**
 * Preferences (GLOSSARY.md) — the Local Storage Service's JSON-file-backed
 * settings, distinct from the SQLite database (map.md ticket 07: "a JSON
 * file for preferences"). Shared between main's `PreferencesStore` and the
 * renderer so both type against the same shape.
 */
export interface Preferences {
  queryHistory: {
    /** User story 53: "avoid persisting sensitive query parameters unless
     * I explicitly opt in." Off by default — Query History Entries always
     * record status/duration/row count regardless of this flag; only the
     * query text itself is withheld unless this is `true`. */
    persistQueryText: boolean
  }
}

export const defaultPreferences: Preferences = {
  queryHistory: { persistQueryText: false }
}
