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
import * as React from 'react'

import { Loader2, Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useLongPress } from '@/hooks/use-long-press'
import { tabState, type BrowserTab, type TabTone } from '@/lib/api/browser'
import { faviconTile, originOf, prettyHost } from '@/lib/browser/nav-state'

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
  /** Long-press / desktop right-click → the per-tab sheet (pin, grants, state). */
  onMenu: (id: string) => void
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

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label="Browser tabs"
      data-tab-rail=""
      style={{
        paddingInlineStart: 'max(12px, env(safe-area-inset-left))',
        paddingInlineEnd: 'max(12px, env(safe-area-inset-right))',
      }}
      className={cn(
        'flex shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-border bg-card py-2',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        '[-webkit-overflow-scrolling:touch] [overscroll-behavior-x:contain] [scroll-snap-type:x_proximity]',
        className,
      )}
    >
      {tabs.map((tab) => (
        <TabChip
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          live={live && live.tabId === tab.id ? live : null}
          favicon={favicons?.[originOf(tab.url) ?? ''] ?? null}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onMenu={() => onMenu(tab.id)}
        />
      ))}
      <button
        type="button"
        onClick={onNew}
        aria-label="New tab"
        data-tab-new=""
        className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-border hover:text-foreground motion-reduce:transition-none"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  )
}

function TabChip({
  tab,
  active,
  live,
  favicon,
  onSelect,
  onClose,
  onMenu,
}: {
  tab: BrowserTab
  active: boolean
  live: LiveTabNav | null
  favicon: string | null
  onSelect: () => void
  onClose: () => void
  onMenu: () => void
}) {
  const state = tabState(tab)
  const press = useLongPress({ onLongPress: onMenu, onClick: onSelect })
  // The socket outranks the row for the tab it is attached to — that is the
  // whole point of the feed — and the row is the truth for every other chip.
  const title = (live?.title || tab.title || prettyHost(tab.url)).trim()
  const icon = live?.favicon ?? favicon
  const loading = !!live?.loading
  return (
    <div
      {...press}
      data-tab-chip={tab.id}
      data-tab-tone={state.tone}
      data-tab-pinned={tab.pinned ? '' : undefined}
      data-tab-loading={loading ? '' : undefined}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={`${title} — ${state.detail}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
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
        scrollSnapAlign: 'center',
      }}
      className={cn(
        'group relative flex h-11 shrink-0 cursor-default select-none items-center gap-2 rounded-xl border text-left transition-colors motion-reduce:transition-none',
        tab.pinned ? 'justify-center px-0' : 'px-2.5',
        active
          ? 'border-transparent bg-secondary text-foreground'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
        // Pinned tabs sort first and are sticky-left — on DESKTOP only. On a
        // phone a sticky pinned chip eats a third of the rail.
        tab.pinned && 'md:sticky md:left-0 md:z-10',
        tab.pinned && 'ring-1 ring-sky-500/60',
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
