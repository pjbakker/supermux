// The quick-tunnel ("try it now — no domain needed") pure decisions, kept out of
// the invite wizard's JSX so they are testable without a DOM.
//
// WHY this file exists: the wizard used to branch straight on
// `status.box_status.quick_tunnel?.active`, which has THREE meanings, not two —
// no tunnel at all, a running tunnel, and a tunnel the box knows about that is
// no longer running. Collapsing the third into "no tunnel" is what made
// "Create a temporary link" look like it did nothing: the POST returned a URL,
// the follow-up status said `active:false`, and the sheet silently re-rendered
// the chooser it started from. Naming the third state is what lets the UI SAY
// what happened.

import type { QuickTunnelStatus } from './api/external-access'

/** What the Domain step should show for the temporary-link branch.
 *  - `none`    — the box has no quick tunnel; offer the chooser.
 *  - `live`    — a tunnel is running; show the link.
 *  - `stopped` — a tunnel was started but is NOT running; say so, offer a retry.
 *    NEVER fold this into `none`: the user asked for a link and got one, so
 *    silently reverting to the chooser is a lie about what happened. */
export type QuickTunnelView = 'none' | 'live' | 'stopped'

export function quickTunnelView(qt?: QuickTunnelStatus | null): QuickTunnelView {
  if (!qt || !qt.host) return 'none'
  return qt.active ? 'live' : 'stopped'
}

/** The `POST /api/external-access/quick-tunnel` body. The company id is REQUIRED
 *  server-side (`QuickTunnelInput`); omitting it is a 422, so the shape is pinned
 *  by a test rather than living only inside a `JSON.stringify` call. */
export function quickTunnelPayload(companyId: number): { company_id: number } {
  return { company_id: companyId }
}
