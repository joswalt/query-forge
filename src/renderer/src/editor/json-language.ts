import { StreamLanguage, type StringStream } from '@codemirror/language'

/**
 * JSON highlighting for the document editor, built on CodeMirror's
 * `StreamLanguage` so it needs no extra package. Stand-in for
 * `@codemirror/lang-json`, which isn't installed; swapping that in later
 * changes only `JsonEditor`'s language extension. Parse errors are shown
 * by the drawer (Save refuses a body that isn't a JSON object).
 */
export const jsonLanguage = StreamLanguage.define<null>({
  name: 'json',
  startState: () => null,
  token(stream: StringStream): string | null {
    if (stream.eatSpace()) return null
    const ch = stream.peek()
    if (ch === '"') {
      stream.next()
      let escaped = false
      while (!stream.eol()) {
        const next = stream.next()
        if (next === '"' && !escaped) break
        escaped = !escaped && next === '\\'
      }
      // A string followed by `:` is a property name.
      return stream.match(/^\s*:/, false) ? 'propertyName' : 'string'
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^(true|false)\b/)) return 'bool'
    if (stream.match(/^null\b/)) return 'null'
    if (stream.match(/^[{}[\]]/)) return 'brace'
    if (stream.match(/^[:,]/)) return 'punctuation'
    stream.next()
    return 'invalid'
  },
  languageData: { closeBrackets: { brackets: ['{', '[', '"'] } }
})
