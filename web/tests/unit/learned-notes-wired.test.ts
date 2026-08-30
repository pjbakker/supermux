/**
 * "This bot cannot write notes" and "it has written none yet" are different facts.
 * ═════════════════════════════════════════════════════════════════════════════
 * `GET /api/sessions/{name}/memory/notes` answers **404** when the session is not
 * a bot at all, and **200** otherwise — carrying `wired`, the server's reading of
 * whether the recall hook is really in this session's launch overlay.
 *
 * The client used to synthesise `wired` from the status code (a 200 meant wired).
 * That was wrong in the commonest case there is: the route's gate is ELIGIBILITY
 * (a company or a role sentence), the hook is wired at LAUNCH, so every bot that
 * became eligible since its last start answers 200 with no hook and no way to
 * save — and got told it simply hadn't written anything yet.
 *
 * So: the flag comes off the wire. A 404 lands in the same UNWIRED empty, but it
 * is not the same state — `eligible` keeps the two apart, because only the 200
 * one can be restarted INTO memory. Restarting a session the route 404'd wires
 * nothing (`session_has_memory` stays false), so that empty state names the step
 * that actually comes first and offers no restart button.
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

describe('the memory client reports whether the bot can write, not whether it answered', () => {
  test('a 404 is "not a bot" — empty, unwired AND not eligible', async () => {
    serve(404)
    const out = await listNotes('plain-pane')
    expect(out.wired).toBe(false)
    // The second bit: a restart cannot wire THIS session, so the panel must ask
    // for a role or a company first instead of offering the restart button.
    expect(out.eligible).toBe(false)
    expect(out.notes).toEqual([])
    expect(out.bot_count).toBe(0)
  })

  test('an ELIGIBLE bot with no hook answers 200 and is still unwired', async () => {
    // The regression this file exists for: the panel must say "restart it", not
    // "it hasn't written anything yet", for a bot whose launch predates its role.
    serve(200, { notes: [], bot_count: 0, role_count: 0, role: '', wired: false })
    const out = await listNotes('mena')
    expect(out.wired).toBe(false)
    // …and this one CAN be restarted into memory, which is what earns the button.
    expect(out.eligible).toBe(true)
    expect(out.notes).toEqual([])
  })

  test('a 200 with an empty list AND the hook is a bot that has learned nothing yet', async () => {
    serve(200, { notes: [], bot_count: 0, role_count: 0, role: '', wired: true })
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
      wired: true,
    })
    const out = await listNotes('mena')
    expect(out.wired).toBe(true)
    expect(out.bot_count).toBe(1)
    expect(out.notes[0].slug).toBe('never-edit-migrations')
  })

  test('search answers on the same two axes — the panel branches on one flag', async () => {
    serve(404)
    const miss = await searchNotes('plain-pane', 'migrations')
    expect(miss.wired).toBe(false)
    expect(miss.eligible).toBe(false)
    serve(200, { notes: [], bot_count: 0, role_count: 0, role: 'reviewer', wired: true })
    const hit = await searchNotes('mena', 'migrations')
    expect(hit.wired).toBe(true)
    expect(hit.eligible).toBe(true)
    expect(hit.role).toBe('reviewer')
  })

  test('a real failure still throws — an unreachable store is not an empty one', async () => {
    serve(500)
    await expect(listNotes('mena')).rejects.toThrow()
  })
})
