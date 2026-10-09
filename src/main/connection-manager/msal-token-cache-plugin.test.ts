import { describe, expect, it, vi } from 'vitest'
import type { TokenCacheContext } from '@azure/msal-node'
import { MsalTokenCachePlugin, type TokenCacheStore } from './msal-token-cache-plugin'

function fakeStore(initial?: string): TokenCacheStore & { written: string[] } {
  let current = initial
  const written: string[] = []
  return {
    written,
    read: () => current,
    write: (serialized: string) => {
      current = serialized
      written.push(serialized)
    }
  }
}

function fakeContext(options: {
  cacheHasChanged: boolean
  serialized?: string
}): TokenCacheContext & { deserializeCalls: string[] } {
  const deserializeCalls: string[] = []
  return {
    deserializeCalls,
    cacheHasChanged: options.cacheHasChanged,
    tokenCache: {
      deserialize: (cache: string) => deserializeCalls.push(cache),
      serialize: () => options.serialized ?? ''
    }
  } as unknown as TokenCacheContext & { deserializeCalls: string[] }
}

describe('MsalTokenCachePlugin', () => {
  it('deserializes a previously stored cache on beforeCacheAccess', async () => {
    const store = fakeStore('stored-cache-blob')
    const plugin = new MsalTokenCachePlugin(store)
    const context = fakeContext({ cacheHasChanged: false })

    await plugin.beforeCacheAccess(context)

    expect(context.deserializeCalls).toEqual(['stored-cache-blob'])
  })

  it('does nothing on beforeCacheAccess when no cache was ever stored', async () => {
    const store = fakeStore(undefined)
    const plugin = new MsalTokenCachePlugin(store)
    const context = fakeContext({ cacheHasChanged: false })

    await plugin.beforeCacheAccess(context)

    expect(context.deserializeCalls).toEqual([])
  })

  it('persists the serialized cache on afterCacheAccess when it changed', async () => {
    const store = fakeStore()
    const plugin = new MsalTokenCachePlugin(store)
    const context = fakeContext({ cacheHasChanged: true, serialized: 'new-cache-blob' })

    await plugin.afterCacheAccess(context)

    expect(store.written).toEqual(['new-cache-blob'])
  })

  it('does not write when the cache did not change (avoids a needless re-encrypt)', async () => {
    const store = fakeStore()
    const writeSpy = vi.spyOn(store, 'write')
    const plugin = new MsalTokenCachePlugin(store)
    const context = fakeContext({ cacheHasChanged: false, serialized: 'unchanged' })

    await plugin.afterCacheAccess(context)

    expect(writeSpy).not.toHaveBeenCalled()
  })
})
