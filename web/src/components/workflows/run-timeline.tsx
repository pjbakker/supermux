// RunTimeline — what actually happened, with the same dot vocabulary the list's
// step rail uses. One language for six outcomes, in two surfaces.
//
// THE HONESTY RULE lives here more visibly than anywhere else in the feature.
// supermux has no MCP client: a `connector_send` ending is an INSTRUCTION
// delivered to the bot's pane, not an email leaving a server. So the ending
// line says "asked scout to send via Gmail" and there is no phrasing in this
// file — or reachable from it — that claims something was sent.
//
// The delivered preview is the PLAIN prompt line. The `<supermux-schedule>`
// wrapper and the agent-confirm footer are machine scaffolding; the server
// already strips both before storing, and `plainPreview` strips them again
// here, because a wrapper leaking into a UI is how a user learns to distrust
// everything else on the page.

import * as React from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock,
  Loader2,
  Minus,
  Unlink,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type {
  CompletionAction,
  WorkflowRunDetail,
  WorkflowStepRow,
} from '@/lib/api/workflows'

import { botThreadHref } from './workflow-href'

const WRAPPER_TAG = 'supermux-schedule'
/** The line that opens the agent-confirm footer (engine::CONFIRM_FOOTER_SENTINEL). */
const CONFIRM_SENTINEL = '— — —'

/**
 * The plain line a step actually delivered.
 *
 * Defensive on purpose: the server strips the wrapper and the footer, and this
 * strips them again. Two implementations of the same rule is a cost worth
 * paying here — an old row written before the stripping landed, or a future
 * wrapper this client does not know about, must not put machine scaffolding in
 * front of a person.
 */
export function plainPreview(raw: string | null | undefined): string {
  let s = (raw ?? '').trim()
  if (!s) return ''
  const open = s.indexOf(`<${WRAPPER_TAG}`)
  if (open >= 0) {
    const gt = s.indexOf('>', open)
    const close = s.indexOf(`</${WRAPPER_TAG}>`)
    if (gt >= 0) s = close > gt ? s.slice(gt + 1, close) : s.slice(gt + 1)
  }
  const cut = s.indexOf(CONFIRM_SENTINEL)
  if (cut >= 0) s = s.slice(0, cut)
  return s.replace(/<\/?supermux-[a-z-]+[^>]*>/g, '').trim()
}

/** Six outcomes, one vocabulary. Shared with the list's rail by intent — the
 *  words and the glyphs are defined once, here, and read there. */
export const STEP_STATUS: Record<
  string,
  { label: string; icon: typeof Check; tone: string }
> = {
  running: { label: 'running', icon: Loader2, tone: 'text-primary' },
  ok: { label: 'done', icon: Check, tone: 'text-emerald-500' },
  skipped: { label: 'skipped', icon: Minus, tone: 'text-muted-foreground' },
  error: { label: 'failed', icon: AlertCircle, tone: 'text-destructive' },
  timeout: { label: 'timed out', icon: Clock, tone: 'text-amber-500' },
  interrupted: { label: 'interrupted', icon: Unlink, tone: 'text-amber-500' },
  cancelled: { label: 'stopped', icon: Minus, tone: 'text-muted-foreground' },
}

/** The chip a status glyph sits in — the tinted wash + the glyph's own colour,
 *  keyed by the same six outcomes as {@link STEP_STATUS}. Encoding the outcome in
 *  FORM (a coloured chip), not just a word, is what makes a run scannable. */
const STATUS_CHIP: Record<string, string> = {
  running: 'bg-primary/15 text-primary',
  ok: 'bg-emerald-500/15 text-emerald-500',
  skipped: 'bg-muted text-muted-foreground',
  error: 'bg-destructive/15 text-destructive',
  timeout: 'bg-amber-500/15 text-amber-500',
  interrupted: 'bg-amber-500/15 text-amber-500',
  cancelled: 'bg-muted text-muted-foreground',
}

/** The card wash for a run that did NOT end clean — a faint semantic tint so a
 *  failure or a timeout reads at a glance in a stack of clean runs, without an
 *  accent rail. Clean / running / skipped keep the neutral card. */
const RUN_WASH: Record<string, string> = {
  error: 'border-destructive/25 bg-destructive/[0.045]',
  timeout: 'border-amber-500/25 bg-amber-500/[0.045]',
  interrupted: 'border-amber-500/25 bg-amber-500/[0.045]',
}

/** How a step ended, in words rather than in an enum value. */
export function signalLabel(signal: string): string {
  switch (signal) {
    case 'agent-confirmed':
      return 'the bot said it was done'
    case 'status-idle':
      return 'the bot went quiet'
    case 'timeout':
      return 'it ran out of time'
    case 'interrupted':
      return 'the session went away'
    default:
      return signal || ''
  }
}

/**
 * The ending line for a finished run.
 *
 * ALWAYS "asked", never "sent". The server delivers an instruction to a pane;
 * whether the mail left is between the bot and its connector, and this surface
 * does not know. Claiming otherwise would be the single most expensive lie in
 * the product.
 */
export function runEndingLine(action: CompletionAction, session: string): string | null {
  switch (action.kind) {
    case 'none':
      return null
    case 'notify':
      return 'You were notified.'
    case 'disable':
      return 'The workflow paused itself afterwards.'
    case 'message_bot':
      return `The run summary was handed to ${action.session}.`
    case 'connector_send':
      return `${session} was asked to send the summary${action.to ? ` to ${action.to}` : ''}.`
  }
}

/** "41 s", "2 min 4 s", "—" while still running. */
export function duration(started: number, finished: number | null): string {
  if (!finished) return ''
  const s = Math.max(0, finished - started)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} min ${rest} s` : `${m} min`
}

/** Today / Yesterday / a date — the header a run is filed under. */
export function dayLabel(epochSeconds: number, now: Date = new Date()): string {
  const d = new Date(epochSeconds * 1000)
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export interface RunTimelineProps {
  runs: WorkflowRunDetail[]
  /** The workflow's current steps, for titles a run row does not carry. */
  steps: WorkflowStepRow[]
  session: string
  onComplete?: CompletionAction
  /** Cap the rendered runs (the bot panel shows the last few). */
  limit?: number
  loading?: boolean
  /** Open every step node. The offline bench uses it to review the expanded
   *  state; nothing in the app passes it. */
  expandAll?: boolean
}

export function RunTimeline({
  runs,
  steps,
  session,
  onComplete,
  limit,
  loading,
  expandAll,
}: RunTimelineProps) {
  const shown = limit ? runs.slice(0, limit) : runs

  if (loading) {
    return <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">Loading runs…</p>
  }
  if (shown.length === 0) {
    return (
      <div className="px-1 py-8 text-center">
        <p className="text-[13.5px] text-foreground">It hasn’t run yet.</p>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Every run shows up here — what it did, how long it took, and where it stopped.
        </p>
      </div>
    )
  }

  // Group by day, preserving the newest-first order the server sent.
  const groups: { label: string; runs: WorkflowRunDetail[] }[] = []
  for (const r of shown) {
    const label = dayLabel(r.run.started_at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.runs.push(r)
    else groups.push({ label, runs: [r] })
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.label} className="flex flex-col gap-2">
          <h3 className="px-1 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
            {g.label}
          </h3>
          {g.runs.map((r) => (
            <RunCard
              key={r.run.id}
              detail={r}
              steps={steps}
              session={session}
              onComplete={onComplete}
              expandAll={expandAll}
            />
          ))}
        </section>
      ))}
    </div>
  )
}

function RunCard({
  detail,
  steps,
  session,
  onComplete,
  expandAll,
}: {
  detail: WorkflowRunDetail
  steps: WorkflowStepRow[]
  session: string
  onComplete?: CompletionAction
  expandAll?: boolean
}) {
  const { run } = detail
  const status = STEP_STATUS[run.status] ?? STEP_STATUS.skipped
  const Icon = status.icon
  const when = new Date(run.started_at * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const dur = run.finished_at ? duration(run.started_at, run.finished_at) : ''
  const trigger =
    run.trigger === 'tick' ? 'on schedule' : run.trigger === 'manual' ? 'by hand' : run.trigger
  // A failed / timed-out run tints its whole card and colours its label; a clean
  // one stays neutral with the label in plain ink.
  const bad = run.status === 'error' || run.status === 'timeout' || run.status === 'interrupted'
  const ending = run.finished_at && onComplete ? runEndingLine(onComplete, session) : null

  return (
    <article className={cn('rounded-xl border px-3 py-2.5', RUN_WASH[run.status] ?? 'border-border bg-card')}>
      <header className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-lg',
            STATUS_CHIP[run.status] ?? STATUS_CHIP.skipped,
          )}
          aria-hidden="true"
        >
          <Icon className={cn('size-4', run.status === 'running' && 'animate-spin')} />
        </span>
        <span
          className={cn(
            'text-[14px] font-semibold capitalize',
            bad ? status.tone : 'text-foreground',
          )}
        >
          {status.label}
        </span>
        <span className="text-[12.5px] tabular-nums text-muted-foreground">
          {when}
          {dur ? ` · ${dur}` : ''}
        </span>
        <span className="ml-auto shrink-0 rounded-full bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {trigger}
        </span>
      </header>

      {run.note && (
        <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">{run.note}</p>
      )}

      <ol className="mt-2.5 flex flex-col">
        {detail.steps.map((sr, i) => (
          <StepNode
            key={sr.id}
            index={i}
            last={i === detail.steps.length - 1}
            title={steps.find((s) => s.id === sr.step_id)?.title || `Step ${sr.position + 1}`}
            run={sr}
            session={session}
            defaultOpen={expandAll}
          />
        ))}
      </ol>

      {ending && (
        <p className="mt-2 border-t border-border pt-2 text-[12px] text-muted-foreground">
          {ending}
        </p>
      )}
    </article>
  )
}

function StepNode({
  index,
  last,
  title,
  run,
  session,
  defaultOpen,
}: {
  index: number
  last: boolean
  title: string
  run: WorkflowRunDetail['steps'][number]
  session: string
  defaultOpen?: boolean
}) {
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(!!defaultOpen)
  const status = STEP_STATUS[run.status] ?? STEP_STATUS.skipped
  const Icon = status.icon
  const preview = plainPreview(run.preview)

  return (
    <li className="flex gap-2.5">
      <div className="flex w-5 shrink-0 flex-col items-center pt-1">
        <Icon
          className={cn('size-3.5', status.tone, run.status === 'running' && 'animate-spin')}
          aria-hidden="true"
        />
        {!last && <span className="mt-0.5 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pb-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-h-9 w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
              open && 'rotate-90',
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
            <span className="tabular-nums text-muted-foreground">{index + 1}. </span>
            {title}
          </span>
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {duration(run.started_at, run.finished_at)}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduce ? undefined : { height: 0, opacity: 0 }}
              transition={springs.cardExpand}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-1.5 pb-1 pl-4.5 pt-1">
                {preview && (
                  <p className="whitespace-pre-wrap rounded-lg bg-secondary/60 px-2.5 py-1.5 text-[12px] leading-snug text-foreground">
                    {preview}
                  </p>
                )}
                <p className="text-[11.5px] text-muted-foreground">
                  {status.label}
                  {run.signal ? ` · ${signalLabel(run.signal)}` : ''}
                  {run.note ? ` · ${run.note}` : ''}
                </p>
                <Link
                  to={botThreadHref(session)}
                  className="inline-flex h-9 w-fit items-center text-[12px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Open the thread here →
                </Link>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  )
}
