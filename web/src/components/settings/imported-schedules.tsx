// Settings → Imported schedules — the real destination behind the post-upgrade
// notification.
//
// Migration 0038 replaced the old scheduler with Workflows and dropped the
// `schedules` table irreversibly. Every pre-drop row was archived in
// `workflows_import_log`, and the one notification the upgrade raises deep-links
// `/settings#imported-schedules` (server: workflows/port.rs). This section IS
// that anchor: it lists the archive from `GET /api/workflows/import-log`, so a
// refused row (a shell job, a boot job) shows WHY it was refused and the literal
// command line — enough to rebuild it by hand. A ported row just says it became
// a workflow.
//
// Renders nothing on a database that never held a `schedules` row (fresh
// installs never see it), and nothing on an errored endpoint — the notification
// only ever fires when rows exist, so a hidden section never orphans the link
// for the user who received it.

import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { workflowsApi, type ImportedSchedule } from '@/lib/api/workflows'
import { sectionItem } from '@/components/settings/primitives'

/** The stable fragment the post-upgrade notification lands on. Mirrors the
 *  `/settings#imported-schedules` literal in `server/src/workflows/port.rs` —
 *  one string, both sides (pinned by `imported-schedules.test.tsx`). */
export const IMPORTED_SCHEDULES_ANCHOR = 'imported-schedules'

/** What one archived row means to a reader. Total over the pre-drop row JSON:
 *  a null / foreign-shaped `row` degrades to the `old_id` and empty strings —
 *  never a throw inside a render. */
export function describeImportRow(entry: ImportedSchedule): {
  name: string
  /** The literal command line (shell/boot jobs) or the prompt text. */
  what: string
  cadence: string
  /** Unix seconds of the old job's last fire, when the row recorded one. */
  lastRun: number | null
} {
  const row: Record<string, unknown> =
    entry.row && typeof entry.row === 'object' ? entry.row : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    name: str(row.name) || str(row.id) || entry.old_id,
    what: str(row.command) || str(row.prompt),
    cadence: str(row.schedule_expr),
    lastRun: typeof row.last_run === 'number' && row.last_run > 0 ? row.last_run : null,
  }
}

/** Only a non-empty archive shows the section. Defensive about the shape: an
 *  offline / errored endpoint can resolve with a non-array body, and hiding
 *  beats crashing on `.map` (same rule as ConnectorsSection). */
export function shouldShowImportLog(rows: unknown): rows is ImportedSchedule[] {
  return Array.isArray(rows) && rows.length > 0
}

function fmtDay(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function ImportRow({ entry }: { entry: ImportedSchedule }) {
  const d = describeImportRow(entry)
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] leading-tight text-foreground">{d.name}</div>
          {entry.ported ? (
            <div className="mt-0.5 flex items-center gap-1 text-[13px] leading-snug text-muted-foreground">
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
              Became a workflow
            </div>
          ) : (
            <div className="mt-0.5 flex items-start gap-1 text-[13px] leading-snug text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">Not carried over — {entry.reason}</span>
            </div>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {fmtDay(entry.at)}
        </span>
      </div>
      {d.what ? (
        // The literal command line / prompt — the part the user rebuilds from.
        // Its own scroll container so a long line never widens the page (390px).
        <pre className="overflow-x-auto rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-[12px] leading-snug text-foreground">
          {d.what}
        </pre>
      ) : null}
      {d.cadence || d.lastRun ? (
        <div className="text-[12px] leading-snug text-muted-foreground">
          {d.cadence ? <>ran {d.cadence}</> : null}
          {d.cadence && d.lastRun ? ' · ' : null}
          {d.lastRun ? <>last fired {fmtDay(d.lastRun)}</> : null}
        </div>
      ) : null}
    </div>
  )
}

/** The presentational card — hand-rolled section (not `Section`) because the
 *  wrapper must carry the deep-link `id`, like `WorkflowsRow` does. Refused
 *  rows arrive first from the server; the order is kept as served. */
export function ImportedSchedulesCard({ rows }: { rows: ImportedSchedule[] }) {
  const refused = rows.filter((r) => !r.ported).length
  return (
    <motion.section
      variants={sectionItem}
      className="flex flex-col"
      id={IMPORTED_SCHEDULES_ANCHOR}
    >
      <h2 className="px-4 pb-2 text-[13px] font-medium leading-none text-muted-foreground">
        Imported schedules
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {rows.map((r) => (
          <ImportRow key={r.old_id} entry={r} />
        ))}
      </div>
      <p className="px-4 pt-2 text-[12px] leading-snug text-muted-foreground">
        {refused > 0
          ? `The old scheduler was replaced by Workflows. ${refused} of its job${
              rows.length === 1 ? '' : 's'
            } could not be carried over — each one above shows its schedule and exact command, so you can rebuild what you still need.`
          : 'The old scheduler was replaced by Workflows. Everything above was carried over.'}
      </p>
    </motion.section>
  )
}

/** The data half. Mounted unconditionally in Settings (the anchor needs an
 *  always-rendered spot in the tree); renders nothing until a non-empty archive
 *  answers. Owner/admin-only server-side — a member's 404 lands here as an
 *  error, which also hides it. */
export function ImportedSchedulesSection() {
  const { data } = useQuery({
    queryKey: ['workflows', 'import-log'],
    queryFn: workflowsApi.importLog,
    staleTime: 5 * 60_000,
    retry: false,
  })
  if (!shouldShowImportLog(data)) return null
  return <ImportedSchedulesCard rows={data} />
}
