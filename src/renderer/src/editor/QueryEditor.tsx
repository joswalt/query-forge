import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import type { ConnectionConfig } from '@shared/types/connection-profile'
import { sqlLanguageFor } from './sql-dialects'

/** Colours come from CSS variables, so a theme switch restyles live editors
 * without reconfiguring them. */
const forgeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--qf-syn-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--qf-syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--qf-syn-number)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--qf-syn-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: 'var(--qf-syn-func)' },
  { tag: [tags.typeName, tags.className], color: 'var(--qf-syn-type)' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--qf-syn-op)' }
])

const forgeTheme = EditorView.theme({
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

export interface QueryEditorHandle {
  /** Selection text if non-empty, else the whole document (user story 24) —
   * exposed so a toolbar "Run" button (which has no CodeMirror event of its
   * own to read a selection from) can honor the same selection-vs-whole-
   * document rule as the in-editor `Mod-Enter` shortcut, rather than always
   * running the tab's full stored text. */
  getExecutionText: () => string
}

export interface QueryEditorProps {
  /** The tab's current query text, read once at mount — a parent `key`
   * (the tab id) forces a remount on tab switch so each tab's text is
   * re-seeded from its own retained state (user story 22), rather than this
   * component reacting to prop changes on every keystroke. */
  initialValue: string
  dialect: ConnectionConfig['kind'] | undefined
  onChange: (value: string) => void
  /** Invoked with the text to run: the current selection if non-empty,
   * otherwise the whole document (user story 24). */
  onExecute: (queryText: string) => void
}

/**
 * CodeMirror 6 query editor (user story 18). Deliberately assembled from
 * individual `@codemirror/*` extensions rather than the `codemirror`
 * meta-package's `basicSetup` bundle — `basicSetup` pulls in
 * `autocompletion()`, and the locked ticket-04 decision is that *all*
 * query-editor autocomplete, including keyword autocomplete, is out of
 * scope for MVP (spec.md Out of Scope; the user confirmed "I do not need
 * code complete"). `closeBrackets()` is unrelated to that — it only
 * auto-closes matching brackets/quotes — so it's kept.
 */
export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(function QueryEditor(
  { initialValue, dialect, onChange, onExecute },
  ref
): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest callbacks are read through refs from inside the keymap/update
  // listener closures below, which are only built once at mount time.
  const onChangeRef = useRef(onChange)
  const onExecuteRef = useRef(onExecute)
  onChangeRef.current = onChange
  onExecuteRef.current = onExecute

  useImperativeHandle(
    ref,
    () => ({
      getExecutionText: () => (viewRef.current ? executionText(viewRef.current) : initialValue)
    }),
    [initialValue]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        forgeTheme,
        syntaxHighlighting(forgeHighlight),
        highlightSelectionMatches(),
        sqlLanguageFor(dialect),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: (view) => {
              onExecuteRef.current(executionText(view))
              return true
            }
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        })
      ]
    })

    const view = new EditorView({ state, parent: container })
    viewRef.current = view

    return () => {
      // Required: CodeMirror's EditorView holds DOM/event resources that
      // outlive a bare unmount, and React StrictMode double-invokes this
      // effect in development — without an explicit destroy, the first
      // mount's view would leak and keep handling keystrokes.
      view.destroy()
      viewRef.current = null
    }
    // Intentionally mount-once: dialect/initialValue changes are handled by
    // the parent remounting this component (via `key={tab.id}`) on tab
    // switch, not by reconfiguring a live view in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className="query-editor" />
})

function executionText(view: EditorView): string {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  return selected.trim().length > 0 ? selected : view.state.doc.toString()
}
