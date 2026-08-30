/**
 * THE EDGE SWIPE — the #1 gesture on a mobile browser, and the one thing a
 * relayed page can never give you for free.
 * ─────────────────────────────────────────────────────────────────────────────
 * A real browser's back-swipe is the platform's: iOS renders the previous page
 * under your thumb and slides it in. We have a JPEG of ONE page and a `back`
 * frame on a socket, so the honest version is different in exactly one way and
 * identical in every other:
 *
 *   · the PEEK is ours (a rubber-banded parallax of the frame we have, plus the
 *     chevron that says which way this is going), because we do not have the
 *     previous page's pixels and inventing them would be a lie;
 *   · the COMMIT is the platform's rule, to the number — distance OR velocity,
 *     because a flick is a decision and a slow drag past the middle is also a
 *     decision, and a gesture that only honours one of the two feels broken in
 *     a way nobody can name.
 *
 * PURE ON PURPOSE. Every number below is decided by arithmetic, not by a
 * touchscreen, so the threshold and the fling are testable without one — the
 * same split `gestures.ts` already makes for tap-vs-scroll.
 *
 * WHY IT LIVES BESIDE `TouchGesture` AND NOT INSIDE IT. The two recognise
 * DIFFERENT things from the same finger and only one may win: an edge swipe is
 * chrome (it never reaches the page), a scroll is content (it always does). The
 * panel asks this one first, and only when it declines does the page see the
 * finger at all — which is why `begin` returns a boolean and why it refuses
 * outright when there is no history to go back to. A peek that cannot commit is
 * an animation that lies.
 */

/** How close to the edge the finger has to START. 28px is Safari's zone and
 *  about a thumb's width; wider and every drag near the margin arms it. */
export const EDGE_ZONE_PX = 28

/** Travel needed to commit, as a fraction of the viewport width… */
export const EDGE_COMMIT_FRACTION = 0.28
/** …with a floor, so a 320px phone does not commit at 90px of drag AND a
 *  future 240px pane does not commit at 67. */
export const EDGE_COMMIT_MIN_PX = 64

/** A flick this fast commits early — px per ms, i.e. 500px/s. */
export const EDGE_FLING_PX_PER_MS = 0.5
/** …but never from nothing: a fling still has to have gone somewhere, or a
 *  fast graze at the edge navigates a page the human was only scrolling past. */
export const EDGE_FLING_MIN_FRACTION = 0.35

/** Past this much movement the direction question is settled. Same 8px as the
 *  tap slop next door, and the same reason: it is what every native scroller
 *  uses. */
export const EDGE_SLOP_PX = 8

export type SwipeEdge = 'left' | 'right'

/** Which edge a finger landed on, or `null` for the middle of the page. */
export function edgeAt(x: number, width: number): SwipeEdge | null {
  if (!(width > 0)) return null
  if (x <= EDGE_ZONE_PX) return 'left'
  if (x >= width - EDGE_ZONE_PX) return 'right'
  return null
}

/** The travel that commits, for this box. */
export function commitDistance(width: number): number {
  return Math.max(EDGE_COMMIT_MIN_PX, width * EDGE_COMMIT_FRACTION)
}

/**
 * iOS resistance: 1:1 with the finger up to the commit point, then damped so
 * the peek can never run away with the screen. Asymptotes at `2 × limit`,
 * which is what makes "I have dragged as far as this goes" legible without a
 * hard stop that reads as a bug.
 */
export function rubberBand(travel: number, limit: number): number {
  if (!(limit > 0)) return 0
  if (travel <= 0) return 0
  if (travel <= limit) return travel
  const over = travel - limit
  return limit + over / (1 + over / limit)
}

/**
 * The commit rule, alone and testable: far enough, OR fast enough having got
 * somewhere. Both halves are load-bearing — see the module note.
 */
export function shouldCommit(travel: number, velocity: number, width: number): boolean {
  const limit = commitDistance(width)
  if (travel >= limit) return true
  return velocity >= EDGE_FLING_PX_PER_MS && travel >= limit * EDGE_FLING_MIN_FRACTION
}

/** What the overlay paints this frame. */
export interface EdgePeek {
  edge: SwipeEdge
  /** Rubber-banded pixels — what the frame parallaxes by. */
  offset: number
  /** 0…1, saturating at the commit point: the chevron's opacity and scale, and
   *  the difference between "I am dragging" and "let go and it goes". */
  progress: number
  /** Release right now and it commits. Drives the haptic and the accent. */
  armed: boolean
}

/** What history says a swipe is allowed to do. A peek that cannot commit is an
 *  animation that lies, so the recogniser refuses to start one. */
export interface EdgeAllow {
  back: boolean
  forward: boolean
}

/**
 * One finger, from the edge. Feed it the same client-space points the touch
 * recogniser gets; it holds no DOM and no socket.
 */
export class EdgeSwipe {
  private edge: SwipeEdge | null = null
  private ox = 0
  private oy = 0
  private width = 0
  private travel = 0
  private velocity = 0
  private lastTravel = 0
  private lastAt = 0
  private locked = false
  private dead = false

  /** A swipe is being tracked AND has not been ruled out as a vertical scroll. */
  get active(): boolean {
    return this.edge !== null && !this.dead
  }

  /** True once the gesture has committed to being a swipe — past this the page
   *  must not also see the finger. */
  get owns(): boolean {
    return this.active && this.locked
  }

  get side(): SwipeEdge | null {
    return this.edge
  }

  /**
   * Arm at the edge. `false` = not our gesture (middle of the page, or no
   * history that way), and the caller relays the finger to the page instead.
   */
  begin(x: number, y: number, at: number, width: number, allow: EdgeAllow): boolean {
    this.reset()
    const edge = edgeAt(x, width)
    if (!edge) return false
    if (edge === 'left' ? !allow.back : !allow.forward) return false
    this.edge = edge
    this.ox = x
    this.oy = y
    this.width = width
    this.lastAt = at
    return true
  }

  /**
   * `null` = nothing to paint yet (still inside the slop), or the gesture has
   * been ruled out. A vertical drag that started at the edge is a SCROLL, and
   * ruling it out is what keeps the page scrollable along its own margin.
   */
  move(x: number, y: number, at: number): EdgePeek | null {
    if (!this.edge || this.dead) return null
    const dx = this.edge === 'left' ? x - this.ox : this.ox - x
    const dy = y - this.oy
    if (!this.locked) {
      // The direction question, asked once. A finger that went further down
      // than sideways is scrolling; one that went sideways owns the gesture.
      if (Math.abs(dy) > EDGE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
        this.dead = true
        return null
      }
      if (dx < EDGE_SLOP_PX) return null
      this.locked = true
    }
    // Dragging BACK towards the edge is allowed (that is how a peek is
    // cancelled), but never past it into a negative offset.
    const travel = Math.max(0, dx)
    const dt = at - this.lastAt
    if (dt > 0) {
      // Smoothed, because a single 4ms sample off a jittery digitiser is noise
      // and this number decides a navigation.
      const instant = (travel - this.lastTravel) / dt
      this.velocity = this.velocity === 0 ? instant : this.velocity * 0.4 + instant * 0.6
      this.lastTravel = travel
      this.lastAt = at
    }
    this.travel = travel
    const limit = commitDistance(this.width)
    return {
      edge: this.edge,
      offset: rubberBand(travel, limit),
      progress: Math.min(1, travel / limit),
      armed: shouldCommit(travel, this.velocity, this.width),
    }
  }

  /** Lift. `null` = there was never a swipe here; otherwise the verdict. */
  end(): { edge: SwipeEdge; commit: boolean } | null {
    const edge = this.edge
    const owned = this.locked && !this.dead
    const verdict = owned && edge ? shouldCommit(this.travel, this.velocity, this.width) : false
    this.reset()
    if (!edge || !owned) return null
    return { edge, commit: verdict }
  }

  /** The OS took the finger, or a second one arrived (a pinch is not a swipe). */
  cancel(): void {
    this.reset()
  }

  private reset(): void {
    this.edge = null
    this.travel = 0
    this.velocity = 0
    this.lastTravel = 0
    this.lastAt = 0
    this.locked = false
    this.dead = false
  }
}
