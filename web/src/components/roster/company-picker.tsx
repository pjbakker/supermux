/**
 * `<CompanyPicker>` — the shared HQ-row + company-rows option list, extracted
 * verbatim from `<CompanySwitcher>`'s old private `renderOptions` so the same
 * markup can drive TWO surfaces without the list being written twice:
 *
 *   • the company SWITCHER (`company-switcher.tsx`) — scopes the roster; keeps
 *     its roving keyboard cursor (`cursor`/`onCursor`), the ⌘1..9 jump hints
 *     (`showShortcutHints`), attention dots (`attention`) and the active check
 *     (`activeId`). The switcher still owns its own Invite / New-company actions
 *     and footer — those are NOT "the list", so they stay there.
 *   • the MOVE-TO-COMPANY sheet (`move-to-company-sheet.tsx`) — a destination
 *     picker. It passes `excludeId` (the bot's current company, so a bot is never
 *     "moved" to where it already lives) and no cursor / hints / check.
 *
 * Both shells share ONE row authoring (`variant: 'menu' | 'sheet'`), skinned per
 * shell exactly as the switcher did (compact 13px desktop rows vs ≥44px touch
 * rows), so the two surfaces can never drift.
 */
import { Check } from 'lucide-react'

import type { Company } from '@/lib/companies'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'

/** A stable empty attention set so a default prop is referentially constant. */
const EMPTY_ATTENTION: ReadonlySet<number | null> = new Set()

/** A subtle ~6px attention dot in the status token (`--gr-need`), NOT an
 *  identity hue — the firewall's status half. Static (no pulse), so it is
 *  reduced-motion-safe by construction; it carries no text, so it owes no AA
 *  contrast, and the accessible signal rides an `sr-only` word on the row. */
function NeedDot() {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full"
      style={{ background: 'var(--gr-need)' }}
    />
  )
}

export interface CompanyPickerProps {
  /** `menu` = compact desktop rows (13px, hover highlight, roving cursor).
   *  `sheet` = touch rows (≥44px tap target, 15px, tap-feedback). */
  variant: 'menu' | 'sheet'
  companies: readonly Company[]
  /** Pick a destination/scope. `null` = HQ, a number = that company. */
  onPick: (id: number | null) => void
  /** The currently-active id — draws a check on that row (`null` = HQ). Pass
   *  `undefined` (the default, the move picker) to show no check at all. */
  activeId?: number | null
  /** A row to OMIT: `null` hides the HQ row, a number hides that company,
   *  `undefined` (the default, the switcher) shows every row. The move picker
   *  passes the bot's current `company_id` so it can't be "moved" in place. */
  excludeId?: number | null
  /** Company ids (with `null` = HQ) that currently need attention — a dot shows
   *  on each such row. Defaults to empty. */
  attention?: ReadonlySet<number | null>
  /** The roving-highlight index (switcher/menu only): `0` = HQ, `i+1` =
   *  `companies[i]`. Omit for no keyboard highlight (the move sheet). */
  cursor?: number
  /** Called on hover (menu only) to move the roving highlight. */
  onCursor?: (i: number) => void
  /** Show the ⌘1..9 jump hints on the rows (switcher/menu only). */
  showShortcutHints?: boolean
}

export function CompanyPicker({
  variant,
  companies,
  onPick,
  activeId,
  excludeId,
  attention = EMPTY_ATTENTION,
  cursor,
  onCursor,
  showShortcutHints = false,
}: CompanyPickerProps) {
  const sheet = variant === 'sheet'
  const rowBase =
    'flex w-full items-center rounded-lg text-left transition-colors focus-visible:outline-none'
  const rowSkin = sheet
    ? 'min-h-[44px] gap-3 px-3.5 py-2.5 text-[15px] active:bg-accent/60'
    : 'gap-2.5 px-3 py-2 text-[13px] hover:bg-accent/50'
  const hl = (on: boolean) => (!sheet && on ? 'bg-accent/50' : '')
  const markSize = sheet ? 28 : 24
  // HQ mark matches the company-mark scale in each shell (sheet 28 / menu 24).
  const sparkSize = sheet ? 28 : 24
  const hasCursor = cursor !== undefined

  return (
    <>
      {/* HQ — pinned top, its own cell (the "above all companies" home). Hidden
          only when it IS the excluded row (a bot already at HQ). */}
      {excludeId !== null && (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeId === null}
            data-hl={(hasCursor && cursor === 0) || undefined}
            className={`${rowBase} ${rowSkin} ${hl(hasCursor && cursor === 0)}`}
            onMouseEnter={() => !sheet && onCursor?.(0)}
            onClick={() => onPick(null)}
          >
            <HqMark size={sparkSize} />
            <span className="flex min-w-0 flex-col">
              <span className="font-semibold text-foreground">HQ</span>
              <span
                className={`text-muted-foreground ${sheet ? 'text-[12.5px]' : 'text-[11.5px]'}`}
              >
                PA · tech-admin · sees everything
              </span>
            </span>
            {attention.has(null) && <span className="sr-only"> — needs you</span>}
            <span className="ml-auto flex items-center gap-2 pl-2">
              {attention.has(null) && <NeedDot />}
              {!sheet && showShortcutHints && (
                <kbd className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
                  ⌘1
                </kbd>
              )}
              {activeId === null && (
                <Check size={16} style={{ color: 'var(--sm-accent)' }} aria-hidden />
              )}
            </span>
          </button>

          <div className="my-1 h-px bg-border" role="separator" />
        </>
      )}

      {/* companies — CompanyMark + name + a faint slug meta + active check.
          The bot's current company is dropped by `excludeId`. */}
      {companies.map((c, i) => {
        if (excludeId != null && c.id === excludeId) return null
        const idx = i + 1
        const on = activeId === c.id
        const needs = attention.has(c.id)
        return (
          <button
            key={c.id}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            data-hl={(hasCursor && cursor === idx) || undefined}
            className={`${rowBase} ${rowSkin} ${hl(hasCursor && cursor === idx)}`}
            onMouseEnter={() => !sheet && onCursor?.(idx)}
            onClick={() => onPick(c.id)}
          >
            <CompanyMark
              slug={c.slug}
              name={c.display_name}
              size={markSize}
              className="shrink-0"
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold text-foreground">
                {c.display_name}
              </span>
              <span
                className={`truncate text-muted-foreground ${sheet ? 'text-[12.5px]' : 'text-[12px]'}`}
              >
                {c.slug}
              </span>
            </span>
            {needs && <span className="sr-only"> — needs you</span>}
            <span className="ml-auto flex items-center gap-2 pl-2">
              {needs && <NeedDot />}
              {!sheet && showShortcutHints && i < 8 && (
                <kbd className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
                  ⌘{i + 2}
                </kbd>
              )}
              {on && (
                <Check size={16} style={{ color: 'var(--sm-accent)' }} aria-hidden />
              )}
            </span>
          </button>
        )
      })}
    </>
  )
}
