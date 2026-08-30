// RecentRuns — the last few runs across ONE bot's workflows.
//
// The bot panel's second field. `RunTimeline` answers "what happened inside
// this run" for a single workflow and needs that workflow's step ledger to do
// it; this answers the cheaper question the panel actually asks — "has this bot
// been doing its jobs" — across all of them, from the cross-workflow activity
// feed, which is the only endpoint that returns runs without an id to ask for.
//
// The status vocabulary is NOT redefined here: the words, the glyphs and the
// duration formatter are imported from `run-timeline`, so a run that reads
// "timed out" in the panel reads "timed out" in the timeline it links to.

import * as React from 'react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { useWorkflowActivity, useWorkflows } from '@/hooks/use-workflows'

import { STEP_STATUS, dayLabel, duration } from './run-timeline'
import { workflowHref } from './workflow-href'

export function RecentRuns({ session, limit = 5 }: { session: string; limit?: number }) {
  const mine = useWorkflows(session)
  const activity = useWorkflowActivity()

  // The feed is company-wide; the panel is one bot. Its rows carry a
  // `workflow_id`, not a session, so the bot's own list is what scopes it.
  const ids = React.useMemo(
    () => new Set((mine.data ?? []).map((w) => w.id)),
    [mine.data],
  )
  const rows = React.useMemo(
    () => (activity.data ?? []).filter((r) => ids.has(r.workflow_id)).slice(0, limit),
    [activity.data, ids, limit],
  )

  if (activity.isLoading || mine.isLoading) {
    return <p className="text-[13px] text-muted-foreground">Loading runs…</p>
  }
  if (activity.error) {
    // Honesty rule: an unreachable feed is not an empty feed.
    return (
      <p className="text-[13px] text-muted-foreground">
        Couldn’t reach the run history.
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Nothing has run yet.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const status = STEP_STATUS[r.status] ?? STEP_STATUS.skipped
        const Icon = status.icon
        const took = r.finished_at ? duration(r.started_at, r.finished_at) : ''
        return (
          <li key={r.id}>
            <Link
              to={workflowHref(r.workflow_id)}
              className={cn(
                'flex min-h-11 w-full items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-1.5 text-left',
                'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  status.tone,
                  r.status === 'running' && 'animate-spin',
                )}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {r.title}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {status.label} · {dayLabel(r.started_at)}
                  {took ? ` · ${took}` : ''}
                  {r.note ? ` · ${r.note}` : ''}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
