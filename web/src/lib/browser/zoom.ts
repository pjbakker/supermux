/**
 * PINCH AND DOUBLE-TAP — zoom that is HONEST about being a magnifying glass.
 * ─────────────────────────────────────────────────────────────────────────────
 * There are two zooms a relayed page could have and they are not the same
 * thing:
 *
 *   · a PAGE zoom — ask chrome to re-lay the page out bigger. Correct, sharp,
 *     and a round trip away: a `Viewport` renegotiation, a re-layout and a full
 *     still frame, i.e. a pinch that answers in 300ms and reflows the text out
 *     from under the fingers doing it.
 *   · a VISUAL zoom — scale the frame we already have, locally, at 60fps, and
 *     go slightly soft the way a photo does.
 *
 * This is the second one, deliberately, and the softness is the tell that it IS
 * the second one. It never blocks on the server, so a pinch is instant on a
 * 200ms relay; the human who wants sharp text has the drive-profile
 * renegotiation already (`driveDpr`), which is a different verb with a
 * different feel.
 *
 * WHAT THE ARITHMETIC HAS TO GET RIGHT, and why it is pure:
 *
 *  1. **The anchor stays under the fingers.** Zooming about the box's centre
 *     instead of the pinch midpoint is the single thing that makes a zoom feel
 *     like it is fighting you. `zoomAt` is that one line of algebra.
 *  2. **The edges never leave.** Pan is clamped so the scaled frame always
 *     covers the box — no grey gutter, ever, which is what turns "zoomed in"
 *     into "lost".
 *  3. **Scale 1 is exactly scale 1.** At the floor the pan is forced to zero,
 *     so releasing a pinch lands back on the pixel grid rather than 0.3px off
 *     it — the difference between crisp and permanently blurry.
 *
 * COORDINATES are the CANVAS BOX's CSS pixels, origin top-left, which is what
 * a `transform-origin: 0 0` element takes. A point `p` paints at
 * `p × scale + offset`.
 */

/** Fit. Never below: the canvas already letterboxes the frame, and a scale
 *  under 1 would letterbox the letterbox. */
export const MIN_ZOOM = 1
/** A 512px-wide mobile JPEG at 4× is a mosaic; past this nothing is gained. */
export const MAX_ZOOM = 4
/** What a double tap goes TO. Chrome's own double-tap lands near 2.5× on a
 *  phone-width page, and it is the level where body text becomes comfortable
 *  rather than merely legible. */
export const DOUBLE_TAP_ZOOM = 2.5

/** Anything under this reads as "not zoomed" — floating-point dust from a
 *  pinch that ended at the floor must not keep the reset affordance on screen. */
export const ZOOM_EPSILON = 0.02

export interface ZoomState {
  scale: number
  /** Translation in CSS px, applied BEFORE the scale (`transform-origin: 0 0`). */
  x: number
  y: number
}

export interface ZoomBox {
  width: number
  height: number
}

export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 }

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

/** Zoomed enough to matter — the reset chip's condition, and the gate that
 *  decides whether a one-finger drag pans or reaches the page. */
export function isZoomed(z: ZoomState): boolean {
  return z.scale > MIN_ZOOM + ZOOM_EPSILON
}

/**
 * Keep the frame covering the box. `x` runs from `width × (1 − scale)`
 * (right edge flush) to `0` (left edge flush); at scale 1 both bounds are 0,
 * which is what snaps a released pinch back onto the pixel grid.
 */
export function clampPan(z: ZoomState, box: ZoomBox): ZoomState {
  const scale = clampScale(z.scale)
  if (scale <= MIN_ZOOM) return { scale: MIN_ZOOM, x: 0, y: 0 }
  const minX = Math.min(0, box.width * (1 - scale))
  const minY = Math.min(0, box.height * (1 - scale))
  return {
    scale,
    x: Math.min(0, Math.max(minX, z.x)),
    y: Math.min(0, Math.max(minY, z.y)),
  }
}

/**
 * Scale to `next` while holding `anchor` (box coords) under the fingers.
 *
 * The algebra: a point `p` currently paints at `p·s + t`. After the change it
 * must still paint there, so `t' = a − (a − t)·(s'/s)`.
 */
export function zoomAt(
  prev: ZoomState,
  box: ZoomBox,
  anchor: { x: number; y: number },
  next: number,
): ZoomState {
  const scale = clampScale(next)
  const k = prev.scale > 0 ? scale / prev.scale : 1
  return clampPan(
    {
      scale,
      x: anchor.x - (anchor.x - prev.x) * k,
      y: anchor.y - (anchor.y - prev.y) * k,
    },
    box,
  )
}

/** Drag the zoomed frame. Clamped, so a pan can never expose a gutter. */
export function panBy(prev: ZoomState, box: ZoomBox, dx: number, dy: number): ZoomState {
  return clampPan({ scale: prev.scale, x: prev.x + dx, y: prev.y + dy }, box)
}

/**
 * Double tap: fit ↔ actual, about the tapped point. Zoomed AT ALL means the
 * tap zooms OUT — every browser does this, and the alternative (zoom further)
 * traps a human who double-tapped by accident at 4×.
 */
export function toggleZoom(
  prev: ZoomState,
  box: ZoomBox,
  point: { x: number; y: number },
): ZoomState {
  if (isZoomed(prev)) return NO_ZOOM
  return zoomAt(prev, box, point, DOUBLE_TAP_ZOOM)
}

/** The `transform` string. `translate` first, then `scale`, matching the
 *  algebra above — the other order is a different (wrong) transform. */
export function zoomTransform(z: ZoomState): string {
  if (!isZoomed(z) && z.x === 0 && z.y === 0) return 'none'
  return `translate(${z.x.toFixed(2)}px, ${z.y.toFixed(2)}px) scale(${z.scale.toFixed(4)})`
}

/** Distance between two fingers. */
export function pinchSpan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** …and the point to hold still while they move. */
export function pinchMid(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Where a pinch started: the state it started from, and the two fingers. */
export interface PinchStart {
  base: ZoomState
  span: number
  mid: { x: number; y: number }
}

/**
 * One frame of a live pinch: scale by the span ratio and pan by the midpoint's
 * own drift, so a two-finger gesture that also SLIDES pans while it zooms —
 * which is what fingers actually do, and leaving it out is why some pinch
 * implementations feel stuck.
 */
export function pinchTo(
  start: PinchStart,
  box: ZoomBox,
  a: { x: number; y: number },
  b: { x: number; y: number },
): ZoomState {
  const span = pinchSpan(a, b)
  if (!(start.span > 0) || !(span > 0)) return start.base
  const mid = pinchMid(a, b)
  const scaled = zoomAt(start.base, box, start.mid, start.base.scale * (span / start.span))
  return panBy(scaled, box, mid.x - start.mid.x, mid.y - start.mid.y)
}
