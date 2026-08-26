/**
 * `<GroupChatEntry>` — the company group chat's COMPACT doorway on the overview.
 * ─────────────────────────────────────────────────────────────────────────────
 * The channel is a DESTINATION, not a hero. The overview shows one calm row —
 * the company mark, `#slug`, the member count, and the latest line — with an
 * unread badge when there is one. Tapping it OPENS the full-bleed
 * `/company/:id/chat` page, where the channel finally has the whole screen to
 * feel like a real channel. This ends the "worst of both worlds" the embedded
 * hero was: it neither eats the roster (one row, not a third of the screen) nor
 * cramps the chat (the chat is now a page, not a peek).
 *
 * It is slightly LOUDER than a bot row on purpose — a raised card, a member
 * count, a live preview — because it stands for everyone in the company, not one
 * bot. But it is still one row.
 *
 * ENABLEMENT is the Router's existence (see `useCompanyChannel`): HQ and a
 * company that never opted in render NOTHING here, so the overview is
 * byte-identical to before until a company actually has a channel.
 */
import * as React from 'react'
import { ChevronRight } from 'lucide-react'

import type { ApiSession } from '@/lib/api'
import { ago } from '@/lib/api/browser'
import type { Company } from '@/lib/companies'
import { CompanyMark } from '@/components/roster/company-mark'
import { cn } from '@/lib/utils'

import { useCompanyChannel } from './use-company-channel'
import type { GroupChatRow } from './types'

/** One line of preview for the latest row — "author: body", the routing/
 *  milestone verbs left to the full channel. Kept short; the row truncates. */
function previewOf(row: GroupChatRow): string {
  const body = row.body.replace(/\s+/g, ' ').trim()
  return row.authorName ? `${row.authorName}: ${body}` : body
}

export interface GroupChatEntryProps {
  /** The active company, or `null` for HQ (renders nothing). */
  company: Company | null
  /** The sessions already scoped to that company by the caller. */
  sessions: readonly ApiSession[]
  /** Open the full channel — the caller navigates to `/company/:id/chat`
   *  (phone and desktop alike; the channel wants the whole screen). */
  onOpen: () => void
  /** The rail's own company-hue scope, merged into the card ground. */
  style?: React.CSSProperties
  className?: string
}

export function GroupChatEntry({ company, sessions, onOpen, style, className }: GroupChatEntryProps) {
  const channel = useCompanyChannel(company, sessions)
  const { enabled, members, feed } = channel

  const latest = feed.rows.length > 0 ? feed.rows[feed.rows.length - 1]! : null
  const nowSec = Math.floor(Date.now() / 1000)

  // HQ, or a company that never enabled group chat: nothing at all.
  if (!enabled || !company) return null

  const memberWord = members.length === 1 ? 'member' : 'members'
  const preview = latest
    ? previewOf(latest)
    : feed.isLoading
      ? 'Opening the channel…'
      : 'No messages yet — start the conversation'

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${company.display_name} chat${feed.unread ? `, ${feed.unread} unread` : ''}`}
      style={style}
      className={cn(
        'gc-entry group flex w-full items-center gap-3 rounded-2xl border-[0.5px] border-hairline bg-fill-soft px-3 py-2.5 text-left',
        'transition-[transform,background-color] hover:bg-fill-soft/70 active:scale-[0.99]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <CompanyMark
        slug={company.slug}
        name={company.display_name}
        size={38}
        className="flex-none"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold tracking-[-0.1px] text-ink">
            #{company.slug}
          </span>
          <span className="flex-none text-[12px] text-ink-3">
            · {members.length} {memberWord}
          </span>
          {latest && (
            <span className="ml-auto flex-none pl-1 text-[11.5px] tabular-nums text-ink-3">
              {ago(nowSec - latest.ts)}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[13px] leading-[1.35] text-ink-2">{preview}</p>
      </div>
      {feed.unread > 0 && (
        <span
          className="flex-none rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
          aria-hidden
        >
          {feed.unread > 99 ? '99+' : feed.unread}
        </span>
      )}
      <ChevronRight
        className="size-4 flex-none text-ink-3 transition-transform group-active:translate-x-0.5"
        aria-hidden
      />
    </button>
  )
}

export default GroupChatEntry
