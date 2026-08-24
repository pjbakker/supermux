/**
 * The shared-browser workspace's data layer — the wire, and the honesty.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two classes of bug live here and neither shows up in a screenshot:
 *
 *   · a request that goes to the wrong door. The human's tab CRUD is BEARER-
 *     gated (`/api/browser/*`); the agent's is hook-token'd somewhere else
 *     entirely. A method or a path that drifts is a security-shaped bug, so
 *     every verb is pinned against the routes in
 *     `server/src/connectors/browser/api.rs`.
 *
 *   · a tab that lies about its sign-in. `tabState` is the ONLY place the
 *     workspace resolves `live` × `login_state` into a label, precisely so no
 *     surface can invent a green dot. The cases below are the ones that would
 *     mislead a human into handing an agent a dead tab — a dehydrated tab whose
 *     last known state was `ok`, a live tab nothing has ever probed, and an
 *     expired tab, which must name the browser restart that caused it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  activeGrantees,
  ago,
  createTab,
  deleteTab,
  granteeLabel,
  grantTab,
  isSecure,
  listTabs,
  normalizeUrl,
  patchTab,
  revokeTabGrant,
  sortTabs,
  tabHost,
  tabState,
  type BrowserTab,
} from '../../src/lib/api/browser'
import {
  TakeoverSocket,
  subjectPath,
  type SocketLike,
} from '../../src/lib/browser/takeover-socket'

/** A tab row, as `GET /api/browser/tabs` renders one. */
function tab(over: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: 'tb_one',
    title: 'Inbox',
    url: 'https://mail.example/inbox',
    pinned: false,
    company_id: null,
    origins: ['mail.example'],
    login_state: 'ok',
    last_probe_at: 1_000,
    live: true,
    grants: [],
    created_at: 0,
    last_used_at: 500,
    ...over,
  }
}

/* ── honest state ────────────────────────────────────────────────────────── */

describe('tabState — the tab never claims more than it knows', () => {
  test('needs_login is the FIRST thing said, even on a live tab', () => {
    const s = tabState(tab({ login_state: 'needs_login', live: true }), 1_360)
    expect(s.tone).toBe('needs-login')
    expect(s.label).toBe('Sign-in needed')
    expect(s.detail).toContain('sign in again')
  })

  test('an EXPIRED, DEHYDRATED tab names the browser restart that caused it', () => {
    // §7.1a: session cookies do not survive a Chrome restart, and the reaper
    // restarts Chrome by design — so this is the common path, not a rare one.
    // A generic "error" here sends the human hunting for a fault that is not
    // theirs.
    const s = tabState(tab({ login_state: 'needs_login', live: false }), 1_360)
    expect(s.tone).toBe('needs-login')
    expect(s.detail).toContain('browser restart')
  })

  test('a DEHYDRATED tab whose last state was ok does NOT read as signed in', () => {
    // The tell that matters: `login_state` is stale the moment the page is gone.
    // Rendering "Signed in" here is exactly the false green light §7.3 forbids.
    const s = tabState(tab({ login_state: 'ok', live: false }), 1_360)
    expect(s.tone).toBe('dehydrated')
    expect(s.label).toBe('Asleep')
    expect(s.detail).not.toContain('Signed in')
  })

  test('signed in states its evidence AND its age', () => {
    const s = tabState(tab({ login_state: 'ok', live: true, last_probe_at: 1_000 }), 1_360)
    expect(s.tone).toBe('ok')
    expect(s.detail).toBe('Signed in · verified 6 min ago')
  })

  test('signed in with NO probe says so rather than dating a check that never ran', () => {
    const s = tabState(tab({ login_state: 'ok', last_probe_at: null }), 1_360)
    expect(s.detail).toContain('not verified yet')
  })

  test('unknown is never dressed up as ok', () => {
    const s = tabState(tab({ login_state: 'unknown' }), 1_360)
    expect(s.tone).toBe('unknown')
    expect(s.label).toBe('Not verified')
    expect(s.detail).not.toContain('Signed in')
  })
})

describe('ago', () => {
  test('sub-minute is "just now", not "0 min ago"', () => {
    expect(ago(3)).toBe('just now')
    expect(ago(44)).toBe('just now')
  })
  test('a clock skew reads as just now rather than a future probe', () => {
    expect(ago(-90)).toBe('just now')
  })
  test('minutes, hours, days', () => {
    expect(ago(360)).toBe('6 min ago')
    expect(ago(7_200)).toBe('2 h ago')
    expect(ago(172_800)).toBe('2 d ago')
  })
})

describe('grantees', () => {
  test('a disabled grant row is NOT a grantee — it confers nothing', () => {
    const t = tab({
      grants: [
        { tab_id: 'tb_one', grantee: 'Ada', enabled: 1, granted_at: 0 },
        { tab_id: 'tb_one', grantee: 'Grace', enabled: 0, granted_at: 0 },
      ],
    })
    expect(activeGrantees(t)).toEqual(['Ada'])
  })
  test('the keyspace reads as words', () => {
    expect(granteeLabel('*')).toBe('All agents')
    expect(granteeLabel('@company:4', 'Acme')).toBe('Acme')
    expect(granteeLabel('Ada')).toBe('Ada')
  })
})

describe('rail ordering + url helpers', () => {
  test('pinned first, then most-recently-used', () => {
    const order = sortTabs([
      tab({ id: 'a', pinned: false, last_used_at: 900 }),
      tab({ id: 'b', pinned: true, last_used_at: 100 }),
      tab({ id: 'c', pinned: false, last_used_at: 950 }),
    ]).map((t) => t.id)
    expect(order).toEqual(['b', 'c', 'a'])
  })
  test('sortTabs does not mutate its input', () => {
    const input = [tab({ id: 'a' }), tab({ id: 'b', pinned: true })]
    sortTabs(input)
    expect(input.map((t) => t.id)).toEqual(['a', 'b'])
  })
  test('a padlock is only drawn for https', () => {
    expect(isSecure('https://a.example/x')).toBe(true)
    expect(isSecure('http://a.example/x')).toBe(false)
    expect(isSecure('not a url')).toBe(false)
  })
  test('tabHost falls back to the raw string rather than throwing', () => {
    expect(tabHost('https://mail.example/inbox')).toBe('mail.example')
    expect(tabHost('half-typed')).toBe('half-typed')
  })
  test('normalizeUrl refuses a non-http scheme outright', () => {
    expect(normalizeUrl('mail.example')).toBe('https://mail.example')
    expect(normalizeUrl('https://a.example')).toBe('https://a.example')
    expect(normalizeUrl('javascript:alert(1)')).toBe(null)
    expect(normalizeUrl('  ')).toBe(null)
  })
})

/* ── the wire ────────────────────────────────────────────────────────────── */

describe('the tab CRUD hits the HUMAN door, with the right verbs', () => {
  type G = { window?: unknown; fetch?: unknown }
  const g = globalThis as unknown as G
  const saved: G = {}
  let calls: Array<{ url: string; init?: RequestInit }> = []

  beforeEach(() => {
    saved.window = g.window
    saved.fetch = g.fetch
    g.window = { _SUPERMUX_BASE_URL: '', _SUPERMUX_AUTH_TOKEN: 'test-token' }
    calls = []
  })
  afterEach(() => {
    if (saved.window === undefined) delete g.window
    else g.window = saved.window
    if (saved.fetch === undefined) delete g.fetch
    else g.fetch = saved.fetch
  })

  const stub = (body: unknown) => {
    calls = []
    g.fetch = mock(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => body }
    })
  }

  test('list unwraps `{tabs}` and survives an empty body', async () => {
    stub({ tabs: [tab()] })
    expect((await listTabs()).map((t) => t.id)).toEqual(['tb_one'])
    expect(calls[0].url).toBe('/api/browser/tabs')
    stub({})
    expect(await listTabs()).toEqual([])
  })

  test('create POSTs the url + an explicit company (null = HQ)', async () => {
    stub(tab())
    await createTab('https://mail.example')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      url: 'https://mail.example',
      company_id: null,
    })
  })

  test('the bearer rides every call', async () => {
    stub({ tabs: [] })
    await listTabs()
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-token')
  })

  test('pin is a PATCH of exactly one field', async () => {
    stub(tab({ pinned: true }))
    await patchTab('tb_one', { pinned: true })
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one')
    expect(calls[0].init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ pinned: true })
  })

  test('grant POSTs to /grant; revoke DELETEs the ENCODED grantee', async () => {
    stub({ grants: [] })
    await grantTab('tb_one', '@company:4')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/grant')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      grantee: '@company:4',
      enabled: true,
    })

    stub({ grants: [] })
    // A grantee is a PATH SEGMENT on revoke, and the keyspace contains `@` and
    // `:` — unencoded, `@company:4` is a different route (and a 404 the human
    // would read as "already revoked").
    await revokeTabGrant('tb_one', '@company:4')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/grant/%40company%3A4')
    expect(calls[0].init?.method).toBe('DELETE')

    stub({ grants: [] })
    await revokeTabGrant('tb_one', '*')
    expect(calls[0].url).toBe('/api/browser/tabs/tb_one/grant/*')
  })

  test('delete is honest that it clears no cookies', async () => {
    stub({ deleted: true, cookies_cleared: false, note: 'the tab is gone' })
    const r = await deleteTab('tb_one')
    expect(calls[0].init?.method).toBe('DELETE')
    expect(r.cookies_cleared).toBe(false)
  })
})

/* ── the socket's subject ────────────────────────────────────────────────── */

describe('a tab attaches to the TAB route, a session to the session route', () => {
  test('subjectPath', () => {
    expect(subjectPath({ kind: 'tab', id: 'tb_9f' })).toBe('/ws/browser/tab/tb_9f')
    expect(subjectPath({ kind: 'session', name: 'ada bot' })).toBe(
      '/ws/browser/ada%20bot/takeover',
    )
  })

  test('the socket dials the tab route for a tab subject', () => {
    let dialled = ''
    const sock: SocketLike = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    }
    new TakeoverSocket(
      { kind: 'tab', id: 'tb_9f' },
      () => {},
      () => {},
      {
        baseUrl: () => 'ws://bench',
        token: () => 'x',
        factory: (u) => {
          dialled = u
          return sock
        },
      },
    ).start()
    expect(dialled).toBe('ws://bench/ws/browser/tab/tb_9f')
  })

  test('a bare string is STILL the session route (the in-chat card is unchanged)', () => {
    let dialled = ''
    const sock: SocketLike = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    }
    new TakeoverSocket(
      'ada',
      () => {},
      () => {},
      {
        baseUrl: () => 'ws://bench',
        token: () => 'x',
        factory: (u) => {
          dialled = u
          return sock
        },
      },
    ).start()
    expect(dialled).toBe('ws://bench/ws/browser/ada/takeover')
  })
})
