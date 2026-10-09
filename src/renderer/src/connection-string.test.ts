import { describe, expect, it } from 'vitest'
import { parseSqlConnectionString, type ParsedSqlConnectionString } from './connection-string'

function parseOk(input: string): ParsedSqlConnectionString {
  const result = parseSqlConnectionString(input)
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
  return result.value
}

function parseError(input: string): string {
  const result = parseSqlConnectionString(input)
  if (result.ok) throw new Error('expected an error')
  return result.error
}

describe('parseSqlConnectionString', () => {
  it('parses the portal’s Entra "passwordless" ADO.NET string', () => {
    const value = parseOk(
      'Server=tcp:opt-data-store-nonprod-679d3e28.database.windows.net,1433;Initial Catalog=mydb;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication="Active Directory Default";'
    )
    expect(value).toMatchObject({
      server: 'opt-data-store-nonprod-679d3e28.database.windows.net',
      port: 1433,
      database: 'mydb',
      encrypt: true,
      authMode: 'entra-id'
    })
    expect(value.username).toBeUndefined()
    expect(value.password).toBeUndefined()
  })

  it('parses the portal’s SQL authentication string and drops placeholders', () => {
    const value = parseOk(
      'Server=tcp:h.database.windows.net,1433;Initial Catalog=db;Persist Security Info=False;User ID={your_username};Password={your_password};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;'
    )
    expect(value.authMode).toBe('sql-credentials')
    expect(value.username).toBeUndefined()
    expect(value.password).toBeUndefined()
    expect(value.notes.join(' ')).toMatch(/placeholder/)
  })

  it('reads real credentials, case-insensitive keys and synonyms', () => {
    const value = parseOk('data source=h.example.net;DATABASE=db;uid=alice;PWD=s3cret')
    expect(value).toMatchObject({
      server: 'h.example.net',
      database: 'db',
      username: 'alice',
      password: 's3cret',
      authMode: 'sql-credentials'
    })
  })

  it('keeps semicolons and doubled quotes inside quoted values', () => {
    const value = parseOk(`Server=h;Database=db;User ID=alice;Password="pa;ss""word"`)
    expect(value.password).toBe('pa;ss"word')
  })

  it('maps Encrypt=False', () => {
    expect(parseOk('Server=h;Encrypt=False').encrypt).toBe(false)
  })

  it('never maps Connection Timeout, but tells the user', () => {
    const value = parseOk('Server=h;Connection Timeout=30')
    expect(value.notes.join(' ')).toMatch(/Connection Timeout/)
  })

  it('rejects Active Directory Password (ROPC) and Device Code', () => {
    expect(parseError('Server=h;Authentication=Active Directory Password')).toMatch(/not supported/)
    expect(parseError('Server=h;Authentication=Active Directory Device Code')).toMatch(
      /not supported/
    )
  })

  it('rejects other unsupported authentication modes', () => {
    expect(parseError('Server=h;Authentication=Active Directory Managed Identity')).toMatch(
      /not supported/
    )
  })

  it('rejects unknown keys instead of silently dropping them', () => {
    expect(parseError('Server=h;ApplicationIntent=ReadOnly')).toMatch(/applicationintent/)
  })

  it('rejects TrustServerCertificate=True', () => {
    expect(parseError('Server=h;TrustServerCertificate=True')).toMatch(/not supported/)
  })

  it('rejects a missing server, an empty string, malformed pairs and a bad port', () => {
    expect(parseError('Database=db')).toMatch(/no Server/)
    expect(parseError('   ')).toMatch(/empty/)
    expect(parseError('Server')).toMatch(/Expected "="/)
    expect(parseError('Server=h,notaport')).toMatch(/port/)
    expect(parseError('Server=h;Password="oops')).toMatch(/Unterminated/)
  })
})
