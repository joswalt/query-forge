import { formatCellValue } from './cell-format'

/** Narrowest a fitted column gets: room for a short header and "NULL". */
export const FIT_MIN_WIDTH_PX = 60
/** Widest a fitted column gets, so one long JSON blob can't push every
 * other column off screen; the cell inspector shows the rest. */
export const FIT_MAX_WIDTH_PX = 720

/** Only the longest few texts are measured: on tens of thousands of rows,
 * measuring every one would stall the click, and pixel width tracks
 * character count closely (the cells are monospace). */
const MEASURED_CANDIDATES = 25

/**
 * The width that shows a column's header and every loaded value in full
 * (clamped to FIT_MIN/MAX_WIDTH_PX): what "fit column to contents" sets.
 * DOM-free, so the measuring is injected (a canvas `measureText` in the
 * grid; a fake in tests). `paddingPx` is the cell's horizontal padding.
 */
export function fitColumnWidth({
  header,
  values,
  measureHeader,
  measureCell,
  paddingPx
}: {
  header: string
  values: unknown[]
  measureHeader: (text: string) => number
  measureCell: (text: string) => number
  paddingPx: number
}): number {
  const texts = values.map(formatCellValue)
  texts.sort((a, b) => b.length - a.length)
  let widest = measureHeader(header)
  for (const text of texts.slice(0, MEASURED_CANDIDATES)) {
    widest = Math.max(widest, measureCell(text))
  }
  const width = Math.ceil(widest + paddingPx)
  return Math.min(FIT_MAX_WIDTH_PX, Math.max(FIT_MIN_WIDTH_PX, width))
}
