import { describe, expect, it } from 'vitest'
import type { ConnectionEnvironment } from '@shared/types/connection-profile'
import { requiresWriteConfirmation } from './write-confirmation'

const profile = (environment?: ConnectionEnvironment): { environment?: ConnectionEnvironment } => ({
  environment
})

describe('requiresWriteConfirmation', () => {
  it('requires a Write Confirmation on a prod Connection Profile', () => {
    expect(requiresWriteConfirmation(profile('prod'))).toBe(true)
  })

  it('needs no Write Confirmation on a stg Connection Profile', () => {
    expect(requiresWriteConfirmation(profile('stg'))).toBe(false)
  })

  it('needs no Write Confirmation on a dev Connection Profile', () => {
    expect(requiresWriteConfirmation(profile('dev'))).toBe(false)
  })

  it('needs no Write Confirmation when the Environment is unset', () => {
    expect(requiresWriteConfirmation(profile())).toBe(false)
    expect(requiresWriteConfirmation({})).toBe(false)
  })

  it('needs no Write Confirmation when there is no Connection Profile', () => {
    expect(requiresWriteConfirmation(undefined)).toBe(false)
  })

  it('follows the Environment alone: a read-only or writable prod profile both require it', () => {
    const readOnlyProd = { environment: 'prod' as const, readOnly: true }
    const writableProd = { environment: 'prod' as const, readOnly: false }
    expect(requiresWriteConfirmation(readOnlyProd)).toBe(true)
    expect(requiresWriteConfirmation(writableProd)).toBe(true)
  })
})
