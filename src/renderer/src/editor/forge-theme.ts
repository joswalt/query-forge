import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/** Colours come from CSS variables, so a theme switch restyles live editors
 * without reconfiguring them. Shared by the query editor and the document
 * editor so both look the same. */
export const forgeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--qf-syn-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--qf-syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--qf-syn-number)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--qf-syn-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: 'var(--qf-syn-func)' },
  { tag: [tags.typeName, tags.className], color: 'var(--qf-syn-type)' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--qf-syn-op)' }
])

export const forgeTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--qf-fg)', backgroundColor: 'transparent', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--qf-font-mono)', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--qf-ember-1)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--qf-ember-1)', borderLeftWidth: '2px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--qf-muted)',
    border: 'none',
    paddingLeft: '4px'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--qf-fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--qf-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--qf-accent-soft)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--qf-accent-soft)',
    outline: '1px solid var(--qf-accent)'
  },
  '.cm-searchMatch': { backgroundColor: 'var(--qf-accent-soft)' }
})
