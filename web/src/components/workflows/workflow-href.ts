// Where "manage all workflows" and "open the thread" go — one module, one place.
//
// PURE AND IMPORT-FREE, and deliberately so: it is the only thing in the
// workflows subtree that may know a route, and the `bun test` runner resolves
// it without a React tree behind it.
//
// The descendant of `session-schedules/schedule-href.ts`, whose whole reason
// for existing was that B1 folded `/scheduler` into Settings while the surfaces
// pointing at it were still being written. Workflows unfolds that: the route is
// a real top-level destination again, so the constant moves back — and it moves
// HERE rather than being inlined at four call sites, because that is what made
// the last move a one-line change instead of a grep.

/** The workflows list — the "manage all workflows" destination. */
export const WORKFLOWS_ROUTE = '/workflows'

/** The list. `folded` exists so both worlds stay reachable from a test if the
 *  surface is ever folded into Settings again. */
export function workflowAdminHref(folded: boolean = false): string {
  return folded ? '/settings#workflows' : WORKFLOWS_ROUTE
}

/** One workflow's detail (steps + run history). */
export function workflowHref(id: string): string {
  return `${WORKFLOWS_ROUTE}/${encodeURIComponent(id)}`
}

/** The composer, creating. `session` pre-selects the owning bot — what
 *  "+ New workflow" inside a bot's panel needs. */
export function workflowNewHref(session?: string | null): string {
  return session
    ? `${WORKFLOWS_ROUTE}/new?session=${encodeURIComponent(session)}`
    : `${WORKFLOWS_ROUTE}/new`
}

/** The composer, editing. */
export function workflowEditHref(id: string): string {
  return `${WORKFLOWS_ROUTE}/${encodeURIComponent(id)}/edit`
}

/**
 * "Open the thread here →" — the bot's own chat pane, which is where a workflow
 * actually happens. A run has no surface of its own to link to: the steps are
 * delivered into the bot's transcript like anything else a human typed, and
 * pretending otherwise would be the dishonest link.
 */
export function botThreadHref(session: string): string {
  return `/focus/${encodeURIComponent(session)}`
}
