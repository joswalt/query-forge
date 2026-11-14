import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { forgeHighlight, forgeTheme } from './forge-theme'
import { jsonLanguage } from './json-language'

const jsonHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--qf-syn-func)' },
  { tag: tags.brace, color: 'var(--qf-syn-op)' },
  { tag: tags.invalid, color: 'var(--qf-err)', textDecoration: 'underline wavy' }
])

/**
 * The document editor (story 25): the app's CodeMirror setup with JSON
 * highlighting. Mount-once like `QueryEditor`: the parent remounts it via
 * `key` when the text must be replaced (a fresh server copy), rather than
 * this component reacting to `initialValue` on every keystroke.
 */
export function JsonEditor({
  initialValue,
  onChange,
  readOnly = false,
  ariaLabel
}: {
  initialValue: string
  onChange?: (value: string) => void
  readOnly?: boolean
  ariaLabel: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        forgeTheme,
        syntaxHighlighting(forgeHighlight),
        syntaxHighlighting(jsonHighlight),
        jsonLanguage,
        EditorState.readOnly.of(readOnly),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
        })
      ]
    })
    const view = new EditorView({ state, parent: container })
    return () => view.destroy()
    // Mount-once; see the component doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={containerRef} className="json-editor" />
}
