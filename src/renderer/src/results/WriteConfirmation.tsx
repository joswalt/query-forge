import { useEffect, useRef, useState } from 'react'
import type { ConnectionEnvironment } from '@shared/types/connection-profile'
import { requiresWriteConfirmation } from '@shared/write-confirmation'
import { ENVIRONMENT_LABEL } from '../connection-environment'

/** Which drawer write a Write Confirmation is waiting on. */
export type DrawerWrite = 'save' | 'delete'

/** The drawer's Write Confirmation step (decision 05, stories 51 to 58). */
export interface WriteConfirmationStep {
  /** The write of the active edit session waiting for Confirm, if any. */
  awaiting: DrawerWrite | undefined
  /** The policy for the current profile, for labels and the header strip. */
  required: boolean
  /** First step of a write: on prod it waits for Confirm, elsewhere it
   * writes at once. The policy is read now, from the current profile. */
  press: (write: DrawerWrite, send: () => void) => void
  /** Confirm: sends the write waiting for it. */
  confirm: (send: () => void) => void
  /** Cancel: back to the editor, draft untouched. */
  cancel: () => void
  /** Focus target after the first step, so Enter or a repeated Cmd/Ctrl+S
   * never confirms a prod write by habit. */
  cancelRef: React.RefObject<HTMLButtonElement>
}

/**
 * Holds the one Write Confirmation that may be waiting in the drawer.
 * It belongs to the exact edit session state it was pressed on: any change
 * to that session (an edit to the draft, a read, Edit instead) or a switch
 * to another session drops it, so Confirm always sends what was on screen.
 * Renderer-only: nothing about it is sent, so no request carries a
 * `confirmed` flag.
 */
export function useWriteConfirmation(
  profile: { environment?: ConnectionEnvironment } | undefined,
  session: object | undefined
): WriteConfirmationStep {
  const [pending, setPending] = useState<{ session: object; write: DrawerWrite } | undefined>()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const required = requiresWriteConfirmation(profile)
  // An Environment edited away from prod meanwhile shows the plain buttons.
  const awaiting =
    required && pending !== undefined && pending.session === session ? pending.write : undefined

  useEffect(() => {
    if (awaiting) cancelRef.current?.focus()
  }, [awaiting])

  return {
    awaiting,
    required,
    press(write, send) {
      if (session === undefined) return
      if (requiresWriteConfirmation(profile)) {
        setPending({ session, write })
        // Already waiting (Cmd/Ctrl+S again): the effect won't run again.
        cancelRef.current?.focus()
      } else {
        send()
      }
    },
    confirm(send) {
      setPending(undefined)
      send()
    },
    cancel() {
      setPending(undefined)
    },
    cancelRef
  }
}

/** The prod-coloured strip across the top of the drawer (story 55). */
export function ProdWriteStrip(): React.JSX.Element {
  return (
    <div className="document-drawer__env-strip" data-env="prod" role="note">
      <strong>{ENVIRONMENT_LABEL.prod}</strong>
      <span>Every create, save and delete asks you to confirm.</span>
    </div>
  )
}

/**
 * Confirm / Cancel, shown in place of the write button while a Write
 * Confirmation waits. Cancel takes focus.
 */
export function ConfirmWriteButtons({
  step,
  write,
  onConfirm
}: {
  step: WriteConfirmationStep
  write: DrawerWrite
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <>
      <span className="document-drawer__confirm-prompt" role="status">
        {write === 'delete' ? 'Delete from prod?' : 'Save to prod?'}
      </span>
      <button type="button" ref={step.cancelRef} onClick={step.cancel}>
        Cancel
      </button>
      <button
        type="button"
        className={write === 'delete' ? 'btn--danger document-drawer__confirm' : 'btn--primary'}
        onClick={() => step.confirm(onConfirm)}
      >
        Confirm
      </button>
    </>
  )
}

/** Is this key event Cmd/Ctrl+S? */
export function isSaveShortcut(event: React.KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's'
  )
}
