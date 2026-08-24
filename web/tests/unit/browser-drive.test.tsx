/**
 * PHASE 2 — the half of the shared browser a human drives.
 * ─────────────────────────────────────────────────────────────────────────────
 * Four things can silently un-drive the viewport, and not one of them shows up
 * in a screenshot:
 *
 *   · a gesture recogniser that calls a scroll a tap (every drag ends in a
 *     click on whatever was under the thumb) or a tap a scroll (nothing is ever
 *     clickable), or that sends BOTH a touch sequence and a mouse click, which
 *     makes chrome's own synthesised click land twice;
 *   · a `ClientMsg::Viewport` whose field names have drifted from the serde
 *     struct that parses them — the page silently keeps chrome's default box
 *     and the phone keeps reading a desktop render;
 *   · a state matrix that resolves its precedence differently from the way it
 *     reads, so a signed-out asleep tab shows a spinner nobody can act on;
 *   · an input path that forgot the drive lock, which relays a human's
 *     keystrokes into a page an AGENT is holding.
 *
 * So all four are pinned here, at the level each one actually lives at.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ClickCounter,
  DOUBLE_TAP_MS,
  TAP_MS,
  TAP_SLOP_PX,
  TouchGesture,
  type GestureAction,
} from '../../src/lib/browser/gestures'
import { keyboardScrollDelta, trapKeyAction } from '../../src/lib/browser/keyboard-trap'
import { viewportState, type ViewportInputs } from '../../src/lib/browser/viewport-state'
import {
  MAX_VIEWPORT_DPR,
  TakeoverSocket,
  driveDpr,
  viewportPayload,
  type SocketLike,
} from '../../src/lib/browser/takeover-socket'
import { TakeoverPanel } from '../../src/components/browser/takeover-panel'

/* ── the gesture recogniser ──────────────────────────────────────────────── */

const P = (x: number, y: number) => ({ x, y })
const kinds = (as: GestureAction[]) =>
  as.map((a) => (a.kind === 'touch' ? `touch:${a.phase}` : `tap:${a.clickCount}`))

describe('one finger on a relayed page', () => {
  test('a tap is a CLICK and not a touch sequence — chrome would click twice', () => {
    const g = new TouchGesture()
    expect(kinds(g.begin(P(100, 200), 0))).toEqual([])
    // A real thumb wobbles a pixel or two; that is still a tap.
    expect(kinds(g.move(P(102, 201), 40))).toEqual([])
    const out = g.end(P(102, 201), 80)
    expect(kinds(out)).toEqual(['tap:1'])
    expect(out[0]).toEqual({ kind: 'tap', point: P(102, 201), clickCount: 1 })
  })

  test('past the slop it is a SCROLL, and the buffered start is flushed first', () => {
    const g = new TouchGesture()
    g.begin(P(100, 400), 0)
    const first = g.move(P(100, 400 - (TAP_SLOP_PX + 4)), 30)
    // touchMove without touchStart is a protocol error, not a scroll.
    expect(kinds(first)).toEqual(['touch:start', 'touch:move'])
    expect(first[0]).toMatchObject({ point: P(100, 400) })
    expect(kinds(g.move(P(100, 300), 60))).toEqual(['touch:move'])
    expect(g.isScrolling).toBe(true)
    // …and it ends as a touch, never as a click.
    expect(kinds(g.end(P(100, 300), 90))).toEqual(['touch:end'])
  })

  test('a scroll never also clicks, and a tap never also touches', () => {
    const g = new TouchGesture()
    g.begin(P(0, 0), 0)
    const all = [...g.move(P(0, 60), 20), ...g.end(P(0, 60), 40)]
    expect(all.every((a) => a.kind === 'touch')).toBe(true)

    const t = new TouchGesture()
    t.begin(P(5, 5), 0)
    const tapped = t.end(P(5, 5), 30)
    expect(tapped.every((a) => a.kind === 'tap')).toBe(true)
  })

  test('a long press is not a tap — a click on release is a click nobody asked for', () => {
    const g = new TouchGesture()
    g.begin(P(10, 10), 0)
    expect(kinds(g.end(P(10, 10), TAP_MS + 50))).toEqual([])
  })

  test('double tap carries clickCount 2; a slow or distant second tap does not', () => {
    const g = new TouchGesture()
    g.begin(P(50, 50), 0)
    g.end(P(50, 50), 20)
    g.begin(P(52, 51), 100)
    expect(kinds(g.end(P(52, 51), 120))).toEqual(['tap:2'])

    const slow = new TouchGesture()
    slow.begin(P(50, 50), 0)
    slow.end(P(50, 50), 20)
    slow.begin(P(50, 50), DOUBLE_TAP_MS + 100)
    expect(kinds(slow.end(P(50, 50), DOUBLE_TAP_MS + 120))).toEqual(['tap:1'])

    const far = new TouchGesture()
    far.begin(P(50, 50), 0)
    far.end(P(50, 50), 20)
    far.begin(P(300, 400), 60)
    expect(kinds(far.end(P(300, 400), 80))).toEqual(['tap:1'])
  })

  test('a cancel only cancels a gesture the page was TOLD about', () => {
    const tapish = new TouchGesture()
    tapish.begin(P(1, 1), 0)
    expect(kinds(tapish.cancel())).toEqual([])

    const scrolling = new TouchGesture()
    scrolling.begin(P(1, 1), 0)
    scrolling.move(P(1, 90), 20)
    expect(kinds(scrolling.cancel())).toEqual(['touch:cancel'])
    expect(scrolling.isDown).toBe(false)
  })

  test('clickCount is counted HERE, for both input kinds', () => {
    // A PointerEvent's `detail` is 0 in chrome, so the mouse path that looked
    // like it read the browser's count sent 1 forever: no double click ever
    // selected a word or opened a row.
    const c = new ClickCounter()
    expect(c.next(P(10, 10), 0)).toBe(1)
    expect(c.next(P(11, 10), 120)).toBe(2)
    expect(c.next(P(11, 10), 200)).toBe(3)
    // Capped at CDP's own ceiling, and reset by distance or by time.
    expect(c.next(P(11, 10), 260)).toBe(3)
    expect(c.next(P(400, 400), 300)).toBe(1)
    expect(c.next(P(400, 400), 300 + DOUBLE_TAP_MS + 10)).toBe(1)
  })

  test('a stray move or end with no finger down relays nothing', () => {
    const g = new TouchGesture()
    expect(kinds(g.move(P(1, 1), 0))).toEqual([])
    expect(kinds(g.end(P(1, 1), 0))).toEqual([])
  })
})

/* ── the viewer's box ────────────────────────────────────────────────────── */

describe('the Viewport message', () => {
  test('the shape is the one takeover.rs parses', () => {
    const msg = viewportPayload({ width: 390.4, height: 780.6, dpr: 3, mobile: true })
    expect(msg).toEqual({
      type: 'viewport',
      width: 390,
      height: 781,
      // Clamped client-side too: a 3× phone asking for a 3× frame is asking for
      // pixels it cannot show.
      dpr: MAX_VIEWPORT_DPR,
      mobile: true,
    })
  })

  test('the server struct still has these exact fields', () => {
    // The twin assertion of `REASON_NO_CONTEXT`: the day a field is renamed on
    // one side, one of the two suites fails instead of the page silently
    // keeping chrome's default viewport.
    const rust = readFileSync(
      '../server/src/connectors/browser/takeover.rs',
      'utf8',
    )
    const at = rust.indexOf('    Viewport {')
    expect(at).toBeGreaterThan(0)
    const decl = rust.slice(at, at + 400)
    for (const field of ['width: u32', 'height: u32', 'dpr: f64', 'mobile: bool']) {
      expect(decl).toContain(field)
    }
    // …and snake_case tagging, which is what makes `type: 'viewport'` match.
    expect(rust).toContain('#[serde(tag = "type", rename_all = "snake_case")]')
  })

  test('a box that is not laid out yet is NOT sent', () => {
    // A ResizeObserver fires once with a zero box before layout. Sending it
    // would ask chrome to lay a page out at nothing.
    expect(viewportPayload({ width: 0, height: 800, dpr: 2, mobile: false })).toBeNull()
    expect(viewportPayload({ width: 390, height: 0, dpr: 2, mobile: false })).toBeNull()
    expect(
      viewportPayload({ width: 390, height: 700, dpr: Number.NaN, mobile: false }),
    ).toMatchObject({ dpr: 1 })
  })

  test('DRIVING asks for the viewer’s real pixels; WATCHING asks for 1×', () => {
    // The profile choice, expressed in the field the server already parses:
    // `screencast_profile` caps the stream at css × dpr, so 1× is the cheap
    // watch stream and 2× is the sharp drive one.
    expect(driveDpr(true, 3)).toBe(MAX_VIEWPORT_DPR)
    expect(driveDpr(true, 1)).toBe(1)
    expect(driveDpr(false, 3)).toBe(1)
    expect(driveDpr(false, 1)).toBe(1)
    expect(driveDpr(true, Number.NaN)).toBe(1)
  })

  test('the socket sends it once per box, and re-sends it after a reconnect', () => {
    const h = harness()
    h.sock.start()
    const first = h.last()
    first.accept()
    h.sock.viewport({ width: 390, height: 780, dpr: 2, mobile: true })
    h.sock.viewport({ width: 390, height: 780, dpr: 2, mobile: true })
    expect(h.sent(first).filter((m) => m.type === 'viewport')).toHaveLength(1)
    // A different box IS a new message — that is a rotation.
    h.sock.viewport({ width: 780, height: 390, dpr: 2, mobile: true })
    expect(h.sent(first).filter((m) => m.type === 'viewport')).toHaveLength(2)

    // The socket drops; the new one knows nothing about our box, and on a tab
    // route it may have just rehydrated the page at chrome's default size.
    first.die(1006)
    h.timers[0]?.()
    const second = h.last()
    second.accept()
    expect(h.sent(second).filter((m) => m.type === 'viewport')).toEqual([
      { type: 'viewport', width: 780, height: 390, dpr: 2, mobile: true },
    ])
    h.sock.stop()
  })

  test('a box negotiated before auth_ok is held, not dropped', () => {
    const h = harness()
    h.sock.start()
    const ws = h.last()
    ws.onopen?.({})
    h.sock.viewport({ width: 400, height: 800, dpr: 1, mobile: false })
    expect(h.sent(ws).filter((m) => m.type === 'viewport')).toEqual([])
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) })
    expect(h.sent(ws).filter((m) => m.type === 'viewport')).toHaveLength(1)
    h.sock.stop()
  })

  test('restart() is the ONE door back from a terminal state', () => {
    const h = harness()
    h.sock.start()
    h.last().accept()
    h.last().die(4404, 'no browser context')
    expect(h.latest().state).toBe('no-context')
    h.sock.restart()
    expect(h.latest().state).toBe('connecting')
    // …and it dials, rather than waiting for a backoff that was never armed.
    expect(h.last()).toBeDefined()
    h.last().accept()
    expect(h.latest().state).toBe('live')
    h.sock.stop()
  })
})

/* ── the keyboard trap ───────────────────────────────────────────────────── */

describe('typing into somebody else’s page', () => {
  test('printable keys are left to the input event; named keys are relayed', () => {
    // Both would type every character twice — the split IS the contract.
    expect(trapKeyAction({ key: 'a' })).toBe('insert')
    expect(trapKeyAction({ key: 'é' })).toBe('insert')
    expect(trapKeyAction({ key: '€' })).toBe('insert')
    expect(trapKeyAction({ key: 'Enter' })).toBe('relay')
    expect(trapKeyAction({ key: 'Backspace' })).toBe('relay')
    expect(trapKeyAction({ key: 'Tab' })).toBe('relay')
    expect(trapKeyAction({ key: 'ArrowDown' })).toBe('relay')
    expect(trapKeyAction({ key: 'Escape' })).toBe('relay')
  })

  test('a chord is a key event even when it looks printable', () => {
    expect(trapKeyAction({ key: 'a', ctrlKey: true })).toBe('relay')
    expect(trapKeyAction({ key: 'a', altKey: true })).toBe('relay')
  })

  test('the platform keeps ⌘, and Android’s Unidentified is left to the text path', () => {
    expect(trapKeyAction({ key: 'r', metaKey: true })).toBe('ignore')
    expect(trapKeyAction({ key: 'Unidentified' })).toBe('ignore')
    expect(trapKeyAction({ key: 'Shift' })).toBe('ignore')
    expect(trapKeyAction({ key: 'Meta' })).toBe('ignore')
    expect(trapKeyAction({ key: '' })).toBe('ignore')
  })

  test('the tapped field is scrolled out from behind the keyboard — and only then', () => {
    // The page is laid out at 400 CSS px now that the viewport lifted above the
    // keyboard. A field at y=380 is behind it; one at y=100 is not.
    expect(keyboardScrollDelta(100, 400)).toBe(0)
    const dy = keyboardScrollDelta(380, 400)
    expect(dy).toBeGreaterThan(0)
    // It comes to rest inside the band, not at its very bottom edge.
    expect(380 - dy).toBeLessThan(400 * 0.5)
    expect(380 - dy).toBeGreaterThan(0)
    // Nothing to scroll to, nothing sent.
    expect(keyboardScrollDelta(380, 0)).toBe(0)
    expect(keyboardScrollDelta(Number.NaN, 400)).toBe(0)
  })
})

/* ── the state matrix ────────────────────────────────────────────────────── */

const BASE: ViewportInputs = {
  hasTab: true,
  tabLive: true,
  waking: false,
  socket: 'live',
  mode: 'agent_driving',
  needsLogin: false,
  crashed: false,
}
const at = (over: Partial<ViewportInputs>) => viewportState({ ...BASE, ...over })

describe('the viewport state matrix', () => {
  test('every non-live state has a title and — where one exists — one verb', () => {
    const table: Array<[Partial<ViewportInputs>, string, string | null]> = [
      [{ hasTab: false }, 'empty', null],
      [{ crashed: true }, 'crashed', 'reload'],
      [{ socket: 'no-context' }, 'asleep', 'wake'],
      [{ socket: 'no-context', waking: true }, 'waking', null],
      [{ socket: 'busy' }, 'busy', 'retry'],
      [{ socket: 'offline' }, 'offline', 'retry'],
      [{ socket: 'reconnecting' }, 'reconnecting', 'retry'],
      [{ socket: 'connecting' }, 'connecting', null],
      [{ socket: 'connecting', tabLive: false }, 'waking', null],
      [{ socket: null, tabLive: false }, 'asleep', 'wake'],
      [{ needsLogin: true }, 'needs-login', 'drive'],
      [{}, 'live', null],
    ]
    for (const [over, phase, verb] of table) {
      const v = at(over)
      expect(v.phase).toBe(phase as never)
      expect(v.action?.verb ?? null).toBe(verb as never)
      if (phase !== 'live') expect(v.title.length).toBeGreaterThan(0)
    }
  })

  test('a dead renderer outranks everything else that is true at the same time', () => {
    expect(at({ crashed: true, socket: 'no-context', needsLogin: true }).phase).toBe('crashed')
  })

  test('signed-out is a BANNER — the sign-in form is on the page it would cover', () => {
    const v = at({ needsLogin: true })
    expect(v.cover).toBe('banner')
    expect(v.keepFrame).toBe(true)
    expect(v.dim).toBe(false)
    // Already driving: nothing to press, the wheel is already yours.
    expect(at({ needsLogin: true, mode: 'human_driving' }).action).toBeNull()
  })

  test('a dropped socket keeps the last frame, dimmed, and never claims it is now', () => {
    const v = at({ socket: 'reconnecting' })
    expect(v.keepFrame).toBe(true)
    expect(v.dim).toBe(true)
    expect(v.cover).toBe('banner')
    expect(v.title.toLowerCase()).toContain('not live')
  })

  test('4404 is asleep with a button, not a dead end', () => {
    const v = at({ socket: 'no-context' })
    expect(v.cover).toBe('screen')
    expect(v.action).toEqual({ verb: 'wake', label: 'Wake this tab' })
  })

  test('a SESSION with no page is not a tab to wake — no button, no lie', () => {
    // A workspace tab has a row and a profile on disk, so "wake it" is a verb
    // the human owns. A scratch session has no page because the AGENT has not
    // opened one, and nothing on this surface can change that.
    const session = at({ socket: 'no-context', subject: 'session' })
    expect(session.action).toBeNull()
    expect(session.detail).toContain('the agent has to open one')
    expect(at({ socket: 'no-context', subject: 'tab' }).action?.verb).toBe('wake')
  })

  test('live is the only state that covers nothing', () => {
    expect(at({}).cover).toBe('none')
    expect(at({}).action).toBeNull()
  })
})

/* ── the drive lock, on every input path ─────────────────────────────────── */

const PANEL = readFileSync('src/components/browser/takeover-panel.tsx', 'utf8')

/** The body of a `const name = (…) => {…}` handler, up to the next top-level
 *  declaration. Crude on purpose: it is checking a guard is PRESENT, and a
 *  handler that moved out of this shape should fail loudly. */
function handlerBody(name: string): string {
  const start = PANEL.indexOf(`  const ${name} = `)
  expect(start).toBeGreaterThan(0)
  const next = PANEL.indexOf('\n  const ', start + 1)
  return PANEL.slice(start, next === -1 ? PANEL.length : next)
}

describe('watching is not driving', () => {
  test('every input path is behind the drive lock', () => {
    // Watch-first is the whole reason a workspace tab does not block its
    // agents. A relay that forgets the lock types into a page an AGENT holds.
    for (const handler of [
      'onTouchStart',
      'onTouchMove',
      'onTouchEnd',
      'onPointerDown',
      'onPointerMove',
      'onPointerUp',
      // Both key surfaces go through this one, box and trap alike.
      'relayKey',
      'onTrapInput',
      'onCompositionEnd',
      'onPaste',
    ]) {
      expect(handlerBody(handler)).toContain('driving')
    }
  })

  test('a printable key is relayed from the BOX and left to the trap’s input event', () => {
    // The bug this pins: while the rule was shared, a hardware keyboard focused
    // on the box typed letters into a void — a `<div>` never fires `input`, so
    // "leave it to the input event" meant "drop it". And the mirror bug: relay
    // it from the trap TOO and every character is typed twice.
    const body = handlerBody('relayKey')
    expect(body).toContain("if (action === 'insert' && fromTrap) return")
  })

  test('the trap does not let its events bubble into the box', () => {
    // The trap is INSIDE the box, so without this every key, paste and
    // composition is relayed a second time on the way up.
    expect(handlerBody('relayKey')).toContain('if (fromTrap) e.stopPropagation()')
    expect(handlerBody('onTrapInput')).toContain('e.stopPropagation()')
    expect(handlerBody('onCompositionEnd')).toContain('e.stopPropagation()')
    expect(PANEL).toContain('// Same double-relay hazard as the keys above')
  })

  test('a mouse down and its up agree about the click count', () => {
    // A `down` that opened a double click and an `up` that says 1 is a page
    // that never sees the double click at all.
    expect(handlerBody('onPointerDown')).toContain(
      'clickCountRef.current = clicksRef.current!.next(p, e.timeStamp)',
    )
    expect(handlerBody('onPointerUp')).toContain('clickCount: clickCountRef.current')
  })

  test('the box does not steal focus back off the trap', () => {
    // A tap fires compat mouse events, and the browser's default mousedown
    // focuses the nearest focusable ancestor — the box. That un-focused the
    // trap on every tap: the keyboard came up and typed into nothing.
    expect(handlerBody('onMouseDown')).toContain('if (driving) e.preventDefault()')
  })

  test('the wheel listener is non-passive and gated too', () => {
    expect(PANEL).toContain("box.addEventListener('wheel', onWheel, { passive: false })")
    const wheel = PANEL.slice(PANEL.indexOf('const onWheel'), PANEL.indexOf('box.addEventListener'))
    expect(wheel).toContain('if (!driving) return')
  })

  test('touch and mouse never both fire for one finger', () => {
    // Pointer events fire for touch as well; without this the finger would
    // click twice and scroll twice.
    expect(PANEL).toContain("e.pointerType !== 'touch'")
    for (const handler of ['onPointerDown', 'onPointerMove', 'onPointerUp']) {
      expect(handlerBody(handler)).toContain('isMouse(e)')
    }
  })

  test('an asleep tab is not attached on sight — looking must not start chrome', () => {
    // The tab route rehydrates on attach, which is what makes the live panel a
    // sane default for an OPEN tab and exactly why selecting an asleep one must
    // not dial: that would start a real browser, spend a slot against the tab
    // cap and change what the agents see, as a side effect of a glance.
    expect(PANEL).toContain('if (attached) sock.start()')
    expect(PANEL).toContain('socket: attached ? snap.state : null')
    expect(readFileSync('src/components/browser/workspace.tsx', 'utf8')).toContain(
      'attach={active.live || !!forceLive}',
    )
  })

  test('leaving drive puts the keyboard away', () => {
    expect(PANEL).toContain('if (!driving) trapRef.current?.blur()')
  })
})

/* ── it renders ──────────────────────────────────────────────────────────── */

describe('the drivable viewport renders', () => {
  const html = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <TakeoverPanel
        subject={{ kind: 'tab', id: 'tb_mail' }}
        options={{ factory: () => stubSocket() }}
        {...props}
      />,
    )

  test('the keyboard trap is a REAL input, ≥16px, and disabled while watching', () => {
    const out = html()
    expect(out).toContain('data-keyboard-trap')
    // display:none is unfocusable, and a sub-16px field zooms iOS.
    expect(out).not.toContain('display:none')
    expect(out).toContain('font-size:16px')
    expect(out).toContain('disabled=""')
  })

  test('the state screen is mounted with the phase on the box', () => {
    // A fresh panel has not dialled yet: connecting, with the chrome above it
    // still standing.
    expect(html()).toContain('data-viewport-phase="connecting"')
    expect(html({ tabLive: false })).toContain('data-viewport-phase="waking"')
    expect(html({ crashed: true, onReload: () => {} })).toContain(
      'data-viewport-action="reload"',
    )
  })

  test('a state whose verb the host did not wire draws no dead button', () => {
    expect(html({ crashed: true })).not.toContain('data-viewport-action')
  })
})

/* ── the fake socket ─────────────────────────────────────────────────────── */

function stubSocket(): SocketLike {
  return {
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  }
}

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
  die(code: number, reason?: string) {
    FakeSocket.open = FakeSocket.open.filter((s) => s !== this)
    this.onclose?.({ code, reason })
  }
}

function harness() {
  FakeSocket.open = []
  const snaps: Array<{ state: string }> = []
  const timers: Array<() => void> = []
  const sock = new TakeoverSocket(
    { kind: 'tab', id: 'tb_mail' },
    (s) => snaps.push(s),
    () => undefined,
    {
      factory: (url) => new FakeSocket(url),
      token: () => 'T0KEN',
      baseUrl: () => 'ws://box:8824',
      schedule: (fn) => {
        timers.push(fn)
        return timers.length
      },
      cancel: () => undefined,
    },
  )
  return {
    sock,
    timers,
    last: () => FakeSocket.open[FakeSocket.open.length - 1],
    latest: () => snaps[snaps.length - 1] ?? { state: 'connecting' },
    sent: (ws: FakeSocket) =>
      ws.sent.map((s) => JSON.parse(s) as { type: string; [k: string]: unknown }),
  }
}
