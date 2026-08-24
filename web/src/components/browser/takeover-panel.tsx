/**
 * The takeover panel — the agent's page, on your screen, under your thumb.
 * ─────────────────────────────────────────────────────────────────────────────
 * A `<canvas>` fed base64 JPEGs off the takeover socket, plus a header that
 * answers the only two questions a human has while looking at it: *what am I
 * looking at* and *who is driving*. Pointer, wheel, keyboard and paste are
 * relayed back, coordinate-mapped through `frame-map.ts`.
 *
 * WHY JPEG→CANVAS AND NOT A VIDEO ELEMENT. iOS Safari is the target: MSE is
 * absent on iPhone, WebCodecs is recent-and-partial, and a `<video>` needs a
 * container format nobody is producing here. A JPEG decoded into a canvas is
 * the one path that works on every engine we ship to, and CDP hands us exactly
 * that. `createImageBitmap` does the decode off the main thread where it
 * exists, with an `<img>` fallback (see `decodeFrame`).
 *
 * DROP-OLD-FRAMES, CLIENT SIDE TOO. Decoding is async; a frame that finishes
 * decoding after a newer one arrived is thrown away rather than painted out of
 * order. Only one decode is ever in flight, which is also what keeps a slow
 * phone from queueing sixty stale frames — and, because the server acks only
 * what it has handed to us, that backpressure reaches all the way to chrome's
 * encoder.
 *
 * MOTION. There is no decorative animation here at all: the only thing that
 * moves is the page itself, which is content. The live dot's pulse is the one
 * exception and it is `motion-reduce:animate-none`.
 *
 * ── PHASE 2: A PAGE A HUMAN CAN ACTUALLY DRIVE ───────────────────────────────
 *
 * Everything above shipped a canvas you could WATCH on a phone and drive only
 * with a mouse. Three things were missing, and all three were client-side —
 * every server primitive has existed since phase 0:
 *
 *   1. **Touch.** `Input.dispatchTouchEvent` has been wired in `takeover.rs`
 *      the whole time; the client only ever sent mouse events, so a thumb could
 *      not scroll. `TouchGesture` (`lib/browser/gestures.ts`) decides tap vs
 *      scroll and this panel relays the result: scroll as real touch events (so
 *      the page's own handlers and chrome's fling both work), tap as a real
 *      click. Never both — see that file's note on the double-click that would
 *      otherwise land on every tap.
 *   2. **A keyboard.** A canvas cannot raise a soft keyboard; only a focused
 *      editable can. So there is a hidden `<input>` — the KEYBOARD TRAP — that
 *      a tap focuses while driving, and whose keystrokes are relayed as text
 *      (IME- and emoji-safe) or as key events (`lib/browser/keyboard-trap.ts`).
 *      The viewport lifts above the keyboard rather than letting iOS scroll the
 *      page out from under the thumb, and the tapped point is scrolled back
 *      into the band that is left.
 *   3. **A box the page is laid out at.** `ClientMsg::Viewport` tells the
 *      server the canvas' real CSS size and pixel ratio; it answers with
 *      `Emulation.setDeviceMetricsOverride` and a stream capped to the same
 *      pixels. That is the difference between a phone reading a 1366px desktop
 *      render at a third scale and a phone reading the site's MOBILE layout.
 *
 * Plus the state matrix (`lib/browser/viewport-state.ts`): every non-live state
 * is a screen with an action, not a pill floating over black.
 */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions,
                  jsx-a11y/no-noninteractive-tabindex --
   The takeover surface is a `role="application"` widget: it takes the keyboard
   and the pointer wholesale and relays them to ANOTHER document. That is
   precisely what the role is for, and precisely what jsx-a11y's
   "non-interactive element" heuristic cannot model — here the interaction IS
   the element's purpose. The surface is keyboard reachable (`tabIndex={0}`) and
   labelled (`aria-label`), so the accessibility outcome the rules protect is
   met; wrapping the canvas in a <button> to satisfy them would break the
   coordinate mapping every gesture depends on. Scoped to this file, which
   contains exactly one such element. */
import * as React from 'react'

import { Keyboard, Loader2, Power, RotateCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  decodeFrame,
  fitFrame,
  frameSize,
  toPagePoint,
  type DecodedFrame,
  type TakeoverFrame,
} from '@/lib/browser/frame-map'
import {
  EMPTY_SNAPSHOT,
  TakeoverSocket,
  driveDpr,
  modifiersFor,
  subjectName,
  type TakeoverOptions,
  type TakeoverSnapshot,
  type TakeoverSubject,
} from '@/lib/browser/takeover-socket'
import { ClickCounter, TouchGesture, type GestureAction } from '@/lib/browser/gestures'
import { keyboardScrollDelta, trapKeyAction } from '@/lib/browser/keyboard-trap'
import { viewportState, type ViewportVerb, type ViewportView } from '@/lib/browser/viewport-state'
import { useKeyboardViewport } from '@/hooks/use-keyboard-viewport'

/** Cap the backing store at 2× — a 3× phone would triple the fill cost of
 *  every frame for a JPEG that is 512px wide to begin with. */
const MAX_DPR = 2

/**
 * Paint an already-decoded frame into the canvas at the box's CURRENT size.
 *
 * Split out of the decode loop because a RESIZE has to repaint too, and it has
 * no frame of its own to wait for: a static page emits no screencast frames
 * (spike gotcha #1), so a canvas whose backing store was sized for the old box
 * would sit there CSS-stretched — blurry, and letterboxed for the wrong aspect
 * — for as long as the page holds still. Which, on a signed-in inbox, is
 * "until something moves".
 */
function blit(canvas: HTMLCanvasElement, box: HTMLElement, image: DecodedFrame): void {
  const cssW = box.clientWidth
  const cssH = box.clientHeight
  if (!(cssW > 0) || !(cssH > 0)) return
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  const w = Math.round(cssW * dpr)
  const h = Math.round(cssH * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const fit = fitFrame({ width: cssW, height: cssH }, frameSize(image))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.drawImage(image as CanvasImageSource, fit.left, fit.top, fit.width, fit.height)
}

/** Wipe the canvas. Used when the SUBJECT changes: the canvas element survives
 *  a subject swap (React reuses the node), so without this the PREVIOUS tab's
 *  page stays on screen while the new tab's socket dials and its seed still is
 *  captured — one tab's pixels under another tab's address bar, which is the
 *  one thing a workspace must never show. */
function wipe(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
}

/** Free a decoded frame we are done with.
 *
 *  `createImageBitmap` allocates OUTSIDE the JS heap and is reclaimed only when
 *  the GC eventually gets to it, so at 30–60 frames a second an un-closed
 *  bitmap per frame is real drift on a long watch. An `<img>` fallback has
 *  nothing to release. */
function release(frame: DecodedFrame | null | undefined): void {
  if (frame && 'close' in frame && typeof frame.close === 'function') frame.close()
}

/** The three wheel verbs, published into a host-owned ref while the socket is
 *  alive (and nulled on teardown, so a stale handle cannot poke a dead socket).
 *  A ref rather than a callback argument on purpose: the host calls these from
 *  its own event handlers, so nothing reads a ref during render. */
export interface TakeoverControls {
  takeOver: () => void
  handBack: () => void
  resync: () => void
  /** Dial again after a terminal state (busy / offline / no-context). The tab
   *  route rehydrates on attach, so on an asleep tab this IS the wake. */
  retry: () => void
}

/** What a host-drawn header renders from. Plain values only. */
export interface TakeoverHeaderState {
  snapshot: TakeoverSnapshot
  /** `snapshot.mode === 'human_driving'`, spelled out because it is the ONE
   *  thing a host must not get wrong. */
  driving: boolean
}

export interface TakeoverPanelProps {
  /** The supermux session whose SCRATCH browser context this is (the in-chat
   *  path). Ignored when `subject` is given. */
  session?: string
  /** The WORKSPACE subject — a persistent tab, or a session spelled out. The
   *  route is the only difference: a tab attaches watch-first (`/ws/browser/
   *  tab/{id}`), a session grabs the wheel on attach. */
  subject?: TakeoverSubject
  /** Injected for tests/benches; production passes nothing. */
  options?: TakeoverOptions
  /** The panel is hosted inside a surface that ALREADY states who is driving and
   *  already offers the single hand-back (the in-chat takeover overlay). Then
   *  this header must not draw its own mode badge and its own mode-flipping
   *  button beside the host's — one state, one control (jury TAKEOVER_PANEL #2).
   *  Standalone (the /dev bench, a future full-page route) keeps both. */
  embedded?: boolean
  /** Draw the host's OWN header (address bar, Watch/Drive) in place of the
   *  built-in one, driving this same socket. The workspace route uses it; the
   *  in-chat card and the bench pass nothing and keep today's header. */
  renderHeader?: (state: TakeoverHeaderState) => React.ReactNode
  /** Where to publish [[TakeoverControls]] for a host-drawn header. */
  controlsRef?: { current: TakeoverControls | null }
  /** The tab ROW says a live page exists. Distinct from the socket's state:
   *  the row is what the workspace polls, the socket is what is attached right
   *  now, and the gap between them is exactly "waking". */
  tabLive?: boolean
  /**
   * DIAL, or stand ready without dialling. Defaults to `true` (every existing
   * caller keeps today's behaviour).
   *
   * The tab route REHYDRATES on attach, which is exactly what makes the live
   * panel a sane default for an open tab — and exactly why merely selecting an
   * ASLEEP one must not attach: that would start a real chrome, spend a slot
   * against the tab cap and change what the agents see, all as a side effect of
   * a human glancing at a row. So the workspace passes the row's own `live`
   * here, the asleep state screen is drawn without a socket, and pressing
   * **Wake** is what dials (which is also what wakes it).
   */
  attach?: boolean
  /** A wake / navigate is in flight on the host's side. */
  waking?: boolean
  /** The tab's last login probe said signed out — drawn as a banner OVER the
   *  page, never instead of it (the sign-in form is on that page). */
  needsLogin?: boolean
  /** The renderer died. Nothing sets this in production yet — the
   *  `Inspector.targetCrashed` relay is phase 3 — so today only the bench does. */
  crashed?: boolean
  /** Wake the tab row (`POST …/open`). The socket restarts either way. */
  onWake?: () => void
  /** Re-navigate to the current url — the crashed state's one verb. */
  onReload?: () => void
  /** BENCH ONLY. The offline screenshot rig has no soft keyboard, so the lift
   *  and the Done bar can only be captured by pretending one is up. Pixels of
   *  pretend keyboard; production never passes it. */
  benchKeyboard?: number
  className?: string
}

export function TakeoverPanel({
  session,
  subject,
  options,
  embedded,
  renderHeader,
  controlsRef,
  tabLive,
  attach,
  waking,
  needsLogin,
  crashed,
  onWake,
  onReload,
  benchKeyboard,
  className,
}: TakeoverPanelProps) {
  // Primitives, not the object: a caller passing `subject={{kind:'tab',id}}`
  // inline would otherwise hand the effect a new identity on every render and
  // redial the socket sixty times a minute.
  const kind = subject?.kind ?? 'session'
  const name = subject ? subjectName(subject) : session ?? ''

  const [snap, setSnap] = React.useState<TakeoverSnapshot>(EMPTY_SNAPSHOT)
  /** The human pressed Wake on a tab the host still thinks is asleep. Latched
   *  so the dial does not un-happen on the next poll that has not caught up. */
  const [dialled, setDialled] = React.useState(false)
  const attached = (attach ?? true) || dialled
  /** The ONE thing a host must not get wrong: the human holds the wheel. Every
   *  input path below is gated on it. */
  const driving = snap.mode === 'human_driving'
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const socketRef = React.useRef<TakeoverSocket | null>(null)

  /** The frame currently ON the canvas — the mapping basis for every gesture.
   *  A ref, not state: sixty re-renders a second to paint a canvas React does
   *  not own would be pure waste. */
  const paintedRef = React.useRef<{ image: DecodedFrame; frame: TakeoverFrame } | null>(null)

  React.useEffect(() => {
    // The decode loop lives INSIDE the effect, so its two pieces of mutable
    // state (the newest undecoded frame, and whether a decode is in flight) are
    // plain closure variables that are born and die with the socket rather than
    // refs that outlive it.
    let alive = true
    let pending: TakeoverFrame | null = null
    let decoding = false
    // Captured for the cleanup: the canvas node outlives a subject swap (React
    // reuses it), and reading the ref in a cleanup is exactly what the
    // exhaustive-deps rule warns about.
    const mounted = canvasRef.current

    const paint = async (): Promise<void> => {
      if (decoding) return
      const next = pending
      pending = null
      if (!next) return
      decoding = true
      try {
        const image = await decodeFrame(next.data)
        const canvas = canvasRef.current
        const box = boxRef.current
        if (alive && canvas && box) {
          blit(canvas, box, image)
          // The one we just replaced is now unreachable — close it here rather
          // than leaving a bitmap per frame to the GC.
          release(paintedRef.current?.image)
          paintedRef.current = { image, frame: next }
        } else {
          // Decoded into a panel that went away mid-decode.
          release(image)
        }
      } catch {
        /* a frame that will not decode is a frame we skip */
      } finally {
        decoding = false
        // A newer frame landed while we were decoding: paint that one and drop
        // the ones in between — drop-old-frames, client side.
        if (alive && pending) void paint()
      }
    }

    const sock = new TakeoverSocket(
      kind === 'tab' ? { kind: 'tab', id: name } : { kind: 'session', name },
      setSnap,
      (frame) => {
        pending = frame
        void paint()
      },
      options,
    )
    socketRef.current = sock
    // Publish the wheel verbs over the LOCAL socket, not the ref — they are
    // born and die with this socket, exactly like the decode loop above.
    if (controlsRef) {
      controlsRef.current = {
        takeOver: () => sock.takeOver(),
        handBack: () => sock.handBack(),
        resync: () => sock.resync(),
        retry: () => sock.restart(),
      }
    }
    if (attached) sock.start()
    return () => {
      alive = false
      pending = null
      sock.stop()
      if (controlsRef) controlsRef.current = null
      socketRef.current = null
      // The subject changed (or the panel unmounted): the pixels on the canvas
      // are the OLD subject's and must not outlive it — see `wipe`.
      if (mounted) wipe(mounted)
      release(paintedRef.current?.image)
      paintedRef.current = null
    }
  }, [kind, name, options, controlsRef, attached])

  // ── the viewer's box ───────────────────────────────────────────────────────
  // Sent on attach, on every resize, and whenever the wheel changes hands (the
  // drive profile asks for the human's real pixels; watching asks for 1×). The
  // socket de-duplicates identical boxes and re-sends the last one after a
  // reconnect, so this only has to be called generously.
  const negotiateAt = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const negotiate = React.useCallback(() => {
    if (negotiateAt.current) clearTimeout(negotiateAt.current)
    negotiateAt.current = setTimeout(() => {
      negotiateAt.current = null
      const box = boxRef.current
      const sock = socketRef.current
      if (!box || !sock) return
      sock.viewport({
        width: box.clientWidth,
        height: box.clientHeight,
        dpr: driveDpr(driving, window.devicePixelRatio || 1),
        // A COARSE POINTER, not a narrow window: a 390px browser window on a
        // laptop is a narrow desktop, and telling a site it is a phone there
        // would hand a mouse touch-sized buttons.
        mobile: !!window.matchMedia?.('(pointer: coarse)').matches,
      })
    }, 120)
  }, [driving])
  React.useEffect(
    () => () => {
      if (negotiateAt.current) clearTimeout(negotiateAt.current)
    },
    [],
  )
  // Taking the wheel re-negotiates: same box, sharper pixels.
  React.useEffect(() => {
    negotiate()
  }, [negotiate])

  // Repaint from the frame we ALREADY hold when the box resizes — a rotation, a
  // split-pane drag, an iOS URL-bar collapse. `blit` sizes the backing store, so
  // without this the canvas keeps the previous box's dimensions and the browser
  // stretches it; on a static page no further frame ever arrives to fix it.
  React.useEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (!box || !canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const painted = paintedRef.current
      if (painted) blit(canvas, box, painted.image)
      // The box moved, so the box we told the SERVER about is stale — the page
      // is now being laid out for a viewport that no longer exists. Debounced,
      // because each negotiation costs chrome a metrics override, a screencast
      // restart and a full still, and a rotation fires this observer four times.
      negotiate()
    })
    ro.observe(box)
    return () => ro.disconnect()
    // Re-installed when the wheel changes hands, because `negotiate` closes
    // over `driving` (the drive profile asks for sharper pixels). That happens
    // twice a session and never mid-gesture, so it costs nothing.
  }, [negotiate])

  /** A pointer/wheel event's position in PAGE coordinates, or `null` when it
   *  landed on the letterbox (or before the first frame). */
  const pagePoint = React.useCallback((clientX: number, clientY: number) => {
    const box = boxRef.current
    const painted = paintedRef.current
    if (!box || !painted) return null
    const rect = box.getBoundingClientRect()
    return toPagePoint(
      { x: clientX - rect.left, y: clientY - rect.top },
      { width: rect.width, height: rect.height },
      frameSize(painted.image),
      painted.frame.metadata,
    )
  }, [])


  // ── the soft keyboard ──────────────────────────────────────────────────────
  // The app's own keyboard observer, reused rather than re-derived: it already
  // knows the iOS-overlay / Android-resizes-content split that every naive
  // `innerHeight` check gets wrong.
  const kb = useKeyboardViewport()
  const trapRef = React.useRef<HTMLInputElement | null>(null)
  const composingRef = React.useRef(false)
  /** Where the last tap landed, in PAGE px — what the keyboard has to be kept
   *  off. Cleared once used so an old tap cannot scroll a later page. */
  const lastTapRef = React.useRef<{ x: number; y: number } | null>(null)
  // While driving on a phone the keyboard OVERLAYS the layout viewport (iOS) —
  // so the canvas is lifted above it and, because the box shrank, the page is
  // re-laid-out at what is left. The human keeps seeing the whole page, smaller,
  // instead of a page scrolled out from under their thumb.
  const kbInset = benchKeyboard ?? (kb.keyboardOpen ? kb.keyboardInset : 0)
  const keyboardUp = driving && kbInset > 0
  const lift = keyboardUp ? kbInset : 0

  const focusTrap = React.useCallback(() => {
    // `preventScroll`: the trap is a 1px box inside the viewport, and letting
    // the platform scroll it into view would move the supermux page under a
    // human who is looking at somebody else's.
    trapRef.current?.focus({ preventScroll: true })
  }, [])

  // Leaving drive puts the keyboard away. A trap that keeps focus after the
  // wheel went back to the agent is a keyboard over a page that is ignoring it.
  React.useEffect(() => {
    if (!driving) trapRef.current?.blur()
  }, [driving])

  // The keyboard just came up over the point the human tapped: scroll the page
  // so the field they are typing into is in the band that is left. Delayed past
  // the negotiation above, so the height read here is the page's NEW one.
  React.useEffect(() => {
    if (!kb.keyboardOpen || !driving) return
    const tap = lastTapRef.current
    if (!tap) return
    const t = setTimeout(() => {
      const painted = paintedRef.current
      const pageHeight = painted?.frame.metadata.deviceHeight ?? 0
      const dy = keyboardScrollDelta(tap.y, pageHeight)
      if (dy) socketRef.current?.wheel(tap, { dx: 0, dy })
      lastTapRef.current = null
    }, 420)
    return () => clearTimeout(t)
  }, [kb.keyboardOpen, driving])

  // ── touch ──────────────────────────────────────────────────────────────────
  const gestureRef = React.useRef<TouchGesture | null>(null)
  if (gestureRef.current == null) {
    gestureRef.current = new TouchGesture()
  }

  /** Relay what the recogniser decided. A tap is a click AND the moment the
   *  keyboard may be wanted, so it is also what focuses the trap. */
  const relay = React.useCallback(
    (actions: GestureAction[]) => {
      const sock = socketRef.current
      if (!sock) return
      for (const a of actions) {
        if (a.kind === 'touch') {
          sock.touch(a.phase, a.point)
          continue
        }
        lastTapRef.current = a.point
        sock.mouse('down', a.point, { buttons: 1, clickCount: a.clickCount })
        sock.mouse('up', a.point, { buttons: 0, clickCount: a.clickCount })
        // Focusing INSIDE the touchend handler is what makes iOS raise the
        // keyboard at all: a focus() outside a user gesture is ignored there.
        focusTrap()
      }
    },
    [focusTrap],
  )

  const touchPoint = (t: { clientX: number; clientY: number }) =>
    pagePoint(t.clientX, t.clientY)

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!driving) return
    const t = e.touches[0]
    if (!t) return
    const p = touchPoint(t)
    if (!p) return
    relay(gestureRef.current!.begin(p, e.timeStamp))
  }

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!driving) return
    const t = e.touches[0]
    if (!t) return
    const p = touchPoint(t)
    if (!p) return
    relay(gestureRef.current!.move(p, e.timeStamp))
  }

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!driving) return
    const t = e.changedTouches[0]
    relay(gestureRef.current!.end(t ? touchPoint(t) : null, e.timeStamp))
  }

  const onTouchCancel = () => {
    relay(gestureRef.current!.cancel())
  }

  // Wheel has to be a native listener: React's synthetic `onWheel` is passive
  // in every current engine, so `preventDefault` there is a no-op and the
  // takeover surface would scroll the supermux page instead of the agent's.
  React.useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      if (!driving) return
      const p = pagePoint(e.clientX, e.clientY)
      if (!p) return
      e.preventDefault()
      socketRef.current?.wheel(p, { dx: e.deltaX, dy: e.deltaY })
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [driving, pagePoint])

  // ── mouse (desktop) ────────────────────────────────────────────────────────
  // Pointer events fire for TOUCH too, and a finger that produced both a
  // pointer stream and a touch stream would click twice and scroll twice. Touch
  // has its own recogniser above, so this path is mouse and pen only.
  const isMouse = (e: React.PointerEvent<HTMLDivElement>) => e.pointerType !== 'touch'

  /** A pointer event's `detail` is 0 in chrome — it is a `MouseEvent` field —
   *  so the count is kept here, and the `up` reuses the `down`'s. */
  const clicksRef = React.useRef<ClickCounter | null>(null)
  if (clicksRef.current == null) {
    clicksRef.current = new ClickCounter()
  }
  const clickCountRef = React.useRef(1)

  const mouseButton = (button: number) =>
    button === 2 ? 'right' : button === 1 ? 'middle' : 'left'

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isMouse(e)) return
    // Focus the trap, not the box: it is the one element that owns the keyboard
    // while driving (and on desktop it raises nothing — it is just where the
    // keystrokes land). Not driving: focus the box, so the surface is still
    // keyboard-reachable and Drive is one Tab away.
    if (driving) focusTrap()
    else e.currentTarget.focus({ preventScroll: true })
    if (!driving) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    clickCountRef.current = clicksRef.current!.next(p, e.timeStamp)
    socketRef.current?.mouse('down', p, {
      buttons: 1,
      clickCount: clickCountRef.current,
      button: mouseButton(e.button),
      modifiers: modifiersFor(e),
    })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!driving || !isMouse(e)) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    socketRef.current?.mouse('move', p, {
      buttons: e.buttons,
      modifiers: modifiersFor(e),
    })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!driving || !isMouse(e)) return
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    socketRef.current?.mouse('up', p, {
      buttons: 0,
      // The pair has to agree: a `down` that opened a double click and an `up`
      // that says "1" is a page that never sees the double click at all.
      clickCount: clickCountRef.current,
      button: mouseButton(e.button),
      modifiers: modifiersFor(e),
    })
  }

  /**
   * Keep the FOCUS on the trap.
   *
   * A tap fires compatibility mouse events after `touchend`, and the browser's
   * default `mousedown` behaviour moves focus to the nearest focusable
   * ancestor — which is this box, `tabIndex={0}`. That silently un-focused the
   * trap on every single tap: the keyboard came up and then typed into nothing.
   * Cancelling the default keeps focus where the tap put it, and costs nothing
   * we want (the box's own selection and drag behaviour are relayed to the page
   * anyway, not performed locally).
   */
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (driving) e.preventDefault()
  }

  /** Right-click belongs to the PAGE while driving — the server has accepted
   *  `button:'right'` since phase 0, and a supermux context menu over somebody
   *  else's page is not a menu about anything the human can see. */
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (driving) e.preventDefault()
  }

  // ── keys ───────────────────────────────────────────────────────────────────
  // TWO SURFACES, ONE RULE SET, AND THE DIFFERENCE IS WHERE PRINTABLES GO.
  //
  //   · THE TRAP is an `<input>`, so a printable key also produces an `input`
  //     event carrying the text — which is the path that survives IME, dead
  //     keys and Android's `Unidentified`. Relaying the key event AS WELL would
  //     type every character twice, so `insert` is left to `onTrapInput`.
  //   · THE BOX is a `<div>`. No input event will ever fire on it, so a
  //     printable key that is not relayed here is a keystroke that vanishes.
  //     `key()` carries `text` for exactly this case (`keyText`).
  //
  // Everything else — named keys, chords, and the ⌘ shortcuts the platform
  // keeps — is identical on both.
  const relayKey = (kind: 'down' | 'up', e: React.KeyboardEvent, fromTrap: boolean) => {
    // THE TRAP IS INSIDE THE BOX, so every key it handles would bubble into the
    // box's handler and be relayed a SECOND time — every character typed twice,
    // every Enter submitting twice. One surface handles a given event; that is
    // what this line buys.
    if (fromTrap) e.stopPropagation()
    if (!driving) return
    const action = trapKeyAction(e)
    if (action === 'ignore') return
    if (action === 'insert' && fromTrap) return
    e.preventDefault()
    socketRef.current?.key(kind, e)
  }

  const onKeyDown = (e: React.KeyboardEvent) => relayKey('down', e, false)
  const onKeyUp = (e: React.KeyboardEvent) => relayKey('up', e, false)
  const onTrapKeyDown = (e: React.KeyboardEvent) => relayKey('down', e, true)
  const onTrapKeyUp = (e: React.KeyboardEvent) => relayKey('up', e, true)

  /** The trap's text, drained on every input event so it never accumulates a
   *  shadow copy of what the human typed — and never shows a second caret
   *  disagreeing with the page's. */
  const drainTrap = (el: HTMLInputElement): string => {
    const value = el.value
    el.value = ''
    return value
  }

  const onTrapInput = (e: React.FormEvent<HTMLInputElement>) => {
    e.stopPropagation()
    const value = drainTrap(e.currentTarget)
    // Mid-composition the value is a half-written glyph; `compositionend` sends
    // the finished one.
    if (!driving || composingRef.current || !value) return
    socketRef.current?.text(value)
  }

  const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    e.stopPropagation()
    composingRef.current = false
    const value = drainTrap(e.currentTarget) || e.data
    if (!driving || !value) return
    socketRef.current?.text(value)
  }

  const onPaste = (e: React.ClipboardEvent) => {
    if (!driving) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (!text) return
    e.preventDefault()
    // `insertText`, not per-key events: it is the only path that carries
    // non-ASCII and emoji intact.
    socketRef.current?.text(text)
  }

  // ── what the box is doing, and the one thing to do about it ────────────────
  const view = viewportState({
    hasTab: true,
    tabLive: tabLive ?? true,
    waking: !!waking,
    // A socket that was never dialled has no state to report — `null` is what
    // sends the matrix down the row's own asleep/connecting branch.
    socket: attached ? snap.state : null,
    mode: snap.mode,
    needsLogin: !!needsLogin,
    crashed: !!crashed,
    subject: kind,
  })

  const act = (verb: ViewportVerb) => {
    const sock = socketRef.current
    switch (verb) {
      case 'wake':
        // Both halves: the host's row has to learn it is awake (or the chrome
        // keeps offering Wake), and the socket dials — which, on the tab route,
        // IS the wake: `tab_takeover_socket` rehydrates on attach.
        onWake?.()
        setDialled(true)
        sock?.restart()
        return
      case 'retry':
        sock?.restart()
        return
      case 'drive':
        sock?.takeOver()
        return
      case 'reload':
        onReload?.()
        return
    }
  }

  return (
    <div
      className={cn('flex min-h-0 flex-col overflow-hidden bg-paper text-ink', className)}
      data-takeover={name}
      data-takeover-kind={kind}
    >
      {renderHeader ? (
        renderHeader({ snapshot: snap, driving })
      ) : (
      <header className="flex items-center gap-2 border-b border-hairline bg-surface px-3 py-2">
        {!embedded && <ModePill mode={snap.mode} state={snap.state} />}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2"
          title={snap.url}
          data-takeover-url
        >
          {snap.url || '—'}
        </span>
        {embedded ? null : driving ? (
          <button
            type="button"
            onClick={() => socketRef.current?.handBack()}
            className="shrink-0 rounded-full border border-hairline bg-fill-soft px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-fill-soft-2 motion-reduce:transition-none"
          >
            Hand back to agent
          </button>
        ) : (
          <button
            type="button"
            onClick={() => socketRef.current?.takeOver()}
            disabled={snap.state !== 'live'}
            className="shrink-0 rounded-full border border-hairline bg-fill-soft px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-fill-soft-2 disabled:opacity-60 motion-reduce:transition-none"
          >
            Take over
          </button>
        )}
      </header>
      )}

      <div
        ref={boxRef}
        role="application"
        aria-label={
          kind === 'tab' ? 'Shared browser tab' : `Shared browser for ${name}`
        }
        tabIndex={0}
        data-takeover-driving={driving ? 'yes' : 'no'}
        data-viewport-phase={view.phase}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        // The lift is the keyboard's height (iOS overlays the layout viewport;
        // on Android the layout already shrank and this is 0). The resize it
        // causes re-negotiates the page's own box, so the page gets SMALLER
        // rather than scrolling out from under the thumb.
        style={lift ? { marginBottom: lift } : undefined}
        className={cn(
          'relative min-h-0 flex-1 touch-none select-none outline-none',
          // `touch-none` stops the BROWSER panning (we recognise the gesture
          // ourselves); `overscroll-contain` stops a fling at the page's top
          // from pulling supermux itself down to refresh.
          '[overscroll-behavior:contain]',
          'bg-[var(--sm-code-bg)]',
          driving ? 'cursor-default' : 'cursor-not-allowed',
          // The one moment worth marking: a ring that says "you are IN the
          // page", so nobody types a password into a surface that is watching.
          driving && 'ring-2 ring-inset ring-primary',
        )}
      >
        {/* Dimmed while the state says the picture is not a claim about now —
            the honest half of "keep the last frame": it stays readable, and it
            stops looking live. */}
        <canvas
          ref={canvasRef}
          className={cn(
            'block h-full w-full',
            view.dim && view.cover !== 'screen' && 'opacity-50',
          )}
          data-takeover-canvas
        />

        {/* THE KEYBOARD TRAP. A real, focusable input — the only thing on a
            phone that raises a keyboard — kept visually out of the way rather
            than `display:none`, which is unfocusable. 16px because iOS zooms
            the whole supermux page when a focused field is smaller, which is
            the exact bug the address bar was fixed for in phase 1. */}
        <input
          ref={trapRef}
          data-keyboard-trap=""
          aria-label="Type into the page"
          type="text"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          tabIndex={-1}
          disabled={!driving}
          onKeyDown={onTrapKeyDown}
          onKeyUp={onTrapKeyUp}
          onInput={onTrapInput}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={onCompositionEnd}
          onPaste={(e) => {
            // Same double-relay hazard as the keys above: the box would paste
            // the clipboard a second time on the way up.
            e.stopPropagation()
            onPaste(e)
          }}
          style={{ fontSize: 16 }}
          className="absolute left-0 top-0 size-px border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
        />

        {view.cover === 'screen' && (
          <ViewportScreen view={view} onAct={act} canWake={!!onWake} canReload={!!onReload} />
        )}
        {view.cover === 'banner' && <ViewportBanner view={view} onAct={act} />}
        {keyboardUp && <KeyboardDoneBar onDone={() => trapRef.current?.blur()} />}
        <StatusVeil refused={snap.refused} />
      </div>
    </div>
  )
}

/** AGENT_DRIVING / HUMAN_DRIVING — the one thing that must never be ambiguous. */
function ModePill({
  mode,
  state,
}: {
  mode: TakeoverSnapshot['mode']
  state: TakeoverSnapshot['state']
}) {
  const human = mode === 'human_driving'
  const label = mode === null ? '—' : human ? 'HUMAN_DRIVING' : 'AGENT_DRIVING'
  return (
    <span
      data-takeover-mode={mode ?? 'unknown'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium tracking-tight',
        human
          ? 'border-transparent bg-bubble-user text-bubble-user-ink'
          : 'border-hairline bg-fill-soft text-ink-2',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          human ? 'bg-current' : 'bg-ink-3',
          state === 'live' && human && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      {label}
    </span>
  )
}

/** The transient one: an input the server DROPPED, and why. Everything else a
 *  human needs to act on is a state screen now (see `viewport-state.ts`) —
 *  a pill floating over a black rectangle was the audit's headline complaint. */
function StatusVeil({ refused }: { refused: string | null }) {
  if (!refused) return null
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3"
      data-takeover-status
    >
      <span className="rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-2 backdrop-blur">
        {`Input ignored — ${refused}`}
      </span>
    </div>
  )
}

/** A state that owns the box: there is nothing truthful to show behind it.
 *
 *  Always a title, a sentence that says what is actually true, and — where one
 *  exists — the single verb that fixes it, at thumb size. A state screen whose
 *  action the host did not wire renders WITHOUT the button rather than with a
 *  dead one. */
function ViewportScreen({
  view,
  onAct,
  canWake,
  canReload,
}: {
  view: ViewportView
  onAct: (verb: ViewportVerb) => void
  canWake: boolean
  canReload: boolean
}) {
  const action =
    view.action &&
    (view.action.verb === 'wake' ? canWake : view.action.verb === 'reload' ? canReload : true)
      ? view.action
      : null
  return (
    <div
      data-viewport-screen={view.phase}
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center',
        // Opaque over a dimmed frame, or over nothing at all. Either way the
        // human is reading words, not squinting past them.
        view.keepFrame ? 'bg-background/85 backdrop-blur-[2px]' : 'bg-background',
      )}
    >
      {view.spinner && (
        <Loader2
          className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-hidden
        />
      )}
      <p className="text-[13px] font-medium text-foreground">{view.title}</p>
      <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-muted-foreground">
        {view.detail}
      </p>
      {action && (
        <button
          type="button"
          onClick={() => onAct(action.verb)}
          data-viewport-action={action.verb}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground"
        >
          {action.verb === 'wake' && <Power className="size-4" aria-hidden />}
          {action.verb === 'reload' && <RotateCw className="size-4" aria-hidden />}
          {action.label}
        </button>
      )}
    </div>
  )
}

/** A state that sits OVER a live page — signed-out, and reconnecting. Both are
 *  cases where covering the page would hide the very thing the human came for
 *  (the sign-in form; the last frame). Top-anchored, out of the thumb zone. */
function ViewportBanner({
  view,
  onAct,
}: {
  view: ViewportView
  onAct: (verb: ViewportVerb) => void
}) {
  return (
    <div
      data-viewport-banner={view.phase}
      className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
        {view.spinner && (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden
          />
        )}
        <span className="min-w-0 truncate text-[12.5px] text-foreground">{view.title}</span>
        {view.action && (
          <button
            type="button"
            onClick={() => onAct(view.action!.verb)}
            data-viewport-action={view.action.verb}
            className="relative shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground after:absolute after:-inset-1.5 after:content-['']"
          >
            {view.action.label}
          </button>
        )}
      </div>
    </div>
  )
}

/** The way OUT of the soft keyboard. Without it the only dismissal is the
 *  platform's swipe-down, which on a page that has just been tapped tends to
 *  re-open — and a keyboard you cannot put away is a page you cannot read. */
function KeyboardDoneBar({ onDone }: { onDone: () => void }) {
  return (
    <div className="absolute inset-x-0 bottom-0 flex justify-end border-t border-border bg-card/95 p-1.5 backdrop-blur">
      <button
        type="button"
        onClick={onDone}
        data-keyboard-done=""
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-4 text-[13px] font-medium text-foreground"
      >
        <Keyboard className="size-4" aria-hidden />
        Done
      </button>
    </div>
  )
}
