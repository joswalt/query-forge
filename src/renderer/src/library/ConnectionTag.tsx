import type { ConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'
import { ENVIRONMENT_SHORT } from '../connection-environment'
import { DATABASE_KIND_LABEL } from '../database-kind'
import { CosmosIcon, DatabaseIcon } from '../icons'

/**
 * Which connection a saved query or history entry belongs to: kind icon,
 * name and Environment chip, so a prod entry reads as prod here too. Falls
 * back to `fallbackName` (the name recorded at the time) or the database
 * kind when the Connection Profile is gone or was never set.
 */
export function ConnectionTag({
  connection,
  fallbackName,
  kind
}: {
  connection: ConnectionProfile | undefined
  fallbackName?: string
  kind?: ConnectionConfig['kind']
}): React.JSX.Element {
  const resolvedKind = connection?.config.kind ?? kind
  const name =
    connection?.name ?? fallbackName ?? (resolvedKind ? `Any ${DATABASE_KIND_LABEL[resolvedKind]}` : 'No connection')
  return (
    <span className="conn-tag" title={resolvedKind ? `${name} (${DATABASE_KIND_LABEL[resolvedKind]})` : name}>
      {resolvedKind === 'cosmos-db' ? (
        <CosmosIcon size={13} />
      ) : resolvedKind === 'azure-sql' ? (
        <DatabaseIcon size={13} />
      ) : null}
      <span className="conn-tag__name">{name}</span>
      {connection?.environment && (
        <span className="chip chip--env chip--small" data-env={connection.environment}>
          {ENVIRONMENT_SHORT[connection.environment]}
        </span>
      )}
    </span>
  )
}
