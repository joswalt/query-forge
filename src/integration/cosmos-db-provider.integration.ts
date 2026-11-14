import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CosmosClient, PartitionKeyKind } from '@azure/cosmos'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { ResultChunk } from '@shared/types/database-provider'
import type { DocumentWriteResult, StoredDocument } from '@shared/types/document-writer'
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
      expect(metadata.objects[0].children?.[0]).toMatchObject({ kind: 'partition-key' })
    } finally {
      await provider.disconnect()
    }
  }, 60_000)

  it("carries the container's partition key paths on the first Result Chunk", async () => {
    const provider = new CosmosDbProvider()
    await provider.connect(profile(), QF_COSMOS_KEY)
    try {
      const chunks: ResultChunk[] = []
      for await (const chunk of provider.executeQuery('SELECT TOP 1 * FROM c')) chunks.push(chunk)
      expect(chunks[0].meta?.partitionKeyPaths?.length).toBeGreaterThan(0)
    } finally {
      await provider.disconnect()
    }
  }, 60_000)
})

/**
 * Document Writes against throwaway containers created in QF_COSMOS_DATABASE
 * (and deleted afterwards), so each test controls its partition key
 * definition. The emulator doesn't document its etag (412), hierarchical
 * partition key or None-key behaviour, so those tests are probes: a failure
 * on the emulator records a gap in it, not necessarily in QueryForge. The
 * emulator reports 0 RU, so RU assertions run only against a live account.
 */
describe.skipIf(!enabled)('CosmosDbProvider Document Writes (live account / emulator)', () => {
  const isEmulator = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(QF_COSMOS_ENDPOINT ?? '')
  const suffix = randomUUID().slice(0, 8)
  const singleKeyContainer = `qf-it-writes-${suffix}`
  const hierarchicalContainer = `qf-it-writes-hpk-${suffix}`
  let admin: CosmosClient
  let provider: CosmosDbProvider

  function expectCharged(result: { requestCharge: number }): void {
    if (!isEmulator) expect(result.requestCharge).toBeGreaterThan(0)
  }

  function storedDocument(result: DocumentWriteResult): StoredDocument {
    expect(result.outcome).toBe('success')
    if (result.outcome !== 'success' || !result.document) throw new Error('no stored document')
    return result.document
  }

  beforeAll(async () => {
    admin = new CosmosClient({ endpoint: QF_COSMOS_ENDPOINT as string, key: QF_COSMOS_KEY })
    const database = admin.database(QF_COSMOS_DATABASE as string)
    await database.containers.create({ id: singleKeyContainer, partitionKey: { paths: ['/pk'] } })
    await database.containers.create({
      id: hierarchicalContainer,
      partitionKey: { paths: ['/tenant', '/region'], kind: PartitionKeyKind.MultiHash, version: 2 }
    })
    provider = new CosmosDbProvider()
    await provider.connect(profile(), QF_COSMOS_KEY)
  }, 120_000)

  afterAll(async () => {
    await provider?.disconnect()
    const database = admin?.database(QF_COSMOS_DATABASE as string)
    await database?.container(singleKeyContainer).delete().catch(() => {})
    await database?.container(hierarchicalContainer).delete().catch(() => {})
    admin?.dispose()
  }, 120_000)

  it('round-trips a Document Write through create, replace, patch and delete', async () => {
    const container = singleKeyContainer
    const id = `doc-${randomUUID()}`

    const created = await provider.writeDocument({
      kind: 'create',
      id,
      partitionKey: 'p1',
      body: { pk: 'p1', n: 1 },
      container
    })
    const createdDoc = storedDocument(created)
    expect(createdDoc).toMatchObject({ id, pk: 'p1', n: 1 })
    expectCharged(created)

    const replaced = await provider.writeDocument({
      kind: 'replace',
      id,
      partitionKey: 'p1',
      body: { id, pk: 'p1', n: 2 },
      ifMatch: createdDoc._etag as string,
      container
    })
    const replacedDoc = storedDocument(replaced)
    expect(replacedDoc.n).toBe(2)

    const patched = await provider.writeDocument({
      kind: 'patch',
      id,
      partitionKey: 'p1',
      ifMatch: replacedDoc._etag as string,
      operations: [
        { op: 'set', path: '/status', value: 'done' },
        { op: 'remove', path: '/n' }
      ],
      container
    })
    const patchedDoc = storedDocument(patched)
    expect(patchedDoc.status).toBe('done')
    expect('n' in patchedDoc).toBe(false)

    const read = await provider.readDocument({ id, partitionKey: 'p1', container })
    expect(read).toMatchObject({ outcome: 'success', document: { id, status: 'done' } })

    const deleted = await provider.writeDocument({
      kind: 'delete',
      id,
      partitionKey: 'p1',
      ifMatch: patchedDoc._etag as string,
      container
    })
    expect(deleted).toMatchObject({ outcome: 'success' })
    expect(deleted).not.toHaveProperty('document')
    expectCharged(deleted)
  }, 60_000)

  it('reports an id clash on create as a conflict', async () => {
    const id = `doc-${randomUUID()}`
    const write = {
      kind: 'create' as const,
      id,
      partitionKey: 'p1',
      body: { pk: 'p1' },
      container: singleKeyContainer
    }
    await provider.writeDocument(write)

    const clash = await provider.writeDocument(write)

    expect(clash.outcome).toBe('conflict')
  }, 60_000)

  it('reads a missing document as not-found', async () => {
    const result = await provider.readDocument({
      id: `missing-${randomUUID()}`,
      partitionKey: 'p1',
      container: singleKeyContainer
    })

    expect(result.outcome).toBe('not-found')
  }, 60_000)

  it('probe: refuses replace, patch and delete with a stale etag as a Concurrent Change', async () => {
    const id = `doc-${randomUUID()}`
    const container = singleKeyContainer
    const first = storedDocument(
      await provider.writeDocument({ kind: 'create', id, partitionKey: 'p1', body: { pk: 'p1', n: 1 }, container })
    )
    const staleEtag = first._etag as string
    storedDocument(
      await provider.writeDocument({
        kind: 'replace',
        id,
        partitionKey: 'p1',
        body: { id, pk: 'p1', n: 2 },
        ifMatch: staleEtag,
        container
      })
    )

    const replace = await provider.writeDocument({
      kind: 'replace',
      id,
      partitionKey: 'p1',
      body: { id, pk: 'p1', n: 3 },
      ifMatch: staleEtag,
      container
    })
    const patch = await provider.writeDocument({
      kind: 'patch',
      id,
      partitionKey: 'p1',
      ifMatch: staleEtag,
      operations: [{ op: 'set', path: '/n', value: 4 }],
      container
    })
    const remove = await provider.writeDocument({
      kind: 'delete',
      id,
      partitionKey: 'p1',
      ifMatch: staleEtag,
      container
    })

    expect([replace.outcome, patch.outcome, remove.outcome]).toEqual([
      'precondition-failed',
      'precondition-failed',
      'precondition-failed'
    ])
  }, 60_000)

  it('probe: addresses documents with the None and null partition key values', async () => {
    const container = singleKeyContainer
    const noneId = `none-${randomUUID()}`
    const nullId = `null-${randomUUID()}`

    storedDocument(
      await provider.writeDocument({ kind: 'create', id: noneId, partitionKey: {}, body: { n: 1 }, container })
    )
    storedDocument(
      await provider.writeDocument({ kind: 'create', id: nullId, partitionKey: null, body: { pk: null }, container })
    )

    expect(await provider.readDocument({ id: noneId, partitionKey: {}, container })).toMatchObject({
      outcome: 'success'
    })
    expect(await provider.readDocument({ id: noneId, partitionKey: null, container })).toMatchObject({
      outcome: 'not-found'
    })
    expect(await provider.readDocument({ id: nullId, partitionKey: null, container })).toMatchObject({
      outcome: 'success'
    })
  }, 60_000)

  it('probe: writes and reads documents with a hierarchical partition key, including a None level', async () => {
    const container = hierarchicalContainer
    const id = `doc-${randomUUID()}`
    const noneLevelId = `none-level-${randomUUID()}`

    const created = storedDocument(
      await provider.writeDocument({
        kind: 'create',
        id,
        partitionKey: ['tenant-a', 'eu'],
        body: { tenant: 'tenant-a', region: 'eu' },
        container
      })
    )
    const patched = await provider.writeDocument({
      kind: 'patch',
      id,
      partitionKey: ['tenant-a', 'eu'],
      ifMatch: created._etag as string,
      operations: [{ op: 'set', path: '/status', value: 'done' }],
      container
    })
    expect(storedDocument(patched).status).toBe('done')

    storedDocument(
      await provider.writeDocument({
        kind: 'create',
        id: noneLevelId,
        partitionKey: ['tenant-a', {}],
        body: { tenant: 'tenant-a' },
        container
      })
    )
    expect(
      await provider.readDocument({ id: noneLevelId, partitionKey: ['tenant-a', {}], container })
    ).toMatchObject({ outcome: 'success' })
  }, 60_000)
})
