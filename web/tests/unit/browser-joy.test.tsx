/**
 * PHASE 4 — the joy layer, at the level each part actually lives at.
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything here is invisible in a screenshot and wrong in a way that is only
 * discovered by a thumb:
 *
 *   · an EDGE SWIPE whose threshold or fling rule is off navigates a page the
 *     human was scrolling past, or refuses to navigate one they flicked at —
 *     and both failures look identical in a still image;
 *   · a ZOOM whose pan bounds are wrong shows a grey gutter, and one whose
 *     anchor algebra is wrong drifts out from under the fingers doing it;
 *   · an UNDO STACK that keeps two entries for one id offers to open the same
 *     address twice, and one that never prunes offers a window that has closed;
 *   · a DROP INDEX that is off by one puts the chip one place from where it was
 *     let go, every single time, in one of the two directions;
 *   · a FIND that puts a frame on the wire for a server that cannot answer it
 *     spins forever, which is the exact failure this whole feature-check
 *     exists to prevent.
 *
 * So all five are pinned as arithmetic, plus the two surfaces whose honesty is
 * the point: the find bar's disabled state, and the undo bar's "Reopen".
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  EDGE_COMMIT_MIN_PX,
  EDGE_FLING_PX_PER_MS,
  EDGE_ZONE_PX,
  EdgeSwipe,
  commitDistance,
  edgeAt,
  rubberBand,
  shouldCommit,
} from '../../src/lib/browser/edge-swipe'
import {
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  NO_ZOOM,
  clampPan,
  clampScale,
  isZoomed,
  panBy,
  pinchTo,
  toggleZoom,
  zoomAt,
  zoomTransform,
} from '../../src/lib/browser/zoom'
import {
  UNDO_STACK_MAX,
  UNDO_WINDOW_MS,
  popClosed,
  pruneClosed,
  pushClosed,
  type ClosedTab,
} from '../../src/lib/browser/closed-tabs'
import {
  applyOrder,
  clampToPartition,
  dropIndex,
  moveItem,
} from '../../src/lib/browser/tab-order'
import {
  NO_CAPS,
  NO_FIND,
  findLabel,
  findPayload,
  parseCaps,
  parseFindResult,
} from '../../src/lib/browser/page-tools'
import {
  EMPTY_SNAPSHOT,
  TakeoverSocket,
  type SocketLike,
  type TakeoverSnapshot,
} from '../../src/lib/browser/takeover-socket'
import { FindBar } from '../../src/components/browser/find-bar'
import { UndoBar } from '../../src/components/browser/undo-bar'
import { BrowserMenu } from '../../src/components/browser/browser-menu'

/* ── the edge swipe ──────────────────────────────────────────────────────── */

const PHONE = 390

describe('the edge swipe — the #1 mobile gesture', () => {
  test('only the two edges arm it; the middle of the page is the page', () => {
    expect(edgeAt(4, PHONE)).toBe('left')
    expect(edgeAt(EDGE_ZONE_PX, PHONE)).toBe('left')
    expect(edgeAt(EDGE_ZONE_PX + 1, PHONE)).toBeNull()
    expect(edgeAt(PHONE - EDGE_ZONE_PX, PHONE)).toBe('right')
    expect(edgeAt(PHONE / 2, PHONE)).toBeNull()
    // A box with no width cannot have an edge — the first frame before layout.
    expect(edgeAt(0, 0)).toBeNull()
  })

  test('the commit distance has a FLOOR, so a 320px phone is not twitchy', () => {
    // 0.28 × 390 = 109, above the floor…
    expect(commitDistance(390)).toBeCloseTo(109.2, 1)
    // …but a narrow pane would commit at 56px without one.
    expect(commitDistance(200)).toBe(EDGE_COMMIT_MIN_PX)
  })

  test('the rubber band is 1:1 to the commit point, then damped, never runaway', () => {
    const limit = commitDistance(PHONE)
    expect(rubberBand(0, limit)).toBe(0)
    expect(rubberBand(50, limit)).toBe(50)
    expect(rubberBand(limit, limit)).toBe(limit)
    // Past it, resistance — and it asymptotes at 2× rather than hard-stopping.
    expect(rubberBand(limit * 2, limit)).toBeGreaterThan(limit)
    expect(rubberBand(limit * 2, limit)).toBeLessThan(limit * 1.6)
    expect(rubberBand(limit * 100, limit)).toBeLessThan(limit * 2)
  })

  test('commit is distance OR velocity — both halves are load-bearing', () => {
    const limit = commitDistance(PHONE)
    // Far enough, however slowly.
    expect(shouldCommit(limit, 0, PHONE)).toBe(true)
    expect(shouldCommit(limit - 1, 0, PHONE)).toBe(false)
    // Fast enough, having got somewhere: a flick is a decision.
    expect(shouldCommit(limit * 0.5, EDGE_FLING_PX_PER_MS, PHONE)).toBe(true)
    // …but a fast graze that went nowhere is a graze, not a decision.
    expect(shouldCommit(limit * 0.1, EDGE_FLING_PX_PER_MS * 4, PHONE)).toBe(false)
  })

  test('it refuses to start a peek it could not commit', () => {
    const g = new EdgeSwipe()
    // No history behind: a peek here would be an animation that lies.
    expect(g.begin(4, 300, 0, PHONE, { back: false, forward: true })).toBe(false)
    expect(g.active).toBe(false)
    expect(g.begin(4, 300, 0, PHONE, { back: true, forward: false })).toBe(true)
    expect(g.side).toBe('left')
    // The middle of the page is never a swipe.
    expect(g.begin(200, 300, 0, PHONE, { back: true, forward: true })).toBe(false)
  })

  test('a drag that goes DOWN the screen is a scroll, and the page keeps it', () => {
    const g = new EdgeSwipe()
    g.begin(6, 200, 0, PHONE, { back: true, forward: true })
    expect(g.move(8, 260, 60)).toBeNull()
    expect(g.active).toBe(false)
    expect(g.owns).toBe(false)
    // …and it stays dead even if the finger later goes sideways.
    expect(g.move(180, 262, 120)).toBeNull()
    expect(g.end()).toBeNull()
  })

  test('a slow drag past the threshold commits; one short of it does not', () => {
    const limit = commitDistance(PHONE)
    const g = new EdgeSwipe()
    g.begin(6, 300, 0, PHONE, { back: true, forward: true })
    // Slow enough that velocity plays no part (100px over 1.4s).
    let peek = g.move(6 + limit + 4, 300, 1_400)
    expect(peek?.edge).toBe('left')
    expect(peek?.armed).toBe(true)
    expect(peek?.progress).toBe(1)
    expect(g.owns).toBe(true)
    expect(g.end()).toEqual({ edge: 'left', commit: true })

    const h = new EdgeSwipe()
    h.begin(6, 300, 0, PHONE, { back: true, forward: true })
    peek = h.move(6 + limit - 20, 300, 1_400)
    expect(peek?.armed).toBe(false)
    expect(peek!.progress).toBeLessThan(1)
    expect(h.end()).toEqual({ edge: 'left', commit: false })
  })

  test('a FLICK commits well short of the threshold — that is the whole point', () => {
    const g = new EdgeSwipe()
    g.begin(384, 300, 0, PHONE, { back: true, forward: true })
    // Right edge → forward. 60px in 40ms = 1.5px/ms, a real flick.
    g.move(354, 300, 20)
    const peek = g.move(324, 300, 40)
    expect(peek?.edge).toBe('right')
    expect(peek!.progress).toBeLessThan(1)
    expect(peek?.armed).toBe(true)
    expect(g.end()).toEqual({ edge: 'right', commit: true })
  })

  test('the peek offset is the RUBBER-BANDED travel, not the raw finger', () => {
    const limit = commitDistance(PHONE)
    const g = new EdgeSwipe()
    g.begin(2, 300, 0, PHONE, { back: true, forward: true })
    const peek = g.move(2 + limit * 3, 300, 900)
    expect(peek!.offset).toBeLessThan(limit * 2)
    expect(peek!.offset).toBeGreaterThan(limit)
  })

  test('cancel forgets everything — a lost finger must not navigate later', () => {
    const g = new EdgeSwipe()
    g.begin(4, 300, 0, PHONE, { back: true, forward: true })
    g.move(140, 300, 200)
    g.cancel()
    expect(g.active).toBe(false)
    expect(g.end()).toBeNull()
  })
})

/* ── pinch and double-tap zoom ───────────────────────────────────────────── */

const BOX = { width: 390, height: 700 }

describe('the visual zoom — a magnifying glass, with edges that never leave', () => {
  test('scale is clamped at both ends, and garbage lands on the floor', () => {
    expect(clampScale(0.2)).toBe(1)
    expect(clampScale(99)).toBe(MAX_ZOOM)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(2.5)).toBe(2.5)
  })

  test('at scale 1 the pan is EXACTLY zero — a released pinch lands on the grid', () => {
    expect(clampPan({ scale: 1, x: -40, y: 12 }, BOX)).toEqual(NO_ZOOM)
    expect(isZoomed(NO_ZOOM)).toBe(false)
    // Floating-point dust from a pinch that ended at the floor is not "zoomed".
    expect(isZoomed({ scale: 1.005, x: 0, y: 0 })).toBe(false)
    expect(isZoomed({ scale: 1.5, x: 0, y: 0 })).toBe(true)
  })

  test('pan can never expose a gutter, in either direction', () => {
    const z = { scale: 2, x: 200, y: 300 }
    // Positive offsets would show blank on the left/top.
    expect(clampPan(z, BOX)).toEqual({ scale: 2, x: 0, y: 0 })
    // …and past the far edge would show blank on the right/bottom.
    const far = clampPan({ scale: 2, x: -9_999, y: -9_999 }, BOX)
    expect(far.x).toBe(-BOX.width)
    expect(far.y).toBe(-BOX.height)
  })

  test('zooming holds the ANCHOR under the fingers — the one line that matters', () => {
    const anchor = { x: 120, y: 260 }
    const next = zoomAt(NO_ZOOM, BOX, anchor, 2)
    // The point that was under the fingers still paints where it was.
    expect(anchor.x * next.scale + next.x).toBeCloseTo(anchor.x, 5)
    expect(anchor.y * next.scale + next.y).toBeCloseTo(anchor.y, 5)
  })

  test('double tap zooms IN about the tap, and OUT from anywhere', () => {
    const inn = toggleZoom(NO_ZOOM, BOX, { x: 200, y: 300 })
    expect(inn.scale).toBe(DOUBLE_TAP_ZOOM)
    // Zoomed at all → the tap zooms out, so a stray double tap at 4× is never
    // a trap.
    expect(toggleZoom(inn, BOX, { x: 10, y: 10 })).toEqual(NO_ZOOM)
    expect(toggleZoom({ scale: MAX_ZOOM, x: -50, y: -50 }, BOX, { x: 0, y: 0 })).toEqual(
      NO_ZOOM,
    )
  })

  test('a pinch that also SLIDES pans while it zooms', () => {
    const start = { base: NO_ZOOM, span: 100, mid: { x: 195, y: 350 } }
    // Fingers spread 2× AND the midpoint drifts 30px left.
    const out = pinchTo(start, BOX, { x: 65, y: 350 }, { x: 265, y: 350 })
    expect(out.scale).toBeCloseTo(2, 5)
    // Without the midpoint term this would be the pure-zoom offset; with it,
    // the content has moved too.
    const pure = zoomAt(NO_ZOOM, BOX, start.mid, 2)
    expect(out.x).not.toBeCloseTo(pure.x, 3)
  })

  test('a degenerate pinch (a finger landing on another) changes nothing', () => {
    const start = { base: { scale: 2, x: -10, y: -10 }, span: 0, mid: { x: 0, y: 0 } }
    expect(pinchTo(start, BOX, { x: 5, y: 5 }, { x: 5, y: 5 })).toEqual(start.base)
  })

  test('the transform is identity-free at rest, and translate-then-scale zoomed', () => {
    expect(zoomTransform(NO_ZOOM)).toBe('none')
    const t = zoomTransform({ scale: 2, x: -30, y: -40 })
    expect(t.indexOf('translate')).toBeLessThan(t.indexOf('scale'))
    expect(t).toContain('-30.00px')
    expect(t).toContain('scale(2.0000)')
  })

  test('panBy is clamped too — a pan is never a way around the bounds', () => {
    const z = { scale: 2, x: -100, y: -100 }
    expect(panBy(z, BOX, 500, 500)).toEqual({ scale: 2, x: 0, y: 0 })
  })
})

/* ── undo close ──────────────────────────────────────────────────────────── */

function closed(id: string, at = 0): ClosedTab {
  return { id, url: `https://${id}.example/`, title: id, pinned: false, index: 0, at }
}

describe('the closed-tab stack', () => {
  test('newest first, and one entry per id — never two doors to one address', () => {
    let stack = pushClosed([], closed('a'))
    stack = pushClosed(stack, closed('b'))
    expect(stack.map((t) => t.id)).toEqual(['b', 'a'])
    // Re-opened and re-closed: it moves to the top, it does not appear twice.
    stack = pushClosed(stack, closed('a', 5))
    expect(stack.map((t) => t.id)).toEqual(['a', 'b'])
  })

  test('it is a stack, not a history — capped', () => {
    let stack: ClosedTab[] = []
    for (let i = 0; i < UNDO_STACK_MAX + 6; i += 1) stack = pushClosed(stack, closed(`t${i}`))
    expect(stack.length).toBe(UNDO_STACK_MAX)
    expect(stack[0].id).toBe(`t${UNDO_STACK_MAX + 5}`)
  })

  test('popping an empty stack is null, not a throw — the shortcut always fires', () => {
    expect(popClosed([])).toBeNull()
    const taken = popClosed([closed('a'), closed('b')])
    expect(taken?.entry.id).toBe('a')
    expect(taken?.rest.map((t) => t.id)).toEqual(['b'])
  })

  test('the window expires, so a stale offer cannot outlive its promise', () => {
    const stack = [closed('fresh', 10_000), closed('old', 0)]
    const alive = pruneClosed(stack, 10_000 + UNDO_WINDOW_MS - 1)
    expect(alive.map((t) => t.id)).toEqual(['fresh'])
    expect(pruneClosed(stack, 1_000_000)).toEqual([])
  })
})

/* ── drag-reorder ────────────────────────────────────────────────────────── */

describe('the rail is rearrangeable, and the arithmetic is the whole feature', () => {
  test('moveItem is splice-safe in BOTH directions', () => {
    const l = ['a', 'b', 'c', 'd']
    expect(moveItem(l, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(l, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveItem(l, 1, 1)).toBe(l)
    // Out of range invents nothing.
    expect(moveItem(l, 9, 0)).toBe(l)
    expect(moveItem(l, 0, 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  test('the drop index counts the chips the pointer has passed, own chip excluded', () => {
    // Four 100px chips: centres at 50, 150, 250, 350.
    const centers = [50, 150, 250, 350]
    // Dragging the first one, still at home.
    expect(dropIndex(centers, 40, 0)).toBe(0)
    // Past the second chip's centre → it goes after it.
    expect(dropIndex(centers, 160, 0)).toBe(1)
    expect(dropIndex(centers, 260, 0)).toBe(2)
    // Dragging the LAST one leftwards. The index is in POST-REMOVAL space, so
    // "just past b's centre" is 2 in [a, b, c] — which lands it after b.
    expect(dropIndex(centers, 40, 3)).toBe(0)
    expect(dropIndex(centers, 160, 3)).toBe(2)
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 2)).toEqual(['a', 'b', 'd', 'c'])
    // Round-tripped through moveItem, a full drag left lands where it looks.
    expect(moveItem(['a', 'b', 'c', 'd'], 3, dropIndex(centers, 40, 3))).toEqual([
      'd',
      'a',
      'b',
      'c',
    ])
  })

  test('a drag never silently PINS a tab — the partition is clamped', () => {
    // [pinned, pinned, plain, plain] — dragging a plain chip into the pinned run.
    const pinned = [true, true, false, false]
    expect(clampToPartition(pinned, 2, 0)).toBe(2)
    expect(clampToPartition(pinned, 2, 3)).toBe(3)
    // …and a pinned chip cannot be dragged out of the pinned run either.
    expect(clampToPartition(pinned, 0, 3)).toBe(1)
    // The only chip of its kind has exactly one slot: pinned sorts first.
    expect(clampToPartition([true, false, false], 0, 2)).toBe(0)
    expect(clampToPartition([true, true, false], 2, 0)).toBe(2)
  })

  test('applying an order can never HIDE a tab — a preference is not a filter', () => {
    const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(applyOrder(tabs, ['c', 'a', 'b']).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    // A tab an agent opened after the drag: kept, at the end.
    expect(applyOrder(tabs, ['c', 'a']).map((t) => t.id)).toEqual(['c', 'a', 'b'])
    // An id in the order that no longer exists: dropped, silently and safely.
    expect(applyOrder(tabs, ['gone', 'b']).map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(applyOrder(tabs, [])).toBe(tabs)
  })
})

/* ── find and copy: the feature check IS the feature ─────────────────────── */

describe('find-in-page degrades to "cannot", never to "did not answer"', () => {
  test('a missing caps frame is NO, not maybe', () => {
    expect(parseCaps({})).toEqual(NO_CAPS)
    expect(parseCaps({ find: 'yes', copy: 1 })).toEqual(NO_CAPS)
    expect(parseCaps({ find: true, copy: false })).toEqual({
      find: true,
      copy: false,
      signIn: false,
    })
  })

  test('the wire shape is the SERVER spelling, so the day it lands nothing changes', () => {
    expect(findPayload('inbox')).toEqual({
      type: 'find',
      query: 'inbox',
      forward: true,
      case_sensitive: false,
    })
    expect(findPayload('x', { forward: false, caseSensitive: true })).toMatchObject({
      forward: false,
      case_sensitive: true,
    })
  })

  test('a find_result is parsed totally, and the index never exceeds the total', () => {
    expect(parseFindResult({})).toEqual(NO_FIND)
    expect(parseFindResult({ query: 'a', index: 99, total: 3 })).toEqual({
      query: 'a',
      index: 3,
      total: 3,
    })
    expect(parseFindResult({ query: 'a', index: -4, total: 'x' })).toEqual({
      query: 'a',
      index: 0,
      total: 0,
    })
  })

  test('the label never claims a search nobody ran', () => {
    // No query at all: nothing, not "0/0" — which would read as "no matches".
    expect(findLabel(NO_FIND, '', false)).toBe('')
    // Typed, unanswered: pending, not zero.
    expect(findLabel(NO_FIND, 'inbox', true)).toBe('…')
    // Answered for an OLDER query: still pending for this one.
    expect(findLabel({ query: 'inb', index: 1, total: 4 }, 'inbox', false)).toBe('…')
    expect(findLabel({ query: 'inbox', index: 0, total: 0 }, 'inbox', false)).toBe('No matches')
    expect(findLabel({ query: 'inbox', index: 2, total: 7 }, 'inbox', false)).toBe('2/7')
  })

})

/* ── the socket half of the feature check ────────────────────────────────── */

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
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type)
  }
}

function harness(onCopied?: (t: string) => void) {
  FakeSocket.open = []
  const snaps: TakeoverSnapshot[] = []
  const sock = new TakeoverSocket(
    { kind: 'tab', id: 'tb_one' },
    (s) => snaps.push(s),
    () => undefined,
    {
      factory: (url) => new FakeSocket(url),
      token: () => 'T0KEN',
      baseUrl: () => 'ws://box:8824',
      schedule: () => 1,
      cancel: () => undefined,
      onCopied,
    },
  )
  sock.start()
  const ws = FakeSocket.open[FakeSocket.open.length - 1]
  ws.accept()
  return { sock, ws, latest: () => snaps[snaps.length - 1] ?? EMPTY_SNAPSHOT }
}

describe('the DOM verbs fail CLOSED, and loudly in the UI rather than on the wire', () => {
  test('a fresh snapshot claims nothing', () => {
    expect(EMPTY_SNAPSHOT.caps).toEqual(NO_CAPS)
    expect(EMPTY_SNAPSHOT.find).toEqual(NO_FIND)
  })

  test('with no caps frame, NOTHING is sent — the bar has already said why', () => {
    const { sock, ws } = harness()
    expect(sock.find('inbox')).toBe(false)
    expect(sock.copySelection()).toBe(false)
    sock.findClose()
    expect(ws.types().filter((t) => t.startsWith('find') || t === 'copy')).toEqual([])
  })

  test('a caps frame turns them on, and the frames are the server spelling', () => {
    const { sock, ws, latest } = harness()
    ws.deliver({ type: 'caps', find: true, copy: true })
    expect(latest().caps).toEqual({ find: true, copy: true, signIn: false })
    expect(sock.find('inbox', { forward: false })).toBe(true)
    expect(sock.copySelection()).toBe(true)
    const sent = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
    expect(sent).toContainEqual({
      type: 'find',
      query: 'inbox',
      forward: false,
      case_sensitive: false,
    })
    expect(sent).toContainEqual({ type: 'copy' })
  })

  test('an empty query is never a search', () => {
    const { sock, ws } = harness()
    ws.deliver({ type: 'caps', find: true })
    expect(sock.find('')).toBe(false)
    expect(ws.types()).not.toContain('find')
  })

  test('a find_result lands on the snapshot; closing clears it', () => {
    const { sock, ws, latest } = harness()
    ws.deliver({ type: 'caps', find: true })
    ws.deliver({ type: 'find_result', query: 'inbox', index: 2, total: 7 })
    expect(latest().find).toEqual({ query: 'inbox', index: 2, total: 7 })
    sock.findClose()
    expect(latest().find).toEqual(NO_FIND)
    expect(ws.types()).toContain('find_close')
  })

  test('copied text is a CALLBACK, never parked in the snapshot', () => {
    const got: string[] = []
    const { ws, latest } = harness((t) => got.push(t))
    ws.deliver({ type: 'caps', copy: true })
    ws.deliver({ type: 'copied', text: 'account 1234' })
    expect(got).toEqual(['account 1234'])
    // A signed-in page's content must not sit in a React tree after the copy.
    expect(JSON.stringify(latest())).not.toContain('account 1234')
  })

  test('an unknown frame is still ignored — a newer server cannot break an older client', () => {
    const { ws, latest } = harness()
    ws.deliver({ type: 'something_new', payload: 1 })
    expect(latest().state).toBe('live')
  })
})

/* ── the two surfaces whose honesty is the point ─────────────────────────── */

describe('the find bar says what it cannot do', () => {
  const noop = () => undefined

  test('without caps the field is disabled and the placeholder is the reason', () => {
    const html = renderToStaticMarkup(
      <FindBar
        query=""
        onQuery={noop}
        result={NO_FIND}
        caps={NO_CAPS}
        onNext={noop}
        onPrev={noop}
        onClose={noop}
        onCopyUrl={noop}
        onCopySelection={noop}
      />,
    )
    expect(html).toContain('Find needs a server update')
    expect(html).toContain('disabled=""')
    // The copy-selection button is greyed with its own reason…
    expect(html).toContain('needs a server update')
    // …and "Copy link" is NOT, because the url is a fact the client holds.
    expect(html).toContain('aria-label="Copy link"')
    expect(html).not.toContain('data-find-supported')
  })

  test('with caps it is a find bar, with a live count', () => {
    const html = renderToStaticMarkup(
      <FindBar
        query="inbox"
        onQuery={noop}
        result={{ query: 'inbox', index: 2, total: 7 }}
        caps={{ find: true, copy: true, signIn: false }}
        onNext={noop}
        onPrev={noop}
        onClose={noop}
        onCopyUrl={noop}
        onCopySelection={noop}
      />,
    )
    expect(html).toContain('data-find-supported')
    expect(html).toContain('2/7')
    expect(html).toContain('placeholder="Find in page"')
  })

  test('the field is ≥16px, or iOS zooms the whole shell', () => {
    const html = renderToStaticMarkup(
      <FindBar
        query=""
        onQuery={noop}
        result={NO_FIND}
        caps={{ find: true, copy: false, signIn: false }}
        onNext={noop}
        onPrev={noop}
        onClose={noop}
        onCopyUrl={noop}
        onCopySelection={noop}
      />,
    )
    expect(html).toContain('text-[16px]')
  })
})

describe('the undo bar promises exactly what it can deliver', () => {
  test('nothing closed, nothing drawn', () => {
    expect(
      renderToStaticMarkup(<UndoBar entry={null} onUndo={() => {}} onDismiss={() => {}} />),
    ).toBe('')
  })

  test('it says REOPEN — a new row at the same address, not a restored one', () => {
    const html = renderToStaticMarkup(
      <UndoBar
        entry={{
          id: 'tb_x',
          url: 'https://mail.acme.example/inbox',
          title: 'Inbox — Acme Mail',
          pinned: false,
          index: 0,
          at: 0,
        }}
        onUndo={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(html).toContain('Reopen')
    expect(html).not.toContain('Restore')
    expect(html).toContain('Inbox — Acme Mail')
    // The window is drawn from the ONE constant that also dismisses it.
    expect(html).toContain(`${UNDO_WINDOW_MS}ms`)
    // Thumb-reachable, above the safe area.
    expect(html).toContain('safe-area-inset-bottom')
    expect(html).toContain('min-h-11')
  })
})

describe('the context menu', () => {
  test('a disabled verb is greyed WITH ITS REASON, never hidden', () => {
    const html = renderToStaticMarkup(
      <BrowserMenu
        at={{ x: 10, y: 10 }}
        label="Page menu"
        fixed
        onSelect={() => {}}
        onClose={() => {}}
        items={[
          { id: 'back', label: 'Back' },
          {
            id: 'copy-selection',
            label: 'Copy selection',
            disabled: true,
            hint: 'Reading the page selection needs a server update',
          },
        ]}
      />,
    )
    expect(html).toContain('Copy selection')
    expect(html).toContain('needs a server update')
    expect(html).toContain('disabled=""')
    expect(html).toContain('role="menu"')
    // Every row is a 44px target — this is the same menu a long-press opens.
    expect(html).toContain('min-h-11')
  })
})
