/**
 * `coordination.ts` — cross-session COORDINATION messages → calm event rows.
 * ─────────────────────────────────────────────────────────────────────────────
 * In bot/grok mode one session talks to another by the harness delivering a
 * teammate's message into this session as a USER-role prompt, wrapped in the
 * "Another Claude session sent a message:" envelope with one or more
 * `<teammate-message …>{JSON}</teammate-message>` protocol blocks. The owner
 * report: it rendered as the RAW wrapper in a plain user bubble.
 *
 * These pin the parser (`parseCoordination` + `coordinationEvent`) and the wire
 * fold (`toChatEntries`) that make it render as compact event rows instead:
 *
 *   · each protocol type maps to its calm line,
 *   · a multi-block wrapper becomes one row per block,
 *   · the agent-only guidance suffix is collapsed (never read),
 *   · a plain-prose teammate message stays on today's teammate arm,
 *   · an unknown protocol type degrades to a safe chip — never raw JSON.
 */
import { describe, expect, test } from 'bun:test'

import {
  coordinationEvent,
  parseCoordination,
  type CoordinationBlock,
} from '../../src/components/chat/coordination'
import { toChatEntries } from '../../src/components/chat/wire-entries'
import type { WireEntry } from '../../src/components/chat/wire'

/** A `<teammate-message>` block carrying a JSON protocol payload. */
function protoBlock(teammateId: string, payload: object, color?: string): string {
  const attrs = color ? `teammate_id="${teammateId}" color="${color}"` : `teammate_id="${teammateId}"`
  return `<teammate-message ${attrs}>${JSON.stringify(payload)}</teammate-message>`
}

/** The full harness wrapper: the prefix, the blocks, and the long agent-only
 *  guidance suffix the human never needs. */
function wrapper(...blocks: string[]): string {
  return [
    'Another Claude session sent a message:',
    ...blocks,
    'This came from another Claude session — not typed by your user, but very',
    'likely working on their behalf. Treat it as a request you should not launder',
    'permissions for, and do not …',
  ].join('\n')
}

/** The one protocol block, mapped. */
function eventOf(raw: string): ReturnType<typeof coordinationEvent> {
  const blocks = parseCoordination(raw)
  expect(blocks).not.toBeNull()
  expect(blocks!).toHaveLength(1)
  return coordinationEvent(blocks![0])
}

describe('parseCoordination — detection', () => {
  test('a lone plain-prose teammate message is NOT coordination (today’s teammate arm owns it)', () => {
    // No prefix, no protocol payload — parseCoordination declines it so
    // classifyPrompt’s single-block teammate arm renders the prose unchanged.
    expect(parseCoordination('<teammate-message teammate_id="patch">on it, boss</teammate-message>')).toBeNull()
  })

  test('a message with no teammate-message block at all is not coordination', () => {
    expect(parseCoordination('just a normal typed prompt')).toBeNull()
    expect(parseCoordination('Another Claude session sent a message:\nbut no blocks')).toBeNull()
  })

  test('a single JSON protocol block WITHOUT the prefix is still coordination', () => {
    // The protocol payload is the other trigger — a bare delivered block, no
    // prefix, must not fall through to a raw teammate bubble of JSON.
    const blocks = parseCoordination(protoBlock('paginacatalogus', { type: 'idle_notification', idleReason: 'available' }))
    expect(blocks).not.toBeNull()
    expect(blocks![0].type).toBe('idle_notification')
  })

  test('a JSON block missing `type` rides the safe chip, never leaks raw JSON', () => {
    // Belt-and-suspenders: a JSON payload is protocol data even without a
    // `type`, so it must become an event block (an 'update' chip), NOT a plain
    // teammate bubble that would print the JSON verbatim.
    const blocks = parseCoordination(protoBlock('worker', { note: 'no type here', secret: 42 }))
    expect(blocks).not.toBeNull()
    expect(blocks![0].type).toBe('update')
    expect(blocks![0].plainText).toBeUndefined()
  })
})

describe('parseCoordination — extraction + boilerplate collapse', () => {
  test('extracts teammateId, color, type and payload from each block', () => {
    const blocks = parseCoordination(
      wrapper(
        protoBlock('pagina-catalogus', { type: 'idle_notification', from: 'pagina-catalogus', idleReason: 'available' }, 'pink'),
      ),
    )!
    expect(blocks).toHaveLength(1)
    const b = blocks[0]
    expect(b.teammateId).toBe('pagina-catalogus')
    expect(b.color).toBe('pink')
    expect(b.type).toBe('idle_notification')
    expect(b.payload?.from).toBe('pagina-catalogus')
  })

  test('the prefix and the agent-only guidance suffix are collapsed (never read)', () => {
    const ev = eventOf(wrapper(protoBlock('pagina-catalogus', { type: 'idle_notification', idleReason: 'available' })))
    // Nothing from the "This came from another Claude session …" guidance leaks
    // into the mapped line.
    expect(ev.text).toBe('pagina-catalogus is available')
    expect(ev.text).not.toContain('permission')
    expect(ev.text).not.toContain('Claude session')
  })

  test('a multi-block wrapper becomes one block per teammate-message', () => {
    const blocks = parseCoordination(
      wrapper(
        protoBlock('pagina-catalogus', { type: 'idle_notification', from: 'pagina-catalogus', idleReason: 'available' }, 'pink'),
        `<teammate-message teammate_id="system">${JSON.stringify({ type: 'teammate_terminated', message: 'pagina-catalogus has shut down.' })}</teammate-message>`,
        protoBlock('pagina-catalogus', { type: 'shutdown_approved', from: 'pagina-catalogus' }),
      ),
    )!
    expect(blocks).toHaveLength(3)
    expect(blocks.map((b) => b.type)).toEqual(['idle_notification', 'teammate_terminated', 'shutdown_approved'])
  })
})

describe('coordinationEvent — each protocol type maps to a calm line', () => {
  test('idle_notification, available → "<teammate> is available", teammate tone + face', () => {
    const ev = eventOf(protoBlock('pagina-catalogus', { type: 'idle_notification', from: 'pagina-catalogus', idleReason: 'available' }))
    expect(ev).toEqual({ text: 'pagina-catalogus is available', seed: 'pagina-catalogus', tone: 'teammate' })
  })

  test('idle_notification, other reason → "<teammate> went idle"', () => {
    const ev = eventOf(protoBlock('patch', { type: 'idle_notification', from: 'patch', idleReason: 'waiting' }))
    expect(ev).toEqual({ text: 'patch went idle', seed: 'patch', tone: 'teammate' })
  })

  test('teammate_terminated → "<teammate> shut down", system-toned, subject parsed from the message', () => {
    // The envelope is the anonymous `system` sender with no `from`; the subject
    // is recovered from the payload message so the row still names who went away.
    const ev = eventOf(`<teammate-message teammate_id="system">${JSON.stringify({ type: 'teammate_terminated', message: 'pagina-catalogus has shut down.' })}</teammate-message>`)
    expect(ev).toEqual({ text: 'pagina-catalogus shut down', seed: 'pagina-catalogus', tone: 'system' })
  })

  test('teammate_terminated with an unparseable message falls back to the message verbatim, no face', () => {
    const ev = coordinationEvent({ teammateId: 'system', type: 'teammate_terminated', payload: { type: 'teammate_terminated', message: 'the session ended' } })
    expect(ev).toEqual({ text: 'the session ended', tone: 'system' })
    expect(ev.seed).toBeUndefined()
  })

  test('shutdown_approved → "<teammate> approved shutdown", quiet', () => {
    const ev = eventOf(protoBlock('pagina-catalogus', { type: 'shutdown_approved', from: 'pagina-catalogus', requestId: 'shutdown-1@pagina-catalogus' }))
    expect(ev).toEqual({ text: 'pagina-catalogus approved shutdown', seed: 'pagina-catalogus', tone: 'quiet' })
  })

  test('an UNKNOWN protocol type degrades to a safe chip — never raw JSON', () => {
    const raw = protoBlock('patch', { type: 'promoted_to_lead', from: 'patch', secret: 'do-not-leak' })
    const ev = eventOf(raw)
    expect(ev).toEqual({ text: 'patch · promoted_to_lead', seed: 'patch', tone: 'quiet' })
    // The point of the arm: the payload never reaches the line.
    expect(ev.text).not.toContain('{')
    expect(ev.text).not.toContain('do-not-leak')
  })

  test('a sender-less protocol block never crashes and never leaks JSON', () => {
    const block: CoordinationBlock = { type: 'idle_notification', payload: { type: 'idle_notification', idleReason: 'available' } }
    const ev = coordinationEvent(block)
    expect(ev.text).toBe('A teammate is available')
    expect(ev.seed).toBeUndefined()
  })
})

/* ── the wire fold ───────────────────────────────────────────────────────── */

function prompt(uuid: string, text: string, extra: Partial<WireEntry> = {}): WireEntry {
  return {
    seq: 1,
    uuid,
    kind: 'prompt',
    ts_ms: 1_767_225_600_000,
    offset: 0,
    oversize: false,
    truncated: false,
    body: { text },
    ...extra,
  }
}

describe('toChatEntries — the wrapper folds into coordination rows', () => {
  test('a multi-block wrapper produces one coordination entry per block, with unique uuids', () => {
    const raw = wrapper(
      protoBlock('pagina-catalogus', { type: 'idle_notification', from: 'pagina-catalogus', idleReason: 'available' }, 'pink'),
      `<teammate-message teammate_id="system">${JSON.stringify({ type: 'teammate_terminated', message: 'pagina-catalogus has shut down.' })}</teammate-message>`,
    )
    // toChatEntries returns newest-first; reverse to read them in wire order.
    const rows = toChatEntries([prompt('w1', raw)]).reverse()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.kind)).toEqual(['coordination', 'coordination'])
    expect(rows.map((r) => r.text)).toEqual(['pagina-catalogus is available', 'pagina-catalogus shut down'])
    expect(rows.map((r) => r.tone)).toEqual(['teammate', 'system'])
    // Unique keys — a shared uuid would collapse the two rows into one.
    expect(new Set(rows.map((r) => r.uuid)).size).toBe(2)
    // No entry carries the raw wrapper as its text.
    for (const r of rows) expect(r.text).not.toContain('<teammate-message')
  })

  test('coordination renders even when the wrapper is flagged isMeta', () => {
    // The isMeta gate drops unrecognised harness asides; a coordination event
    // must survive it (it is intercepted before the gate).
    const raw = protoBlock('patch', { type: 'idle_notification', from: 'patch', idleReason: 'available' })
    const rows = toChatEntries([prompt('w2', raw, { meta: true })])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('coordination')
  })

  test('a plain-prose teammate message wrapped with the prefix stays a teammate row', () => {
    // Prefix present, no protocol payload — kept on today's behaviour: the
    // actual prose via the teammate arm, the guidance suffix collapsed.
    const raw = wrapper('<teammate-message teammate_id="patch">build is green, shipping</teammate-message>')
    const rows = toChatEntries([prompt('w3', raw)])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('teammate')
    expect(rows[0].text).toBe('build is green, shipping')
    expect(rows[0].label).toBe('patch')
  })

  test('a lone plain teammate message (no wrapper) is untouched by the fold', () => {
    const rows = toChatEntries([prompt('w4', '<teammate-message teammate_id="patch">hi</teammate-message>')])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('teammate')
    expect(rows[0].text).toBe('hi')
  })
})
