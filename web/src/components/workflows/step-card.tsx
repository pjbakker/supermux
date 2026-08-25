// StepCard — the composer's atom: one step, collapsed to a line or expanded to
// its four sections.
//
// Collapsed is the default and the important state: a five-step workflow you
// cannot see the shape of is a form, not a document. So collapsed shows the
// ordinal on the spine, one line of the prompt, and the two counts that change
// what a step DOES (files, connectors) — nothing else earns the row.
//
// Expanded is in a FIXED order — Prompt → Files → Must use → ▸ Advanced —
// chosen by how often each is needed: the prompt always, files sometimes,
// connectors rarely, advanced almost never. Advanced holds the timeout as three
// chips, never a number input; nobody wants to type 1800.
//
// Reordering is ▲ ▼ in the step's own menu, on every pointer. Drag-to-reorder
// inside a scrolling touch list is the classic mobile failure, and a
// desktop-only second mechanism is a second thing to keep correct for a list
// that is usually three items long. Both moves fire `navigator.vibrate?.(8)` —
// the same haptic the nav uses.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Loader2,
  MoreVertical,
  Paperclip,
  Plug,
  Plus,
  Trash2,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AttachmentChips } from '@/components/chat/attachment-chips'
import { useStagedAttachments } from '@/components/focus-mode/use-staged-attachments'
import type { WorkflowCommand, WorkflowFile } from '@/lib/api/workflows'

import { StepPrompt } from './step-prompt'

/** One step, as the composer holds it. `key` is a stable LOCAL id so a
 *  reorder animates rather than remounting; `id` is the server's, and only
 *  exists while editing something that was already saved. */
export interface StepDraft {
  key: string
  id?: string
  title: string
  /** The merged `/command prompt` text the field owns. Split at the wire. */
  text: string
  files: WorkflowFile[]
  connectors: string[]
  timeout_secs: number
  /** The step's own ending. Curated, and in practice only ever "tell me". */
  notifyOnDone: boolean
}

export const DEFAULT_TIMEOUT = 1800

/** The three answers to "how long should this be allowed to take". A number
 *  input would be a worse question with more ways to get it wrong. */
export const TIMEOUT_CHIPS: { secs: number; label: string }[] = [
  { secs: 1800, label: '30 min' },
  { secs: 7200, label: '2 hours' },
  { secs: 28800, label: '8 hours' },
]

export function newStep(seed: Partial<StepDraft> = {}): StepDraft {
  return {
    key: `step-${Math.random().toString(36).slice(2, 9)}`,
    title: '',
    text: '',
    files: [],
    connectors: [],
    timeout_secs: DEFAULT_TIMEOUT,
    notifyOnDone: false,
    ...seed,
  }
}

/** The one-line preview a collapsed card shows. */
export function stepPreview(step: StepDraft): string {
  const line = step.text.trim().split('\n')[0] ?? ''
  return line || step.title || 'Empty step'
}

const buzz = () => {
  if (typeof navigator !== 'undefined') navigator.vibrate?.(8)
}

export interface StepCardProps {
  step: StepDraft
  index: number
  total: number
  expanded: boolean
  onToggle: () => void
  onChange: (next: StepDraft) => void
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
  /** Open the connector-hint picker for this step. */
  onEditConnectors: () => void
  /** Told whenever this step has bytes in flight — Save waits for them. */
  onUploading?: (uploading: boolean) => void
  commands: ReadonlyArray<WorkflowCommand>
  commandsLoading: boolean
  /** Live: this step is the one running right now. */
  running?: boolean
  /** Names the step in the validity line ("Step 3 has no prompt"). */
  invalid?: boolean
}

export function StepCard({
  step,
  index,
  total,
  expanded,
  onToggle,
  onChange,
  onMove,
  onDelete,
  onEditConnectors,
  onUploading,
  commands,
  commandsLoading,
  running,
  invalid,
}: StepCardProps) {
  const reduce = useReducedMotion()
  const [advanced, setAdvanced] = React.useState(false)
  const staged = useStagedAttachments()
  const fileInput = React.useRef<HTMLInputElement>(null)

  // Fold each finished upload into the step's own file list exactly once. The
  // engine (5 MB image guard, parallel upload, calm error toast, leak-free
  // object-URL revoke) is `use-staged-attachments`'s; only the disposition is
  // ours, which is the whole reason it is reused rather than re-implemented.
  const folded = React.useRef<Set<string>>(new Set())
  // Point the refs at the latest props from an EFFECT, never during render:
  // the fold below has to read "the step as it is now" without re-subscribing
  // to every keystroke, and a render-time ref write is the pattern the lint
  // (rightly) refuses.
  const changeRef = React.useRef(onChange)
  const stepRef = React.useRef(step)
  // `onUploading` gets the SAME ref treatment as `onChange`, and for the same
  // reason: the composer passes it as a fresh inline arrow every render, so
  // depending on it in the effect below re-fires the effect → setState → re-render
  // → new arrow → … ("Maximum update depth exceeded"). Reading it through a ref
  // lets the effect depend on `staged.uploading` ALONE, so it fires only when the
  // upload state actually flips.
  const uploadingRef = React.useRef(onUploading)
  React.useEffect(() => {
    changeRef.current = onChange
    stepRef.current = step
    uploadingRef.current = onUploading
  })
  React.useEffect(() => {
    const ready = staged.attachments.filter(
      (a) => a.path && !a.uploading && !a.error && !folded.current.has(a.id),
    )
    if (ready.length === 0) return
    for (const a of ready) folded.current.add(a.id)
    changeRef.current({
      ...stepRef.current,
      files: [
        ...stepRef.current.files,
        ...ready.map((a) => ({ path: a.path as string, name: a.name })),
      ],
    })
    for (const a of ready) staged.dismiss(a.id)
  }, [staged])

  React.useEffect(() => {
    uploadingRef.current?.(staged.uploading)
  }, [staged.uploading])

  const move = (delta: -1 | 1) => {
    buzz()
    onMove(delta)
  }

  return (
    <li className="relative flex gap-2.5">
      {/* the spine + the ordinal */}
      <div className="flex w-6 shrink-0 flex-col items-center">
        <span
          className={cn(
            'relative flex size-6 items-center justify-center rounded-full text-[11.5px] font-semibold tabular-nums transition-colors duration-150',
            invalid
              ? 'bg-destructive/15 text-destructive ring-1 ring-destructive'
              : running
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground',
          )}
        >
          {/* The ordinal cross-fades to a spinner while its step is running —
              the same circle, not a second badge beside it. */}
          <AnimatePresence initial={false} mode="wait">
            {running ? (
              <motion.span
                key="spin"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              </motion.span>
            ) : (
              <motion.span
                key="num"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
              >
                {index + 1}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        {index < total - 1 && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>

      <div className="min-w-0 flex-1 rounded-xl border border-border bg-card">
        <div className="flex items-start gap-1.5 px-2.5 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                'block truncate text-[14px]',
                expanded
                  ? 'text-[12.5px] font-medium text-muted-foreground'
                  : step.text.trim()
                    ? 'text-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {/* Expanded, the prompt is right there in the textarea — repeating
                  it in the header is a line that says nothing twice. */}
              {expanded ? step.title || `Step ${index + 1}` : stepPreview(step)}
            </span>
            {!expanded && (step.files.length > 0 || step.connectors.length > 0) && (
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {step.files.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                    <Paperclip className="size-3" aria-hidden="true" />
                    {step.files.length}
                  </span>
                )}
                {step.connectors.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    <Plug className="size-3" aria-hidden="true" />
                    {c}
                  </span>
                ))}
              </span>
            )}
          </button>
          <StepMenu
            index={index}
            total={total}
            onMove={move}
            onDelete={onDelete}
          />
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduce ? undefined : { height: 0, opacity: 0 }}
              transition={springs.cardExpand}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-3 border-t border-border px-2.5 pb-3 pt-3">
                {/* 1 — Prompt */}
                <StepPrompt
                  value={step.text}
                  onChange={(text) => onChange({ ...step, text })}
                  commands={commands}
                  loading={commandsLoading}
                  placeholder="What should the bot do at this step? Type / for a skill."
                  rows={3}
                  ariaLabel={`Step ${index + 1} prompt`}
                />

                {/* 2 — Files */}
                <section className="flex flex-col gap-1.5">
                  <h4 className="text-[12px] font-medium text-muted-foreground">Files</h4>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {step.files.map((f) => (
                      <span
                        key={f.path}
                        className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-1 pl-2.5 pr-1 text-[12px] text-foreground"
                      >
                        <span className="truncate" title={f.path}>
                          {f.name || f.path}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${f.name || f.path}`}
                          onClick={() =>
                            onChange({ ...step, files: step.files.filter((x) => x.path !== f.path) })
                          }
                          className="relative inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                    <AttachmentChips attachments={staged.attachments} onDismiss={staged.dismiss} />
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      Attach files
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        staged.handleFiles(Array.from(e.target.files ?? []))
                        e.target.value = ''
                      }}
                    />
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Paths are pasted into the prompt when this step runs.
                  </p>
                </section>

                {/* 3 — Must use */}
                <section className="flex flex-col gap-1.5">
                  <h4 className="text-[12px] font-medium text-muted-foreground">Must use</h4>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {step.connectors.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center gap-1 rounded-full bg-secondary py-1 pl-2.5 pr-1 text-[12px] text-foreground"
                      >
                        <Plug className="size-3" aria-hidden="true" />
                        {c}
                        <button
                          type="button"
                          aria-label={`Remove ${c}`}
                          onClick={() =>
                            onChange({
                              ...step,
                              connectors: step.connectors.filter((x) => x !== c),
                            })
                          }
                          className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={onEditConnectors}
                      className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      Connector
                    </button>
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    The bot is told to use these. It may still choose others.
                  </p>
                </section>

                {/* 4 — Advanced */}
                <section>
                  <button
                    type="button"
                    onClick={() => setAdvanced((v) => !v)}
                    aria-expanded={advanced}
                    className="inline-flex h-8 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      className={cn(
                        'size-3.5 transition-transform duration-150',
                        advanced && 'rotate-90',
                      )}
                      aria-hidden="true"
                    />
                    Advanced
                  </button>
                  <AnimatePresence initial={false}>
                    {advanced && (
                      <motion.div
                        initial={reduce ? false : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={reduce ? undefined : { height: 0, opacity: 0 }}
                        transition={springs.cardExpand}
                        className="overflow-hidden"
                      >
                        <div className="flex flex-col gap-2 pt-2">
                          <div className="flex flex-col gap-1.5">
                            <span className="text-[12px] text-muted-foreground">
                              Give up after
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {TIMEOUT_CHIPS.map((t) => (
                                <button
                                  key={t.secs}
                                  type="button"
                                  aria-pressed={step.timeout_secs === t.secs}
                                  onClick={() => onChange({ ...step, timeout_secs: t.secs })}
                                  className={cn(
                                    'h-8 rounded-full px-3 text-[12px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                    step.timeout_secs === t.secs
                                      ? 'bg-foreground text-background'
                                      : 'bg-secondary text-muted-foreground hover:text-foreground',
                                  )}
                                >
                                  {t.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <label className="flex min-h-11 items-center gap-2 text-[12.5px] text-foreground">
                            <input
                              type="checkbox"
                              checked={step.notifyOnDone}
                              onChange={(e) =>
                                onChange({ ...step, notifyOnDone: e.target.checked })
                              }
                              className="size-4 rounded border-border"
                            />
                            Tell me when this step is done
                          </label>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  )
}

function StepMenu({
  index,
  total,
  onMove,
  onDelete,
}: {
  index: number
  total: number
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Step ${index + 1} options`}
          className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-1.5 before:content-['']"
        >
          <MoreVertical className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(-1)}>
          <ArrowUp className="mr-2 size-4" aria-hidden="true" />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={index === total - 1} onSelect={() => onMove(1)}>
          <ArrowDown className="mr-2 size-4" aria-hidden="true" />
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-destructive">
          <Trash2 className="mr-2 size-4" aria-hidden="true" />
          Delete step
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
