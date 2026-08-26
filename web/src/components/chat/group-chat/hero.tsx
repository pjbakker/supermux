/**
 * `<GroupChatHero>` — the channel, mounted as the OVERVIEW's hero (spec §7.3).
 * ─────────────────────────────────────────────────────────────────────────────
 * The one piece that knows about the app. It answers three questions and hands
 * the rest to `<ChatChannel>`, which knows only pixels:
 *
 *   WHO IS IN IT   the company's own sessions, wearing REAL presence
 *                  (`markStateForSession` / `attentionFor` — the same two
 *                  functions the roster rows use, so a face in the pile and the
 *                  same face in the list below it can never disagree). Nothing
 *                  here guesses a status; that is the stuck-active lesson.
 *   WHAT IS IN IT  `useGroupChat` — the shared `ChatSocket` on
 *                  `/ws/companies/{id}/groupchat`, the history route under it,
 *                  the `for_company` badge tick over it.
 *   WHERE A MESSAGE GOES  the company's Main Assistant, and nowhere else.
 *
 * IS GROUP CHAT ENABLED? There is no flag to read: enabling a company creates
 * its Router as a normal session named `<slug>-assistant` (spec §3.1), so the
 * honest test is whether that session EXISTS. It does ⇒ the composer sends. It
 * does not ⇒ the hero renders **nothing at all** rather than an inert box on
 * the overview of a company that never opted in. HQ likewise renders nothing:
 * HQ has no company, so it has no channel.
 */
import * as React from 'react'

import { useRosterMarks } from '@/hooks/use-roster-marks'
import { useMediaQuery } from '@/hooks/use-media-query'
import { displayLabel, type ApiSession } from '@/lib/api'
import type { Company } from '@/lib/companies'
import { groupChatApi } from '@/lib/api/groupchat'
import { attentionFor, markStateForSession } from '@/lib/mark-status'

import { ChatChannel } from './channel'
import type { ChannelMember, GroupChatRow } from './types'
import { useGroupChat } from './use-group-chat'

/**
 * The Main Assistant's session slug for a company.
 *
 * A NAMING CONVENTION, and it is the server's (`companies::groupchat::
 * router_name`) — restated here, not invented, because this feature ships with
 * no migration and therefore no column to read. One function on each side, so
 * the two cannot drift into disagreeing about what "the Router" is.
 */
export function routerName(companySlug: string): string {
  return `${companySlug}-assistant`
}

/** The roster's deduped faces, read ONCE for the whole pile — the reason
 *  `use-roster-marks.ts` publishes a map instead of a per-row hook. Outside the
 *  provider (a bench, a unit test) it degrades to the hash-pure fallback: a face
 *  that may collide beats no face at all. */
function useChannelMembers(sessions: readonly ApiSession[]): ChannelMember[] {
  const { pinFor } = useRosterMarks()
  return React.useMemo(
    () =>
      sessions.map((s) => ({
        seed: s.name,
        name: displayLabel(s),
        pin: pinFor(s.name),
        state: markStateForSession(s),
        attention: attentionFor(s),
      })),
    [sessions, pinFor],
  )
}

export interface GroupChatHeroProps {
  /** The active company, or `null` for HQ (renders nothing). */
  company: Company | null
  /** The sessions already scoped to that company by the caller. */
  sessions: readonly ApiSession[]
  /**
   * Override the live feed. The hero fetches its own rows; this exists for the
   * offline bench, which has no server and must still render the grammar.
   */
  rows?: readonly GroupChatRow[]
  /** The rail's own company-hue scope (`agentHueVars`), so the composer's focus
   *  ring is the company's colour. A focus STATE, never a fill (contract C7). */
  style?: React.CSSProperties
  className?: string
}

export function GroupChatHero({ company, sessions, rows, style, className }: GroupChatHeroProps) {
  const isPhone = useMediaQuery('(max-width: 767px)')
  const members = useChannelMembers(sessions)

  // The Router, by the one naming convention. Its presence IS the enablement
  // read — see the header. Resolved off the same session list the pile is built
  // from, so a company whose Assistant was stopped still has a channel (the
  // delegate path wakes it) while a company that never had one has none.
  const router = React.useMemo(
    () => (company ? sessions.find((s) => s.name === routerName(company.slug)) ?? null : null),
    [company, sessions],
  )

  const feed = useGroupChat(company && router ? company.id : null)

  // The send: `POST /api/companies/{id}/groupchat/post` — the CHANNEL's own
  // route, not the Router's pty.
  //
  // It has to be this one, because a human request is two things at once and
  // only the server can do both atomically: the `AUTHOR_HUMAN` ROW everyone in
  // the channel reads (a pty write leaves no row, so the request the Router
  // answers would be invisible in the feed), and the ROUTING TURN that row
  // opens — the `seq` the server's max-2-tag cap counts against. Typing into
  // the pty produced the wake without either.
  //
  // The wake still happens, and still exactly once: `post_handler` appends the
  // row and then hands the text to the same `<supermux-human>` funnel the chat
  // composer uses. Still one pty write, still one turn — the token-economy rule
  // (spec §4) is unchanged; only the door moved. The row comes back on the
  // socket like every other row, so there is nothing optimistic to reconcile.
  //
  // No `session` in the body, ever: the server stamps the author from the
  // request's own resolved identity (owner or company colleague alike), which
  // is why the browser has nothing to declare.
  const send = React.useMemo(
    () =>
      company && router
        ? (text: string) => groupChatApi.post(company.id, text)
        : undefined,
    [company, router],
  )

  // HQ, or a company that never enabled group chat: nothing at all. An inert
  // box at the top of the overview would be a promise the surface cannot keep.
  if (!company || !router) return null

  return (
    <ChatChannel
      company={company}
      members={members}
      rows={rows ?? feed.rows}
      loading={rows ? false : feed.isLoading}
      error={rows ? false : feed.isError}
      hasMore={rows ? false : feed.hasMore}
      loadingMore={feed.loadingMore}
      onLoadMore={feed.loadMore}
      unread={rows ? 0 : feed.unread}
      onSeenBottom={feed.markRead}
      onSend={send}
      routerLabel={displayLabel(router)}
      surface={isPhone ? 'phone' : 'desktop'}
      // A hero, not a page: it takes at most a third of a phone screen, so the
      // roster it sits above is still the thing you see when you land.
      feedMaxHeight={isPhone ? 'min(34svh, 300px)' : 340}
      style={style}
      className={className}
    />
  )
}

export default GroupChatHero
