import type { ConnectionConfig } from '@shared/types/connection-profile'
import type { DatabaseProvider } from '@shared/types/database-provider'
import { CosmosDbProvider } from './providers/cosmos-db-provider'
import { AzureSqlProvider } from './providers/azure-sql-provider'
import { QueryExecutionService } from './query-execution-service'
import type { QueryExecutionRequest } from './protocol'

/**
 * The actual fork target for `utilityProcess.fork()` (ADR 0001) — the
 * Query Execution Service's real-world transport. Deliberately thin: wires
 * `process.parentPort` to `QueryExecutionService`, whose dispatch logic is
 * unit-tested independent of this file. Not unit-tested itself (it is pure
 * Electron-runtime glue); covered later by a Playwright-Electron
 * integration test per the spec's testing split.
 */
function createRealProvider(config: ConnectionConfig): DatabaseProvider {
  return config.kind === 'cosmos-db' ? new CosmosDbProvider() : new AzureSqlProvider()
}

const service = new QueryExecutionService(createRealProvider)

process.parentPort.on('message', (messageEvent) => {
  const request = messageEvent.data as QueryExecutionRequest
  void service.handle(request, (response) => {
    process.parentPort.postMessage(response)
  })
})
