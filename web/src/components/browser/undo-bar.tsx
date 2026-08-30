// "Closed · Undo" — the smallest safety net, at the end of the thumb.
//
// WHY NOT THE APP'S TOAST. `ui/toast` exists and has an `action` slot (the
// overview's archive flow uses it for exactly this shape). It is anchored to
// the TOP of the window and its capsule is 36px tall — correct for a passive
// notice on a desktop, wrong for the one control you may need to hit in a hurry
// on a phone, where the top of the screen is the part of the display a thumb
// cannot reach. So this one sits at the BOTTOM of the workspace, above the safe
// area, with a 44px target — and it is scoped to the browser, so a tab closed
// here cannot be undone from a screen the tab is not on.
//
// IT COUNTS DOWN VISIBLY. A bar that vanishes without warning teaches people to
// stop trusting it; the hairline draining left-to-right is the window, drawn.
// Under Reduce Motion the drain is not animated — the bar simply stands for its
// window and goes, and the label still says what it is.
//
// IT DOES NOT OVER-CLAIM. Re-opening mints a NEW tab at the same address: the
// cookies are on the server and survive, the GRANTS do not (a permission is not
// decoration). "Reopen" is therefore the word, never "Restore".
import { RotateCcw, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { UNDO_WINDOW_MS, type ClosedTab } from '@/lib/browser/closed-tabs'
import { prettyHost } from '@/lib/browser/nav-state'

export interface UndoBarProps {
  entry: ClosedTab | null
  onUndo: () => void
  onDismiss: () => void
  className?: string
}

export function UndoBar({ entry, onUndo, onDismiss, className }: UndoBarProps) {
  if (!entry) return null
  const name = (entry.title || prettyHost(entry.url) || 'Tab').trim()
  return (
    <div
      role="status"
      data-browser-undo={entry.id}
      style={{ bottom: 'max(14px, calc(env(safe-area-inset-bottom) + 10px))' }}
      className={cn(
        'sm-browser-undo-in absolute left-1/2 z-30 flex max-w-[calc(100%-24px)] items-center gap-2 overflow-hidden rounded-2xl border border-border bg-card/95 py-1.5 pl-3 pr-1.5 shadow-[var(--sm-card-shadow)] backdrop-blur',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
        Closed <span className="font-medium text-foreground">{name}</span>
      </span>
      <button
        type="button"
        onClick={onUndo}
        data-browser-undo-action=""
        className="relative inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium text-primary transition-colors hover:bg-secondary motion-reduce:transition-none"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Reopen
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
      {/* The window, drawn. `animation` rather than a transition so it starts
          from a known 100% on mount even when the bar is re-shown for a second
          close inside the same second. */}
      <span
        aria-hidden
        data-browser-undo-timer=""
        style={{ animationDuration: `${UNDO_WINDOW_MS}ms` }}
        className="sm-browser-undo-drain absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary/60"
      />
    </div>
  )
}
