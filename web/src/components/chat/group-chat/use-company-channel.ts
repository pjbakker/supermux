/**
 * `useCompanyChannel` — the ONE app-aware resolution for a company's group chat,
 * shared by every surface that speaks to the channel:
 *
 *   • `<GroupChatEntry>`  the compact overview row (latest line + unread badge).
 *   • `<CompanyChatPage>` the full-bleed `/company/:id/chat` destination.
 *
 * It answers the three questions the presentational `<ChatChannel>` refuses to
 * know (WHO is in it, WHAT is in it, WHERE a message goes) exactly once, so the
 * row you tap and the page it opens can never disagree about whether the channel
 * exists, who its members are, or how many messages are unread.
 *
 * ENABLEMENT is not a flag — enabling a company creates its Router as a normal
 * session `<slug>-assistant` (spec §3.1), so the honest test is whether that
 * session EXISTS in the passed roster. `enabled === false` ⇒ HQ, or a company
 * that never opted in ⇒ every surface renders nothing.
 */
import * as React from 'react'

import { useRosterMarks } from '@/hooks/use-roster-marks'
import { displayLabel, type ApiSession } from '@/lib/api'
import type { Company } from '@/lib/companies'
import { groupChatApi } from '@/lib/api/groupchat'
import { attentionFor, markStateForSession } from '@/lib/mark-status'

import type { ChannelMember } from './types'
import { useGroupChat, type GroupChatFeed } from './use-group-chat'

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
export function useChannelMembers(sessions: readonly ApiSession[]): ChannelMember[] {
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

export interface CompanyChannel {
  /** The company has a channel (its Router session exists). `false` ⇒ HQ or a
   *  company that never enabled group chat — the caller renders nothing. */
  enabled: boolean
  /** The company's own sessions as channel members (faces + presence). */
  members: ChannelMember[]
  /** The Router session, or `null` when not enabled. */
  router: ApiSession | null
  /** The Router's display name — the send control says where it goes. */
  routerLabel: string
  /** The live feed (rows, unread, loading, paging). Points at nothing when not
   *  enabled, so mounting this hook on HQ costs no socket. */
  feed: GroupChatFeed
  /** Deliver a human message to the Router, or `undefined` (read-only). */
  send?: (text: string) => Promise<unknown>
}

export function useCompanyChannel(
  company: Company | null,
  sessions: readonly ApiSession[],
): CompanyChannel {
  const members = useChannelMembers(sessions)

  // The Router, by the one naming convention. Its presence IS the enablement
  // read. Resolved off the same session list the pile is built from, so a
  // company whose Assistant was stopped still has a channel (the delegate path
  // wakes it) while a company that never had one has none.
  const router = React.useMemo(
    () => (company ? sessions.find((s) => s.name === routerName(company.slug)) ?? null : null),
    [company, sessions],
  )
  const enabled = !!(company && router)

  // Only opens the socket when there is a channel to read — HQ and un-opted
  // companies pass `null` and pay for nothing.
  const feed = useGroupChat(enabled ? company!.id : null)

  // The send: `POST /api/companies/{id}/groupchat/post` — the CHANNEL's own
  // route, not the Router's pty. The server appends the AUTHOR_HUMAN row AND
  // opens the one authed routing turn atomically; the browser declares no
  // author (the server stamps it from the request's resolved identity).
  const send = React.useMemo(
    () => (enabled ? (text: string) => groupChatApi.post(company!.id, text) : undefined),
    [enabled, company],
  )

  return {
    enabled,
    members,
    router,
    routerLabel: router ? displayLabel(router) : '',
    feed,
    send,
  }
}
