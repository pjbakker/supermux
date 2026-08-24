/**
 * DRAG-REORDER — the rail's order, as arithmetic.
 * ─────────────────────────────────────────────────────────────────────────────
 * SESSION-ONLY, AND SAID SO. There is no `position` column on `browser_tabs`
 * and no ordering field on the row, so an order dragged here lives in the
 * workspace's own state and is gone on reload. That is a deliberate v1: the
 * alternative is a schema migration for a preference, and a migration is the
 * one thing in this repo that cannot be taken back (`sqlx` checksums them).
 * The server support this needs is one nullable `position INTEGER` plus a
 * `PATCH /api/browser/tabs/{id}` field — noted, not smuggled in.
 *
 * PINNED IS A PARTITION, NOT A SORT KEY. Pinned chips are favicon-only and
 * sticky-left on desktop; dragging an unpinned tab into the pinned run would
 * either silently pin it (a permission-shaped act from a drag) or leave the
 * rail rendering in an order it is not in. So a drag is clamped INSIDE its own
 * partition, and pinning stays the explicit control it already is.
 *
 * Pure, because the interesting half is off-by-ones: `moveItem` with `to`
 * after `from` is the classic splice bug, and `dropIndex` at the exact
 * midpoint between two chips is the one a mouse finds in ten seconds.
 */

/** Move one item, splice-safe in both directions. Out-of-range indices return
 *  the list unchanged rather than inventing a hole. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list
  if (from < 0 || from >= list.length) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  const at = Math.min(Math.max(to, 0), next.length)
  next.splice(at, 0, item)
  return next
}

/**
 * Where a pointer at `x` wants to drop, given each chip's CENTRE.
 *
 * Centres, not edges: a chip is 112–168px wide and its centre is the only
 * point where "before" flips to "after" without a dead band. The dragged chip
 * is excluded from the comparison — comparing against your own centre makes
 * the drop index oscillate as the row reflows under the finger.
 */
export function dropIndex(centers: number[], x: number, from: number): number {
  let to = 0
  for (let i = 0; i < centers.length; i += 1) {
    if (i === from) continue
    if (centers[i] < x) to += 1
  }
  return Math.min(Math.max(to, 0), Math.max(centers.length - 1, 0))
}

/**
 * Clamp a drop into the dragged chip's own pinned/unpinned run.
 *
 * Both indices are in POST-REMOVAL coordinates — the same space `moveItem`
 * takes — because that is the only space in which "the slot after the last
 * pinned chip" is a number and not an argument.
 */
export function clampToPartition(pinned: boolean[], from: number, to: number): number {
  const rest = pinned.filter((_, i) => i !== from)
  const mine = pinned[from]
  const lo = rest.indexOf(mine)
  // No sibling of this kind at all: the partition is one slot, and pinned
  // sorts before unpinned.
  if (lo < 0) return mine ? 0 : rest.length
  let hi = lo
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i] === mine) {
      hi = i + 1
      break
    }
  }
  return Math.min(Math.max(to, lo), hi)
}

/**
 * Apply a remembered order to a live list.
 *
 * TOTAL BY CONSTRUCTION: ids the order does not mention (a tab another agent
 * opened while we were dragging) keep their server order and land at the end,
 * and ids in the order that no longer exist are dropped. A reorder is a
 * preference; it must never be able to hide a tab.
 */
export function applyOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items
  const rank = new Map(order.map((id, i) => [id, i]))
  const known: T[] = []
  const fresh: T[] = []
  for (const item of items) (rank.has(item.id) ? known : fresh).push(item)
  known.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  return [...known, ...fresh]
}
