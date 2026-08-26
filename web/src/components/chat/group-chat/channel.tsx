/**
 * `<ChatChannel>` — the company group chat, as a CHANNEL (spec §7.1, direction B).
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a second chat surface. Every pixel here is one of B0's shipped primitives
 * with a channel's grammar laid over it:
 *
 *   row       `<MessageRow>` (`ui/bubble.tsx`) — the transcript's ONE row
 *             grammar, gutter + content, so the group chat's left edge lands on
 *             the same line the focused transcript's does. `grouped` keeps its
 *             meaning: 8px of air instead of 14, and the mark drawn once.
 *   face      `<SessionMark>` at `MARK_SIZE.gutter` for an agent,
 *             `<HumanMark>` at the same 28px for a human colleague — the
 *             three-shape identity convention, unchanged.
 *   name      the author's own pigment via `accentInkVarsForSeed` +
 *             `ACCENT_INK_CLASS` (`ui/accent-ink.ts`). Identity is carried by
 *             ink and by the mark, never by a fill (concept contract C7).
 *   @mention  `<MentionChip>` (`ui/system-line.tsx`) when the name resolves to a
 *             member — face + name in ITS pigment, the app's existing mention.
 *   routing   the Assistant's fan-out is a `Routed` row: "Routed to →" plus the
 *             tagged members as chips, so it reads as an ACT, not as a post
 *             (spec §7.2.2).
 *   composer  `<ComposerShell>` (`composer-shell.tsx`) — the same glass pill,
 *             the same read-only honesty note, `Message #<company>`.
 *
 * WHAT THE THREE KIND LABELS COST: one 10.5px uppercase chip beside the name,
 * tinted with a `--gr-*` STATUS tone (never a bot hue, never blue) — §7.2.4's
 * palette discipline. Workflow completions additionally get the spec's compact
 * card, because a `run_summary` is a server-authored artefact, not speech.
 *
 * Presentational only: it takes rows and members and renders pixels. The live
 * WS (`/ws/companies/{id}/groupchat`) and the composer's send land in the
 * follow-up (spec §8 steps 8–9); until then the composer is honestly read-only.
 */
import * as React from 'react'

import { SessionMark } from '@/brand/marks'
import { PAPER } from '@/brand/tokens'
import { useTheme } from '@/components/theme-provider'
import { CompanyMark } from '@/components/roster/company-mark'
import { HumanMark } from '@/components/roster/human-mark'
import { cn } from '@/lib/utils'

import { ComposerFrame } from '../composer-shell'
import {
  ACCENT_INK_CLASS,
  accentInkVarsForSeed,
  ArrowIcon,
  CheckIcon,
  Composer,
  Facepile,
  MARK_SIZE,
  MentionChip,
  MessageRow,
  type FacepileMember,
} from '../ui'

import { isGrouped, type ChannelMember, type GroupChatKind, type GroupChatRow } from './types'

/* ── the kind label ──────────────────────────────────────────────────────────
   Spec §7.2.1's differentiator, at the smallest weight that still separates:
   a chip beside the author name. The tone comes from the `--gr-*` status family
   the roster already speaks (`grok-mode.css`) — `--gr-work` for a milestone (a
   bot chose to speak), `--gr-done` for a completed run. `routed` is deliberately
   NEUTRAL ink: the router is chrome, and the loud part of its row is the tagged
   members' own pigment. Blue stays reserved for interactive (§7.2.4). */
const KIND_LABEL: Partial<Record<GroupChatKind, { text: string; tone: string | null }>> = {
  milestone: { text: 'Milestone', tone: 'var(--gr-work)' },
  workflow: { text: 'Workflow', tone: 'var(--gr-done)' },
  routed: { text: 'Routed', tone: null },
}

function KindLabel({ kind }: { kind: GroupChatKind }) {
  const label = KIND_LABEL[kind]
  if (!label) return null
  return (
    <span
      data-kind={kind}
      className="rounded-[var(--sm-r-xs,6px)] px-1.5 py-px text-[10.5px] font-semibold uppercase leading-[1.5] tracking-[0.04em]"
      style={
        label.tone
          ? { color: label.tone, background: `color-mix(in oklab, ${label.tone} 13%, transparent)` }
          : { color: 'var(--sm-ink-2)', background: 'var(--sm-fill-soft)' }
      }
    >
      {label.text}
    </span>
  )
}

/* ── @mentions in prose ──────────────────────────────────────────────────────
   A mention that resolves to a member becomes the app's own `<MentionChip>`
   (face + name in the member's pigment, zero layout cost). One that does not —
   `@all`, `@company`, a bot from another company — becomes a quiet highlight
   rather than a chip, because drawing a face for a session we cannot identify
   would be a confident lie about who is on it. */
const MENTION_RE = /(@[A-Za-z0-9][A-Za-z0-9._-]*)/g

function MessageText({
  body,
  members,
}: {
  body: string
  members: ReadonlyMap<string, ChannelMember>
}) {
  const parts = React.useMemo(() => body.split(MENTION_RE), [body])
  return (
    <>
      {parts.map((part, i) => {
        if (!part.startsWith('@')) return <React.Fragment key={i}>{part}</React.Fragment>
        const member = members.get(part.slice(1).toLowerCase())
        if (member) {
          return (
            <MentionChip
              key={i}
              seed={member.seed}
              pin={member.pin}
              name={`@${member.name}`}
            />
          )
        }
        return (
          <span key={i} className="font-medium text-primary">
            {part}
          </span>
        )
      })}
    </>
  )
}

/* ── one row ─────────────────────────────────────────────────────────────── */

function RowFace({ row, ring }: { row: GroupChatRow; ring: string }) {
  if (row.authorKind === 'human') {
    return <HumanMark seed={row.authorSeed} name={row.authorName} size={MARK_SIZE.gutter} />
  }
  return (
    <SessionMark
      seed={row.authorSeed}
      size={MARK_SIZE.gutter}
      ring={ring}
      animate={false}
      label={null}
    />
  )
}

function ChannelRow({
  row,
  grouped,
  members,
  ring,
  surface,
}: {
  row: GroupChatRow
  grouped: boolean
  members: ReadonlyMap<string, ChannelMember>
  ring: string
  surface: 'desktop' | 'phone'
}) {
  return (
    <MessageRow
      surface={surface}
      grouped={grouped}
      gutter={grouped ? undefined : <RowFace row={row} ring={ring} />}
      className="px-3.5"
    >
      {/* `min-w-0` is what keeps a long word / a path inside 390px: the row is a
          flex container and a flex item's default `min-width:auto` would let the
          text push the whole channel wider than the phone. */}
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              style={accentInkVarsForSeed(row.authorSeed)}
              className={cn(
                ACCENT_INK_CLASS,
                'text-[14px] font-semibold tracking-[-0.1px]',
                // A human colleague is named in plain ink: the pigment belongs to
                // the circle mark, and a channel where every name is coloured is
                // a channel where colour means nothing.
                row.authorKind === 'human' && 'text-ink',
              )}
            >
              {row.authorName}
            </span>
            <KindLabel kind={row.kind} />
            <time
              dateTime={new Date(row.ts * 1000).toISOString()}
              className="text-[11.5px] tabular-nums text-ink-3"
            >
              {hhmm(row.ts)}
            </time>
          </div>
        )}

        {row.kind === 'workflow' ? (
          <WorkflowCard row={row} />
        ) : row.kind === 'routed' ? (
          <RoutedBody row={row} members={members} />
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-[1.45] tracking-[-0.1px] text-ink">
            <MessageText body={row.body} members={members} />
          </p>
        )}
      </div>
    </MessageRow>
  )
}

/** Spec §7.2.1: a completed run is a compact CARD, not a bubble — a
 *  server-authored `run_summary` with a success check, so it never reads as
 *  something a bot chose to say. Built from the same hairline/fill tokens the
 *  rest of the surface uses; no new palette. */
function WorkflowCard({ row }: { row: GroupChatRow }) {
  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-[12px] border-[0.5px] border-hairline-soft bg-fill-soft px-3 py-2">
      <span className="mt-[3px] flex-none" style={{ color: 'var(--gr-done)' }}>
        <CheckIcon />
      </span>
      <div className="min-w-0 flex-1">
        {row.runLabel && (
          <p className="truncate text-[13.5px] font-semibold tracking-[-0.1px] text-ink">
            {row.runLabel}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-ink-2">
          {row.body}
        </p>
      </div>
    </div>
  )
}

/** Spec §7.2.2: the Assistant's fan-out reads as a routing ACT — "Routed to →"
 *  plus the tagged members as their own chips, then the one-sentence why. */
function RoutedBody({
  row,
  members,
}: {
  row: GroupChatRow
  members: ReadonlyMap<string, ChannelMember>
}) {
  const tagged = (row.tags ?? [])
    .map((t) => members.get(t.toLowerCase()))
    .filter((m): m is ChannelMember => Boolean(m))
  return (
    <div className="mt-0.5">
      {tagged.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-2">
          <span>Routed to</span>
          <ArrowIcon className="flex-none text-ink-3" />
          {tagged.map((m) => (
            <MentionChip key={m.seed} seed={m.seed} pin={m.pin} name={`@${m.name}`} />
          ))}
        </div>
      )}
      <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-ink-2">
        <MessageText body={row.body} members={members} />
      </p>
    </div>
  )
}

/** The same `HH:MM` the delayed-send chip prints (`chat/delay-send.ts`) — one
 *  clock format across the app, locale-driven. */
function hhmm(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* ── the channel ─────────────────────────────────────────────────────────── */

export interface ChatChannelProps {
  /** The company this channel belongs to — its mark and its `#slug`. */
  company: { slug: string; display_name: string }
  /** Everyone in the channel, in roster order. Drives the header facepile AND
   *  the `@mention` resolver, so a mention can only ever name a real member. */
  members: readonly ChannelMember[]
  /** Oldest → newest. Empty renders the honest empty state, never filler. */
  rows: readonly GroupChatRow[]
  surface?: 'desktop' | 'phone'
  /** Max height of the SCROLLING feed. The channel is a hero on the overview,
   *  not the page — it must never eat the roster below it. */
  feedMaxHeight?: number | string
  /** Merged into the section's own ground — the caller's hue scope. */
  style?: React.CSSProperties
  className?: string
}

export function ChatChannel({
  company,
  members,
  rows,
  surface = 'phone',
  feedMaxHeight = 320,
  style,
  className,
}: ChatChannelProps) {
  const { resolvedTheme } = useTheme()
  const ring = PAPER[resolvedTheme === 'dark' ? 'dark' : 'light'].paperRaised

  // The `@mention` resolver: name → member, lower-cased. Built once per member
  // list so a 40-row feed does not rebuild it per row.
  const byName = React.useMemo(() => {
    const map = new Map<string, ChannelMember>()
    for (const m of members) {
      map.set(m.seed.toLowerCase(), m)
      map.set(m.name.toLowerCase(), m)
    }
    return map
  }, [members])

  const pile = React.useMemo<FacepileMember[]>(
    () => members.map((m) => ({ seed: m.seed, pin: m.pin, name: m.name, state: m.state, attention: m.attention })),
    [members],
  )

  // Newest-at-the-bottom, like every other transcript in the app.
  const feedRef = React.useRef<HTMLDivElement | null>(null)
  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0
  React.useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastSeq])

  return (
    <section
      data-testid="group-chat-channel"
      // `overflow-x-hidden` is the phone contract: nothing inside this hero may
      // ever hand the page a horizontal scrollbar (spec §7.2.5).
      className={cn('flex min-w-0 flex-col overflow-x-hidden', className)}
      style={{ background: 'var(--gr-surf)', ...style }}
      aria-label={`Group chat for ${company.display_name}`}
    >
      {/* ── channel header: company mark · #slug · member facepile ─────────── */}
      <header
        className="flex flex-none items-center gap-2.5 px-3.5 py-2.5"
        style={{ borderBottom: '0.5px solid var(--gr-line)' }}
      >
        {/* The company hue lives HERE and nowhere else on the surface (§7.2.4). */}
        <CompanyMark slug={company.slug} name={company.display_name} size={24} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold tracking-[-0.2px] text-ink">
            #{company.slug}
          </p>
          <p className="truncate text-[11.5px] text-ink-2">
            {members.length === 1 ? '1 member' : `${members.length} members`}
          </p>
        </div>
        {pile.length > 0 && (
          <Facepile
            members={pile.slice(0, 6)}
            variant="row"
            size={MARK_SIZE.facepile + 4}
            ring={ring}
            className="flex-none"
          />
        )}
      </header>

      {/* ── the feed ───────────────────────────────────────────────────────── */}
      <div
        ref={feedRef}
        data-testid="group-chat-feed"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-1"
        style={{ maxHeight: feedMaxHeight }}
      >
        {rows.length === 0 ? (
          // HONEST EMPTY: the channel exists, nothing has been said in it. No
          // invented welcome row — the server authors that (spec §3.1).
          <p className="px-3.5 py-6 text-center text-[13px] leading-[1.5] text-ink-2">
            No messages in #{company.slug} yet.
            <br />
            Milestones, completed workflows and routed requests will land here.
          </p>
        ) : (
          rows.map((row, i) => (
            <ChannelRow
              key={row.seq}
              row={row}
              grouped={isGrouped(row, rows[i - 1])}
              members={byName}
              ring={ring}
              surface={surface}
            />
          ))
        )}
      </div>

      {/* ── the composer ─────────────────────────────────────────────────────
          The SAME glass pill the focused transcript uses, in the SAME frame
          (`ComposerFrame`), with the same honesty rung: `readOnly`, and the
          "why" revealed on focus at zero layout cost. Its copy is this
          surface's own, because "switch to Terminal" is not the answer here —
          the send path is a waking delegate into the Main Assistant and it
          lands in the follow-up (spec §8 step 9). */}
      <div className="flex-none pt-1.5">
        <ComposerFrame surface={surface} className="px-3.5 pb-3">
          <>
            <p
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-x-0 -top-[22px] text-center',
                'text-[12.6px] tracking-[-0.05px] text-ink-2',
                'opacity-0 transition-opacity duration-200 group-focus-within:opacity-100',
              )}
            >
              Read-only preview — sending isn’t wired up yet.
            </p>
            <Composer
              size={surface === 'phone' ? 'mobile' : 'desktop'}
              readOnly
              placeholder={`Message #${company.slug}`}
            />
          </>
        </ComposerFrame>
      </div>
    </section>
  )
}

export default ChatChannel
