/**
 * Settings → Imported schedules: the 0038 archive is genuinely reachable.
 * ─────────────────────────────────────────────────────────────────────────────
 * Migration 0038 dropped the `schedules` table irreversibly and archived every
 * pre-drop row in `workflows_import_log`. The post-upgrade notification
 * (server: workflows/port.rs) deep-links `/settings#imported-schedules` — this
 * suite pins the contract that makes that link honest:
 *
 *   1. THE ANCHOR EXISTS. The card carries id `imported-schedules`, and the
 *      Settings route mounts the section OUTSIDE the collapsed Advanced group
 *      (a fragment can only scroll to an always-rendered target). The server's
 *      deep link and the web anchor are read from BOTH source files, so neither
 *      side can drift alone.
 *   2. THE ROWS ARE READ TOTALLY. `describeImportRow` reads the archived
 *      pre-drop row JSON (name, command/prompt, cadence, last run) and degrades
 *      to the `old_id` on a null/foreign shape — never a throw inside a render.
 *   3. WHAT THE USER SEES. A refused row shows WHY it was refused and the
 *      literal command line, so a shell job can be rebuilt by hand; a ported
 *      row says it became a workflow. Nothing claims a migration that did not
 *      happen.
 *   4. WHEN IT SHOWS. Only a non-empty archive renders the section — a fresh
 *      install (or an errored/non-array body) hides it entirely.
 *
 * No DOM: pure helpers + presentational components via `react-dom/server`,
 * like the rest of the unit net (`bun test`).
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  IMPORTED_SCHEDULES_ANCHOR,
  ImportedSchedulesCard,
  describeImportRow,
  shouldShowImportLog,
} from '../../src/components/settings/imported-schedules'
import type { ImportedSchedule } from '../../src/lib/api/workflows'

const refusedShell: ImportedSchedule = {
  old_id: 'SCH-linkbuilder',
  ported: false,
  reason: 'kind shell has no Workflows v1 equivalent',
  row: {
    id: 'SCH-linkbuilder',
    name: 'linkbuilder-bridge',
    kind: 'shell',
    command: 'node ~/bridge.mjs --tick',
    schedule_expr: 'every 15m',
    enabled: 1,
    last_run: 1756049400,
  },
  at: 1756049800,
}

const portedPrompt: ImportedSchedule = {
  old_id: 'SCH-daily',
  ported: true,
  reason: '',
  row: { id: 'SCH-daily', kind: 'prompt', prompt: 'summarize the inbox', schedule_expr: '@daily' },
  at: 1756049800,
}

describe('describeImportRow reads the archived row totally', () => {
  test('a shell row yields its name, command line and cadence', () => {
    const d = describeImportRow(refusedShell)
    expect(d.name).toBe('linkbuilder-bridge')
    expect(d.what).toBe('node ~/bridge.mjs --tick')
    expect(d.cadence).toBe('every 15m')
  })

  test('a prompt row falls back to the prompt text and the old id', () => {
    const d = describeImportRow(portedPrompt)
    expect(d.name).toBe('SCH-daily')
    expect(d.what).toBe('summarize the inbox')
  })

  test('a null / foreign-shaped row degrades to the old_id, never throws', () => {
    const d = describeImportRow({ old_id: 'SCH-x', ported: false, reason: 'r', row: null, at: 0 })
    expect(d.name).toBe('SCH-x')
    expect(d.what).toBe('')
    expect(d.cadence).toBe('')
  })
})

describe('shouldShowImportLog', () => {
  test('true only for a non-empty array', () => {
    expect(shouldShowImportLog([refusedShell])).toBe(true)
    expect(shouldShowImportLog([])).toBe(false)
    expect(shouldShowImportLog(undefined)).toBe(false)
    // Defensive: an offline / errored endpoint can resolve with a non-array
    // body — the section hides rather than crashing on `.map`.
    expect(shouldShowImportLog({ error: 'nope' })).toBe(false)
  })
})

describe('the card', () => {
  const html = renderToStaticMarkup(
    <ImportedSchedulesCard rows={[refusedShell, portedPrompt]} />,
  )

  test('carries the deep-link anchor', () => {
    expect(html).toContain(`id="${IMPORTED_SCHEDULES_ANCHOR}"`)
  })

  test('a refused row shows the reason and the literal command line', () => {
    expect(html).toContain('kind shell has no Workflows v1 equivalent')
    expect(html).toContain('node ~/bridge.mjs --tick')
    expect(html).toContain('linkbuilder-bridge')
  })

  test('a ported row is labelled as carried over, not as needing rescue', () => {
    expect(html).toContain('Became a workflow')
  })
})

describe('the wiring both sides of the deep link depend on', () => {
  test('the server notification and the web anchor agree', () => {
    const port = readFileSync(
      new URL('../../../server/src/workflows/port.rs', import.meta.url),
      'utf8',
    )
    expect(port).toContain(`/settings#${IMPORTED_SCHEDULES_ANCHOR}`)
    expect(IMPORTED_SCHEDULES_ANCHOR).toBe('imported-schedules')
  })

  test('Settings mounts the section OUTSIDE the collapsed Advanced group', () => {
    const settings = readFileSync(
      new URL('../../src/routes/settings.tsx', import.meta.url),
      'utf8',
    )
    const section = settings.indexOf('<ImportedSchedulesSection')
    const advanced = settings.indexOf('<AdvancedGroup>')
    expect(section).toBeGreaterThan(-1)
    expect(advanced).toBeGreaterThan(-1)
    // A fragment can only scroll to an always-rendered element; anything inside
    // the (collapsed-by-default) Advanced body is not one.
    expect(section).toBeLessThan(advanced)
  })
})
