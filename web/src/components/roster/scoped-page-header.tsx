// `<ScopedPageHeader>` — the shared header for the scoped full-page surfaces
// (store / workflows / browser). It carries the SAME leading identity the overview
// roster header does (`grok-roster.tsx` `.gr-head`): the `<CompanySwitcher/>` is
// the prominent scope chip, and the page's title/subtitle sit next to it. An
// optional `actions` slot holds the page's own right-anchored controls (a search
// box, a "New…" pill) exactly where those pages already put them.
//
// Presentational + reusable: it owns no scope state (the switcher writes
// `activeCompany` itself; surfaces read it via `useCompanyScope`). Authored in the
// target pages' own title idiom (24/28px title, 13.5px subtitle) so it reads native
// dropped into any of them, and the switcher chip picks up its grok skin from the
// broadened `[data-grok] .gr-company` rule wherever it mounts.
import * as React from 'react'

import { CompanySwitcher } from '@/components/roster/company-switcher'

export function ScopedPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-3">
        <CompanySwitcher />
        <div className="min-w-0">
          <h1 className="truncate text-[24px] font-semibold tracking-tight text-foreground sm:text-[28px]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 truncate text-[13.5px] text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </div>
  )
}
