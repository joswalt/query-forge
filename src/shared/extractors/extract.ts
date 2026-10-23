import type { Extractor, ExtractorOptions } from './extractor'
import { jsonExtractor, jsonLinesExtractor } from './json-extractors'
import {
  sqlInsertMultirowExtractor,
  sqlInsertsExtractor,
  whereClauseExtractor
} from './sql-extractors'
import {
  csvExtractor,
  markdownExtractor,
  oneRowExtractor,
  pipeExtractor,
  prettyExtractor,
  semicolonExtractor,
  tsvExtractor
} from './text-extractors'

export type { Extractor, ExtractorId, ExtractorOptions } from './extractor'

/**
 * Extractors (GLOSSARY.md): named output formats that turn result rows plus
 * a column list into text. Pure, shared code used by both the renderer
 * (clipboard copy, via `extract`) and main (the Export Service writing a
 * file), so copied and exported output are byte-identical for the same rows
 * and Extractor (user story 50; ADR 0003). Listed in dropdown order.
 */
export const EXTRACTORS: readonly Extractor[] = [
  csvExtractor,
  tsvExtractor,
  pipeExtractor,
  semicolonExtractor,
  jsonExtractor,
  jsonLinesExtractor,
  markdownExtractor,
  prettyExtractor,
  oneRowExtractor,
  sqlInsertsExtractor,
  sqlInsertMultirowExtractor,
  whereClauseExtractor
]

/** The Extractor for `id`, or CSV for an unknown id (e.g. a persisted
 * setting from a newer or older build). */
export function getExtractor(id: string): Extractor {
  return EXTRACTORS.find((extractor) => extractor.id === id) ?? csvExtractor
}

/** The whole output for in-memory rows: the renderer's copy actions and the
 * Export Service's "Export loaded" both go through this. */
export function extract(
  extractorId: string,
  rows: readonly unknown[],
  columns: readonly string[],
  options: ExtractorOptions
): string {
  const extractor = getExtractor(extractorId)
  if (extractor.buffersAllRows) return extractor.render(rows, columns, options)
  let text = extractor.begin(options)
  rows.forEach((row, index) => {
    text += extractor.row(row, options, index)
  })
  return text + extractor.end(options, rows.length)
}
