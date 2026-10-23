/**
 * Preferences (GLOSSARY.md) — the Local Storage Service's JSON-file-backed
 * settings, distinct from the SQLite database (map.md ticket 07: "a JSON
 * file for preferences"). Shared between main's `PreferencesStore` and the
 * renderer so both type against the same shape.
 */
import type { ExtractorId } from '../extractors/extract'

export type Theme = 'light' | 'dark'

export interface Preferences {
  queryHistory: {
    /** User story 53: "avoid persisting sensitive query parameters unless
     * I explicitly opt in." Off by default — Query History Entries always
     * record status/duration/row count regardless of this flag; only the
     * query text itself is withheld unless this is `true`. */
    persistQueryText: boolean
  }
  /** User story 54: "dark and light themes." A plain top-level value, not
   * nested like `queryHistory`, since it has no sibling settings of its
   * own yet — nesting it under e.g. `appearance` preemptively would be
   * speculative structure with nothing to justify it. */
  theme: Theme
  /** The Active Extractor and Include header toggle (GLOSSARY.md), global
   * across tabs (Extractors stories 2, 19). A persisted id this build doesn't
   * know is read back as CSV (`getExtractor`). */
  extractor: {
    activeExtractorId: ExtractorId
    includeHeader: boolean
  }
}

export const defaultPreferences: Preferences = {
  queryHistory: { persistQueryText: false },
  theme: 'dark',
  extractor: { activeExtractorId: 'csv', includeHeader: true }
}
