import { extract, getExtractor, type ExtractorOptions } from '@shared/extractors/extract'
import { formatCellValue } from './cell-format'

/** About 10 MB of text (UTF-16 code units, close enough for a speed bump):
 * past this a copy asks "copy anyway / export to file instead" first, so a
 * huge result doesn't freeze the app or flood the clipboard (user story 11). */
export const COPY_SIZE_LIMIT = 10 * 1024 * 1024

export type CopyScope = 'cell' | 'selected' | 'all'

/** What a copy shortcut copies (user stories 4-6): Cmd/Ctrl+Shift+C is all
 * loaded rows; Cmd/Ctrl+C is the selected rows, or the active cell when no
 * row is selected. */
export function copyScopeForShortcut({
  shift,
  selectedRowCount
}: {
  shift: boolean
  selectedRowCount: number
}): CopyScope {
  if (shift) return 'all'
  return selectedRowCount > 0 ? 'selected' : 'cell'
}

export type CopyRequest =
  | { scope: 'cell'; value: unknown }
  | {
      scope: 'rows'
      rows: readonly unknown[]
      columns: readonly string[]
      extractorId: string
      options: ExtractorOptions
    }

export interface CopyPlan {
  text: string
  /** The confirmation toast, e.g. "Copied 1,240 rows as Markdown". */
  message: string
  needsSizeConfirmation: boolean
}

/**
 * The text a copy action puts on the clipboard. A cell copy is always the
 * raw value as the grid shows it, whatever the Active Extractor (user
 * story 9); a rows copy goes through the Extractor (Active, or the one
 * picked from "Copy as ▸").
 */
export function planCopy(request: CopyRequest, sizeLimit = COPY_SIZE_LIMIT): CopyPlan {
  if (request.scope === 'cell') {
    return {
      text: formatCellValue(request.value),
      message: 'Copied value',
      needsSizeConfirmation: false
    }
  }
  const { rows, columns, extractorId, options } = request
  const text = extract(extractorId, rows, columns, options)
  const count = `${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'row' : 'rows'}`
  return {
    text,
    message: `Copied ${count} as ${getExtractor(extractorId).label}`,
    needsSizeConfirmation: text.length >= sizeLimit
  }
}
