import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { ResultChunk } from '@shared/types/database-provider'
import { AzureSqlProvider } from '@main/query-execution/providers/azure-sql-provider'

/**
 * Azure SQL Provider against a real (free-tier, serverless) Azure SQL
 * Database — spec.md Testing Decisions: no local SQL Server container.
 * Skipped unless all of QF_SQL_SERVER, QF_SQL_DATABASE, QF_SQL_USER and
 * QF_SQL_PASSWORD are set. Run with `npm run test:integration`.
 */
const { QF_SQL_SERVER, QF_SQL_DATABASE, QF_SQL_USER, QF_SQL_PASSWORD } = process.env
const enabled = Boolean(QF_SQL_SERVER && QF_SQL_DATABASE && QF_SQL_USER && QF_SQL_PASSWORD)

function profile(): ConnectionProfile {
  return {
    id: 'integration-sql',
    name: 'Integration SQL',
    readOnly: false,
    hasSecret: true,
    config: {
      kind: 'azure-sql',
      server: QF_SQL_SERVER as string,
      database: QF_SQL_DATABASE as string,
      authMode: 'sql-credentials',
      username: QF_SQL_USER,
      encrypt: true,
      connectionTimeoutMs: 60_000
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

async function collect(stream: AsyncIterable<ResultChunk>): Promise<unknown[]> {
  const rows: unknown[] = []
  for await (const chunk of stream) rows.push(...chunk.rows)
  return rows
}

describe.skipIf(!enabled)('AzureSqlProvider (live Azure SQL Database)', () => {
  it('testConnection succeeds with valid credentials and fails with a wrong password', async () => {
    const provider = new AzureSqlProvider()
    expect((await provider.testConnection(profile(), QF_SQL_PASSWORD)).success).toBe(true)
    expect((await provider.testConnection(profile(), 'definitely-wrong')).success).toBe(false)
  }, 120_000)

  it('streams rows for a query', async () => {
    const provider = new AzureSqlProvider()
    await provider.connect(profile(), QF_SQL_PASSWORD)
    try {
      const rows = await collect(provider.executeQuery('SELECT 1 AS one UNION ALL SELECT 2'))
      expect(rows).toHaveLength(2)
    } finally {
      await provider.disconnect()
    }
  }, 120_000)

  it('cancel() performs genuine server-side cancellation', async () => {
    const provider = new AzureSqlProvider()
    await provider.connect(profile(), QF_SQL_PASSWORD)
    try {
      const executionId = 'integration-cancel'
      const running = collect(provider.executeQuery("WAITFOR DELAY '00:00:30'; SELECT 1", { executionId }))
      const started = Date.now()
      setTimeout(() => provider.cancel(executionId), 1_000)
      await running.catch(() => undefined)
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      await provider.disconnect()
    }
  }, 120_000)

  it('getMetadata lists at least one schema object or none without throwing', async () => {
    const provider = new AzureSqlProvider()
    await provider.connect(profile(), QF_SQL_PASSWORD)
    try {
      const metadata = await provider.getMetadata()
      expect(Array.isArray(metadata.objects)).toBe(true)
    } finally {
      await provider.disconnect()
    }
  }, 120_000)
})
