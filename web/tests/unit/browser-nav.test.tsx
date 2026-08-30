/**
 * PHASE 3 — the half of the shared browser that makes it a BROWSER.
 * ─────────────────────────────────────────────────────────────────────────────
 * Five things here are invisible in a screenshot and wrong in a way nobody
 * notices until it matters, so all five are pinned:
 *
 *   · the WIRE. `nav_state` is a flat, tagged frame whose field names
 *     (`can_go_back`, `default_prompt`, …) are pinned by a Rust test precisely
 *     because this client parses them. A rename on either side must fail on
 *     both, and a frame from an older server must degrade to "we don't know"
 *     rather than throwing inside a socket `onmessage` — which would take the
 *     whole relay down with it.
 *
 *   · the GREYING. Back is grey on the first page of a history and lit the
 *     instant there is something behind it, straight off `can_go_back`. An
 *     always-lit arrow that sometimes does nothing is the "moved:false is a
 *     normal state" case the server documents, made into a UI bug.
 *
 *   · the FAVICON, which is UNTRUSTED INPUT: a `data:` URI whose bytes the
 *     PAGE chose. `safeFavicon` is the allowlist, and the fallback tile is what
 *     stops a rejected icon becoming a blank square.
 *
 *   · the DIALOG. A page with an open `alert()` is a page chrome has stopped
 *     dead: same frame forever, every tap relayed into something that will not
 *     answer. The answer must default to DISMISS on a garbled frame, because
 *     this tab is signed in to things.
 *
 *   · the PARSE, made visible. Row 0 of the suggestion list must always mirror
 *     what Enter is about to do, and a tab row must SWITCH rather than open a
 *     ninth copy of an inbox that is already signed in.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  EMPTY_NAV,
  faviconTile,
  originOf,
  parseNavState,
  prettyHost,
  safeFavicon,
} from '../../src/lib/browser/nav-state'
import { MAX_OMNIBOX_ROWS, moveHighlight, omniboxRows } from '../../src/lib/browser/omnibox'
import {
  EMPTY_SNAPSHOT,
  TakeoverSocket,
  type SocketLike,
  type TakeoverSnapshot,
} from '../../src/lib/browser/takeover-socket'
import { NavControls } from '../../src/components/browser/nav-controls'
import { PageDialogSurface } from '../../src/components/browser/page-dialog'
import { SecurityPanel, securityTone } from '../../src/components/browser/security-chip'
import { TabStrip } from '../../src/components/browser/tab-strip'
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

/* ── the wire ────────────────────────────────────────────────────────────── */

describe('nav_state is parsed exactly as the server spells it', () => {
  const raw = {
    type: 'nav_state',
    url: 'https://mail.example/inbox',
    title: 'Inbox — Mail',
    favicon: 'data:image/png;base64,AAAA',
    loading: true,
    can_go_back: true,
    can_go_forward: false,
    secure: true,
    dialog: null,
  }

  test('every snake_case field lands on its camelCase home', () => {
    const nav = parseNavState(raw)
    expect(nav.url).toBe('https://mail.example/inbox')
    expect(nav.title).toBe('Inbox — Mail')
    expect(nav.favicon).toBe('data:image/png;base64,AAAA')
    expect(nav.loading).toBe(true)
    expect(nav.canGoBack).toBe(true)
    expect(nav.canGoForward).toBe(false)
    expect(nav.secure).toBe(true)
    expect(nav.dialog).toBeNull()
  })

  test('a frame missing everything degrades to "we do not know", never a throw', () => {
    // An older server, or a serde rename that lost a field. Every flag false
    // means every control greys — which is honest — instead of an exception
    // inside `onmessage` taking the relay down.
    expect(parseNavState({ type: 'nav_state' })).toEqual(EMPTY_NAV)
    expect(parseNavState({ loading: 'yes', can_go_back: 1 })).toEqual(EMPTY_NAV)
  })

  test('a dialog is parsed with its default_prompt, and defaults to alert', () => {
    const nav = parseNavState({
      ...raw,
      dialog: { kind: 'prompt', message: 'Name?', default_prompt: 'Ada' },
    })
    expect(nav.dialog).toEqual({ kind: 'prompt', message: 'Name?', default_prompt: 'Ada' })
    const bare = parseNavState({ ...raw, dialog: {} })
    expect(bare.dialog).toEqual({ kind: 'alert', message: '', default_prompt: '' })
  })
})

describe('the favicon is untrusted input', () => {
  test('data:image and https are admitted', () => {
    expect(safeFavicon('data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
    expect(safeFavicon('https://cdn.example/i.ico')).toBe('https://cdn.example/i.ico')
  })

  test('everything else becomes the tile — no javascript:, no data:text/html', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'http://cdn.example/i.ico',
      'blob:https://x/y',
      '',
      42,
      null,
    ]) {
      expect(safeFavicon(bad)).toBeNull()
    }
  })

  test('the fallback tile is a stable letter + hue, never a blank square', () => {
    const a = faviconTile('https://mail.example/inbox')
    expect(a.letter).toBe('M')
    // Same site, same colour — that stability is what makes a favicon-only
    // pinned chip identifiable before its real icon has ever loaded.
    expect(faviconTile('https://mail.example/other').hue).toBe(a.hue)
    expect(faviconTile('https://www.mail.example/x').hue).toBe(a.hue)
    expect(faviconTile('').letter).toBe('?')
  })

  test('the memo is keyed by ORIGIN, so a tab that moved cannot keep a face', () => {
    expect(originOf('https://mail.example/inbox?x=1')).toBe('https://mail.example')
    expect(originOf('https://mail.example:8443/x')).toBe('https://mail.example:8443')
    expect(originOf('not a url')).toBeNull()
    // A different origin misses the memo entirely — which is the point.
    expect(originOf('https://bank.example/portal')).not.toBe('https://mail.example')
  })

  test('prettyHost beats the raw url as a 112px chip title', () => {
    expect(prettyHost('https://www.reseller.example/back-office?period=q3')).toBe(
      'reseller.example',
    )
    expect(prettyHost('half typed')).toBe('half typed')
  })
})

/* ── the socket: the feed in, the controls out ───────────────────────────── */

class FakeSocket implements SocketLike {
  static open: FakeSocket[] = []
  readonly sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.open.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    FakeSocket.open = FakeSocket.open.filter((s) => s !== this)
  }
  accept() {
    this.onopen?.({})
    this.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) })
  }
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  parsed(): Array<{ type: string; [k: string]: unknown }> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

function harness() {
  FakeSocket.open = []
  const snaps: TakeoverSnapshot[] = []
  const sock = new TakeoverSocket(
    { kind: 'tab', id: 'tb_one' },
    (s) => snaps.push(s),
    () => undefined,
    {
      factory: (url) => new FakeSocket(url),
      token: () => 'T0KEN',
      baseUrl: () => 'ws://box:8824',
      schedule: () => 1,
      cancel: () => undefined,
    },
  )
  sock.start()
  const ws = FakeSocket.open[FakeSocket.open.length - 1]
  ws.accept()
  return {
    sock,
    ws,
    latest: () => snaps[snaps.length - 1] ?? EMPTY_SNAPSHOT,
    control: () => ws.parsed().filter((m) => m.type !== 'auth' && m.type !== 'viewport'),
  }
}

describe('the nav-state feed drives the snapshot', () => {
  test('a fresh snapshot knows nothing — every affordance is off', () => {
    expect(EMPTY_SNAPSHOT.nav).toEqual(EMPTY_NAV)
  })

  test('nav_state lands on `nav` AND moves `url` — the bar follows the page', () => {
    const h = harness()
    h.ws.deliver({ type: 'target', session: 'tb_one', url: 'https://mail.example/', width: 1, height: 1 })
    expect(h.latest().url).toBe('https://mail.example/')
    // The page redirected itself. The fire-once `target` frame cannot know, so
    // an address bar reading from it would be stale within seconds.
    h.ws.deliver({
      type: 'nav_state',
      url: 'https://mail.example/inbox?auth=ok',
      title: 'Inbox',
      favicon: null,
      loading: false,
      can_go_back: true,
      can_go_forward: false,
      secure: true,
      dialog: null,
    })
    expect(h.latest().url).toBe('https://mail.example/inbox?auth=ok')
    expect(h.latest().nav.canGoBack).toBe(true)
    expect(h.latest().nav.title).toBe('Inbox')
    h.sock.stop()
  })

  test('a nav_state with an empty url keeps the last one rather than blanking', () => {
    const h = harness()
    h.ws.deliver({ type: 'nav_state', url: 'https://a.example/', title: 'A' })
    h.ws.deliver({ type: 'nav_state', url: '', title: 'A', loading: true })
    expect(h.latest().url).toBe('https://a.example/')
    expect(h.latest().nav.loading).toBe(true)
    h.sock.stop()
  })
})

describe('the control frames are exactly what the server parses', () => {
  test('navigate / back / forward / reload / stop', () => {
    const h = harness()
    h.sock.navigate('https://example.test/x')
    h.sock.back()
    h.sock.forward()
    h.sock.reload()
    h.sock.reload(true)
    h.sock.stopLoading()
    expect(h.control()).toEqual([
      { type: 'navigate', url: 'https://example.test/x' },
      { type: 'back' },
      { type: 'forward' },
      { type: 'reload', ignore_cache: false },
      { type: 'reload', ignore_cache: true },
      { type: 'stop' },
    ])
    h.sock.stop()
  })

  test('an empty navigate is not sent — it would be a load of nothing', () => {
    const h = harness()
    h.sock.navigate('')
    expect(h.control()).toEqual([])
    h.sock.stop()
  })

  test('a dialog answer carries accept + prompt_text, and dismiss is a real false', () => {
    const h = harness()
    h.sock.dialog(true, 'Ada')
    h.sock.dialog(false)
    expect(h.control()).toEqual([
      { type: 'dialog', accept: true, prompt_text: 'Ada' },
      // `prompt_text` is dropped by JSON.stringify when undefined, which is
      // exactly what `#[serde(default)] Option<String>` expects.
      { type: 'dialog', accept: false },
    ])
    h.sock.stop()
  })
})

/* ── the controls ────────────────────────────────────────────────────────── */

const controls = (over: Partial<Parameters<typeof NavControls>[0]> = {}) =>
  renderToStaticMarkup(
    <NavControls
      canGoBack={false}
      canGoForward={false}
      loading={false}
      onBack={() => {}}
      onForward={() => {}}
      onReload={() => {}}
      onStop={() => {}}
      {...over}
    />,
  )

/** The `disabled` attribute of one `data-nav-*` cell. */
function cellDisabled(html: string, hook: string): boolean {
  const at = html.indexOf(hook)
  expect(at).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<button', at)
  return html.slice(open, at).includes('disabled=""')
}

describe('back and forward are grey until the history says otherwise', () => {
  test('nothing behind, nothing ahead: both arrows are disabled, not hidden', () => {
    const html = controls()
    expect(html).toContain('data-nav-back')
    expect(html).toContain('data-nav-forward')
    expect(cellDisabled(html, 'data-nav-back')).toBe(true)
    expect(cellDisabled(html, 'data-nav-forward')).toBe(true)
  })

  test('can_go_back lights Back on its own — the two flags are independent', () => {
    const html = controls({ canGoBack: true })
    expect(cellDisabled(html, 'data-nav-back')).toBe(false)
    expect(cellDisabled(html, 'data-nav-forward')).toBe(true)
  })

  test('no page at all greys every cell without changing the row', () => {
    const html = controls({ canGoBack: true, canGoForward: true, disabled: true })
    expect(cellDisabled(html, 'data-nav-back')).toBe(true)
    expect(cellDisabled(html, 'data-nav-forward')).toBe(true)
    expect(cellDisabled(html, 'data-nav-reload')).toBe(true)
  })

  test('reload BECOMES stop while loading — one cell, never a fourth button', () => {
    const idle = controls()
    expect(idle).toContain('data-nav-reload="reload"')
    expect(idle).not.toContain('data-nav-reload="stop"')

    const busy = controls({ loading: true })
    expect(busy).toContain('data-nav-reload="stop"')
    expect(busy).toContain('aria-label="Stop loading"')
    // Exactly as many cells as before: a Stop that ARRIVES would reflow the row
    // under a thumb that is already moving toward Reload.
    const cells = (h: string) => h.split('<button').length
    expect(cells(busy)).toBe(cells(idle))
  })

  test('every cell is a 44px target — 36px of ink plus the ::after inset', () => {
    const html = controls()
    expect(html).toContain('size-9')
    expect(html).toContain('after:-inset-1')
  })
})

/* ── the chrome, wired to the feed ───────────────────────────────────────── */

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
      onWatch={() => {}}
      onDrive={() => {}}
      onMenu={() => {}}
      {...over}
    />,
  )

describe('the chrome renders the feed, not a guess', () => {
  test('the arrows come straight off can_go_back / can_go_forward', () => {
    const html = chrome({
      nav: { ...EMPTY_NAV, url: 'https://mail.example/inbox', canGoBack: true, secure: true },
    })
    expect(cellDisabled(html, 'data-nav-back')).toBe(false)
    expect(cellDisabled(html, 'data-nav-forward')).toBe(true)
  })

  test('a loading page turns the cell into Stop and lights the hairline', () => {
    const html = chrome({ nav: { ...EMPTY_NAV, loading: true } })
    expect(html).toContain('data-nav-reload="stop"')
    expect(html).toContain('data-address-loading')
  })

  test('an asleep tab greys the whole row — there is no page to act on', () => {
    const html = chrome({
      tab: tab({ live: false }),
      live: false,
      nav: { ...EMPTY_NAV, canGoBack: true, canGoForward: true },
    })
    expect(cellDisabled(html, 'data-nav-back')).toBe(true)
    expect(cellDisabled(html, 'data-nav-reload')).toBe(true)
  })
})

/* ── the padlock ─────────────────────────────────────────────────────────── */

describe('the security chip claims only what it can prove', () => {
  test('https live is the lock; http live says the words out loud', () => {
    expect(securityTone('https://mail.example/x', true, true)).toBe('secure')
    expect(securityTone('http://docs.internal/x', false, true)).toBe('insecure')
  })

  test('an asleep tab makes NO claim, however good its url looks', () => {
    // The padlock is a claim about a CONNECTION. There is not one.
    expect(securityTone('https://mail.example/x', true, false)).toBe('none')
    expect(securityTone('', false, true)).toBe('none')
    // about:blank is neither encrypted nor cleartext — it was never fetched.
    expect(securityTone('about:blank', false, true)).toBe('none')
  })

  test('the chip renders "Not secure" in words, not a neutral globe', () => {
    const html = renderToStaticMarkup(
      <BrowserChrome
        tab={tab({ url: 'http://docs.internal/handbook' })}
        url="http://docs.internal/handbook"
        live
        nav={{ ...EMPTY_NAV, url: 'http://docs.internal/handbook', secure: false }}
        driving={false}
        canDrive
        onNavigate={() => {}}
        onWake={() => {}}
        onReload={() => {}}
        onWatch={() => {}}
        onDrive={() => {}}
        onMenu={() => {}}
      />,
    )
    expect(html).toContain('data-security-chip="insecure"')
    expect(html).toContain('Not secure')
  })

  test('the panel names the transport-only limit and the off-allowlist host', () => {
    const html = renderToStaticMarkup(
      <SecurityPanel
        tone="secure"
        url="https://newhost.example/page"
        origins={['mail.example']}
        detail="Signed in · verified 6 min ago"
        lent={2}
        onManage={() => {}}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('not about who is on the other end')
    expect(html).toContain('data-security-origin="mail.example"')
    // The nudge: honest, and it never blocks the human.
    expect(html).toContain('data-security-offlist')
    expect(html).toContain("Agents can&#x27;t use this tab on newhost.example")
    expect(html).toContain('Lent to 2')
  })

  test('a host the allowlist DOES cover gets no nudge', () => {
    const html = renderToStaticMarkup(
      <SecurityPanel
        tone="secure"
        url="https://a.example/x"
        origins={['.example']}
        onClose={() => {}}
      />,
    )
    expect(html).not.toContain('data-security-offlist')
  })
})

/* ── the strip ───────────────────────────────────────────────────────────── */

const strip = (over: Partial<Parameters<typeof TabStrip>[0]> = {}) =>
  renderToStaticMarkup(
    <TabStrip
      tabs={[tab()]}
      activeId="tb_one"
      onSelect={() => {}}
      onClose={() => {}}
      onMenu={() => {}}
      onNew={() => {}}
      {...over}
    />,
  )

describe('the tabs are tabs now', () => {
  test('a tab with no icon gets its hashed letter tile, never a blank square', () => {
    const html = strip()
    expect(html).toContain('data-tab-tile="M"')
    expect(html).not.toContain('data-tab-favicon')
  })

  test('the live feed supplies the ACTIVE tab title, favicon and spinner', () => {
    const html = strip({
      live: {
        tabId: 'tb_one',
        title: 'Inbox (3) — Acme Mail',
        favicon: 'data:image/png;base64,AA',
        loading: false,
      },
    })
    expect(html).toContain('Inbox (3) — Acme Mail')
    expect(html).toContain('data-tab-favicon')
    expect(html).not.toContain('data-tab-tile')
  })

  test('loading swaps the favicon for a spinner in the SAME 16px cell', () => {
    const html = strip({
      live: { tabId: 'tb_one', title: 'Inbox', favicon: 'data:image/png;base64,AA', loading: true },
    })
    expect(html).toContain('data-tab-spinner')
    expect(html).toContain('data-tab-loading')
    expect(html).not.toContain('data-tab-favicon')
  })

  test('the feed only speaks for the tab it is attached to', () => {
    const html = strip({
      tabs: [tab(), tab({ id: 'tb_two', title: 'Bank', url: 'https://bank.example/portal' })],
      live: { tabId: 'tb_one', title: 'Live title', favicon: null, loading: true },
    })
    // One spinner, not two: the other chip renders from its own row.
    expect(html.split('data-tab-spinner').length - 1).toBe(1)
    expect(html).toContain('Bank')
  })

  test('a row with no title falls back to the HOST, not the raw url', () => {
    const html = strip({
      tabs: [tab({ title: '', url: 'https://www.reseller.example/back-office?period=q3' })],
    })
    expect(html).toContain('reseller.example')
    expect(html).not.toContain('back-office?period=q3')
  })

  test('the origin memo dresses a tab the socket is not attached to', () => {
    const html = strip({
      tabs: [tab({ id: 'tb_two', url: 'https://bank.example/portal' })],
      activeId: 'tb_one',
      favicons: { 'https://bank.example': 'data:image/png;base64,BB' },
    })
    expect(html).toContain('data-tab-favicon')
  })

  test('a pinned tab is its favicon and nothing else — 44px, keeps its dot', () => {
    const html = strip({ tabs: [tab({ pinned: true })] })
    expect(html).toContain('data-tab-pinned')
    expect(html).toContain('width:44px')
    // The title is gone, the STATE is not: a pinned chip that hid its sign-in
    // state would be the one place a stale tab looked healthy.
    expect(html).toContain('data-tab-dot="ok"')
  })

  test('the rail is still the only overflow container, and still 44px tall', () => {
    const html = strip()
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('[overscroll-behavior-x:contain]')
    expect(html).toContain('h-11')
  })
})

/* ── the omnibox list ────────────────────────────────────────────────────── */

describe('the suggestion list makes the parser visible', () => {
  const tabs = [
    tab({ id: 'tb_mail', title: 'Inbox — Acme Mail', url: 'https://mail.example/inbox' }),
    tab({ id: 'tb_bank', title: 'Bank', url: 'https://bank.example/portal', origins: ['bank.example'] }),
  ]

  test('an empty query has no list at all', () => {
    expect(omniboxRows('', tabs)).toEqual([])
    expect(omniboxRows('   ', tabs)).toEqual([])
  })

  test('row 0 says SEARCH when the parse searches', () => {
    const rows = omniboxRows('how to bake bread', tabs)
    expect(rows[0].kind).toBe('search')
    expect(rows[0].label).toContain('how to bake bread')
    expect(rows[0].action).toEqual({
      kind: 'navigate',
      url: 'https://www.google.com/search?q=how%20to%20bake%20bread',
    })
  })

  test('row 0 says GO when the parse navigates, and shows where', () => {
    const rows = omniboxRows('mail.example/inbox', tabs)
    expect(rows[0].kind).toBe('navigate')
    expect(rows[0].action).toEqual({
      kind: 'navigate',
      url: 'https://mail.example/inbox',
    })
  })

  test('a refused scheme gets NO row — the in-place refusal says why', () => {
    const rows = omniboxRows('javascript:alert(1)', tabs)
    expect(rows.every((r) => r.kind !== 'navigate' && r.kind !== 'search')).toBe(true)
  })

  test('an open tab SWITCHES — never a ninth copy of a signed-in inbox', () => {
    const rows = omniboxRows('acme', tabs)
    const hit = rows.find((r) => r.kind === 'tab')
    expect(hit?.action).toEqual({ kind: 'switch', tabId: 'tb_mail' })
    expect(hit?.detail).toContain('Switch')
  })

  test('an allowlisted host is offered, a leading-dot RULE never is', () => {
    const rows = omniboxRows('bank', [
      tab({ id: 'tb_x', title: 'X', url: 'https://x.example/', origins: ['bank.example', '.bank.example'] }),
    ])
    const origins = rows.filter((r) => r.kind === 'origin')
    expect(origins.map((r) => r.label)).toEqual(['bank.example'])
  })

  test('two rows never share a destination', () => {
    const rows = omniboxRows('mail.example', tabs)
    const dests = rows.map((r) =>
      r.action.kind === 'navigate' ? r.action.url : `tab:${r.action.tabId}`,
    )
    expect(new Set(dests).size).toBe(dests.length)
  })

  test('the list is capped, so the keyboard never covers the page', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      tab({ id: `tb_${i}`, title: `Mail ${i}`, url: `https://mail${i}.example/` }),
    )
    expect(omniboxRows('mail', many).length).toBeLessThanOrEqual(MAX_OMNIBOX_ROWS)
  })

  test('↑/↓ walk the list and always leave a way back to plain typing', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0)
    expect(moveHighlight(0, 1, 3)).toBe(1)
    expect(moveHighlight(2, 1, 3)).toBe(-1)
    // ↑ from "nothing picked" enters at the END, like every browser.
    expect(moveHighlight(-1, -1, 3)).toBe(2)
    expect(moveHighlight(0, -1, 3)).toBe(-1)
    // An empty list has nothing to highlight.
    expect(moveHighlight(-1, 1, 0)).toBe(-1)
  })
})

/* ── the page's own modal ────────────────────────────────────────────────── */

const surface = (
  dialog: { kind: string; message: string; default_prompt: string },
) => renderToStaticMarkup(<PageDialogSurface dialog={dialog} onAnswer={() => {}} />)

describe('a javascript dialog is answerable, so a page can never freeze', () => {
  test('alert has ONE button — offering Cancel would be a lie', () => {
    const html = surface({ kind: 'alert', message: 'stop right there', default_prompt: '' })
    expect(html).toContain('data-page-dialog="alert"')
    expect(html).toContain('stop right there')
    expect(html).toContain('data-page-dialog-accept')
    expect(html).not.toContain('data-page-dialog-cancel')
  })

  test('confirm offers both, and prompt adds a ≥16px field seeded by the page', () => {
    const confirm = surface({ kind: 'confirm', message: 'Delete?', default_prompt: '' })
    expect(confirm).toContain('data-page-dialog-cancel')
    expect(confirm).toContain('data-page-dialog-accept')

    const prompt = surface({ kind: 'prompt', message: 'Name?', default_prompt: 'Ada' })
    expect(prompt).toContain('data-page-dialog-input')
    expect(prompt).toContain('value="Ada"')
    // The same 16px floor as every other input in this workspace: below it iOS
    // zooms the whole shell the moment the field takes focus.
    expect(prompt).toContain('text-[16px]')
  })

  test('beforeunload says what leaving means rather than quoting nothing', () => {
    const html = surface({ kind: 'beforeunload', message: '', default_prompt: '' })
    expect(html).toContain('Leave the page')
    expect(html).toContain('Stay')
    expect(html).toContain('may not be saved')
  })

  test('the buttons are thumb-sized and the message cannot burst the card', () => {
    const html = surface({ kind: 'confirm', message: 'x'.repeat(400), default_prompt: '' })
    expect(html).toContain('min-h-11')
    expect(html).toContain('break-words')
    expect(html).toContain('max-w-[22rem]')
  })

  test('it is mounted in the viewport and re-enables touch over a touch-none box', () => {
    const html = surface({ kind: 'alert', message: 'hi', default_prompt: '' })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('touch-auto')
  })
})

/* ── two doors, one verb ─────────────────────────────────────────────────── */

describe('the socket is preferred and REST is the fallback', () => {
  const workspace = readFileSync('src/components/browser/workspace.tsx', 'utf8')
  const client = readFileSync('src/lib/api/browser.ts', 'utf8')

  test('every nav verb goes through `drive()`, which prefers a live socket', () => {
    // The shape that matters: socket first (the relay is already holding the
    // page), REST second (the only door that can wake a sleeping tab).
    expect(workspace).toContain('if (live && c) {')
    for (const verb of ['c.back()', 'c.forward()', 'c.stop()', 'c.reload(hard)', 'c.navigate(dest)']) {
      expect(workspace).toContain(verb)
    }
  })

  test('the REST door exists for all four, at the paths the server routes', () => {
    expect(client).toContain('/api/browser/tabs/${enc(id)}/${verb}')
    // The verb union IS the route table; a typo here is a 404 nobody notices
    // until a tab is asleep.
    expect(client).toContain("export type NavControl = 'back' | 'forward' | 'reload' | 'stop'")
  })

  test('`moved:false` is reported as a state, not thrown as a failure', () => {
    const hook = readFileSync('src/hooks/use-browser-tabs.ts', 'utf8')
    expect(hook).toContain('out !== null && out.moved')
  })
})
