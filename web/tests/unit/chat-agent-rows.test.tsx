/**
 * The working row's agent list — subagent visibility, pinned.
 * ─────────────────────────────────────────────────────────────────────────────
 * During a fan-out this surface used to show a spinner, `· N subagents` and
 * nothing else, while the terminal showed the work — and the number came from a
 * count that a lost `SubagentStop` can pin at a session with no children left.
 * The replacement is a list of rows the server has FIRST-HAND evidence of, and
 * what has to hold for it to be an improvement rather than a second ghost:
 *
 *   · no rows ⇒ no clause, no control, no list. Silence is the honest default,
 *     and it is what a session whose count is stale now gets.
 *   · collapsed by default, and the clause IS the control (`aria-expanded`).
 *   · a quiet row states the FACT and never a verdict.
 *   · the cap is a count, not thirty rows nobody reads.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AGENT_QUIET_AFTER_MS,
  AGENT_ROWS_SHOWN,
  agentName,
  isQuiet,
  nextQuietAtMs,
  quietLabel,
} from '../../src/components/chat/agent-rows'
import { serverNowMs } from '../../src/components/chat/latency'
import { WorkingRow, toListRow } from '../../src/components/chat/working-row'
import { AgentList } from '../../src/components/chat/ui'
import type { AgentRow } from '../../src/lib/api/sessions'

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

function agent(over: Partial<AgentRow> & { id: string }): AgentRow {
  const now = serverNowMs()
  return { type: 'general-purpose', started_ms: now - 12_000, last_evidence_ms: now - 900, ...over }
}

const rows = (n: number, over: Partial<AgentRow> = {}) =>
  Array.from({ length: n }, (_, i) => agent({ id: `a${i}`, ...over }))

const row = (over: Partial<AgentRow> = {}) =>
  renderToStaticMarkup(
    <WorkingRow name="release-train" activity="⚡ cargo test" turnStartMs={serverNowMs() - 12_000} {...over} />,
  )

describe('the quiet ladder', () => {
  test('a row is live inside the window and quiet outside it', () => {
    const now = 1_756_000_000_000
    expect(isQuiet({ last_evidence_ms: now }, now)).toBe(false)
    expect(isQuiet({ last_evidence_ms: now - AGENT_QUIET_AFTER_MS + 1 }, now)).toBe(false)
    expect(isQuiet({ last_evidence_ms: now - AGENT_QUIET_AFTER_MS }, now)).toBe(true)
  })

  test('the dim is an EDGE the client can schedule, not a fact it waits for', () => {
    // The whole reason the wire carries stamps: in the case this ladder exists
    // for — every child silent inside a long `Bash` — no hook fires, so no delta
    // arrives, so a server-computed staleness could never be refreshed and the
    // row would keep a filled dot forever. The client has to know WHEN to look
    // again, and it must be a single edge rather than a per-second tick.
    const now = 1_756_000_000_000
    const soon = { last_evidence_ms: now - 10_000 }
    const later = { last_evidence_ms: now - 1_000 }
    expect(nextQuietAtMs([later, soon], now)).toBe(soon.last_evidence_ms + AGENT_QUIET_AFTER_MS)
    // Stable while the clock sits inside the interval — that is what keeps the
    // timer armed once per transition instead of re-armed on every render.
    expect(nextQuietAtMs([later, soon], now + 5_000)).toBe(soon.last_evidence_ms + AGENT_QUIET_AFTER_MS)
    // Nothing left to schedule once every row has already gone quiet.
    expect(nextQuietAtMs([{ last_evidence_ms: now - AGENT_QUIET_AFTER_MS }], now)).toBe(null)
    expect(nextQuietAtMs([], now)).toBe(null)
  })

  test('a quiet row states the fact and never a verdict', () => {
    expect(quietLabel(180_000)).toBe('no tool call for 3m')
    expect(quietLabel(599_000)).toBe('no tool call for 9m')
    // Floored at 1m: `0m` would read as a judgement about the agent rather than
    // a measurement of our own evidence.
    expect(quietLabel(60_000)).toBe('no tool call for 1m')
    for (const ms of [60_000, 180_000, 599_000]) {
      expect(quietLabel(ms)).not.toMatch(/stopped|done|stuck|dead|failed/i)
    }
  })

  test('a nameless child is called by its kind, never by an invented name', () => {
    const strip = (s: string) => s.replace(/^\S+\s/, '')
    expect(agentName(agent({ id: 'a', label: '⚡ run the tests' }), strip)).toBe('run the tests')
    expect(agentName(agent({ id: 'a', type: 'workflow-subagent' }), strip)).toBe('workflow-subagent')
    // A blank label is an absent one — it must not render as an empty line.
    expect(agentName(agent({ id: 'a', type: 'Explore', label: '   ' }), strip)).toBe('Explore')
  })
})

describe('the per-agent clock', () => {
  test('a live row is anchored on its own stamp, identically on every render', () => {
    // The anchor used to be `serverNowMs() - since_ms`, recomputed in the render
    // body: `since_ms` is frozen at the last delta while `serverNowMs()` keeps
    // moving, so every render handed `LiveElapsed` a LATER anchor, which tore
    // down its interval and rewrote the digits back to the delta's value. The
    // clock counted up between renders and snapped backwards on each one.
    const r = agent({ id: 'a1', started_ms: 1_756_000_000_000, last_evidence_ms: 1_756_000_009_000 })
    const first = toListRow(r, 1_756_000_010_000)
    const later = toListRow(r, 1_756_000_040_000)
    for (const line of [first, later]) {
      expect(line.quiet).toBe(false)
      expect((line.right as { props: { turnStartMs: number } }).props.turnStartMs).toBe(r.started_ms)
    }
  })

  test('a quiet row drops the clock and states the fact', () => {
    const r = agent({ id: 'a1', started_ms: 1_756_000_000_000, last_evidence_ms: 1_756_000_000_000 })
    const line = toListRow(r, 1_756_000_000_000 + 3 * 60_000)
    expect(line.quiet).toBe(true)
    expect(line.right).toBe('no tool call for 3m')
  })
})

describe('the collapsed working row', () => {
  test('no agents ⇒ no clause, no control, no list', () => {
    const html = row()
    expect(html).not.toContain('chat-agents-toggle')
    expect(text(html)).not.toContain('agents')
    // …and explicitly for an EMPTY array, which is what the SSE delta sends to
    // clear a session's list.
    expect(row({ agents: [] })).not.toContain('chat-agents-toggle')
  })

  test('one agent is not parallelism worth a control', () => {
    expect(row({ agents: rows(1) })).not.toContain('chat-agents-toggle')
  })

  test('two or more ⇒ the clause is the control, and it starts closed', () => {
    const html = row({ agents: rows(3) })
    expect(html).toContain('chat-agents-toggle')
    expect(html).toContain('aria-expanded="false"')
    expect(text(html)).toContain('· 3 agents')
    // Collapsed costs zero pixels beyond the clause: no list is rendered, so a
    // reader who never taps sees exactly what they saw before.
    expect(text(html)).not.toContain('their work shows in the terminal')
  })
})

describe('the expanded list', () => {
  const list = (n: number, over: Partial<AgentRow> = {}) =>
    renderToStaticMarkup(
      <AgentList
        // Sliced exactly as `working-row.tsx` slices it — the cap is the
        // caller's decision, and this pins the pair, not the primitive alone.
        rows={rows(n, over)
          .slice(0, AGENT_ROWS_SHOWN)
          .map((r) => ({ id: r.id, label: r.label ?? r.type, quiet: isQuiet(r, serverNowMs()) }))}
        more={Math.max(0, n - AGENT_ROWS_SHOWN)}
        note="their work shows in the terminal"
      />,
    )

  test('it caps at six and counts the rest', () => {
    const out = text(list(9))
    expect(out).toContain('+3 more')
    expect(out.match(/general-purpose/g)?.length).toBe(AGENT_ROWS_SHOWN)
  })

  test('under the cap there is no `+N more`', () => {
    expect(text(list(3))).not.toContain('more')
  })

  test('the trailing line says where the work actually is', () => {
    // `SUBAGENTS.elsewhere` was dead copy until this list wired it: the chat
    // deliberately does not render subagent turns, so it has to say so.
    expect(text(list(3))).toContain('their work shows in the terminal')
  })
})
