/**
 * SEND LATER — the receipt, above the pill.
 * ─────────────────────────────────────────────────────────────────────────────
 * When a delay is picked the message LEAVES the composer, and something has to
 * say where it went. That is this: one small glass chip per queued send, in the
 * same above-pill stack as the refusal banner, the `@`/`/` picker and the
 * attachment chips — so it reads as part of the one composer unit and the pill's
 * radius never clips it.
 *
 * WHAT IT SAYS IS WHAT IS TRUE. "Queued · sends in 1h" counts down against the
 * schedule's OWN `next_run` (the server's number, not the browser's arithmetic),
 * and when that moment passes it says "Sending…" for the length of the runner's
 * tick rather than vanishing a beat before the words arrive. Cancel deletes the
 * schedule and puts the message back in the box.
 *
 * THE CANCEL WINDOW CLOSES AT `dueMs`, not at the end of that settle window, and
 * this is the chip's one load-bearing rule (`delay-send.ts::isCancellable`). The
 * runner delivers a due one-shot on its next tick, and the DELETE endpoint
 * removes a row by id whether or not it has fired — so a Cancel offered while
 * the chip reads "Sending…" could come back 200 on a message already IN the
 * session and hand the words back as if nothing had gone out. Past `dueMs` the
 * send is committed: the control is not drawn at all, because a disabled Cancel
 * still reads as "you nearly could have".
 *
 * MOTION. Entry is `springs.cardExpand` — the chip lifts into the stack the way
 * every raised surface in this app does; exit is the faster `tweens.popoverOut`,
 * because the app's rule is that exits never linger. Under
 * `prefers-reduced-motion` both collapse to `motionOff` and the chip simply is
 * or is not there.
 */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { motionOff, springs, tweens } from '../../lib/springs'
import { cn } from '../../lib/utils'

import { COARSE_TARGET } from './composer-shell'
import { countdownLabel, DELAY_OPTIONS, isCancellable, type QueuedSend } from './delay-send'
import { ClockIcon } from './ui'

export interface QueuedSendsProps {
  queued: readonly QueuedSend[]
  /** The clock the countdowns are read against (the hook's ticker). */
  nowMs: number
  /** Delete the schedule and put the words back in the composer. */
  onCancel: (id: string) => void
  /** A write is in flight — Cancel goes inert rather than firing twice. */
  busy?: boolean
  /** The last failure, in the server's own words; null when all is well. */
  error?: string | null
  onDismissError?: () => void
  phone?: boolean
}

/** The stable sentence a screen reader hears once, when the chip appears — the
 *  visible countdown is `aria-hidden`, because a region that re-announces every
 *  second is worse than one that does not announce at all. Past the fire time it
 *  says the other true thing, and it says it once. */
function spokenFor(item: QueuedSend, due: boolean): string {
  if (due) return 'Queued message is being sent now.'
  const option = DELAY_OPTIONS.find((o) => o.key === item.optionKey)
  return option
    ? `Message queued — sending ${option.label.toLowerCase()}.`
    : 'Message queued to send later.'
}

export function QueuedSends({
  queued,
  nowMs,
  onCancel,
  busy,
  error,
  onDismissError,
  phone,
}: QueuedSendsProps) {
  const reduce = useReducedMotion() ?? false
  if (!queued.length && !error) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="chat-queued-sends"
      className="mb-2 flex flex-wrap items-center justify-end gap-1.5"
    >
      <AnimatePresence initial={false}>
        {queued.map((item) => {
          const left = item.dueMs - nowMs
          const due = left <= 0
          // The one gate: strictly before `dueMs` (see the header).
          const cancellable = isCancellable(item, nowMs)
          return (
            <motion.span
              key={item.id}
              layout={reduce ? false : 'position'}
              initial={reduce ? false : { opacity: 0, y: 6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              // The exit carries its OWN, faster transition (the app's rule:
              // an exit never lingers) — `tweens.popoverOut`, 100ms, against
              // the entry spring's ~320ms settle.
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, y: 4, scale: 0.96, transition: tweens.popoverOut }
              }
              transition={reduce ? motionOff : springs.cardExpand}
              data-testid="chat-queued-chip"
              // The message itself, on hover — which of two queued sends this is
              // should never require cancelling one to find out.
              title={item.text}
              className={cn(
                'sm-t-hover inline-flex max-w-full items-center gap-1.5 rounded-full',
                'border-[0.5px] border-hairline bg-surface py-1 pl-2.5 pr-1',
                'backdrop-blur-[60px] backdrop-saturate-[180%] shadow-[var(--sm-popover-shadow)]',
                phone ? 'text-[12px]' : 'text-[12.5px]',
                'tracking-[-0.05px] text-ink-2',
              )}
            >
              <ClockIcon className={due ? 'text-brand' : undefined} />
              <span className="sr-only">{spokenFor(item, due)}</span>
              <span aria-hidden className="text-ink">
                {due ? 'Sending…' : 'Queued'}
              </span>
              {!due && (
                <>
                  <span aria-hidden className="text-ink-3">
                    ·
                  </span>
                  <span aria-hidden className="tabular-nums">
                    {countdownLabel(left)}
                  </span>
                </>
              )}
              {cancellable ? (
                <button
                  type="button"
                  data-testid="chat-queued-cancel"
                  aria-label="Cancel this queued message and put it back in the composer"
                  disabled={busy}
                  onClick={() => onCancel(item.id)}
                  className={cn(
                    'sm-t-hover relative ml-0.5 rounded-full px-2 py-0.5 font-medium',
                    'text-ink-2 hover:bg-fill-soft hover:text-ink',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hairline',
                    'disabled:pointer-events-none disabled:opacity-50',
                    // The invisible 44pt target every control on this bar grows on
                    // a coarse pointer — a chip is small, and Cancel is the one
                    // control here somebody reaches for in a hurry.
                    COARSE_TARGET,
                  )}
                >
                  Cancel
                </button>
              ) : (
                // Past `dueMs` there is nothing left to offer — the words are on
                // their way. The cell keeps the chip's right-hand padding so it
                // does not jump width as the countdown runs out.
                <span aria-hidden className="ml-0.5 px-2 py-0.5" />
              )}
            </motion.span>
          )
        })}
      </AnimatePresence>
      {error && (
        <p
          data-testid="chat-queued-error"
          className={cn(
            'flex w-full items-center gap-1.5 rounded-2xl border-[0.5px] border-status-error/30',
            'bg-status-error/10 px-3.5 py-2 text-[12.6px] tracking-[-0.05px] text-status-error',
          )}
        >
          <span aria-hidden>⚠</span>
          <span className="min-w-0 flex-1">Couldn’t queue that — {error}</span>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              className="sm-t-hover relative flex-none rounded-full px-2 py-0.5 font-medium hover:bg-status-error/10"
            >
              Dismiss
            </button>
          )}
        </p>
      )}
    </div>
  )
}

export default QueuedSends
