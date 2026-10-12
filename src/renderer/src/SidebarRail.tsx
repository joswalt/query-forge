import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { ConnectionStatus } from './connection-status'
import { ENVIRONMENT_SHORT } from './connection-environment'
import { BookmarkIcon, ClockIcon, CosmosIcon, DatabaseIcon, PlusIcon } from './icons'

interface Props {
  connections: ConnectionProfile[]
  statuses: Record<string, ConnectionStatus>
  /** Expand the sidebar and bring this connection's card into view. */
  onRevealConnection: (id: string) => void
  /** Expand the sidebar and open this section. */
  onOpenSection: (sectionId: 'saved-queries' | 'history') => void
  onNewConnection: () => void
}

/**
 * The sidebar collapsed to a narrow rail: one button per connection (kind icon,
 * live status dot, and an environment edge so prod stays recognisable), plus
 * entry points to the other sections. It never connects or runs anything — a
 * click only expands the sidebar, so a stray click can't open a prod session.
 */
export function SidebarRail({
  connections,
  statuses,
  onRevealConnection,
  onOpenSection,
  onNewConnection
}: Props): React.JSX.Element {
  return (
    <nav className="rail" aria-label="Connections, saved queries and history">
      <ul className="rail__list">
        {connections.map((connection) => {
          const status = statuses[connection.id] ?? 'disconnected'
          const label = [
            connection.name,
            connection.environment ? ENVIRONMENT_SHORT[connection.environment] : null,
            connection.readOnly ? 'read-only' : null,
            status
          ]
            .filter(Boolean)
            .join(', ')
          return (
            <li key={connection.id}>
              <button
                type="button"
                className="rail__btn rail__conn"
                data-status={status}
                data-env={connection.environment}
                aria-label={label}
                title={label}
                onClick={() => onRevealConnection(connection.id)}
              >
                {connection.config.kind === 'cosmos-db' ? <CosmosIcon /> : <DatabaseIcon />}
                <span className="status-dot rail__dot" data-status={status} aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className="rail__btn"
        aria-label="New connection"
        title="New connection"
        onClick={onNewConnection}
      >
        <PlusIcon />
      </button>
      <hr className="rail__divider" />
      <button
        type="button"
        className="rail__btn"
        aria-label="Saved queries"
        title="Saved queries"
        onClick={() => onOpenSection('saved-queries')}
      >
        <BookmarkIcon />
      </button>
      <button
        type="button"
        className="rail__btn"
        aria-label="Query history"
        title="Query history"
        onClick={() => onOpenSection('history')}
      >
        <ClockIcon />
      </button>
    </nav>
  )
}
