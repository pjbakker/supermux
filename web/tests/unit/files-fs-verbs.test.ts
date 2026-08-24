/**
 * The three new fs verbs on the wire, and the bulk fan-out that drives them.
 * ─────────────────────────────────────────────────────────────────────────────
 * `filesApi` is the only place the client decides what a namespace verb LOOKS
 * like, and three of its decisions are not obvious from the call site:
 *
 *   • `overwrite` DEFAULTS TO FALSE and is always sent. Omitting it would let a
 *     server-side default drift into a silent clobber on a drive three bots
 *     share; sending it explicitly makes "refuse" the client's position too.
 *   • `if_modified` is OMITTED when the caller has no `modified` to offer, and
 *     `0` is a real value meaning "this file must not exist yet". Serialising
 *     `if_modified: undefined` as `null`, or defaulting it to 0, would turn
 *     every ordinary save into a 409.
 *   • `move` is `POST /api/fs/rename` — rename and move are ONE verb, and the
 *     UI's two menu items must not become two endpoints.
 *
 * The second half pins the route's `runBulk` shape end to end: N single verbs
 * through `mapWithLimit`, then ONE summary. That composition — not either half
 * alone — is what makes "4 moved · 1 failed: destination exists" true.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { filesApi, FsError } from '@/lib/api/files'
import { mapWithLimit } from '@/lib/concurrency'
import { bulkTarget, summarizeBulk } from '@/lib/files-bulk'

interface Captured {
  url: string
  method: string
  body: unknown
}

const captured: Captured[] = []
let nextResponse: () => Response = () => new Response('{"ok":true}', { status: 200 })

const realFetch = globalThis.fetch
const hadWindow = 'window' in globalThis

beforeEach(() => {
  captured.length = 0
  // `apiUrl`/`apiToken` read `window` at CALL time by design (the token is
  // never embedded in source), so the runtime globals are what a test stubs.
  ;(globalThis as { window?: unknown }).window = {
    _SUPERMUX_BASE_URL: '',
    _SUPERMUX_AUTH_TOKEN: 'tok',
  }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return nextResponse()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

describe('filesApi — the namespace verbs on the wire', () => {
  test('mkdir POSTs the path to /api/fs/mkdir', async () => {
    await filesApi.mkdir('/srv/acme/docs')
    expect(captured[0]).toEqual({
      url: '/api/fs/mkdir',
      method: 'POST',
      body: { path: '/srv/acme/docs' },
    })
  })

  test('move is /api/fs/rename — ONE verb for rename and move', async () => {
    await filesApi.move('/a/x.md', '/b/x.md')
    expect(captured[0]!.url).toBe('/api/fs/rename')
    expect(captured[0]!.method).toBe('POST')
  })

  test('overwrite is EXPLICITLY false unless asked for', async () => {
    await filesApi.move('/a/x.md', '/b/x.md')
    expect(captured[0]!.body).toEqual({
      from: '/a/x.md',
      to: '/b/x.md',
      overwrite: false,
    })
    await filesApi.copy('/a/x.md', '/b/x.md', { overwrite: true })
    expect(captured[1]!.url).toBe('/api/fs/copy')
    expect((captured[1]!.body as { overwrite: boolean }).overwrite).toBe(true)
  })

  test('writeFile OMITS if_modified when the caller has none (legacy write)', async () => {
    await filesApi.writeFile('/a/x.md', 'hi')
    expect(captured[0]!.body).toEqual({ path: '/a/x.md', content: 'hi' })
    expect(Object.keys(captured[0]!.body as object)).not.toContain('if_modified')
  })

  test('writeFile sends if_modified: 0 verbatim — the "must be new" assertion', async () => {
    await filesApi.writeFile('/a/new.md', '', 0)
    expect(captured[0]!.body).toEqual({
      path: '/a/new.md',
      content: '',
      if_modified: 0,
    })
  })

  test('writeFile forwards a real mtime as the lost-update guard', async () => {
    await filesApi.writeFile('/a/x.md', 'hi', 1_700_000_000)
    expect((captured[0]!.body as { if_modified: number }).if_modified).toBe(
      1_700_000_000,
    )
  })

  test('a 409 surfaces as an FsError carrying the STATUS and the server’s words', async () => {
    nextResponse = () =>
      new Response('{"error":"destination exists"}', { status: 409 })
    try {
      await filesApi.mkdir('/srv/acme/docs')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(FsError)
      expect((e as FsError).status).toBe(409)
      expect((e as FsError).message).toBe('destination exists')
    } finally {
      nextResponse = () => new Response('{"ok":true}', { status: 200 })
    }
  })
})

describe('the bulk fan-out, composed the way the route composes it', () => {
  const targets = [
    { path: '/srv/acme/a.md', name: 'a.md' },
    { path: '/srv/acme/b.md', name: 'b.md' },
    { path: '/srv/acme/c.md', name: 'c.md' },
    { path: '/srv/acme/d.md', name: 'd.md' },
    { path: '/srv/acme/e.md', name: 'e.md' },
  ]

  test('every selected item gets its OWN single verb — no batch endpoint', async () => {
    const results = await mapWithLimit(targets, 4, (t) =>
      filesApi.move(t.path, bulkTarget('/srv/acme/archive', t.name)),
    )
    expect(captured).toHaveLength(5)
    expect(captured.every((c) => c.url === '/api/fs/rename')).toBe(true)
    expect((captured[0]!.body as { to: string }).to).toBe(
      '/srv/acme/archive/a.md',
    )
    expect(summarizeBulk('move', results).message).toBe('5 moved')
  })

  test('ONE failure is reported as one failure, with the server’s reason', async () => {
    nextResponse = () => {
      // The third call 409s; everything else succeeds.
      if (captured.length === 3) {
        return new Response('{"error":"destination exists"}', { status: 409 })
      }
      return new Response('{"ok":true}', { status: 200 })
    }
    const results = await mapWithLimit(targets, 4, (t) =>
      filesApi.move(t.path, bulkTarget('/srv/acme/archive', t.name)),
    )
    const summary = summarizeBulk('move', results)
    // Four really did move. Nothing is rolled back, and nothing is rounded up.
    expect(summary.message).toBe('4 moved · 1 failed: destination exists')
    expect(summary.tone).toBe('error')
    nextResponse = () => new Response('{"ok":true}', { status: 200 })
  })

  test('bulkTarget joins without doubling the slash', () => {
    expect(bulkTarget('/srv/acme/', 'a.md')).toBe('/srv/acme/a.md')
    expect(bulkTarget('/srv/acme', 'a.md')).toBe('/srv/acme/a.md')
  })
})
