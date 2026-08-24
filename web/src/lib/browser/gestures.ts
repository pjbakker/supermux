/**
 * One finger on a relayed page — the gesture recogniser.
 * ─────────────────────────────────────────────────────────────────────────────
 * The server has spoken touch since phase 0 (`takeover.rs`'s `TouchKind` →
 * `Input.dispatchTouchEvent`); the web client only ever sent MOUSE, which is
 * why a phone could look at a page and never scroll it. This is the missing
 * half, kept pure so the arithmetic that decides "was that a tap or a scroll"
 * is testable without a touchscreen.
 *
 * WHY A TAP IS NOT A TOUCH SEQUENCE. Chrome turns a dispatched
 * touchStart/touchEnd pair into a synthesised click of its own — that is how
 * every CDP driver taps. So a recogniser that emitted the touch sequence AND a
 * mouse down/up would click twice on every tap, and every checkbox would land
 * back where it started. The two paths are therefore EXCLUSIVE:
 *
 *   · finger moves past [[TAP_SLOP_PX]] → a SCROLL. The buffered start is
 *     flushed as `touchStart` and the drag continues as `touchMove`s, so the
 *     page's own touch handlers (carousels, maps, canvas apps) see a real
 *     gesture and chrome's compositor gives fling/momentum for free.
 *   · finger lifts under the slop and under [[TAP_MS]] → a TAP, sent as
 *     `mouse down` + `mouse up` (a real click at a real point, with
 *     `clickCount: 2` when it is the second of a double tap).
 *
 * The cost of buffering the start is nothing a thumb can feel: the decision is
 * made by the first move past 8 px, which is the same threshold every native
 * scroller uses.
 */

import type { Point } from './frame-map'

/** Past this much movement the gesture is a scroll, not a tap. The native
 *  touch-slop on both platforms, and the audit's number. */
export const TAP_SLOP_PX = 8

/** A press held longer than this is not a tap — it is a long press (whose
 *  context menu is a later phase) or a stalled drag. Either way, clicking on
 *  release would be a click the human did not ask for. */
export const TAP_MS = 400

/** Second tap inside this window, and this close, is a double tap. */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_SLOP_PX = 24

/** What the recogniser wants relayed. `touch` goes out as `ClientMsg::Touch`,
 *  `tap` as a `mouse down`/`mouse up` pair — see the module note on why never
 *  both. */
export type GestureAction =
  | { kind: 'touch'; phase: 'start' | 'move' | 'end' | 'cancel'; point: Point }
  | { kind: 'tap'; point: Point; clickCount: number }

function far(a: Point, b: Point, limit: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) > limit
}

/**
 * `clickCount` — the difference between two clicks and a double click, and the
 * only way a page ever selects a word or opens a row.
 *
 * The client has to count them itself for BOTH input kinds. A touch has no
 * native notion of a double tap at all, and a `PointerEvent`'s `detail` is 0 in
 * chrome (it is a `MouseEvent` field), so the pointer path that looked like it
 * was reading the browser's own count was quietly sending 1 forever.
 */
export class ClickCounter {
  private last: { point: Point; at: number; count: number } | null = null

  next(point: Point, at: number): number {
    const prev = this.last
    let count = 1
    if (prev && at - prev.at <= DOUBLE_TAP_MS && !far(prev.point, point, DOUBLE_TAP_SLOP_PX)) {
      // A triple click is a real thing (select the paragraph); CDP caps at 3.
      count = Math.min(prev.count + 1, 3)
    }
    this.last = { point, at, count }
    return count
  }
}

/**
 * One finger, in PAGE coordinates (the caller has already mapped through
 * `frame-map`). Feed it `begin`/`move`/`end`/`cancel` and relay what it hands
 * back; it holds no DOM and no socket, which is the whole point.
 */
export class TouchGesture {
  private origin: Point | null = null
  private originAt = 0
  private last: Point | null = null
  private scrolling = false
  private taps = new ClickCounter()

  /** True once the finger has committed to a scroll — the caller uses it to
   *  keep `preventDefault` honest. */
  get isScrolling(): boolean {
    return this.scrolling
  }

  /** True while a finger is down, whatever it has decided to be. */
  get isDown(): boolean {
    return this.origin !== null
  }

  begin(point: Point, at: number): GestureAction[] {
    this.origin = point
    this.originAt = at
    this.last = point
    this.scrolling = false
    // Nothing goes out yet: see the module note. The start is buffered until
    // the finger says which of the two gestures this is.
    return []
  }

  move(point: Point, at: number): GestureAction[] {
    const origin = this.origin
    if (!origin) return []
    this.last = point
    if (this.scrolling) return [{ kind: 'touch', phase: 'move', point }]
    // Still inside the slop, or still inside the tap window with no movement:
    // undecided, so nothing is relayed and the page sees no half-gesture.
    if (!far(origin, point, TAP_SLOP_PX) && at - this.originAt <= TAP_MS) return []
    this.scrolling = true
    // Flush the buffered start FIRST — a `touchMove` with no `touchStart` is a
    // protocol error, not a scroll.
    return [
      { kind: 'touch', phase: 'start', point: origin },
      { kind: 'touch', phase: 'move', point },
    ]
  }

  end(point: Point | null, at: number): GestureAction[] {
    const origin = this.origin
    if (!origin) return []
    const where = point ?? this.last ?? origin
    const scrolling = this.scrolling
    this.reset()
    if (scrolling) return [{ kind: 'touch', phase: 'end', point: where }]
    // A press that never moved but sat there is not a tap (see TAP_MS): the
    // finger is gone and nothing is sent, which is honest — the page was never
    // told a finger arrived.
    if (at - this.originAt > TAP_MS) return []
    return [{ kind: 'tap', point: where, clickCount: this.taps.next(where, at) }]
  }

  /** The OS took the finger (a system gesture, a call, a scroll handoff). */
  cancel(): GestureAction[] {
    const scrolling = this.scrolling
    const where = this.last
    this.reset()
    // Only a gesture the page was TOLD about needs cancelling.
    return scrolling && where ? [{ kind: 'touch', phase: 'cancel', point: where }] : []
  }

  private reset(): void {
    this.origin = null
    this.last = null
    this.scrolling = false
  }
}
