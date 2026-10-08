import { MSSQL, sql, SQLDialect, StandardSQL } from '@codemirror/lang-sql'
import type { LanguageSupport } from '@codemirror/language'
import type { ConnectionConfig } from '@shared/types/connection-profile'

/**
 * Cosmos DB's "SQL for NoSQL" dialect, authored as a CodeMirror `SQLDialect`
 * keyword-list config rather than a from-scratch Lezer grammar — the
 * locked decision (ticket 04; see
 * .scratch/queryforge-architecture/research/04-query-editor.md §1): neither
 * CodeMirror nor Monaco ships a Cosmos dialect, and for *highlighting-grade*
 * support a keyword/builtin list over the existing SQL grammar skeleton is
 * the documented, comparable-effort path. Highlighting only — no
 * `schemaCompletionSource` is wired to this, matching ticket 04's "I do not
 * need code complete" decision (spec.md Out of Scope).
 */
export const cosmosNoSqlDialect = SQLDialect.define({
  keywords:
    'select from where order by asc desc top offset limit join in and or not is null ' +
    'between like exists udf group having distinct as value array object true false undefined ' +
    'all any first last',
  builtin:
    'c root udf getcurrentdatetime getcurrenttimestamp getcurrentticks arrayconcat arrayslice ' +
    'isdefined isarray isbool isnull isnumber isobject isprimitive isstring length lower upper ' +
    'trim ltrim rtrim replace reversestring substring concat stringequals tostring tonumber ' +
    'tobool toobject toarray documentid contains startswith endswith indexof left right'
})

/**
 * Resolves the CodeMirror SQL language support for a tab's active
 * connection kind. `undefined` (no connection selected yet) falls back to
 * plain StandardSQL rather than erroring — a tab is always editable even
 * before a connection is chosen (user story 21).
 */
export function sqlLanguageFor(kind: ConnectionConfig['kind'] | undefined): LanguageSupport {
  if (kind === 'cosmos-db') return sql({ dialect: cosmosNoSqlDialect, upperCaseKeywords: true })
  if (kind === 'azure-sql') return sql({ dialect: MSSQL, upperCaseKeywords: true })
  return sql({ dialect: StandardSQL })
}
