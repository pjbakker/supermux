/**
 * T5.6 — the composer.
 *
 * The behaviour that decides whether this surface is good is in three pure
 * functions, and they are asserted directly rather than through a DOM the
 * runner does not have:
 *
 *  * `draftProblem` — the rule for this page is that a blocked Save always
 *    NAMES what to do about it, by step number. The only way to keep that true
 *    is for the block and the sentence to be the same value, so the validator
 *    returns a sentence and `null` means "go";
 *  * `stepsToWire` — the command/prompt split happens at the boundary and
 *    nowhere else, which is what preserves the two-line delivery;
 *  * `draftFromTemplate` / `emptyDraft` — the defaults, which are the cheapest
 *    UX there is and the thing a redesign most easily loses.
 *
 * The render assertions cover the rest: the removed kinds cannot be expressed,
 * the footer is pinned and safe-area aware, and no raw-Vaul site was added
 * (`sheet-inventory.test.ts` owns that ratchet; the composer's one modal is a
 * `ResponsiveSheet`).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  ComposerBody,
  draftFromTemplate,
  draftFromWorkflow,
  draftProblem,
  emptyDraft,
  stepsToWire,
  type ComposerDraft,
} from '../../src/components/workflows/workflow-composer'
import { newStep } from '../../src/components/workflows/step-card'
import { isCadenceExpr } from '../../src/components/workflows/cadence'
import { ToastProvider } from '../../src/components/ui/toast'

const SRC = fileURLToPath(new URL('../../src/components/workflows', import.meta.url))
const composerSrc = readFileSync(join(SRC, 'workflow-composer.tsx'), 'utf8')
const triggerSrc = readFileSync(join(SRC, 'trigger-picker.tsx'), 'utf8')
const stepSrc = readFileSync(join(SRC, 'step-card.tsx'), 'utf8')

const draft = (over: Partial<ComposerDraft> = {}): ComposerDraft => ({
  ...emptyDraft('scout'),
  steps: [newStep({ text: 'Pull the numbers' })],
  ...over,
})

const preview = async () => ({ next_runs: ['2026-08-31T09:00:00.000Z'] })

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

const body = (over: Partial<ComposerDraft> = {}): string =>
  render(
    <ComposerBody
      id={null}
      initial={draft(over)}
      previewFn={preview}
      sessionsOverride={[{ name: 'scout', display_name: 'Scout' }]}
    />,
  )

describe('the defaults are the feature', () => {
  test('a new workflow already has a bot-shaped cadence — not an empty field', () => {
    const d = emptyDraft('scout')
    expect(d.trigger.kind).toBe('recurring')
    expect(isCadenceExpr(d.trigger.expr)).toBe(true)
    expect(d.steps).toHaveLength(1)
    // Only ONE thing is left to do, and the validator says which.
    expect(draftProblem(d)).toBe('Step 1 has no prompt')
  })

  test('a template seeds a complete, saveable workflow', () => {
    const d = draftFromTemplate('weekly-report', 'scout')
    expect(draftProblem(d)).toBeNull()
    expect(d.steps.length).toBeGreaterThanOrEqual(3)
    expect(isCadenceExpr(d.trigger.expr)).toBe(true)
    expect(d.title).toBe('Weekly report, emailed')
  })

  test('an unknown template key falls back to the default draft, never to a crash', () => {
    expect(draftFromTemplate('nope', 'scout').steps).toHaveLength(1)
  })
})

describe('Save is blocked with a sentence, never with a silent disabled button', () => {
  test('it names the offending step by number', () => {
    const d = draft({ steps: [newStep({ text: 'a' }), newStep({ text: '' }), newStep({ text: 'c' })] })
    expect(draftProblem(d)).toBe('Step 2 has no prompt')
  })

  test('it names a missing bot before anything else — nothing else matters without one', () => {
    expect(draftProblem(draft({ session: '' }))).toBe('Pick which bot runs this')
  })

  test('it blocks while an upload is in flight, and says which file', () => {
    expect(draftProblem(draft(), true, 'brief.pdf')).toBe('Still attaching brief.pdf…')
  })

  test('a repeating trigger with no cadence is refused in the trigger’s own words', () => {
    expect(draftProblem(draft({ trigger: { kind: 'recurring', expr: '' } }))).toBe(
      'Say how often it runs',
    )
    expect(draftProblem(draft({ trigger: { kind: 'once', expr: '' } }))).toBe(
      'Pick when it should run',
    )
  })

  test('a "when I say" workflow needs no cadence at all', () => {
    expect(draftProblem(draft({ trigger: { kind: 'manual', expr: '' } }))).toBeNull()
  })

  test('a half-filled connector send is refused by the completion row’s own reason', () => {
    const d = draft({
      onComplete: { kind: 'connector_send', connector_id: 'gmail', account_ref: 'a1', to: '' },
    })
    expect(draftProblem(d)).toBe('Say who the summary goes to')
  })
})

describe('the wire boundary', () => {
  test('a leading slash line becomes `command`, the rest becomes `prompt`', () => {
    const [wire] = stepsToWire([newStep({ text: '/daily-digest summarise the day' })])
    expect(wire.command).toBe('/daily-digest')
    expect(wire.prompt).toBe('summarise the day')
  })

  test('a bare prompt carries no command — the two-line delivery is not forced', () => {
    const [wire] = stepsToWire([newStep({ text: 'just do the thing' })])
    expect(wire.command).toBe('')
    expect(wire.prompt).toBe('just do the thing')
  })

  test('files, connectors and the timeout ride along; a step gets a title if it has none', () => {
    const [wire] = stepsToWire([
      newStep({
        text: 'x',
        files: [{ path: '/d/uploads/a.pdf', name: 'a.pdf' }],
        connectors: ['gmail'],
        timeout_secs: 7200,
      }),
    ])
    expect(wire.files).toEqual([{ path: '/d/uploads/a.pdf', name: 'a.pdf' }])
    expect(wire.connectors).toEqual(['gmail'])
    expect(wire.timeout_secs).toBe(7200)
    expect(wire.title).toBe('Step 1')
  })

  test('a per-step ending is typed or absent — never a string', () => {
    expect(stepsToWire([newStep({ text: 'x', notifyOnDone: true })])[0].on_complete).toEqual({
      kind: 'notify',
    })
    expect(stepsToWire([newStep({ text: 'x' })])[0].on_complete).toBeUndefined()
  })

  test('an edited workflow round-trips through the draft', () => {
    const d = draftFromWorkflow({
      workflow: {
        id: 'WF-1',
        title: 'Weekly',
        session: 'scout',
        company_id: null,
        enabled: 1,
        trigger_kind: 'recurring',
        schedule_expr: 'weekly on mon at 9:00',
        next_run: null,
        last_run: null,
        run_count: 0,
        on_complete: '{"kind":"notify"}',
        created: 0,
        updated: 0,
        deleted: null,
      },
      steps: [
        {
          id: 'S1',
          workflow_id: 'WF-1',
          position: 0,
          title: 'Pull',
          command: '/numbers',
          prompt: 'for last week',
          files: '[]',
          connectors: '["gmail"]',
          timeout_secs: 7200,
          on_complete: '{"kind":"notify"}',
          created: 0,
          updated: 0,
        },
      ],
      last_run_summary: null,
    })
    expect(d.steps[0].text).toBe('/numbers for last week')
    expect(d.steps[0].connectors).toEqual(['gmail'])
    expect(d.steps[0].notifyOnDone).toBe(true)
    expect(d.onComplete).toEqual({ kind: 'notify' })
    expect(stepsToWire(d.steps)[0].command).toBe('/numbers')
  })

  test('a legacy connector_send row missing `to` normalizes — the edit route no longer white-screens', () => {
    const d = draftFromWorkflow({
      workflow: {
        id: 'WF-2',
        title: 'Legacy',
        session: 'scout',
        company_id: null,
        enabled: 1,
        trigger_kind: 'manual',
        schedule_expr: null,
        next_run: null,
        last_run: null,
        run_count: 0,
        // A partial/hand-authored row: connector_id + account_ref, no `to`.
        on_complete: '{"kind":"connector_send","connector_id":"gmail","account_ref":"a1"}',
        created: 0,
        updated: 0,
        deleted: null,
      },
      steps: [
        {
          id: 'S1',
          workflow_id: 'WF-2',
          position: 0,
          title: 'Do',
          command: '',
          prompt: 'the thing',
          files: '[]',
          connectors: '[]',
          timeout_secs: 1800,
          on_complete: null,
          created: 0,
          updated: 0,
        },
      ],
      last_run_summary: null,
    })
    // Normalized to a complete shape at the parse boundary.
    expect(d.onComplete).toEqual({
      kind: 'connector_send',
      connector_id: 'gmail',
      account_ref: 'a1',
      to: '',
      subject: null,
    })
    // The render-time validator must not throw on it — it names the gap instead.
    expect(() => draftProblem(d)).not.toThrow()
    expect(draftProblem(d)).toBe('Say who the summary goes to')
  })
})

describe('the dragon’s options are GONE, not hidden', () => {
  const all = composerSrc + triggerSrc + stepSrc

  test.each(['boot_dir', 'boot_provider', 'boot_worktree', 'bypass_permissions', 'done_pattern', '_test_fire'])(
    '%s cannot be expressed anywhere in the composer',
    (field) => {
      expect(all).not.toContain(field)
    },
  )

  test('there is no kind toggle and no shell', () => {
    expect(all).not.toContain("kind: 'shell'")
    expect(all).not.toContain("kind: 'boot'")
    expect(all).not.toContain("kind: 'tmux'")
  })

  test('the composer sends no field the server refuses by name', () => {
    // The create body is built in one place; the keys are the whole payload.
    const start = composerSrc.indexOf('const body = {')
    const keys = composerSrc.slice(start, composerSrc.indexOf('}', start))
    expect(keys).toContain('title')
    expect(keys).toContain('session')
    expect(keys).toContain('trigger_kind')
    expect(keys).toContain('schedule_expr')
    expect(keys).toContain('on_complete')
    expect(keys).toContain('steps')
    expect(keys).not.toContain('command:')
    expect(keys).not.toContain('watch')
  })
})

describe('the page renders as a document with a pinned footer', () => {
  const html = body()

  test('the footer is pinned and safe-area aware — the iOS contract', () => {
    expect(html).toContain('pb-safe')
    expect(html).toContain('sticky bottom-0')
  })

  test('the validity line is a live region, so it is announced as it changes', () => {
    expect(html).toContain('aria-live="polite"')
  })

  test('Save and Save & run are both present, and Save is the primary', () => {
    expect(html).toContain('Save &amp; run')
    expect(html).toContain('bg-primary')
  })

  test('the trigger offers exactly three answers', () => {
    expect(html).toContain('When I say')
    expect(html).toContain('Once')
    expect(html).toContain('Repeating')
    expect(html).toContain('role="radiogroup"')
  })

  test('the quick cadences are one tap, with no keyboard', () => {
    expect(html).toContain('Every weekday, 9:00')
    expect(html).toContain('Mondays, 9:00')
    expect(html).toContain('Every hour')
  })

  test('the cadence is read back in English, and the raw expression is not the headline', () => {
    expect(html).toContain('Every weekday at 09:00')
  })

  test('reordering is ▲▼ in the step menu — drag-to-reorder is not shipped', () => {
    expect(stepSrc).toContain('Move up')
    expect(stepSrc).toContain('Move down')
    expect(stepSrc).not.toContain('useDraggable')
    expect(stepSrc).not.toContain('draggable=')
  })

  test('both reorder paths buzz — the same haptic the nav uses', () => {
    expect(stepSrc).toContain('navigator.vibrate?.(8)')
  })

  test('the file chip promises what actually happens to a path', () => {
    const expandedHtml = render(
      <ComposerBody
        id={null}
        initial={draft()}
        previewFn={preview}
        sessionsOverride={[{ name: 'scout' }]}
        initialExpanded={0}
      />,
    )
    expect(expandedHtml).toContain('Paths are pasted into the prompt when this step runs.')
    expect(expandedHtml).toContain('The bot is told to use these. It may still choose others.')
  })

  test('the timeout is three chips, never a number input', () => {
    expect(stepSrc).toContain('30 min')
    expect(stepSrc).toContain('2 hours')
    expect(stepSrc).toContain('8 hours')
    expect(stepSrc).not.toContain('timeout_secs}\n            type="number"')
  })
})
