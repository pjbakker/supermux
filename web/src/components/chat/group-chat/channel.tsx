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

import {
  ACCENT_INK_CLASS,
  accentInkVarsForSeed,
  ArrowIcon,
  CheckIcon,
  Facepile,
  MARK_SIZE,
  MentionChip,
  MessageRow,
  type FacepileMember,
} from '../ui'

import { ChatLoadingSkeleton } from '../chat-loading-skeleton'
import { ChannelComposer } from './channel-composer'

import { isGrouped, type ChannelMember, type GroupChatKind, type GroupChatRow } from './types'

// Full markdown for message bodies — bots post code fences, bullet lists and
// bold constantly, and the old hand-rolled linkifier rendered all of it as raw
// text with literal ** and backticks (below Slack AND Grok-bot). Reuse the 1:1
// chat's OWN renderer (mentions + code highlight + gfm), lazily so its heavy
// stack (react-markdown + rehype-highlight) stays off the app chunk — the exact
// discipline `transcript-item.tsx` uses. Suspense falls back to raw text at the
// same metrics, so a slow chunk never blanks a message.
const LazyChatMarkdown = React.lazy(() => import('../markdown/chat-markdown'))

/** A message body rendered as markdown, with the channel's members resolved as
 *  mention chips. Built from the channel's `members` map so an `@name` a human
 *  typed (the server keeps a human's `@`s) chips to the real bot face. */
function ChannelBody({
  text,
  members,
  surface,
}: {
  text: string
  members: ReadonlyMap<string, ChannelMember>
  surface: 'desktop' | 'phone'
}) {
  // `mentionSegments` wants lowercased-name → slug; `members` is already keyed
  // by lowercased seed AND name, so map its values to their seed.
  const mentions = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const [k, v] of members) m.set(k, v.seed)
    return m
  }, [members])
  const pinFor = React.useCallback(
    (seed: string) => members.get(seed.toLowerCase())?.pin,
    [members],
  )
  return (
    <React.Suspense
      fallback={<span className="whitespace-pre-wrap break-words">{text}</span>}
    >
      <LazyChatMarkdown text={text} mentions={mentions} pinFor={pinFor} surface={surface} />
    </React.Suspense>
  )
}

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
  fresh,
}: {
  row: GroupChatRow
  grouped: boolean
  members: ReadonlyMap<string, ChannelMember>
  ring: string
  surface: 'desktop' | 'phone'
  /** This row LANDED after mount — give it the arrival pop. A row already
   *  present at mount does not animate, or the whole history pops on every
   *  mount. `.grok-entry` is inert (and reduced-motion-safe) off the grok skin. */
  fresh?: boolean
}) {
  return (
    <MessageRow
      surface={surface}
      grouped={grouped}
      gutter={grouped ? undefined : <RowFace row={row} ring={ring} />}
      className={cn('px-3.5', fresh && 'grok-entry')}
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
          <div className="mt-0.5 text-[15px] leading-[1.45] tracking-[-0.1px] text-ink">
            <ChannelBody text={row.body} members={members} surface={surface} />
          </div>
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
      {/* The routing ACT is the chips above; the body is the distilled request
          the Router handed the bot — useful context, but the bot's PROMPT, not
          channel speech. Keep it quiet and clamped so a route reads as one calm
          line, not a wall of instruction. */}
      <p className="mt-1 line-clamp-2 break-words text-[13px] leading-[1.4] text-ink-3">
        {row.body}
      </p>
    </div>
  )
}

/** The Router is live on a turn — an "is routing…" row at the foot of the feed,
 *  on the SAME `MessageRow` grammar as every other row (face in the gutter +
 *  content), so it lines up and reads as the assistant thinking rather than as
 *  silence after a human posts. Driven by the Router's real session status; it
 *  unmounts the moment the turn ends (its routed/reply row lands). Reuses the
 *  composer's own `.grok-typing` dots (inert / reduced-motion-safe off-skin). */
function RouterTypingRow({
  seed,
  label,
  ring,
  surface,
}: {
  seed: string
  label: string
  ring: string
  surface: 'desktop' | 'phone'
}) {
  return (
    <MessageRow
      surface={surface}
      grouped={false}
      gutter={<SessionMark seed={seed} size={MARK_SIZE.gutter} ring={ring} animate={false} label={null} />}
      className="grok-entry px-3.5"
    >
      <div className="flex items-center gap-2 pt-0.5 text-[13.5px] text-ink-2">
        <span>{label} is routing</span>
        <span className="grok-typing inline-flex items-center gap-[3px]" aria-hidden>
          <i className="inline-block size-[3px] rounded-full bg-current" />
          <i className="inline-block size-[3px] rounded-full bg-current" />
          <i className="inline-block size-[3px] rounded-full bg-current" />
        </span>
      </div>
    </MessageRow>
  )
}

/** The same `HH:MM` the delayed-send chip prints (`chat/delay-send.ts`) — one
 *  clock format across the app, locale-driven. */
function hhmm(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Today / Yesterday / a full date — the day-divider's label. Relative words for
 *  the two the reader lives in, an absolute date beyond that (Slack's grammar). */
function dayLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const key = d.toDateString()
  const now = new Date()
  if (key === now.toDateString()) return 'Today'
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (key === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

/** A centred hairline marking a change of calendar day. Pure chrome, built from
 *  the surface's own `--gr-line` / `text-ink-3` — no new palette (spec §7.2.4). */
function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2" role="separator">
      <span className="h-px flex-1" style={{ background: 'var(--gr-line)' }} />
      <span className="flex-none text-[11px] font-medium uppercase tracking-[0.04em] text-ink-3">
        {dayLabel(ts)}
      </span>
      <span className="h-px flex-1" style={{ background: 'var(--gr-line)' }} />
    </div>
  )
}

/** Slack's most-missed-on-return affordance: one accent hairline with a "New"
 *  cap, drawn above the first unseen row. The state is already computed by
 *  `use-group-chat` (`firstUnreadSeq`), so this is nearly free. */
function UnreadDivider() {
  return (
    <div
      className="grok-entry flex items-center gap-2 px-3.5 py-1"
      role="separator"
      data-testid="group-chat-new-divider"
    >
      <span className="h-px flex-1 bg-primary/60" />
      <span className="flex-none text-[10.5px] font-semibold uppercase tracking-[0.06em] text-primary">
        New
      </span>
    </div>
  )
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
  /**
   * No seed has landed yet. The empty state is suppressed while this holds:
   * "we don't know yet" and "there is nothing" are different sentences, and
   * printing the second while the first is true is the lie this flag prevents.
   */
  loading?: boolean
  /** The data plane gave up. Says so once, quietly, above the feed. */
  error?: boolean
  /** There are older rows below the top of the window. */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  /** Rows that landed since the reader last saw the bottom. */
  unread?: number
  /** The `seq` of the first unseen row — draws the "New" separator above it. */
  firstUnreadSeq?: number | null
  /** The reader is looking at the newest row — clear the unread count. */
  onSeenBottom?: () => void
  /**
   * Deliver a human message to the Router. Absent ⇒ the composer is read-only.
   * Resolving means the SERVER accepted it, not that anyone has read it.
   */
  onSend?: (text: string) => Promise<unknown>
  /** The Router's display name — the send control says where it goes. */
  routerLabel?: string
  /** The Router (Main Assistant) is live on a turn right now — draws an "is
   *  routing…" typing row at the foot of the feed, driven by its REAL session
   *  status (the same signal the 1:1 chat's working row trusts), so a human who
   *  just posted sees the assistant thinking instead of silence. */
  routerWorking?: boolean
  /** The Router's session name (hue seed) for that typing row's face. */
  routerSeed?: string
  /** Why sending is unavailable, when it is. */
  composerNote?: string
  /** A control rendered at the START of the header row — the full-bleed
   *  `/company/:id/chat` page passes a Back button here so the channel keeps ONE
   *  header (no second bar stacked above it). Omitted on the overview. */
  headerLeading?: React.ReactNode
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
  loading = false,
  error = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  unread = 0,
  firstUnreadSeq = null,
  onSeenBottom,
  onSend,
  routerLabel,
  routerWorking = false,
  routerSeed,
  composerNote,
  headerLeading,
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

  // Newest-at-the-bottom, like every other transcript in the app — but STICKY,
  // not forced: a reader who has scrolled up to read an older row must not be
  // yanked back by the next milestone. `atBottomRef` is a ref rather than state
  // because the scroll handler runs on every frame of a flick and a `setState`
  // there would re-render the whole feed for a number nothing draws.
  const feedRef = React.useRef<HTMLDivElement | null>(null)
  const atBottomRef = React.useRef(true)
  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0

  // The arrival pop is for milestones that LAND, not for the history that was
  // already here. The hero MOUNTS EMPTY (loading), so freezing at mount would
  // capture seq 0 and pop the entire seed. Instead the baseline is frozen to the
  // FIRST non-empty window — the seed's high-water mark — the once it appears
  // (setting a ref during render is idempotent). Only rows past it get
  // `.grok-entry`, so the seed rests and the next socket row pops.
  const seqBaseline = React.useRef<number | null>(null)
  if (seqBaseline.current === null && lastSeq > 0) seqBaseline.current = lastSeq

  // A pill needs to know it is off the bottom, but the sticky-scroll logic must
  // stay on a ref (it runs every flick frame — state there would re-render the
  // feed for a number nothing draws). So: ref for the hot path, and a piece of
  // state flipped ONLY on the transition, cheap enough to gate a pill.
  const [atBottom, setAtBottom] = React.useState(true)

  const seen = React.useCallback(() => {
    if (atBottomRef.current) onSeenBottom?.()
  }, [onSeenBottom])

  const onScroll = React.useCallback(() => {
    const el = feedRef.current
    if (!el) return
    // 24px of slack: a phone's rubber-band and a sub-pixel row height both leave
    // a scroller a hair short of its own bottom.
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
    atBottomRef.current = bottom
    setAtBottom((was) => (was === bottom ? was : bottom))
    seen()
  }, [seen])

  const jumpToLatest = React.useCallback(() => {
    const el = feedRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
    seen()
  }, [seen])

  React.useEffect(() => {
    const el = feedRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
    seen()
  }, [lastSeq, seen])

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
        {headerLeading}
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
        {unread > 0 && (
          // The unread count, in the app's accent — an interactive-tier colour
          // on a badge that IS the "there is something below" affordance
          // (tapping the feed's bottom clears it). Never a bot hue.
          <span
            // `key={unread}` REMOUNTS the badge on every increment, which is what
            // re-fires `.grok-receipt`'s scale-up pop — a number that snaps reads
            // as news. Inert (and reduced-motion-safe) off the grok skin.
            key={unread}
            data-testid="group-chat-unread"
            className="grok-receipt flex-none rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
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
      {/* A `relative` shell so the jump-to-latest pill can float over the
          scroller's bottom-right without being clipped by its own overflow. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={feedRef}
        onScroll={onScroll}
        data-testid="group-chat-feed"
        // `overflow-anchor:auto` pins the reader's row when content grows above
        // it (a paged-in block, a late avatar) — a one-line scroll-hardening.
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-1 [overflow-anchor:auto]"
        style={{ maxHeight: feedMaxHeight }}
      >
        {error && rows.length === 0 && (
          // ONE quiet line, and only when there is nothing else to show. With
          // rows on screen the feed says nothing: they are still true, they are
          // simply not a claim about now — the same reading `connection.ts`
          // gives a reconnecting transcript.
          <p className="px-3.5 py-6 text-center text-[13px] leading-[1.5] text-ink-2">
            Can’t reach the channel right now.
          </p>
        )}
        {hasMore && rows.length > 0 && (
          <div className="flex justify-center pb-1 pt-2">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              data-testid="group-chat-earlier"
              className="sm-t-hover rounded-full px-3 py-1 text-[12.5px] text-ink-2 hover:bg-fill-soft hover:text-ink disabled:opacity-60"
            >
              {loadingMore ? 'Loading…' : 'Earlier messages'}
            </button>
          </div>
        )}
        {rows.length === 0 ? (
          // While the seed is in flight, a calm loading skeleton (the SAME one the
          // 1:1 chat uses) instead of a blank hero that flashes empty-then-full.
          // Only once we actually KNOW it is empty do we say so — no invented
          // welcome row (the server authors that, spec §3.1).
          loading ? (
            <ChatLoadingSkeleton />
          ) : error ? null : (
            <p className="px-3.5 py-6 text-center text-[13px] leading-[1.5] text-ink-2">
              No messages in #{company.slug} yet.
              <br />
              Milestones, completed workflows and routed requests will land here.
            </p>
          )
        ) : (
          <>
            {rows.map((row, i) => {
              const prev = rows[i - 1]
              // A calendar-day change draws a divider AND breaks grouping: a run
              // must never straddle midnight, or the day label lands mid-run with
              // no avatar under it.
              const newDay =
                !prev ||
                new Date(row.ts * 1000).toDateString() !== new Date(prev.ts * 1000).toDateString()
              const grouped = !newDay && isGrouped(row, prev)
              return (
                <React.Fragment key={row.seq}>
                  {newDay && <DayDivider ts={row.ts} />}
                  {firstUnreadSeq === row.seq && i > 0 && <UnreadDivider />}
                  <ChannelRow
                    row={row}
                    grouped={grouped}
                    members={byName}
                    ring={ring}
                    surface={surface}
                    fresh={seqBaseline.current !== null && row.seq > seqBaseline.current}
                  />
                </React.Fragment>
              )
            })}
            {routerWorking && routerSeed && (
              <RouterTypingRow
                seed={routerSeed}
                label={routerLabel ?? 'Assistant'}
                ring={ring}
                surface={surface}
              />
            )}
          </>
        )}
      </div>

        {/* ── jump-to-latest ─────────────────────────────────────────────────
            Only when the reader is BOTH scrolled up AND behind: a milestone
            landed below the fold. Taps to the newest row. Enters with the same
            `.grok-entry` pop the rows use (inert / reduced-motion-safe off-skin). */}
        {!atBottom && unread > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            data-testid="group-chat-jump"
            aria-label={`Jump to ${unread} new ${unread === 1 ? 'message' : 'messages'}`}
            className={cn(
              'grok-entry absolute bottom-3 right-3.5 z-10 flex items-center gap-1.5',
              'rounded-full bg-primary py-1 pl-3 pr-2.5 text-primary-foreground',
              'text-[12px] font-semibold tabular-nums shadow-lg shadow-black/20',
              'sm-t-hover hover:brightness-105 active:scale-95',
            )}
          >
            {unread > 99 ? '99+' : unread} New
            <ArrowIcon className="rotate-90" />
          </button>
        )}
      </div>

      {/* ── the composer ─────────────────────────────────────────────────────
          The app's own pill, wired to the ONE session a human message is
          allowed to wake: the company's Main Assistant (spec §3.3). See
          `channel-composer.tsx` for why an `@mention` is a hint to the Router
          rather than a second destination. */}
      <div className="flex-none pt-1.5">
        <ChannelComposer
          channel={`#${company.slug}`}
          members={members}
          surface={surface}
          onSend={onSend}
          routerLabel={routerLabel}
          disabledNote={composerNote}
          // The newest row's seq — the composer's "routing…" pill clears itself
          // when a later row (the router's reply) lands past the send.
          lastSeq={lastSeq}
          // No `pb-3`: let ComposerFrame's phone branch own the keyboard-safe
          // bottom pad (it zeros the home-indicator band on keyboard-open); a
          // fixed pad here silently overrode it via twMerge last-wins.
          className="px-3.5"
        />
      </div>

    </section>
  )
}

export default ChatChannel
