/**
 * UNDO CLOSE — the smallest safety net a browser has, and the one every human
 * has already learned somewhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 * A shared-browser tab is not a page: it is a browser PROFILE with a signed-in
 * session behind it, and closing one drops the row. That makes the mis-tap
 * expensive in a way a normal ⌘W is not — the cookies survive on the server,
 * but finding the address again is the human's problem.
 *
 * WHAT UNDO CAN AND CANNOT PROMISE, stated once so the UI never over-claims:
 *
 *   · it CAN re-open a tab at the url it was on, at the position it held, with
 *     its pin — all four are facts we held in the row we just deleted;
 *   · it CANNOT restore the tab's GRANTS or its id. A re-created tab is a NEW
 *     row, so the bots that were lent the old one are not lent this one. That
 *     is the honest behaviour (a grant is a permission, not a decoration), and
 *     it is why the affordance says "Reopened" rather than "Restored".
 *
 * The stack is capped and deduped by id: closing the same tab twice cannot
 * happen, but a re-opened-then-re-closed tab can, and two entries for one id
 * would offer to open the same address twice.
 */

/** Everything undo needs, and nothing it does not — a snapshot, never a live
 *  row: the row is gone by the time this matters. */
export interface ClosedTab {
  id: string
  url: string
  title: string
  pinned: boolean
  /** Where it sat in the rail, so it comes back where it was rather than at
   *  the end — which is the difference between "undone" and "opened again". */
  index: number
  /** `Date.now()` at close. Used only to expire the affordance. */
  at: number
}

/** Deep enough for a run of mis-taps, shallow enough that it is a stack and
 *  not a history feature nobody asked for. */
export const UNDO_STACK_MAX = 8

/** How long the affordance stands before it goes away by itself. Long enough
 *  to notice a mistake, short enough that it is not furniture. */
export const UNDO_WINDOW_MS = 7_000

/** Push, newest first, with the id deduped. */
export function pushClosed(stack: ClosedTab[], entry: ClosedTab): ClosedTab[] {
  return [entry, ...stack.filter((t) => t.id !== entry.id)].slice(0, UNDO_STACK_MAX)
}

/** Take the most recent one back. Returns `null` for an empty stack rather
 *  than throwing: the keyboard shortcut fires whether or not anything is
 *  there. */
export function popClosed(stack: ClosedTab[]): { entry: ClosedTab; rest: ClosedTab[] } | null {
  const [entry, ...rest] = stack
  if (!entry) return null
  return { entry, rest }
}

/** Drop entries older than the window — what a timer tick calls, so a stale
 *  "Closed · Undo" cannot outlive its own promise. */
export function pruneClosed(stack: ClosedTab[], now: number): ClosedTab[] {
  return stack.filter((t) => now - t.at < UNDO_WINDOW_MS)
}
