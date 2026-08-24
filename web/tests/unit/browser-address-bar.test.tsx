/**
 * The omnibox and the persistent chrome — Phase 1 of the shared-browser human UI.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two of the owner's three complaints are asserted here, because both are
 * STRUCTURAL and neither shows up in a screenshot:
 *
 *   1. "it even CAPITALISES". The box this replaces carried seven attributes
 *      and none of the eight that stop a phone treating an address as prose.
 *      A missing `autoCapitalize` is invisible on a desktop bench and ruins
 *      every single mobile keystroke, so the attribute set is pinned here
 *      rather than eyeballed.
 *
 *   2. it zoomed. `web/index.html` deliberately ships no `user-scalable=no`
 *      and says in a comment that the iOS focus-zoom is solved by ≥16px inputs
 *      instead; the old field was `text-[12.5px]`, i.e. the one input in the
 *      app that broke the rule the viewport meta depends on. The floor is
 *      asserted, and the sub-16px classes are asserted ABSENT — a re-dress
 *      that "tidies" the font size back down fails this file.
 *
 * Plus the thing that made the address bar unreachable in the first place: the
 * chrome used to live inside the takeover panel's header slot, so it existed
 * only for a LIVE tab — and no human verb could make a tab live. The chrome is
 * now a sibling of the viewport, and this file proves it renders with no tab at
 * all, with an asleep tab (offering Wake), and with a live one (offering
 * Reload).
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AddressBar } from '../../src/components/browser/address-bar'
import { BrowserChrome } from '../../src/components/browser/browser-chrome'
import type { BrowserTab } from '../../src/lib/api/browser'

function tab(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'tb_one',
    title: 'Inbox',
    url: 'https://mail.example/inbox',
    pinned: false,
    company_id: null,
    origins: ['mail.example'],
    login_state: 'ok',
    last_probe_at: null,
    live: true,
    grants: [],
    created_at: 1_000,
    last_used_at: null,
    ...over,
  }
}

const chrome = (over: Partial<Parameters<typeof BrowserChrome>[0]> = {}) =>
  renderToStaticMarkup(
    <BrowserChrome
      tab={tab()}
      url="https://mail.example/inbox"
      live
      driving={false}
      canDrive
      onNavigate={() => {}}
      onWake={() => {}}
      onReload={() => {}}
      onResync={() => {}}
      onWatch={() => {}}
      onDrive={() => {}}
      onMenu={() => {}}
      {...over}
    />,
  )

describe('the omnibox has the input hygiene a phone needs', () => {
  const html = renderToStaticMarkup(
    <AddressBar url="https://mail.example/inbox" live onNavigate={() => {}} />,
  )

  // React's SSR writes these attribute names in camelCase (HTML parses them
  // case-insensitively), so the assertions are made on the lowered markup —
  // it is the attribute's PRESENCE that the phone cares about.
  const flat = html.toLowerCase()

  test('every attribute the old box was missing is present', () => {
    // ← the "even CAPITALISES" complaint, in one line.
    expect(flat).toContain('autocapitalize="none"')
    expect(flat).toContain('autocorrect="off"')
    expect(flat).toContain('spellcheck="false"')
    expect(flat).toContain('autocomplete="off"')
    // The URL keyboard (/ . : and .com) and a Go key instead of "return".
    expect(flat).toContain('inputmode="url"')
    expect(flat).toContain('enterkeyhint="go"')
    expect(flat).toContain('name="address"')
    expect(flat).toContain('aria-label="address and search"')
  })

  test('type is text, NOT url — `type="url"` refuses a search query on submit', () => {
    expect(html).toContain('type="text"')
    expect(html).not.toContain('type="url"')
  })

  test('the field is ≥16px, so iOS does not focus-zoom the whole shell', () => {
    expect(html).toContain('text-[16px]')
    // And nothing smaller may be applied to the INPUT. The old box was
    // `text-[12.5px]`; a "tidy-up" that puts any sub-16px step back on this
    // element reintroduces the zoom silently, on a device no bench runs on.
    const input = html.slice(html.indexOf('<input'))
    const classes = input.slice(input.indexOf('class="') + 7)
    const applied = classes.slice(0, classes.indexOf('"'))
    for (const banned of ['text-[12.5px]', 'text-[13px]', 'text-[14px]', 'text-[15px]']) {
      expect(applied).not.toContain(banned)
    }
  })

  test('the target is 44px and the field is min-w-0, so 390px cannot overflow', () => {
    expect(html).toContain('min-h-11')
    expect(html).toContain('min-w-0')
  })
})

describe('the omnibox shows the current page, formatted', () => {
  test('idle it renders the trimmed url as the input VALUE — not a dead span', () => {
    const html = renderToStaticMarkup(
      <AddressBar url="https://www.example.com/inbox" live onNavigate={() => {}} />,
    )
    expect(html).toContain('value="example.com/inbox"')
    expect(html).toContain('data-address-intent="idle"')
  })

  test('with no page it is still mounted, and says what it is for', () => {
    const html = renderToStaticMarkup(<AddressBar url="" onNavigate={() => {}} />)
    expect(html).toContain('placeholder="Search or type a URL"')
    expect(html).toContain('value=""')
  })
})

describe('the chrome is persistent — it reports, it does not vanish', () => {
  test('no tab at all: the bar still stands and the state line is honest', () => {
    const html = chrome({ tab: null, url: '', live: false, canDrive: false })
    expect(html).toContain('data-address-bar')
    expect(html).toContain('No tab open')
    expect(html).toContain('data-tab-state="none"')
  })

  test('the power cell is Wake when asleep and Sleep when live — one cell', () => {
    const asleep = chrome({ tab: tab({ live: false }), live: false, canDrive: false })
    expect(asleep).toContain('data-chrome-wake')
    expect(asleep).toContain('aria-label="Wake tab"')
    expect(asleep).not.toContain('data-chrome-sleep')
    // Reload keeps its own cell either way (greyed, not gone) so waking a tab
    // does not reflow the row under the human's thumb.
    expect(asleep).toContain('data-chrome-reload')

    const live = chrome({ onSleep: () => {} })
    expect(live).toContain('data-chrome-sleep')
    expect(live).not.toContain('data-chrome-wake')
    expect(live).toContain('data-chrome-reload')
  })

  test('resync is wired at last, and disabled while nothing is live', () => {
    expect(chrome()).toContain('data-chrome-resync')
    expect(chrome({ live: false, canDrive: false })).toContain('disabled=""')
  })

  test('Watch/Drive keeps its radiogroup, and Drive waits for a live socket', () => {
    expect(chrome()).toContain('aria-label="Who is driving"')
    expect(chrome({ canDrive: false })).toContain('aria-checked="false"')
  })
})

describe('the transient compose bar is gone for good', () => {
  const workspace = readFileSync('src/components/browser/workspace.tsx', 'utf8')

  test('no row-creation form, no `composing` state', () => {
    expect(workspace).not.toContain('data-tab-compose')
    expect(workspace).not.toContain('setComposing')
  })

  test('the chrome is mounted OUTSIDE the live branch', () => {
    // The whole of complaint #1's structure: while the chrome lived in
    // `renderHeader`, it could only exist for a tab that was already live.
    const chromeAt = workspace.indexOf('<BrowserChrome')
    const branchAt = workspace.indexOf('{!active ? (')
    expect(chromeAt).toBeGreaterThan(0)
    expect(branchAt).toBeGreaterThan(chromeAt)
  })

  test('the asleep card offers the wake verb the server now has', () => {
    expect(workspace).toContain('data-tab-wake')
    expect(workspace).toContain('Wake tab')
  })
})
