// The `/workflows` route — the list, in its page scope.
//
// Lazy under <Layout> (mirrors `/store`). The same <WorkflowsView> renders
// bot-scoped inside the bot panel; this file is only the container.
import { WorkflowsView } from '@/components/workflows/workflows-view'

export function Workflows() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkflowsView variant="page" />
    </div>
  )
}

export default Workflows
