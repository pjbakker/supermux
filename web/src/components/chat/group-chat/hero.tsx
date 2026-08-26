/**
 * `<GroupChatHero>` — the channel, mounted as the OVERVIEW's hero (spec §7.3).
 * ─────────────────────────────────────────────────────────────────────────────
 * The one piece that knows about the app: it turns the rail's own company scope
 * and its own session list into the channel's members, and renders nothing at
 * all in HQ (`activeCompany === null`) — HQ has no company, so it has no
 * channel, and an empty box there would be the firewall leaking.
 *
 * PRESENCE IS REAL OR IT IS ABSENT. Member faces carry `markStateForSession` +
 * `attentionFor` off the live sessions query — the same two functions the roster
 * rows use, so a face in the pile and the same face in the list below it can
 * never disagree. Nothing here guesses a status (the stuck-active lesson).
 *
 * The FEED is empty until the groupchat WS lands (spec §8 steps 1–2, 8): the
 * channel draws its honest empty state rather than inventing rows. `rows` is a
 * prop so the wire adapter — and the offline bench — can hand it real ones.
 */
import * as React from 'react'

import { useRosterMarks } from '@/hooks/use-roster-marks'
import { useMediaQuery } from '@/hooks/use-media-query'
import { displayLabel, type ApiSession } from '@/lib/api'
import type { Company } from '@/lib/companies'
import { attentionFor, markStateForSession } from '@/lib/mark-status'

import { ChatChannel } from './channel'
import type { ChannelMember, GroupChatRow } from './types'

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
  /** The feed. Empty until the groupchat WS lands (spec §8). */
  rows?: readonly GroupChatRow[]
  /** The rail's own company-hue scope (`agentHueVars`), so the composer's focus
   *  ring is the company's colour. A focus STATE, never a fill (contract C7). */
  style?: React.CSSProperties
  className?: string
}

export function GroupChatHero({ company, sessions, rows = [], style, className }: GroupChatHeroProps) {
  const isPhone = useMediaQuery('(max-width: 767px)')
  const members = useChannelMembers(sessions)
  if (!company) return null
  return (
    <ChatChannel
      company={company}
      members={members}
      rows={rows}
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
