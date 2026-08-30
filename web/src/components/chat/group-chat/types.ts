/**
 * The company group chat's DISPLAY shape (spec §1, §7).
 * ─────────────────────────────────────────────────────────────────────────────
 * One row of the per-company sidecar log (`groupchat.log.jsonl`, spec §2.0), as
 * the surface needs to draw it. Deliberately NOT the wire type: the WS/history
 * endpoints land in a follow-up (spec §8 steps 1–2) and will map into this, the
 * same way `wire-entries.ts` maps the chat socket's blocks into `ChatEntry`.
 *
 * Pure types + two pure helpers, no React — so the offline bench, the unit
 * runner and the future wire adapter can all import them without a DOM.
 */
import type { MarkAttention, MarkPin, MarkState } from '@/brand/marks'

/**
 * The three message KINDS the spec insists must be visually differentiated
 * (§7.2.1 — "the biggest gap"), plus the two voices that carry no label:
 *
 *   `request`   a human dropped a goal (the composer's own voice)
 *   `routed`    the Main Assistant's `@bot-a @bot-b — why` (§7.2.2)
 *   `milestone` a bot manually posted a short important update
 *   `workflow`  a server-authored `run_summary` (`fire_workflow_complete`)
 *   `reply`     an ordinary bot post — the unlabelled default
 */
export type GroupChatKind = 'request' | 'routed' | 'milestone' | 'workflow' | 'reply'

/** Who wrote it. Drives which identity mark the gutter draws: a human colleague
 *  is a CIRCLE (`<HumanMark>`), an agent is its mascot (`<SessionMark>`) — the
 *  three-shape identity convention `human-mark.tsx` states. */
export type GroupChatAuthorKind = 'human' | 'bot' | 'router' | 'workflow'

/** A member of the channel — the facepile's unit, and the `@mention` roster the
 *  body parser resolves names against. `seed` is the session name (the hue seed);
 *  `state`/`attention` come from `markStateForSession` / `attentionFor`, i.e.
 *  REAL session status only (spec §7.2.3 — no optimistic guesses). */
export interface ChannelMember {
  seed: string
  name: string
  pin?: MarkPin
  state?: MarkState
  attention?: MarkAttention
}

/** One rendered row of the feed. */
export interface GroupChatRow {
  /** The sidecar log's monotone `seq` — the React key and the paging cursor. */
  seq: number
  /** Epoch SECONDS (the whole app's `ChatEntry.ts` convention). */
  ts: number
  kind: GroupChatKind
  authorKind: GroupChatAuthorKind
  /** The hue seed: a session name for an agent, the immutable user id for a
   *  human (never the mutable display name — `human-mark.tsx`'s hue firewall). */
  authorSeed: string
  authorName: string
  body: string
  /** `routed` only — the ≤2 sessions the Assistant tagged (spec §4.6). */
  tags?: readonly string[]
  /** `workflow` only — the workflow's name, the completion card's title. */
  runLabel?: string
  /** `workflow` only — the run this row summarises (the server's one-shot key). */
  runId?: string
}

/** Consecutive rows by the same author, close in time, are ONE run: the avatar
 *  and the author line are drawn once (Slack's grouping). 5 minutes is the
 *  window; a different author or a different kind always breaks the run, because
 *  a kind change is exactly what the labels exist to make visible. */
export const GROUP_WINDOW_SECONDS = 300

export function isGrouped(row: GroupChatRow, prev: GroupChatRow | undefined): boolean {
  if (!prev) return false
  if (prev.authorSeed !== row.authorSeed || prev.authorKind !== row.authorKind) return false
  if (prev.kind !== row.kind) return false
  return row.ts - prev.ts <= GROUP_WINDOW_SECONDS
}
