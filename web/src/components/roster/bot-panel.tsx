/**
 * `<BotPanel>` — the per-bot settings PAGE (Grok/Bot mode, ASK 3).
 * ─────────────────────────────────────────────────────────────────────────────
 * The roster's detail pane used to only GLANCE (cost/context/provider/status) —
 * nothing was editable. The real editable surface lived in
 * `focus-mode/session-info-panel.tsx` and was never mounted in Grok mode. This is
 * that surface, re-shaped as a tabbed bot page and reusing the info-panel's own
 * section bodies (name editor, dir, desc/role, tags, settings, Issues, Schedules,
 * Git, Clone, NotifPolicyControl) rather than reimplementing them.
 *
 * "Three fidelities, one component" (master plan §11.4):
 *   • variant="pane"  — the desktop roster's second column (replaces DetailPane).
 *   • variant="sheet" — a bottom sheet (the mobile focus-view title opens THIS,
 *                       not a duplicate surface).
 *
 * Three quiet tabs — the five-tab version read as five settings screens, so it
 * was folded down to what you actually DO here: glance, configure, automate.
 *   • Overview  — the glance (context / tokens / provider / status), the latest
 *                 line, editable tags and the working directory.
 *   • Setup     — everything you CONFIGURE, grouped: the role + model + core
 *                 notes, the bot's Connectors, what it has learned, how it
 *                 notifies you, and the launch internals (skills / MCP / flags)
 *                 tucked under one Advanced disclosure.
 *   • Workflows — the bot-scoped Workflows list · Recent runs · Issues · Git.
 *
 * The old `instructions` / `tools` / `memory` keys folded into ONE tab keyed
 * `instructions` (labelled "Setup"); `normalizeTab()` re-points any legacy
 * deep-link at `tools` or `memory` onto it, so a bookmarked panelTab never lands
 * on a tab that no longer exists.
 *
 * Styling is Tailwind + shadcn tokens (NOT `[data-grok]`-scoped CSS) so the ONE
 * component renders identically in the in-shell pane and in the body-portalled
 * sheet; the pane's outer chrome reuses the roster's existing `.gr-pane` surface.
 */
import * as React from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Files as FilesIcon,
  FolderOpen,
  Loader2,
  Plus,
  Terminal,
  Undo2,
} from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { modelOptions } from '@/lib/model-options'
import { SessionFace } from '@/components/roster/session-face'
import { GrantedConnectors, RestartToApply } from '@/components/roster/granted-connectors'
import { LearnedNotes } from '@/components/roster/learned-notes'
import { NotifPolicyControl } from '@/components/focus-mode/notif-policy-control'
import {
  DescEditor,
  TagsEditor,
  GitRow,
  type DescEditorHandle,
} from '@/components/focus-mode/session-info-panel'
import { WorkflowsView } from '@/components/workflows/workflows-view'
import { RecentRuns } from '@/components/workflows/recent-runs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { SessionActionsMenu } from '@/components/session-tile/session-actions-menu'
import { IssueList } from '@/components/issues/issue-list'
import { IssueSurface } from '@/components/issues/issue-surface'
import { useSession } from '@/hooks/use-sessions'
import { useSessionConfig } from '@/hooks/use-session-config'
import { useCloneSession } from '@/components/focus-mode/use-clone-session'
import { useToast } from '@/components/ui/use-toast'
import { displayLabel, type ApiSession } from '@/lib/api'

/* ── tiny pure helpers (mirrors of grok-roster's; kept local so this module is
      self-contained and does not widen grok-roster's export surface) ────────── */

const CTX_WINDOW = 200_000
function ctxPct(tokens?: number): number | null {
  if (typeof tokens !== 'number' || tokens <= 0) return null
  return Math.min(100, Math.round((tokens / CTX_WINDOW) * 100))
}
/** The ring's colour, as a COLOUR. `--status-*-ink` holds a bare HSL triplet
 *  (`38 92% 33%`), so dropping it straight into `conic-gradient()` made the whole
 *  declaration invalid at computed-value time and the ring painted NOTHING — the
 *  glance's hero stat was a bare percentage on a blank card. `--color-status-*-ink`
 *  is the same token already wrapped in `hsl()` (globals.css `@theme`), which is
 *  what a gradient can actually use; the hex stays as the fallback.
 *
 *  The three steps follow the hexes the author wrote (green → amber → hot), so
 *  they map onto `ready` / `active` / `error` — the app's own green, amber and
 *  (never-alarmist) orange. `waiting` is the BLUE "needs input" channel and says
 *  nothing about how full a context window is, so it stays out of this scale. */
function ringColor(pct: number): string {
  return pct < 50
    ? 'var(--color-status-ready-ink, #16a34a)'
    : pct < 80
      ? 'var(--color-status-active-ink, #d97706)'
      : 'var(--color-status-error-ink, #dc2626)'
}
function fmtTokens(n?: number): string | undefined {
  if (typeof n !== 'number' || n <= 0) return undefined
  if (n < 1000) return `${Math.max(0.1, n / 1000).toFixed(1)}k`
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}
function modelOf(s: ApiSession | null): string {
  if (!s) return ''
  if (s.model?.trim()) return s.model.trim()
  const m = s.flags?.match(/--model[= ]+(\S+)/)
  return m?.[1] ?? ''
}
function relTime(iso?: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'Yesterday' : `${days}d`
}

/** Role presets that ADD a durable job to the role/desc textarea. Picking one
 *  INSERTS its paragraph (at the caret, or into an empty field as the whole
 *  text) — it never replaces what is already written, and the row under the
 *  field offers a one-tap Undo. The user edits from there and blur saves. */
const ROLE_PRESETS: { label: string; text: string }[] = [
  {
    label: 'Reviewer',
    text: 'You review changes for correctness and clarity. Read the diff, flag real bugs and risky edits, and keep feedback specific and actionable. Never merge; report findings.',
  },
  {
    label: 'Builder',
    text: 'You implement features end to end. Prefer small, verifiable steps; run the tests before claiming done; keep changes scoped to the task.',
  },
  {
    label: 'Researcher',
    text: 'You investigate and explain. Search broadly, cite the files you read, and return a structured answer — findings first, then the evidence.',
  },
  {
    label: 'Ops',
    text: 'You keep things running. Watch health, act on failures, prefer the least-destructive recovery, and always say what you changed.',
  },
]

/** The receipt under the instruction field: which preset was applied, the draft
 *  it displaced (`prev`) and the one it produced (`after`, the Undo's guard).
 *  `refused` means the editor turned the Undo down because the field has been
 *  edited since — the row stays, saying so. */
export interface AppliedPreset {
  label: string
  prev: string
  after: string
  refused?: boolean
}

/** What the receipt becomes after an Undo attempt. `restore()` REFUSES once the
 *  field has moved on (reverting then would take the sentences written after the
 *  insert), and clearing the row on a refusal would claim an undo that never
 *  happened — so a refusal keeps the row and re-words it. Pure, so
 *  `tests/unit/bot-panel-settings.test.ts` can pin exactly that. */
export function afterUndo(applied: AppliedPreset, restored: boolean): AppliedPreset | null {
  return restored ? null : { ...applied, refused: true }
}

/* ── section shell (Tailwind, portal-safe) ─────────────────────────────────── */

/** Exported for `<TeamPanel>`, which copies BotPanel's FRAME (tabs, tablist,
 *  scrolling body) but shares its section primitives rather than re-declaring
 *  them — the panels must look like one family, and a second copy would drift.
 *  BotPanel itself is NOT generalised: no `variant` prop crosses the two. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{label}</h3>
        {hint && <p className="text-[12px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** The "Applies on next start" advisory — shown after a launch-line change
 *  (model / notes / a grant) so the user knows the live agent was NOT relaunched.
 *  Now carries the one-tap restart that closes the loop (was advice with no
 *  button); a mid-turn bot arms first. */
function RestartHint({ name }: { name: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <ArrowRight className="size-3 shrink-0" aria-hidden />
        Applies on next start — the running agent keeps its current setup.
      </span>
      <RestartToApply name={name} />
    </div>
  )
}

/* ── model picker ──────────────────────────────────────────────────────────── */

function ModelPicker({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  const { setModel, pending } = useSessionConfig()
  const options = modelOptions(session?.provider)
  const current = modelOf(session)
  const currentLabel = options.find((o) => o.value === current)?.label ?? current ?? 'Default'

  if (options.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {session?.provider ? `${session.provider} runs one model — no selection.` : 'No model selection.'}
      </p>
    )
  }

  return (
    // `modal={false}` — same reason as the row + actions menus: this picker lives
    // inside the bot-panel's Vaul sheet on a phone, where a modal Radix menu
    // portalled to <body> lands under the drawer's pointer-events:none and reads
    // as dead on touch. See session-actions-menu.tsx for the full note.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={pending}
          data-vr="bot-model-picker"
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-input bg-card px-3 text-[13px] font-medium text-foreground',
            'transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          )}
        >
          <span className="font-mono">{currentLabel || 'Default'}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value || 'default'}
            data-vr="bot-model-option"
            onSelect={() => {
              if (o.value === current) return
              void setModel(name, o.value).then((restart) => {
                if (restart) onRestartAdvised()
              })
            }}
          >
            <span className="flex-1 font-mono text-[13px]">{o.label}</span>
            {o.value === current && <Check className="size-4 shrink-0" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ── notes (memory) editor — launch-injected, read-only to the bot at runtime ── */

function NotesEditor({
  name,
  memory,
  onRestartAdvised,
}: {
  name: string
  memory: string
  onRestartAdvised: () => void
}) {
  const { setMemory, pending } = useSessionConfig()
  const [draft, setDraft] = React.useState(memory)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (!focused.current) setDraft(memory)
  }, [memory])

  const commit = () => {
    focused.current = false
    const next = draft.trim()
    if (next === (memory ?? '').trim()) return
    void setMemory(name, next).then((restart) => {
      if (restart) onRestartAdvised()
    })
  }

  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={commit}
      disabled={pending}
      rows={3}
      placeholder="Facts this bot should always have on hand — conventions, endpoints, who owns what…"
      aria-label="Notes this bot keeps"
      data-vr="bot-notes"
      className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

/* ── working-dir row (mono + copy + Files link) ────────────────────────────── */

export function WorkingDirRow({ name, dir }: { name: string; dir: string }) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  if (!dir) return <p className="text-sm text-muted-foreground">Not set.</p>
  const copy = () => {
    void navigator.clipboard?.writeText(dir).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
        {dir}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy working directory"
        title={copied ? 'Copied' : 'Copy'}
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check className="size-4 text-status-active-ink" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
      <Link
        to={`/files/${encodeURIComponent(name)}`}
        aria-label="Open in file browser"
        title="Files"
        className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FolderOpen className="size-4" aria-hidden />
      </Link>
    </div>
  )
}

/* ── the three tabs ────────────────────────────────────────────────────────── */

/** The tab KEY is the durable one — it is router state (`panelTab` in history,
 *  `initialTab`/`infoTab` on the two routes), a bench selector and the
 *  `data-vr-tab` hook — so the config tab stays keyed `'instructions'` even
 *  though its LABEL is now "Setup" (the same key-vs-label split the roster
 *  already uses elsewhere). Exported so the tab contract is asserted against the
 *  real array rather than a test's copy of the strings (`workflows-view.test.tsx`). */
export type TabKey = 'overview' | 'instructions' | 'workflows'
export const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'instructions', label: 'Setup' },
  { key: 'workflows', label: 'Workflows' },
]

/** Re-point a legacy or unknown tab key onto a tab that still exists. The old
 *  five-tab model shipped `'tools'` and `'memory'` as router state; both folded
 *  into Setup (`'instructions'`), so a bookmarked `panelTab: 'tools'` must land
 *  there rather than on a blank body. Pure, so the redirect is unit-testable
 *  without a live panel. */
export function normalizeTab(t?: string | null): TabKey {
  if (t === 'tools' || t === 'memory' || t === 'instructions') return 'instructions'
  if (t === 'overview' || t === 'workflows') return t
  return 'overview'
}

/** The CORE-notes cap — stated plainly (the truth about when edits land). */
const CORE_NOTES_CAP = 2000

/** One card in the glance row. The four differ only in what they SAY, so they
 *  share a shell: the same label rhythm, and — because the Context ring is 44px
 *  and a word is not — a common 44px value floor that lines all four values up
 *  on one baseline instead of letting each card set its own. */
function Stat({
  label,
  value,
  meta,
}: {
  label: string
  value: React.ReactNode
  meta?: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex min-h-11 flex-col justify-end gap-0.5">
        {value}
        {meta && <span className="truncate text-[11.5px] leading-tight text-muted-foreground">{meta}</span>}
      </div>
    </div>
  )
}

function OverviewTab({
  name,
  session,
}: {
  name: string
  session: ApiSession | null
}) {
  const pct = ctxPct(session?.tokens)
  const tokens = fmtTokens(session?.tokens)
  const model = modelOf(session)
  const preview =
    session?.chat_tail?.agent?.trim() ||
    session?.chat_tail?.user?.trim() ||
    session?.task_summary?.trim() ||
    ''
  const dir = session?.dir?.trim() || ''

  return (
    // TWO REGIONS, not one column of five loose things: the GLANCE (read-only
    // numbers, one card row) and then, under a hairline, the DETAILS you can act
    // on. The rule is what makes the tab read as intentional — before it, the
    // stat cards, a chat bubble, a tag field and a path row all sat at the same
    // altitude, six units apart, with nothing saying which was which.
    <div className="flex flex-col gap-5">
      {/* the glance — Context ring HERO + Tokens + Provider + Status */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Context"
          value={
            pct !== null ? (
              <div
                className="relative size-11"
                style={{
                  borderRadius: '50%',
                  background: `conic-gradient(${ringColor(pct)} ${pct}%, var(--muted, #e5e5e5) 0)`,
                }}
              >
                <span className="absolute inset-[6px] grid place-items-center rounded-full bg-card font-mono text-[12px] font-bold text-foreground">
                  {pct}%
                </span>
              </div>
            ) : (
              <span className="text-[15px] font-semibold text-foreground">—</span>
            )
          }
          meta={tokens ? `${tokens} tokens` : 'no tokens yet'}
        />
        <Stat
          label="Tokens"
          value={
            <span className="font-mono text-[22px] font-semibold leading-none tabular-nums text-foreground">
              {tokens ?? '0'}
            </span>
          }
          meta="cumulative"
        />
        <Stat
          label="Provider"
          value={
            <span className="truncate text-[15px] font-semibold capitalize text-foreground">
              {session?.provider ?? '—'}
            </span>
          }
          meta={model || (session?.runtime === 'native' ? 'native runtime' : 'runtime')}
        />
        <Stat
          label="Status"
          value={
            <span className="truncate text-[15px] font-semibold capitalize text-foreground">
              {session?.status ?? '—'}
            </span>
          }
          meta={relTime(session?.updated_at) || '—'}
        />
      </div>

      <div className="flex flex-col gap-6 border-t border-border pt-5">
        {preview && (
          <Field label="Latest">
            <div className="max-w-[64ch] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
              {preview}
              <div className="mt-2 text-[12px] text-muted-foreground">{relTime(session?.updated_at)}</div>
            </div>
          </Field>
        )}

        <Field label="Tags" hint="Searchable across the roster.">
          <TagsEditor name={name} tags={session?.tags ?? []} />
        </Field>

        <Field label="Working directory">
          <WorkingDirRow name={name} dir={dir} />
        </Field>
      </div>
    </div>
  )
}

/** The "What this bot does" block — the role/desc textarea, the preset pills
 *  that INSERT (never overwrite) a durable job, and the transient undo receipt.
 *  Pulled out of `InstructionsTab` so the folded Setup tab and `<TeamPanel>`'s
 *  Setup tab share ONE implementation of the pill/undo contract rather than two
 *  that could drift. */
function RoleField({ name, session }: { name: string; session: ApiSession | null }) {
  const desc = session?.desc ?? ''
  // The pills drive the EDITOR, not the row. Writing `desc` behind the field's
  // back is what made one stray tap destroy an authored instruction: the PATCH
  // replaced the whole value and the editor re-seeded from it, with nothing to
  // undo. Through the handle a preset is an ordinary edit — inserted, still
  // uncommitted, reversible.
  const editor = React.useRef<DescEditorHandle | null>(null)
  // The last preset applied, the draft it displaced, and the one it produced.
  // One step is enough: the undo row is a way back from a mis-tap, not a
  // history — and `after` is what keeps a late Undo from eating the sentences
  // the user wrote in the meantime (the editor refuses a moved-on field).
  const [applied, setApplied] = React.useState<AppliedPreset | null>(null)
  // The receipt is transient — a way back from the tap you just made, not a
  // banner that outlives it. It clears itself after a beat (and on the next
  // preset, which replaces it).
  React.useEffect(() => {
    if (!applied) return
    const t = setTimeout(() => setApplied(null), 12_000)
    return () => clearTimeout(t)
  }, [applied])

  return (
    <Field
      label="What this bot does"
      hint="The durable role, injected into the agent's system prompt at launch — this steers every turn. Tasks still go in the message; this is the standing job."
    >
      <div className="flex flex-wrap gap-1.5">
        {ROLE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            data-vr="bot-role-preset"
            aria-label={`Add the ${p.label} role to these instructions`}
            // Do NOT take focus off the textarea: a blur here would commit a
            // half-typed draft and the insert would then land in a stale one.
            // The pill edits the field the user is still standing in.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const done = editor.current?.insert(p.text)
              if (done) setApplied({ label: p.label, prev: done.prev, after: done.next })
            }}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-secondary px-3.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {p.label}
          </button>
        ))}
      </div>
      <DescEditor ref={editor} name={name} desc={desc} />
      {applied && (
        <div
          role="status"
          data-vr="bot-role-undo-row"
          data-vr-refused={applied.refused ? 'yes' : undefined}
          className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground"
        >
          {applied.refused ? (
            <>
              {/* The Undo was REFUSED, and says so. Clearing the row here would
                  read as "undone" while the field still holds the preset. */}
              <span>Can’t undo — you’ve edited since.</span>
              <button
                type="button"
                data-vr="bot-role-undo-dismiss"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setApplied(null)}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Dismiss
              </button>
            </>
          ) : (
            <>
              <span>Added “{applied.label}” to your instructions.</span>
              <button
                type="button"
                data-vr="bot-role-undo"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  setApplied(afterUndo(applied, editor.current?.restore(applied.prev, applied.after) ?? false))
                }
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Undo2 className="size-3.5 shrink-0" aria-hidden />
                Undo
              </button>
            </>
          )}
        </div>
      )}
    </Field>
  )
}

/** The launch internals — skills, MCP, flags, worktree, runtime — behind ONE
 *  disclosure. These are the "nerdy" bits the owner wanted folded away, not
 *  deleted: shown on demand, never in the resting surface. Shared by the Setup
 *  tab and by `<TeamPanel>`'s `ToolsTab`. */
function LaunchInternals({ session }: { session: ApiSession | null }) {
  const mcp = session?.mcp?.trim() || ''
  return (
    <details className="group rounded-xl border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer list-none text-[13px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
        Advanced
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground text-[13px]">Skills</dt>
          <dd className="text-[13px] text-foreground">Workspace defaults</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-[13px]">MCP</dt>
          <dd className="min-w-0">
            {mcp ? (
              <code className="block max-w-full truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground">
                {mcp}
              </code>
            ) : (
              <span className="text-[13px] text-muted-foreground">None</span>
            )}
          </dd>
        </div>
      </div>
      <dl className="mt-4 flex flex-col gap-2 border-t border-border pt-3 text-[13px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Flags</dt>
          <dd className="min-w-0 text-right">
            {session?.flags?.trim() ? (
              <code className="max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">{session.flags}</code>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Worktree</dt>
          <dd>{session ? (session.worktree ? 'Yes' : 'No') : '—'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="capitalize">{session?.runtime ?? '—'}</dd>
        </div>
      </dl>
    </details>
  )
}

/** The LEAD's instructions, verbatim, when `<TeamPanel>` mounts it — a crew is
 *  steered by steering its lead, so there is exactly ONE instructions surface.
 *  Kept for `<TeamPanel>`, which composes it with `<ToolsTab>` into its own
 *  Setup tab; the bot panel folds the same pieces inline via `<SetupTab>`. */
export function InstructionsTab({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <RoleField name={name} session={session} />
      <Field label="Model" hint="The launch model for this bot.">
        <ModelPicker name={name} session={session} onRestartAdvised={onRestartAdvised} />
      </Field>
      <Field
        label="Notes this bot keeps"
        hint="Injected read-only into the system prompt at launch — the bot can read these, but not rewrite them."
      >
        <NotesEditor name={name} memory={session?.memory ?? ''} onRestartAdvised={onRestartAdvised} />
      </Field>
      <Field label="Notifications">
        <NotifPolicyControl name={name} value={session?.notif} />
      </Field>
    </div>
  )
}

/** The lead's tools. `<TeamPanel>` mounts this crew-scoped: a teammate pane
 *  inherits the lead's env/config, so the lead's grants ARE the crew's grants. */
export function ToolsTab({ name, session }: { name: string; session: ApiSession | null }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Connectors are the HERO — the real, per-bot action surface — so they
          lead; the launch internals fold behind Advanced below. */}
      <GrantedConnectors name={name} />
      <LaunchInternals session={session} />
    </div>
  )
}

/** A hairline group divider inside a tab — the same rule the Overview tab uses
 *  to split the glance from the details: a quiet rule between altitudes, not a
 *  heavy heading, so the folded Setup tab reads as calm sections rather than one
 *  long column of loose fields. */
function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 border-t border-border pt-6 first:border-t-0 first:pt-0">
      {children}
    </div>
  )
}

/** SETUP — the one tab that holds everything you CONFIGURE, folded from the old
 *  Instructions + Connectors + Memory tabs. The owner found three separate
 *  settings screens nerdy and redundant (the core-notes editor even appeared on
 *  two of them); here they are four calm groups, hairline-separated, with the
 *  launch internals under a single Advanced disclosure.
 *
 *   1 · Behavior   — the role, the model, the core notes it always carries.
 *   2 · Connectors — the real per-bot action surface.
 *   3 · Memory     — what the bot has LEARNED across runs.
 *   4 · Delivery   — how it notifies you, then the Advanced internals. */
function SetupTab({
  name,
  session,
  onRestartAdvised,
}: {
  name: string
  session: ApiSession | null
  onRestartAdvised: () => void
}) {
  const memory = session?.memory ?? ''
  return (
    <div className="flex flex-col gap-6">
      <Group>
        <RoleField name={name} session={session} />
        <Field label="Model" hint="The launch model for this bot.">
          <ModelPicker name={name} session={session} onRestartAdvised={onRestartAdvised} />
        </Field>
        <Field
          label="Notes this bot keeps"
          hint="Kept verbatim and injected into the system prompt every run — the bot reads these, but can't rewrite them."
        >
          <NotesEditor name={name} memory={memory} onRestartAdvised={onRestartAdvised} />
          <p className="mt-1 text-[12px] tabular-nums text-muted-foreground">
            ~{memory.length} / {CORE_NOTES_CAP} chars · restart to apply
          </p>
        </Field>
      </Group>

      <Group>
        <Field label="Connectors" hint="What this bot can reach — its per-bot grants.">
          <GrantedConnectors name={name} />
        </Field>
      </Group>

      <Group>
        <LearnedNotes name={name} />
      </Group>

      <Group>
        <Field label="Notifications">
          <NotifPolicyControl name={name} value={session?.notif} />
        </Field>
        <LaunchInternals session={session} />
      </Group>
    </div>
  )
}

function WorkflowsTab({
  name,
  onNavigate,
}: {
  name: string
  onNavigate: (name: string) => void
}) {
  const [issuesOpen, setIssuesOpen] = React.useState(false)
  const [openIssueId, setOpenIssueId] = React.useState<string | null>(null)
  const { session } = useSession(name)

  return (
    <div className="flex flex-col gap-6">
      {/* The list carries its own heading and its own "+ New workflow" — one
          implementation of a workflow list, scoped, rather than a second one
          that would start disagreeing with /workflows about what a card says. */}
      <WorkflowsView variant="panel" scope={name} />

      <Field label="Recent runs">
        <RecentRuns session={name} limit={5} />
      </Field>

      <Field label="Issues">
        <div className="flex flex-col gap-2">
          <IssueList
            session={name}
            onOpen={(issue) => {
              setOpenIssueId(issue.id)
              setIssuesOpen(true)
            }}
          />
          <button
            type="button"
            onClick={() => {
              setOpenIssueId(null)
              setIssuesOpen(true)
            }}
            className="self-start rounded-md px-1 py-1 text-xs text-primary hover:underline"
          >
            Open issues →
          </button>
        </div>
      </Field>
      <IssueSurface
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        initialIssueId={openIssueId}
        session={name}
        title={displayLabel(session ?? { name })}
        onFocusSession={(target) => {
          setIssuesOpen(false)
          onNavigate(target)
        }}
      />

      <Field label="Git">
        <GitRow name={name} />
      </Field>
    </div>
  )
}

/* ── the panel body (shared by both variants) ──────────────────────────────── */

function BotPanelBody({
  name,
  variant,
  onOpenThread,
  onOpenTerminal,
  onNavigate,
  initialTab,
}: {
  name: string
  variant: 'pane' | 'sheet'
  onOpenThread: () => void
  /** When set, this bot cannot be a chat surface (Codex/shell/remote/team-lead),
   *  so the header offers "Open terminal →" (→ /focus) INSTEAD of "Open thread". */
  onOpenTerminal?: () => void
  onNavigate: (name: string) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: TabKey
}) {
  const { session } = useSession(name)
  const clone = useCloneSession()
  const { toast } = useToast()
  // `normalizeTab` re-points a stale deep-link (a bookmarked `tools`/`memory`
  // panelTab from the five-tab era) onto the tab that absorbed it, so the panel
  // never opens on a body that no longer renders.
  const [tab, setTab] = React.useState<TabKey>(() => normalizeTab(initialTab))
  const [restartAdvised, setRestartAdvised] = React.useState(false)
  const onRestartAdvised = React.useCallback(() => setRestartAdvised(true), [])

  const label = displayLabel(session ?? { name })
  const model = modelOf(session)
  const sub = [session?.status, model || session?.provider, session?.branch].filter(Boolean).join(' · ')

  const doClone = async () => {
    if (clone.pending) return
    try {
      const newName = await clone.run(name)
      toast({ message: `Cloned to ${newName}`, tone: 'active' })
      onNavigate(newName)
    } catch (e) {
      toast({ message: `Clone failed — ${(e as Error).message}`, tone: 'error', duration: 4000 })
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', variant === 'pane' && 'h-full')}>
      {/* sticky header — face · editable name · sub-line · Open thread · [...]
          The `pane` variant is FULL-SCREEN on a phone (the grok roster's detail
          view), so its top runs under the iOS status bar / Dynamic Island unless
          it reserves the inset — the same fix Overview/Files/Connectors got.
          `env(safe-area-inset-top)` is 0 on desktop and in a normal browser tab,
          so this is a no-op off a notched standalone PWA; `max()` keeps the base
          0.75rem there. The `sheet` variant is a bottom drawer — never under the
          status bar — so it keeps the plain `py-3`. */}
      {/* ONE identity header (no generic "Bot" bar above it anymore). Two calm
          rows: the face + editable name lead; the status line and the single
          primary action sit below with room to breathe — the airy hierarchy the
          cramped one-row version lacked. */}
      <header
        className={cn(
          'flex flex-col gap-3 border-b border-border bg-background/80 px-5 pb-4 backdrop-blur-sm',
          variant === 'pane'
            ? 'pt-[max(0.875rem,env(safe-area-inset-top))]'
            : 'pt-4',
        )}
      >
        <div className="flex items-start gap-3.5">
          <SessionFace name={name} status={session?.status} size={48} />
          {/* The name is the title — one clean line, no bordered field and no
              second "id" row (that clutter is what made the old header read as a
              form). Rename lives in the ⋯ menu, reachable right beside it. */}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="truncate text-[19px] font-semibold leading-tight tracking-tight text-foreground">
              {label}
            </h2>
          </div>
          {session && (
            <SessionActionsMenu
              session={session}
              variant="row"
              className="!static !size-9 !opacity-100 -mr-2 -mt-1 flex-none"
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          {sub ? (
            <span className="min-w-0 flex-1 truncate text-[13px] capitalize text-muted-foreground">
              {sub}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {onOpenTerminal ? (
            <button
              type="button"
              onClick={onOpenTerminal}
              data-vr="bot-open-terminal"
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-sm transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Terminal className="size-3.5" aria-hidden />
              Open terminal
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenThread}
              data-vr="bot-open-thread"
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-sm transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open thread
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </header>

      {/* tab bar — an EQUAL-WIDTH segmented control. Each tab is `flex-1
          basis-0`, so three of them divide the width instead of overflowing it:
          the bar fits at 320px with no horizontal scroll and no cut-off tab (the
          five-tab version scrolled sideways on a phone and clipped its last
          tab). The BODY scrolls; this bar never does.

          A plain `div` carries `role="tablist"` (a `nav` is a landmark and may
          not take an interactive role: jsx-a11y/no-noninteractive-element-to-
          interactive-role). Full WAI-ARIA tab pattern: roving `tabindex`,
          arrow-key movement, and each tab `aria-controls` the one panel it
          drives (`aria-labelledby` points back). */}
      <div
        role="tablist"
        aria-label="Bot settings"
        className="flex w-full shrink-0 items-stretch border-b border-border px-2"
      >
        {TABS.map((t, ti) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`bot-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="bot-tabpanel"
            tabIndex={tab === t.key ? 0 : -1}
            data-vr="bot-tab"
            data-vr-tab={t.key}
            onClick={() => setTab(t.key)}
            // Roving-tabindex arrow movement lives on the tabs themselves (they
            // are the focusable elements); the tablist container stays a plain,
            // non-focusable grouping so it needs no tabindex.
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const next =
                e.key === 'ArrowRight'
                  ? (ti + 1) % TABS.length
                  : (ti - 1 + TABS.length) % TABS.length
              setTab(TABS[next].key)
              e.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
                ?.focus()
            }}
            className={cn(
              'relative -mb-px min-h-11 flex-1 basis-0 px-2 text-center text-[13px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              tab === t.key
                ? 'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* scrolling tab body */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-5 py-5 [scrollbar-width:thin]',
          variant === 'sheet' && 'max-h-[70vh]',
        )}
        role="tabpanel"
        id="bot-tabpanel"
        aria-labelledby={`bot-tab-${tab}`}
        tabIndex={0}
      >
        {restartAdvised && <div className="mb-4"><RestartHint name={name} /></div>}
        {tab === 'overview' && (
          <OverviewTab name={name} session={session} />
        )}
        {tab === 'instructions' && (
          <SetupTab name={name} session={session} onRestartAdvised={onRestartAdvised} />
        )}
        {tab === 'workflows' && <WorkflowsTab name={name} onNavigate={onNavigate} />}

        {/* Clone — the panel's footer action, on every tab's scroll floor */}
        <div className="mt-8 border-t border-border pt-5">
          <button
            type="button"
            onClick={doClone}
            disabled={clone.pending}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent/40 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {clone.pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FilesIcon className="size-4" aria-hidden />}
            {clone.pending ? 'Cloning…' : 'Clone bot in this directory'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── the public component ──────────────────────────────────────────────────── */

export interface BotPanelProps {
  name: string
  variant: 'pane' | 'sheet'
  /** Navigate to the bot's focus thread. */
  onOpenThread: () => void
  /** pane only, ineligible bots: show "Open terminal →" (→ /focus) in the header
   *  instead of "Open thread", since this bot cannot render as a chat surface. */
  onOpenTerminal?: () => void
  /** Navigate to a session's focus route (used by Clone + issue focus). */
  onNavigate: (name: string) => void
  /** sheet only. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Dev/bench only: seat a specific tab so a still frame can show each one. */
  initialTab?: TabKey
}

export function BotPanel({
  name,
  variant,
  onOpenThread,
  onOpenTerminal,
  onNavigate,
  open,
  onOpenChange,
  initialTab,
}: BotPanelProps) {
  if (variant === 'sheet') {
    return (
      <ResponsiveSheet
        open={open ?? false}
        onOpenChange={onOpenChange ?? (() => {})}
        // The body draws its OWN identity header (face · name · status · Open
        // thread), so suppress the sheet's generic bar — it was stacking a second
        // "Bot / <name>" title above the real one (the triple-name clutter).
        title={name}
        hideHeader
        className="max-w-2xl"
      >
        {/* `data-grok` so the sheet (portalled to <body>, outside the shell root)
            still resolves the Grok accent tokens, exactly like command-palette. */}
        <div data-grok>
          <BotPanelBody
            name={name}
            variant="sheet"
            initialTab={initialTab}
            onOpenThread={() => {
              onOpenChange?.(false)
              onOpenThread()
            }}
            onNavigate={(n) => {
              onOpenChange?.(false)
              onNavigate(n)
            }}
          />
        </div>
      </ResponsiveSheet>
    )
  }

  return (
    <div className="gr-pane gr-botpane" data-shell-pane>
      <BotPanelBody
        name={name}
        variant="pane"
        onOpenThread={onOpenThread}
        onOpenTerminal={onOpenTerminal}
        onNavigate={onNavigate}
        initialTab={initialTab}
      />
    </div>
  )
}

export default BotPanel
