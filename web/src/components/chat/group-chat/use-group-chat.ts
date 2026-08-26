/**
 * The company group chat's DATA PLANE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Three sources, one shape out:
 *
 *   live      `/ws/companies/{id}/groupchat` — the SAME `ChatSocket` the session
 *             transcript uses, pointed at a different path. The server mirrors
 *             `sessions::chat::ws` frame-for-frame, so the socket's first-frame
 *             auth, backoff ladder, lagged re-seed, staleness clock, foreground
 *             redial and total dispose all apply here without a line of new
 *             connection code. THAT is the reuse: a second hand-rolled socket is
 *             a second set of these bugs.
 *   backlog   `GET /api/companies/{id}/groupchat/history` — pages OLDER rows
 *             under the socket's seed window. The cursor is the log `seq`,
 *             which rides on each entry's `offset`, so paging hands the server
 *             back the oldest row it already has and there is no second id
 *             space to reconcile.
 *   badge     the `for_company` `groupchat` SSE tick. Carries `seq` and no text
 *             (by design), which is all an unread count needs. Idempotent
 *             against the socket: unread is `max(seq seen) − lastRead`, so it
 *             does not matter which half sees a row first.
 *
 * WHY NOT `use-chat-backlog`: that module's cursors are conversation-id keyed
 * and its 409 path is about a session's transcript being replaced underneath it.
 * The sidecar log has neither — one monotone `seq`, one file, server-owned — so
 * the paging here is twenty lines instead of three hundred, and honest about it.
 */
import * as React from 'react'

import { useSse, type SseEventType } from '@/hooks/use-sse'
import { groupChatApi } from '@/lib/api'

import type { ChatConnState } from '../chat-socket'
import { useChatWs } from '../use-chat-ws'

import { mergeRows, toGroupChatRows } from './wire'
import type { GroupChatRow } from './types'

/** One backlog page. Smaller than the server's 200 default: this is a hero, and
 *  a reader who taps "earlier" wants the next screenful, not the next ring. */
const PAGE = 50

export interface GroupChatFeed {
  /** Oldest → newest, backlog merged under the live window. */
  rows: GroupChatRow[]
  /** No seed has landed yet — suppress "nothing here" until we actually know. */
  isLoading: boolean
  /** The data plane gave up. The rows on screen stay; they are simply not a
   *  claim about now. */
  isError: boolean
  state: ChatConnState
  /** There are older rows below the top of the window. */
  hasMore: boolean
  loadingMore: boolean
  /** Page one screenful of older rows in. */
  loadMore: () => void
  /** Rows that landed since the reader last looked at the bottom of the feed. */
  unread: number
  markRead: () => void
  redial: () => void
}

export function useGroupChat(companyId: number | null): GroupChatFeed {
  const enabled = companyId !== null
  // A stable name even while disabled: `useChatWs` memoises the store on it, and
  // a name that changes shape between renders would re-dial on every one. The
  // `@` prefix is never a valid session slug, so a company channel can never
  // collide with a session's own socket in the link aggregate.
  const view = useChatWs(
    `@company:${companyId ?? 'none'}`,
    enabled,
    enabled ? `/ws/companies/${companyId}/groupchat` : undefined,
  )

  const windowRows = React.useMemo(() => toGroupChatRows(view.wire), [view.wire])

  // ── the backlog ───────────────────────────────────────────────────────────
  const [older, setOlder] = React.useState<readonly GroupChatRow[]>([])
  const [olderHasMore, setOlderHasMore] = React.useState<boolean | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [readSeq, setReadSeq] = React.useState<number | null>(null)
  const [sseSeq, setSseSeq] = React.useState(0)

  // SWITCHING COMPANY (or a server-ordered re-seed) INVALIDATES EVERYTHING the
  // backlog holds: those rows belong to the old channel. Adjusted during render
  // on the transition — the repo's "adjust state when a prop changes" pattern —
  // rather than in an effect, so no commit ever paints one company's backlog
  // under another's window.
  const scope = `${companyId ?? 'none'}#${view.resyncCount}`
  const [scopeAt, setScopeAt] = React.useState(scope)
  if (scope !== scopeAt) {
    setScopeAt(scope)
    setOlder([])
    setOlderHasMore(null)
    setLoadingMore(false)
    setReadSeq(null)
    setSseSeq(0)
  }

  const rows = React.useMemo(() => mergeRows(older, windowRows), [older, windowRows])

  const oldestSeq = rows.length > 0 ? rows[0]!.seq : null
  const newestSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : 0

  const loadMore = React.useCallback(() => {
    if (companyId === null || loadingMore || oldestSeq === null) return
    setLoadingMore(true)
    void groupChatApi
      .history(companyId, { beforeSeq: oldestSeq, limit: PAGE })
      .then((page) => {
        const fetched = toGroupChatRows(page.entries)
        setOlder((prev) => mergeRows(fetched, prev))
        setOlderHasMore(page.has_more)
      })
      // A failed page is not a broken feed: the window on screen is untouched
      // and the affordance comes back, so the reader can try again.
      .catch(() => setOlderHasMore(true))
      .finally(() => setLoadingMore(false))
  }, [companyId, loadingMore, oldestSeq])

  // ── the badge tick ────────────────────────────────────────────────────────
  const onEvent = React.useCallback(
    (type: SseEventType, payload: unknown) => {
      if (type !== 'groupchat' || companyId === null) return
      const p = payload as { company?: number; seq?: number } | null
      if (!p || p.company !== companyId || typeof p.seq !== 'number') return
      setSseSeq((prev) => (p.seq! > prev ? p.seq! : prev))
    },
    [companyId],
  )
  useSse(React.useMemo(() => ({ onEvent }), [onEvent]))

  const highSeq = Math.max(newestSeq, sseSeq)

  // The first seed is not "unread" — the reader is looking at it. Seeding the
  // cursor here (rather than at 0) is what stops a freshly mounted hero from
  // claiming twelve new messages the moment it connects.
  //
  // Adjusted DURING RENDER on the seeded transition, not in an effect: the
  // effect version paints one frame with `unread = highSeq` before correcting
  // itself, which on a busy channel is a badge that flashes "37" and then
  // vanishes. Guarded, so it runs exactly once per channel.
  if (view.seeded && readSeq === null) setReadSeq(highSeq)

  const markRead = React.useCallback(() => setReadSeq(highSeq), [highSeq])

  return {
    rows,
    isLoading: enabled && view.isLoading,
    isError: view.isError,
    state: view.state,
    // Before the first page is asked for, the socket's own `has_more` answers;
    // after it, the last page's does.
    hasMore: olderHasMore ?? view.hasMore,
    loadingMore,
    loadMore,
    unread: readSeq === null ? 0 : Math.max(0, highSeq - readSeq),
    markRead,
    redial: view.redial,
  }
}
