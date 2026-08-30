// The working row's agent list — the DECISIONS, with no React in them.
//
// `SessionSummary.agents` is a list of children the server has FIRST-HAND
// evidence of: a row exists only because a hook carrying that agent's own
// `agent_id` arrived. This module turns that list into what the expanded working
// row says, and nothing else — so the three judgements that could quietly go
// wrong (when a row is quiet, what quiet is allowed to claim, how many rows a
// phone gets) are pure functions with tests rather than JSX.
//
// Import rule: relative only, like the rest of `components/chat` — the unit
// runner resolves these files directly and does not read the tsconfig aliases.

import type { AgentRow } from '../../lib/api/sessions'

/**
 * How long a row may go without a hook before it reads QUIET rather than live.
 *
 * Mirrors the server's `AGENT_LIVE_WINDOW` (`state.rs`), and it is 60s rather
 * than the 10s `subagents_live` window on purpose: an agent sitting inside one
 * `Bash` is legitimately silent, and Claude Code's `Bash` ceiling is 600s. A
 * 10s window would blink every row in and out, which is worse jank than the
 * stale count these rows replace.
 */
export const AGENT_QUIET_AFTER_MS = 60_000

/**
 * How many rows the expanded list draws before it says `+N more`.
 *
 * Six, because the surface this has to survive is a 390px phone with the
 * composer up: six 24px rows plus the trailing line is about as much as can
 * appear under the working row without pushing the live band off screen. A
 * fan-out of thirty is a real thing on this host, and the honest answer to it is
 * a count, not thirty rows nobody reads.
 */
export const AGENT_ROWS_SHOWN = 6

/** Has this row gone quiet — no tool call within `AGENT_QUIET_AFTER_MS`? */
export function isQuiet(row: Pick<AgentRow, 'quiet_ms'>): boolean {
  return row.quiet_ms >= AGENT_QUIET_AFTER_MS
}

/**
 * What a quiet row is allowed to say: the FACT, and only the fact.
 *
 * Never "stopped", never "done", never "stuck" — supermux does not know any of
 * those. All it knows is when the last hook carrying this agent's id arrived, so
 * that is what it says. Floors at 1m: a row is not quiet below 60s, and `0m`
 * would read as a verdict rather than a measurement.
 */
export function quietLabel(quietMs: number): string {
  return `no tool call for ${Math.max(1, Math.floor(quietMs / 60_000))}m`
}

/**
 * The name this agent goes by, given what the wire actually carries.
 *
 * Preference order: its CURRENT tool call (the app's own voice, and the only
 * thing that says what the agent is doing), else its kind. A workflow child has
 * no human name anywhere on the wire — `workflow-subagent` reads badly, and it
 * is still better than inventing one.
 */
export function agentName(row: AgentRow, strip: (label: string) => string): string {
  const label = row.label?.trim()
  return label ? strip(label) : row.type
}
