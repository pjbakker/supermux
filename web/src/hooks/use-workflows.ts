// useWorkflows — TanStack Query bindings for `/api/workflows`.
//
// Real-time, not polled. The engine pushes a company-stamped `workflows` SSE
// frame on every change (created / updated / steps / run / step / cancelled /
// deleted) and an `alerts` frame when a run finishes; `useWorkflowsStream`
// subscribes to the SHARED `use-sse.ts` stream — the one app-wide EventSource —
// and invalidates on both. There is no interval here, ever, and no second
// connection: reconnect / backoff / staleness are all `useSse`'s.

import { useCallback, useMemo, useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import {
  workflowsApi,
  type StepInput,
  type WorkflowCommand,
  type WorkflowCreateInput,
  type WorkflowDetailPayload,
  type WorkflowPatchInput,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
  type WorkflowWithSteps,
} from '@/lib/api/workflows'
import { useSse, type SseEventType } from '@/hooks/use-sse'

const WORKFLOWS_KEY = ['workflows'] as const
const COMMANDS_KEY = ['workflows', 'commands'] as const
const ACTIVITY_KEY = ['workflows', 'activity'] as const
const listKey = (session?: string | null) => ['workflows', 'list', session ?? '*'] as const
const oneKey = (id: string) => ['workflows', 'one', id] as const
const runsKey = (id: string) => ['workflows', 'runs', id] as const

/** Every workflow the viewer may see, or one bot's when `session` is given. */
export function useWorkflows(session?: string | null) {
  return useQuery<WorkflowWithSteps[]>({
    queryKey: listKey(session),
    queryFn: () => workflowsApi.list(session ?? null),
    staleTime: 30_000,
    retry: false,
  })
}

/** One workflow + steps + its last run (the detail header renders it). */
export function useWorkflow(id: string | null | undefined) {
  return useQuery<WorkflowDetailPayload>({
    queryKey: oneKey(id ?? ''),
    queryFn: () => workflowsApi.get(id as string),
    enabled: !!id,
    staleTime: 15_000,
    retry: false,
  })
}

/** The last ≤20 runs of one workflow, each with its own step ledger. */
export function useWorkflowRuns(id: string | null | undefined, limit?: number) {
  return useQuery<WorkflowRunDetail[]>({
    queryKey: [...runsKey(id ?? ''), limit ?? 20],
    queryFn: () => workflowsApi.runs(id as string, limit),
    enabled: !!id,
    staleTime: 10_000,
    retry: false,
  })
}

/** The cross-workflow activity feed (the bot panel's "Recent runs"). */
export function useWorkflowActivity(enabled = true) {
  return useQuery<WorkflowRunSummary[]>({
    queryKey: ACTIVITY_KEY,
    queryFn: workflowsApi.activity,
    enabled,
    staleTime: 15_000,
    retry: false,
  })
}

/** The REAL installed agent commands for the step picker's `/` autocomplete.
 *  Cached 60s — the installed set rarely changes mid-session. */
export function useWorkflowCommands(cwd?: string | null) {
  return useQuery<WorkflowCommand[]>({
    queryKey: [...COMMANDS_KEY, cwd ?? ''],
    queryFn: () => workflowsApi.commands(cwd ?? null),
    staleTime: 60_000,
    retry: false,
  })
}

export function useCreateWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: WorkflowCreateInput) => workflowsApi.create(input),
    onSuccess: () => invalidateWorkflows(qc),
  })
}

export function usePatchWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: WorkflowPatchInput }) =>
      workflowsApi.patch(id, patch),
    onSuccess: () => invalidateWorkflows(qc),
  })
}

export function useReplaceSteps() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, steps }: { id: string; steps: StepInput[] }) =>
      workflowsApi.replaceSteps(id, steps),
    onSuccess: () => invalidateWorkflows(qc),
  })
}

/** Run now. The fire is async on the server (202); the `workflows` SSE frame
 *  lands the fresh run row, and we nudge the cache after a short beat so the
 *  rail starts moving even on a stream that is mid-reconnect. */
export function useRunWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workflowsApi.run(id),
    onSuccess: () => {
      window.setTimeout(() => invalidateWorkflows(qc), 600)
    },
  })
}

export function useCancelRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workflowsApi.cancel(id),
    onSuccess: () => invalidateWorkflows(qc),
  })
}

export function useDeleteWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workflowsApi.remove(id),
    onSuccess: () => invalidateWorkflows(qc),
  })
}

// ── live stream (SSE — never polling) ─────────────────────────────────────────

function invalidateWorkflows(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: WORKFLOWS_KEY })
}

/**
 * Does this SSE frame concern workflows?
 *
 * PURE and exported so the branch is asserted directly rather than through a
 * mounted provider: two channels carry workflow news, and the second one is
 * shared with the board, so "invalidate on every `alerts`" would refetch the
 * whole surface every time an issue moved.
 *
 * The engine's own alert frames carry `source:"workflows"`; the spec writes the
 * singular. Both are accepted — the alternative is a live surface that silently
 * stops updating over a plural.
 */
export function isWorkflowEvent(type: SseEventType | string, payload: unknown): boolean {
  if (type === 'workflows') return true
  if (type !== 'alerts') return false
  const p = payload as { source?: string; payload?: { source?: string } } | null
  const source = p?.source ?? p?.payload?.source
  return source === 'workflow' || source === 'workflows'
}

/**
 * Subscribe the workflows caches to the SHARED live event stream. Mount once
 * per surface (the list route, the detail route, the bot panel tab). Pure push;
 * the focus/visibility/online resync reconciles a fire that landed while the
 * stream was asleep.
 */
export function useWorkflowsStream() {
  const qc = useQueryClient()
  const onEvent = useCallback(
    (type: SseEventType, payload: unknown) => {
      if (isWorkflowEvent(type, payload)) invalidateWorkflows(qc)
    },
    [qc],
  )
  const onResync = useCallback(() => invalidateWorkflows(qc), [qc])
  const handlers = useMemo(() => ({ onEvent, onResync }), [onEvent, onResync])
  useSse(handlers)
}

// ── live progress (what makes the rail move) ──────────────────────────────────

/** Where one workflow's in-flight run has got to. Assembled from the SSE frames
 *  alone — a run's step-by-step position exists nowhere else without polling a
 *  ledger the list has no reason to fetch. */
export interface WorkflowProgress {
  runId: number
  /** 1-based, matching the frame. */
  step: number
  steps: number
  running: boolean
  /** `ok` | `error` | `timeout` | `interrupted` | `cancelled`, once the run has
   *  finished and the `alerts` frame said which. Null while running. */
  status: string | null
}

export type ProgressMap = Readonly<Record<string, WorkflowProgress>>

/**
 * Fold one SSE frame into the progress map. PURE, so the state machine is
 * testable without a stream.
 *
 * The two channels arrive in a fixed order and carry different halves of the
 * truth: `alerts` names the terminal STATUS, the `workflows` `run-finished`
 * frame only says it ended. So a `run-finished` never clobbers a status an
 * alert already set — otherwise a failed run would flash red and settle grey.
 */
export function applyProgressFrame(
  map: ProgressMap,
  type: SseEventType | string,
  payload: unknown,
): ProgressMap {
  const p = (payload ?? {}) as Record<string, unknown>
  const id = typeof p.workflow === 'string' ? p.workflow : null
  if (!id) return map
  const prev = map[id]
  const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

  if (type === 'alerts') {
    const source = p.source ?? (p.payload as { source?: string } | undefined)?.source
    if (source !== 'workflows' && source !== 'workflow') return map
    return {
      ...map,
      [id]: {
        runId: num(p.run_id, prev?.runId ?? 0),
        step: num(p.step, prev?.step ?? 0),
        steps: num(p.steps, prev?.steps ?? 0),
        running: false,
        status: typeof p.status === 'string' ? p.status : (prev?.status ?? null),
      },
    }
  }
  if (type !== 'workflows') return map

  const change = typeof p.change === 'string' ? p.change : ''
  if (change === 'run-started' || change === 'step') {
    return {
      ...map,
      [id]: {
        runId: num(p.run_id, prev?.runId ?? 0),
        step: num(p.step, prev?.step ?? 0),
        steps: num(p.steps, prev?.steps ?? 0),
        running: true,
        status: null,
      },
    }
  }
  if (change === 'run-finished' || change === 'cancelled') {
    return {
      ...map,
      [id]: {
        runId: num(p.run_id, prev?.runId ?? 0),
        step: num(p.step, prev?.step ?? 0),
        steps: num(p.steps, prev?.steps ?? 0),
        running: false,
        // `cancelled` is its own answer; anything else waits for the alert
        // rather than inventing a verdict the server did not give.
        status: change === 'cancelled' ? 'cancelled' : (prev?.status ?? null),
      },
    }
  }
  if (change === 'deleted') {
    const { [id]: _gone, ...rest } = map
    return rest
  }
  return map
}

/**
 * The live position of every running workflow, folded out of the shared SSE
 * stream. Mount alongside `useWorkflowsStream` on any surface drawing a rail.
 */
export function useWorkflowProgress(): ProgressMap {
  const [map, setMap] = useState<ProgressMap>({})
  const onEvent = useCallback((type: SseEventType, payload: unknown) => {
    setMap((m) => applyProgressFrame(m, type, payload))
  }, [])
  const handlers = useMemo(() => ({ onEvent }), [onEvent])
  useSse(handlers)
  return map
}
