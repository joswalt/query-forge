import { describe, expect, it, vi } from 'vitest'
import { MsalServicePrincipalAuthenticator } from './entra-id-authenticator'

describe('MsalServicePrincipalAuthenticator', () => {
  it('requests a client-credentials token for the tenant authority and scopes', async () => {
    const acquireTokenByClientCredential = vi.fn(async () => ({ accessToken: 'tok' }))
    const factory = vi.fn(() => ({ acquireTokenByClientCredential }))
    const authenticator = new MsalServicePrincipalAuthenticator(factory)

    const token = await authenticator.acquireToken(
      { clientId: 'client-1', tenantId: 'tenant-1' },
      'shh',
      ['https://database.windows.net/.default']
    )

    expect(token).toBe('tok')
    expect(factory).toHaveBeenCalledWith({
      auth: {
        clientId: 'client-1',
        clientSecret: 'shh',
        authority: 'https://login.microsoftonline.com/tenant-1'
      }
    })
    expect(acquireTokenByClientCredential).toHaveBeenCalledWith({
      scopes: ['https://database.windows.net/.default']
    })
  })

  it('fails clearly when Entra returns no token', async () => {
    const authenticator = new MsalServicePrincipalAuthenticator(() => ({
      acquireTokenByClientCredential: async () => null
    }))

    await expect(
      authenticator.acquireToken({ clientId: 'c', tenantId: 't' }, 's', ['x/.default'])
    ).rejects.toThrow(/no access token/i)
  })
})
