/**
 * `nudges.ts` — the routing-fold that turns a Router's one-tag-per-bot rows into
 * a single "Nudged @a @b" line. Every case is a rule that would be invisible in
 * review and obvious in use.
 */
import { describe, expect, test } from 'bun:test'

import { collapseNudges, unreadAnchor } from '../../src/components/chat/group-chat/nudges'
import type { GroupChatRow } from '../../src/components/chat/group-chat/types'

const routed = (seq: number, ts: number, tag: string, seed = 'acme-assistant'): GroupChatRow => ({
  seq,
  ts,
  kind: 'routed',
  authorKind: 'router',
  authorSeed: seed,
  authorName: 'Assistant',
  body: 'do the thing',
  tags: [tag],
})
const reply = (seq: number, ts: number, seed: string): GroupChatRow => ({
  seq,
  ts,
  kind: 'reply',
  authorKind: 'bot',
  authorSeed: seed,
  authorName: seed,
  body: 'done',
})

const tagsOf = (rows: GroupChatRow[]) => rows.map((r) => r.tags ?? [])

describe('collapseNudges', () => {
  test('a Router turn that tags two bots folds to ONE row, chips behind each other', () => {
    const out = collapseNudges([routed(1, 100, 'ada'), routed(2, 100, 'max')])
    expect(out).toHaveLength(1)
    expect(out[0].tags).toEqual(['ada', 'max'])
    // The first row's seq is the stable React key; the latest ts keeps the pulse.
    expect(out[0].seq).toBe(1)
    expect(out[0].ts).toBe(100)
  })

  test('three tags across a few seconds still make one line, in tag order', () => {
    const out = collapseNudges([routed(1, 100, 'ada'), routed(2, 101, 'max'), routed(3, 103, 'sam')])
    expect(out).toHaveLength(1)
    expect(out[0].tags).toEqual(['ada', 'max', 'sam'])
    expect(out[0].ts).toBe(103) // latest ts wins
  })

  test('a bot reply between two nudges breaks the run — two separate lines', () => {
    const out = collapseNudges([routed(1, 100, 'ada'), reply(2, 101, 'ada'), routed(3, 102, 'max')])
    expect(out.map((r) => r.kind)).toEqual(['routed', 'reply', 'routed'])
    expect(tagsOf(out.filter((r) => r.kind === 'routed'))).toEqual([['ada'], ['max']])
  })

  test('two DIFFERENT routers never fold into each other', () => {
    const out = collapseNudges([routed(1, 100, 'ada', 'acme-assistant'), routed(2, 101, 'max', 'globex-assistant')])
    expect(out).toHaveLength(2)
  })

  test('a duplicate tag in the same turn is de-duped, not doubled', () => {
    const out = collapseNudges([routed(1, 100, 'ada'), routed(2, 100, 'Ada')])
    expect(out).toHaveLength(1)
    expect(out[0].tags).toEqual(['ada']) // case-insensitive union keeps the first spelling
  })

  test('a nudge beyond the grouping window stands on its own', () => {
    const out = collapseNudges([routed(1, 100, 'ada'), routed(2, 100 + 301, 'max')])
    expect(out).toHaveLength(2)
  })

  test('it never mutates its input', () => {
    const input = [routed(1, 100, 'ada'), routed(2, 100, 'max')]
    const before = JSON.stringify(input)
    collapseNudges(input)
    expect(JSON.stringify(input)).toBe(before)
  })

  test('an empty feed is the identity', () => {
    expect(collapseNudges([])).toEqual([])
  })
})

describe('unreadAnchor — the "New" line survives the fold', () => {
  test('a boundary INSIDE a folded run lands on the row that absorbed it', () => {
    // The reader was at the bottom when nudge seq 10 landed (read up to 10), then
    // scrolled up while seq 11 of the same turn arrived. 11 folds into 10, so
    // matching the raw anchor against the display list would draw NO divider.
    const display = collapseNudges([routed(10, 100, 'ada'), routed(11, 101, 'max')])
    expect(display.map((r) => r.seq)).toEqual([10])
    expect(unreadAnchor(display, 11)).toBe(10)
  })

  test('a boundary at the head of a run is that row, unchanged', () => {
    const display = collapseNudges([reply(9, 99, 'ada'), routed(10, 100, 'ada'), routed(11, 101, 'max')])
    expect(unreadAnchor(display, 10)).toBe(10)
  })

  test('a fully-read feed draws no line', () => {
    expect(unreadAnchor(collapseNudges([routed(1, 100, 'ada')]), null)).toBeNull()
  })

  test('an empty feed has no anchor', () => {
    expect(unreadAnchor([], 5)).toBeNull()
  })
})
