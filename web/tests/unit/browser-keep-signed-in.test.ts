/**
 * "KEEP ME SIGNED IN" — the copy, pinned.
 * ─────────────────────────────────────────────────────────────────────────────
 * This feature's entire interface is one menu row and one sentence under it, so
 * that sentence IS the product. Four classes of bug live in it and none of them
 * shows up in a screenshot:
 *
 *   · a CLAIM that is not backed by evidence. supermux must never say "you are
 *     signed in"; it says when it last checked, or why it cannot. A row that
 *     silently keeps rendering "Every 45 min · checked 12 min ago." while the
 *     sweep has been stuck for two hours is the exact false green light the
 *     workspace was built to prevent.
 *
 *   · a line that DOES NOT FIT. The ⋯ menu is a fixed 232px popup and the
 *     detail clamps at two lines. A sentence past ~88 characters is silently
 *     truncated on a phone, which turns the honest half into the invisible
 *     half. Every string this module can produce is measured below — including
 *     the ones with a hostname interpolated into them.
 *
 *   · the WATCH state described as refreshing. Watch mode is the one case where
 *     supermux deliberately does nothing: the site expires sessions in minutes
 *     and defeating that on a bank tab is indefensible. Saying "refreshing"
 *     there would be a lie about a security control.
 *
 *   · a SIGNED-OUT tab that reads as fine. `needs_login` 409s every agent verb
 *     on the tab, so it outranks the cadence line.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import type { BrowserTab } from '../../src/lib/api/browser'
import {
  DETAIL_MAX,
  STALE_INTERVALS,
  canKeepSignedIn,
  everyLabel,
  isWatching,
  keepAliveRow,
  keepAliveSheetRow,
} from '../../src/lib/browser/keep-signed-in'

const NOW = 1_788_000_000

function tab(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'tb_x',
    title: 'Seller Central',
    url: 'https://bol.com/account',
    pinned: false,
    company_id: null,
    origins: ['bol.com'],
    login_state: 'ok',
    last_probe_at: NOW - 720,
    live: true,
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
    grants: [],
    created_at: NOW - 100_000,
    last_used_at: NOW - 100,
    ...over,
  }
}

describe('the ⋯ row', () => {
  test('a page the ping cannot reach is greyed, with the reason — never hidden', () => {
    for (const url of ['about:blank', 'chrome://newtab', 'file:///etc/hosts', '']) {
      const row = keepAliveRow(tab({ url }), NOW)
      expect(row.disabled).toBe(true)
      expect(row.label).toBe('Keep me signed in')
      expect(row.hint).toBe('Only web pages can be kept signed in')
      // A greyed row shows no state, because there is none to show.
      expect(row.detail).toBeUndefined()
    }
    // No active tab at all is the same row.
    expect(keepAliveRow(null, NOW).disabled).toBe(true)
    expect(canKeepSignedIn('https://x.example/')).toBe(true)
    expect(canKeepSignedIn('http://x.internal/')).toBe(true)
  })

  test('off: the label is the verb and the line names the site', () => {
    const row = keepAliveRow(tab(), NOW)
    expect(row.label).toBe('Keep me signed in')
    expect(row.detail).toBe('Refresh bol.com so bots stay signed in.')
    expect(row.disabled).toBeFalsy()
  })

  test('off: a hostname too long to fit loses its NAME, never the sentence', () => {
    const host = `${'sub.'.repeat(12)}example.com`
    const row = keepAliveRow(tab({ url: `https://${host}/x` }), NOW)
    expect(row.detail).toBe('Refresh this site so bots stay signed in.')
    expect(row.detail!.length).toBeLessThanOrEqual(DETAIL_MAX)
  })

  test('on, never checked: "Starting" appears ONLY while last_keepalive_at is null', () => {
    const starting = keepAliveRow(tab({ keepalive_enabled: true, last_keepalive_at: null }), NOW)
    expect(starting.label).toBe('Stop keeping signed in')
    expect(starting.detail).toBe('Starting — first check within a minute.')

    const checked = keepAliveRow(
      tab({ keepalive_enabled: true, keepalive_action: 'soft', last_keepalive_at: NOW - 1 }),
      NOW,
    )
    expect(checked.detail).not.toContain('Starting')
  })

  test('on and healthy: an interval AND an age, both of them coarse', () => {
    const row = keepAliveRow(
      tab({
        keepalive_enabled: true,
        keepalive_action: 'soft',
        keepalive_every: 45,
        last_keepalive_at: NOW - 720,
      }),
      NOW,
    )
    expect(row.detail).toBe('Every 45 min · checked 12 min ago.')
  })

  test('watch mode says WATCHING, and never says refreshing', () => {
    const row = keepAliveRow(
      tab({
        keepalive_enabled: true,
        keepalive_action: 'watch',
        keepalive_every: 10,
        last_keepalive_at: NOW - 300,
      }),
      NOW,
    )
    expect(row.detail).toBe('Watching only — this site signs out in minutes.')
    // The full reason lives in the sheet, which has room for it.
    expect(keepAliveSheetRow(tab({ keepalive_enabled: true, keepalive_action: 'watch' })).detail)
      .toContain("won't hammer it")
  })

  test('a signed-out tab outranks the cadence line — bots on it are 409ing', () => {
    const row = keepAliveRow(
      tab({
        keepalive_enabled: true,
        keepalive_action: 'soft',
        keepalive_every: 10,
        login_state: 'needs_login',
        last_keepalive_at: NOW - 120,
      }),
      NOW,
    )
    expect(row.detail).toBe('Signed out — take the wheel and sign in again.')
  })

  test('the stale line flips at exactly three missed intervals, and carries the age', () => {
    const every = 45
    const cutoff = STALE_INTERVALS * every * 60
    const fresh = keepAliveRow(
      tab({
        keepalive_enabled: true,
        keepalive_action: 'soft',
        keepalive_every: every,
        last_keepalive_at: NOW - cutoff,
      }),
      NOW,
    )
    expect(fresh.detail).toBe('Every 45 min · checked 2 h ago.')

    const stale = keepAliveRow(
      tab({
        keepalive_enabled: true,
        keepalive_action: 'soft',
        keepalive_every: every,
        last_keepalive_at: NOW - cutoff - 1,
      }),
      NOW,
    )
    expect(stale.detail).toBe("Hasn't been able to check since 2 h ago.")
  })

  test('the interval reads coarsely: minutes, then hours', () => {
    expect(everyLabel(5)).toBe('5 min')
    expect(everyLabel(45)).toBe('45 min')
    expect(everyLabel(119)).toBe('119 min')
    expect(everyLabel(120)).toBe('2 h')
    expect(everyLabel(360)).toBe('6 h')
    // A row that has never been stamped still renders something sane.
    expect(everyLabel(0)).toBe('15 min')
  })

  test('EVERY line this module can produce fits the MEASURED two-line clamp', () => {
    // 54 is not a guess: the detail column measures 176px at 11.5px/15.8px and
    // clamps at two lines, and the rig read a 61-character line truncating
    // (scrollHeight 47 vs clientHeight 32) on a 390px phone bench.
    expect(DETAIL_MAX).toBe(54)
    const cases: BrowserTab[] = [
      tab(),
      tab({ url: 'https://a.example/' }),
      tab({ url: `https://${'sub.'.repeat(12)}example.com/` }),
      tab({ keepalive_enabled: true, last_keepalive_at: null }),
      tab({ keepalive_enabled: true, keepalive_action: 'soft', last_keepalive_at: NOW - 60 }),
      tab({ keepalive_enabled: true, keepalive_action: 'watch', last_keepalive_at: NOW - 60 }),
      tab({ keepalive_enabled: true, login_state: 'needs_login', last_keepalive_at: NOW - 60 }),
      tab({
        keepalive_enabled: true,
        keepalive_every: 360,
        last_keepalive_at: NOW - 30 * 86_400,
      }),
    ]
    for (const t of cases) {
      const { detail } = keepAliveRow(t, NOW)
      if (detail === undefined) continue
      expect(detail.length).toBeLessThanOrEqual(DETAIL_MAX)
    }
  })
})

describe('the sheet row — where the cost is stated', () => {
  test('off names what is lost, not what is gained', () => {
    const r = keepAliveSheetRow(tab())
    expect(r.on).toBe(false)
    expect(r.title).toBe('Not kept signed in')
    expect(r.detail).toBe('Bots lose access when the site signs this tab out.')
  })

  test('on states the price: a page held open, and a cap of four', () => {
    const r = keepAliveSheetRow(tab({ keepalive_enabled: true, keepalive_action: 'soft' }))
    expect(r.title).toBe('Keeping you signed in')
    expect(r.detail).toContain('Holds the page open in the browser — up to 4 tabs.')
  })

  test('watch says supermux will not hammer the site, and will tell you', () => {
    const r = keepAliveSheetRow(tab({ keepalive_enabled: true, keepalive_action: 'watch' }))
    expect(r.title).toBe('Watching this tab')
    expect(r.detail).toContain("won't hammer it")
  })

  test('any unrecognised mode — the column default included — means soft', () => {
    expect(isWatching(tab({ keepalive_action: 'reload' }))).toBe(false)
    expect(isWatching(tab({ keepalive_action: '' }))).toBe(false)
    expect(isWatching(tab({ keepalive_action: 'watch' }))).toBe(true)
  })
})

describe('honesty, asserted against the source', () => {
  const src = readFileSync(
    new URL('../../src/lib/browser/keep-signed-in.ts', import.meta.url),
    'utf8',
  )
  const workspace = readFileSync(
    new URL('../../src/components/browser/workspace.tsx', import.meta.url),
    'utf8',
  )

  test('no copy claims the tab "stays logged in", and none blames a restart', () => {
    expect(src.toLowerCase()).not.toContain('stays logged in')
    expect(src.toLowerCase()).not.toContain('stay logged in')
    // Session cookies were measured surviving both a clean Chrome close and a
    // SIGKILL on this durable profile, so a restart warning here would be false.
    expect(src.toLowerCase()).not.toContain('restart')
  })

  test('there is no countdown and no interval picker', () => {
    // `now` is INJECTED (a default parameter), never read on a timer: a
    // backgrounded PWA must not re-render a clock nobody is watching, and the
    // line is recomputed when the menu opens.
    for (const banned of ['setInterval', 'setTimeout', 'requestAnimationFrame', 'useEffect']) {
      expect(src).not.toContain(banned)
    }
    // Nothing here proposes a cadence — the server learns it from the jar.
    expect(src).not.toContain('keepalive_every:')
    expect(src).not.toContain('keepalive_action:')
  })

  test('the workspace offers the row once, in the PAGE menu, above Sharing', () => {
    // The page menu only — the tab menu (right-click a chip) keeps its verbs.
    const pageRows = workspace.slice(
      workspace.indexOf('const pageRows'),
      workspace.indexOf('/** The verb table.'),
    )
    expect(pageRows).toContain("id: 'keepalive'")
    expect(pageRows.indexOf("id: 'keepalive'")).toBeLessThan(pageRows.indexOf("id: 'sharing'"))
    expect(workspace.split("id: 'keepalive'").length - 1).toBe(1)
    expect(workspace).toContain('onKeepAlive?.(active.id, !active.keepalive_enabled)')
  })
})
