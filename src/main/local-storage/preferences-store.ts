import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultPreferences } from '@shared/types/preferences'
import type { Preferences } from '@shared/types/preferences'

export type { Preferences }
export { defaultPreferences }

/**
 * Loads/saves `Preferences` as a single JSON file at `filePath`. Merges a
 * freshly-loaded file over `defaultPreferences` one level deep, so adding a
 * new preference later doesn't require a migration — an old file on disk
 * simply lacks the new key until the user changes it.
 */
export class PreferencesStore {
  private cached: Preferences | undefined

  constructor(private readonly filePath: string) {}

  get(): Preferences {
    if (!this.cached) this.cached = this.load()
    return this.cached
  }

  /**
   * Shallow-merges `patch` over the current value one level deep *per top-
   * level key* (not just `queryHistory` by name) — so a future preference
   * section (e.g. a theme choice) merges the same way without this method
   * needing to grow a new hardcoded branch for it.
   */
  update(patch: Partial<Preferences>): Preferences {
    const current = this.get()
    const next = { ...current } as Preferences
    for (const key of Object.keys(patch) as (keyof Preferences)[]) {
      const patchValue = patch[key]
      if (patchValue !== undefined) {
        next[key] = { ...current[key], ...patchValue }
      }
    }
    this.cached = next
    this.save(next)
    return next
  }

  private load(): Preferences {
    if (!existsSync(this.filePath)) return defaultPreferences
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<Preferences>
      return {
        queryHistory: { ...defaultPreferences.queryHistory, ...parsed.queryHistory }
      }
    } catch {
      // A corrupt/unreadable preferences file falls back to defaults rather
      // than crashing app startup — preferences are non-essential settings,
      // never the sole copy of user data (that's the SQLite database).
      return defaultPreferences
    }
  }

  private save(preferences: Preferences): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(preferences, null, 2), 'utf8')
  }
}
