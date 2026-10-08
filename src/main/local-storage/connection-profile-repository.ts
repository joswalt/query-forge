import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'

export interface CreateConnectionProfileInput {
  name: string
  readOnly: boolean
  config: ConnectionConfig
  secretCiphertext?: Buffer
}

export interface UpdateConnectionProfileInput {
  name?: string
  readOnly?: boolean
  config?: ConnectionConfig
  /** `null` clears the stored secret; `undefined` leaves it untouched. */
  secretCiphertext?: Buffer | null
}

interface ConnectionProfileRow {
  id: string
  name: string
  read_only: number
  config_json: string
  secret_ciphertext: Buffer | null
  created_at: string
  updated_at: string
}

/**
 * Local Storage Service component owning Connection Profile persistence in
 * SQLite. Stores secrets only as opaque ciphertext blobs — encryption and
 * decryption are the Connection Manager's responsibility, not this
 * repository's (GLOSSARY.md: "Connection Manager" vs "Local Storage
 * Service").
 */
export class ConnectionProfileRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateConnectionProfileInput): ConnectionProfile {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO connection_profiles (id, name, read_only, config_json, secret_ciphertext, created_at, updated_at)
         VALUES (@id, @name, @readOnly, @configJson, @secretCiphertext, @createdAt, @updatedAt)`
      )
      .run({
        id,
        name: input.name,
        readOnly: input.readOnly ? 1 : 0,
        configJson: JSON.stringify(input.config),
        secretCiphertext: input.secretCiphertext ?? null,
        createdAt: now,
        updatedAt: now
      })
    return this.get(id)!
  }

  get(id: string): ConnectionProfile | undefined {
    const row = this.getRow(id)
    return row ? toConnectionProfile(row) : undefined
  }

  list(): ConnectionProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM connection_profiles ORDER BY name ASC')
      .all() as ConnectionProfileRow[]
    return rows.map(toConnectionProfile)
  }

  update(id: string, input: UpdateConnectionProfileInput): ConnectionProfile {
    const existing = this.getRow(id)
    if (!existing) {
      throw new Error(`Connection profile "${id}" does not exist`)
    }

    const name = input.name ?? existing.name
    const readOnly = input.readOnly ?? Boolean(existing.read_only)
    const configJson = input.config ? JSON.stringify(input.config) : existing.config_json
    const secretCiphertext =
      input.secretCiphertext === undefined ? existing.secret_ciphertext : input.secretCiphertext
    const updatedAt = new Date().toISOString()

    this.db
      .prepare(
        `UPDATE connection_profiles
         SET name = @name, read_only = @readOnly, config_json = @configJson, secret_ciphertext = @secretCiphertext, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({ id, name, readOnly: readOnly ? 1 : 0, configJson, secretCiphertext, updatedAt })

    return this.get(id)!
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM connection_profiles WHERE id = ?').run(id)
  }

  getSecretCiphertext(id: string): Buffer | undefined {
    return this.getRow(id)?.secret_ciphertext ?? undefined
  }

  private getRow(id: string): ConnectionProfileRow | undefined {
    return this.db.prepare('SELECT * FROM connection_profiles WHERE id = ?').get(id) as
      | ConnectionProfileRow
      | undefined
  }
}

function toConnectionProfile(row: ConnectionProfileRow): ConnectionProfile {
  return {
    id: row.id,
    name: row.name,
    readOnly: Boolean(row.read_only),
    config: JSON.parse(row.config_json) as ConnectionConfig,
    hasSecret: row.secret_ciphertext !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
