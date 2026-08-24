// DEV bench (/dev/workflows) — every workflows surface, offline.
//
// No server behind it: the list renders from fixtures, the composer's cadence
// preview is a stubbed promise, the connector rows are seeded, and the run
// timeline is handed a ledger. Both themes and the `[data-grok]` skin on one
// page so the offline Playwright rig can screenshot the whole feature.
//
// ── query flags ──────────────────────────────────────────────────────────────
//   ?surface=phone   render every panel in a 390px column (the mobile rig)
//   ?surface=narrow  390 → 320px, for the tightest phone
//   ?state=empty     the list's empty state (the three starter templates)
//   ?state=running   a workflow mid-run: the rail moves, step 2 of 3
//   ?state=error     the unreachable state
//   ?state=loading   the skeleton
//   ?panel=composer  ONLY the composer, full height (the deep-review shot)
//   ?panel=timeline  ONLY the run history
//   ?panel=hints     the connector-hint sheet, open
//   ?expanded=0      which composer step starts expanded (default 0; `none` = all closed)
//   ?theme=light|dark  render only that slab
//   ?grok=1          stamp `data-grok` (App.tsx's DevSkin gate does this globally)
//
// Not a product route: `App.tsx` only mounts it under `import.meta.env.DEV`.
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkflowsView } from '@/components/workflows/workflows-view'
import { ComposerBody, draftFromTemplate } from '@/components/workflows/workflow-composer'
import { ConnectorHintPicker } from '@/components/workflows/connector-hint-picker'
import { RunTimeline } from '@/components/workflows/run-timeline'
import type { ProgressMap } from '@/hooks/use-workflows'
import type { ConnectorCard, SessionConnector } from '@/lib/api/connectors'
import type {
  WorkflowRunDetail,
  WorkflowStepRow,
  WorkflowWithSteps,
} from '@/lib/api/workflows'

const BENCH_QC = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})

const NOW = Math.floor(Date.now() / 1000)

const step = (id: string, i: number, title: string, over: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id,
  workflow_id: 'WF-report',
  position: i,
  title,
  command: '',
  prompt: title,
  files: '[]',
  connectors: '[]',
  timeout_secs: 1800,
  on_complete: '',
  created: 0,
  updated: 0,
  ...over,
})

const REPORT_STEPS = [
  step('S1', 0, 'Pull this week’s numbers', { files: '[{"path":"/d/uploads/brief.pdf","name":"brief.pdf"}]' }),
  step('S2', 1, 'Draft the client summary'),
  step('S3', 2, 'Email it to the client', { connectors: '["gmail"]' }),
]

const FIXTURE: WorkflowWithSteps[] = [
  {
    id: 'WF-report',
    title: 'Weekly client report',
    session: 'scout',
    company_id: null,
    enabled: 1,
    trigger_kind: 'recurring',
    schedule_expr: 'weekly on mon at 9:00',
    next_run: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    last_run: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    run_count: 12,
    on_complete: '{"kind":"connector_send","connector_id":"gmail","account_ref":"a1","to":"client@example.com","subject":"Weekly report"}',
    created: 0,
    updated: 0,
    deleted: null,
    steps: REPORT_STEPS,
  },
  {
    id: 'WF-triage',
    title: 'Morning triage',
    session: 'inbox',
    company_id: null,
    enabled: 1,
    trigger_kind: 'recurring',
    schedule_expr: 'every weekday at 8:00',
    next_run: new Date(Date.now() + 3_600_000).toISOString(),
    last_run: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    run_count: 41,
    on_complete: '{"kind":"notify"}',
    created: 0,
    updated: 0,
    deleted: null,
    steps: [step('T1', 0, 'Read the inbox'), step('T2', 1, 'Surface the top of it')],
  },
  {
    id: 'WF-standup',
    title: 'Daily standup digest — a title long enough to need truncating on a phone',
    session: 'scout',
    company_id: null,
    enabled: 0,
    trigger_kind: 'manual',
    schedule_expr: null,
    next_run: null,
    last_run: null,
    run_count: 0,
    on_complete: '{"kind":"none"}',
    created: 0,
    updated: 0,
    deleted: null,
    steps: [step('D1', 0, 'Gather what moved'), step('D2', 1, 'Write it up')],
  },
]

const RUNNING: ProgressMap = {
  'WF-report': { runId: 91, step: 2, steps: 3, running: true, status: null },
}

const RUNS: WorkflowRunDetail[] = [
  {
    run: {
      id: 91,
      workflow_id: 'WF-report',
      started_at: NOW - 300,
      finished_at: null,
      trigger: 'tick',
      status: 'running',
      current_step: 2,
      note: '',
      heartbeat: NOW,
    },
    steps: [
      {
        id: 1, run_id: 91, step_id: 'S1', position: 0,
        started_at: NOW - 300, finished_at: NOW - 259,
        status: 'ok', signal: 'agent-confirmed',
        preview: 'Pull this week’s numbers\n/d/uploads/brief.pdf', note: '',
      },
      {
        id: 2, run_id: 91, step_id: 'S2', position: 1,
        started_at: NOW - 259, finished_at: null,
        status: 'running', signal: '', preview: 'Draft the client summary', note: '',
      },
    ],
  },
  {
    run: {
      id: 90, workflow_id: 'WF-report',
      started_at: NOW - 86_400, finished_at: NOW - 86_400 + 214,
      trigger: 'manual', status: 'error', current_step: 3,
      note: 'step 3 stopped: the bot never confirmed', heartbeat: 0,
    },
    steps: [
      { id: 3, run_id: 90, step_id: 'S1', position: 0, started_at: NOW - 86_400, finished_at: NOW - 86_400 + 40, status: 'ok', signal: 'status-idle', preview: 'Pull this week’s numbers', note: '' },
      { id: 4, run_id: 90, step_id: 'S2', position: 1, started_at: NOW - 86_400 + 40, finished_at: NOW - 86_400 + 121, status: 'ok', signal: 'agent-confirmed', preview: 'Draft the client summary', note: '' },
      { id: 5, run_id: 90, step_id: 'S3', position: 2, started_at: NOW - 86_400 + 121, finished_at: NOW - 86_400 + 214, status: 'timeout', signal: 'timeout', preview: 'Email it to the client', note: 'gave up after 30 min' },
    ],
  },
  {
    run: {
      id: 89, workflow_id: 'WF-report',
      started_at: NOW - 3 * 86_400, finished_at: NOW - 3 * 86_400 + 96,
      trigger: 'tick', status: 'ok', current_step: 3, note: '', heartbeat: 0,
    },
    steps: [
      { id: 6, run_id: 89, step_id: 'S1', position: 0, started_at: NOW - 3 * 86_400, finished_at: NOW - 3 * 86_400 + 41, status: 'ok', signal: 'agent-confirmed', preview: 'Pull this week’s numbers', note: '' },
      { id: 7, run_id: 89, step_id: 'S2', position: 1, started_at: NOW - 3 * 86_400 + 41, finished_at: NOW - 3 * 86_400 + 96, status: 'ok', signal: 'status-idle', preview: 'Draft the client summary', note: '' },
    ],
  },
]

const GRANTS = [
  {
    connector_id: 'gmail',
    has_secret: true,
    enabled: true,
    card: {
      id: 'gmail',
      display_name: 'Gmail',
      accounts: [
        { id: 'a1', account_label: 'sander@acme.com', status: 'active', has_secret: true, last_used_at: 0, health: 'ok', grant_level: 'bot' },
      ],
    },
  },
  {
    connector_id: 'icloud-mail',
    has_secret: true,
    enabled: true,
    card: {
      id: 'icloud-mail',
      display_name: 'iCloud Mail',
      accounts: [
        { id: 'a2', account_label: 'sander@icloud.com', status: 'disconnected', has_secret: true, last_used_at: 0, health: 'error', grant_level: 'bot' },
      ],
    },
  },
] as unknown as SessionConnector[]

const CATALOG = [
  { id: 'github', display_name: 'GitHub' },
  { id: 'slack', display_name: 'Slack' },
] as unknown as ConnectorCard[]

const BOTS = [
  { name: 'scout', display_name: 'Scout', status: 'active' },
  { name: 'inbox', display_name: 'Inbox', status: 'idle' },
]

/** The preview endpoint, offline.
 *
 *  It walks the real cadence rather than adding a fixed number of days: a bench
 *  whose "Every Monday" preview lands on a Tuesday teaches a reviewer to
 *  distrust the preview, which is the one thing on this surface that has to be
 *  believed. */
const previewFn = async (expression: string) => {
  const e = expression.toLowerCase()
  const hourly = /every\s+\d*\s*h/.test(e)
  const weekday = e.includes('weekday')
  const dayIdx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].findIndex((d) =>
    new RegExp(`\\b${d}`).test(e),
  )
  const hour = Number(/at\s+(\d{1,2})/.exec(e)?.[1] ?? 9)
  const out: string[] = []
  const d = new Date()
  d.setSeconds(0, 0)
  if (hourly) {
    d.setMinutes(0)
    for (let i = 1; i <= 5; i += 1) {
      const n = new Date(d)
      n.setHours(d.getHours() + i)
      out.push(n.toISOString())
    }
    return { next_runs: out }
  }
  d.setHours(hour, 0, 0, 0)
  let cursor = new Date(d)
  while (out.length < 5) {
    cursor = new Date(cursor.getTime() + 86_400_000)
    const dow = cursor.getDay()
    if (weekday && (dow === 0 || dow === 6)) continue
    if (dayIdx >= 0 && dow !== dayIdx) continue
    out.push(cursor.toISOString())
  }
  return { next_runs: out }
}

function Panel({
  label,
  height,
  width,
  children,
}: {
  label: string
  height: number
  width?: number
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-medium text-foreground">{label}</h2>
      <div
        data-vr={label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
        style={{ height, ...(width ? { width, maxWidth: '100%' } : {}) }}
        className="overflow-hidden rounded-2xl border border-border"
      >
        {children}
      </div>
    </section>
  )
}

function Slab({ theme, params }: { theme: 'light' | 'dark'; params: URLSearchParams }) {
  const surface = params.get('surface')
  const phone = surface === 'phone' || surface === 'narrow'
  const width = surface === 'narrow' ? 320 : surface === 'phone' ? 390 : undefined
  const state = params.get('state') ?? ''
  const panel = params.get('panel') ?? ''
  const expandedParam = params.get('expanded')
  const initialExpanded =
    expandedParam === 'none' ? null : expandedParam ? Number(expandedParam) : 0
  const [hintOpen, setHintOpen] = React.useState(panel === 'hints')

  const list = (
    <WorkflowsView
      variant="page"
      mock={state === 'empty' ? [] : FIXTURE}
      mockProgress={state === 'running' ? RUNNING : {}}
      mockState={state === 'error' ? 'error' : state === 'loading' ? 'loading' : undefined}
    />
  )

  const composer = (
    <ComposerBody
      id={null}
      initial={draftFromTemplate('weekly-report', 'scout')}
      previewFn={previewFn}
      sessionsOverride={BOTS}
      initialExpanded={initialExpanded}
    />
  )

  const timeline = (
    <div className="h-full overflow-y-auto p-3">
      <RunTimeline
        runs={RUNS}
        steps={REPORT_STEPS}
        session="scout"
        onComplete={{
          kind: 'connector_send',
          connector_id: 'gmail',
          account_ref: 'a1',
          to: 'client@example.com',
          subject: 'Weekly report',
        }}
        expandAll={params.get('expanded') === 'all'}
      />
    </div>
  )

  const only = panel === 'composer' ? composer : panel === 'timeline' ? timeline : null

  return (
    <div
      data-theme={theme}
      className={theme === 'dark' ? 'dark bg-background text-foreground' : 'bg-background text-foreground'}
    >
      {/* At a phone surface the page carries NO horizontal padding: the panel
          IS the viewport, so a padded bench would make every measurement 8px
          off and hide (or invent) a real overflow. */}
      <div className={phone ? 'flex flex-col gap-8 py-4' : 'flex flex-col gap-10 px-4 py-10'}>
        <header className={phone ? 'px-2' : 'mx-auto w-full max-w-[1120px]'}>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Workflows — {theme}
            {surface ? ` · ${surface}` : ''}
            {state ? ` · ${state}` : ''}
          </h1>
        </header>

        <div className={phone ? 'mx-auto flex flex-col gap-8' : 'mx-auto flex w-full max-w-[1120px] flex-col gap-10'}>
          {only ? (
            <Panel label={`Workflows ${panel} ${theme}`} height={phone ? 760 : 900} width={width}>
              {only}
            </Panel>
          ) : (
            <>
              <Panel label={`Workflows list ${theme}`} height={phone ? 560 : 620} width={width}>
                {list}
              </Panel>
              <Panel label={`Workflow composer ${theme}`} height={phone ? 760 : 900} width={width}>
                {composer}
              </Panel>
              <Panel label={`Workflow runs ${theme}`} height={phone ? 520 : 560} width={width}>
                {timeline}
              </Panel>
            </>
          )}
        </div>

        <div className="mx-auto">
          <button
            type="button"
            onClick={() => setHintOpen(true)}
            className="h-11 rounded-full bg-secondary px-4 text-[13px] font-medium text-foreground"
          >
            Open the connector picker
          </button>
        </div>
      </div>

      <ConnectorHintPicker
        open={hintOpen}
        onOpenChange={setHintOpen}
        session="scout"
        value={['gmail']}
        onChange={() => {}}
        grantsOverride={GRANTS}
        catalogOverride={CATALOG}
      />
    </div>
  )
}

export function DevWorkflows() {
  const [params] = useSearchParams()
  const theme = params.get('theme')
  return (
    <QueryClientProvider client={BENCH_QC}>
      <TooltipProvider>
        <ToastProvider>
          {theme !== 'dark' && <Slab theme="light" params={params} />}
          {theme !== 'light' && <Slab theme="dark" params={params} />}
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

export default DevWorkflows
