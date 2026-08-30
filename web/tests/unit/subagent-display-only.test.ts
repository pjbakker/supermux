/**
 * The display-only invariant, as a gate instead of a convention.
 * ─────────────────────────────────────────────────────────────────────────────
 * There is a bug in this codebase's history that this file exists to make
 * unrepeatable: `SubagentStop` once ended the MAIN turn, so a session went quiet
 * and "done" while its parent agent was still working. The fix was to make every
 * subagent signal display-only, and the load-bearing half of that fix is on the
 * CLIENT: `shouldEndTurn` in `use-chat-turn.ts` decides when a turn is over, and
 * it must never learn that subagents exist.
 *
 * Adding per-agent ROWS (`agents`) and their count (`agents_live`) is exactly
 * the change that would tempt someone to wire "…and no agents are running" into
 * that decision. It reads as an improvement and it is the bug. So the three
 * modules that own the turn boundary and the wire→entry translation are pinned
 * to ZERO mentions:
 *
 *   • `use-chat-turn.ts` — `shouldEndTurn`'s booleans, the turn state machine.
 *   • `use-chat-ws.ts`   — the socket that feeds it.
 *   • `entries.ts`       — the wire→entry translation those two read.
 *
 * They are consumed ONLY by presentational components (`working-row` for the
 * rows, `activity-status` / `grok-roster` / the `live-layer` header for the
 * count). That list is the invariant; this test is the part of it a machine can
 * check.
 *
 * If a future change genuinely needs one of these files to know about agents,
 * that is a deliberate, separately-reviewed decision about the turn boundary —
 * not a one-line import. Deleting this test is the first step of making it, and
 * it should feel like one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

/** The modules that decide when a turn ends, and the translation they read. */
const TURN_BOUNDARY_FILES = [
  '../../src/components/chat/use-chat-turn.ts',
  '../../src/components/chat/use-chat-ws.ts',
  '../../src/components/chat/entries.ts',
] as const

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the subagent display-only invariant', () => {
  for (const rel of TURN_BOUNDARY_FILES) {
    const name = rel.split('/').pop()
    test(`${name} never mentions subagents or agent rows`, () => {
      const src = read(rel)
      // Case-insensitive and substring-wide on purpose: `subagents`,
      // `subagents_live`, `isSubagent` and a stray comment all count. A mention
      // in a COMMENT is caught too — if the concept is worth writing down here,
      // it is one edit away from being read here.
      const hits = src
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /subagent/i.test(line))
      expect(hits).toEqual([])
    })

    test(`${name} never reads the agents key`, () => {
      const src = read(rel)
      // `agent` alone is too broad (this app is full of agents); the two wire
      // keys and the row type are the shapes that would actually smuggle the
      // signal into the turn decision.
      const hits = src
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) =>
          /\bAgentRow\b|\.agents(_live)?\b|\bagents(_live)?\s*[:?]/.test(line),
        )
      expect(hits).toEqual([])
    })
  }
})
