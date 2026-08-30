// `<ScopedPageHeader>` — the CLEAN large-title header for the scoped full-page
// surfaces (store / workflows). Just the page's identity: a large title, an
// optional subtitle, and an optional trailing page action (Workflows' "New").
//
// The company SCOPE is no longer here. It used to lead this header as a chip,
// which left a lonely, unbalanced row on pages with no page action — and any
// filler added to balance it (a Settings gear) was worse. The scope now lives
// ONCE, in the nav, as the ringed scope circle (`<CompanySwitcher variant=
// "circle">`, the WHOOP "profile in the corner"): switchable from anywhere, and
// out of every header. So this component is purely the page title now.
//
//   ┌────────────────────────────────────────────────┐
//   │  Connectors                          <actions>  │   title owns the line
//   │  Give your bots the tools they need.            │   (actions optional)
//   └────────────────────────────────────────────────┘
//
// Full-width page controls (search, tabs, chips) belong to the page and render
// BELOW this header. `actions` is for a compact trailing control (a "New" pill).
import * as React from 'react'

export function ScopedPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  /** A compact trailing page action (Workflows' "New" pill). Full-width controls
   *  (search, tabs) render below this header, not here. */
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground sm:text-[30px]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[14px] leading-snug text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex-none pt-0.5">{actions}</div>}
    </div>
  )
}
