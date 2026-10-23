import { useCallback, useEffect, useState } from 'react'
import { getExtractor, type ExtractorId } from '@shared/extractors/extract'
import { defaultPreferences } from '@shared/types/preferences'

/** The Active Extractor and the Include header toggle, global across tabs
 * and remembered across launches in Preferences (user stories 2, 19). */
export interface ExtractorSettings {
  extractorId: ExtractorId
  includeHeader: boolean
}

const defaults: ExtractorSettings = {
  extractorId: defaultPreferences.extractor.activeExtractorId,
  includeHeader: defaultPreferences.extractor.includeHeader
}

export function useExtractorSettings(): [
  ExtractorSettings,
  (patch: Partial<ExtractorSettings>) => void
] {
  const [settings, setSettings] = useState(defaults)

  useEffect(() => {
    window.api.preferences
      .get()
      .then((prefs) =>
        setSettings({
          // An unknown id (older/newer build) falls back to CSV.
          extractorId: getExtractor(prefs.extractor.activeExtractorId).id,
          includeHeader: prefs.extractor.includeHeader
        })
      )
      .catch(() => {})
  }, [])

  const update = useCallback(
    (patch: Partial<ExtractorSettings>) => {
      const next = { ...settings, ...patch }
      setSettings(next)
      // Best-effort: the choice still applies for this session if saving fails.
      window.api.preferences
        .update({
          extractor: { activeExtractorId: next.extractorId, includeHeader: next.includeHeader }
        })
        .catch(() => {})
    },
    [settings]
  )

  return [settings, update]
}
