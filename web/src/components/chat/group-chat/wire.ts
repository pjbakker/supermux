/**
 * Wire entries → the channel's display rows.
 *
 * The seam, and it is deliberately the SAME shape of seam `wire-entries.ts` is
 * for the session transcript: the socket speaks `WireEntry`, the surface speaks
 * `GroupChatRow`, and exactly one pure module maps between them so a change to
 * either side has one place to land.
 *
 * The server (`companies/groupchat/mod.rs::to_entry`) hands us:
 *   offset          the LOG `seq` — the paging cursor domain AND our React key
 *   ts_ms           the server clock in MILLIseconds
 *   session_id      the author's session slug
 *   label / body.author_kind   `human | bot | router | workflow`
 *   body.text       the row's prose (already `@`-stripped for bot posts)
 *   body.run_id     the workflow run this summarises, when any
 *
 * TWO THINGS ARE DERIVED HERE, and both are derived rather than sent because
 * they are presentation, not provenance:
 *
 *   · the KIND. The log has four author kinds; the hero draws five reads. A
 *     human row is a `request`, a router row is `routed`, a workflow row is a
 *     completion card, and a bot row is a `milestone` — which is exactly what a
 *     bot post IS on this channel (the only bot write path is
 *     `post_message`, §5.1). There is no honest way to tell a "milestone" from
 *     a "reply" on the wire, so the surface does not pretend to.
 *   · the ROUTER'S TAGS. The Router's contract output is one line —
 *     `@bot-a @bot-b — why` (§3.2) — so the leading `@` run is the tag list and
 *     the remainder is the reason. Parsed, not sent, because the log stores the
 *     Router's own sentence verbatim and adding a parallel `tags` column would
 *     be a second truth that could disagree with the text on screen.
 *
 * Pure and import-light (types only), like `entries.ts` and `delegate-intent.ts`
 * — the unit runner has no DOM and no `@/` aliases.
 */
import type { WireEntry } from '../wire'

import type { GroupChatAuthorKind, GroupChatKind, GroupChatRow } from './types'

/** The server's `author_kind` strings (`companies/groupchat/mod.rs`). */
const AUTHOR_KINDS: readonly string[] = ['human', 'bot', 'router', 'workflow']


function kindFor(authorKind: GroupChatAuthorKind): GroupChatKind {
  switch (authorKind) {
    case 'human':
      return 'request'
    case 'router':
      return 'routed'
    case 'workflow':
      return 'workflow'
    default:
      return 'milestone'
  }
}

function readBody(entry: WireEntry): Record<string, unknown> {
  const b = entry.body
  return typeof b === 'object' && b !== null && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * One wire entry → one row, or `null` for a frame this surface cannot draw.
 *
 * `null` rather than a placeholder: a groupchat row whose `author_kind` we do
 * not recognise is a newer server talking to an older client, and inventing a
 * face and a name for it would be the confident lie the honesty rule forbids.
 */
export function toGroupChatRow(entry: WireEntry): GroupChatRow | null {
  const body = readBody(entry)
  const rawKind = str(body.author_kind) ?? str(entry.label)
  if (!rawKind || !AUTHOR_KINDS.includes(rawKind)) return null
  const authorKind = rawKind as GroupChatAuthorKind
  const seed = str(body.author_session) ?? str(entry.session_id) ?? 'server'
  const text = str(body.text) ?? ''

  const row: GroupChatRow = {
    seq: entry.offset,
    // The whole app reads `ChatEntry.ts` as epoch SECONDS; the log is ms.
    ts: Math.floor(entry.ts_ms / 1000),
    kind: kindFor(authorKind),
    authorKind,
    authorSeed: seed,
    authorName: str(body.author_name) ?? seed,
    body: text,
  }

  if (authorKind === 'router') {
    // Tags are STRUCTURED DATA on the row (`body.tagged`), NOT text: the server
    // strips every `@` from a router body before writing it, so parsing tags out
    // of the prose (as this did) always found none and every routing act silently
    // degraded to a plain `reply` — the "Routed to →" chip treatment was dead
    // code that never fired on live data. Read the field the server actually
    // writes (`record_tag` → `row.tagged` → `to_entry` "tagged").
    const tags = Array.isArray(body.tagged)
      ? (body.tagged as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    // A router line with no tags is a direct reply (`@none`), not a routing act,
    // and drawing an empty "Routed to →" arrow would be chrome with nothing
    // behind it.
    if (tags.length === 0) return { ...row, kind: 'reply' }
    return { ...row, tags }
  }

  if (authorKind === 'workflow') {
    const runId = str(body.run_id)
    // `run_summary` leads with the run's own title line when it has one; that
    // line is the card's heading, the rest is its body.
    const nl = text.indexOf('\n')
    if (nl > 0) {
      return { ...row, runLabel: text.slice(0, nl).trim(), body: text.slice(nl + 1).trim(), runId }
    }
    return { ...row, runId }
  }

  return row
}

/** A window of wire entries → rows, oldest-first, unrenderable frames dropped. */
export function toGroupChatRows(wire: readonly WireEntry[]): GroupChatRow[] {
  const out: GroupChatRow[] = []
  for (const e of wire) {
    const row = toGroupChatRow(e)
    if (row) out.push(row)
  }
  return out
}

/** Merge an older page under a window, de-duped on `seq` and re-sorted.
 *
 *  `seq` is monotone per company and assigned under the append lock, so it is a
 *  total order and the dedupe is exact — no timestamp tie-breaks, and a row
 *  that arrives on BOTH the socket and a history page collapses to one. */
export function mergeRows(
  older: readonly GroupChatRow[],
  window: readonly GroupChatRow[],
): GroupChatRow[] {
  const bySeq = new Map<number, GroupChatRow>()
  for (const r of older) bySeq.set(r.seq, r)
  // The live window wins a collision: it is the fresher read of the same row.
  for (const r of window) bySeq.set(r.seq, r)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
