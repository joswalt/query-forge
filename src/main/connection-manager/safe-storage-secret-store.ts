import { safeStorage } from 'electron'
import type { SecretStore } from './secret-store'

/**
 * Real `safeStorage`-backed SecretStore (map.md ticket 08). Main-process
 * only by construction — see docs/adr/0001-...-utility-process.md. Not
 * exercised by the plain-Node Vitest suite; covered instead by an
 * Electron-runtime integration test (Playwright's Electron support, map.md
 * ticket 11) that round-trips a real secret through the OS keychain.
 */
export class SafeStorageSecretStore implements SecretStore {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  encrypt(plaintext: string): Buffer {
    if (!this.isAvailable()) {
      throw new Error('OS-level credential encryption is not available on this machine')
    }
    return safeStorage.encryptString(plaintext)
  }

  decrypt(ciphertext: Buffer): string {
    return safeStorage.decryptString(ciphertext)
  }
}
