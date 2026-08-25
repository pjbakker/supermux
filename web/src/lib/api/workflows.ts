// Workflows — the real client for `/api/workflows` (a bot, an ordered list of
// prompt steps, and one trigger).
//
// Envelope: success bodies are wrapped (`{ ok:true, data }`), errors use
// `{ ok:false, error }`. `wfRequest` unwraps `data` on success and lifts
// `error` on a non-2xx so the UI can render "every weekday at 9am isn't a time
// I understand" instead of crashing.
//
// What is NOT here, deliberately: `kind`, `command:` free text, `boot_*`,
// `bypass_permissions`, `watch`, `done_pattern`, `_test_fire`. The server
// refuses each of them BY NAME (workflows/mod.rs::create), and nothing in this
// module can express one — that is the client half of keeping the dragon dead.

import { apiToken, apiUrl } from './client'

// ── wire types ────────────────────────────────────────────────────────────────

/** How a workflow starts. `manual` = only when a human (or the bot) says so. */
export type TriggerKind = 'manual' | 'once' | 'recurring'

/** One attached file, as stored on a step. `path` is absolute, under
 *  `<data_dir>/uploads/` — the server canonicalises and refuses anything else. */
export interface WorkflowFile {
  path: string
  name: string
  size?: number
  mime?: string
}

/** The five typed completion actions — the curated replacement for the old
 *  `done_action: command:<text>`. There is no free-text arm, here or on the
 *  server, and `workflow-completion.test.ts` is the guard that keeps it so. */
export type CompletionAction =
  | { kind: 'none' }
  | { kind: 'notify' }
  | { kind: 'disable' }
  | {
      kind: 'connector_send'
      connector_id: string
      /** Which connected account of that connector (`connector_accounts.id`). */
      account_ref: string
      to: string
      subject?: string | null
    }
  | { kind: 'message_bot'; session: string }

/** A row of the `workflows` table (mirrors db::workflows::Workflow). */
export interface WorkflowRow {
  id: string
  title: string
  /** The owning bot's slug. */
  session: string
  /** DERIVED from the session; null = the main bot. Never client-set. */
  company_id: number | null
  enabled: number
  trigger_kind: TriggerKind
  /** null iff `trigger_kind === 'manual'`. */
  schedule_expr: string | null
  next_run: string | null
  last_run: string | null
  run_count: number
  /** Typed JSON — read it with `parseCompletion`. Never free text. */
  on_complete: string
  created: number
  updated: number
  deleted: number | null
}

/** A row of `workflow_steps`. Steps are ordered rows, not a JSON column. */
export interface WorkflowStepRow {
  id: string
  workflow_id: string
  position: number
  title: string
  /** The bare slash line, delivered as its OWN submission. */
  command: string
  prompt: string
  /** JSON `[{path,name,size,mime}]` — read it with `parseFiles`. */
  files: string
  /** JSON `["gmail"]` — read it with `parseConnectors`. */
  connectors: string
  timeout_secs: number
  on_complete: string
  created: number
  updated: number
}

/** What every read handler returns: the workflow flattened, plus its steps. */
export interface WorkflowWithSteps extends WorkflowRow {
  steps: WorkflowStepRow[]
}

/** One chain execution. */
export interface WorkflowRunRow {
  id: number
  workflow_id: string
  started_at: number
  finished_at: number | null
  trigger: string
  /** `running` | `ok` | `error` | `timeout` | `interrupted` | `cancelled` | `skipped`. */
  status: string
  current_step: number
  note: string
  heartbeat: number
}

/** One step inside a run. `step_id` is deliberately not a foreign key — what
 *  actually ran survives an edit to what the workflow says now. */
export interface WorkflowStepRunRow {
  id: number
  run_id: number
  step_id: string
  position: number
  started_at: number
  finished_at: number | null
  status: string
  signal: string
  /** The PLAIN delivered line — never the `<supermux-…>` wrapper, never the
   *  confirm footer. The server strips both before it stores this. */
  preview: string
  note: string
}

/** A run joined with its workflow title — the cross-workflow activity feed. */
export interface WorkflowRunSummary {
  id: number
  workflow_id: string
  started_at: number
  finished_at: number | null
  status: string
  note: string
  title: string
  company_id: number | null
}

/** `GET /api/workflows/{id}/runs` — a run with its own step ledger. */
export interface WorkflowRunDetail {
  run: WorkflowRunRow
  steps: WorkflowStepRunRow[]
}

/** `GET /api/workflows/{id}` — the detail payload, last run riding along. */
export interface WorkflowDetailPayload {
  workflow: WorkflowRow
  steps: WorkflowStepRow[]
  last_run_summary: WorkflowRunRow | null
}

/** One REAL installed agent command for the step picker (skills + user/managed
 *  commands + claude.ai MCP connectors). Built-ins are excluded. */
export interface WorkflowCommand {
  cmd: string
  desc: string
  source: 'skill' | 'command' | 'mcp'
}

// ── input types ───────────────────────────────────────────────────────────────

/** One step as a writer supplies it. Ids and positions are the server's own. */
export interface StepInput {
  title?: string
  command?: string
  prompt: string
  files?: WorkflowFile[]
  connectors?: string[]
  timeout_secs?: number
  on_complete?: CompletionAction
}

export interface WorkflowCreateInput {
  title: string
  session: string
  /** Derived from `schedule_expr` when absent — the expression is the truth. */
  trigger_kind?: TriggerKind
  schedule_expr?: string | null
  on_complete?: CompletionAction
  steps: StepInput[]
  enabled?: boolean
}

/** PATCH payload. `session` is absent on purpose: a workflow cannot be moved to
 *  another bot (and therefore not to another company) after it is created. */
export interface WorkflowPatchInput {
  title?: string
  enabled?: boolean
  trigger_kind?: TriggerKind
  schedule_expr?: string
  on_complete?: CompletionAction
}

// ── errors ────────────────────────────────────────────────────────────────────

/** A workflows request that failed; carries the HTTP status so callers can
 *  branch on 400 (bad expression) vs 0 (unreachable) vs 404 vs 410 (stale
 *  bundle). */
export class WorkflowError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WorkflowError'
    this.status = status
  }
  /** The PWA is wedged on a bundle that predates the workflows cutover — the
   *  server answered a removed write verb with `410 Gone` (spec §5.2). */
  get gone(): boolean {
    return isStaleBundle(this.status)
  }
}

/** `410 Gone` is the ONE status that means "this client is out of date", not
 *  "this request was wrong". Pure so the branch is testable without a fetch. */
export function isStaleBundle(status: number): boolean {
  return status === 410
}

/** Surface the service-worker update prompt for a stale bundle. Guarded on a
 *  DOM so the client is importable from a unit test / SSR render. */
function notifyStaleBundle(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  void import('@/lib/sw-update').then((m) =>
    m.markWaiting(() => window.location.reload()),
  )
}

async function wfRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = apiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, headers })
  } catch {
    throw new WorkflowError('Can’t reach supermux-server.', 0)
  }
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    if (isStaleBundle(res.status)) notifyStaleBundle()
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status}).`
    throw new WorkflowError(message, res.status)
  }
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

const enc = encodeURIComponent

export const workflowsApi = {
  /** `GET /api/workflows` — everything the viewer may see, newest first.
   *  `session` narrows to one bot (the BotPanel scope). */
  list: (session?: string | null): Promise<WorkflowWithSteps[]> =>
    wfRequest(session ? `/api/workflows?session=${enc(session)}` : '/api/workflows'),

  /** `GET /api/workflows/{id}` — the workflow, its steps, and its last run. */
  get: (id: string): Promise<WorkflowDetailPayload> => wfRequest(`/api/workflows/${enc(id)}`),

  /** `POST /api/workflows` — create (201). */
  create: (input: WorkflowCreateInput): Promise<WorkflowWithSteps> =>
    wfRequest('/api/workflows', { method: 'POST', body: JSON.stringify(input) }),

  /** `PATCH /api/workflows/{id}` — title / enabled / trigger / completion. */
  patch: (id: string, patch: WorkflowPatchInput): Promise<WorkflowWithSteps> =>
    wfRequest(`/api/workflows/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** `PUT /api/workflows/{id}/steps` — replace the ordered list ATOMICALLY. */
  replaceSteps: (id: string, steps: StepInput[]): Promise<WorkflowStepRow[]> =>
    wfRequest(`/api/workflows/${enc(id)}/steps`, {
      method: 'PUT',
      body: JSON.stringify({ steps }),
    }),

  /** `DELETE /api/workflows/{id}` — soft delete. Past runs stay in the log. */
  remove: (id: string): Promise<{ deleted: boolean }> =>
    wfRequest(`/api/workflows/${enc(id)}`, { method: 'DELETE' }),

  /** `POST /api/workflows/{id}/run` — start the chain now (202). */
  run: (id: string): Promise<{ run_id: number }> =>
    wfRequest(`/api/workflows/${enc(id)}/run`, { method: 'POST' }),

  /** `POST /api/workflows/{id}/cancel` — stop the in-flight run (202). */
  cancel: (id: string): Promise<{ cancelled: boolean; run_id?: number }> =>
    wfRequest(`/api/workflows/${enc(id)}/cancel`, { method: 'POST' }),

  /** `GET /api/workflows/{id}/runs` — this workflow's history, newest first. */
  runs: (id: string, limit?: number): Promise<WorkflowRunDetail[]> =>
    wfRequest(
      limit
        ? `/api/workflows/${enc(id)}/runs?limit=${limit}`
        : `/api/workflows/${enc(id)}/runs`,
    ),

  /** `GET /api/workflows/runs` — the cross-workflow activity feed. */
  activity: (): Promise<WorkflowRunSummary[]> => wfRequest('/api/workflows/runs'),

  /** `POST /api/workflows/preview` — parse an expression WITHOUT persisting and
   *  get the next ≤5 fire times. This is what makes a cadence believable. */
  preview: (expression: string): Promise<{ next_runs: string[] }> =>
    wfRequest('/api/workflows/preview', {
      method: 'POST',
      body: JSON.stringify({ expression }),
    }),

  /** `GET /api/workflows/commands` — the REAL installed agent commands. */
  commands: (cwd?: string | null): Promise<WorkflowCommand[]> =>
    wfRequest(cwd ? `/api/workflows/commands?cwd=${enc(cwd)}` : '/api/workflows/commands'),
}

// ── stored-JSON readers ───────────────────────────────────────────────────────
//
// Three columns arrive as JSON TEXT (`files`, `connectors`, `on_complete`).
// Every reader is total: a malformed or future-shaped value degrades to the
// empty/none answer rather than throwing inside a render.

/** Read a step's `files` column. */
export function parseFiles(json: string | null | undefined): WorkflowFile[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    if (!Array.isArray(v)) return []
    return v.filter(
      (f): f is WorkflowFile => !!f && typeof f === 'object' && typeof f.path === 'string',
    )
  } catch {
    return []
  }
}

/** Read a step's `connectors` column. */
export function parseConnectors(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    if (!Array.isArray(v)) return []
    return v.filter((c): c is string => typeof c === 'string')
  } catch {
    return []
  }
}

/** The five kinds this client understands. A stored value outside this set is
 *  read back as `none` — the UI never invents an action it cannot show. */
const COMPLETION_KINDS = ['none', 'notify', 'disable', 'connector_send', 'message_bot']

/** Read an `on_complete` column into the typed union.
 *
 *  Each variant is NORMALIZED to a complete shape rather than cast blindly: a
 *  legacy/partial/hand-authored row (e.g. a `connector_send` with no `to`) once
 *  cast straight through as `{ to: undefined }`, and the render-time validator
 *  then crashed on `value.to.trim()` — a white-screen on the edit route. Filling
 *  the missing string fields here fixes it at the boundary, so the whole
 *  completion subtree (row inputs AND the sentence) receives well-formed values. */
export function parseCompletion(json: string | null | undefined): CompletionAction {
  if (!json || !json.trim()) return { kind: 'none' }
  try {
    const v = JSON.parse(json)
    if (!v || typeof v !== 'object' || typeof v.kind !== 'string') return { kind: 'none' }
    if (!COMPLETION_KINDS.includes(v.kind)) return { kind: 'none' }
    const str = (x: unknown): string => (typeof x === 'string' ? x : '')
    switch (v.kind) {
      case 'connector_send':
        return {
          kind: 'connector_send',
          connector_id: str(v.connector_id),
          account_ref: str(v.account_ref),
          to: str(v.to),
          subject: typeof v.subject === 'string' ? v.subject : null,
        }
      case 'message_bot':
        return { kind: 'message_bot', session: str(v.session) }
      default:
        // none / notify / disable carry no fields.
        return { kind: v.kind } as CompletionAction
    }
  } catch {
    return { kind: 'none' }
  }
}
