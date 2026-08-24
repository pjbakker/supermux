/**
 * The cadence-honesty contract.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS SUITE EXISTS FOR: "whenever i feel like it" validated. It wore
 * the green check, rendered as "Custom schedule", was given a next-fire time,
 * and left Save enabled — so the user's next action was a 400 from a server
 * that had never agreed to any of it.
 *
 * Two independent causes, both of the same shape — a SHAPE test standing in for
 * a GRAMMAR test:
 *
 *   1. the cron arm was `expr.split(/\s+/).length === 5`, i.e. "any five
 *      words". Five words is not a cron;
 *   2. the named-time arms tested their regex and never read the time inside
 *      it, so "every weekday at potato" matched `RE_WEEKDAY` and passed.
 *
 * And one design fault behind both: the client was making the promise at all.
 * The green check and the next-fire list assert that a schedule is REAL, which
 * only `parser.rs` can know — it owns the grammar, the host timezone and the
 * DST walk. So the promise now waits for the server, and the local validators
 * only decide what is worth sending.
 */
import { describe, expect, test } from 'bun:test'

import {
  describeSchedule,
  isCadenceExpr,
  isCronExpr,
  normalizeCadence,
} from '../../src/components/workflows/cadence'
import {
  CADENCE_IDLE,
  cadenceCheck,
  cadenceProblem,
} from '../../src/components/workflows/use-cadence-preview'
import {
  draftProblem,
  emptyDraft,
  type ComposerDraft,
} from '../../src/components/workflows/workflow-composer'
import { newStep } from '../../src/components/workflows/step-card'

const GIBBERISH = [
  'whenever i feel like it',
  'a b c d e',
  'sometimes',
  'when the mood strikes',
  'every blue moon',
  'ask me later ok thanks',
  'every weekday at potato',
  'daily at bananas',
  'weekly on someday at noon',
  'monthly on 44 at 9am',
  'in 5 potatoes',
  'every 3 fortnights',
  '99 99 * * *',
  '0 9 * * xyz',
  '* * * *',
  '* * * * * *',
]

const REAL = [
  'every weekday at 9am',
  'every weekday at 09:00',
  'daily at 18:00',
  'daily at 6pm',
  'daily at 9:30pm',
  'weekly on mon at 17:00',
  'every monday at 9:00',
  'monthly on 3 at 7am',
  'every 2h',
  'every 30m',
  'in 45m',
  'every morning',
  '0 9 * * 1-5',
  '*/15 * * * *',
  '0 9 1,15 * *',
  '30 8 * * mon-fri',
]

describe('gibberish does not validate — the five-word cron hole', () => {
  test.each(GIBBERISH)('%p is not a cadence', (junk) => {
    expect(isCadenceExpr(junk)).toBe(false)
    expect(normalizeCadence(junk)).toBeNull()
  })

  test('five words is not a cron', () => {
    // The exact input the review found, and the exact reason it passed.
    expect('whenever i feel like it'.split(/\s+/)).toHaveLength(5)
    expect(isCronExpr('whenever i feel like it')).toBe(false)
    expect(isCadenceExpr('whenever i feel like it')).toBe(false)
  })

  test('gibberish is never labelled "Custom schedule"', () => {
    for (const junk of GIBBERISH) expect(describeSchedule(junk)).not.toBe('Custom schedule')
  })

  test('a matching SHAPE with an unreadable time does not pass', () => {
    // Each of these matches its regex and fails its payload.
    expect(isCadenceExpr('every weekday at potato')).toBe(false)
    expect(isCadenceExpr('daily at bananas')).toBe(false)
    expect(isCadenceExpr('weekly on mon at half past')).toBe(false)
    expect(isCadenceExpr('every monday at teatime')).toBe(false)
    expect(isCadenceExpr('monthly on 3 at soon')).toBe(false)
    expect(isCadenceExpr('in 5 potatoes')).toBe(false)
    expect(isCadenceExpr('every 3 fortnights')).toBe(false)
  })

  test('out-of-range cron fields are refused field by field', () => {
    expect(isCronExpr('0 9 * * 1-5')).toBe(true)
    expect(isCronExpr('60 9 * * *')).toBe(false) // minute 0-59
    expect(isCronExpr('0 24 * * *')).toBe(false) // hour 0-23
    expect(isCronExpr('0 9 32 * *')).toBe(false) // day-of-month 1-31
    expect(isCronExpr('0 9 * 13 *')).toBe(false) // month 1-12
    expect(isCronExpr('0 9 * * 8')).toBe(false) // day-of-week 0-7
    expect(isCronExpr('0 9 * * mon-fri')).toBe(true) // names pass through
    expect(isCronExpr('0 9 * jan *')).toBe(true)
    expect(isCronExpr('*/15 * * * *')).toBe(true)
    expect(isCronExpr('0 9 * * */2')).toBe(true)
    expect(isCronExpr('0 9 * * 1-')).toBe(false)
    expect(isCronExpr('0 9 * * 1/')).toBe(false)
  })
})

describe('the advertised examples parse — the hint must not lie either', () => {
  test.each(REAL)('%p is a cadence', (expr) => {
    expect(isCadenceExpr(expr)).toBe(true)
    expect(normalizeCadence(expr)).not.toBeNull()
  })

  test('every clock format the grammar supports is read, not just 24h', () => {
    // parser.rs::parse_time accepts HH:MM, 9am, 6pm, 9:30pm.
    expect(describeSchedule('every weekday at 9am')).toBe('Every weekday at 09:00')
    expect(describeSchedule('daily at 6pm')).toBe('Daily at 18:00')
    expect(describeSchedule('daily at 9:30pm')).toBe('Daily at 21:30')
    expect(describeSchedule('daily at 12am')).toBe('Daily at 00:00')
    expect(describeSchedule('daily at 12pm')).toBe('Daily at 12:00')
    expect(describeSchedule('weekly on mon at 17:00')).toBe('Every Monday at 17:00')
  })

  test('a real cron IS "Custom schedule" — the fallback still has a job', () => {
    expect(describeSchedule('0 9 * * 1-5')).toBe('Custom schedule')
  })
})

describe('the promise waits for the server', () => {
  const snap = (over: Record<string, unknown> = {}) => ({
    expr: 'daily at 9:00',
    runs: ['2026-08-25T09:00:00Z'],
    error: null,
    unreachable: false,
    ...over,
  })

  test('a fresh answer with fire times is the ONLY "ok"', () => {
    expect(cadenceCheck('daily at 9:00', snap()).status).toBe('ok')
    expect(cadenceCheck('daily at 9:00', snap()).runs).toHaveLength(1)
  })

  test('an answer to a DIFFERENT expression is still "checking", not "ok"', () => {
    // The stale-preview lie: the previous cadence's fire times must never sit
    // under a newly typed one.
    const c = cadenceCheck('daily at 10:00', snap())
    expect(c.status).toBe('checking')
    expect(c.runs).toEqual([])
  })

  test('a server refusal is "rejected", and carries the server’s own sentence', () => {
    const c = cadenceCheck('nope', snap({ expr: 'nope', runs: [], error: 'unknown unit' }))
    expect(c.status).toBe('rejected')
    expect(c.error).toBe('unknown unit')
    expect(c.runs).toEqual([])
  })

  test('an expression that parses but never fires is still not a schedule', () => {
    expect(cadenceCheck('0 9 30 2 *', snap({ expr: '0 9 30 2 *', runs: [] })).status).toBe('rejected')
  })

  test('an UNREACHABLE server is our problem, not the user’s — it must not block', () => {
    const c = cadenceCheck('daily at 9:00', snap({ runs: [], error: 'x', unreachable: true }))
    expect(c.status).toBe('unverified')
    expect(cadenceProblem(c)).toBeNull()
  })

  test('nothing to check is idle, and idle never blocks', () => {
    expect(cadenceCheck(null, snap()).status).toBe('idle')
    expect(cadenceProblem(CADENCE_IDLE)).toBeNull()
  })

  test('checking and rejected both block, each with its own sentence', () => {
    expect(cadenceProblem({ status: 'checking', runs: [], error: null })).toBe(
      'Working out when that runs…',
    )
    expect(cadenceProblem({ status: 'rejected', runs: [], error: 'bad cron' })).toBe('bad cron')
  })
})

describe('Save is disabled for a cadence nobody agreed to', () => {
  const draft = (over: Partial<ComposerDraft> = {}): ComposerDraft => ({
    ...emptyDraft('scout'),
    steps: [newStep({ text: 'Pull the numbers' })],
    ...over,
  })
  const ok = { status: 'ok' as const, runs: ['2026-08-25T09:00:00Z'], error: null }

  test('gibberish blocks Save, and says it was not understood', () => {
    // The picker hands up expr:'' with the raw text, which is how the footer
    // can tell "you have not answered" from "I could not read your answer".
    const d = draft({ trigger: { kind: 'recurring', expr: '', text: 'whenever i feel like it' } })
    expect(draftProblem(d, false, undefined, CADENCE_IDLE)).toBe(
      'Couldn’t understand that — try “every weekday at 9am”',
    )
  })

  test('an untouched field asks the question instead of blaming the user', () => {
    const d = draft({ trigger: { kind: 'recurring', expr: '', text: '' } })
    expect(draftProblem(d, false, undefined, CADENCE_IDLE)).toBe('Say how often it runs')
  })

  test('a locally-valid cadence still waits for the server before Save opens', () => {
    const d = draft({ trigger: { kind: 'recurring', expr: 'daily at 9:00', text: 'daily at 9:00' } })
    expect(draftProblem(d, false, undefined, { status: 'checking', runs: [], error: null })).toBe(
      'Working out when that runs…',
    )
    expect(draftProblem(d, false, undefined, ok)).toBeNull()
  })

  test('a server-rejected cadence blocks with the server’s reason', () => {
    const d = draft({ trigger: { kind: 'recurring', expr: '0 9 * * 9', text: '0 9 * * 9' } })
    expect(
      draftProblem(d, false, undefined, { status: 'rejected', runs: [], error: 'bad cron' }),
    ).toBe('bad cron')
  })

  test('a preview outage does not hold the user hostage', () => {
    const d = draft({ trigger: { kind: 'recurring', expr: 'daily at 9:00', text: 'daily at 9:00' } })
    expect(
      draftProblem(d, false, undefined, { status: 'unverified', runs: [], error: null }),
    ).toBeNull()
  })

  test('a manual workflow never waits on a cadence check at all', () => {
    const d = draft({ trigger: { kind: 'manual', expr: '', text: '' } })
    expect(draftProblem(d, false, undefined, { status: 'checking', runs: [], error: null })).toBeNull()
  })
})
