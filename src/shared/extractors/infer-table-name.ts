/**
 * The table a query reads from, for the SQL Extractors' Table field (user
 * story 38): the name after a single-table `FROM`, as written (bracketed and
 * schema-qualified Azure SQL names included; the container identifier for
 * Cosmos). Anything it can't be sure about returns `undefined` so the UI
 * falls back to `my_table`: joins, comma joins, APPLY, subqueries, table-
 * valued functions, several FROMs (a multi-statement script), or none.
 */

const NAME_PART = String.raw`(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[A-Za-z_@#][\w@#$]*)`
const NAME = new RegExp(String.raw`^\s+(${NAME_PART}(?:\s*\.\s*${NAME_PART}){0,3})`)

export function inferTableName(query: string): string | undefined {
  const masked = maskLiterals(query)
  const froms = [...masked.matchAll(/\bfrom\b/gi)]
  if (froms.length !== 1 || /\b(?:join|apply)\b/i.test(masked)) return undefined

  const afterFrom = (froms[0].index ?? 0) + froms[0][0].length
  const match = NAME.exec(query.slice(afterFrom))
  if (!match) return undefined

  // Whatever follows the name (an alias, then WHERE/ORDER BY/...) must not
  // be a call's argument list or a comma join's next table.
  const rest = masked.slice(afterFrom + match[0].length)
  if (/^\s*\(/.test(rest) || /^\s*(?:as\s+)?(?:\[[^\]]*\]|\w+)?\s*,/i.test(rest)) {
    return undefined
  }
  return match[1]
}

/** `query` with the insides of string literals, quoted/bracketed
 * identifiers and comments blanked to spaces (same length, so indexes line
 * up), so a `from` inside any of them isn't mistaken for the keyword. */
function maskLiterals(query: string): string {
  return query.replace(
    /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|\[[^\]]*\]?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (token) =>
      token[0] + ' '.repeat(Math.max(token.length - 2, 0)) + (token.length > 1 ? token.at(-1) : '')
  )
}
