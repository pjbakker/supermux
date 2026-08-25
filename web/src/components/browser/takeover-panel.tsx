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

import {
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Keyboard,
  KeyRound,
  Loader2,
  Minimize2,
  Power,
  RotateCw,
} from 'lucide-react'

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
  measuredViewport,
  modifiersFor,
  signInOps,
  subjectName,
  type TakeoverOptions,
  type TakeoverSnapshot,
  type TakeoverSubject,
} from '@/lib/browser/takeover-socket'
import { SignInSheet, type SignInCreds } from '@/components/browser/sign-in-sheet'
import { signInGate, type DetectedFill } from '@/lib/browser/sign-in-state'
import {
  ClickCounter,
  TAP_MS,
  TAP_SLOP_PX,
  TouchGesture,
  type GestureAction,
} from '@/lib/browser/gestures'
import { EdgeSwipe, type EdgePeek } from '@/lib/browser/edge-swipe'
import {
  NO_ZOOM,
  isZoomed,
  panBy,
  pinchMid,
  pinchSpan,
  pinchTo,
  toggleZoom,
  zoomAt,
  zoomTransform,
  type PinchStart,
  type ZoomState,
} from '@/lib/browser/zoom'
import { keyboardScrollDelta, trapKeyAction } from '@/lib/browser/keyboard-trap'
import { viewportState, type ViewportVerb, type ViewportView } from '@/lib/browser/viewport-state'
import { useKeyboardViewport, useKeyboardRootResize } from '@/hooks/use-keyboard-viewport'
import { PageDialogSurface } from '@/components/browser/page-dialog'

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
  // ── the browser's own verbs (phase 3) ──────────────────────────────────────
  // Published here rather than left to REST because the socket is ALREADY
  // holding this page: the frame goes straight into the relay instead of
  // round-tripping a row load, a wake and a row re-read. The host falls back to
  // the REST door only when nothing is attached — see `workspace.tsx`.
  /** The omnibox's Enter. */
  navigate: (url: string) => void
  back: () => void
  forward: () => void
  /** `hard` = ignore the cache. */
  reload: (hard?: boolean) => void
  /** Stop the in-flight load — what Reload becomes while `loading`. */
  stop: () => void
  /** Answer the modal blocking the page. Dismiss is the safe default. */
  dialog: (accept: boolean, promptText?: string) => void
  // ── the DOM verbs (phase 4) ────────────────────────────────────────────────
  // Both return `false` when this relay cannot do them, which is TODAY for
  // every server: nothing goes on the wire and the caller's UI says why. See
  // `lib/browser/page-tools.ts` for the exact server work each one needs.
  /** Search the page's DOM. `false` = the relay has no find. */
  find: (query: string, opts?: { forward?: boolean; caseSensitive?: boolean }) => boolean
  /** Drop the server's search state — a closed bar must not leak a search. */
  findClose: () => void
  /** Ask for the page's current selection as text. `false` = no copy-out. */
  copySelection: () => boolean
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
  /** **Take the wheel automatically when this tab first goes live.** The shared
   *  browser is a human-first tool, so opening or browsing to a page should DRIVE
   *  by default rather than start in watch-first (the workspace passes this). A
   *  ONE-SHOT per mount: it fires once when the socket first reaches `live`, so a
   *  later **Hand back to agent** sticks and a reconnect never re-grabs the wheel.
   *  The panel is keyed by tab, so switching tabs re-arms it for the new page. */
  driveOnAttach?: boolean
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
  /** BENCH ONLY — the phase-4 joy layer, frozen mid-gesture.
   *
   *  A swipe peek, a pinch and a tap ripple are all things a finger does and a
   *  screenshot rig has no fingers, so the ONE way to capture them offline is
   *  to hand the panel the state a finger would have produced. Every field
   *  drives the SAME overlay the real gesture drives — there is no bench-only
   *  branch below this prop, which is what stops the bench drifting from the
   *  product. */
  benchGesture?: { peek?: EdgePeek; zoom?: number; ripple?: boolean }
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
  driveOnAttach,
  waking,
  needsLogin,
  crashed,
  onWake,
  onReload,
  benchKeyboard,
  benchGesture,
  className,
}: TakeoverPanelProps) {
  // Primitives, not the object: a caller passing `subject={{kind:'tab',id}}`
  // inline would otherwise hand the effect a new identity on every render and
  // redial the socket sixty times a minute.
  const kind = subject?.kind ?? 'session'
  const name = subject ? subjectName(subject) : session ?? ''

  const [snap, setSnap] = React.useState<TakeoverSnapshot>(EMPTY_SNAPSHOT)
  /** The url the current zoom belongs to. */
  const zoomUrlRef = React.useRef('')

  // ── VISUAL ZOOM (phase 4) ──────────────────────────────────────────────────
  // A magnifying glass over the frame we already hold — never a re-layout ask,
  // so a pinch answers in one frame on a 200ms relay. The state is mirrored
  // into a ref because every consumer below reads it from an EVENT handler
  // (a tap, a wheel, a resize), never during render, and a stale closure there
  // would map a tap through last frame's zoom.
  const [zoom, setZoom] = React.useState<ZoomState>(NO_ZOOM)
  const zoomRef = React.useRef<ZoomState>(NO_ZOOM)
  /** A finger is ON it right now, so the transform must follow the finger with
   *  no transition at all. Off, and the same transform SETTLES — which is what
   *  makes a double tap and a released rubber-band read as motion rather than
   *  as a jump. One flag, both gestures. */
  const [liveGesture, setLiveGesture] = React.useState(false)
  const liveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const applyZoom = React.useCallback((next: ZoomState) => {
    zoomRef.current = next
    setZoom(next)
  }, [])
  /** Continuous input (a trackpad's ctrl-wheel) has no end event, so its
   *  live-ness is a trailing timer rather than a gesture boundary. */
  const zoomLiveFor = React.useCallback((ms: number) => {
    setLiveGesture(true)
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => setLiveGesture(false), ms)
  }, [])
  React.useEffect(() => () => {
    if (liveTimer.current) clearTimeout(liveTimer.current)
  }, [])

  /**
   * The socket's snapshot, plus the one thing a NAVIGATION has to reset.
   *
   * A NEW PAGE STARTS AT FIT: a zoom is a fact about the picture in front of
   * you, not about the tab, so carrying 2.5× across a navigation opens the
   * next page at a random corner of itself. Done HERE — in the socket's own
   * callback, which is an event — rather than in an effect watching the url,
   * because an effect would be a second render for a fact this one already has.
   */
  const receiveSnap = React.useCallback((next: TakeoverSnapshot) => {
    if (next.nav.url !== zoomUrlRef.current) {
      zoomUrlRef.current = next.nav.url
      zoomRef.current = NO_ZOOM
      setZoom(NO_ZOOM)
      setLiveGesture(false)
    }
    setSnap(next)
  }, [])

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
  const [signInOpen, setSignInOpen] = React.useState(false)
  /** Auto-drive one-shot: set once we have taken the wheel on this mount, so a
   *  Hand back sticks and a reconnect never re-grabs. Reset only by a remount
   *  (the panel is keyed by tab), which is exactly "a new page was opened". */
  const autoDroveRef = React.useRef(false)

  // DRIVE BY DEFAULT (workspace tabs). The shared browser is a human-first tool,
  // so opening or browsing to a page takes the wheel automatically rather than
  // starting watch-first. One-shot per mount (`autoDroveRef`): fires the first
  // time the socket reaches `live` and we are not already driving, so a Hand back
  // sticks and a reconnect never re-grabs. Only ever for a `driveOnAttach` host —
  // the in-chat session socket already drives server-side, the bench never asks.
  React.useEffect(() => {
    if (!driveOnAttach || autoDroveRef.current) return
    if (snap.state === 'live' && snap.mode !== 'human_driving') {
      autoDroveRef.current = true
      socketRef.current?.takeOver()
    }
  }, [driveOnAttach, snap.state, snap.mode])

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
      receiveSnap,
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
        navigate: (url: string) => sock.navigate(url),
        back: () => sock.back(),
        forward: () => sock.forward(),
        reload: (hard?: boolean) => sock.reload(!!hard),
        stop: () => sock.stopLoading(),
        dialog: (accept: boolean, promptText?: string) => sock.dialog(accept, promptText),
        find: (query: string, opts?: { forward?: boolean; caseSensitive?: boolean }) =>
          sock.find(query, opts),
        findClose: () => sock.findClose(),
        copySelection: () => sock.copySelection(),
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
  }, [kind, name, options, controlsRef, attached, receiveSnap])

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
      // Re-MEASURED here, every time — the box's height is fed by the app-shell
      // `100dvh` flex chain, which on an iOS PWA cold launch briefly resolves
      // SHORT (globals.css:742, use-keyboard-viewport.ts:168) and settles to the
      // full height only after a viewport resize. Reading `boxRef` at fire time
      // (not closing over a stale size) is what lets a settle correct a height
      // that was collapsed at attach.
      sock.viewport(
        measuredViewport(box, {
          driving,
          devicePixelRatio: window.devicePixelRatio || 1,
          coarsePointer: !!window.matchMedia?.('(pointer: coarse)').matches,
        }),
      )
    }, 120)
  }, [driving])
  React.useEffect(
    () => () => {
      if (negotiateAt.current) clearTimeout(negotiateAt.current)
    },
    [],
  )
  // Taking the wheel re-negotiates: same box, sharper pixels.
  //
  // Plus a short burst of delayed re-measures after attach/wheel-change: the iOS
  // PWA `100dvh` height can settle from short to full WITHOUT firing a resize the
  // observer catches, and a box that is already stable-tall emits no further
  // event at all — so a one-shot negotiate at attach can ship a collapsed height
  // that then never gets corrected. Re-measuring at a few fixed delays reaches
  // the settled box regardless; the socket de-dups an unchanged box, so once the
  // height is stable these cost nothing on the wire.
  React.useEffect(() => {
    negotiate()
    const timers = [250, 700, 1500].map((ms) => setTimeout(negotiate, ms))
    return () => timers.forEach(clearTimeout)
  }, [negotiate])

  // Repaint from the frame we ALREADY hold, and re-negotiate, whenever the box
  // SETTLES — a rotation, a split-pane drag, an iOS URL-bar collapse, and the
  // one this exists to catch: the iOS-PWA `100dvh` cold-launch height settling
  // from short to full. `blit` sizes the backing store, so without the repaint
  // the canvas keeps the previous box's dimensions and the browser stretches it;
  // on a static page NO further frame arrives on its own to fix it — the
  // re-negotiate is what makes the server push a fresh still at the settled box.
  React.useEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (!box || !canvas) return
    // One settle handler for every signal. Debounced inside `negotiate`, and the
    // socket de-dups an unchanged box — so firing it generously is free.
    const settle = () => {
      const painted = paintedRef.current
      if (painted) blit(canvas, box, painted.image)
      // The box may have moved, so the box we told the SERVER about is stale —
      // the page is now being laid out for a viewport that no longer exists.
      negotiate()
    }
    // The box's OWN size change (rotation, split-pane). The primary signal.
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settle)
    ro?.observe(box)
    // The VIEWPORT settling. On iOS PWA the shell's `100dvh` flex chain resolves
    // short on cold launch and only settles after a viewport resize event —
    // which fires on `window`/`visualViewport` even in the window where the box's
    // ResizeObserver has been torn down for a `negotiate` identity change (the
    // wheel changing hands). Belt to the ResizeObserver's braces: whichever sees
    // the settle first re-negotiates, the other de-dups.
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', settle)
      window.addEventListener('orientationchange', settle)
    }
    vv?.addEventListener('resize', settle)
    return () => {
      ro?.disconnect()
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', settle)
        window.removeEventListener('orientationchange', settle)
      }
      vv?.removeEventListener('resize', settle)
    }
    // Re-installed when the wheel changes hands, because `negotiate` closes
    // over `driving` (the drive profile asks for sharper pixels). That happens
    // twice a session and never mid-gesture, so it costs nothing.
  }, [negotiate])

  /** The canvas' own box, in CSS px — the space the zoom transform lives in. */
  const zoomBox = React.useCallback(() => {
    const rect = boxRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }, [])

  /** Client coords → the canvas' own box coords, zoom undone.
   *
   *  THE ORDER MATTERS AND IT IS EASY TO GET WRONG. The frame is painted at
   *  `p × scale + offset`, so a tap at `c` was aimed at `(c − offset) / scale`.
   *  Skip this and every tap on a zoomed page lands somewhere else — which is
   *  the bug that makes a zoom feel haunted rather than broken. */
  const unzoomed = React.useCallback((clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return null
    const z = zoomRef.current
    return {
      x: (clientX - rect.left - z.x) / z.scale,
      y: (clientY - rect.top - z.y) / z.scale,
      rect,
    }
  }, [])

  /** A pointer/wheel event's position in PAGE coordinates, or `null` when it
   *  landed on the letterbox (or before the first frame). */
  const pagePoint = React.useCallback(
    (clientX: number, clientY: number) => {
      const painted = paintedRef.current
      const local = unzoomed(clientX, clientY)
      if (!painted || !local) return null
      return toPagePoint(
        { x: local.x, y: local.y },
        { width: local.rect.width, height: local.rect.height },
        frameSize(painted.image),
        painted.frame.metadata,
      )
    },
    [unzoomed],
  )


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
  // How the canvas gets out from under the soft keyboard. NOT a `marginBottom`
  // lift on this box — the documented iOS behaviour is that the LAYOUT viewport
  // keeps its full height while `visualViewport` shrinks and SCROLLS (offsetTop),
  // so subtracting the keyboard with a margin fights the iOS scroll and
  // over-shrinks (the page collapsed into a strip with a black band). Instead we
  // pin the whole app root to `visualViewport.height` while driving with the
  // keyboard open — the same technique the chat composer uses on this device —
  // so the normal-flow `h-full` chain below simply ends on the keyboard top.
  useKeyboardRootResize(driving)

  const focusTrap = React.useCallback(() => {
    // `preventScroll`: the trap is a 1px box inside the viewport, and letting
    // the platform scroll it into view would move the supermux page under a
    // human who is looking at somebody else's.
    trapRef.current?.focus({ preventScroll: true })
  }, [])

  // THE ONE MOMENT WORTH MARKING. Taking the wheel is the instant a human
  // becomes responsible for what happens on a page that is signed in to
  // things, so it gets the app's one browser haptic and a ring that DRAWS in
  // (the box's `transition-shadow` below) rather than appearing. Hand-back is
  // deliberately silent: giving something up needs no celebration.
  const drovePrev = React.useRef(driving)
  React.useEffect(() => {
    if (driving && !drovePrev.current) {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(10)
    }
    drovePrev.current = driving
  }, [driving])

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
  //
  // FOUR GESTURES SHARE ONE FINGER, and the order they are asked in IS the
  // design (phase 4):
  //
  //   1. **two fingers → pinch.** Never anything else, and it cancels whatever
  //      one finger had started — a pinch that also scrolled the page is the
  //      classic double-handling bug.
  //   2. **one finger while zoomed → pan the magnifier.** Nothing reaches the
  //      page: at 2.5× the human is reading, not clicking, and a page that
  //      scrolled under a pan would make the zoom unusable.
  //   3. **one finger from the EDGE → back / forward.** Chrome, not content,
  //      so it is asked before the page and it works while WATCHING — the
  //      server handles `back` above the drive gate on purpose, and refusing a
  //      watcher the gesture while the toolbar button next to it works would be
  //      incoherent rather than safer.
  //   4. **anything else → the page**, through the phase-2 recogniser.
  //
  // 3 and 4 overlap on purpose: the edge recogniser and the page recogniser
  // BOTH see the start, and whichever commits first takes it. A finger that
  // went down at the margin and then straight down the screen is a scroll, and
  // the page gets it — which is the only way a page stays scrollable along its
  // own left edge.
  const gestureRef = React.useRef<TouchGesture | null>(null)
  if (gestureRef.current == null) {
    gestureRef.current = new TouchGesture()
  }
  const edgeRef = React.useRef<EdgeSwipe | null>(null)
  if (edgeRef.current == null) {
    edgeRef.current = new EdgeSwipe()
  }
  /** The double tap that zooms, counted in BOX coords — the zoom is chrome, so
   *  it must survive a tap on the letterbox where a page point does not exist. */
  const zoomTapsRef = React.useRef<ClickCounter | null>(null)
  if (zoomTapsRef.current == null) {
    zoomTapsRef.current = new ClickCounter()
  }
  const pinchRef = React.useRef<PinchStart | null>(null)
  const panRef = React.useRef<{ x: number; y: number } | null>(null)
  const touchStartRef = React.useRef<{ x: number; y: number; at: number } | null>(null)
  const lastBoxRef = React.useRef<{ x: number; y: number } | null>(null)
  /** The live peek, for the overlay. `null` = no swipe in progress. */
  const [peek, setPeek] = React.useState<EdgePeek | null>(null)
  /** Latched so the "let go and it goes" haptic fires ONCE per crossing. */
  const armedRef = React.useRef(false)
  /** The 300ms confirmation at the point a finger landed. On a 200ms relay
   *  this is the whole difference between "did that register" and confidence,
   *  and it costs one absolutely-positioned span. */
  const [ripple, setRipple] = React.useState<{ x: number; y: number; key: number } | null>(null)
  const rippleKey = React.useRef(0)

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

  /** Client → the box's own coords, zoom NOT undone: the edge swipe is about
   *  the edge of the SCREEN and the ripple is painted over the canvas, so both
   *  live in the untransformed layer. */
  const boxPoint = (t: { clientX: number; clientY: number }) => {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: t.clientX - rect.left, y: t.clientY - rect.top, width: rect.width }
  }

  const haptic = () => {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(8)
  }

  const beginPinch = (e: React.TouchEvent<HTMLDivElement>) => {
    const a = boxPoint(e.touches[0])
    const b = boxPoint(e.touches[1])
    if (!a || !b) return
    // A pinch is not a swipe and not a scroll: whatever one finger had begun
    // is abandoned, and the page is told the touch it saw is cancelled.
    edgeRef.current!.cancel()
    setPeek(null)
    if (driving) relay(gestureRef.current!.cancel())
    panRef.current = null
    setLiveGesture(true)
    pinchRef.current = {
      base: zoomRef.current,
      span: pinchSpan(a, b),
      mid: pinchMid(a, b),
    }
  }

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length >= 2) {
      beginPinch(e)
      return
    }
    // The leftover finger of a pinch that has not fully lifted is not a new
    // gesture — see `onTouchEnd`.
    if (pinchRef.current) return
    const t = e.touches[0]
    if (!t) return
    const b = boxPoint(t)
    if (!b) return
    lastBoxRef.current = { x: b.x, y: b.y }
    touchStartRef.current = { x: b.x, y: b.y, at: e.timeStamp }
    // Zoomed: this finger pans the magnifier and the page never hears about it.
    if (isZoomed(zoomRef.current)) {
      panRef.current = { x: t.clientX, y: t.clientY }
      setLiveGesture(true)
      return
    }
    // The edge recogniser refuses outright when there is no history that way,
    // so a peek is never an animation that cannot commit.
    edgeRef.current!.begin(b.x, b.y, e.timeStamp, b.width, {
      back: snap.nav.canGoBack,
      forward: snap.nav.canGoForward,
    })
    if (!driving) return
    const p = touchPoint(t)
    if (!p) return
    relay(gestureRef.current!.begin(p, e.timeStamp))
  }

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      if (e.touches.length < 2) return
      const a = boxPoint(e.touches[0])
      const b = boxPoint(e.touches[1])
      if (!a || !b) return
      applyZoom(pinchTo(pinchRef.current, zoomBox(), a, b))
      return
    }
    const t = e.touches[0]
    if (!t) return
    const pan = panRef.current
    if (pan) {
      applyZoom(panBy(zoomRef.current, zoomBox(), t.clientX - pan.x, t.clientY - pan.y))
      panRef.current = { x: t.clientX, y: t.clientY }
      return
    }
    const b = boxPoint(t)
    if (b) lastBoxRef.current = { x: b.x, y: b.y }
    const swipe = b ? edgeRef.current!.move(b.x, b.y, e.timeStamp) : null
    if (swipe) {
      if (swipe.armed && !armedRef.current) {
        armedRef.current = true
        haptic()
      }
      if (!swipe.armed) armedRef.current = false
      setLiveGesture(true)
      setPeek(swipe)
      // The page must not ALSO see this finger — one gesture, one owner.
      if (driving) relay(gestureRef.current!.cancel())
      return
    }
    if (edgeRef.current!.owns) return
    if (!driving) return
    const p = touchPoint(t)
    if (!p) return
    relay(gestureRef.current!.move(p, e.timeStamp))
  }

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      // Held until EVERY finger is up: the one left behind by a pinch is not
      // the start of a pan, and treating it as one is how a zoom drifts on
      // release.
      if (e.touches.length === 0) {
        pinchRef.current = null
        setLiveGesture(false)
      }
      return
    }
    if (panRef.current) {
      panRef.current = null
      setLiveGesture(false)
      return
    }
    const t = e.changedTouches[0]
    const b = t ? boxPoint(t) : null
    if (b) lastBoxRef.current = { x: b.x, y: b.y }
    const verdict = edgeRef.current!.end()
    setPeek(null)
    setLiveGesture(false)
    armedRef.current = false
    if (verdict) {
      if (verdict.commit) {
        haptic()
        if (verdict.edge === 'left') socketRef.current?.back()
        else socketRef.current?.forward()
      }
      // The finger belonged to the swipe; the page was never told it existed.
      if (driving) gestureRef.current!.cancel()
      touchStartRef.current = null
      return
    }
    // DOUBLE TAP → ZOOM, and it beats relaying a page double-click.
    // On a phone a word is selected by long-press, not by two taps, so two taps
    // mean zoom the way they do in every mobile browser. The FIRST tap has
    // already been relayed as a click, which is also what Safari does.
    const start = touchStartRef.current
    const spot = lastBoxRef.current
    touchStartRef.current = null
    let zoomedNow = false
    if (start && spot && e.timeStamp - start.at <= TAP_MS) {
      if (Math.hypot(spot.x - start.x, spot.y - start.y) <= TAP_SLOP_PX) {
        if (zoomTapsRef.current!.next(spot, e.timeStamp) >= 2) {
          applyZoom(toggleZoom(zoomRef.current, zoomBox(), spot))
          zoomedNow = true
        } else if (driving) {
          rippleKey.current += 1
          setRipple({ x: spot.x, y: spot.y, key: rippleKey.current })
        }
      }
    }
    if (!driving) return
    const out = gestureRef.current!.end(t ? touchPoint(t) : null, e.timeStamp)
    if (!zoomedNow) relay(out)
  }

  const onTouchCancel = () => {
    edgeRef.current!.cancel()
    pinchRef.current = null
    panRef.current = null
    touchStartRef.current = null
    setPeek(null)
    setLiveGesture(false)
    armedRef.current = false
    relay(gestureRef.current!.cancel())
  }

  // Wheel has to be a native listener: React's synthetic `onWheel` is passive
  // in every current engine, so `preventDefault` there is a no-op and the
  // takeover surface would scroll the supermux page instead of the agent's.
  React.useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      // A TRACKPAD PINCH arrives as a ctrl-wheel — that is how every engine
      // reports it, and it is the desktop half of the pinch below. Handled
      // before the drive gate because zoom is local chrome: a human WATCHING an
      // agent must be able to lean in and read.
      if (e.ctrlKey || e.metaKey) {
        const rect = boxRef.current?.getBoundingClientRect()
        if (!rect) return
        e.preventDefault()
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        const cur = zoomRef.current
        // The 0.01 factor is the conventional one: a trackpad's ctrl-wheel
        // deltas are small and continuous, a mouse wheel's are ±100, and this
        // makes one notch a sane step without making the trackpad frantic.
        zoomLiveFor(140)
        applyZoom(
          zoomAt(
            cur,
            { width: rect.width, height: rect.height },
            anchor,
            cur.scale * (1 - e.deltaY * 0.01),
          ),
        )
        return
      }
      if (!driving) return
      const p = pagePoint(e.clientX, e.clientY)
      if (!p) return
      e.preventDefault()
      socketRef.current?.wheel(p, { dx: e.deltaX, dy: e.deltaY })
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [driving, pagePoint, applyZoom, zoomLiveFor])

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

  // Relay a password-manager fill into the page — the ordered text/Tab/text the
  // sign-in sheet produced (`signInOps`), each op onto its socket verb. Gated on
  // `driving`: typing into a page you are only watching is the exact thing the
  // wheel exists to prevent.
  const relaySignIn = (creds: SignInCreds) => {
    const sock = socketRef.current
    if (!sock || !driving) return
    for (const op of signInOps(creds)) {
      if (op.kind === 'text') sock.text(op.text)
      else sock.pressKey(op.key)
    }
  }

  // The SMART fill: each detected selector gets its OWN value typed into it via
  // the server's field-scoped `fillField` (focus + trusted keystrokes, role
  // re-checked server-side) — never a blind Tab into whatever was focused. The
  // secret rides the `fillField` call and is never parked. Enter is opt-in and
  // pressed ONCE, after every field landed (spec §3.5.2). Gated on `driving`.
  const relayDetectedFill = (fills: DetectedFill[], submit: boolean) => {
    const sock = socketRef.current
    if (!sock || !driving) return
    for (const f of fills) sock.fillField(f.selector, f.value, f.role)
    if (submit && fills.length > 0) sock.pressKey('Enter')
  }

  // Scroll a detected field into view + focus it, so the human sees where a fill
  // will land before they commit — the sheet's "show me this field".
  const focusDetectedField = (selector: string) => {
    if (!driving) return
    socketRef.current?.focusField(selector)
  }

  // One tap: the clipboard the human already holds, typed into the focused page
  // field. `readText()` can reject (permission, an insecure origin, a browser
  // that still wants its own gesture) — when it does, the trap input's
  // long-press paste and the sign-in sheet are the fallbacks, so this fails
  // quietly rather than raising a toast for a non-error.
  const pasteFromClipboard = async () => {
    if (!driving) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) socketRef.current?.text(text)
    } catch {
      /* clipboard blocked — trap-input paste + the sheet still work */
    }
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

  // PROACTIVELY SCAN the page for a login form whenever we can — the moment the
  // human takes the wheel on a capable relay, and again when the page navigates.
  // The answer lands on `snap.loginScan`, which is what gates the Sign-in
  // control (`signInGate`): no round-trip on the tap, and the button is never a
  // spinner. No-op on an older relay (`scanLogin` returns false without caps).
  const canScan = driving && snap.caps.signIn && view.cover !== 'screen'
  React.useEffect(() => {
    if (!canScan) return
    socketRef.current?.scanLogin()
  }, [canScan, snap.url])

  // The gate: usable-or-not, from the relay's caps + the last scan. `disabled`
  // is the owner's "not usable when there are no fields"; the button below shows
  // its reason and the sheet, when opened, explains rather than spins.
  const signIn = signInGate(snap.caps.signIn, snap.loginScan)

  // The page's own modal, straight off the feed. The bench reaches this through
  // a real `nav_state` frame on its mock socket, not through a prop — so the
  // screenshot and the product share one path.
  const dialog = snap.nav.dialog

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

  // The bench freezes a gesture rather than adding a second code path: every
  // overlay below reads THESE, and a real finger and `?swipe=` reach them the
  // same way.
  const peekNow = peek ?? benchGesture?.peek ?? null
  const zoomNow =
    benchGesture?.zoom && benchGesture.zoom > 1
      ? { scale: benchGesture.zoom, x: 0, y: 0 }
      : zoom
  // The bench's ripple is FROZEN mid-animation rather than replayed: a 300ms
  // one-shot has finished before a screenshot rig can reach it, and a capture
  // of `opacity: 0` is a capture of nothing.
  const benchRipple = !ripple && !!benchGesture?.ripple
  const rippleNow = ripple ?? (benchRipple ? { x: 160, y: 220, key: 0 } : null)
  // The peek's parallax is a THIRD of the finger's travel: the page yielding,
  // not the page leaving — it is not going anywhere until the gesture commits.
  const parallax = peekNow ? peekNow.offset * 0.35 * (peekNow.edge === 'left' ? 1 : -1) : 0
  const zoomPart = zoomTransform(zoomNow)
  const canvasTransform = parallax
    ? `translateX(${parallax.toFixed(1)}px)${zoomPart === 'none' ? '' : ` ${zoomPart}`}`
    : zoomPart

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
        // No keyboard `marginBottom` here: `useKeyboardRootResize(driving)` pins
        // the app root to `visualViewport.height` while the keyboard is open, so
        // this normal-flow box already ends on the keyboard top. The old margin
        // fought the iOS visual-viewport scroll and over-shrank the page.
        className={cn(
          // `overflow-hidden` is load-bearing since phase 4: a zoomed canvas is
          // a `scale()`d element, which paints OUTSIDE its own box unless it is
          // clipped — at 2.5× the page would spill past the viewport and over
          // whatever is under it.
          'relative min-h-0 flex-1 overflow-hidden touch-none select-none outline-none',
          // `touch-none` stops the BROWSER panning (we recognise the gesture
          // ourselves); `overscroll-contain` stops a fling at the page's top
          // from pulling supermux itself down to refresh.
          '[overscroll-behavior:contain]',
          'bg-[var(--sm-code-bg)]',
          driving ? 'cursor-default' : 'cursor-not-allowed',
          // The one moment worth marking: a ring that says "you are IN the
          // page", so nobody types a password into a surface that is watching.
          // It DRAWS in over 150ms — see the haptic above.
          'transition-shadow duration-150 ease-out motion-reduce:transition-none',
          driving && 'ring-2 ring-inset ring-primary',
        )}
      >
        {/* Dimmed while the state says the picture is not a claim about now —
            the honest half of "keep the last frame": it stays readable, and it
            stops looking live.

            THE TRANSFORM IS THE WHOLE JOY LAYER, IN ONE STRING. The zoom is a
            local magnifying glass (`zoom.ts`) and the peek is the swipe's
            parallax; both are `transform`, so both are composited and neither
            costs a repaint of a JPEG. The transition is 0 WHILE A FINGER IS ON
            IT (the picture must track the finger, not chase it) and settles
            when it lets go — which is what turns a double tap into motion and
            a released rubber-band into a spring-back. */}
        <canvas
          ref={canvasRef}
          style={{
            transform: canvasTransform,
            transformOrigin: '0 0',
            transitionProperty: canvasTransform === 'none' && !peekNow ? 'none' : 'transform',
            transitionDuration: liveGesture ? '0ms' : '240ms',
            transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
          }}
          className={cn(
            'block h-full w-full will-change-transform motion-reduce:!transition-none',
            view.dim && view.cover !== 'screen' && 'opacity-50',
          )}
          data-takeover-canvas
          data-takeover-zoom={zoomNow.scale > 1 ? zoomNow.scale.toFixed(2) : undefined}
        />

        {/* THE PEEK. We do not have the previous page's pixels, so we do not
            draw them: what slides in is a chevron and a shadow, which says
            "back" without claiming to be the page you are going to. */}
        {peekNow && <EdgePeekOverlay peek={peekNow} />}

        {/* The 300ms confirmation at the point the finger landed. Local, so it
            is instant on a relay that is not. */}
        {rippleNow && (
          <span
            key={rippleNow.key}
            aria-hidden
            data-takeover-ripple=""
            style={
              benchRipple
                ? {
                    left: rippleNow.x,
                    top: rippleNow.y,
                    animationDelay: '-0.12s',
                    animationPlayState: 'paused',
                  }
                : { left: rippleNow.x, top: rippleNow.y }
            }
            className="sm-browser-ripple pointer-events-none absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/50 ring-2 ring-primary/60"
            onAnimationEnd={() => setRipple(null)}
          />
        )}

        {/* Zoomed is a MODE, and a mode with no way out is a trap. One tap,
            thumb-reachable, and it says the level so the softness is explained
            rather than mysterious. */}
        {isZoomed(zoomNow) && (
          <button
            type="button"
            data-takeover-zoom-reset=""
            onClick={() => {
              setLiveGesture(false)
              applyZoom(NO_ZOOM)
            }}
            style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
            className="absolute left-1/2 z-20 inline-flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-surface/95 px-4 text-[12.5px] font-medium text-ink shadow-lg backdrop-blur transition-colors hover:bg-fill-soft motion-reduce:transition-none"
          >
            <Minimize2 className="size-3.5" aria-hidden />
            {zoomNow.scale.toFixed(1)}× · Fit
          </button>
        )}

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

        {/* THE FILL CLUSTER. A canvas cannot be autofilled — the human's own
            password manager and their clipboard cannot see fields that live in
            a picture — so paste and sign-in reach the page from HERE. Shown
            only while driving (typing into a watched page is what the wheel
            prevents) and only when a page is visible (a `screen` cover means
            there is nothing to fill yet). Bottom-RIGHT so it clears the centred
            zoom-reset; `stopPropagation` on pointer-down so a tap on the pill
            never also lands as a click on the page beneath it. */}
        {driving && view.cover !== 'screen' && (
          <div
            style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
            className="absolute right-3 z-20 flex items-center gap-2"
          >
            <button
              type="button"
              data-takeover-paste=""
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void pasteFromClipboard()}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-hairline bg-surface/95 px-4 text-[12.5px] font-medium text-ink shadow-lg backdrop-blur transition-colors hover:bg-fill-soft motion-reduce:transition-none"
            >
              <ClipboardPaste className="size-3.5" aria-hidden />
              Paste
            </button>
            {/* GATED on the scan (spec §3.1): when the page has no login form
                the control is not usable — muted, `aria-disabled`, and carrying
                the reason. It still opens the sheet (which explains, never
                spins), because a dead button on a phone has no way to say why.
                Tapping it also re-scans on a capable relay, so a form that
                appeared after a client-side route change is picked up. */}
            <button
              type="button"
              data-takeover-signin=""
              data-signin-gate={signIn.kind}
              aria-disabled={signIn.kind === 'disabled' ? true : undefined}
              title={signIn.kind === 'disabled' || signIn.kind === 'frame' ? signIn.reason : undefined}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (snap.caps.signIn) socketRef.current?.scanLogin()
                setSignInOpen(true)
              }}
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-hairline bg-surface/95 px-4 text-[12.5px] font-medium shadow-lg backdrop-blur transition-colors motion-reduce:transition-none',
                signIn.kind === 'disabled'
                  ? 'text-ink-3 hover:bg-surface/95'
                  : 'text-ink hover:bg-fill-soft',
              )}
            >
              <KeyRound className="size-3.5" aria-hidden />
              Sign in
            </button>
          </div>
        )}

        {view.cover === 'screen' && (
          <ViewportScreen view={view} onAct={act} canWake={!!onWake} canReload={!!onReload} />
        )}
        {view.cover === 'banner' && <ViewportBanner view={view} onAct={act} />}
        {/* A page that opened an `alert()` is a page that has STOPPED: chrome
            blocks the renderer until the modal is answered, so without this
            surface the viewport is a frozen picture with no explanation and no
            way out. It sits over the page (the message is about that page) and
            it is the one overlay that must outrank the state banners. */}
        {dialog && (
          <PageDialogSurface
            dialog={dialog}
            onAnswer={(accept, text) => socketRef.current?.dialog(accept, text)}
          />
        )}
        {keyboardUp && <KeyboardDoneBar onDone={() => trapRef.current?.blur()} />}
        <StatusVeil refused={snap.refused} />
      </div>

      {/* The password-manager bridge, now FIELD-AWARE. Portals to body, so it
          lives at the panel root rather than inside the clipped, `touch-none`
          canvas box. The gate + scan decide blind vs detected vs no-form; the
          two relays are the blind text/Tab path and the field-scoped fill. */}
      <SignInSheet
        open={signInOpen}
        onOpenChange={setSignInOpen}
        gate={signIn}
        scan={snap.loginScan}
        url={snap.url}
        onFillDetected={relayDetectedFill}
        onBlindFill={relaySignIn}
        onFocusField={focusDetectedField}
      />
    </div>
  )
}

/**
 * THE EDGE-SWIPE PEEK — a chevron, a shadow, and nothing that pretends.
 *
 * A native back-swipe slides the PREVIOUS page in under your thumb. We have one
 * page's pixels, so drawing a second page would be inventing it — and this
 * browser is signed in to things, which makes an invented page the worst kind
 * of lie there is. What slides in instead is chrome: a scrim that deepens with
 * the drag, a circle that fills, and an arrow that goes solid at the moment
 * letting go would commit. Three signals, all of them true.
 *
 * `progress` is the arithmetic from `edge-swipe.ts`, saturating at the commit
 * point; `armed` is that same threshold as a boolean, so the visual "let go"
 * and the actual "let go" can never disagree.
 */
function EdgePeekOverlay({ peek }: { peek: EdgePeek }) {
  const left = peek.edge === 'left'
  const Arrow = left ? ChevronLeft : ChevronRight
  const size = 40 + peek.progress * 16
  return (
    <div
      aria-hidden
      data-takeover-peek={peek.edge}
      data-takeover-peek-armed={peek.armed ? '' : undefined}
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {/* The scrim comes from the edge the finger is on, so the direction is
          legible before the arrow is read.

          `currentColor`, NOT `hsl(var(--ink))`: this theme's tokens are whole
          colours (`#000000`), not HSL channel triples, so `hsl(var(--ink))` is
          an invalid colour and the entire gradient falls back to `none` —
          silently, with no error anywhere. Inheriting the ink colour off the
          class below gets the same value and cannot rot that way. */}
      <div
        data-side={left ? 'left' : 'right'}
        style={{
          opacity: 0.05 + peek.progress * 0.22,
          [left ? 'left' : 'right']: 0,
          backgroundImage: `linear-gradient(to ${left ? 'right' : 'left'}, currentColor, transparent 60%)`,
        }}
        className="absolute inset-y-0 w-1/2 text-ink"
      />
      <div
        style={{
          [left ? 'left' : 'right']: Math.max(8, peek.offset * 0.6 - size / 2),
          width: size,
          height: size,
          opacity: 0.35 + peek.progress * 0.65,
        }}
        className="absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-surface/95 shadow-xl backdrop-blur"
      >
        <Arrow
          style={{ transform: `scale(${(0.8 + peek.progress * 0.3).toFixed(2)})` }}
          className={peek.armed ? 'size-5 text-primary' : 'size-5 text-ink-2'}
        />
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
