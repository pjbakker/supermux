// The `/workflows/new` and `/workflows/:id/edit` route — the composer.
//
// Its own lazy chunk, separate from the list: the step tree, the cadence
// grammar and the upload engine are only paid for by somebody who is actually
// composing.
import { WorkflowComposer } from '@/components/workflows/workflow-composer'

export function WorkflowEdit() {
  return <WorkflowComposer />
}

export default WorkflowEdit
