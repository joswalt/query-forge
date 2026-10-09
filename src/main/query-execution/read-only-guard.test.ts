import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types/connection-profile'
import { assertReadOnlyQuery, ReadOnlyViolationError } from './read-only-guard'

const sqlConfig: ConnectionConfig = {
  kind: 'azure-sql',
  server: 'x',
  database: 'y',
  authMode: 'sql-credentials'
}
const cosmosConfig: ConnectionConfig = {
  kind: 'cosmos-db',
  endpoint: 'https://x',
  authMode: 'account-key'
}

describe('assertReadOnlyQuery', () => {
  it.each([
    'SELECT * FROM t',
    'select 1; select 2',
    'WITH c AS (SELECT 1 AS a) SELECT a FROM c',
    "SELECT 'DELETE FROM t' AS note",
    'SELECT [update], "drop" FROM t',
    '-- DROP TABLE t\nSELECT 1',
    '/* INSERT */ SELECT 1'
  ])('allows %s', (query) => {
    expect(() => assertReadOnlyQuery(sqlConfig, query)).not.toThrow()
  })

  it.each([
    'INSERT INTO t VALUES (1)',
    'update t set a = 1',
    'DELETE FROM t',
    'WITH c AS (SELECT 1 AS a) DELETE FROM c',
    'SELECT * INTO #copy FROM t',
    'SELECT 1; DROP TABLE t',
    'EXEC sp_who',
    'TRUNCATE TABLE t',
    "/* hi */ MERGE t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1;"
  ])('rejects %s', (query) => {
    expect(() => assertReadOnlyQuery(sqlConfig, query)).toThrow(ReadOnlyViolationError)
  })

  it('never inspects Cosmos DB queries (NoSQL queries are SELECT-only)', () => {
    expect(() => assertReadOnlyQuery(cosmosConfig, 'SELECT * FROM c WHERE c.op = "DELETE"')).not.toThrow()
  })
})
