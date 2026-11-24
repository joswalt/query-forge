import type { ConnectionConfig } from '@shared/types/connection-profile'

/** Display name of a database kind, for chips and labels. */
export const DATABASE_KIND_LABEL: Record<ConnectionConfig['kind'], string> = {
  'cosmos-db': 'Cosmos DB',
  'azure-sql': 'Azure SQL'
}
