import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { ResultChunk } from '@shared/types/database-provider'
import { CosmosDbProvider } from '@main/query-execution/providers/cosmos-db-provider'

/**
 * Cosmos DB Provider against a real account or the vNext emulator.
 * Skipped unless QF_COSMOS_ENDPOINT and QF_COSMOS_KEY are set; QF_COSMOS_DATABASE
 * and QF_COSMOS_CONTAINER must name an existing container. Run with
 * `npm run test:integration`.
 *
 * Emulator note: the vNext emulator serves a self-signed certificate, so run
 * with NODE_TLS_REJECT_UNAUTHORIZED=0 for the emulator only (test-only
 * tooling, never shipped — spec.md Testing Decisions).
 */
const { QF_COSMOS_ENDPOINT, QF_COSMOS_KEY, QF_COSMOS_DATABASE, QF_COSMOS_CONTAINER } = process.env
const enabled = Boolean(
  QF_COSMOS_ENDPOINT && QF_COSMOS_KEY && QF_COSMOS_DATABASE && QF_COSMOS_CONTAINER
)

function profile(): ConnectionProfile {
  return {
    id: 'integration-cosmos',
    name: 'Integration Cosmos',
    readOnly: false,
    hasSecret: true,
    config: {
      kind: 'cosmos-db',
      endpoint: QF_COSMOS_ENDPOINT as string,
      authMode: 'account-key',
      database: QF_COSMOS_DATABASE,
      container: QF_COSMOS_CONTAINER
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

describe.skipIf(!enabled)('CosmosDbProvider (live account / emulator)', () => {
  it('testConnection succeeds with the account key and fails with a bad key', async () => {
    const provider = new CosmosDbProvider()
    expect((await provider.testConnection(profile(), QF_COSMOS_KEY)).success).toBe(true)
    const bad = await provider.testConnection(profile(), Buffer.from('bad-key').toString('base64'))
    expect(bad.success).toBe(false)
  }, 60_000)

  it('streams a cross-partition query as Result Chunks', async () => {
    const provider = new CosmosDbProvider()
    await provider.connect(profile(), QF_COSMOS_KEY)
    try {
      const chunks: ResultChunk[] = []
      for await (const chunk of provider.executeQuery('SELECT TOP 5 * FROM c')) chunks.push(chunk)
      expect(chunks.length).toBeGreaterThan(0)
      for (const chunk of chunks) expect(Array.isArray(chunk.rows)).toBe(true)
    } finally {
      await provider.disconnect()
    }
  }, 60_000)

  it('getMetadata lists containers with partition keys', async () => {
    const provider = new CosmosDbProvider()
    await provider.connect(profile(), QF_COSMOS_KEY)
    try {
      const metadata = await provider.getMetadata()
      expect(metadata.objects.length).toBeGreaterThan(0)
    } finally {
      await provider.disconnect()
    }
  }, 60_000)
})
