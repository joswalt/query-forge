import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Provider integration tests against live/emulated databases. Kept out of
 * `npm test` (vitest.config.ts only includes `*.test.ts`); each suite skips
 * itself unless its QF_* environment variables are set. See the README's
 * "Provider integration tests" section.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['src/integration/**/*.integration.ts']
  }
})
