/**
 * ONE RESIZE PER ATTACH — the doubled, spliced footer hint.
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner's terminal drew an interactive question's key legend like this:
 *
 *   Enter to select · Tab/Arrow keys to navigate · Esc totcancelselect ·
 *   Tab/Arrow keys to navigate · Esc to cancel
 *
 * — the tail duplicated and the join mangled, which is the signature of a
 * cursor-relative repaint applied on top of a screen that was re-seeded
 * underneath it: the rewrite lands at the wrong column and, with no erase, the
 * old tail survives after the new one.
 *
 * WHAT KEPT CAUSING THAT. Every attach sent the SAME cols×rows three times:
 *   1. batched with `auth` in `onopen` — LOAD-BEARING (the server applies it
 *      before the seed capture, so the seed covers our rows);
 *   2. pushed again, unconditionally, on `auth_ok`;
 *   3. pushed a third time by the ResizeObserver's first debounced fit, whose
 *      `lastSent*` counters were effect-locals starting at 0.
 * Each one re-forks `tmux resize-window`; tmux schedules a redraw even at the
 * same size; the TUI re-emits its whole screen; and the server arms a full
 * mid-stream re-seed 300ms after ANY resize — which then lands in the middle of
 * that repaint.
 *
 * The decision now lives in one pure function shared by all three sites, so the
 * rule is testable without xterm, a DOM or a WebSocket. The source-contract test
 * below is what stops site 2 or 3 from quietly going back to sending
 * unconditionally.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { geometryNeedsSend } from '../../src/lib/term-geometry'

describe('a socket tells the server its geometry once', () => {
  test('a fresh socket has told it nothing, so the first real geometry goes', () => {
    expect(geometryNeedsSend(null, 120, 40)).toBe(true)
  })

  test('the same geometry again is not a resize', () => {
    expect(geometryNeedsSend({ cols: 120, rows: 40 }, 120, 40)).toBe(false)
  })

  test('a real change still goes — in either axis', () => {
    expect(geometryNeedsSend({ cols: 120, rows: 40 }, 80, 40)).toBe(true)
    expect(geometryNeedsSend({ cols: 120, rows: 40 }, 120, 24)).toBe(true)
  })

  test('a terminal that has not laid out yet sends nothing', () => {
    // 0×0 is "no geometry", not "geometry zero": sending it would apply a
    // degenerate size to the pty right before the seed capture.
    expect(geometryNeedsSend(null, 0, 0)).toBe(false)
    expect(geometryNeedsSend(null, 120, 0)).toBe(false)
    expect(geometryNeedsSend({ cols: 120, rows: 40 }, 0, 0)).toBe(false)
  })

  test('the attach sequence that used to send three frames now sends one', () => {
    // Replays the real order: onopen → auth_ok → the observer's first fit, all
    // at the same geometry, against one shared record of what was sent.
    let sent: { cols: number; rows: number } | null = null
    let frames = 0
    const offer = (cols: number, rows: number) => {
      if (!geometryNeedsSend(sent, cols, rows)) return
      sent = { cols, rows }
      frames += 1
    }
    offer(120, 40) // onopen, batched with auth
    offer(120, 40) // auth_ok
    offer(120, 40) // ResizeObserver's first debounced fit
    expect(frames).toBe(1)

    // …and a genuine reflow (rotation, split, font change) still gets through.
    offer(80, 40)
    expect(frames).toBe(2)
  })
})

describe('the three send sites all go through the one rule', () => {
  const src = readFileSync(
    new URL('../../src/hooks/use-live-term.ts', import.meta.url),
    'utf8',
  )

  test('nothing sends a resize frame without asking first', () => {
    // Every literal resize frame in the hook — the raw `onopen` one and the
    // `resize()` calls — must sit behind `geometryNeedsSend`. Counting the
    // guards against the sites is what catches a fourth site being added.
    const guards = src.split('geometryNeedsSend(').length - 1
    expect(guards).toBe(3)
  })

  test('`auth_ok` no longer pushes geometry unconditionally', () => {
    expect(src).not.toContain('if (t) resize(t.cols, t.rows)')
  })

  test('the record is a ref, so both effects share one truth', () => {
    // It used to be two locals inside the ResizeObserver effect, which is why
    // the first fit could not know what `onopen` had already sent.
    expect(src).toContain('sentGeomRef')
    expect(src).not.toContain('lastSentCols')
  })

  test('a new socket forgets what the previous one sent', () => {
    // The pty may have been resized by another viewer while this client was
    // away, so the old socket's geometry is not a claim the new one may make.
    expect(src).toContain('sentGeomRef.current = null')
  })
})
