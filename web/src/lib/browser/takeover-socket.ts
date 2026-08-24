/**
 * The takeover socket: one shared-browser page, watched and driven.
 * ─────────────────────────────────────────────────────────────────────────────
 * Framework-free for the same reason `chat-socket.ts` is: the handshake, the
 * close-code table, the backoff and above all the TEARDOWN are behaviour that
 * has to be tested, and none of it is visible in a rendered snapshot. React's
 * only job (`takeover-panel.tsx`) is to mount it, paint the frames it hands
 * over, and unmount it.
 *
 * The handshake is the terminal socket's, byte for byte (`ws.rs`): connect
 * token-less, send `{type:'auth',token}` as the FIRST frame, wait for
 * `{"type":"auth_ok"}`. The token never goes in the URL — a `WebSocket` cannot
 * set an `Authorization` header and a query-string token ends up in logs.
 *
 * TWO CHANNELS, ON PURPOSE. Frames arrive at up to 60 fps and go straight to
 * `onFrame` → canvas; they never touch React state. Everything a human reads —
 * the mode pill, the target, the connection — is a `snapshot`, which changes a
 * few times a minute. Routing frames through `setState` would re-render the
 * page sixty times a second to paint a canvas that React does not own.
 *
 * THE CLOSE-CODE TABLE (`connectors/browser/takeover.rs`):
 *   · 1008 — auth/origin/bad name. Permanent; retrying cannot fix it.
 *   · 1013 + "already attached" — someone else holds this page. Retryable, but
 *     not by hammering: we back off like any other 1013.
 *   · 4404 + "no browser context" — the agent has not opened a page. TERMINAL:
 *     there is nothing to attach to, and a redial loop would spin forever.
 *   · anything else — a normal drop; back off and redial.
 */

import { authToken, wsUrl } from '@/env'

import type { FrameMetadata, TakeoverFrame } from './frame-map'
import { EMPTY_NAV, parseNavState, type NavState } from './nav-state'
import {
  NO_CAPS,
  NO_FIND,
  copyPayload,
  findClosePayload,
  findPayload,
  parseCaps,
  parseFindResult,
  type FindResult,
  type PageCaps,
} from './page-tools'

/** The slice of `WebSocket` this module uses — so a test can be a socket. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
}

/** Who holds the wheel — mirrors `lock::DriveMode`'s serde spelling. */
export type DriveMode = 'agent_driving' | 'human_driving'

export type TakeoverState =
  /** Dialling, or dialled but not yet seeded. */
  | 'connecting'
  /** Authed; frames are flowing. */
  | 'live'
  /** The socket dropped; what is on the canvas STAYS there, it is just not a
   *  claim about now. */
  | 'reconnecting'
  /** TERMINAL: this session has no browser context to take over. */
  | 'no-context'
  /** TERMINAL: another takeover socket already holds this session. */
  | 'busy'
  /** TERMINAL: refused, or retries exhausted. */
  | 'offline'

/** The 4404/1013 close reasons, verbatim from `takeover.rs`. Pinned on both
 *  sides — the server has the twin assertion, so the day either string moves,
 *  one of the two suites fails. */
export const REASON_NO_CONTEXT = 'no browser context'
export const REASON_ALREADY_ATTACHED = 'already attached'

const CLOSE_AUTH = 1008
const CLOSE_AGAIN = 1013
const CLOSE_NO_CONTEXT = 4404

/** Everything the UI reads. Changes rarely — frames are NOT in here. */
export interface TakeoverSnapshot {
  state: TakeoverState
  /** `null` until the server has told us; never guessed. */
  mode: DriveMode | null
  /** The page's URL. Seeded by the fire-once `target` frame and then kept
   *  honest by every `nav_state` — see [[TakeoverSnapshot.nav]]. */
  url: string
  /**
   * **The live address bar** — title, favicon, spinner, the honest
   * back/forward affordances, the padlock and the modal blocking the page.
   *
   * Never `null`: an attached socket that has not been told anything yet
   * renders [[EMPTY_NAV]], whose every flag is false, so the chrome greys its
   * controls rather than inventing them. Nav state changes a few times per
   * navigation, which is why it rides the SNAPSHOT channel and not the frame
   * one — the whole point of the two-channel split.
   */
  nav: NavState
  /** The last input the server dropped, and why — cleared on the next accepted
   *  gesture so a stale banner cannot outlive its cause. */
  refused: string | null
  /**
   * **What this relay can do beyond pixels** (phase 4). Find-in-page and
   * copy-out need the page's DOM, which the server does not expose yet — so
   * every flag is FALSE until a `caps` frame says otherwise, and the UI shells
   * for both disable themselves with the reason written on them rather than
   * putting a frame on the wire that would be silently dropped. See
   * `page-tools.ts` for the exact server work each one needs.
   */
  caps: PageCaps
  /** The live find, as the server counts it. [[NO_FIND]] until one answers. */
  find: FindResult
}

export const EMPTY_SNAPSHOT: TakeoverSnapshot = {
  state: 'connecting',
  mode: null,
  url: '',
  nav: EMPTY_NAV,
  refused: null,
  caps: NO_CAPS,
  find: NO_FIND,
}

export interface TakeoverOptions {
  /** Injected for tests; defaults to a real `WebSocket`. */
  factory?: (url: string) => SocketLike
  /** Injected for tests; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Injected for tests; defaults to `env.ts`. */
  token?: () => string
  baseUrl?: () => string
  /** The page's selection, when a capable server answers a `copy`. A callback
   *  rather than a snapshot field: clipboard text is a one-shot event, and
   *  parking it in state would leave a signed-in page's content sitting in a
   *  React tree long after the copy. */
  onCopied?: (text: string) => void
}

/**
 * WHAT this socket is attached to. The relay is one piece of code with two
 * subjects (`takeover.rs::router_for`):
 *
 *   · a SCRATCH session — `/ws/browser/{session}/takeover`, the in-chat
 *     interruption, which grabs the wheel on attach because an ask means the
 *     human is coming to drive;
 *   · a WORKSPACE tab — `/ws/browser/tab/{id}`, watch-first: frames flow, input
 *     is refused until the human presses Drive, so merely LOOKING at a tab does
 *     not silently block every agent granted on it.
 *
 * A bare string stays a session subject, so every existing caller (the in-chat
 * `TakeoverCard`, the takeover bench) is unchanged.
 */
export type TakeoverSubject =
  | { kind: 'session'; name: string }
  | { kind: 'tab'; id: string }

/** A bare string is the legacy session subject. */
export function asSubject(s: string | TakeoverSubject): TakeoverSubject {
  return typeof s === 'string' ? { kind: 'session', name: s } : s
}

/** The route this subject attaches to — the ONLY thing that differs per kind. */
export function subjectPath(s: TakeoverSubject): string {
  return s.kind === 'tab'
    ? `/ws/browser/tab/${encodeURIComponent(s.id)}`
    : `/ws/browser/${encodeURIComponent(s.name)}/takeover`
}

/** The subject's human-readable name (aria labels, `data-` hooks). */
export function subjectName(s: TakeoverSubject): string {
  return s.kind === 'tab' ? s.id : s.name
}

/** Exponential backoff with ±20% jitter, capped — the terminal socket's curve. */
export function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersFor(e: {
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): number {
  return (
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
  )
}

/**
 * The text a key press inserts, or `undefined` for a key that inserts nothing.
 *
 * This is what makes the server pick `keyDown` over `rawKeyDown`, and it is the
 * difference between typing into a page and merely poking it: a bare
 * `rawKeyDown` moves focus and fires handlers but never puts a character in an
 * input. A chorded key (Ctrl/Meta held) inserts nothing — `Ctrl+A` is
 * select-all, not the letter "a".
 */
export function keyText(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
}): string | undefined {
  if (e.ctrlKey || e.metaKey) return undefined
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Tab') return '\t'
  // A single code point — `key` is 'a', 'é', '€', or an emoji; anything longer
  // ('Shift', 'ArrowUp', 'Backspace') is a named key that inserts nothing.
  return [...e.key].length === 1 ? e.key : undefined
}

/**
 * **The viewer's box** — the one fact only the client can know, and the whole
 * of legibility.
 *
 * Without it the server lays the page out at its own default and caps the
 * stream at 512², so a phone reads a 1366px desktop render downscaled to a
 * third and a laptop reads a blur. With it (`ClientMsg::Viewport` →
 * `Emulation.setDeviceMetricsOverride` + a matching screencast cap) the page is
 * laid out at the box the human is actually looking at: a phone gets the site's
 * MOBILE layout at 390pt, and a desktop gets type at 1:1.
 *
 * `mobile` is the coarse-pointer answer, not a width guess — a 390px window on
 * a laptop is a narrow desktop, and telling a site it is a phone there would be
 * a lie with touch-sized buttons attached.
 */
export interface ViewportBox {
  /** The canvas' CSS width/height — the box frames are painted into. */
  width: number
  height: number
  /** `devicePixelRatio`. Clamped: see [[MAX_VIEWPORT_DPR]]. */
  dpr: number
  /** A touch viewport that should get the site's phone layout. */
  mobile: boolean
}

/** The server clamps to this too (`context::MAX_DEVICE_SCALE`); we clamp first
 *  so a 3× phone never ASKS for a frame three times the size of the one it can
 *  show. */
export const MAX_VIEWPORT_DPR = 2

/** The wire shape of `ClientMsg::Viewport`, or `null` for a box that is not
 *  laid out yet.
 *
 *  `null` is the common case on mount — a `ResizeObserver` fires once with a
 *  zero box before layout — and the server would reject it anyway
 *  (`ViewportRequest::sanitized`). Not sending it keeps the profile we have
 *  instead of asking chrome to lay a page out at nothing. */
export function viewportPayload(box: ViewportBox): Record<string, unknown> | null {
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (!(width > 0) || !(height > 0)) return null
  const dpr =
    Number.isFinite(box.dpr) && box.dpr > 0 ? Math.min(box.dpr, MAX_VIEWPORT_DPR) : 1
  return { type: 'viewport', width, height, dpr, mobile: !!box.mobile }
}

/**
 * The device scale to ASK for, which is how a client picks its streaming
 * profile without a second message.
 *
 * Driving is reading: the human is about to click a link they have to be able
 * to read, so ask for their real pixels (capped at 2×, past which a JPEG buys
 * nothing an eye resolves). Watching is watching: 1× is a quarter of the bytes
 * of a retina stream and loses nothing at a glance — the audit's "drop back to
 * a cheap profile on hand-back", expressed in the field the server already
 * parses rather than a new one.
 */
export function driveDpr(driving: boolean, devicePixelRatio: number): number {
  if (!driving) return 1
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.min(devicePixelRatio, MAX_VIEWPORT_DPR)
    : 1
}

export class TakeoverSocket {
  private ws: SocketLike | null = null
  private authed = false
  private stopped = false
  private attempt = 0
  private retry: unknown = null
  private snap: TakeoverSnapshot = { ...EMPTY_SNAPSHOT }
  /** The last box we were ASKED to negotiate, and the last one actually put on
   *  the wire. Two fields, not one: the ask outlives a reconnect (the new
   *  socket has to be told again, or a rehydrated page lays itself out at
   *  chrome's default), while the sent value is what de-duplicates a
   *  `ResizeObserver` that fires four times per rotation. */
  private wantBox: Record<string, unknown> | null = null
  private sentBox: string | null = null

  // Plain fields, not constructor parameter properties: the app's tsconfig
  // sets `erasableSyntaxOnly`, so every construct that emits runtime code from
  // a type-position keyword is out.
  private readonly subject: TakeoverSubject
  private readonly onSnapshot: (s: TakeoverSnapshot) => void
  private readonly onFrame: (f: TakeoverFrame) => void
  private readonly opts: TakeoverOptions

  constructor(
    subject: string | TakeoverSubject,
    onSnapshot: (s: TakeoverSnapshot) => void,
    onFrame: (f: TakeoverFrame) => void,
    opts: TakeoverOptions = {},
  ) {
    this.subject = asSubject(subject)
    this.onSnapshot = onSnapshot
    this.onFrame = onFrame
    this.opts = opts
  }

  snapshot(): TakeoverSnapshot {
    return this.snap
  }

  /** Dial. Idempotent while a socket is open. */
  start(): void {
    if (this.stopped || this.ws) return
    const base = (this.opts.baseUrl ?? wsUrl)()
    const url = `${base}${subjectPath(this.subject)}`
    const make = this.opts.factory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike)
    const ws = make(url)
    this.ws = ws
    this.authed = false

    ws.onopen = () => {
      // FIRST frame, always. Anything sent before `auth_ok` is dropped by the
      // server, so input helpers no-op until `authed`.
      const token = (this.opts.token ?? authToken)()
      ws.send(JSON.stringify({ type: 'auth', token }))
    }
    ws.onmessage = (ev) => this.receive(ev.data)
    ws.onerror = () => {
      /* `onclose` always follows; nothing useful to do here. */
    }
    ws.onclose = (ev) => this.closed(ev.code, ev.reason)
  }

  /** Hang up for good. Safe to call twice, and from a React cleanup. */
  stop(): void {
    this.stopped = true
    if (this.retry !== null) {
      ;(this.opts.cancel ?? clearTimeout)(this.retry as never)
      this.retry = null
    }
    const ws = this.ws
    this.ws = null
    this.authed = false
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close(1000, 'done')
      } catch {
        /* already gone */
      }
    }
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (!this.authed || !this.ws) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      /* the close handler will redial */
    }
  }

  mouse(
    kind: 'move' | 'down' | 'up',
    point: { x: number; y: number },
    extra: { button?: string; buttons?: number; clickCount?: number; modifiers?: number } = {},
  ): void {
    this.send({
      type: 'mouse',
      kind,
      x: point.x,
      y: point.y,
      button: extra.button ?? (kind === 'move' ? 'none' : 'left'),
      buttons: extra.buttons ?? (kind === 'down' ? 1 : 0),
      click_count: extra.clickCount ?? (kind === 'move' ? 0 : 1),
      modifiers: extra.modifiers ?? 0,
    })
  }

  wheel(point: { x: number; y: number }, delta: { dx: number; dy: number }): void {
    this.send({ type: 'wheel', x: point.x, y: point.y, dx: delta.dx, dy: delta.dy })
  }

  key(
    kind: 'down' | 'up',
    e: { key: string; code?: string; keyCode?: number; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  ): void {
    this.send({
      type: 'key',
      kind,
      key: e.key,
      code: e.code ?? '',
      key_code: e.keyCode ?? 0,
      text: kind === 'down' ? keyText(e) : undefined,
      modifiers: modifiersFor(e),
    })
  }

  text(text: string): void {
    if (!text) return
    this.send({ type: 'text', text })
  }

  touch(kind: 'start' | 'move' | 'end' | 'cancel', point?: { x: number; y: number }): void {
    this.send({ type: 'touch', kind, x: point?.x ?? 0, y: point?.y ?? 0 })
  }

  /**
   * Tell the server what box we are painting into. Idempotent: the same box
   * twice is one message, because a rotation fires the observer several times
   * and each one costs a `setDeviceMetricsOverride`, a screencast renegotiation
   * and a full still frame on the server.
   */
  viewport(box: ViewportBox): void {
    const msg = viewportPayload(box)
    if (!msg) return
    this.wantBox = msg
    this.flushViewport()
  }

  private flushViewport(): void {
    const msg = this.wantBox
    if (!msg || !this.authed) return
    const key = JSON.stringify(msg)
    if (key === this.sentBox) return
    this.sentBox = key
    this.send(msg)
  }

  /** Give the wheel back but keep watching. */
  handBack(): void {
    this.send({ type: 'hand_back' })
  }

  /** Grab it again. */
  takeOver(): void {
    this.send({ type: 'take_over' })
  }

  /**
   * Dial again after a TERMINAL state — busy, offline, or a `no-context` we
   * have since fixed by waking the tab.
   *
   * `stop()` is one-way on purpose (a React cleanup must not be undoable), so
   * this is the ONE door back, and it is only ever opened by a human pressing
   * Retry or Wake. Nothing here retries on its own.
   */
  restart(): void {
    if (this.ws) return
    this.stopped = false
    this.attempt = 0
    this.authed = false
    this.sentBox = null
    this.patch({ state: 'connecting', refused: null })
    this.start()
  }

  /** Ask for a fresh still — a static page emits no frames of its own. */
  resync(): void {
    this.send({ type: 'resync' })
  }

  // ── the navigation controls (P1-4) ────────────────────────────────────────
  //
  // These ride the SOCKET rather than the REST door whenever one is attached,
  // and the difference is not micro-optimisation: the REST route re-loads the
  // row, wakes the tab, runs the verb and re-reads the row, and every one of
  // those hops is latency between a thumb and a page. On an attached socket the
  // frame lands in the relay that is already holding the page.
  //
  // The server handles all of them ABOVE the drive gate (`takeover.rs`), on
  // purpose: the wheel governs the INPUT relay, not the address bar. A human
  // watching an agent may still press Back — refusing that while the identical
  // REST route accepts it would be incoherent, not safer.

  /** The address bar's Enter, over the live socket. */
  navigate(url: string): void {
    if (!url) return
    this.send({ type: 'navigate', url })
  }

  /** One step back through the page's own history. */
  back(): void {
    this.send({ type: 'back' })
  }

  /** …and one forward. */
  forward(): void {
    this.send({ type: 'forward' })
  }

  /** Reload. `ignoreCache` is the hard reload (the reload button's long-press). */
  reload(ignoreCache = false): void {
    this.send({ type: 'reload', ignore_cache: !!ignoreCache })
  }

  /** Stop the in-flight load — the button Reload turns into while `loading`. */
  stopLoading(): void {
    this.send({ type: 'stop' })
  }

  /**
   * Answer the modal the page has opened.
   *
   * DISMISS is the default on the server too (`#[serde(default)] accept`), and
   * that direction is the safe one: a garbled or half-built frame must never
   * be read as "yes" to a `confirm()` the human never saw.
   */
  dialog(accept: boolean, promptText?: string): void {
    this.send({
      type: 'dialog',
      accept: !!accept,
      prompt_text: promptText ?? undefined,
    })
  }

  // ── the DOM verbs (phase 4) — gated, because the server cannot do them yet ──
  //
  // FAIL CLOSED, AND LOUDLY IN THE UI RATHER THAN SILENTLY ON THE WIRE. An
  // un-capable relay drops an unknown frame on the floor, so a find bar that
  // sent one anyway would spin against a server that will never answer. The
  // capability comes from a `caps` frame the server does not send yet, which
  // means today these three are always no-ops and every surface that offers
  // them says so. The moment `takeover.rs` grows the arms in `page-tools.ts`'s
  // header, this client needs no edit at all.

  /** Can this relay search the page's DOM and read its selection? */
  caps(): PageCaps {
    return this.snap.caps
  }

  /** Search the page. No-op (and `false`) when the server cannot. */
  find(query: string, opts: { forward?: boolean; caseSensitive?: boolean } = {}): boolean {
    if (!this.snap.caps.find || !query) return false
    this.send(findPayload(query, opts))
    return true
  }

  /** Drop the server's search state — closing the bar must not leak a search
   *  per keystroke into the relay. */
  findClose(): void {
    if (!this.snap.caps.find) return
    this.patch({ find: NO_FIND })
    this.send(findClosePayload())
  }

  /** Ask for the page's current selection as text. */
  copySelection(): boolean {
    if (!this.snap.caps.copy) return false
    this.send(copyPayload())
    return true
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return
    let msg: { type?: string; [k: string]: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'auth_ok':
        this.authed = true
        this.attempt = 0
        // A fresh socket knows nothing about our box, and on a TAB route it may
        // have just rehydrated the page at chrome's default size. Re-negotiate
        // before the first frame lands, so the seed still is already the right
        // shape rather than a full-desktop render the human watches snap.
        this.sentBox = null
        this.flushViewport()
        this.patch({ state: 'live' })
        return
      case 'target':
        // The seed, and only the seed: it carries the canvas size the panel
        // needs on attach. Its url is superseded the moment a nav_state lands.
        this.patch({ url: String(msg.url ?? '') })
        return
      case 'nav_state': {
        const nav = parseNavState(msg)
        // `url` is patched from the SAME frame rather than left to the target
        // seed, so every consumer of `snapshot.url` — the omnibox, the strip,
        // the security chip — follows a page that navigates itself.
        this.patch({ nav, url: nav.url || this.snap.url })
        return
      }
      case 'caps':
        // Sent once after `auth_ok` by a server that has the DOM verbs. Absent
        // = [[NO_CAPS]], which is why the default is false rather than unknown.
        this.patch({ caps: parseCaps(msg) })
        return
      case 'find_result':
        this.patch({ find: parseFindResult(msg) })
        return
      case 'copied': {
        const text = typeof msg.text === 'string' ? msg.text : ''
        this.opts.onCopied?.(text)
        return
      }
      case 'mode':
        this.patch({ mode: msg.mode as DriveMode, refused: null })
        return
      case 'refused':
        this.patch({ refused: String(msg.reason ?? 'refused') })
        return
      case 'frame': {
        const data = typeof msg.data === 'string' ? msg.data : ''
        if (!data) return
        this.onFrame({
          data,
          metadata: (msg.metadata ?? {}) as FrameMetadata,
        })
        return
      }
      default:
        return
    }
  }

  private closed(code: number, reason?: string): void {
    this.ws = null
    this.authed = false
    if (this.stopped) return

    const why = (reason ?? '').trim()
    // Terminal: redialling cannot change any of these facts.
    if (code === CLOSE_NO_CONTEXT || why === REASON_NO_CONTEXT) {
      this.patch({ state: 'no-context' })
      this.stopped = true
      return
    }
    if (code === CLOSE_AUTH) {
      this.patch({ state: 'offline' })
      this.stopped = true
      return
    }
    if (code === CLOSE_AGAIN && why === REASON_ALREADY_ATTACHED) {
      // Retryable in principle (the other viewer will leave) but never by
      // hammering — surface it and let the human retry.
      this.patch({ state: 'busy' })
      this.stopped = true
      return
    }

    this.attempt += 1
    this.patch({ state: 'reconnecting' })
    const delay = backoffDelay(this.attempt)
    this.retry = (this.opts.schedule ?? setTimeout)(() => {
      this.retry = null
      this.start()
    }, delay)
  }

  private patch(next: Partial<TakeoverSnapshot>): void {
    this.snap = { ...this.snap, ...next }
    this.onSnapshot(this.snap)
  }
}
