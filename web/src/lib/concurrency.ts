// mapWithLimit — the bounded fan-out behind every bulk file action.
//
// Files' bulk bar (Move / Copy / Download / Delete over a multi-selection) is a
// CLIENT fan-out by design: there are deliberately no server-side bulk
// endpoints (files v1 spec §1 non-goals), because a batch verb would need its
// own partial-failure envelope, its own audit shape and its own jail story —
// three new things to get wrong — where N single verbs already have all three.
//
// What the client owes in return is (a) not opening N sockets at once against a
// small VPS, and (b) reporting what actually happened. This helper is (a); it
// hands back a settled result PER ITEM, in input order, so the caller can be
// honest about partial failure instead of collapsing it into one throw.
//
// Pure: no DOM, no fetch, no timers — unit-tested in isolation.

/** One item's outcome. Mirrors `PromiseSettledResult` so the shape is familiar,
 *  but is declared here so this module stays dependency-free and the `reason`
 *  is typed as `unknown` (it is whatever `fn` rejected with). */
export type Settled<R> =
  | { status: 'fulfilled'; value: R }
  | { status: 'rejected'; reason: unknown }

/**
 * Run `fn` over `items` with at most `limit` calls in flight.
 *
 * - **Order is preserved**: `result[i]` is always `items[i]`'s outcome, whatever
 *   order the calls happen to settle in.
 * - **A rejection never fails the batch**: it lands as `{status:'rejected'}` in
 *   its own slot and the remaining items keep going. This is the whole point —
 *   "3 moved · 1 failed" is a truthful report, "the move failed" is not.
 * - `limit` is clamped to at least 1, so a caller passing `0` degrades to
 *   sequential rather than deadlocking on an empty worker pool.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const out: Settled<R>[] = new Array(items.length)
  if (items.length === 0) return out
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))

  // A shared cursor over the input rather than pre-sliced chunks: chunking by
  // index would let one slow chunk idle its worker while another still has
  // work queued. Each worker just takes the next unclaimed index.
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]!, i) }
      } catch (reason) {
        out[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return out
}
