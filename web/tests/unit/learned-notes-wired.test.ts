/**
 * "The tier is OFF" and "the bot has written nothing yet" are different facts.
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /api/sessions/{name}/memory/notes` answers **404** while the memory tier
 * is not enabled for a session, and **200 + []** for a real bot that simply
 * hasn't saved a note yet. The client used to flatten both into the same empty
 * response, so the panel printed "This bot hasn't written any notes yet" over a
 * store that does not exist for it — the one sentence that made a fully built
 * feature look permanently dead.
 *
 * The server already draws the distinction; `wired` is the client keeping it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { listNotes, searchNotes } from '../../src/lib/api/memory'

const realFetch = globalThis.fetch

/** Answer the next request with `status`, and `data` when it is a 200. */
function serve(status: number, data?: unknown) {
  globalThis.fetch = (async () =>
    new Response(status === 200 ? JSON.stringify({ ok: true, data }) : JSON.stringify({ ok: false, error: 'not a bot' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
}

/** The api client reads the bearer + base off `window` at CALL time, so the two
 *  globals have to exist. Set the PROPERTIES; never swap the window object out —
 *  bun runs every unit file in one process, and replacing `window` with a bare
 *  literal takes `window.matchMedia` with it and reds the DOM suites downstream. */
const win = globalThis as unknown as {
  window?: { _SUPERMUX_AUTH_TOKEN?: string; _SUPERMUX_BASE_URL?: string }
}
const hadWindow = 'window' in win
const realAuth = win.window?._SUPERMUX_AUTH_TOKEN
const realBase = win.window?._SUPERMUX_BASE_URL

beforeEach(() => {
  if (!win.window) win.window = {}
  win.window._SUPERMUX_AUTH_TOKEN = 'test-token'
  win.window._SUPERMUX_BASE_URL = ''
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (!hadWindow) delete win.window
  else if (win.window) {
    win.window._SUPERMUX_AUTH_TOKEN = realAuth
    win.window._SUPERMUX_BASE_URL = realBase
  }
})

describe('the memory client keeps 404 apart from 200-with-nothing', () => {
  test('a 404 is the tier being OFF — empty AND unwired', async () => {
    serve(404)
    const out = await listNotes('plain-pane')
    expect(out.wired).toBe(false)
    expect(out.notes).toEqual([])
    expect(out.bot_count).toBe(0)
  })

  test('a 200 with an empty list is a real bot that has learned nothing yet', async () => {
    serve(200, { notes: [], bot_count: 0, role_count: 0, role: '' })
    const out = await listNotes('mena')
    expect(out.wired).toBe(true)
    expect(out.notes).toEqual([])
  })

  test('a populated 200 keeps its counts and is wired', async () => {
    serve(200, {
      notes: [
        {
          slug: 'never-edit-migrations',
          description: 'never edit a file under server/migrations',
          tier: 'bot',
          note_type: 'bugfix',
          modified: '2026-08-18T00:00:00Z',
          snippet: 'sqlx checksums them.',
        },
      ],
      bot_count: 1,
      role_count: 0,
      role: '',
    })
    const out = await listNotes('mena')
    expect(out.wired).toBe(true)
    expect(out.bot_count).toBe(1)
    expect(out.notes[0].slug).toBe('never-edit-migrations')
  })

  test('search answers on the same two axes — the panel branches on one flag', async () => {
    serve(404)
    expect((await searchNotes('plain-pane', 'migrations')).wired).toBe(false)
    serve(200, { notes: [], bot_count: 0, role_count: 0, role: 'reviewer' })
    const hit = await searchNotes('mena', 'migrations')
    expect(hit.wired).toBe(true)
    expect(hit.role).toBe('reviewer')
  })

  test('a real failure still throws — an unreachable store is not an empty one', async () => {
    serve(500)
    await expect(listNotes('mena')).rejects.toThrow()
  })
})
