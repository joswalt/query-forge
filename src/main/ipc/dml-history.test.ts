import { describe, expect, it } from 'vitest'
import type { DmlCommitSummary, WriteOutcome } from '@shared/types/dml-run'
import {
  commitEndedHistoryInput,
  planningEndedHistoryInput,
  type DmlRunTarget,
  type PlannedDmlRun
} from './dml-history'

const noOutcomes: Record<WriteOutcome, number> = {
  written: 0,
  unchanged: 0,
  'concurrent-change': 0,
  'not-found': 0,
  'expression-undefined': 0,
  failed: 0,
  'not-attempted': 0
}

const plannedRun: PlannedDmlRun = {
  profileId: 'profile-1',
  statement: "DELETE FROM c WHERE c.status = 'old'",
  databaseName: 'shop',
  containerName: 'orders',
  verb: 'DELETE',
  matchCount: 1_840,
  drivingQueryRequestCharge: 12,
  planningDurationMs: 400
}

const context = { profileName: 'Shop (prod)', persistQueryText: false }

function summary(
  counts: Partial<Record<WriteOutcome, number>>,
  cancelled = false
): DmlCommitSummary {
  return {
    verb: 'DELETE',
    counts: { ...noOutcomes, ...counts },
    drivingQueryRequestCharge: 12,
    writeRequestCharge: 400,
    durationMs: 2_000,
    cancelled
  }
}

const commitTimes = { startedAt: 10_000, finishedAt: 12_000 }

describe('commitEndedHistoryInput', () => {
  it('records partial when a commit ran to the end with a Concurrent Change', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary({ written: 1_837, 'concurrent-change': 3 }) },
      commitTimes,
      context
    )

    expect(input.status).toBe('partial')
  })

  it.each([
    ['not-found', { written: 1_839, 'not-found': 1 }],
    ['expression-undefined', { written: 1_839, 'expression-undefined': 1 }],
    ['failed', { written: 1_839, failed: 1 }]
  ] as const)('records partial when a document ended %s', (_outcome, counts) => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary(counts) },
      commitTimes,
      context
    )

    expect(input.status).toBe('partial')
  })

  it('records success when every document ended written or unchanged', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary({ written: 1_800, unchanged: 40 }) },
      commitTimes,
      context
    )

    expect(input.status).toBe('success')
  })

  it('records cancelled for a stopped commit, even with unwritten documents', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      {
        kind: 'ended',
        summary: summary({ written: 100, failed: 2, 'not-attempted': 1_738 }, true)
      },
      commitTimes,
      context
    )

    expect(input.status).toBe('cancelled')
  })

  it('records error with its message when the commit could not run', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'failed', wasCancelled: false, message: 'This connection is read-only.' },
      commitTimes,
      context
    )

    expect(input.status).toBe('error')
    expect(input.errorMessage).toBe('This connection is read-only.')
  })

  it('records cancelled without a message when a commit asked to stop failed', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'failed', wasCancelled: true, message: 'Aborted' },
      commitTimes,
      context
    )

    expect(input.status).toBe('cancelled')
    expect(input.errorMessage).toBeUndefined()
  })

  it('withholds the statement text unless Preferences opted in', () => {
    const ending = { kind: 'ended' as const, summary: summary({ written: 1_840 }) }

    expect(commitEndedHistoryInput(plannedRun, ending, commitTimes, context).queryText).toBe(
      undefined
    )
    expect(
      commitEndedHistoryInput(plannedRun, ending, commitTimes, {
        ...context,
        persistQueryText: true
      }).queryText
    ).toBe("DELETE FROM c WHERE c.status = 'old'")
  })

  it('records the documents matched as the row count, even for a stopped commit', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary({ written: 10, 'not-attempted': 1_830 }, true) },
      commitTimes,
      context
    )

    expect(input.rowCount).toBe(1_840)
  })

  it('times the run as planning plus commit, leaving out the wait at the confirmation', () => {
    // Planning took 400 ms; the user then sat at the confirmation before
    // the commit started at 10,000 and ended at 12,000.
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary({ written: 1_840 }) },
      { startedAt: 10_000, finishedAt: 12_000 },
      context
    )

    expect(input.durationMs).toBe(2_400)
    expect(input.executedAt).toBe(new Date(10_000).toISOString())
  })

  it('keeps verb, target, Write Outcome counts and total RU with the text withheld', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary({ written: 1_837, 'concurrent-change': 3 }) },
      commitTimes,
      context
    )

    expect(input.dml).toEqual({
      verb: 'DELETE',
      databaseName: 'shop',
      containerName: 'orders',
      counts: { ...noOutcomes, written: 1_837, 'concurrent-change': 3 },
      totalRequestCharge: 412,
      retry: false
    })
  })

  it('keeps the counts and RU reported so far when a commit failed midway', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      {
        kind: 'failed',
        wasCancelled: false,
        message: 'The Query Execution Service stopped',
        progress: {
          completed: 5,
          total: 1_840,
          requestCharge: 50,
          counts: { ...noOutcomes, written: 5 }
        }
      },
      commitTimes,
      context
    )

    expect(input.dml?.counts).toEqual({ ...noOutcomes, written: 5 })
    expect(input.dml?.totalRequestCharge).toBe(62)
  })

  it('records zero counts and the Driving Query RU when the commit never reported', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'failed', wasCancelled: false, message: 'This connection is read-only.' },
      commitTimes,
      context
    )

    expect(input.dml?.counts).toEqual(noOutcomes)
    expect(input.dml?.totalRequestCharge).toBe(12)
  })

  it('carries the Retry marker', () => {
    const input = commitEndedHistoryInput(
      { ...plannedRun, retry: true },
      { kind: 'ended', summary: summary({ written: 3 }) },
      commitTimes,
      context
    )

    expect(input.dml?.retry).toBe(true)
  })

  it('falls back to a placeholder profile name when the profile is gone', () => {
    const input = commitEndedHistoryInput(
      plannedRun,
      { kind: 'ended', summary: summary({ written: 1_840 }) },
      commitTimes,
      { ...context, profileName: undefined }
    )

    expect(input.profileName).toBe('(deleted connection)')
  })
})

describe('planningEndedHistoryInput', () => {
  const run: DmlRunTarget = {
    profileId: 'profile-1',
    statement: "UPDATE c SET c.flag = true WHERE c.kind = 'x'",
    databaseName: 'shop',
    containerName: 'orders'
  }
  const planningTimes = { startedAt: 5_000, finishedAt: 5_300 }

  it('records error with its message when planning failed, keeping the verb from the statement', () => {
    const input = planningEndedHistoryInput(
      run,
      {
        kind: 'failed',
        wasCancelled: false,
        message: 'More than 50,000 documents match.',
        progress: { matched: 50_001, requestCharge: 830 }
      },
      planningTimes,
      context
    )

    expect(input).toEqual({
      profileId: 'profile-1',
      profileName: 'Shop (prod)',
      queryText: undefined,
      status: 'error',
      durationMs: 300,
      rowCount: undefined,
      errorMessage: 'More than 50,000 documents match.',
      executedAt: new Date(5_000).toISOString(),
      dml: {
        verb: 'UPDATE',
        databaseName: 'shop',
        containerName: 'orders',
        counts: noOutcomes,
        totalRequestCharge: 830,
        retry: false
      }
    })
  })

  it('records cancelled without a message when planning was cancelled', () => {
    const input = planningEndedHistoryInput(
      run,
      { kind: 'failed', wasCancelled: true, message: 'Aborted' },
      planningTimes,
      context
    )

    expect(input.status).toBe('cancelled')
    expect(input.errorMessage).toBeUndefined()
    expect(input.dml?.totalRequestCharge).toBe(0)
  })

  it('records success with no documents matched when the Driving Query found nothing', () => {
    const input = planningEndedHistoryInput(
      run,
      { kind: 'no-matches', verb: 'UPDATE', drivingQueryRequestCharge: 2.8 },
      planningTimes,
      context
    )

    expect(input.status).toBe('success')
    expect(input.rowCount).toBe(0)
    expect(input.dml?.counts).toEqual(noOutcomes)
    expect(input.dml?.totalRequestCharge).toBe(2.8)
  })

  it('withholds the statement text unless Preferences opted in', () => {
    const ending = { kind: 'failed' as const, wasCancelled: false, message: 'Missing WHERE' }

    expect(planningEndedHistoryInput(run, ending, planningTimes, context).queryText).toBe(undefined)
    expect(
      planningEndedHistoryInput(run, ending, planningTimes, { ...context, persistQueryText: true })
        .queryText
    ).toBe("UPDATE c SET c.flag = true WHERE c.kind = 'x'")
  })

  it('records a Retry whose planning failed with the Retry marker and the original statement', () => {
    const input = planningEndedHistoryInput(
      { ...run, retry: true },
      { kind: 'failed', wasCancelled: false, message: 'Request rate is large' },
      planningTimes,
      { ...context, persistQueryText: true }
    )

    expect(input.status).toBe('error')
    expect(input.queryText).toBe("UPDATE c SET c.flag = true WHERE c.kind = 'x'")
    expect(input.dml?.retry).toBe(true)
  })

  it('keeps the Retry marker with the statement text withheld', () => {
    const input = planningEndedHistoryInput(
      { ...run, retry: true },
      { kind: 'no-matches', verb: 'UPDATE', drivingQueryRequestCharge: 2.5 },
      planningTimes,
      context
    )

    expect(input.queryText).toBe(undefined)
    expect(input.dml?.retry).toBe(true)
  })
})
