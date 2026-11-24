import { useCallback, useEffect, useRef, useState } from 'react'

/** Which row was just copied, cleared after a moment so its "Copied" note fades. */
export function useCopiedFlag(durationMs = 1500): [string | null, (id: string) => void] {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timeoutRef.current), [])

  const markCopied = useCallback(
    (id: string) => {
      setCopiedId(id)
      clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(
        () => setCopiedId((current) => (current === id ? null : current)),
        durationMs
      )
    },
    [durationMs]
  )
  return [copiedId, markCopied]
}
