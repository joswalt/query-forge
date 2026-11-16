import type { DmlSampleChange, DmlSampleValue } from '@shared/types/dml-run'

/** How much of a value a confirmation sample cell shows before `…`. */
export const SAMPLE_VALUE_CHARS = 60

const json = (value: unknown): string => JSON.stringify(value) ?? String(value)

function truncated(text: string): string {
  return text.length > SAMPLE_VALUE_CHARS ? `${text.slice(0, SAMPLE_VALUE_CHARS - 1)}…` : text
}

/** A sample value as one short line: `(absent)` or truncated JSON. */
export function sampleValueText(value: DmlSampleValue): string {
  return value.defined ? truncated(json(value.value)) : '(absent)'
}

/**
 * How an `UPDATE` changes an array at one place: the entries kept from
 * the start and end, and what replaces the run between them. Entries
 * compare by their JSON.
 */
export interface ArrayEdit {
  kept: number
  removed: unknown[]
  added: unknown[]
}

export function arrayEdit(current: unknown[], next: unknown[]): ArrayEdit {
  const a = current.map(json)
  const b = next.map(json)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  return {
    kept: prefix + suffix,
    removed: current.slice(prefix, current.length - suffix),
    added: next.slice(prefix, next.length - suffix)
  }
}

const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

/**
 * The one-line summary of an array `SET` that only adds or only removes
 * entries, e.g. `3 entries` / `+ {"status":"CANCELED",…}`, so an append
 * reads at a glance instead of as two identical truncated prefixes.
 * `undefined` when the change isn't that shape (not arrays on both sides,
 * nothing changed, or entries both removed and added).
 */
export function arrayChangeSummary(change: DmlSampleChange): { kept: string; delta: string } | undefined {
  const { current, next } = change
  if (!current.defined || !next.defined) return undefined
  if (!Array.isArray(current.value) || !Array.isArray(next.value)) return undefined
  const edit = arrayEdit(current.value, next.value)
  if (edit.removed.length > 0 && edit.added.length > 0) return undefined
  if (edit.added.length > 0) {
    const delta = edit.added.length === 1 ? truncated(json(edit.added[0])) : entries(edit.added.length)
    return { kept: entries(edit.kept), delta: `+ ${delta}` }
  }
  if (edit.removed.length > 0) {
    const delta = edit.removed.length === 1 ? truncated(json(edit.removed[0])) : entries(edit.removed.length)
    return { kept: entries(edit.kept), delta: `− ${delta}` }
  }
  return undefined
}

export interface DiffLine {
  kind: 'same' | 'removed' | 'added'
  text: string
}

/** Above this many line pairs the diff skips matching and shows the whole
 * current value removed and the whole new value added. */
const DIFF_CELL_LIMIT = 1_000_000

const prettyLines = (value: DmlSampleValue): string[] =>
  value.defined ? (JSON.stringify(value.value, null, 2) ?? String(value.value)).split('\n') : ['(absent)']

/**
 * A line diff of the pretty-printed current and new values (longest
 * common subsequence), for the expanded view of one sample cell.
 */
export function sampleChangeDiff(change: DmlSampleChange): DiffLine[] {
  const a = prettyLines(change.current)
  const b = prettyLines(change.next)
  const removedAll = a.map((text): DiffLine => ({ kind: 'removed', text }))
  const addedAll = b.map((text): DiffLine => ({ kind: 'added', text }))
  if (a.length * b.length > DIFF_CELL_LIMIT) return [...removedAll, ...addedAll]

  // lengths[i][j]: LCS length of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) lines.push({ kind: 'removed', text: a[i++] })
    else lines.push({ kind: 'added', text: b[j++] })
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++] })
  return lines
}
