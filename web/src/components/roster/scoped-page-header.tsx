// `<ScopedPageHeader>` — the shared header for the scoped full-page surfaces
// (store / workflows / browser), an iOS-style LARGE TITLE with a balanced scope
// bar on top.
//
// The tension: the `<CompanySwitcher>` is a QUIET 34px scope chip. Alone on a wide
// row it floats, unbalanced (a "New" pill on the right fixed it on Workflows but
// Connectors/Browser had nothing to anchor the other edge). The overview solves
// this by ending its header row with the account affordance — so this bar mirrors
// that: switcher on the LEFT, a Settings gear on the RIGHT (grok hides Settings
// from the nav, so this doubles as the doorway), and any page action (a "New"
// pill) sits between them. The row is always balanced, on every page.
//
//   ┌ scope bar ─────────────────────────────────────┐
//   │  [◈ HQ ⌄]              <actions>   ⚙            │   balanced both edges
//   ├────────────────────────────────────────────────┤
//   │  Connectors                                     │   large title owns its line
//   │  Give your bots the tools they need.            │
//   └────────────────────────────────────────────────┘
//
// `compact` (the browser, a full-bleed live canvas that a big title would break)
// renders ONLY the scope bar — the switcher stays visible + switchable without a
// title eating the workspace.
//
// Full-width page controls (a search FIELD, tabs, chips) are NOT passed here; they
// belong to the page, rendered BELOW. `actions` is for COMPACT scope-bar controls.
//
// Presentational: it owns no scope state (the switcher writes `activeCompany`; the
// gear navigates). The switcher chip picks up its grok skin from the broadened
// `[data-grok] .gr-company` rule wherever it mounts.
import * as React from 'react'
import { useNavigate } from 'react-router-dom'

import { CompanySwitcher } from '@/components/roster/company-switcher'
import { SettingsGlyph } from '@/components/nav-glyphs'

export function ScopedPageHeader({
  title,
  subtitle,
  actions,
  compact,
}: {
  title: string
  subtitle?: string
  /** COMPACT controls for the scope bar (a "New" pill). Full-width controls
   *  (search, tabs) render below this header, not here. */
  actions?: React.ReactNode
  /** Scope bar only, no title — for the browser's full-bleed canvas. */
  compact?: boolean
}) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col">
      <div className="flex min-h-9 items-center gap-2">
        <CompanySwitcher />
        <div className="flex-1" />
        {actions}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="Settings"
          title="Settings"
          className="grid size-9 flex-none place-items-center rounded-full text-muted-foreground transition-colors hover:bg-fill-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SettingsGlyph className="size-[19px]" />
        </button>
      </div>
      {!compact && (
        <>
          <h1 className="mt-3 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground sm:text-[30px]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 text-[14px] leading-snug text-muted-foreground">{subtitle}</p>
          )}
        </>
      )}
    </div>
  )
}
