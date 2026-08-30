/**
 * THE ⋯ MENU ROW WITH A SECOND LINE.
 * ─────────────────────────────────────────────────────────────────────────────
 * `BrowserMenuItem.hint` renders only as a `title=` attribute, and a phone has
 * no hover — so before `detail` a menu row physically could not show state.
 * "Keep me signed in" is a row whose whole value IS its state ("Every 45 min ·
 * checked 12 min ago"), which is why the field exists.
 *
 * Two things have to stay true, and both are the kind that break silently:
 *
 *   · EVERY EXISTING ROW RENDERS UNCHANGED. `detail` is optional, and a row
 *     without one must keep its single truncating span and its 44px tap target
 *     — a menu whose rows all grew taller to accommodate one new row is a
 *     regression in eight places to fix one.
 *
 *   · THE ROW STAYS ONE BUTTON. Two lines inside one `role="menuitem"`, not two
 *     elements: roving focus, Enter, and `disabled` all hang off that button,
 *     and a detail line that became its own focusable node would break the
 *     keyboard path this menu documents at the top of its file.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { BrowserMenu, type BrowserMenuItem } from '../../src/components/browser/browser-menu'
import { keepAliveRow } from '../../src/lib/browser/keep-signed-in'
import type { BrowserTab } from '../../src/lib/api/browser'

const NOW = 1_788_000_000

function menu(items: BrowserMenuItem[]): string {
  return renderToStaticMarkup(
    <BrowserMenu
      at={{ x: 10, y: 10 }}
      items={items}
      label="Page menu"
      onSelect={() => {}}
      onClose={() => {}}
      fixed
    />,
  )
}

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
    keepalive_enabled: true,
    keepalive_every: 45,
    keepalive_action: 'soft',
    last_keepalive_at: NOW - 720,
    grants: [],
    created_at: NOW - 100_000,
    last_used_at: NOW - 100,
    ...over,
  }
}

describe('BrowserMenuItem.detail', () => {
  test('draws a second, muted line INSIDE the one menuitem button', () => {
    const html = menu([{ id: 'keepalive', ...keepAliveRow(tab(), NOW) }])
    expect(html).toContain('Stop keeping signed in')
    expect(html).toContain('Every 45 min · checked 12 min ago.')
    expect(html).toContain('data-browser-menu-detail="keepalive"')
    // One button, two lines — not two rows.
    expect(html.split('role="menuitem"').length - 1).toBe(1)
    expect(html).toContain('line-clamp-2')
  })

  test('a row WITHOUT a detail is byte-identical to before: one span, min-h-11', () => {
    const html = menu([{ id: 'copy-url', label: 'Copy link' }])
    expect(html).toContain('min-h-11')
    expect(html).not.toContain('min-h-14')
    expect(html).not.toContain('data-browser-menu-detail')
    expect(html).not.toContain('line-clamp-2')
  })

  test('a row WITH a detail gets the taller tap target, and only that row', () => {
    const html = menu([
      { id: 'copy-url', label: 'Copy link' },
      { id: 'keepalive', ...keepAliveRow(tab(), NOW) },
    ])
    expect(html).toContain('min-h-11')
    expect(html).toContain('min-h-14')
  })

  test('disabled still greys the row and keeps the reason on its title', () => {
    const html = menu([{ id: 'keepalive', ...keepAliveRow(tab({ url: 'about:blank' }), NOW) }])
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="Only web pages can be kept signed in"')
    expect(html).toContain('Keep me signed in')
    // Nothing is claimed about a page that cannot be pinged.
    expect(html).not.toContain('data-browser-menu-detail')
  })

  test('the label is the VERB, and it flips with the state', () => {
    expect(menu([{ id: 'keepalive', ...keepAliveRow(tab({ keepalive_enabled: false }), NOW) }]))
      .toContain('Keep me signed in')
    expect(menu([{ id: 'keepalive', ...keepAliveRow(tab(), NOW) }])).toContain(
      'Stop keeping signed in',
    )
  })
})
