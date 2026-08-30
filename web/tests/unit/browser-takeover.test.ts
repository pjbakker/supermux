/**
 * The takeover client — the arithmetic and the socket, without a browser.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two things can silently ruin a takeover and neither shows up in a screenshot:
 *
 *   · a coordinate map that is off by a scale factor or an `offsetTop`, so
 *     every tap lands somewhere the human did not aim — worst of all, plausibly
 *     nearby;
 *   · a socket that sends input before `auth_ok`, keeps a dead one redialling,
 *     or leaves one open after unmount.
 *
 * So: the mapping is pinned against the exact `metadata` CDP sends, and the
 * socket is driven through a fake one.
 */
import { describe, expect, test } from 'bun:test'

import {
  fitFrame,
  frameSrc,
  toPagePoint,
  type FrameMetadata,
} from '../../src/lib/browser/frame-map'
import {
  EMPTY_SNAPSHOT,
  REASON_ALREADY_ATTACHED,
  REASON_NO_CONTEXT,
  TakeoverSocket,
  backoffDelay,
  keyText,
  modifiersFor,
  type SocketLike,
  type TakeoverSnapshot,
} from '../../src/lib/browser/takeover-socket'
import type { TakeoverFrame } from '../../src/lib/browser/frame-map'
import {
  NO_CAPS,
  parseCaps,
  parseLoginScan,
} from '../../src/lib/browser/page-tools'

/* ── the frame arithmetic ────────────────────────────────────────────────── */

/** What the server actually relays for a 1024×768 page capped to 512 wide. */
const META: FrameMetadata = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 1024,
  deviceHeight: 768,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
}
const IMAGE = { width: 512, height: 384 }

describe('frame fitting', () => {
  test('letterboxes rather than stretching', () => {
    // A 4:3 frame in a 16:9 box: bars left and right, aspect preserved.
    const fit = fitFrame({ width: 800, height: 300 }, IMAGE)
    expect(fit.zoom).toBeCloseTo(300 / 384)
    expect(fit.height).toBeCloseTo(300)
    expect(fit.width).toBeCloseTo(400)
    expect(fit.left).toBeCloseTo(200)
    expect(fit.top).toBeCloseTo(0)
  })

  test('a degenerate box paints nothing rather than dividing by zero', () => {
    expect(fitFrame({ width: 0, height: 0 }, IMAGE).zoom).toBe(0)
    expect(fitFrame({ width: 100, height: 100 }, { width: 0, height: 0 }).zoom).toBe(0)
  })
})

describe('canvas point → page point', () => {
  test('the centre of the canvas is the centre of the page', () => {
    // Box exactly the frame's aspect: no letterbox, zoom 1.
    const p = toPagePoint({ x: 256, y: 192 }, { width: 512, height: 384 }, IMAGE, META)
    expect(p).not.toBeNull()
    expect(p!.x).toBeCloseTo(512)
    expect(p!.y).toBeCloseTo(384)
  })

  test('the frame cap is undone — a tap is in PAGE pixels, not image pixels', () => {
    // The whole point: the JPEG is 512 wide, the page is 1024. A click on the
    // right edge of the image is x=1024, not x=512.
    const p = toPagePoint({ x: 512, y: 0 }, { width: 512, height: 384 }, IMAGE, META)
    expect(p!.x).toBeCloseTo(1024)
    expect(p!.y).toBeCloseTo(0)
  })

  test('offsetTop is subtracted — the strip above the page is not the page', () => {
    const withTop: FrameMetadata = { ...META, offsetTop: 24 }
    const p = toPagePoint({ x: 0, y: 192 }, { width: 512, height: 384 }, IMAGE, withTop)
    expect(p!.y).toBeCloseTo(384 - 24)
  })

  test('pageScaleFactor is deliberately NOT applied', () => {
    // CDP takes unscaled viewport CSS px; dividing by the scale would break
    // every pinch-zoomed page. Same point, doubled scale ⇒ same answer.
    const zoomed: FrameMetadata = { ...META, pageScaleFactor: 2 }
    const a = toPagePoint({ x: 100, y: 100 }, { width: 512, height: 384 }, IMAGE, META)
    const b = toPagePoint({ x: 100, y: 100 }, { width: 512, height: 384 }, IMAGE, zoomed)
    expect(b).toEqual(a)
  })

  test('a scaled, letterboxed canvas maps back exactly', () => {
    // The real mobile case: a 360×640 viewport showing a 512×384 frame.
    const box = { width: 360, height: 640 }
    const fit = fitFrame(box, IMAGE) // zoom 360/512, bars top and bottom
    const p = toPagePoint(
      { x: fit.left + fit.width / 2, y: fit.top + fit.height / 2 },
      box,
      IMAGE,
      META,
    )
    expect(p!.x).toBeCloseTo(512)
    expect(p!.y).toBeCloseTo(384)
  })

  test('a tap on the letterbox is dropped, not clamped to the edge', () => {
    const box = { width: 360, height: 640 }
    const fit = fitFrame(box, IMAGE)
    // Well above the painted image — the grey bar.
    expect(toPagePoint({ x: 180, y: fit.top - 20 }, box, IMAGE, META)).toBeNull()
    expect(toPagePoint({ x: -5, y: 300 }, box, IMAGE, META)).toBeNull()
  })

  test('a seed still-frame with no metadata maps 1:1', () => {
    // `Page.captureScreenshot` carries no metadata; the frame IS the page.
    const p = toPagePoint({ x: 10, y: 20 }, { width: 512, height: 384 }, IMAGE, {})
    expect(p!.x).toBeCloseTo(10)
    expect(p!.y).toBeCloseTo(20)
  })

  test('frames are decoded as jpeg data URLs — no video codec anywhere', () => {
    // The iOS Safari contract in one assertion.
    expect(frameSrc('AAA')).toBe('data:image/jpeg;base64,AAA')
  })
})

/* ── keyboard translation ────────────────────────────────────────────────── */

describe('key translation', () => {
  test('printable keys carry text, named keys do not', () => {
    expect(keyText({ key: 'a' })).toBe('a')
    expect(keyText({ key: 'é' })).toBe('é')
    expect(keyText({ key: 'Enter' })).toBe('\r')
    expect(keyText({ key: 'Tab' })).toBe('\t')
    expect(keyText({ key: 'ArrowUp' })).toBeUndefined()
    expect(keyText({ key: 'Backspace' })).toBeUndefined()
  })

  test('a chord inserts nothing — Ctrl+A is select-all, not "a"', () => {
    expect(keyText({ key: 'a', ctrlKey: true })).toBeUndefined()
    expect(keyText({ key: 'a', metaKey: true })).toBeUndefined()
  })

  test('modifiers use CDP bits: alt 1, ctrl 2, meta 4, shift 8', () => {
    expect(modifiersFor({})).toBe(0)
    expect(modifiersFor({ shiftKey: true })).toBe(8)
    expect(modifiersFor({ ctrlKey: true, altKey: true })).toBe(3)
    expect(modifiersFor({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
  })
})

/* ── the socket ──────────────────────────────────────────────────────────── */

class FakeSocket implements SocketLike {
  static open: FakeSocket[] = []
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
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
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    FakeSocket.open = FakeSocket.open.filter((s) => s !== this)
  }
  /** Drive the handshake the way the server does. */
  accept() {
    this.onopen?.({})
    this.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) })
  }
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  die(code: number, reason?: string) {
    FakeSocket.open = FakeSocket.open.filter((s) => s !== this)
    this.onclose?.({ code, reason })
  }
  parsed(): Array<{ type: string; [k: string]: unknown }> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

function harness(session = 'ada') {
  FakeSocket.open = []
  const snaps: TakeoverSnapshot[] = []
  const frames: TakeoverFrame[] = []
  const timers: Array<() => void> = []
  const copied: string[] = []
  const focused: Array<{ selector: string; ok: boolean }> = []
  const filled: Array<{ selector: string; ok: boolean }> = []
  const sock = new TakeoverSocket(
    session,
    (s) => snaps.push(s),
    (f) => frames.push(f),
    {
      factory: (url) => new FakeSocket(url),
      token: () => 'T0KEN',
      baseUrl: () => 'ws://box:8824',
      schedule: (fn) => {
        timers.push(fn)
        return timers.length
      },
      cancel: () => undefined,
      onCopied: (t) => copied.push(t),
      onFocused: (selector, ok) => focused.push({ selector, ok }),
      onFilled: (selector, ok) => filled.push({ selector, ok }),
    },
  )
  return {
    sock,
    snaps,
    frames,
    timers,
    copied,
    focused,
    filled,
    last: () => FakeSocket.open[FakeSocket.open.length - 1],
    latest: () => snaps[snaps.length - 1] ?? EMPTY_SNAPSHOT,
  }
}

describe('the takeover socket', () => {
  test('auth is the first frame and the token is never in the URL', () => {
    const h = harness()
    h.sock.start()
    const ws = h.last()
    expect(ws.url).toBe('ws://box:8824/ws/browser/ada/takeover')
    expect(ws.url).not.toContain('T0KEN')
    ws.onopen?.({})
    expect(h.last().parsed()[0]).toEqual({ type: 'auth', token: 'T0KEN' })
    h.sock.stop()
  })

  test('nothing is sent before auth_ok', () => {
    const h = harness()
    h.sock.start()
    const ws = h.last()
    ws.onopen?.({})
    h.sock.text('too early')
    h.sock.handBack()
    expect(ws.parsed().filter((m) => m.type !== 'auth')).toEqual([])
    // …and everything flows once the server says go.
    ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) })
    h.sock.text('now')
    expect(ws.parsed().at(-1)).toEqual({ type: 'text', text: 'now' })
    h.sock.stop()
  })

  test('mode and target land in the snapshot; frames do NOT', () => {
    const h = harness()
    h.sock.start()
    const ws = h.last()
    ws.accept()
    ws.deliver({ type: 'target', session: 'ada', url: 'https://example.internal/' })
    ws.deliver({ type: 'mode', mode: 'human_driving' })
    ws.deliver({ type: 'frame', data: 'AAAA', metadata: { deviceWidth: 1024 } })

    expect(h.latest().state).toBe('live')
    expect(h.latest().url).toBe('https://example.internal/')
    expect(h.latest().mode).toBe('human_driving')
    // The frame went to the canvas callback, and produced no snapshot churn.
    expect(h.frames).toEqual([{ data: 'AAAA', metadata: { deviceWidth: 1024 } }])
    const beforeFrames = h.snaps.length
    ws.deliver({ type: 'frame', data: 'BBBB', metadata: {} })
    expect(h.snaps.length).toBe(beforeFrames)
    h.sock.stop()
  })

  test('a refusal is surfaced and cleared by the next mode change', () => {
    const h = harness()
    h.sock.start()
    h.last().accept()
    h.last().deliver({ type: 'refused', reason: 'agent is driving' })
    expect(h.latest().refused).toBe('agent is driving')
    h.last().deliver({ type: 'mode', mode: 'human_driving' })
    expect(h.latest().refused).toBeNull()
    h.sock.stop()
  })

  test('4404 "no browser context" is TERMINAL — no redial storm', () => {
    const h = harness()
    h.sock.start()
    h.last().accept()
    h.last().die(4404, REASON_NO_CONTEXT)
    expect(h.latest().state).toBe('no-context')
    expect(h.timers.length).toBe(0)
    expect(FakeSocket.open.length).toBe(0)
  })

  test('1013 "already attached" stops too — the fix is to close the other tab', () => {
    const h = harness()
    h.sock.start()
    h.last().accept()
    h.last().die(1013, REASON_ALREADY_ATTACHED)
    expect(h.latest().state).toBe('busy')
    expect(h.timers.length).toBe(0)
  })

  test('1008 is permanent; an ordinary drop redials with backoff', () => {
    const auth = harness()
    auth.sock.start()
    auth.last().accept()
    auth.last().die(1008, 'auth required')
    expect(auth.latest().state).toBe('offline')
    expect(auth.timers.length).toBe(0)

    const drop = harness()
    drop.sock.start()
    drop.last().accept()
    drop.last().die(1006)
    expect(drop.latest().state).toBe('reconnecting')
    expect(drop.timers.length).toBe(1)
    drop.timers[0]()
    expect(FakeSocket.open.length).toBe(1)
    drop.sock.stop()
  })

  test('backoff grows and stays bounded', () => {
    expect(backoffDelay(1)).toBeLessThanOrEqual(600)
    expect(backoffDelay(3)).toBeGreaterThan(backoffDelay(1))
    for (let i = 1; i < 20; i++) expect(backoffDelay(i)).toBeLessThanOrEqual(12_000)
  })

  test('stop() leaves nothing open and nothing scheduled', () => {
    const h = harness()
    h.sock.start()
    const ws = h.last()
    ws.accept()
    h.sock.stop()
    expect(ws.closed).not.toBeNull()
    expect(ws.onmessage).toBeNull()
    // A late close from the transport must not resurrect it.
    ws.onclose?.({ code: 1006 })
    expect(h.timers.length).toBe(0)
    // …and mount/unmount thrash leaves no sockets behind.
    for (let i = 0; i < 5; i++) {
      const t = harness()
      t.sock.start()
      t.last().accept()
      t.sock.stop()
    }
    expect(FakeSocket.open.length).toBe(0)
  })

  test('input encodes the shapes takeover.rs parses', () => {
    const h = harness()
    h.sock.start()
    h.last().accept()
    const ws = h.last()
    h.sock.mouse('down', { x: 12.5, y: 30 }, { buttons: 1 })
    h.sock.mouse('move', { x: 13, y: 31 }, { buttons: 1 })
    h.sock.wheel({ x: 5, y: 6 }, { dx: 0, dy: -120 })
    h.sock.key('down', { key: 'a', code: 'KeyA', keyCode: 65 })
    h.sock.key('up', { key: 'a', code: 'KeyA', keyCode: 65 })
    h.sock.text('hallo')
    h.sock.touch('start', { x: 1, y: 2 })
    h.sock.touch('end')
    h.sock.handBack()
    h.sock.takeOver()
    h.sock.resync()

    const sent = ws.parsed().filter((m) => m.type !== 'auth')
    expect(sent.map((m) => m.type)).toEqual([
      'mouse', 'mouse', 'wheel', 'key', 'key', 'text', 'touch', 'touch',
      'hand_back', 'take_over', 'resync',
    ])
    expect(sent[0]).toEqual({
      type: 'mouse', kind: 'down', x: 12.5, y: 30,
      button: 'left', buttons: 1, click_count: 1, modifiers: 0,
    })
    // A drag is a move WITH a button held — snake_case, as serde expects.
    expect(sent[1]).toMatchObject({ kind: 'move', button: 'none', buttons: 1, click_count: 0 })
    expect(sent[3]).toMatchObject({ kind: 'down', key: 'a', code: 'KeyA', key_code: 65, text: 'a' })
    // keyUp carries no text — the server would turn it into a keyDown insert.
    expect(sent[4].text).toBeUndefined()
    expect(sent[7]).toMatchObject({ type: 'touch', kind: 'end' })
    h.sock.stop()
  })
})

/* ── smart sign-in (phase 3 socket wiring) ───────────────────────────────────
 *
 * The three verbs gate on `caps.signIn`, the answers land where §3's state
 * machine will read them, and the secret in `fill_field` never touches the
 * snapshot. Wire names are pinned to `takeover.rs` (snake_case: `sign_in`,
 * `multi_step`, `frame_hint`).
 */

/** Turn on the sign-in capability the way the server does. */
function withSignIn(h: ReturnType<typeof harness>) {
  h.sock.start()
  h.last().accept()
  h.last().deliver({ type: 'caps', find: false, copy: false, sign_in: true })
}

describe('smart sign-in — the socket wiring', () => {
  test('scan_login / focus_field / fill_field produce the exact JSON frames', () => {
    const h = harness()
    withSignIn(h)
    const ws = h.last()
    expect(h.sock.scanLogin()).toBe(true)
    expect(h.sock.focusField('#pw')).toBe(true)
    expect(h.sock.fillField('#pw', 's3cret', 'password')).toBe(true)

    const sent = ws.parsed().filter((m) => m.type !== 'auth')
    expect(sent).toEqual([
      { type: 'scan_login' },
      { type: 'focus_field', selector: '#pw' },
      { type: 'fill_field', selector: '#pw', value: 's3cret', role: 'password' },
    ])
    h.sock.stop()
  })

  test('the three verbs are no-ops until a caps frame lights sign-in', () => {
    const h = harness()
    h.sock.start()
    h.last().accept() // authed, but NO caps frame → signIn stays false
    const ws = h.last()
    expect(h.sock.scanLogin()).toBe(false)
    expect(h.sock.focusField('#pw')).toBe(false)
    expect(h.sock.fillField('#pw', 'nope', 'password')).toBe(false)
    // Nothing hit the wire — an un-capable relay would drop it on the floor.
    expect(ws.parsed().filter((m) => m.type !== 'auth')).toEqual([])
    // …and the degrade default is explicit false, never "unknown".
    expect(h.latest().caps.signIn).toBe(false)
    h.sock.stop()
  })

  test('a caps frame sets snap.caps.signIn; absent caps ⇒ signIn:false (degrade)', () => {
    const on = harness()
    withSignIn(on)
    expect(on.latest().caps.signIn).toBe(true)
    on.sock.stop()

    // An older relay that only knows find/copy leaves signIn false without
    // clobbering the other flags.
    const mixed = harness()
    mixed.sock.start()
    mixed.last().accept()
    mixed.last().deliver({ type: 'caps', find: true, copy: true })
    expect(mixed.latest().caps).toEqual({ find: true, copy: true, signIn: false })
    mixed.sock.stop()

    // No caps frame at all → the EMPTY_SNAPSHOT default holds.
    const none = harness()
    none.sock.start()
    none.last().accept()
    expect(none.latest().caps).toEqual(NO_CAPS)
    none.sock.stop()
  })

  test('a login_fields frame populates snap.loginScan (camelCased from the wire)', () => {
    const h = harness()
    withSignIn(h)
    expect(h.latest().loginScan).toBeNull()
    h.last().deliver({
      type: 'login_fields',
      form: true,
      reason: null,
      fields: [
        { selector: '#email', role: 'username', label: 'Email', visible: true, source: 'autocomplete', rect: { x: 1, y: 2, w: 3, h: 4 } },
        { selector: '#pw', role: 'password', label: 'Password', visible: true, source: 'type', rect: { x: 1, y: 9, w: 3, h: 4 } },
      ],
      otp: null,
      multi_step: 'combined', // snake_case ON THE WIRE
      frame_hint: null,
    })
    const scan = h.latest().loginScan
    expect(scan).not.toBeNull()
    expect(scan!.form).toBe(true)
    expect(scan!.multiStep).toBe('combined') // camelCase in the snapshot
    expect(scan!.frameHint).toBeNull()
    expect(scan!.fields.map((f) => [f.selector, f.role])).toEqual([
      ['#email', 'username'],
      ['#pw', 'password'],
    ])
    expect(scan!.fields[0].rect).toEqual({ x: 1, y: 2, w: 3, h: 4 })
    h.sock.stop()
  })

  test('a form:false scan disables the offer with its reason, no fields', () => {
    const h = harness()
    withSignIn(h)
    h.last().deliver({
      type: 'login_fields',
      form: false,
      reason: 'no-password-field',
      fields: [],
      otp: null,
      multi_step: 'combined',
      frame_hint: 'cross-origin-iframe',
    })
    const scan = h.latest().loginScan!
    expect(scan.form).toBe(false)
    expect(scan.reason).toBe('no-password-field')
    expect(scan.frameHint).toBe('cross-origin-iframe')
    expect(scan.fields).toEqual([])
    h.sock.stop()
  })

  test('focused / filled answers reach the callbacks, not the snapshot', () => {
    const h = harness()
    withSignIn(h)
    const before = h.snaps.length
    h.last().deliver({ type: 'focused', selector: '#pw', ok: true })
    h.last().deliver({ type: 'filled', selector: '#pw', ok: false })
    expect(h.focused).toEqual([{ selector: '#pw', ok: true }])
    expect(h.filled).toEqual([{ selector: '#pw', ok: false }])
    // One-shot results must not churn the snapshot channel.
    expect(h.snaps.length).toBe(before)
    h.sock.stop()
  })

  test('a refused scan surfaces the banner — it does NOT spin', () => {
    const h = harness()
    withSignIn(h)
    expect(h.sock.scanLogin()).toBe(true)
    // The server answers an agent-driving scan with `refused`, not login_fields.
    h.last().deliver({ type: 'refused', reason: 'agent is driving' })
    expect(h.latest().refused).toBe('agent is driving')
    expect(h.latest().loginScan).toBeNull() // no phantom offer
    h.sock.stop()
  })

  test('the fill secret is never retained on the snapshot', () => {
    const h = harness()
    withSignIn(h)
    h.sock.fillField('#pw', 'hunter2', 'password')
    h.last().deliver({ type: 'filled', selector: '#pw', ok: true })
    // The secret exists only inside the one frame on the wire.
    for (const snap of h.snaps) {
      expect(JSON.stringify(snap)).not.toContain('hunter2')
    }
    // …and it is not stashed on the instance's live snapshot either.
    expect(JSON.stringify(h.sock.snapshot())).not.toContain('hunter2')
    h.sock.stop()
  })
})

/* ── the pure parsers ────────────────────────────────────────────────────── */

describe('parseCaps', () => {
  test('reads the wire sign_in and degrades a garbled frame to false', () => {
    expect(parseCaps({ find: true, copy: false, sign_in: true })).toEqual({
      find: true,
      copy: false,
      signIn: true,
    })
    // Absent / wrong-typed flags are "cannot", never "probably".
    expect(parseCaps({})).toEqual(NO_CAPS)
    expect(parseCaps({ sign_in: 'yes' })).toEqual(NO_CAPS)
    // Only snake_case counts — a camelCase `signIn` is NOT the server's wire.
    expect(parseCaps({ signIn: true }).signIn).toBe(false)
  })
})

describe('parseLoginScan', () => {
  test('clamps the small vocabularies and camelCases the wire names', () => {
    const scan = parseLoginScan({
      form: true,
      reason: 'no-password-field', // ignored when form=true
      fields: [{ selector: '#u', role: 'username', label: 'User', visible: true, source: 'keyword', rect: { x: 0, y: 0, w: 0, h: 0 } }],
      otp: { selector: '#otp', label: 'Code' },
      multi_step: 'username-only',
      frame_hint: 'cross-origin-iframe',
    })
    expect(scan.form).toBe(true)
    expect(scan.reason).toBeNull()
    expect(scan.multiStep).toBe('username-only')
    expect(scan.frameHint).toBe('cross-origin-iframe')
    expect(scan.otp).toEqual({ selector: '#otp', label: 'Code' })
    expect(scan.fields).toHaveLength(1)
  })

  test('fail-closed: a hostile frame becomes a disabled offer, not a wrong one', () => {
    const scan = parseLoginScan({
      form: false,
      reason: 'not-a-real-reason', // unknown → null
      fields: [{ selector: '#x' }], // dropped: form is false
      otp: { selector: '#o' },
      multi_step: 'bogus', // unknown → 'combined'
      frame_hint: 'evil', // unknown → null
    })
    expect(scan.form).toBe(false)
    expect(scan.reason).toBeNull()
    expect(scan.fields).toEqual([])
    expect(scan.otp).toBeNull()
    expect(scan.multiStep).toBe('combined')
    expect(scan.frameHint).toBeNull()
  })

  test('a field missing a selector is dropped; roles/sources clamp to known', () => {
    const scan = parseLoginScan({
      form: true,
      reason: null,
      fields: [
        { role: 'password' }, // no selector → dropped
        { selector: '#p', role: 'wizard', source: 'magic' }, // clamp both
      ],
      otp: null,
      multi_step: 'combined',
      frame_hint: null,
    })
    expect(scan.fields).toHaveLength(1)
    expect(scan.fields[0]).toMatchObject({ selector: '#p', role: 'username', source: 'keyword' })
  })
})
