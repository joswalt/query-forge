import type { ConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'
import type {
  ConnectionProfileRepository,
  CreateConnectionProfileInput,
  UpdateConnectionProfileInput
} from '../local-storage/connection-profile-repository'
import type { SecretStore } from './secret-store'

export interface CreateConnectionProfileRequest {
  name: string
  readOnly?: boolean
  config: ConnectionConfig
  secret?: string
}

export interface UpdateConnectionProfileRequest {
  name?: string
  readOnly?: boolean
  config?: ConnectionConfig
  /** `null` clears the stored secret; `undefined` (or omitted) leaves it untouched. */
  secret?: string | null
}

/**
 * Connection Manager (GLOSSARY.md) — owns Connection Profile CRUD and secret
 * encrypt/decrypt. Never holds a live database connection; that is the
 * Query Execution Service's job. Composes the Local Storage Service's
 * ConnectionProfileRepository (opaque ciphertext persistence) with a
 * SecretStore (the actual encrypt/decrypt operation).
 */
export class ConnectionManager {
  constructor(
    private readonly repository: ConnectionProfileRepository,
    private readonly secretStore: SecretStore
  ) {}

  list(): ConnectionProfile[] {
    return this.repository.list()
  }

  get(id: string): ConnectionProfile | undefined {
    return this.repository.get(id)
  }

  create(request: CreateConnectionProfileRequest): ConnectionProfile {
    const input: CreateConnectionProfileInput = {
      name: request.name,
      readOnly: request.readOnly ?? false,
      config: request.config,
      secretCiphertext:
        request.secret !== undefined ? this.secretStore.encrypt(request.secret) : undefined
    }
    return this.repository.create(input)
  }

  update(id: string, request: UpdateConnectionProfileRequest): ConnectionProfile {
    const input: UpdateConnectionProfileInput = {
      name: request.name,
      readOnly: request.readOnly,
      config: request.config,
      secretCiphertext:
        request.secret === null
          ? null
          : request.secret !== undefined
            ? this.secretStore.encrypt(request.secret)
            : undefined
    }
    return this.repository.update(id, input)
  }

  delete(id: string): void {
    this.repository.delete(id)
  }

  /**
   * Decrypts the stored secret for a Connection Profile, producing a
   * Decrypted Secret for one-time handoff to the Query Execution Service at
   * connect-time (docs/adr/0001-...). Returns undefined when the profile has
   * no stored secret (e.g. an Entra ID profile that mints a token
   * interactively rather than persisting one).
   */
  revealSecret(id: string): string | undefined {
    const ciphertext = this.repository.getSecretCiphertext(id)
    return ciphertext ? this.secretStore.decrypt(ciphertext) : undefined
  }
}
