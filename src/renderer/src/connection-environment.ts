import {
  CONNECTION_ENVIRONMENTS,
  type ConnectionEnvironment
} from '@shared/types/connection-profile'

export const ENVIRONMENT_LABEL: Record<ConnectionEnvironment, string> = {
  prod: 'Production',
  stg: 'Staging',
  dev: 'Development'
}

/** Short form for chips and tooltips. */
export const ENVIRONMENT_SHORT: Record<ConnectionEnvironment, string> = {
  prod: 'prod',
  stg: 'stg',
  dev: 'dev'
}

/** One `<optgroup>` of the Connection select; `label` is null when nothing is grouped. */
export interface EnvironmentGroup<T> {
  label: string | null
  connections: T[]
}

/**
 * Splits connections into Production, Staging, Development, then "Other" for
 * profiles with no environment, so a prod connection never sits on the row
 * next to its stg twin. Input order is kept within each group, and when no
 * profile has an environment the list comes back as one unlabelled group.
 */
export function groupByEnvironment<T extends { environment?: ConnectionEnvironment }>(
  connections: readonly T[]
): EnvironmentGroup<T>[] {
  if (!connections.some((c) => c.environment)) {
    return connections.length ? [{ label: null, connections: [...connections] }] : []
  }
  const groups: EnvironmentGroup<T>[] = CONNECTION_ENVIRONMENTS.map((env) => ({
    label: ENVIRONMENT_LABEL[env],
    connections: connections.filter((c) => c.environment === env)
  }))
  groups.push({
    label: 'Other',
    connections: connections.filter((c) => !c.environment)
  })
  return groups.filter((g) => g.connections.length > 0)
}
