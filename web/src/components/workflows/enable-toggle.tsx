// EnableToggle — the per-workflow pause switch. Spring-physics thumb
// (springs.toggleSnap) with an optimistic flip; on error it reverts and says
// so. ≥44pt hit target. Used in the list row and the detail header.
//
// Retyped from `components/scheduler/enable-toggle.tsx` onto `usePatchWorkflow`.
// The words changed with it: a workflow is PAUSED, not "disabled" — pausing is
// what the user is doing, and the server keeps the cadence on the row so
// resuming does not make them retype it.

import * as React from 'react'
import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { usePatchWorkflow } from '@/hooks/use-workflows'

interface EnableToggleProps {
  id: string
  enabled: boolean
  /** The workflow's title, so the announcement names WHICH one moved. */
  title?: string
  onError?: (message: string) => void
}

export function EnableToggle({ id, enabled, title, onError }: EnableToggleProps) {
  const patch = usePatchWorkflow()
  // Optimistic local mirror so the thumb moves the instant it is tapped, while
  // re-syncing to the prop when the server-confirmed value changes (the
  // store-during-render pattern — no setState-in-effect).
  const [on, setOn] = React.useState(enabled)
  const [lastProp, setLastProp] = React.useState(enabled)
  if (enabled !== lastProp) {
    setLastProp(enabled)
    setOn(enabled)
  }

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const next = !on
    setOn(next)
    patch.mutate(
      { id, patch: { enabled: next } },
      {
        onError: (err) => {
          setOn(!next) // revert — the row must not claim a state the server refused
          onError?.(`Couldn’t ${next ? 'resume' : 'pause'} — ${(err as Error).message}`)
        },
      },
    )
  }

  const what = title ? ` ${title}` : ''
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? `Pause${what}` : `Resume${what}`}
      onClick={toggle}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors',
        // ≥44pt tap target via a padding box, without inflating the switch.
        'before:absolute before:-inset-2.5 before:content-[""]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        on ? 'bg-primary' : 'bg-muted',
      )}
    >
      <motion.span
        layout
        transition={springs.toggleSnap}
        className={cn('block size-6 rounded-full bg-white shadow-sm', on ? 'ml-auto' : 'ml-0')}
      />
    </button>
  )
}
