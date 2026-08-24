// The `/browser` route — the shared-browser workspace (Doorway 1 for the human).
//
// Thin by design: it owns the ACTIVE-TAB selection and nothing else. The tabs,
// the grants and every mutation come from `use-browser-tabs`; the surface is
// `<BrowserWorkspace/>`, which the `/dev/browser-workspace` bench mounts with
// fixtures instead. Same component both sides, so the screenshots cannot drift
// from the product.
//
// Lazy under <Layout> (the settings/store pattern) — the workspace pulls in the
// takeover canvas + socket, which no other route needs.
import * as React from 'react'

import { BrowserWorkspace } from '@/components/browser/workspace'
import { useBrowserTabActions, useBrowserTabs } from '@/hooks/use-browser-tabs'
import { useSessions } from '@/hooks/use-sessions'

export function BrowserRoute() {
  const { tabs } = useBrowserTabs()
  const actions = useBrowserTabActions()
  const { sessions } = useSessions()
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // Follow the list rather than pinning a dead id: a tab closed elsewhere (or
  // reaped) must not leave the route pointing at a row that no longer exists.
  const active = tabs.some((t) => t.id === activeId) ? activeId : tabs[0]?.id ?? null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BrowserWorkspace
        tabs={tabs}
        activeId={active}
        onActivate={setActiveId}
        onNew={(url) => {
          // `null` = the server refused it and the human already saw why; do
          // NOT select a tab that was never created.
          void actions.create(url).then((tab) => {
            if (tab) setActiveId(tab.id)
          })
        }}
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
