// `<ScopedPageHeader>` — the shared header for the scoped full-page surfaces
// (store / workflows / browser), designed as an iOS-style LARGE TITLE.
//
// The core tension: the `<CompanySwitcher>` is a QUIET 34px scope chip (on the
// overview it IS the whole title), so pairing it in one row with a loud page
// title made the chip look lost and the title dwarf it. The fix is hierarchy by
// STACKING, the Settings/App-Store pattern:
//
//   ┌ scope row ─────────────────────────────┐   the switcher as a nav/context
//   │  [◈ HQ ⌄]                    <actions>  │   control; page actions balance
//   ├────────────────────────────────────────┤   it on the right
//   │  Connectors                             │   the large title owns its line
//   │  Give your bots the tools they need.    │   subtitle beneath
//   └────────────────────────────────────────┘
//
// The switcher never competes with the title; it reads as "which space am I in",
// exactly its role on the overview. Full-width page controls (a search FIELD,
// tabs, filter chips) are NOT passed here — they belong to the page, rendered
// BELOW this header. `actions` is only for COMPACT controls that sit on the scope
// row (a "New" pill, an icon button).
//
// Presentational + reusable: it owns no scope state (the switcher writes
// `activeCompany` itself; surfaces read it via `useCompanyScope`). The switcher
// chip picks up its grok skin from the broadened `[data-grok] .gr-company` rule
// wherever it mounts.
import * as React from 'react'

import { CompanySwitcher } from '@/components/roster/company-switcher'

export function ScopedPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  /** COMPACT controls for the scope row's right edge (a "New" pill, an icon).
   *  Full-width controls (search field, tabs) render below this header, not here. */
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col">
      <div className="flex min-h-9 items-center justify-between gap-2">
        <CompanySwitcher />
        {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
      </div>
      <h1 className="mt-3 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground sm:text-[30px]">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 text-[14px] leading-snug text-muted-foreground">{subtitle}</p>
      )}
    </div>
  )
}
