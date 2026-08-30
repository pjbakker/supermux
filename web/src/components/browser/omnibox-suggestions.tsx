// THE DROPDOWN UNDER THE ADDRESS BAR — six rows, 44px each, keyboard-first.
//
// Its job is not to be clever. It is to make the parser VISIBLE: row 0 always
// mirrors what Enter is about to do ("Search for «q3 numbers»" vs "Go to
// mail.example"), so the branch is something a human sees before pressing,
// rather than something they discover in a new tab. Everything under it — open
// tabs, allowlisted hosts — is convenience, and the ranking is decided in
// `lib/browser/omnibox.ts`, where it can be tested without a renderer.
//
// KEYBOARD. `-1` is "nothing highlighted, Enter takes the bar's own parse",
// which is the state one keystroke leaves you in; ↓ enters the list, ↑ from the
// top enters it at the bottom, and walking off either edge returns to `-1` so
// there is always a way back to plain typing. `aria-activedescendant` on the
// input carries that to a screen reader, which is why the rows have stable ids.
//
// MOBILE. Full width, under the bar, inside the chrome's own stacking context —
// not a portal — so it moves with the chrome and never floats over a scrolled
// page. `overscroll-contain` so flicking the list does not pull the page.
import { ArrowUpRight, Globe, Search, ShieldCheck, SquareStack } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { OmniboxRow } from '@/lib/browser/omnibox'

/** The id of one row, shared by `aria-activedescendant` and the row itself. */
export function rowDomId(listId: string, index: number): string {
  return `${listId}-row-${index}`
}

const ICON = {
  search: Search,
  navigate: ArrowUpRight,
  tab: SquareStack,
  origin: ShieldCheck,
} as const

export interface OmniboxSuggestionsProps {
  id: string
  rows: OmniboxRow[]
  /** `-1` = nothing highlighted (Enter takes the bar's parse). */
  highlighted: number
  onPick: (row: OmniboxRow) => void
  /** Arrow-key highlight follows the mouse, like every browser's omnibox. */
  onHighlight: (index: number) => void
  className?: string
}

export function OmniboxSuggestions({
  id,
  rows,
  highlighted,
  onPick,
  onHighlight,
  className,
}: OmniboxSuggestionsProps) {
  if (rows.length === 0) return null
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Address suggestions"
      data-omnibox-suggestions=""
      className={cn(
        'absolute inset-x-0 top-full z-20 mt-1 max-h-[17rem] overflow-y-auto rounded-xl border border-border bg-card py-1 shadow-lg [overscroll-behavior:contain]',
        className,
      )}
    >
      {rows.map((row, i) => {
        const Icon = ICON[row.kind] ?? Globe
        const active = i === highlighted
        return (
          <li
            key={row.id}
            id={rowDomId(id, i)}
            role="option"
            aria-selected={active}
            data-omnibox-row={row.kind}
            data-omnibox-active={active ? '' : undefined}
            onMouseEnter={() => onHighlight(i)}
            // The field must not blur before the click lands, or the bar
            // restores its value and the row is picked against a stale draft.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(row)}
            // The list is driven from the INPUT (↑/↓ + `aria-activedescendant`),
            // which is how a combobox works — but a row that can be reached by
            // some other means must still answer Enter/Space rather than being
            // a mouse-only control.
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onPick(row)
            }}
            className={cn(
              'flex min-h-11 cursor-default items-center gap-2.5 px-3',
              active ? 'bg-secondary' : 'hover:bg-secondary/60',
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] leading-tight text-foreground">
                {row.label}
              </span>
              <span className="truncate text-[11.5px] leading-tight text-muted-foreground">
                {row.detail}
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
