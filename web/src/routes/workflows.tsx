// The `/workflows` route — the list, in its page scope.
//
// Lazy under <Layout> (mirrors `/store`). The same <WorkflowsView> renders
// bot-scoped inside the bot panel; this file is only the container.
import { WorkflowsView } from '@/components/workflows/workflows-view'

export function Workflows() {
  return (
    // `pt-safe` reserves the iOS-PWA status-bar / Dynamic Island region ABOVE
    // the list's sticky header (which otherwise ran under it). Additive and
    // env(safe-area-inset-top)=0 everywhere it does not apply (desktop, regular
    // web), so this is a no-op off-device — the `safe-header` contract, applied
    // at the route wrapper because the header itself is shared with the bot-panel
    // variant that must NOT carry the inset.
    <div className="flex min-h-0 flex-1 flex-col pt-safe">
      <WorkflowsView variant="page" />
    </div>
  )
}

export default Workflows
