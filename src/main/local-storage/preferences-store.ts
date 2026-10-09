import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultPreferences } from '@shared/types/preferences'
import type { Preferences } from '@shared/types/preferences'
import { isRecord } from '@shared/is-record'

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
   * section merges the same way without this method needing to grow a new
   * hardcoded branch for it. A scalar key (e.g. `theme`) is replaced
   * outright rather than object-spread: spreading a string/number/boolean
   * produces an index-keyed object (`{...'dark'}` → `{0:'d',1:'a',...}`),
   * not the scalar itself, so only plain-object values are merged.
   */
  update(patch: Partial<Preferences>): Preferences {
    const current = this.get()
    const next = { ...current } as Preferences
    for (const key of Object.keys(patch) as (keyof Preferences)[]) {
      const patchValue = patch[key]
      if (patchValue !== undefined) {
        // `keyof Preferences` spans both an object-shaped value
        // (`queryHistory`) and a scalar one (`theme`) — TS's indexed-write
        // checking wants the assigned value assignable to *every* possible
        // value type at once (an intersection, not the union callers
        // actually mean), which no single merged value can satisfy. The
        // `as never` cast is the escape hatch for that specific, known TS
        // limitation; `isRecord`/`patchValue !== undefined` above already
        // do the real type-safety work.
        next[key] = (
          isRecord(patchValue) ? { ...(current[key] as object), ...patchValue } : patchValue
        ) as never
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
      const merged = { ...defaultPreferences } as Preferences
      for (const key of Object.keys(defaultPreferences) as (keyof Preferences)[]) {
        const parsedValue = parsed[key]
        if (parsedValue === undefined) continue
        // Same indexed-write limitation as `update()`'s `as never` above.
        merged[key] = (
          isRecord(parsedValue)
            ? { ...(defaultPreferences[key] as object), ...parsedValue }
            : parsedValue
        ) as never
      }
      return merged
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
