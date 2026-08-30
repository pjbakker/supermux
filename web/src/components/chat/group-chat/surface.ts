/**
 * WHICH group-chat doorway a surface gets — the ONE pure rule, so the roster and
 * its tests cannot disagree about it.
 * ─────────────────────────────────────────────────────────────────────────────
 * The channel has two doorways, and they are viewport-forked on purpose:
 *
 *   'dock'  PHONE — the compact `<GroupChatEntry>` card above the list, which
 *           opens the full-bleed `/company/:id/chat` page. A phone has no right
 *           pane, so the channel still wants the whole screen. UNCHANGED.
 *   'row'   DESKTOP — a normal-sized roster row PINNED at the top of the bot
 *           list, which opens `<ChatChannel>` in the SAME right pane a bot chat
 *           opens in. The channel is a colleague-shaped destination there, not a
 *           separate page that throws the two-pane layout away.
 *   'none'  HQ, a company that never opted in, or a desktop search that this
 *           row does not answer.
 *
 * WHY the search clause: the roster's search filters the rows below, so a row
 * that is pinned above them would be the one thing a search cannot remove — it
 * would read as a result that matched. It stays only while it genuinely answers
 * the query (its own label, the company's name, or its slug).
 */

/** The doorway a surface renders for the company channel. */
export type GroupChatSurface = 'none' | 'dock' | 'row'

/** The pinned row's own label — matched against the search needle. */
export const CHANNEL_ROW_LABEL = 'Company chat'

export interface GroupChatSurfaceInput {
  /** The channel exists (its Router session is in the roster). */
  enabled: boolean
  /** The viewport is a phone (<768px) — the roster's own `isPhone` read. */
  isPhone: boolean
  /** The roster's raw search box. Empty ⇒ no filtering at all. */
  query?: string
  /** The active company's display name and slug — the other two things the
   *  pinned row honestly answers a search with. */
  displayName?: string
  slug?: string
}

/** Does the pinned row itself answer this search needle? */
export function channelRowMatches(
  query: string,
  company: { displayName?: string; slug?: string },
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const fields = [CHANNEL_ROW_LABEL, company.displayName ?? '', company.slug ?? '']
  return fields.some((f) => f.toLowerCase().includes(needle))
}

export function groupChatSurface(o: GroupChatSurfaceInput): GroupChatSurface {
  if (!o.enabled) return 'none'
  // Phone keeps today's doorway verbatim, search or no search — the dock has
  // never been search-aware and this change must not make it so.
  if (o.isPhone) return 'dock'
  return channelRowMatches(o.query ?? '', { displayName: o.displayName, slug: o.slug })
    ? 'row'
    : 'none'
}

/* ── the one-line preview both doorways show ────────────────────────────────
   The dock card and the pinned row show the SAME sentence for the same feed —
   they are two shapes of one doorway, so the copy lives here once. */

/** "author: body" for the newest row, whitespace collapsed to one line. */
export function channelPreviewLine(row: {
  body: string
  authorName?: string | null
}): string {
  const body = row.body.replace(/\s+/g, ' ').trim()
  return row.authorName ? `${row.authorName}: ${body}` : body
}

/**
 * The preview slot's text. "We don't know yet" and "there is nothing" are
 * different sentences — `loading` is what keeps the second from being printed
 * while the first is true.
 */
export function channelPreview(
  latest: { body: string; authorName?: string | null } | null,
  loading: boolean,
): string {
  if (latest) return channelPreviewLine(latest)
  return loading ? 'Opening the channel…' : 'No messages yet — start the conversation'
}
