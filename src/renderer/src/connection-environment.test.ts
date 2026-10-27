import { describe, expect, it } from 'vitest'
import type { ConnectionEnvironment } from '@shared/types/connection-profile'
import { groupByEnvironment } from './connection-environment'

const profile = (
  name: string,
  environment?: ConnectionEnvironment
): { name: string; environment?: ConnectionEnvironment } => ({
  name,
  environment
})

describe('groupByEnvironment', () => {
  it('orders groups Production, Staging, Development, Other and keeps input order within each', () => {
    const groups = groupByEnvironment([
      profile('opt-ecom (prod)', 'prod'),
      profile('opt-ecom (stg)', 'stg'),
      profile('scratch'),
      profile('opt-item (prod)', 'prod'),
      profile('local', 'dev')
    ])
    expect(groups.map((g) => [g.label, g.connections.map((c) => c.name)])).toEqual([
      ['Production', ['opt-ecom (prod)', 'opt-item (prod)']],
      ['Staging', ['opt-ecom (stg)']],
      ['Development', ['local']],
      ['Other', ['scratch']]
    ])
  })

  it('leaves out empty groups', () => {
    const groups = groupByEnvironment([profile('a', 'stg'), profile('b', 'stg')])
    expect(groups.map((g) => g.label)).toEqual(['Staging'])
  })

  it('returns one unlabelled group when no connection has an environment', () => {
    const groups = groupByEnvironment([profile('a'), profile('b')])
    expect(groups).toEqual([{ label: null, connections: [profile('a'), profile('b')] }])
  })

  it('returns no groups for no connections', () => {
    expect(groupByEnvironment([])).toEqual([])
  })
})
