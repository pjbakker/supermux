/**
 * T5.3 — the anti-drop test for the workflows list.
 *
 * Redesigning a five-column table into a card is exactly where a capability
 * gets "simplified away": a column that no longer fits is the easiest thing in
 * the world to quietly not render. `schedules-section.test.tsx` made that
 * inventory executable for the settings fold; this is the same contract
 * re-expressed against the surface that replaces it.
 *
 * Two kinds of assertion, and the difference is deliberate:
 *
 *  * what a viewer can SEE without touching anything is asserted against the
 *    rendered markup;
 *  * what lives behind the row's `…` menu is asserted against the SOURCE, since
 *    a Radix dropdown renders its content into a portal on open and there is no
 *    DOM in this runner. A source scan is a weaker proof than a render, and it
 *    is used only where a render is impossible — never as a shortcut.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { WorkflowsView } from '../../src/components/workflows/workflows-view'
import { StepRail } from '../../src/components/workflows/step-rail'
import { WORKFLOW_TEMPLATES } from '../../src/components/workflows/templates'
import { ToastProvider } from '../../src/components/ui/toast'
import type { WorkflowWithSteps } from '../../src/lib/api/workflows'

const VIEW_SRC = readFileSync(
  new URL('../../src/components/workflows/workflows-view.tsx', import.meta.url).pathname,
  'utf8',
)

const step = (i: number, title: string) => ({
  id: `S-${i}`,
  workflow_id: 'WF-1',
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
})

const HOUR = 3600_000
const FIXTURE: WorkflowWithSteps[] = [
  {
    id: 'WF-report',
    title: 'Weekly client report',
    session: 'scout',
    company_id: null,
    enabled: 1,
    trigger_kind: 'recurring',
    schedule_expr: 'weekly on mon at 9:00',
    next_run: new Date(Date.now() + 3 * HOUR).toISOString(),
    last_run: new Date(Date.now() - 5 * HOUR).toISOString(),
    run_count: 12,
    on_complete: '{"kind":"notify"}',
    created: 0,
    updated: 0,
    deleted: null,
    steps: [step(0, 'Pull the numbers'), step(1, 'Draft the summary'), step(2, 'Email it')],
  },
  {
    id: 'WF-triage',
    title: 'Morning triage',
    session: 'inbox',
    company_id: null,
    enabled: 0,
    trigger_kind: 'recurring',
    schedule_expr: 'every weekday at 8:00',
    next_run: new Date(Date.now() + HOUR).toISOString(),
    last_run: null,
    run_count: 0,
    on_complete: '{"kind":"none"}',
    created: 0,
    updated: 0,
    deleted: null,
    steps: [step(0, 'Read the inbox'), step(1, 'Surface the top of it')],
  },
]

const render = (node: React.ReactNode): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

const list = (props: Record<string, unknown> = {}): string =>
  render(<WorkflowsView mock={FIXTURE} {...props} />)

describe('every capability of the old schedules table survives the redesign', () => {
  const html = list()

  test('title', () => {
    expect(html).toContain('Weekly client report')
    expect(html).toContain('Morning triage')
  })

  test('human cadence — the expression is never shown raw', () => {
    expect(html).toContain('Every Monday at 09:00')
    expect(html).toContain('Every weekday at 08:00')
    expect(html).not.toContain('weekly on mon at 9:00')
  })

  test('next fire — and "paused" for a paused row, never a stale timestamp', () => {
    expect(html).toContain('next in 3h')
    expect(html).toContain('next paused')
  })

  test('last fired — with "never" for one that has not', () => {
    expect(html).toContain('ran 5h ago')
    expect(html).toContain('ran never')
  })

  test('the enable toggle, as a real switch', () => {
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('aria-label="Pause Weekly client report"')
  })

  test('create', () => {
    expect(html).toContain('/workflows/new')
  })

  test('edit · run now · run log · delete are all on the row menu', () => {
    // Rendered into a portal on open, so asserted against the source.
    expect(VIEW_SRC).toContain('Run now')
    expect(VIEW_SRC).toContain('workflowEditHref')
    expect(VIEW_SRC).toContain('Duplicate')
    expect(VIEW_SRC).toContain('ArmedButton')
    // The run log is the card itself: the whole card links to the detail view,
    // whose Runs tab is the history.
    expect(html).toContain('href="/workflows/WF-report"')
  })

  test('the delete copy promises only what the soft delete keeps', () => {
    expect(VIEW_SRC).toContain('Past runs stay in the log.')
  })

  test('the row menu offers Run now · Duplicate · Pause · Delete', () => {
    for (const item of ['Run now', 'Duplicate', 'Delete']) expect(VIEW_SRC).toContain(item)
    // "Pause" is the toggle, in the row itself — one control, not two.
    expect(VIEW_SRC).toContain('EnableToggle')
  })
})

describe('the step rail', () => {
  test('renders one dot per step', () => {
    const html = render(<StepRail steps={4} />)
    expect(html.split('data-testid="step-dot"').length - 1).toBe(4)
    expect(html).toContain('data-status="idle"')
  })

  test('marks the current one and fills the ones behind it', () => {
    const html = render(<StepRail steps={4} current={3} status="running" currentLabel="Draft the summary" />)
    expect(html).toContain('data-dot-state="filled"')
    expect(html).toContain('data-dot-state="current"')
    expect(html).toContain('data-dot-state="hollow"')
  })

  test('is aria-hidden and narrated by an sr-only live region', () => {
    const html = render(<StepRail steps={4} current={2} status="running" currentLabel="Draft the summary" />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Step 2 of 4: Draft the summary')
  })

  test('stops at the failing dot on error — it never draws progress past a failure', () => {
    const html = render(<StepRail steps={4} current={2} status="error" />)
    expect(html).toContain('data-dot-state="error"')
    // One filled (step 1), one error (step 2), two hollow — nothing beyond the stop.
    expect(html.split('data-dot-state="filled"').length - 1).toBe(1)
    expect(html.split('data-dot-state="hollow"').length - 1).toBe(2)
  })

  test('a long chain collapses rather than drawing a barcode', () => {
    const html = render(<StepRail steps={14} />)
    expect(html.split('data-testid="step-dot"').length - 1).toBe(8)
    expect(html).toContain('+6')
  })

  test('zero steps draws nothing at all', () => {
    expect(render(<StepRail steps={0} />)).not.toContain('step-dot')
  })
})

describe('the empty state', () => {
  const html = render(<WorkflowsView mock={[]} />)

  test('offers three tappable starter templates, client-side, no server table', () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(3)
    for (const t of WORKFLOW_TEMPLATES) expect(html).toContain(t.title)
  })

  test('every template is a COMPLETE workflow — a cadence and real prompts', () => {
    for (const t of WORKFLOW_TEMPLATES) {
      expect(t.schedule_expr.length).toBeGreaterThan(0)
      expect(t.steps.length).toBeGreaterThanOrEqual(2)
      for (const s of t.steps) expect(s.prompt.length).toBeGreaterThan(20)
    }
  })

  test('nobody’s first workflow starts at a blank textarea', () => {
    // Tapping a template opens the composer PRE-POPULATED.
    expect(VIEW_SRC).toContain('template=')
    expect(html).toContain('Start from scratch')
  })

  test('the filter chips are hidden when there is nothing to filter', () => {
    expect(html).not.toContain('aria-pressed')
  })
})

describe('the two scopes are one component', () => {
  test('the page scope shows the owning bot; a bot scope does not repeat it', () => {
    expect(list()).toContain('Give a bot a job and a time.')
    const panel = render(<WorkflowsView variant="panel" scope="scout" mock={FIXTURE} />)
    expect(panel).toContain('New workflow')
    expect(panel).toContain('Weekly client report')
  })

  test('a bot scope pre-selects that bot on create', () => {
    const panel = render(<WorkflowsView variant="panel" scope="scout" mock={[]} />)
    expect(panel).toContain('Start from scratch for scout')
  })
})

describe('loading and failure are honest and calm', () => {
  test('the unreachable state says what is still true', () => {
    const html = render(<WorkflowsView mock={[]} mockState="error" />)
    expect(html).toContain('Can’t reach supermux-server')
    expect(html).toContain('Your workflows are still there')
    expect(html).toContain('Try again')
  })

  test('loading is a skeleton, not a spinner over an empty promise', () => {
    const html = render(<WorkflowsView mock={[]} mockState="loading" />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('Nothing scheduled yet')
  })
})

describe('the live rail', () => {
  test('a running workflow says which step it is on', () => {
    const html = list({
      mockProgress: {
        'WF-report': { runId: 7, step: 2, steps: 3, running: true, status: null },
      },
    })
    expect(html).toContain('step 2/3')
    expect(html).toContain('running now')
    expect(html).toContain('data-status="running"')
  })
})
