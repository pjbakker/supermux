// The tab strip — the workspace's spine, and the one thing that must not break
// a phone.
//
// THE RAIL IS THE ONLY OVERFLOW CONTAINER ON THE PAGE. Everything inside it is
// `min-w-0` and every chip is a fixed `clamp(112px, 38vw, 168px)` wide, so a
// 200-character page title ellipsises inside its chip instead of pushing the
// document sideways. The app's standing rule is that the body NEVER scrolls
// horizontally; at 390px this is the surface that would break it first, so the
// widths here are deliberate rather than incidental:
//
//   · ~2.6 chips visible at 390px — enough that the rail READS as scrollable
//     without needing a scrollbar (which is hidden: `scrollbar-width:none`).
//   · `overscroll-behavior-x: contain` so flicking the rail past its end does
//     not turn into a browser back-swipe.
//   · `scroll-snap-type: x proximity` — proximity, not mandatory: a mandatory
//     snap fights a human who is scanning eight tabs at speed.
//   · `padding-inline: max(12px, env(safe-area-inset-*))` so the first and last
//     chip clear a notch in landscape.
//   · the `+` is the LAST CELL IN THE RAIL, never a floating overlay — a
//     floating + covers the right-most chip exactly when the rail is scrolled
//     to the end, which is exactly when you can least afford it.
//
// TOUCH TARGETS. The chip is 44px tall. The close affordance is touch-visible
// on the ACTIVE chip only (a 24px target beside a 112px chip is a mis-tap
// generator otherwise) and hover-visible on EVERY chip where a real pointer
// exists — `@media (hover:hover)`, so a phone never inherits the desktop rule.
// It carries an invisible `::after` that expands its hit box to 44×44 without
// changing the layout.
//
// PIN IS NOT LONG-PRESS-ONLY. Long-press opens the tab sheet, where the pin
// lives as an explicit control — discoverability over cleverness. The chip's
// pinned tell is a ring, not a hidden gesture.
//
// ── PHASE 3: THESE ARE TABS NOW, NOT ROWS ────────────────────────────────────
//
// FAVICON. Leading, 16px, with the status dot as a corner badge ON it rather
// than a separate circle stealing 14px of a 112px chip. The source is the
// nav-state feed (`favicon`, a `data:` URI the server read INSIDE the page,
// where the cookies are — the web client must never fetch `/favicon.ico`
// itself: the browser profile is the thing that is logged in, not this page).
// Only the ACTIVE tab has a socket, so the others are served from a memo keyed
// by ORIGIN, and anything with no icon at all gets a hashed letter tile — never
// a blank square, and never another site's icon.
//
// TITLE. `title || prettyHost(url)`. The raw full URL this replaces was the
// worst of both worlds in a 112px chip: unreadable AND uninformative.
//
// SPINNER. The favicon cross-fades to a spinner while that tab is loading. It
// is the same 16px cell, so a load does not reflow the chip.
//
// PINNED = FAVICON-ONLY (`w-11`), which is what pinning is FOR, and it also
// stops a sticky pinned chip eating a third of a 390px rail.
//
// ── PHASE 4: THE RAIL YOU CAN REARRANGE, AND THE CHIPS THAT MOVE ─────────────
//
// DRAG-REORDER, WITH TWO DIFFERENT ENTRY GESTURES, because the two pointers
// mean different things:
//
//   · a MOUSE has no ambiguity — press and move 8px is a drag, full stop;
//   · a FINGER on a horizontally-scrolling rail does. So touch arms on a
//     350ms hold (with a haptic), and then the same finger either MOVES (drag)
//     or LIFTS (the context menu). That is the iOS rule, and it is the only one
//     that leaves the rail scrollable — an immediate touch-drag would eat every
//     flick across eight tabs.
//
// THE ORDER IS SESSION-ONLY AND SAID SO. There is no `position` column on
// `browser_tabs`; persisting one is a migration, and migrations are the one
// thing in this repo that cannot be taken back. The workspace holds the order
// in state and `lib/browser/tab-order.ts` applies it — see that file's header
// for the exact server field this wants.
//
// PINNED IS A PARTITION, NOT A SORT KEY. A drag is clamped inside its own
// pinned/unpinned run, so dragging never silently pins a tab: pinning stays the
// explicit control it already is, in the sheet.
//
// A CLOSING CHIP COLLAPSES ITS WIDTH rather than vanishing (`.sm-browser-chip-
// out`, 150ms), and `onClose` fires on `animationend` — so the rail closes the
// gap instead of teleporting every chip to its right. Under Reduce Motion that
// animation is 0.01ms, which fires on the same tick: the close is never
// DELAYED by a preference, only un-animated.

import * as React from 'react'

import { Loader2, Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { tabState, type BrowserTab, type TabTone } from '@/lib/api/browser'
import { faviconTile, originOf, prettyHost } from '@/lib/browser/nav-state'
import { clampToPartition, dropIndex, moveItem } from '@/lib/browser/tab-order'

/** Colour is the ONLY thing the dot carries; the words are on the chip's title
 *  and in the sheet. Amber is never "probably fine" — it means sign-in needed. */
const DOT: Record<TabTone, string> = {
  ok: 'bg-emerald-500',
  'needs-login': 'bg-amber-500',
  dehydrated: 'bg-slate-400',
  unknown: 'bg-slate-400',
}

/** The live nav state of the ONE tab a socket is attached to. The other chips
 *  render from their row, which the server now writes url/title through to — so
 *  they are minutes-fresh rather than stale-forever, and honestly so. */
export interface LiveTabNav {
  tabId: string
  title: string
  favicon: string | null
  loading: boolean
}

export interface TabStripProps {
  tabs: BrowserTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** The per-tab sheet (pin, grants, state). Reached from the context menu's
   *  last row when one is wired, and directly when it is not. */
  onMenu: (id: string) => void
  /** PHASE 4 — right-click / long-press-and-lift → the context menu, AT A
   *  POINT. Absent = the long-press opens the sheet directly, which is what
   *  phases 1-3 did and what the in-chat card still wants. */
  onContext?: (id: string, at: { x: number; y: number }) => void
  /** PHASE 4 — a drag finished; the ids in their new order. Client-only for
   *  v1 (see the header). Absent = the rail is not draggable at all. */
  onReorder?: (order: string[]) => void
  onNew: () => void
  /** The active tab's live title / favicon / spinner. */
  live?: LiveTabNav | null
  /** origin → `data:` favicon, remembered from every tab we have attached to.
   *  Keyed by ORIGIN and not by tab id on purpose: the icon is a fact about a
   *  SITE, so a tab that navigated away simply misses the memo and falls back
   *  to its tile instead of wearing the previous site's face. */
  favicons?: Record<string, string>
  className?: string
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onMenu,
  onContext,
  onReorder,
  onNew,
  live,
  favicons,
  className,
}: TabStripProps) {
  const railRef = React.useRef<HTMLDivElement | null>(null)

  // Centre the active chip when it changes. `block:'nearest'` matters: without
  // it the browser scrolls the PAGE to bring the rail into view, which on a
  // phone yanks the viewport out from under the human's thumb.
  React.useEffect(() => {
    if (!activeId) return
    const rail = railRef.current
    const chip = rail?.querySelector<HTMLElement>(`[data-tab-chip="${CSS.escape(activeId)}"]`)
    if (!chip) return
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    chip.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    })
  }, [activeId])

  // ── the closing chip ───────────────────────────────────────────────────────
  // Held mounted for the 150ms its width takes to collapse; `onClose` fires on
  // `animationend`, so the row leaves the list exactly when the gap is closed
  // rather than 150ms before it.
  const [closing, setClosing] = React.useState<string | null>(null)
  // DERIVED, not synced. The tab can go away for a reason that was not us
  // (another session closed it, a poll dropped it), and then there is nothing
  // left to animate out — but reconciling that in an effect would be a second
  // render for a fact this one already knows.
  const closingNow = closing && tabs.some((t) => t.id === closing) ? closing : null

  // A chip springs in ON MOUNT and only on mount: React keys the chips by tab
  // id, so a new tab is a new element and a CSS `animation` runs itself. No
  // bookkeeping, no ref, and nothing to get wrong — the first paint animates
  // the whole rail at once, which reads as the rail arriving rather than as a
  // cascade, because every chip runs the same 260ms in the same frame.

  // ── drag-reorder ───────────────────────────────────────────────────────────
  const [drag, setDrag] = React.useState<{
    id: string
    from: number
    to: number
    dx: number
    /** Chip width + the rail's gap — how far every chip the drag passes has to
     *  move. In STATE and not in the ref below because `shiftFor` reads it
     *  during render, and a ref read there is a value the render cannot see
     *  change. */
    step: number
  } | null>(null)
  /** Measured once per drag: the chips' centres and widths do not change while
   *  one is in the air (the others only TRANSFORM), and re-measuring per move
   *  would read back a layout we are animating. */
  const metrics = React.useRef<{ centers: number[] } | null>(null)
  const dragOrigin = React.useRef<number>(0)

  const beginDrag = (id: string, clientX: number) => {
    if (!onReorder) return
    const rail = railRef.current
    if (!rail) return
    const from = tabs.findIndex((t) => t.id === id)
    if (from < 0) return
    const chips = Array.from(rail.querySelectorAll<HTMLElement>('[data-tab-chip]'))
    const rects = chips.map((el) => el.getBoundingClientRect())
    if (rects.length !== tabs.length) return
    const mine = rects[from]
    metrics.current = { centers: rects.map((r) => r.left + r.width / 2) }
    dragOrigin.current = clientX
    // The rail's 6px gap, so the chip lands exactly where the gap opened.
    setDrag({ id, from, to: from, dx: 0, step: mine.width + 6 })
  }

  const moveDrag = (clientX: number) => {
    const m = metrics.current
    setDrag((cur) => {
      if (!cur || !m) return cur
      const dx = clientX - dragOrigin.current
      const to = clampToPartition(
        tabs.map((t) => !!t.pinned),
        cur.from,
        dropIndex(m.centers, m.centers[cur.from] + dx, cur.from),
      )
      return { ...cur, dx, to }
    })
  }

  const endDrag = (commit: boolean) => {
    setDrag((cur) => {
      if (cur && commit && cur.to !== cur.from && onReorder) {
        onReorder(moveItem(tabs, cur.from, cur.to).map((t) => t.id))
      }
      return null
    })
    metrics.current = null
  }

  /** How far a chip that is NOT the dragged one has to slide for the gap to be
   *  where the finger is. Derived, never stored: the list is the truth and this
   *  is a view of it. */
  const shiftFor = (index: number): number => {
    if (!drag || index === drag.from) return 0
    const { from, to, step } = drag
    if (to >= from && index > from && index <= to) return -step
    if (to < from && index >= to && index < from) return step
    return 0
  }

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label="Browser tabs"
      data-tab-rail=""
      data-tab-dragging={drag ? drag.id : undefined}
      style={{
        // The shell drops its MobileTopBar, so this rail is the browser
        // workspace's top chrome and owns the iOS-PWA status-bar inset (same
        // reason the grok roster header does): reserve it on top so the tab chips
        // clear the notch. `max()` no-ops at env=0, so desktop and the browser
        // tab keep the original 0.5rem the `pb-2`/floor supplies. The L/R insets
        // are already handled below.
        paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
        paddingInlineStart: 'max(12px, env(safe-area-inset-left))',
        paddingInlineEnd: 'max(12px, env(safe-area-inset-right))',
      }}
      className={cn(
        'flex shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-border bg-card pb-2',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        '[-webkit-overflow-scrolling:touch] [overscroll-behavior-x:contain] [scroll-snap-type:x_proximity]',
        // A drag must not also scroll the rail out from under itself.
        drag && 'touch-none select-none [scroll-snap-type:none]',
        className,
      )}
    >
      {tabs.map((tab, index) => (
        <TabChip
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          live={live && live.tabId === tab.id ? live : null}
          favicon={favicons?.[originOf(tab.url) ?? ''] ?? null}
          closing={closingNow === tab.id}
          dragging={drag?.id === tab.id}
          dragDx={drag?.id === tab.id ? drag.dx : shiftFor(index)}
          reorderable={!!onReorder}
          onSelect={() => onSelect(tab.id)}
          onClose={() => setClosing(tab.id)}
          onClosed={() => {
            setClosing((cur) => (cur === tab.id ? null : cur))
            onClose(tab.id)
          }}
          onMenu={(at) => (onContext ? onContext(tab.id, at) : onMenu(tab.id))}
          onDragStart={(x) => beginDrag(tab.id, x)}
          onDragMove={moveDrag}
          onDragEnd={endDrag}
        />
      ))}
      <button
        type="button"
        onClick={onNew}
        aria-label="New tab"
        data-tab-new=""
        className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  )
}

/**
 * ONE CHIP, THREE GESTURES, AND THE ORDER THEY RESOLVE IN.
 *
 * A mouse and a finger want different things from the same 112px box, so the
 * chip runs one pointer state machine rather than two handler sets:
 *
 *   · MOUSE — down, then 8px of movement, is a drag. Right-click is the menu.
 *     No hold, because a mouse has no ambiguity to resolve.
 *   · TOUCH — a 350ms hold ARMS the chip (and buzzes). Move after that and it
 *     is a drag; lift without moving and it is the menu. Before the hold, the
 *     finger belongs to the RAIL, which is horizontally scrollable — an
 *     immediate touch-drag would eat every flick across eight tabs.
 *   · Either pointer, short and still: select.
 *
 * `pointercancel` is the rail winning the scroll, and it must reset everything
 * — a chip left armed after a flick would drag on the human's next tap.
 */
function TabChip({
  tab,
  active,
  live,
  favicon,
  closing,
  dragging,
  dragDx,
  reorderable,
  onSelect,
  onClose,
  onClosed,
  onMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  tab: BrowserTab
  active: boolean
  live: LiveTabNav | null
  favicon: string | null
  closing: boolean
  dragging: boolean
  dragDx: number
  reorderable: boolean
  onSelect: () => void
  onClose: () => void
  onClosed: () => void
  onMenu: (at: { x: number; y: number }) => void
  onDragStart: (clientX: number) => void
  onDragMove: (clientX: number) => void
  onDragEnd: (commit: boolean) => void
}) {
  const state = tabState(tab)
  const title = (live?.title || tab.title || prettyHost(tab.url)).trim()
  const icon = live?.favicon ?? favicon
  const loading = !!live?.loading

  const press = React.useRef<{
    x: number
    y: number
    touch: boolean
    armed: boolean
    dragging: boolean
    moved: boolean
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const clearPress = () => {
    const p = press.current
    if (p?.timer) clearTimeout(p.timer)
    press.current = null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return
    const touch = e.pointerType === 'touch'
    const p = {
      x: e.clientX,
      y: e.clientY,
      touch,
      armed: !touch,
      dragging: false,
      moved: false,
      timer: null as ReturnType<typeof setTimeout> | null,
    }
    press.current = p
    if (!touch) return
    p.timer = setTimeout(() => {
      const cur = press.current
      if (!cur || cur.moved) return
      cur.armed = true
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(8)
    }, 350)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current
    if (!p) return
    if (p.dragging) {
      onDragMove(e.clientX)
      return
    }
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (Math.hypot(dx, dy) <= 8) return
    p.moved = true
    // Not armed yet: the finger belongs to the rail's own scroll. Stand down
    // rather than compete with it.
    if (!p.armed || !reorderable) {
      if (p.touch) clearPress()
      return
    }
    // A mouse only drags SIDEWAYS out of a horizontal rail; a vertical drag off
    // a chip is somebody selecting, not reordering.
    if (!p.touch && Math.abs(dy) > Math.abs(dx)) return
    p.dragging = true
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    onDragStart(p.x)
    onDragMove(e.clientX)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current
    clearPress()
    if (!p) return
    if (p.dragging) {
      onDragEnd(true)
      return
    }
    // Armed by a hold and never moved: the menu, at the finger.
    if (p.touch && p.armed && !p.moved) {
      onMenu({ x: e.clientX, y: e.clientY })
      return
    }
    if (!p.moved) onSelect()
  }

  const onPointerCancel = () => {
    const p = press.current
    clearPress()
    if (p?.dragging) onDragEnd(false)
  }

  return (
    <div
      data-tab-chip={tab.id}
      data-tab-tone={state.tone}
      data-tab-pinned={tab.pinned ? '' : undefined}
      data-tab-loading={loading ? '' : undefined}
      data-tab-dragging={dragging ? '' : undefined}
      role="tab"
      aria-selected={active}
      aria-grabbed={dragging || undefined}
      tabIndex={0}
      title={`${title} — ${state.detail}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        clearPress()
        onMenu({ x: e.clientX, y: e.clientY })
      }}
      onAnimationEnd={(e) => {
        // The close animation, and only that one: the spring-IN shares this
        // element and must not drop the row.
        if (closing && e.animationName === 'sm-browser-chip-out') onClosed()
      }}
      onAuxClick={(e) => {
        // Middle-click closes, the way it has on every desktop browser for
        // twenty years. Guarded to button 1 so a right-click never closes.
        if (e.button !== 1) return
        e.preventDefault()
        onClose()
      }}
      style={{
        // A pinned chip is its favicon and nothing else: that is what pinning
        // IS, and it is what keeps eight tabs reachable on a 390px rail.
        width: tab.pinned ? 44 : 'clamp(112px, 38vw, 168px)',
        scrollSnapAlign: dragging ? 'none' : 'center',
        // The dragged chip follows the finger; every other chip slides by one
        // chip-width to open the gap. Both are `transform`, so the whole reflow
        // is composited — a rail of eight chips never touches layout.
        transform: dragDx ? `translateX(${dragDx.toFixed(1)}px)` : undefined,
        transitionProperty: dragging ? 'none' : 'transform',
        transitionDuration: dragging ? '0ms' : '160ms',
        transitionTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
        zIndex: dragging ? 20 : undefined,
      }}
      className={cn(
        'group relative flex h-11 shrink-0 cursor-default select-none items-center gap-2 rounded-xl border text-left transition-colors motion-reduce:!transition-none',
        tab.pinned ? 'justify-center px-0' : 'px-2.5',
        active
          ? 'border-transparent bg-secondary text-foreground'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
        // Pinned tabs sort first and are sticky-left — on DESKTOP only. On a
        // phone a sticky pinned chip eats a third of the rail.
        tab.pinned && !dragging && 'md:sticky md:left-0 md:z-10',
        tab.pinned && 'ring-1 ring-sky-500/60',
        // In the air: lifted, and slightly larger, so it reads as being held.
        dragging && 'scale-[1.04] cursor-grabbing shadow-lg ring-1 ring-primary/50',
        // Mount-driven — see the rail's note.
        'sm-browser-chip-in',
        closing && 'sm-browser-chip-out',
      )}
    >
      <TabIcon
        url={tab.url}
        title={title}
        favicon={icon}
        loading={loading}
        tone={state.tone}
      />
      {!tab.pinned && (
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight">
          {title}
        </span>
      )}
      {!tab.pinned && (
        <button
          type="button"
          aria-label={`Close ${title}`}
          data-tab-close=""
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          // Touch: the active chip only — a 24px target beside a 112px chip is
          // a mis-tap generator on every other one. Real pointer: every chip on
          // hover, because a mouse does not mis-tap and hunting for the active
          // chip to close a background tab is the desktop papercut.
          className={cn(
            'relative -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors after:absolute after:-inset-2.5 after:content-[\'\'] hover:bg-background hover:text-foreground motion-reduce:transition-none',
            !active && 'hidden [@media(hover:hover)]:group-hover:flex',
          )}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}

/**
 * 16px of identity: the site's own icon, a spinner while it loads, or a hashed
 * letter tile — and the status dot as a badge on its corner.
 *
 * The dot MOVED here rather than being dropped: the tone is the honesty rule
 * (§7.3, a tab that needs a sign-in says so wherever it is drawn) and the chip
 * cannot afford two 16px cells. On a pinned favicon-only chip it is the only
 * state signal there is, which is exactly why it had to survive.
 */
function TabIcon({
  url,
  title,
  favicon,
  loading,
  tone,
}: {
  url: string
  title: string
  favicon: string | null
  loading: boolean
  tone: TabTone
}) {
  const tile = faviconTile(url)
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {loading ? (
        <Loader2
          data-tab-spinner=""
          className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-hidden
        />
      ) : favicon ? (
        <img
          src={favicon}
          alt=""
          data-tab-favicon=""
          // Decorative: the title beside it already names the tab, and a
          // screen reader reading a base64 blob's alt text helps nobody.
          aria-hidden
          className="size-4 rounded-[3px] object-contain"
        />
      ) : (
        <span
          data-tab-tile={tile.letter}
          aria-hidden
          title={title}
          style={{
            backgroundColor: `hsl(${tile.hue} 60% 45%)`,
          }}
          className="flex size-4 items-center justify-center rounded-[3px] text-[9px] font-bold leading-none text-white"
        >
          {tile.letter}
        </span>
      )}
      <span
        aria-hidden
        data-tab-dot={tone}
        className={cn(
          'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card',
          DOT[tone],
        )}
      />
    </span>
  )
}
