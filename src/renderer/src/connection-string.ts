import type { AzureSqlAuthMode } from '@shared/types/connection-profile'

/**
 * Fields an Azure SQL ADO.NET connection string can populate on the
 * connection form. Only what a Connection Profile can actually hold — the
 * parser never widens the profile to arbitrary driver options.
 */
export interface ParsedSqlConnectionString {
  server: string
  port?: number
  database?: string
  username?: string
  /** Plaintext password from the string — handed to the form's secret field,
   * never stored as part of the profile. Absent for portal placeholders. */
  password?: string
  encrypt?: boolean
  authMode: AzureSqlAuthMode
  /** Non-fatal things the user should know (ignored keys, placeholders). */
  notes: string[]
}

export type ParseSqlConnectionStringResult =
  | { ok: true; value: ParsedSqlConnectionString }
  | { ok: false; error: string }

const SERVER_KEYS = new Set(['server', 'data source', 'address', 'addr', 'network address'])
const DATABASE_KEYS = new Set(['database', 'initial catalog'])
const USER_KEYS = new Set(['user id', 'uid', 'user'])
const PASSWORD_KEYS = new Set(['password', 'pwd'])

/** Keys the Azure portal emits that don't change anything this app models. */
const HARMLESS_KEYS = new Set([
  'persist security info',
  'multipleactiveresultsets',
  'application name',
  'app',
  'pooling',
  'packet size',
  'workstation id',
  'wsid',
  'connect retry count',
  'connect retry interval'
])
const TIMEOUT_KEYS = new Set(['connection timeout', 'connect timeout', 'timeout'])

/** Splits `key=value;key=value` honouring ADO.NET quoting: values may be
 * wrapped in `'` or `"` (doubled quote escapes) and may then contain `;`. */
function tokenize(input: string): Array<[string, string]> | string {
  const pairs: Array<[string, string]> = []
  let i = 0
  const n = input.length

  while (i < n) {
    while (i < n && (input[i] === ';' || /\s/.test(input[i]))) i++
    if (i >= n) break

    let key = ''
    while (i < n && input[i] !== '=' && input[i] !== ';') key += input[i++]
    if (i >= n || input[i] !== '=') return `Expected "=" after "${key.trim()}".`
    i++ // '='

    while (i < n && /\s/.test(input[i])) i++
    let value = ''
    const quote = input[i]
    if (quote === '"' || quote === "'") {
      i++
      for (;;) {
        if (i >= n) return `Unterminated quoted value for "${key.trim()}".`
        if (input[i] === quote) {
          if (input[i + 1] === quote) {
            value += quote
            i += 2
            continue
          }
          i++
          break
        }
        value += input[i++]
      }
      while (i < n && input[i] !== ';') i++
    } else {
      while (i < n && input[i] !== ';') value += input[i++]
      value = value.trim()
    }
    pairs.push([key.trim().toLowerCase().replace(/\s+/g, ' '), value])
  }
  return pairs
}

function parseBool(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case 'mandatory':
    case 'strict':
      return true
    case 'false':
    case 'no':
    case 'optional':
      return false
    default:
      return undefined
  }
}

/** Portal templates use `{your_password}`-style placeholders. */
function isPlaceholder(value: string): boolean {
  return /^\{.*\}$/.test(value.trim())
}

/**
 * Parses an Azure SQL **ADO.NET** connection string (the portal's
 * Settings → Connection strings → ADO.NET tab, either the SQL
 * authentication or the Microsoft Entra variant).
 *
 * Deliberately strict about what it cannot honour: an unrecognised key is an
 * error rather than silently dropped, and authentication modes the spec
 * rules out (Active Directory Password = ROPC, Device Code) or the app has
 * no support for are rejected with a reason.
 */
export function parseSqlConnectionString(input: string): ParseSqlConnectionStringResult {
  const tokens = tokenize(input)
  if (typeof tokens === 'string') return { ok: false, error: tokens }
  if (tokens.length === 0) return { ok: false, error: 'The connection string is empty.' }

  const notes: string[] = []
  let server: string | undefined
  let port: number | undefined
  let database: string | undefined
  let username: string | undefined
  let password: string | undefined
  let encrypt: boolean | undefined
  let authMode: AzureSqlAuthMode | undefined

  for (const [key, value] of tokens) {
    if (SERVER_KEYS.has(key)) {
      let host = value.trim().replace(/^tcp:/i, '')
      const comma = host.lastIndexOf(',')
      if (comma !== -1) {
        const parsedPort = Number(host.slice(comma + 1).trim())
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          return { ok: false, error: `Invalid port in Server: "${value}".` }
        }
        port = parsedPort
        host = host.slice(0, comma)
      }
      if (/^[^,]*\\/.test(host)) {
        return { ok: false, error: 'Named SQL Server instances are not supported (Azure SQL only).' }
      }
      server = host.trim()
    } else if (DATABASE_KEYS.has(key)) {
      database = value.trim()
    } else if (USER_KEYS.has(key)) {
      if (isPlaceholder(value)) notes.push('User ID was a placeholder — enter your username.')
      else username = value
    } else if (PASSWORD_KEYS.has(key)) {
      if (isPlaceholder(value)) notes.push('Password was a placeholder — enter your password.')
      else password = value
    } else if (key === 'encrypt') {
      encrypt = parseBool(value)
      if (encrypt === undefined) return { ok: false, error: `Unrecognised Encrypt value "${value}".` }
    } else if (key === 'trustservercertificate') {
      const trust = parseBool(value)
      if (trust === undefined) {
        return { ok: false, error: `Unrecognised TrustServerCertificate value "${value}".` }
      }
      if (trust) {
        return { ok: false, error: 'TrustServerCertificate=True is not supported.' }
      }
    } else if (key === 'authentication') {
      const normalized = value.trim().toLowerCase().replace(/\s+/g, '')
      if (normalized === 'activedirectorydefault' || normalized === 'activedirectoryinteractive') {
        authMode = 'entra-id'
      } else if (normalized === 'sqlpassword' || normalized === 'notspecified' || normalized === '') {
        authMode = 'sql-credentials'
      } else if (normalized === 'activedirectorypassword') {
        return {
          ok: false,
          error:
            '"Active Directory Password" (username/password against Entra ID) is not supported — use "Active Directory Interactive" or SQL authentication.'
        }
      } else if (normalized === 'activedirectorydevicecode') {
        return { ok: false, error: '"Active Directory Device Code" is not supported.' }
      } else {
        return { ok: false, error: `Authentication "${value}" is not supported.` }
      }
    } else if (TIMEOUT_KEYS.has(key)) {
      notes.push(
        'Connection Timeout was ignored — set "Timeout in seconds" yourself (it also sets the query timeout).'
      )
    } else if (HARMLESS_KEYS.has(key)) {
      // Accepted, no effect on what this app models.
    } else {
      return { ok: false, error: `Unsupported connection string key "${key}".` }
    }
  }

  if (!server) return { ok: false, error: 'The connection string has no Server.' }

  return {
    ok: true,
    value: {
      server,
      port,
      database,
      username,
      password,
      encrypt,
      authMode: authMode ?? 'sql-credentials',
      notes
    }
  }
}
