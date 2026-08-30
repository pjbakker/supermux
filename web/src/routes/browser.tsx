// The `/browser` route — the shared-browser workspace (Doorway 1 for the human).
//
// Thin by design: it owns the ACTIVE-TAB selection and the company SCOPE, and
// nothing else. The tabs, the grants and every mutation come from
// `use-browser-tabs`; the surface is `<BrowserWorkspace/>`, which the
// `/dev/browser-workspace` bench mounts with fixtures instead. Same component
// both sides, so the screenshots cannot drift from the product.
//
// Lazy under <Layout> (the settings/store pattern) — the workspace pulls in the
// takeover canvas + socket, which no other route needs.
import * as React from 'react'

import { BrowserWorkspace } from '@/components/browser/workspace'
import { useCompanyScope } from '@/components/roster/use-company-scope'
import { useBrowserTabActions, useBrowserTabs } from '@/hooks/use-browser-tabs'
import { useSessions } from '@/hooks/use-sessions'

export function BrowserRoute() {
  const { tabs } = useBrowserTabs()
  const actions = useBrowserTabActions()
  const { sessions } = useSessions()
  const { activeCompany, inScope } = useCompanyScope()
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // Scope to the active company: HQ (null) shows only the global tabs, a company
  // shows its own. The human owns the whole jar (the server hands back every
  // row); the switcher just narrows which of them this workspace draws — the
  // list filter, exactly as the overview roster does it. No search box here, so
  // nothing lifts scope.
  const scopedTabs = React.useMemo(
    () => tabs.filter((t) => inScope(t.company_id)),
    [tabs, inScope],
  )

  // Follow the SCOPED list rather than pinning a dead id: a tab closed elsewhere,
  // reaped, or left out of scope by a company switch must not leave the route
  // pointing at a row this workspace no longer shows — fall to the first in-scope
  // tab, or the empty state.
  const active = scopedTabs.some((t) => t.id === activeId)
    ? activeId
    : scopedTabs[0]?.id ?? null

    return (
    // `h-full`, not `flex-1`: the shell's `<main#shell-content>` is a BLOCK
    // scroll container (`display:block; overflow:auto`) so that grow-and-scroll
    // routes (overview, files) work. `flex-1` is inert inside a block parent —
    // flex-grow only applies in a flex container — so a `flex-1` child collapses
    // to its CONTENT height, and the takeover box then sizes to the 512² seed
    // frame instead of the viewport (the black-band bug). `h-full` takes 100% of
    // main's definite height, giving the flex chain below a real box to fill.
    //
    // No page header here: the browser is a full-bleed live canvas, and the
    // company scope now lives in the nav scope circle (out of every header). The
    // workspace's own tab strip + omnibox ARE its chrome; nothing stacks above.
    //
    // <BrowserWorkspace> mounts DIRECTLY under this flex-col root — NO wrapper
    // div. A wrapper here was `display:block`, and the workspace's own `flex-1`
    // (workspace.tsx) is INERT inside a block parent, so the workspace collapsed
    // to content height and the takeover box measured short → the live page sat
    // in a short frame at the top with a black band below it. That orphaned
    // wrapper (left behind when the compact header was removed) was the whole
    // "black band" bug. Direct mount keeps the workspace a real flex child of a
    // definite-height flex parent — exactly how the /dev bench mounts it (which
    // is why the bench always rendered full-height while the route did not).
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <BrowserWorkspace
        tabs={scopedTabs}
        activeId={active}
        onActivate={setActiveId}
        onNew={(url) => {
          // `null` = the server refused it and the human already saw why; do
          // NOT select a tab that was never created. Stamped into the active
          // company so a tab opened in a scope belongs to it.
          void actions.create(url, activeCompany).then((tab) => {
            if (tab) setActiveId(tab.id)
          })
        }}
        // Enter in the omnibox. `navigate` wakes the tab if it is asleep and
        // then drives the page, so one keystroke covers both — the human never
        // has to know that "asleep" was a state.
        onNavigate={(id, url) => void actions.navigate(id, url)}
        onWake={(id) => void actions.wake(id)}
        // The REST half of the nav controls. The workspace prefers the takeover
        // socket whenever one is attached (no round-trip); these are the door
        // that still works — and still wakes the tab — when it is not.
        onBack={(id) => void actions.navControl(id, 'back')}
        onForward={(id) => void actions.navControl(id, 'forward')}
        onReload={(id) => void actions.navControl(id, 'reload')}
        onStop={(id) => void actions.navControl(id, 'stop')}
        // "Close" on the chip DELETES the row; this closes the PAGE and keeps
        // the tab, its grants and its cookies. Two acts, two verbs.
        onSleep={(id) => void actions.sleep(id)}
        busy={actions.pending}
        onClose={(id) => void actions.close(id)}
        onPin={(id, pinned) => void actions.setPinned(id, pinned)}
        onGrant={(id, grantee) => actions.grant(id, grantee)}
        onRevoke={(id, grantee) => actions.revoke(id, grantee)}
        onOrigins={(id, origins) => void actions.patch(id, { origins })}
        // Company-tagged: the sheet drops the bots this tab's containment would
        // make the server refuse, rather than offering a control that 400s.
        bots={sessions.map((s) => ({ name: s.name, company_id: s.company_id ?? null }))}
      />
    </div>
  )
}

export default BrowserRoute
