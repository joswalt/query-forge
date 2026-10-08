/**
 * Thin interface wrapping OS-level credential encryption (GLOSSARY.md:
 * "SecretStore"). Exists so Connection Manager business logic can be
 * unit-tested against a mock/fake, reserving the real `safeStorage` binding
 * (see `safe-storage-secret-store.ts`) for Electron-runtime integration
 * tests (map.md ticket 11).
 */
export interface SecretStore {
  isAvailable(): boolean
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}
