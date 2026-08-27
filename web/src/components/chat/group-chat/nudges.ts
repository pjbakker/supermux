/**
 * `nudges.ts` — the group-chat feed's routing-fold, kept pure so it can be
 * asserted without a DOM (same discipline as `grouping.ts` / `wire.ts`).
 *
 * A single Router turn fans a bot out ONE `tag_bot` at a time, so the sidecar
 * log carries one `routed` row PER tagged bot. Rendered raw that is a stack of
 * "Nudged @x" / "Nudged @y" lines for what was one act. `collapseNudges` folds a
 * run of consecutive `routed` rows from the SAME Router (within the grouping
 * window) into a single row whose `tags` are the de-duped union — the feed then
 * shows one "Nudged @a @b @c" line, chips behind each other.
 *
 * Invariants the render relies on and the tests pin:
 *   · the FIRST row's `seq` survives, so the React key is stable across a socket
 *     row arriving mid-fold;
 *   · the LATEST `ts` survives, so the working-pulse and day-grouping stay live;
 *   · only `routed` rows fold, and only into an adjacent `routed` row — a bot's
 *     `post_message` or a milestone between two nudges breaks the run;
 *   · it never mutates its input.
 */
import { GROUP_WINDOW_SECONDS, type GroupChatRow } from './types'

export function collapseNudges(rows: readonly GroupChatRow[]): GroupChatRow[] {
  const out: GroupChatRow[] = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    if (
      row.kind === 'routed' &&
      prev?.kind === 'routed' &&
      prev.authorSeed === row.authorSeed &&
      row.ts - prev.ts <= GROUP_WINDOW_SECONDS
    ) {
      const seen = new Set((prev.tags ?? []).map((t) => t.toLowerCase()))
      const tags = [...(prev.tags ?? [])]
      for (const t of row.tags ?? []) {
        if (!seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase())
          tags.push(t)
        }
      }
      out[out.length - 1] = { ...prev, ts: row.ts, tags }
    } else {
      out.push(row)
    }
  }
  return out
}
