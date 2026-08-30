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
  quietLabel,
} from '../../src/components/chat/agent-rows'
import { serverNowMs } from '../../src/components/chat/latency'
import { WorkingRow } from '../../src/components/chat/working-row'
import { AgentList } from '../../src/components/chat/ui'
import type { AgentRow } from '../../src/lib/api/sessions'

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

function agent(over: Partial<AgentRow> & { id: string }): AgentRow {
  return { type: 'general-purpose', since_ms: 12_000, quiet_ms: 900, ...over }
}

const rows = (n: number, over: Partial<AgentRow> = {}) =>
  Array.from({ length: n }, (_, i) => agent({ id: `a${i}`, ...over }))

const row = (over: Partial<AgentRow> = {}) =>
  renderToStaticMarkup(
    <WorkingRow name="release-train" activity="⚡ cargo test" turnStartMs={serverNowMs() - 12_000} {...over} />,
  )

describe('the quiet ladder', () => {
  test('a row is live inside the window and quiet outside it', () => {
    expect(isQuiet({ quiet_ms: 0 })).toBe(false)
    expect(isQuiet({ quiet_ms: AGENT_QUIET_AFTER_MS - 1 })).toBe(false)
    expect(isQuiet({ quiet_ms: AGENT_QUIET_AFTER_MS })).toBe(true)
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
          .map((r) => ({ id: r.id, label: r.label ?? r.type, quiet: isQuiet(r) }))}
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
