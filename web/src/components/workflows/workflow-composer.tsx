// WorkflowComposer — the full-page create/edit surface.
//
// A ROUTE, not a sheet, and the reason is scar tissue: a chain with N steps,
// file chips and a keyboard-heavy textarea is a document, bottom sheets fight
// the iOS keyboard (this codebase has the mode-9 visualViewport work to prove
// it), and a primary action that scrolls out of a sheet is one users cannot
// find. Sheets are used INSIDE the composer, for the pickers, where they are
// right.
//
// The shape of the page is the shape of the sentence: WHO does it (the bot),
// WHEN (the trigger — the part this whole feature exists to make easy), WHAT
// (the steps), and HOW IT ENDS (the completion action). Nothing else is on the
// page. There is no kind toggle, no shell command, no boot directory, no
// bypass-permissions checkbox — not hidden under "advanced", GONE.
//
// The footer is pinned and always says the truth: either what is missing, by
// step number, or what will happen when you press Save. A disabled button with
// no explanation is the failure mode this replaces.

import * as React from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, Loader2, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useToast } from '@/components/ui/use-toast'
import { SessionPicker } from '@/components/session/session-picker'
import { displayLabel } from '@/lib/api/sessions'
import { useSessions } from '@/hooks/use-sessions'
import {
  parseCompletion,
  parseConnectors,
  parseFiles,
  type CompletionAction,
  type StepInput,
  type WorkflowDetailPayload,
} from '@/lib/api/workflows'
import {
  useCreateWorkflow,
  usePatchWorkflow,
  useReplaceSteps,
  useRunWorkflow,
  useWorkflow,
  useWorkflowCommands,
} from '@/hooks/use-workflows'

import { CompletionActionRow, completionProblem } from './completion-action-row'
import {
  CADENCE_IDLE,
  cadenceProblem,
  useCadencePreview,
  type CadenceCheck,
} from './use-cadence-preview'
import { ConnectorHintPicker } from './connector-hint-picker'
import { StepCard, newStep, type StepDraft } from './step-card'
import { TriggerPicker, type TriggerValue } from './trigger-picker'
import { mergeCommandAndPrompt, splitCommandAndPrompt } from './step-prompt'
import { templateByKey } from './templates'
import { WORKFLOWS_ROUTE, workflowHref } from './workflow-href'

/** Everything the page holds, in one object — so seeding it from a template, a
 *  loaded workflow or an empty draft is one assignment rather than six. */
export interface ComposerDraft {
  title: string
  session: string
  trigger: TriggerValue
  steps: StepDraft[]
  onComplete: CompletionAction
}

/** The default a brand-new workflow opens on.
 *
 *  It is deliberately NOT empty: a workflow that runs every weekday at 9 is
 *  what most people are here to make, so the only thing left to do is say what
 *  it should do. Defaults are the cheapest UX there is. */
export function emptyDraft(session = '', prompt = ''): ComposerDraft {
  return {
    title: '',
    session,
    trigger: { kind: 'recurring', expr: 'every weekday at 9:00', text: 'every weekday at 9:00' },
    // `prompt` is the composer's clock (`?prompt=`): the human path that used to
    // hand a chat draft to the schedules sheet hands it to step 1 instead. The
    // draft is COPIED, so backing out of here costs the typist nothing.
    steps: [newStep(prompt ? { text: prompt } : {})],
    onComplete: { kind: 'notify' },
  }
}

/** Seed from a starter template — the empty state's whole point. */
export function draftFromTemplate(key: string, session = ''): ComposerDraft {
  const t = templateByKey(key)
  if (!t) return emptyDraft(session)
  return {
    title: t.title,
    session,
    trigger: { kind: 'recurring', expr: t.schedule_expr, text: t.schedule_expr },
    steps: t.steps.map((s) => newStep({ title: s.title, text: s.prompt, connectors: s.connectors ?? [] })),
    onComplete: t.on_complete,
  }
}

/** Seed from a saved workflow (the edit route). */
export function draftFromWorkflow(payload: WorkflowDetailPayload): ComposerDraft {
  const w = payload.workflow
  return {
    title: w.title,
    session: w.session,
    trigger: {
      kind: (w.trigger_kind as TriggerValue['kind']) ?? 'manual',
      expr: w.schedule_expr ?? '',
      text: w.schedule_expr ?? '',
    },
    steps: (payload.steps ?? []).map((s) =>
      newStep({
        id: s.id,
        title: s.title,
        text: mergeCommandAndPrompt(s.command, s.prompt),
        files: parseFiles(s.files),
        connectors: parseConnectors(s.connectors),
        timeout_secs: s.timeout_secs,
        notifyOnDone: parseCompletion(s.on_complete).kind === 'notify',
      }),
    ),
    onComplete: parseCompletion(w.on_complete),
  }
}

/**
 * What is stopping Save, in the words the footer says.
 *
 * PURE, and it returns a SENTENCE rather than a boolean: the rule for this
 * surface is that a blocked Save always names what to do about it, and the only
 * way to keep that true is for the block and the sentence to be the same value.
 */
export function draftProblem(
  draft: ComposerDraft,
  uploading = false,
  uploadingName?: string,
  check: CadenceCheck = CADENCE_IDLE,
): string | null {
  if (!draft.session.trim()) return 'Pick which bot runs this'
  const empty = draft.steps.findIndex((s) => !s.text.trim())
  if (empty >= 0) return `Step ${empty + 1} has no prompt`
  if (draft.steps.length === 0) return 'Add at least one step'
  if (draft.trigger.kind !== 'manual') {
    if (!draft.trigger.expr.trim()) {
      // Two different failures, two different sentences. "Say how often it
      // runs" is right for an empty field and WRONG for a field holding
      // "whenever i feel like it" — that user answered the question, they just
      // were not understood, and telling them to answer it again is the kind of
      // form that makes people give up.
      if (draft.trigger.kind === 'once') return 'Pick when it should run'
      return draft.trigger.text?.trim()
        ? 'Couldn’t understand that — try “every weekday at 9am”'
        : 'Say how often it runs'
    }
    // It parsed locally; the SERVER still has to confirm it before Save can
    // promise anything.
    const cadence = cadenceProblem(check)
    if (cadence) return cadence
  }
  const completion = completionProblem(draft.onComplete)
  if (completion) return completion
  if (uploading) return `Still attaching${uploadingName ? ` ${uploadingName}` : ''}…`
  return null
}

/** The composer's draft → the wire's steps. The command/prompt split happens
 *  HERE, at the boundary, and nowhere else — the field owns merged text so a
 *  round-trip cannot eat the user's spaces. */
export function stepsToWire(steps: StepDraft[]): StepInput[] {
  return steps.map((s, i) => {
    const { command, prompt } = splitCommandAndPrompt(s.text)
    return {
      title: s.title || `Step ${i + 1}`,
      command,
      prompt,
      files: s.files,
      connectors: s.connectors,
      timeout_secs: s.timeout_secs,
      on_complete: s.notifyOnDone ? ({ kind: 'notify' } as CompletionAction) : undefined,
    }
  })
}

// ── the route ─────────────────────────────────────────────────────────────────

export function WorkflowComposer() {
  const { id } = useParams<{ id: string }>()
  const editing = !!id
  const [params] = useSearchParams()
  const loaded = useWorkflow(id ?? null)

  if (editing && !loaded.data) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-[13px] text-muted-foreground">
        {loaded.error ? 'That workflow isn’t here anymore.' : 'Loading…'}
      </div>
    )
  }

  const initial = editing
    ? draftFromWorkflow(loaded.data as WorkflowDetailPayload)
    : params.get('template')
      ? draftFromTemplate(params.get('template') as string, params.get('session') ?? '')
      : emptyDraft(params.get('session') ?? '', params.get('prompt') ?? '')

  // Keyed on the id so navigating create → edit re-seeds instead of carrying a
  // stale draft across two different workflows.
  return <ComposerBody key={id ?? 'new'} id={id ?? null} initial={initial} />
}

export interface ComposerBodyProps {
  id: string | null
  initial: ComposerDraft
  /** Offline bench: the preview endpoint, and the session list. */
  previewFn?: (expression: string) => Promise<{ next_runs: string[] }>
  sessionsOverride?: { name: string; display_name?: string; status?: string }[]
  /** Offline bench: start with this step expanded (0-based). */
  initialExpanded?: number | null
}

export function ComposerBody({
  id,
  initial,
  previewFn,
  sessionsOverride,
  initialExpanded = 0,
}: ComposerBodyProps) {
  const reduce = useReducedMotion()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [draft, setDraft] = React.useState<ComposerDraft>(initial)
  const [expanded, setExpanded] = React.useState<string | null>(
    initialExpanded === null ? null : (initial.steps[initialExpanded]?.key ?? null),
  )
  const [uploading, setUploading] = React.useState<Record<string, boolean>>({})
  const [hintFor, setHintFor] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const liveSessions = useSessions()
  const sessions = React.useMemo(
    () =>
      sessionsOverride ??
      liveSessions.sessions.map((s) => ({
        name: s.name,
        display_name: s.display_name,
        status: s.status,
      })),
    [sessionsOverride, liveSessions.sessions],
  )
  const commands = useWorkflowCommands()

  const create = useCreateWorkflow()
  const patch = usePatchWorkflow()
  const replaceSteps = useReplaceSteps()
  const run = useRunWorkflow()

  // ONE check, one debounce, one source of truth: the composer owns it because
  // it is the thing that has to decide whether Save may be pressed, and the
  // picker only renders it.
  const check = useCadencePreview(
    draft.trigger.kind === 'manual' ? null : draft.trigger.expr || null,
    previewFn,
  )
  const anyUploading = Object.values(uploading).some(Boolean)
  const problem = draftProblem(draft, anyUploading, undefined, check)
  const set = (patchDraft: Partial<ComposerDraft>) => setDraft((d) => ({ ...d, ...patchDraft }))

  const setStep = (key: string, next: StepDraft) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.key === key ? next : s)) }))

  const addStep = (at?: number) =>
    setDraft((d) => {
      const step = newStep()
      const steps = [...d.steps]
      steps.splice(at ?? steps.length, 0, step)
      setExpanded(step.key)
      return { ...d, steps }
    })

  const moveStep = (key: string, delta: -1 | 1) =>
    setDraft((d) => {
      const i = d.steps.findIndex((s) => s.key === key)
      const j = i + delta
      if (i < 0 || j < 0 || j >= d.steps.length) return d
      const steps = [...d.steps]
      const [moved] = steps.splice(i, 1)
      steps.splice(j, 0, moved)
      return { ...d, steps }
    })

  const deleteStep = (key: string) =>
    setDraft((d) => {
      const steps = d.steps.filter((s) => s.key !== key)
      return { ...d, steps: steps.length ? steps : [newStep()] }
    })

  const title = draft.title.trim() || defaultTitle(draft)

  const save = async (thenRun: boolean) => {
    if (problem) {
      toast({ message: problem, tone: 'error' })
      return
    }
    setSaving(true)
    try {
      const body = {
        title,
        session: draft.session,
        trigger_kind: draft.trigger.kind,
        schedule_expr: draft.trigger.kind === 'manual' ? undefined : draft.trigger.expr,
        on_complete: draft.onComplete,
        steps: stepsToWire(draft.steps),
      }
      let savedId = id
      if (id) {
        await patch.mutateAsync({
          id,
          patch: {
            title: body.title,
            trigger_kind: body.trigger_kind,
            schedule_expr: body.schedule_expr,
            on_complete: body.on_complete,
          },
        })
        await replaceSteps.mutateAsync({ id, steps: body.steps })
      } else {
        const created = await create.mutateAsync(body)
        savedId = created.id
      }
      if (thenRun && savedId) {
        await run.mutateAsync(savedId)
        toast({ message: `Saved, and “${title}” is running now.` })
      } else {
        toast({ message: `Saved “${title}”.` })
      }
      navigate(savedId ? workflowHref(savedId) : WORKFLOWS_ROUTE)
    } catch (e) {
      toast({ message: `Couldn’t save — ${(e as Error).message}`, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const hintStep = draft.steps.find((s) => s.key === hintFor) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      {/* pt reserves the iOS status-bar inset (0 off a notched standalone PWA),
          mirroring the other full-screen route headers; the bottom bar already
          has its `pb-safe` twin. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/85 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur sm:px-5 sm:pt-2">
        <Link
          to={WORKFLOWS_ROUTE}
          aria-label="Back to workflows"
          className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {id ? 'Edit workflow' : 'New workflow'}
        </span>
        {/* Disabled in step with the footer's Save, never on its own: the two
            are the same action, and one of them refusing while the other looks
            ready is the interface disagreeing with itself. The pinned footer is
            always on screen, so this is never a disabled button with no
            explanation — the explanation is two lines below it. */}
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={saving || !!problem}
          aria-describedby="composer-validity"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-transform duration-100 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          Save
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-[720px] min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-40 pt-3 sm:px-5">
        {/* who + what it is called */}
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:p-4">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
              Called
            </span>
            <input
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder={defaultTitle(draft)}
              aria-label="Workflow name"
              className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base font-medium text-foreground placeholder:font-normal placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
              Run by
            </span>
            <SessionPicker
              value={draft.session}
              onChange={(name) => set({ session: name })}
              sessions={sessions}
              allowEmpty={false}
              placeholder="Pick a bot"
              ariaLabel="Which bot runs this"
              menuLabel="Run by"
            />
          </div>
        </section>

        {/* WHEN — the point of the whole surface */}
        <TriggerPicker value={draft.trigger} onChange={(trigger) => set({ trigger })} check={check} />

        {/* WHAT */}
        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
            Steps
          </h2>
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {draft.steps.map((s, i) => (
                <motion.div
                  key={s.key}
                  layout={!reduce}
                  initial={reduce ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={reduce ? undefined : { opacity: 0, height: 0 }}
                  transition={springs.cardExpand}
                >
                  <StepCard
                    step={s}
                    index={i}
                    total={draft.steps.length}
                    expanded={expanded === s.key}
                    onToggle={() => setExpanded((k) => (k === s.key ? null : s.key))}
                    onChange={(next) => setStep(s.key, next)}
                    onMove={(delta) => moveStep(s.key, delta)}
                    onDelete={() => deleteStep(s.key)}
                    onEditConnectors={() => setHintFor(s.key)}
                    onUploading={(u) => setUploading((m) => ({ ...m, [s.key]: u }))}
                    commands={commands.data ?? []}
                    commandsLoading={commands.isLoading}
                    invalid={!s.text.trim() && problem === `Step ${i + 1} has no prompt`}
                  />
                  {i < draft.steps.length - 1 && (
                    <InsertBetween onInsert={() => addStep(i + 1)} />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </ul>
          <button
            type="button"
            onClick={() => addStep()}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-[13px] font-medium text-muted-foreground transition-colors duration-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4" aria-hidden="true" />
            Add step
          </button>
        </section>

        {/* HOW IT ENDS */}
        <CompletionActionRow
          value={draft.onComplete}
          onChange={(onComplete) => set({ onComplete })}
          session={draft.session}
          bots={sessions}
        />
      </div>

      {/* the pinned footer — the validity line lives here, always */}
      <div className="pb-safe sticky bottom-0 z-10 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:px-5">
        {/* Stacked on a phone: three items in one row at 390px means the
            validity line gets four words, which is not enough for a sentence
            that has to NAME the problem. */}
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <p
            id="composer-validity"
            role="status"
            aria-live="polite"
            className={cn(
              'min-w-0 flex-1 text-[12.5px] leading-snug sm:truncate',
              problem ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground',
            )}
          >
            {problem ?? readyLine(draft)}
          </p>
          <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={saving || !!problem}
            className="inline-flex h-11 shrink-0 items-center rounded-full bg-secondary px-3.5 text-[13px] font-medium text-foreground transition-transform duration-100 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Save &amp; run
          </button>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={saving || !!problem}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-primary px-5 text-[13.5px] font-medium text-primary-foreground transition-transform duration-100 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Save
          </button>
          </div>
        </div>
      </div>

      {hintStep && (
        <ConnectorHintPicker
          open={!!hintFor}
          onOpenChange={(o) => !o && setHintFor(null)}
          session={draft.session}
          value={hintStep.connectors}
          onChange={(connectors) => setStep(hintStep.key, { ...hintStep, connectors })}
        />
      )}
    </div>
  )
}

/** The hairline "+" between two steps. A step almost always needs to go in the
 *  middle, and scrolling to the bottom to add one and then moving it up four
 *  times is the interaction that makes people stop adding steps. */
function InsertBetween({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="group relative ml-8 flex h-4 items-center">
      <button
        type="button"
        onClick={onInsert}
        aria-label="Insert a step here"
        className="relative inline-flex h-4 w-full items-center focus-visible:outline-none"
      >
        <span className="h-px flex-1 bg-transparent transition-colors duration-100 group-hover:bg-border" />
        <span className="mx-1 inline-flex size-4 items-center justify-center rounded-full bg-secondary text-muted-foreground opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100">
          <Plus className="size-3" aria-hidden="true" />
        </span>
        <span className="h-px flex-1 bg-transparent transition-colors duration-100 group-hover:bg-border" />
      </button>
    </div>
  )
}

/** A name, if the user did not type one. Better than "Untitled": the first
 *  step's first words are what the workflow is actually about. */
function defaultTitle(draft: ComposerDraft): string {
  const first = draft.steps[0]?.text.trim().split('\n')[0] ?? ''
  if (!first) return 'Untitled workflow'
  return first.length > 48 ? `${first.slice(0, 45)}…` : first
}

/** What Save will do, said before it happens. */
function readyLine(draft: ComposerDraft): string {
  const who = displayLabel({ name: draft.session }) || 'the bot'
  const n = draft.steps.length
  if (draft.trigger.kind === 'manual') return `${who} runs ${n} step${n === 1 ? '' : 's'} when you say.`
  return `${who} runs ${n} step${n === 1 ? '' : 's'} on this schedule.`
}

export default WorkflowComposer
