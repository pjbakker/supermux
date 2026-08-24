// StepRail — one dot per step on a spine, and the whole "where is this thing"
// answer without opening anything.
//
// It is what makes a workflow feel alive instead of feeling like a cron row,
// and it is deliberately the ONLY animated element on a card: four pulsing
// things is a card that is hard to look at, so exactly one dot — the current
// one — breathes, and the segment behind it fills once.
//
// Accessibility: the rail is `aria-hidden` (a row of dots narrates as noise)
// and the same information is published as an sr-only `aria-live="polite"`
// sentence — "step 2 of 4: Draft the summary" — which is what a screen-reader
// user actually needs.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'

/** The rail's four states. `error` stops the rail at the failing dot — a rail
 *  that filled past a failure would be drawing progress that never happened. */
export type RailStatus = 'idle' | 'running' | 'done' | 'error'

export interface StepRailProps {
  /** How many steps the workflow has. */
  steps: number
  /** 1-based position of the step in flight (or the one that failed). */
  current?: number
  status?: RailStatus
  /** The current step's title, for the spoken line. */
  currentLabel?: string
  className?: string
}

/** How many dots are drawn before the rail collapses into a count. A 12-step
 *  workflow's rail is a barcode, not a status. */
const MAX_DOTS = 8

export function StepRail({
  steps,
  current = 0,
  status = 'idle',
  currentLabel,
  className,
}: StepRailProps) {
  const reduce = useReducedMotion()
  const n = Math.max(0, steps)
  if (n === 0) return null

  const shown = Math.min(n, MAX_DOTS)
  const dots = Array.from({ length: shown }, (_, i) => i + 1)
  // With more steps than dots the last dot stands for "…and the rest", so the
  // fill is scaled rather than lying about which one is lit.
  const scale = (k: number) => (n === shown ? k : Math.round((k * shown) / n))
  const at = scale(current)

  const spoken =
    status === 'running' && current > 0
      ? `Step ${current} of ${n}${currentLabel ? `: ${currentLabel}` : ''}`
      : status === 'error' && current > 0
        ? `Stopped at step ${current} of ${n}${currentLabel ? `: ${currentLabel}` : ''}`
        : status === 'done'
          ? `All ${n} steps finished`
          : `${n} step${n === 1 ? '' : 's'}, not running`

  return (
    <>
      <div
        aria-hidden="true"
        className={cn('flex min-w-0 items-center gap-0 py-0.5', className)}
        data-testid="step-rail"
        data-status={status}
      >
        {dots.map((k) => {
          const filled =
            status === 'done' || (status !== 'idle' && k < at) || (status === 'error' && k < at)
          const isCurrent = status !== 'idle' && k === at
          const failed = status === 'error' && isCurrent
          return (
            <React.Fragment key={k}>
              {k > 1 && (
                // The spine between two dots. It fills in 300ms as the chain
                // advances — the one place a duration is right, because the
                // segment is drawing a hand-off, not settling into place.
                <span className="relative h-[2px] w-3 shrink-0 overflow-hidden rounded-full bg-border sm:w-4">
                  <motion.span
                    className="absolute inset-y-0 left-0 bg-primary/70"
                    initial={false}
                    animate={{ width: filled || isCurrent ? '100%' : '0%' }}
                    transition={reduce ? { duration: 0 } : { duration: 0.3, ease: 'easeOut' }}
                  />
                </span>
              )}
              <span
                data-testid="step-dot"
                data-dot-state={failed ? 'error' : filled ? 'filled' : isCurrent ? 'current' : 'hollow'}
                className={cn(
                  'relative block size-2 shrink-0 rounded-full ring-1 transition-colors duration-150',
                  failed
                    ? 'bg-destructive ring-destructive'
                    : filled
                      ? 'bg-primary ring-primary'
                      : isCurrent
                        ? 'bg-primary/40 ring-primary'
                        : 'bg-transparent ring-border',
                )}
              >
                {/* The ONE animated element per card: the current dot's halo. */}
                {isCurrent && !failed && !reduce && (
                  <motion.span
                    className="absolute -inset-1 rounded-full bg-primary/25"
                    animate={{ opacity: [0.15, 0.6, 0.15], scale: [0.85, 1.15, 0.85] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
              </span>
            </React.Fragment>
          )
        })}
        {n > shown && <span className="ml-1.5 text-[11px] text-muted-foreground">+{n - shown}</span>}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {spoken}
      </span>
    </>
  )
}

/** The dot vocabulary, in ONE place, so the list rail and the run timeline
 *  cannot drift into two languages for the same six outcomes. */
export const STATUS_GLYPH: Record<string, { label: string; tone: string }> = {
  running: { label: 'running', tone: 'text-primary' },
  ok: { label: 'ok', tone: 'text-emerald-500' },
  skipped: { label: 'skipped', tone: 'text-muted-foreground' },
  error: { label: 'error', tone: 'text-destructive' },
  timeout: { label: 'timed out', tone: 'text-amber-500' },
  interrupted: { label: 'interrupted', tone: 'text-amber-500' },
  cancelled: { label: 'stopped', tone: 'text-muted-foreground' },
}

/** Map a run/step status onto the rail's four states. */
export function railStatusFor(status: string | null | undefined, running: boolean): RailStatus {
  if (running) return 'running'
  if (!status) return 'idle'
  if (status === 'ok') return 'done'
  if (status === 'running') return 'running'
  if (status === 'skipped' || status === 'cancelled') return 'idle'
  return 'error'
}
