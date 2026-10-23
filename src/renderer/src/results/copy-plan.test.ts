import { describe, expect, it } from 'vitest'
import { copyScopeForShortcut, planCopy } from './copy-plan'

const options = { includeHeader: true, tableName: 'my_table' }
const rows = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
  { id: 3, name: 'c' }
]
const columns = ['id', 'name']

describe('copyScopeForShortcut', () => {
  it('copies the active cell for Cmd/Ctrl+C with no row selection', () => {
    expect(copyScopeForShortcut({ shift: false, selectedRowCount: 0 })).toBe('cell')
  })

  it('copies the selected rows for Cmd/Ctrl+C with rows selected', () => {
    expect(copyScopeForShortcut({ shift: false, selectedRowCount: 2 })).toBe('selected')
  })

  it('copies all loaded rows for Cmd/Ctrl+Shift+C, selection or not', () => {
    expect(copyScopeForShortcut({ shift: true, selectedRowCount: 0 })).toBe('all')
    expect(copyScopeForShortcut({ shift: true, selectedRowCount: 2 })).toBe('all')
  })
})

describe('planCopy', () => {
  it('copies a cell as its raw grid text regardless of the Active Extractor', () => {
    expect(planCopy({ scope: 'cell', value: { a: 1 } })).toEqual({
      text: '{"a":1}',
      message: 'Copied value',
      needsSizeConfirmation: false
    })
    expect(planCopy({ scope: 'cell', value: null }).text).toBe('NULL')
  })

  it('copies the given rows through the Extractor, in the given row order', () => {
    const plan = planCopy({
      scope: 'rows',
      rows: [rows[2], rows[0]],
      columns,
      extractorId: 'csv',
      options
    })
    expect(plan.text).toBe('id,name\n3,c\n1,a')
    expect(plan.message).toBe('Copied 2 rows as CSV')
    expect(plan.needsSizeConfirmation).toBe(false)
  })

  it('names a single row in the singular and formats large counts with separators', () => {
    const one = planCopy({ scope: 'rows', rows: [rows[0]], columns, extractorId: 'json', options })
    expect(one.message).toBe('Copied 1 row as JSON')
    const many = planCopy({
      scope: 'rows',
      rows: Array.from({ length: 1240 }, (_, i) => ({ id: i })),
      columns: ['id'],
      extractorId: 'csv',
      options
    })
    expect(many.message).toBe('Copied 1,240 rows as CSV')
  })

  it('asks for confirmation once the output reaches the size limit', () => {
    const request = { scope: 'rows' as const, rows, columns, extractorId: 'csv' as const, options }
    const text = 'id,name\n1,a\n2,b\n3,c'
    expect(planCopy(request, text.length + 1).needsSizeConfirmation).toBe(false)
    expect(planCopy(request, text.length).needsSizeConfirmation).toBe(true)
  })
})
