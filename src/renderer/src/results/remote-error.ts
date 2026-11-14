const INVOKE_WRAPPER = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

/**
 * The message of a rejected `ipcRenderer.invoke`, without the wrapper
 * Electron adds. Main has already scrubbed it (no secrets).
 */
export function remoteErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(INVOKE_WRAPPER, '')
}
