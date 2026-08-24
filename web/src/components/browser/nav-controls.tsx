// BACK · FORWARD · RELOAD‖STOP — the three verbs that make a viewport a browser.
//
// THE GREYING IS THE HONESTY. `can_go_back` / `can_go_forward` arrive on the
// nav-state feed, computed from the page's own history (`Page.getNavigation
// History`), so Back is grey on the first page of a tab and lit the instant
// there is something behind it. The alternative — always-lit arrows that
// sometimes do nothing — is the exact "moved:false is a normal state" case the
// server's REST door documents, and it is a state a UI should never make a
// human discover by pressing.
//
// RELOAD BECOMES STOP, IT DOES NOT GROW A NEIGHBOUR. While `loading` the same
// cell is an `×` that stops the load, which is what every browser on every
// platform does; a separate Stop button would mean a four-cell row where one
// cell is always dead. Press-and-hold Reload = HARD reload (ignore the cache) —
// the desktop right-click menu's entry, on a phone-reachable gesture.
//
// WHERE IT SITS. On a phone this is row 2 of the chrome, left of the Watch/Drive
// pair; on desktop the whole chrome collapses to one row and these are its
// leading cells, which is the toolbar shape a browser has had since 1993.
import * as React from 'react'

import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ChromeButton } from '@/components/browser/chrome-button'

/** How long a press has to last to mean "hard reload". The same 350ms the tab
 *  rail's long-press uses, so the whole workspace holds at one speed. */
export const HARD_RELOAD_HOLD_MS = 350

export interface NavControlsProps {
  /** From the nav-state feed. `false` ⇒ the arrow is grey, not hidden. */
  canGoBack: boolean
  canGoForward: boolean
  /** A load is in flight: Reload is a Stop button and the hairline shimmers. */
  loading: boolean
  /** There is no page to act on at all (no tab, or the tab is asleep). Greys
   *  every cell without changing the row's width. */
  disabled?: boolean
  onBack: () => void
  onForward: () => void
  /** `hard` = ignore the cache (press-and-hold / right-click). */
  onReload: (hard?: boolean) => void
  onStop: () => void
  className?: string
}

export function NavControls({
  canGoBack,
  canGoForward,
  loading,
  disabled,
  onBack,
  onForward,
  onReload,
  onStop,
  className,
}: NavControlsProps) {
  // Press-and-hold on the reload cell is the HARD reload.
  //
  // Hand-rolled rather than `useLongPress`, and for a real reason: that hook
  // owns the click itself, which on a real `<button>` would mean the hold fires
  // AND the browser's own click fires after it — one hold, two reloads. Here the
  // timer only sets a latch, and the button's own `onClick` reads it. Keyboard
  // activation (Enter/Space on a focused button) never touches the pointer path,
  // so it still gets a plain soft reload.
  const heldRef = React.useRef(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHold = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }
  React.useEffect(() => clearHold, [])
  const hold = {
    onPointerDown: () => {
      if (disabled || loading) return
      heldRef.current = false
      clearHold()
      timerRef.current = setTimeout(() => {
        heldRef.current = true
        onReload(true)
      }, HARD_RELOAD_HOLD_MS)
    },
    onPointerUp: clearHold,
    onPointerLeave: clearHold,
    onPointerCancel: clearHold,
  }

  return (
    <div
      data-nav-controls=""
      data-nav-loading={loading ? '' : undefined}
      role="group"
      aria-label="Page navigation"
      // 4px between cells on a phone, 6px from `md` up: the hit boxes are the
      // `::after` insets, not the gaps, so tightening this costs no target and
      // buys the Watch/Drive pair its place on the same row at 390px.
      className={cn('flex shrink-0 items-center gap-1 md:gap-1.5', className)}
    >
      <ChromeButton
        label="Back"
        icon={ArrowLeft}
        disabled={disabled || !canGoBack}
        onClick={onBack}
        data-nav-back=""
      />
      <ChromeButton
        label="Forward"
        icon={ArrowRight}
        disabled={disabled || !canGoForward}
        onClick={onForward}
        data-nav-forward=""
      />
      {/* ONE cell, two states. `data-nav-reload` stays put in both so a test —
          and a screenshot diff — can see the swap rather than a re-layout. */}
      <ChromeButton
        label={loading ? 'Stop loading' : 'Reload (hold for a hard reload)'}
        icon={loading ? X : RotateCw}
        disabled={disabled}
        onClick={() => {
          // The hold already reloaded; swallow the click it produced.
          if (heldRef.current) {
            heldRef.current = false
            return
          }
          if (loading) onStop()
          else onReload(false)
        }}
        press={hold}
        onContextMenu={(e) => {
          // Desktop's half of the same gesture: right-click is the hard reload,
          // and the native menu over a browser toolbar helps nobody.
          e.preventDefault()
          if (!disabled && !loading) onReload(true)
        }}
        data-nav-reload={loading ? 'stop' : 'reload'}
      />
    </div>
  )
}
