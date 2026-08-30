// THE CONTEXT MENU — right-click on desktop, long-press on a phone, one
// component, and NOT a dropdown.
//
// WHY NOT `ui/dropdown-menu`. Radix's dropdown is anchored to a TRIGGER: it
// wants an element to hang off, and it opens where that element is. A context
// menu is anchored to a POINT — the pixel the pointer was on, which may be the
// middle of a 168px tab chip or the middle of a page. Radix ships a separate
// `react-context-menu` primitive for exactly this reason and it is not a
// dependency here; adding one for a menu this small would be a worse trade than
// the ~90 lines below, all of which are the parts that actually matter:
//
//   · FLIP AND CLAMP. A menu summoned 20px from the right edge of a 320px phone
//     must open leftwards, and one summoned near the bottom must open upwards,
//     or half of it is off-screen and the item nobody can reach is always
//     "Close others". Measured against the real viewport, after mount.
//   · ROVING FOCUS. ↑/↓ move, Enter runs, Escape closes and RETURNS FOCUS to
//     where it came from. A menu you can open with a keyboard and not leave is
//     a trap.
//   · 44px ROWS, always. This is the same menu on a phone, where it is what a
//     long-press opens.
//   · DISMISS ON ANYTHING — outside pointer, scroll, resize, Escape. A context
//     menu that survives a scroll floats over the wrong thing.
//
// THE ITEMS ARE DATA, NOT CLOSURES. A row carries an id and how to draw itself;
// the host gets ONE `onSelect(id)` and keeps its verb table in one place. That
// is what lets the tab menu and the page menu be the same component — and it
// keeps every ref the verbs touch (the live socket, in the workspace's case)
// inside an event handler where refs belong, instead of inside a closure built
// during render.
import * as React from 'react'

import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface BrowserMenuItem {
  id: string
  label: string
  icon?: LucideIcon
  /** Greyed, with the reason on its `title` — never hidden. A verb that
   *  disappears when it cannot be used reflows the menu under the pointer. */
  disabled?: boolean
  /** Why it is greyed, or what it will do. */
  hint?: string
  /** Draws it in the destructive tint (Close, Close others). */
  danger?: boolean
  /** A hairline above this row. */
  separated?: boolean
}

export interface BrowserMenuProps {
  /** Where the pointer was, in CLIENT coordinates. */
  at: { x: number; y: number }
  items: BrowserMenuItem[]
  /** Named for the screen reader — "Tab menu", "Page menu". */
  label: string
  /** The chosen row's id. Fires AFTER the menu has closed — several of these
   *  verbs unmount the thing the menu is on. */
  onSelect: (id: string) => void
  onClose: () => void
  /** Bench only: skip the viewport measurement so a screenshot is stable. */
  fixed?: boolean
}

const MENU_WIDTH = 232
const EDGE_GAP = 8

export function BrowserMenu({ at, items, label, onSelect, onClose, fixed }: BrowserMenuProps) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number }>({
    left: at.x,
    top: at.y,
  })
  const [active, setActive] = React.useState(() => items.findIndex((i) => !i.disabled))
  const returnTo = React.useRef<Element | null>(null)

  // Flip and clamp against the REAL viewport, once the menu has a height.
  React.useEffect(() => {
    if (fixed) return
    const el = ref.current
    if (!el || typeof window === 'undefined') return
    const w = el.offsetWidth || MENU_WIDTH
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.max(EDGE_GAP, Math.min(at.x, vw - w - EDGE_GAP))
    const top = at.y + h + EDGE_GAP > vh ? Math.max(EDGE_GAP, at.y - h) : at.y
    setPos({ left, top })
  }, [at.x, at.y, fixed, items.length])

  React.useEffect(() => {
    returnTo.current = typeof document === 'undefined' ? null : document.activeElement
    ref.current?.focus({ preventScroll: true })
    return () => {
      const back = returnTo.current
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  // Anything that moves the world under the menu closes it.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const away = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const bye = () => onClose()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('scroll', bye, true)
    window.addEventListener('resize', bye)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('scroll', bye, true)
      window.removeEventListener('resize', bye)
    }
  }, [onClose])

  const step = (dir: 1 | -1) => {
    setActive((cur) => {
      for (let n = 1; n <= items.length; n += 1) {
        const next = (cur + dir * n + items.length * 2) % items.length
        if (!items[next]?.disabled) return next
      }
      return cur
    })
  }

  const run = (item: BrowserMenuItem) => {
    if (item.disabled) return
    // Close FIRST: several of these unmount the thing that owns the menu (close
    // the tab it is on), and a menu still mounted over a dead row is a ghost.
    onClose()
    onSelect(item.id)
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-browser-menu={label}
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          step(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          step(-1)
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          const item = items[active]
          if (item) run(item)
        }
      }}
      className="sm-browser-menu-in fixed z-50 max-h-[70vh] origin-top-left overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-1 shadow-[var(--sm-card-shadow)] outline-none"
    >
      {items.map((item, i) => {
        const Icon = item.icon
        return (
          <React.Fragment key={item.id}>
            {item.separated && <div aria-hidden className="my-1 h-px bg-border" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              data-browser-menu-item={item.id}
              onPointerEnter={() => !item.disabled && setActive(i)}
              onClick={() => run(item)}
              className={cn(
                'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors motion-reduce:transition-none',
                item.disabled
                  ? 'cursor-default text-muted-foreground/50'
                  : item.danger
                    ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400'
                    : 'text-foreground hover:bg-secondary',
                !item.disabled && i === active && (item.danger ? 'bg-red-500/10' : 'bg-secondary'),
              )}
            >
              {Icon && <Icon className="size-4 shrink-0 opacity-70" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}
