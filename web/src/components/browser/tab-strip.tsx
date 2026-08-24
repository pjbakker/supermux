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
// TOUCH TARGETS. The chip is 44px tall. The close affordance renders only on
// the ACTIVE chip (a 24px target beside a 112px chip is a mis-tap generator
// otherwise) and carries an invisible `::after` that expands its hit box to
// 44×44 without changing the layout.
//
// PIN IS NOT LONG-PRESS-ONLY. Long-press opens the tab sheet, where the pin
// lives as an explicit control — discoverability over cleverness. The chip's
// pinned tell is a ring, not a hidden gesture.
import * as React from 'react'

import { Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useLongPress } from '@/hooks/use-long-press'
import { tabState, type BrowserTab, type TabTone } from '@/lib/api/browser'

/** Colour is the ONLY thing the dot carries; the words are on the chip's title
 *  and in the sheet. Amber is never "probably fine" — it means sign-in needed. */
const DOT: Record<TabTone, string> = {
  ok: 'bg-emerald-500',
  'needs-login': 'bg-amber-500',
  dehydrated: 'bg-slate-400',
  unknown: 'bg-slate-400',
}

export interface TabStripProps {
  tabs: BrowserTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** Long-press / desktop right-click → the per-tab sheet (pin, grants, state). */
  onMenu: (id: string) => void
  onNew: () => void
  className?: string
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onMenu,
  onNew,
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
  onSelect,
  onClose,
  onMenu,
}: {
  tab: BrowserTab
  active: boolean
  onSelect: () => void
  onClose: () => void
  onMenu: () => void
}) {
  const state = tabState(tab)
  const press = useLongPress({ onLongPress: onMenu, onClick: onSelect })
  return (
    <div
      {...press}
      data-tab-chip={tab.id}
      data-tab-tone={state.tone}
      data-tab-pinned={tab.pinned ? '' : undefined}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={`${tab.title || tab.url} — ${state.detail}`}
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
      style={{ width: 'clamp(112px, 38vw, 168px)', scrollSnapAlign: 'center' }}
      className={cn(
        'relative flex h-11 shrink-0 cursor-default select-none items-center gap-2 rounded-xl border px-2.5 text-left transition-colors motion-reduce:transition-none',
        active
          ? 'border-transparent bg-secondary text-foreground'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
        // Pinned tabs sort first and are sticky-left — on DESKTOP only. On a
        // phone a sticky pinned chip eats a third of the rail.
        tab.pinned && 'md:sticky md:left-0 md:z-10',
        tab.pinned && 'ring-1 ring-sky-500/60',
      )}
    >
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full', DOT[state.tone])}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight">
        {tab.title || tab.url}
      </span>
      {active && (
        <button
          type="button"
          aria-label={`Close ${tab.title || tab.url}`}
          data-tab-close=""
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          // The `::after` is the touch target: 24px of ink, 44px of hit box,
          // zero layout cost.
          className="relative -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:bg-background hover:text-foreground motion-reduce:transition-none"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}
