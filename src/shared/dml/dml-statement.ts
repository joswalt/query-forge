/**
 * The shared, pure DML Statement parser and translator (GLOSSARY.md: "DML
 * Statement", "Driving Query"), in the style of ADR 0003: no Node, DOM or
 * Electron dependency, so the renderer (detect DML, show syntax errors
 * before anything is sent) and the Query Execution Service (the authority:
 * re-parse, refuse, translate) run the very same code.
 *
 * Only the shell of a statement is parsed: the verb, the alias, the `SET`
 * targets and the start of `WHERE`. `WHERE` conditions and `SET` expressions
 * pass through verbatim, so Cosmos DB evaluates them.
 */

export type DmlVerb = 'DELETE' | 'UPDATE'

/**
 * Removes `--` line comments and block comments, leaving string literals
 * untouched. Each comment becomes one space so tokens either side of it
 * stay apart.
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const end = endOfString(text, i)
      out += text.slice(i, end)
      i = end
    } else if (ch === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline
      out += ' '
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? text.length : close + 2
      out += ' '
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** Index just past the string literal opening at `start` (backslash escapes). */
function endOfString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    if (text[i] === '\\') i += 2
    else if (text[i] === quote) return i + 1
    else i++
  }
  return text.length
}

/**
 * Detection (story 72): after comments are stripped, a first keyword of
 * `DELETE` or `UPDATE` makes the text a DML Statement. Anything else runs as
 * a query, unchanged.
 */
export function detectDmlStatement(text: string): DmlVerb | undefined {
  const first = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(stripComments(text))?.[1]?.toUpperCase()
  return first === 'DELETE' || first === 'UPDATE' ? first : undefined
}

/** Patch's cap on operations per document (ADR 0004 amendment), so also on `SET`s. */
export const MAX_ASSIGNMENTS = 10

/**
 * One `SET <target> = <expression>` of an UPDATE. `pointer` is the target as
 * a patch JSON pointer; `target` is the path as typed, for projection and
 * display. The literal `undefined` makes it a `remove`.
 */
export type DmlAssignment =
  | { kind: 'set'; target: string; pointer: string; expression: string }
  | { kind: 'remove'; target: string; pointer: string }

/** The parsed shell of a DML Statement (GLOSSARY.md); `condition` is verbatim. */
export type DmlStatement =
  | { verb: 'DELETE'; alias: string; condition: string }
  | { verb: 'UPDATE'; alias: string; assignments: DmlAssignment[]; condition: string }

/** A DML Statement QueryForge refuses before anything is sent (story 73). */
export interface DmlSyntaxError {
  message: string
}

export type DmlParseResult =
  | { ok: true; statement: DmlStatement }
  | { ok: false; error: DmlSyntaxError }

interface Token {
  kind: 'word' | 'string' | 'number' | 'punct'
  text: string
  start: number
  end: number
  /** Nesting of `(`, `[` and `{` around the token; 0 is the statement shell. */
  depth: number
  /** A word right after `.` is a property name, never a keyword. */
  afterDot: boolean
}

const MULTI_CHAR_PUNCT = ['!=', '<>', '<=', '>=', '??', '||', '<<', '>>>', '>>']

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let depth = 0
  let i = 0
  const push = (kind: Token['kind'], start: number, end: number, tokenDepth = depth): void => {
    const previous = tokens[tokens.length - 1]
    tokens.push({
      kind,
      text: text.slice(start, end),
      start,
      end,
      depth: tokenDepth,
      afterDot: previous?.kind === 'punct' && previous.text === '.'
    })
  }
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '"' || ch === "'") {
      const end = endOfString(text, i)
      push('string', i, end)
      i = end
    } else if (/[A-Za-z_$@]/.test(ch)) {
      const end = scan(text, i, /[A-Za-z0-9_$@]/)
      push('word', i, end)
      i = end
    } else if (/[0-9]/.test(ch)) {
      const end = scan(text, i, /[0-9A-Za-z_.]/)
      push('number', i, end)
      i = end
    } else if (ch === '(' || ch === '[' || ch === '{') {
      push('punct', i, i + 1)
      depth++
      i++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(depth - 1, 0)
      push('punct', i, i + 1)
      i++
    } else {
      const multi = MULTI_CHAR_PUNCT.find((p) => text.startsWith(p, i))
      const end = i + (multi?.length ?? 1)
      push('punct', i, end)
      i = end
    }
  }
  return tokens
}

function scan(text: string, start: number, pattern: RegExp): number {
  let i = start
  while (i < text.length && pattern.test(text[i])) i++
  return i
}

/** A keyword token of the statement shell (depth 0, not a property name). */
function isKeyword(token: Token | undefined, keyword: string): boolean {
  return (
    token !== undefined &&
    token.kind === 'word' &&
    token.depth === 0 &&
    !token.afterDot &&
    token.text.toUpperCase() === keyword
  )
}

const RESERVED_WORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'SET', 'JOIN', 'IN', 'AS', 'VALUE', 'TOP', 'DISTINCT',
  'ORDER', 'GROUP', 'BY', 'OFFSET', 'LIMIT', 'AND', 'OR', 'NOT', 'BETWEEN', 'EXISTS',
  'LIKE', 'ARRAY', 'TRUE', 'FALSE', 'NULL', 'UNDEFINED', 'DELETE', 'UPDATE'
])

function isAlias(token: Token | undefined): token is Token {
  return (
    token !== undefined &&
    token.kind === 'word' &&
    token.depth === 0 &&
    !RESERVED_WORDS.has(token.text.toUpperCase())
  )
}

class DmlParseFailure extends Error {}

function fail(message: string): never {
  throw new DmlParseFailure(message)
}

/**
 * Parses the shell of a DML Statement: `DELETE FROM <alias> WHERE <cond>` or
 * `UPDATE <alias> SET <path> = <expr> [, …] WHERE <cond>`. Never throws; a
 * statement QueryForge refuses comes back as a named `DmlSyntaxError`.
 */
export function parseDmlStatement(
  text: string,
  partitionKeyPaths: readonly string[] = []
): DmlParseResult {
  try {
    return { ok: true, statement: parseShell(stripComments(text), partitionKeyPaths) }
  } catch (err) {
    if (err instanceof DmlParseFailure) return { ok: false, error: { message: err.message } }
    throw err
  }
}

function parseShell(text: string, partitionKeyPaths: readonly string[]): DmlStatement {
  const all = tokenize(text)
  // One statement per run (story 65): a trailing `;` is allowed, any other
  // top-level `;` means a second statement.
  const semicolons = all.filter((t) => t.kind === 'punct' && t.text === ';' && t.depth === 0)
  const trailing = semicolons.length === 1 && semicolons[0] === all[all.length - 1]
  if (semicolons.length > 0 && !trailing) {
    fail('Run one statement at a time: only a trailing ";" is allowed after a DML Statement.')
  }
  const tokens = trailing ? all.slice(0, -1) : all
  const bodyEnd = trailing ? semicolons[0].start : text.length

  refuseUnsupportedClauses(tokens)

  if (isKeyword(tokens[0], 'DELETE')) return parseDelete(text, tokens, bodyEnd)
  if (isKeyword(tokens[0], 'UPDATE')) return parseUpdate(text, tokens, bodyEnd, partitionKeyPaths)
  return fail('A DML Statement starts with DELETE or UPDATE.')
}

/**
 * Story 66: clauses a DML Statement can't carry, named in the error. Only
 * the shell is scanned; the same words inside property names, strings and
 * parenthesised subqueries pass through for Cosmos DB to judge.
 */
function refuseUnsupportedClauses(tokens: Token[]): void {
  const refuse = (clause: string): never =>
    fail(`${clause} is not supported in a DML Statement.`)
  tokens.forEach((token, i) => {
    if (isKeyword(token, 'JOIN')) refuse('JOIN')
    if (isKeyword(token, 'DISTINCT')) refuse('DISTINCT')
    if (isKeyword(token, 'TOP')) refuse('TOP')
    if (isKeyword(token, 'OFFSET') || isKeyword(token, 'LIMIT')) refuse('OFFSET … LIMIT')
    if (isKeyword(token, 'GROUP') && isKeyword(tokens[i + 1], 'BY')) refuse('GROUP BY')
    if (isKeyword(token, 'ORDER') && isKeyword(tokens[i + 1], 'BY')) refuse('ORDER BY')
  })
}

/** Story 64: `WHERE` is required, with a non-empty condition. */
function conditionAfter(
  text: string,
  where: Token | undefined,
  bodyEnd: number,
  verb: DmlVerb
): string {
  const everything = verb === 'DELETE' ? 'delete every document' : 'update every document'
  const condition = where ? text.slice(where.end, bodyEnd).trim() : ''
  if (condition === '') fail(`WHERE is required; use WHERE true to ${everything}.`)
  return condition
}

function parseDelete(text: string, tokens: Token[], bodyEnd: number): DmlStatement {
  const [, from, alias, where] = tokens
  const example = 'as in DELETE FROM c WHERE <condition>'
  if (!isKeyword(from, 'FROM')) fail(`Expected FROM after DELETE, ${example}.`)
  if (!isAlias(alias)) fail(`Expected an alias after DELETE FROM, ${example}.`)
  if (where !== undefined && !isKeyword(where, 'WHERE')) {
    fail(`Expected WHERE after DELETE FROM ${alias.text}, found "${where.text}".`)
  }
  return { verb: 'DELETE', alias: alias.text, condition: conditionAfter(text, where, bodyEnd, 'DELETE') }
}

function parseUpdate(
  text: string,
  tokens: Token[],
  bodyEnd: number,
  partitionKeyPaths: readonly string[]
): DmlStatement {
  const [, alias, set] = tokens
  const example = 'as in UPDATE c SET c.path = <expression> WHERE <condition>'
  if (!isAlias(alias)) fail(`Expected an alias after UPDATE, ${example}.`)
  if (!isKeyword(set, 'SET')) fail(`Expected SET after UPDATE ${alias.text}, ${example}.`)

  const whereIndex = tokens.findIndex((t) => isKeyword(t, 'WHERE'))
  const where = whereIndex === -1 ? undefined : tokens[whereIndex]
  const setTokens = tokens.slice(3, whereIndex === -1 ? tokens.length : whereIndex)
  if (setTokens.length === 0) fail('SET needs at least one assignment, as in SET c.path = <expression>.')

  // Split on top-level commas; each group's text runs up to its comma (or WHERE).
  const groups: Array<{ tokens: Token[]; end: number }> = [{ tokens: [], end: where?.start ?? bodyEnd }]
  for (const token of setTokens) {
    const current = groups[groups.length - 1]
    if (token.kind === 'punct' && token.text === ',' && token.depth === 0) {
      groups.push({ tokens: [], end: current.end })
      current.end = token.start
    } else {
      current.tokens.push(token)
    }
  }
  if (groups.length > MAX_ASSIGNMENTS) {
    fail(
      `An UPDATE can SET at most ${MAX_ASSIGNMENTS} paths (the patch limit); ` +
        `this one sets ${groups.length}.`
    )
  }
  const assignments = groups.map((group) => {
    if (group.tokens.length === 0) fail('SET has an empty assignment; remove the extra ",".')
    return parseAssignment(text, group.tokens, group.end, alias.text, partitionKeyPaths)
  })

  return {
    verb: 'UPDATE',
    alias: alias.text,
    assignments,
    condition: conditionAfter(text, where, bodyEnd, 'UPDATE')
  }
}

function parseAssignment(
  text: string,
  tokens: Token[],
  end: number,
  alias: string,
  partitionKeyPaths: readonly string[]
): DmlAssignment {
  const equalsIndex = tokens.findIndex((t) => t.kind === 'punct' && t.text === '=' && t.depth === 0)
  if (equalsIndex === 0) {
    fail(`SET needs a target path before "=", as in SET ${alias}.path = <expression>.`)
  }
  const targetTokens = equalsIndex === -1 ? tokens : tokens.slice(0, equalsIndex)
  const target = text.slice(targetTokens[0].start, targetTokens[targetTokens.length - 1].end)
  if (equalsIndex === -1) fail(`Expected "=" after ${target} in SET.`)

  const path = parseTargetPath(targetTokens, target, alias)
  refuseProtectedTarget(target, path, partitionKeyPaths)

  const expression = text.slice(tokens[equalsIndex].end, end).trim()
  if (expression === '') fail(`SET ${target} needs a value after "=".`)
  const pointer = toJsonPointer(path)
  // Story 70: the literal `undefined` removes the property.
  return expression === 'undefined'
    ? { kind: 'remove', target, pointer }
    : { kind: 'set', target, pointer, expression }
}

/** Story 67: `<alias>` then `.name`, `["quoted key"]` or `[<integer>]` steps. */
function parseTargetPath(tokens: Token[], target: string, alias: string): Array<string | number> {
  const invalid = (): never =>
    fail(
      `${target} is not a valid SET target; use a path such as ` +
        `${alias}.a.b, ${alias}["odd key"] or ${alias}.tags[0].`
    )
  const [root, ...rest] = tokens
  if (root.kind !== 'word' || root.afterDot) invalid()
  if (root.text !== alias) {
    if (rest.length === 0 || rest[0].text === '.' || rest[0].text === '[') {
      fail(`SET target ${target} must start with the alias ${alias}.`)
    }
    invalid()
  }
  if (rest.length === 0) {
    fail(`SET ${target} must name a property, as in SET ${alias}.path = <expression>.`)
  }

  const path: Array<string | number> = []
  let i = 0
  while (i < rest.length) {
    const [open, key, close] = [rest[i], rest[i + 1], rest[i + 2]]
    const bracketed = open.text === '[' && close?.text === ']'
    if (open.text === '.' && key?.kind === 'word') {
      path.push(key.text)
      i += 2
    } else if (bracketed && key?.kind === 'string') {
      path.push(decodeStringLiteral(key.text))
      i += 3
    } else if (bracketed && key?.kind === 'number' && /^\d+$/.test(key.text)) {
      path.push(Number(key.text))
      i += 3
    } else {
      invalid()
    }
  }
  return path
}

const SYSTEM_PROPERTIES = new Set(['_rid', '_self', '_etag', '_ts', '_attachments'])

/**
 * Story 68: a bulk update never changes an address (`id`, any partition key
 * path) or a server-managed field. A target above or below a partition key
 * path would change it too, so overlap in either direction is refused.
 */
function refuseProtectedTarget(
  target: string,
  path: Array<string | number>,
  partitionKeyPaths: readonly string[]
): void {
  const first = String(path[0])
  if (first === 'id') fail(`SET ${target} is not allowed: id is part of each document's address.`)
  if (SYSTEM_PROPERTIES.has(first)) {
    fail(`SET ${target} is not allowed: ${first} is a system property managed by Cosmos DB.`)
  }
  const segments = path.map(String)
  for (const keyPath of partitionKeyPaths) {
    const key = partitionKeyPathSegments(keyPath)
    const shared = Math.min(key.length, segments.length)
    if (key.slice(0, shared).every((segment, i) => segment === segments[i])) {
      fail(`SET ${target} is not allowed: it would change the partition key path ${keyPath}.`)
    }
  }
}

/** `/a/b` → `['a', 'b']`; a quoted segment (`/"odd key"`) is unquoted. */
function partitionKeyPathSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => (/^".*"$/.test(segment) ? segment.slice(1, -1) : segment))
}

/** RFC 6901: `~` → `~0`, `/` → `~1`. */
function toJsonPointer(path: Array<string | number>): string {
  return path.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

const STRING_ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
}

function decodeStringLiteral(literal: string): string {
  let out = ''
  for (let i = 1; i < literal.length - 1; i++) {
    const ch = literal[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = literal[++i]
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(literal.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(literal.slice(i + 1, i + 5), 16))
      i += 4
    } else {
      out += STRING_ESCAPES[next] ?? next
    }
  }
  return out
}

/** A Cosmos DB query plus its parameters (the SDK's `SqlQuerySpec` shape). */
export interface DrivingQuery {
  query: string
  parameters: Array<{ name: string; value: unknown }>
}

/** Where one partition key level's value and definedness land in each match. */
export interface PartitionKeyColumns {
  path: string
  valueColumn: string
  /** `IS_DEFINED(<path>)`: false means the None value, never "unknown". */
  definedColumn: string
}

/**
 * The patch operation one `SET` becomes for each matched document. `set`
 * takes its value from `valueColumn`; `definedColumn` says whether the path
 * exists today (a `remove` of an absent path is dropped) and `currentColumn`
 * holds today's value for the confirmation sample.
 */
export type DmlOperationTemplate =
  | {
      op: 'set'
      path: string
      target: string
      valueColumn: string
      definedColumn: string
      currentColumn: string
    }
  | { op: 'remove'; path: string; target: string; definedColumn: string; currentColumn: string }

export interface DmlTranslation {
  drivingQuery: DrivingQuery
  partitionKey: PartitionKeyColumns[]
  /** One per `SET`, in order; empty for a DELETE. */
  operations: DmlOperationTemplate[]
}

export type DmlTranslationResult =
  | { ok: true; statement: DmlStatement; translation: DmlTranslation }
  | { ok: false; error: DmlSyntaxError }

/**
 * The Query Execution Service's entry point (the authority, story 144):
 * re-parses the statement text against the container's partition key paths
 * and derives its Driving Query and patch operation templates. The `WHERE`
 * condition and `SET` expressions are passed through verbatim.
 */
export function translateDmlStatement(
  text: string,
  partitionKeyPaths: readonly string[]
): DmlTranslationResult {
  const parsed = parseDmlStatement(text, partitionKeyPaths)
  if (!parsed.ok) return parsed
  const { statement } = parsed
  const { alias } = statement

  const partitionKey = partitionKeyPaths.map((path, i) => ({
    path,
    valueColumn: `__pkv${i + 1}`,
    definedColumn: `__pk${i + 1}`
  }))
  const projections = [`${alias}.id`, `${alias}._etag`, `${alias}._rid`]
  partitionKey.forEach((key) => {
    const access = propertyAccess(alias, partitionKeyPathSegments(key.path))
    projections.push(`${access} AS ${key.valueColumn}`, `IS_DEFINED(${access}) AS ${key.definedColumn}`)
  })

  const operations: DmlOperationTemplate[] = []
  if (statement.verb === 'UPDATE') {
    statement.assignments.forEach((assignment, i) => {
      const n = i + 1
      const columns = { definedColumn: `__def${n}`, currentColumn: `__cur${n}` }
      const { target, pointer: path } = assignment
      if (assignment.kind === 'set') {
        operations.push({ op: 'set', path, target, valueColumn: `__set${n}`, ...columns })
        projections.push(`(${assignment.expression}) AS __set${n}`)
      } else {
        operations.push({ op: 'remove', path, target, ...columns })
      }
      projections.push(
        `IS_DEFINED(${target}) AS ${columns.definedColumn}`,
        `${target} AS ${columns.currentColumn}`
      )
    })
  }

  return {
    ok: true,
    statement,
    translation: {
      drivingQuery: {
        query: `SELECT ${projections.join(', ')} FROM ${alias} WHERE ${statement.condition}`,
        parameters: []
      },
      partitionKey,
      operations
    }
  }
}

/** `c` + `['address', 'odd key']` → `c.address["odd key"]`. */
function propertyAccess(alias: string, segments: string[]): string {
  return (
    alias +
    segments
      .map((s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`))
      .join('')
  )
}
