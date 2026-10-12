import type { ConnectionEnvironment } from '@shared/types/connection-profile'

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
