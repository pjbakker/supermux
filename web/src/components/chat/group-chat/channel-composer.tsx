/**
 * The channel's composer — the app's own pill, wired to the Router.
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything visible is B0's: `<ComposerFrame>` (the inset + the stat/notice
 * parking spot), `<Composer>` (the glass pill, its focus ring, the 16px iOS
 * no-zoom floor, the contenteditable-on-phone swap), `COARSE_TARGET` (the
 * invisible 44pt hitbox), `.sm-mic` (the one inverted control). The `@` popover
 * is `<EntityPickerView>` — the same listbox the chat composer, the ⌘K palette
 * and the workflow prompt field all use — fed session rows with real
 * `<SessionMark>` faces.
 *
 * WHERE THE MESSAGE GOES, and why that is the whole design (spec §3.3, §4):
 * every human message is delivered to ONE session, the company's Main Assistant,
 * and to nobody else. The Router is the single fan-out throttle: it reads the
 * request, emits at most two `@tags`, and only those bots spend a turn. So the
 * composer does NOT deliver to a mentioned bot even when the draft names one —
 * an `@mention` is a HINT for the Router, and the control says so out loud
 * ("Send to <Assistant>"), because a control that silently routed elsewhere
 * depending on where an `@` sat in a sentence is exactly the failure
 * `delegate-intent.ts` was written to avoid.
 *
 * HONESTY WHEN IT CANNOT SEND: no Router session ⇒ the pill is `readOnly` and
 * says why in one line, rather than accepting keystrokes it will drop.
 */
import * as React from 'react'

import { SessionMark } from '@/brand/marks'
import { EntityPickerView } from '@/components/ui/entity-picker'
import type { EntityRow } from '@/lib/entity'
import { cn } from '@/lib/utils'

import type { ComposerField } from '../composer-draft'
import { COARSE_TARGET, ComposerFrame } from '../composer-shell'
import { readTrigger } from '../slash'
import { ArrowIcon, CheckIcon, Composer, MARK_SIZE, SpinnerIcon } from '../ui'

import type { ChannelMember } from './types'

/** How many members the `@` popover offers at once. A company roster is small;
 *  the cap is here so a 40-bot company cannot turn the hero into a scroller. */
const MAX_OFFERS = 8

export interface ChannelComposerProps {
  /** The channel's `#slug` — the placeholder's subject. */
  channel: string
  /** The `@` corpus. Only real members can be mentioned. */
  members: readonly ChannelMember[]
  surface?: 'desktop' | 'phone'
  /**
   * Deliver the message to the Router. Resolving means the SERVER accepted it —
   * not that the Router has read it. Absent ⇒ the pill is read-only.
   */
  onSend?: (text: string) => Promise<unknown>
  /** The Router's display name, for the send control's label. */
  routerLabel?: string
  /** Why sending is unavailable. Shown in place of the read-only hint. */
  disabledNote?: string
  /** The newest row's `seq`. When a row lands PAST the one in flight, the
   *  "routing…" pill has been answered — it clears itself. */
  lastSeq?: number
  className?: string
}

export function ChannelComposer({
  channel,
  members,
  surface = 'phone',
  onSend,
  routerLabel,
  disabledNote,
  lastSeq = 0,
  className,
}: ChannelComposerProps) {
  const phone = surface === 'phone'
  const fieldRef = React.useRef<ComposerField | null>(null)
  const [draft, setDraft] = React.useState('')
  const [caret, setCaret] = React.useState(0)
  const [active, setActive] = React.useState(0)
  const [byKey, setByKey] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  // Is the standing notice the live "routing…" beat (dots animate) or a refusal
  // (plain text)? The two look different and clear on different cues.
  const [routing, setRouting] = React.useState(false)
  // The brief ✓ that lands on the send button the instant the server accepts,
  // before the routing pill takes over — a tactile finish on the send itself.
  const [justSent, setJustSent] = React.useState(false)
  // The seq the feed was at when THIS message was accepted. The next row past it
  // is the router's answer, and the cue to retire the routing pill.
  const sentSeqRef = React.useRef<number | null>(null)
  const receiptTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // A safety cap: if the send is accepted but nothing ever posts to the channel,
  // the "routing…" pill must not hang forever.
  const routeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => () => {
    if (receiptTimer.current) clearTimeout(receiptTimer.current)
    if (routeTimer.current) clearTimeout(routeTimer.current)
  }, [])

  // Close the send→route loop: once a row lands past the one we sent under, the
  // router has spoken (or another message did) — drop the pill. Guarded on
  // `routing` so a normal scroll of the feed never clears a refusal notice.
  React.useEffect(() => {
    if (!routing || sentSeqRef.current === null) return
    if (lastSeq > sentSeqRef.current) {
      if (routeTimer.current) clearTimeout(routeTimer.current)
      setRouting(false)
      setNotice(null)
      sentSeqRef.current = null
    }
  }, [lastSeq, routing])

  // ── the `@` popover ───────────────────────────────────────────────────────
  // `readTrigger` is the chat composer's own rule for where a mention token
  // begins and ends — reused verbatim so the two surfaces cannot disagree about
  // when a popover is open.
  const trigger = React.useMemo(() => {
    const t = readTrigger(draft, caret)
    return t && t.kind === '@' ? t : null
  }, [draft, caret])

  const offers = React.useMemo<ChannelMember[]>(() => {
    if (!trigger) return []
    const q = trigger.query.toLowerCase()
    const hit = (m: ChannelMember) =>
      m.name.toLowerCase().includes(q) || m.seed.toLowerCase().includes(q)
    return members.filter(hit).slice(0, MAX_OFFERS)
  }, [trigger, members])

  const open = trigger !== null && offers.length > 0 && !!onSend
  const clamped = Math.min(active, Math.max(0, offers.length - 1))

  const rows = React.useMemo<EntityRow[]>(
    () =>
      offers.map((m) => ({
        id: m.seed,
        kind: 'session' as const,
        label: m.name,
        meta: m.name === m.seed ? undefined : m.seed,
        // A session's row wears its own face — the same rule the palette's
        // session rows follow, and the reason `EntityRowBase.leading` exists.
        leading: (
          <SessionMark
            seed={m.seed}
            pin={m.pin}
            size={MARK_SIZE.chip + 5}
            state={m.state}
            animate={false}
            label={null}
          />
        ),
        value: `@${m.name} `,
      })),
    [offers],
  )

  const focusField = () => fieldRef.current?.focus()

  const pick = React.useCallback(
    (index: number) => {
      const t = trigger
      const m = offers[index]
      if (!t || !m) return
      const value = `@${m.name} `
      const next = draft.slice(0, t.start) + value + draft.slice(t.end)
      const pos = t.start + value.length
      setDraft(next)
      setCaret(pos)
      setActive(0)
      // The caret has to land AFTER the inserted token or the popover reopens on
      // the text it just consumed.
      requestAnimationFrame(() => {
        const el = fieldRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    },
    [draft, offers, trigger],
  )

  // ── send ──────────────────────────────────────────────────────────────────
  const submit = React.useCallback(() => {
    const text = draft.trim()
    if (!onSend || sending || text.length === 0) return
    setSending(true)
    setNotice(null)
    setRouting(false)
    void onSend(text)
      .then(() => {
        setDraft('')
        setCaret(0)
        // 1) A tactile finish on the send itself: the arrow flips to a ✓ that
        //    pops in (`.grok-receipt`) for a beat before the pill takes over.
        setJustSent(true)
        if (receiptTimer.current) clearTimeout(receiptTimer.current)
        receiptTimer.current = setTimeout(() => setJustSent(false), 900)
        // 2) The optimistic half of §P0.1's "Assistant is routing…" beat — live
        //    anticipation, not dead text. It is a RECEIPT about delivery, not a
        //    claim the Router decided anything; the routing row arrives on the
        //    socket like any other, and clears this pill (the effect above).
        sentSeqRef.current = lastSeq
        setRouting(true)
        setNotice(`Sent to ${routerLabel ?? 'the assistant'} — routing`)
        if (routeTimer.current) clearTimeout(routeTimer.current)
        routeTimer.current = setTimeout(() => {
          setRouting(false)
          setNotice(null)
          sentSeqRef.current = null
        }, 6000)
      })
      // THE DRAFT SURVIVES A FAILURE, the same rule `handoffResult` states for
      // the chat composer's hand-off: a message that did not go is still the
      // sender's, and re-typing it is not an acceptable recovery.
      .catch((err: unknown) => {
        setRouting(false)
        sentSeqRef.current = null
        setNotice(err instanceof Error && err.message ? err.message : 'That didn’t send — your message is still here.')
      })
      .finally(() => setSending(false))
  }, [draft, lastSeq, onSend, routerLabel, sending])

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<Element>) => {
      if (open) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setByKey(true)
          setActive((i) => (i + 1) % offers.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setByKey(true)
          setActive((i) => (i - 1 + offers.length) % offers.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          pick(clamped)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setCaret(draft.length)
          return
        }
      }
      // Shift+Enter is a newline, everywhere in this app.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      }
    },
    [clamped, draft.length, offers.length, open, pick, submit],
  )

  const canSend = !!onSend && !sending && draft.trim().length > 0
  const hint = disabledNote ?? (onSend ? null : 'Sending isn’t available here yet.')

  return (
    <ComposerFrame surface={surface} className={cn('px-3.5 pb-3', className)}>
      <>
        {/* The one line above the pill. Absolutely positioned, so the surface at
            rest is exactly the boards and nothing below it ever reflows. */}
        {(notice || hint) && (
          <p
            role={notice ? 'status' : undefined}
            className={cn(
              'pointer-events-none absolute inset-x-0 -top-[22px] flex items-center justify-center gap-1.5 text-center',
              'text-[12.6px] tracking-[-0.05px] text-ink-2',
              // The routing pill ENTERS with the arrival pop; a refusal and the
              // read-only hint do not. `.grok-entry` is inert off the grok skin.
              routing && 'grok-entry',
              // The read-only hint is a hover-reveal (it is a standing fact);
              // a send receipt or a refusal is shown at once (it is news).
              !notice && 'opacity-0 transition-opacity duration-200 group-focus-within:opacity-100',
            )}
          >
            {notice ?? hint}
            {/* Three staggered dots — live anticipation while the router reads.
                Reduced motion keeps the .25/.45/.7 static stagger (the twin in
                grok-mode.css), so it still reads as three dots mid-wave. */}
            {routing && (
              <span className="grok-typing inline-flex items-center gap-[3px]" aria-hidden>
                <i className="inline-block size-[3px] rounded-full bg-current" />
                <i className="inline-block size-[3px] rounded-full bg-current" />
                <i className="inline-block size-[3px] rounded-full bg-current" />
              </span>
            )}
          </p>
        )}

        {open && (
          <div className="absolute inset-x-0 bottom-[calc(100%+8px)] z-20">
            <EntityPickerView
              rows={rows}
              activeIndex={clamped}
              surface={surface}
              anchor="token"
              ariaLabel={`Members of ${channel}`}
              scrollOnActive={byKey}
              onHover={(i) => {
                setByKey(false)
                setActive(i)
              }}
              onPick={(row) => {
                const i = rows.findIndex((r) => r.id === row.id)
                if (i >= 0) pick(i)
              }}
              testId="groupchat-mentions"
            />
          </div>
        )}

        <Composer
          size={phone ? 'mobile' : 'desktop'}
          placeholder={`Message ${channel}`}
          readOnly={!onSend}
          grown={draft.includes('\n')}
          field={{
            ref: fieldRef,
            value: draft,
            onChange: (e) => {
              setDraft(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setNotice(null)
              setRouting(false)
            },
            onSelect: (e) => setCaret(e.currentTarget.selectionStart ?? 0),
            onKeyDown,
            enterKeyHint: 'send',
            'data-testid': 'groupchat-composer-field',
          }}
          trailing={
            <button
              type="button"
              data-testid="groupchat-send"
              onClick={canSend ? submit : focusField}
              disabled={!canSend}
              aria-busy={sending || undefined}
              aria-label={
                routerLabel ? `Send to ${routerLabel}` : `Send to ${channel}`
              }
              title={routerLabel ? `Send to ${routerLabel}` : undefined}
              className={cn(
                'sm-mic relative grid flex-none place-items-center self-center rounded-full',
                phone ? 'size-9' : 'size-10',
                COARSE_TARGET,
                !canSend && 'opacity-60',
              )}
            >
              {sending ? (
                <SpinnerIcon />
              ) : justSent ? (
                // A ✓ that pops in on accept (`.grok-receipt`, reduced-motion:
                // shows without the pop) — the tactile finish, before the pill.
                <CheckIcon className="grok-receipt" />
              ) : (
                // The app's send is an UP arrow; `ArrowIcon` is the same stroke
                // pointing right, so it is turned rather than redrawn.
                <ArrowIcon className="-rotate-90" />
              )}
            </button>
          }
        />
      </>
    </ComposerFrame>
  )
}
