import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { PreferencesStore, defaultPreferences } from './preferences-store'

describe('PreferencesStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queryforge-preferences-'))
    filePath = join(dir, 'preferences.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns defaults when no preferences file exists yet', () => {
    const store = new PreferencesStore(filePath)

    expect(store.get()).toEqual(defaultPreferences)
  })

  it('persists an update across a new PreferencesStore instance (same file)', () => {
    new PreferencesStore(filePath).update({ queryHistory: { persistQueryText: true } })

    const reloaded = new PreferencesStore(filePath)

    expect(reloaded.get().queryHistory.persistQueryText).toBe(true)
  })

  it('persists a theme update across a new PreferencesStore instance (same file)', () => {
    new PreferencesStore(filePath).update({ theme: 'dark' })

    const reloaded = new PreferencesStore(filePath)

    expect(reloaded.get().theme).toBe('dark')
  })

  it('fills in defaults for keys missing from an on-disk file written by an older version', () => {
    writeFileSync(filePath, JSON.stringify({}), 'utf8')

    const store = new PreferencesStore(filePath)

    expect(store.get()).toEqual(defaultPreferences)
  })

  it('falls back to defaults when the file on disk is corrupt', () => {
    writeFileSync(filePath, '{ not valid json', 'utf8')

    const store = new PreferencesStore(filePath)

    expect(store.get()).toEqual(defaultPreferences)
  })
})
