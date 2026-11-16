import { describe, expect, it } from 'vitest'
import type { ConnectionEnvironment } from '@shared/types/connection-profile'
import {
  matchesTypedDmlConfirmation,
  requiresWriteConfirmation,
  typedDmlConfirmation
} from './write-confirmation'

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

describe('typed DML Write Confirmation on prod', () => {
  it('asks for the verb and the document count', () => {
    expect(typedDmlConfirmation('DELETE', 1840)).toBe('DELETE 1840')
    expect(typedDmlConfirmation('UPDATE', 3)).toBe('UPDATE 3')
  })

  it('accepts the verb and count as asked', () => {
    expect(matchesTypedDmlConfirmation('DELETE 1840', 'DELETE', 1840)).toBe(true)
  })

  it('accepts the verb in any case', () => {
    expect(matchesTypedDmlConfirmation('delete 1840', 'DELETE', 1840)).toBe(true)
    expect(matchesTypedDmlConfirmation('Update 12', 'UPDATE', 12)).toBe(true)
  })

  it('tolerates surrounding and repeated spaces', () => {
    expect(matchesTypedDmlConfirmation('  DELETE   1840 ', 'DELETE', 1840)).toBe(true)
  })

  it('refuses a different count, so a WHERE that matches more than meant is noticed', () => {
    expect(matchesTypedDmlConfirmation('DELETE 184', 'DELETE', 1840)).toBe(false)
    expect(matchesTypedDmlConfirmation('DELETE 18400', 'DELETE', 1840)).toBe(false)
    expect(matchesTypedDmlConfirmation('DELETE 01840', 'DELETE', 1840)).toBe(false)
  })

  it('refuses the other verb, the count alone or the verb alone', () => {
    expect(matchesTypedDmlConfirmation('UPDATE 1840', 'DELETE', 1840)).toBe(false)
    expect(matchesTypedDmlConfirmation('1840', 'DELETE', 1840)).toBe(false)
    expect(matchesTypedDmlConfirmation('DELETE', 'DELETE', 1840)).toBe(false)
    expect(matchesTypedDmlConfirmation('', 'DELETE', 1840)).toBe(false)
  })

  it('refuses the count written with separators, which is not what was asked', () => {
    expect(matchesTypedDmlConfirmation('DELETE 1,840', 'DELETE', 1840)).toBe(false)
  })

  it('refuses extra words around the confirmation', () => {
    expect(matchesTypedDmlConfirmation('DELETE 1840 now', 'DELETE', 1840)).toBe(false)
    expect(matchesTypedDmlConfirmation('yes DELETE 1840', 'DELETE', 1840)).toBe(false)
  })
})
