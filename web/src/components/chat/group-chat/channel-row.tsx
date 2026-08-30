/**
 * `<CompanyChannelRow>` — the company chat as a ROSTER ROW (desktop).
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner's ask: on desktop the group chat should behave like any other bot
 * chat — a row in the list, and a conversation in the right pane. So this is not
 * a card, a hero, or a doorway to another page: it is the roster's own Row A
 * anatomy (`.gr-rowA` → `.gr-row-open` base button + `.gr-top`/`.col`/`.l1`/`.l2`),
 * with the channel's identity in the mark slot.
 *
 * Reused, not rebuilt:
 *   · the FACEPILE cluster is the entry card's identity — WHO is in the room —
 *     and it occupies exactly one mark's footprint (40px), which is why the
 *     cluster variant exists at all.
 *   · the preview sentence is `channelPreview` (`surface.ts`), the same string
 *     the phone dock shows.
 *   · every visual is the roster's, so the pinned row cannot drift away from the
 *     bot rows it sits above as densities/themes change.
 *
 * Presentational only: it renders what the caller's `useCompanyChannel` already
 * resolved. The caller owns selection, so a click is just `onOpen`.
 */
import { compactAgo } from '@/lib/overview-layout'

import { Facepile, type FacepileMember } from '../ui'

import { channelPreview, CHANNEL_ROW_LABEL } from './surface'
import type { ChannelMember, GroupChatRow } from './types'

/** "3d" for the newest row. The clock is read HERE, outside the render body: a
 *  component that calls `Date.now()` while rendering is impure (and its output
 *  cannot be replayed) — the same shape `<GroupChatEntry>`'s own `agoOf` uses. */
function rowAgo(tsSeconds: number): string {
  return compactAgo(Date.now() / 1000 - tsSeconds)
}

export interface CompanyChannelRowProps {
  /** The company's own bots — the facepile, in roster order. */
  members: readonly ChannelMember[]
  /** The newest row in the feed, or `null` while empty/unseeded. */
  latest: GroupChatRow | null
  /** No seed has landed yet — suppresses the "nothing here" sentence. */
  loading: boolean
  /** Rows the reader has not seen. `0` draws no badge. */
  unread: number
  /** This row owns the right pane. */
  active: boolean
  onOpen: () => void
}

export function CompanyChannelRow({
  members,
  latest,
  loading,
  unread,
  active,
  onOpen,
}: CompanyChannelRowProps) {
  // `ChannelMember` IS a `FacepileMember` (seed/pin/name/state/attention); the
  // cluster draws the first three, so a 40-bot company still shows a tidy badge.
  const pile: readonly FacepileMember[] = members
  const preview = channelPreview(latest, loading)
  // The SAME clock the bot rows in this column use (`compactAgo`) — the entry
  // card's "3 d ago" phrasing would read as a different kind of thing one line
  // above a bot's "3d".
  const time = latest ? rowAgo(latest.ts) : ''

  return (
    <div className="gr-rowA" data-active={active || undefined} data-gc-row>
      {/* The SAME full-bleed base button every bot row uses — so this is one
          honest tab stop in the roster's natural order (it is the first row, so
          it is the first stop), and its focus ring is the roster's own. */}
      <button
        type="button"
        className="gr-row-open"
        data-vr="roster-company-chat"
        onClick={onOpen}
        aria-label={`Open Company chat${unread ? `, ${unread} unread` : ''}`}
      />
      <span className="gr-top">
        <Facepile members={pile} variant="cluster" ring={null} className="gr-mark" />
        <span className="col">
          <span className="l1">
            <span className="nm">{CHANNEL_ROW_LABEL}</span>
            {unread > 0 && (
              <span
                className="flex-none rounded-full bg-primary px-1.5 py-px text-[11px] font-semibold leading-[1.45] tabular-nums text-primary-foreground"
                aria-hidden
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
            {time && <span className="tm">{time}</span>}
          </span>
          <span className="l2">
            <span className="pv">{preview}</span>
          </span>
        </span>
      </span>
    </div>
  )
}

export default CompanyChannelRow
