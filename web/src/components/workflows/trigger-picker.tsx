// TriggerPicker — when this thing runs.
//
// This is the heart of the whole feature. The old dialog asked for a "kind", a
// "sched type", a recurrence, a cron string, a boot dir and a bypass flag
// before it would tell you when anything would happen. What a person actually
// wants to say is "every weekday at 9". So:
//
//  1. THREE answers, not seven fields — When I say / Once / Repeating.
//  2. Repeating leads with ONE natural-language line, because typing "weekdays
//     9am" is faster than operating any picker ever built, and
//     `normalizeCadence` repairs the phrasings the parser is strict about.
//  3. Under it, five one-tap presets. On a phone that is the whole interaction:
//     tap, done, no keyboard.
//  4. Under THAT, the reassurance — the cadence read back in plain English and
//     the next real fire times from the server. A schedule you cannot picture
//     is a schedule you do not trust, and "next: Mon 25 Aug, 09:00" is the
//     difference.
//  5. The structured composer and the raw expression are still there, one tap
//     down, so the cron and the day-picker grammars lose nothing — they just
//     stop being the first thing a beginner meets.
//
// Nothing here can express a shell command, a boot directory or a bypass flag.
// Those are not hidden behind "advanced"; they are gone.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CalendarClock, Check, ChevronDown, Hand, Repeat, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { workflowsApi, type TriggerKind } from '@/lib/api/workflows'

import {
  EMPTY_RECURRENCE,
  FREQUENCY_CHIPS,
  FREQUENCY_LABEL,
  QUICK_CADENCES,
  WEEKDAYS,
  describeSchedule,
  exprToRecurrence,
  formatFull,
  normalizeCadence,
  onceExprFor,
  recurrenceToExpr,
  type Frequency,
  type RecurrenceDraft,
} from './cadence'

export interface TriggerValue {
  kind: TriggerKind
  /** The expression in the SERVER's grammar, or '' for `manual`. */
  expr: string
}

const MODES: { kind: TriggerKind; label: string; icon: typeof Hand; hint: string }[] = [
  {
    kind: 'manual',
    label: 'When I say',
    icon: Hand,
    hint: 'Runs when you press Run now — or when the bot asks for it.',
  },
  { kind: 'once', label: 'Once', icon: CalendarClock, hint: 'Runs one time, then stops.' },
  { kind: 'recurring', label: 'Repeating', icon: Repeat, hint: 'Runs on a schedule, forever.' },
]

export interface TriggerPickerProps {
  value: TriggerValue
  onChange: (next: TriggerValue) => void
  /** Injected offline (the dev bench). Defaults to the real preview endpoint. */
  previewFn?: (expression: string) => Promise<{ next_runs: string[] }>
  /** Offline bench: start with the structured composer already revealed. */
  initialBuilder?: boolean
}

export function TriggerPicker({
  value,
  onChange,
  previewFn = workflowsApi.preview,
  initialBuilder = false,
}: TriggerPickerProps) {
  const reduce = useReducedMotion()
  // What the user typed, which is NOT what is sent: the field keeps the raw
  // text so a half-typed "every m" does not become "every 1m" under the caret.
  const [text, setText] = React.useState(value.expr)
  const [lastExpr, setLastExpr] = React.useState(value.expr)
  if (value.expr !== lastExpr) {
    setLastExpr(value.expr)
    setText(value.expr)
  }
  const [builder, setBuilder] = React.useState(initialBuilder)
  const [draft, setDraft] = React.useState<RecurrenceDraft>(() =>
    value.expr ? exprToRecurrence(value.expr) : { ...EMPTY_RECURRENCE },
  )
  const [showAll, setShowAll] = React.useState(false)

  const typed = text.trim()
  const normalized = value.kind === 'recurring' ? normalizeCadence(typed) : value.expr
  const preview = usePreview(value.kind === 'manual' ? null : normalized, previewFn)

  const setExpr = (expr: string | null, raw?: string) => {
    if (raw !== undefined) setText(raw)
    onChange({ kind: value.kind, expr: expr ?? '' })
  }

  const pickMode = (kind: TriggerKind) => {
    if (kind === value.kind) return
    if (kind === 'manual') {
      onChange({ kind, expr: '' })
      return
    }
    if (kind === 'recurring') {
      // Coming back to Repeating restores the last cadence rather than an empty
      // field — the expression stays on the row server-side for exactly this.
      const expr = normalizeCadence(text) ?? QUICK_CADENCES[0].expr
      setText(expr)
      onChange({ kind, expr })
      return
    }
    onChange({ kind, expr: value.kind === 'once' ? value.expr : '' })
  }

  return (
    <section className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        Runs
      </h2>

      {/* The three answers. A segmented control, not a dropdown: three options
          you can see are three options you can compare. */}
      <div
        role="radiogroup"
        aria-label="When this workflow runs"
        className="flex gap-1 rounded-full bg-secondary p-1"
      >
        {MODES.map((m) => {
          const on = m.kind === value.kind
          return (
            <button
              key={m.kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => pickMode(m.kind)}
              className={cn(
                // At 320px three labelled chips do not fit WITH glyphs, and a
                // truncated "Repeati" is worse than no icon at all — so the
                // icon is what gives way, never the word.
                'relative flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[13px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[360px]:gap-1 max-[360px]:px-1 max-[360px]:text-[12.5px]',
                on ? 'text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {on && (
                <motion.span
                  layoutId="trigger-pill"
                  transition={reduce ? { duration: 0 } : springs.snappy}
                  className="absolute inset-0 rounded-full bg-foreground"
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5 truncate">
                <m.icon className="size-3.5 shrink-0 max-[360px]:hidden" aria-hidden="true" />
                {m.label}
              </span>
            </button>
          )
        })}
      </div>

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={value.kind}
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={springs.cardExpand}
        >
          {value.kind === 'manual' && (
            <p className="mt-3 text-[13px] leading-snug text-muted-foreground">
              {MODES[0].hint}
            </p>
          )}

          {value.kind === 'once' && (
            <OnceBody expr={value.expr} onExpr={(e) => setExpr(e)} />
          )}

          {value.kind === 'recurring' && (
            <div className="mt-3 flex flex-col gap-2.5">
              <div className="relative">
                <input
                  value={text}
                  onChange={(e) => setExpr(normalizeCadence(e.target.value), e.target.value)}
                  placeholder="every weekday at 9am"
                  aria-label="How often"
                  spellCheck={false}
                  autoCapitalize="none"
                  className="h-11 w-full rounded-lg border border-input bg-transparent pl-3 pr-9 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                />
                {normalized && (
                  <Check
                    className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-emerald-500"
                    aria-hidden="true"
                  />
                )}
              </div>

              {/* One tap, no keyboard — the whole interaction on a phone. */}
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
                {QUICK_CADENCES.map((q) => (
                  <button
                    key={q.key}
                    type="button"
                    aria-pressed={normalized === q.expr}
                    onClick={() => setExpr(q.expr, q.expr)}
                    className={cn(
                      'h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium transition-[transform,color,background-color] duration-100 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      normalized === q.expr
                        ? 'bg-foreground text-background'
                        : 'bg-secondary text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {q.label}
                  </button>
                ))}
              </div>

              <CadenceReadback
                expr={normalized}
                typed={typed}
                preview={preview}
                showAll={showAll}
                onShowAll={() => setShowAll((v) => !v)}
              />

              <div>
                <button
                  type="button"
                  onClick={() => setBuilder((v) => !v)}
                  aria-expanded={builder}
                  className="inline-flex h-8 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  {builder ? 'Hide the builder' : 'Build it instead'}
                </button>
                <AnimatePresence initial={false}>
                  {builder && (
                    <motion.div
                      initial={reduce ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={reduce ? undefined : { height: 0, opacity: 0 }}
                      transition={springs.cardExpand}
                      className="overflow-hidden"
                    >
                      <RecurrenceBuilder
                        draft={draft}
                        onDraft={(d) => {
                          setDraft(d)
                          const expr = recurrenceToExpr(d)
                          if (expr) setExpr(expr, expr)
                        }}
                        rawValue={text}
                        onRaw={(raw) => setExpr(normalizeCadence(raw), raw)}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  )
}

// ── the reassurance line ──────────────────────────────────────────────────────

interface PreviewState {
  runs: string[]
  loading: boolean
  error: string | null
}

/** Ask the server what this expression actually means, debounced.
 *
 *  The server is the only thing that knows: it owns the grammar, the host's
 *  timezone and the DST walk. Rendering a next-fire computed in the browser
 *  would be a second implementation of a calendar, and it would be wrong twice
 *  a year. */
function usePreview(
  expr: string | null,
  previewFn: (expression: string) => Promise<{ next_runs: string[] }>,
): PreviewState {
  // The snapshot remembers WHICH expression it answers. That is what lets the
  // "loading" and "cleared" states be derived during render instead of written
  // by the effect — and it is also what stops the previous cadence's fire times
  // sitting under a newly typed one for the length of the debounce, which would
  // be the most misleading 300ms on the page.
  const [snap, setSnap] = React.useState<{ expr: string; runs: string[]; error: string | null }>({
    expr: '',
    runs: [],
    error: null,
  })
  React.useEffect(() => {
    if (!expr) return
    let live = true
    const t = setTimeout(() => {
      previewFn(expr)
        .then((r) => {
          if (live) setSnap({ expr, runs: r.next_runs ?? [], error: null })
        })
        .catch((e: Error) => {
          if (live) setSnap({ expr, runs: [], error: e.message })
        })
    }, 320)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [expr, previewFn])

  const fresh = !!expr && snap.expr === expr
  return {
    runs: fresh ? snap.runs : [],
    loading: !!expr && !fresh,
    error: fresh ? snap.error : null,
  }
}

function CadenceReadback({
  expr,
  typed,
  preview,
  showAll,
  onShowAll,
}: {
  expr: string | null
  typed: string
  preview: PreviewState
  showAll: boolean
  onShowAll: () => void
}) {
  if (!typed) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        Pick one above, or type it — “every weekday at 9am”, “mondays at 17:00”, “every 2 hours”.
      </p>
    )
  }
  if (!expr) {
    return (
      <p className="text-[12.5px] text-amber-600 dark:text-amber-500">
        I don’t know that one yet. Try “every weekday at 9am” or “daily at 18:00”.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] font-medium text-foreground">{describeSchedule(expr)}</p>
      {preview.error ? (
        <p className="text-[12px] text-amber-600 dark:text-amber-500">{preview.error}</p>
      ) : preview.runs.length > 0 ? (
        <>
          <p className="text-[12px] text-muted-foreground">
            Next: {formatFull(preview.runs[0])}
            {preview.runs.length > 1 && (
              <button
                type="button"
                onClick={onShowAll}
                aria-expanded={showAll}
                className="ml-1.5 inline-flex items-center gap-0.5 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                +{preview.runs.length - 1} more
                <ChevronDown
                  className={cn('size-3 transition-transform duration-150', showAll && 'rotate-180')}
                  aria-hidden="true"
                />
              </button>
            )}
          </p>
          {showAll && (
            <ul className="flex flex-col gap-0.5 pl-0.5">
              {preview.runs.slice(1).map((r) => (
                <li key={r} className="text-[12px] tabular-nums text-muted-foreground">
                  {formatFull(r)}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {preview.loading ? 'Working out when…' : ' '}
        </p>
      )}
    </div>
  )
}

// ── Once ─────────────────────────────────────────────────────────────────────

/** `in <N>m` is the grammar the parser has for a one-shot; a datetime picker is
 *  the question a person can answer. The conversion happens here, and the
 *  readback is what it will actually do. */
function OnceBody({ expr, onExpr }: { expr: string; onExpr: (expr: string | null) => void }) {
  const [when, setWhen] = React.useState(() => defaultOnce())
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Seed the field's expression on first paint so Save is never blocked by a
    // control the user has already answered by looking at it.
    if (!expr) onExpr(onceExprFor(new Date(when)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (v: string) => {
    setWhen(v)
    const e = onceExprFor(new Date(v))
    setErr(e ? null : 'That time has already passed.')
    onExpr(e)
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <input
        type="datetime-local"
        value={when}
        onChange={(e) => set(e.target.value)}
        aria-label="When"
        className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
      />
      {err ? (
        <p className="text-[12.5px] text-amber-600 dark:text-amber-500">{err}</p>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          Runs once, then stops. It stays here afterwards, so you can run it again.
        </p>
      )}
    </div>
  )
}

/** Tomorrow, 09:00 — the answer to "once" that is right more often than now+1h. */
function defaultOnce(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── the builder (salvaged) ────────────────────────────────────────────────────

function RecurrenceBuilder({
  draft,
  onDraft,
  rawValue,
  onRaw,
}: {
  draft: RecurrenceDraft
  onDraft: (d: RecurrenceDraft) => void
  rawValue: string
  onRaw: (raw: string) => void
}) {
  const set = (patch: Partial<RecurrenceDraft>) => onDraft({ ...draft, ...patch })
  const showTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(draft.frequency)

  return (
    <div className="mt-2 flex flex-col gap-2.5 rounded-lg bg-secondary/50 p-2.5">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
        {FREQUENCY_CHIPS.filter((f) => f !== 'once').map((f: Frequency) => (
          <button
            key={f}
            type="button"
            aria-pressed={draft.frequency === f}
            onClick={() => set({ frequency: f })}
            className={cn(
              'h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              draft.frequency === f
                ? 'bg-foreground text-background'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {FREQUENCY_LABEL[f]}
          </button>
        ))}
      </div>

      {draft.frequency === 'weekly' && (
        <div className="flex flex-wrap gap-1">
          {WEEKDAYS.map((d) => (
            <button
              key={d.value}
              type="button"
              aria-pressed={draft.day === d.value}
              aria-label={d.full}
              onClick={() => set({ day: d.value })}
              className={cn(
                'h-9 w-10 rounded-lg text-[12px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                draft.day === d.value
                  ? 'bg-foreground text-background'
                  : 'bg-background text-muted-foreground hover:text-foreground',
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      {draft.frequency === 'monthly' && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          Day of the month
          <input
            type="number"
            min={1}
            max={28}
            value={draft.dom}
            onChange={(e) => set({ dom: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
            className="h-9 w-16 rounded-lg border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      )}

      {draft.frequency === 'interval' && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          Every
          <input
            type="number"
            min={1}
            value={draft.intervalN}
            onChange={(e) => set({ intervalN: Math.max(1, Number(e.target.value) || 1) })}
            className="h-9 w-16 rounded-lg border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <select
            value={draft.intervalUnit}
            onChange={(e) => set({ intervalUnit: e.target.value })}
            className="h-9 rounded-lg border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="m">minutes</option>
            <option value="h">hours</option>
            <option value="d">days</option>
          </select>
        </div>
      )}

      {showTime && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          At
          <input
            type="time"
            value={draft.time}
            onChange={(e) => set({ time: e.target.value })}
            className="h-9 rounded-lg border border-input bg-background px-2 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      )}

      {draft.frequency === 'custom' && (
        <div className="flex flex-col gap-1">
          <input
            value={rawValue}
            onChange={(e) => onRaw(e.target.value)}
            placeholder="0 9 * * 1-5"
            aria-label="Raw expression"
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-[12.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground">
            Five-field cron, or any phrase the parser knows. Nothing here is hidden from you —
            it is just not the first thing you have to learn.
          </p>
        </div>
      )}
    </div>
  )
}
