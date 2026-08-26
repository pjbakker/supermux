/**
 * T5.4 — Workflows is REACHABLE, and it is reachable in the one place the
 * decision put it.
 *
 * A SOURCE SCAN, in the `tour-anchors.test.ts` idiom: `NAV` is a module-private
 * const in `layout.tsx` (exporting it would break react-refresh on the file
 * that owns the shell), and the routes it points at only exist inside a booted
 * router. Rendering all of that would be a worse test of a weaker claim.
 *
 * What each assertion is protecting:
 *
 *  * the ORDER — Connectors then Workflows, because that is the order the two
 *    are learned in: you give a bot its tools, then you give it a job;
 *  * `grokOnly` — the locked decision. Without it the BASE phone rail goes from
 *    four cells to five and `--nav-n` / `data-tab-count` / the sliding-pill
 *    geometry all need a respec they have not had;
 *  * the redirect — `/scheduler` is a URL people have bookmarked, and a 404 is
 *    not what "we renamed it" should feel like;
 *  * the palette keywords — somebody who learned the word "cron" must still
 *    find this by typing it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))
const layout = readFileSync(join(SRC, 'components/layout.tsx'), 'utf8')
const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
const palette = readFileSync(
  join(SRC, 'components/command-palette/command-palette.tsx'),
  'utf8',
)

/** The NAV array's entries, in source order, as `to` values. */
const navBody = layout.slice(layout.indexOf('const NAV: NavItem[] = ['))
const navOrder = Array.from(navBody.slice(0, navBody.indexOf('\n]')).matchAll(/to: '([^']+)'/g)).map(
  (m) => m[1],
)

describe('the nav item', () => {
  test('Workflows sits immediately after Connectors', () => {
    const i = navOrder.indexOf('/store')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(navOrder[i + 1]).toBe('/workflows')
  })

  test('it is grokOnly — the base rail stays four items', () => {
    const entry = navBody.slice(navBody.indexOf("to: '/workflows'"))
    const line = entry.slice(0, entry.indexOf('\n'))
    expect(line).toContain('grokOnly: true')
    // Nav label shortened to 'Flows' (the page/route stays "workflows"); the
    // short label keeps the active-pill from overflowing on the phone nav.
    expect(line).toContain("label: 'Flows'")
  })
})

describe('the route', () => {
  test('/workflows is registered and lazy, like /store', () => {
    expect(app).toContain("path=\"/workflows\"")
    expect(app).toContain("import('@/routes/workflows')")
  })

  test('/scheduler redirects to the list, not to a 404 and not to Settings', () => {
    const line = app.slice(app.indexOf('path="/scheduler"'))
    const stanza = line.slice(0, 200)
    expect(stanza).toContain('to="/workflows"')
    expect(stanza).toContain('replace')
    expect(stanza).not.toContain('#schedules')
  })
})

describe('the command palette', () => {
  test('the Schedules entry became a Workflows entry', () => {
    expect(palette).not.toContain("'/settings#schedules'")
    expect(palette).toContain("go(\n        '/workflows',")
  })

  test('it keeps every keyword somebody already learned, and adds the new ones', () => {
    const entry = palette.slice(palette.indexOf("go(\n        '/workflows',"))
    const stanza = entry.slice(0, 300)
    for (const kw of ['scheduler', 'cron', 'recurring', 'timer', 'prompt later']) {
      expect(stanza).toContain(kw)
    }
    for (const kw of ['workflow', 'steps', 'chain']) expect(stanza).toContain(kw)
  })
})
