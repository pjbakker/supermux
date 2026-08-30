// useCadencePreview — the server's answer to "when does this actually run".
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE PICKER. The green check and
// the next-fire list are a PROMISE that the schedule is real. A promise the
// client makes on its own is a promise it cannot keep: the grammar, the host's
// timezone and the DST walk all live in `parser.rs`, and any local matcher is
// at best an approximation of them. So the promise is only made once the server
// has answered, and this hook is the single place that knows whether it has.
//
// `cadence.ts`'s validators still run first — they repair phrasings and refuse
// obvious junk without a round-trip — but they decide what to SEND, never what
// to CLAIM.
//
// The one case that must NOT block the user: the preview endpoint being
// unreachable. A preview outage turning into "you cannot save a workflow" is a
// worse failure than saving a cadence the server will re-validate anyway, so
// `unverified` says so quietly and gets out of the way.

import * as React from 'react'

import { WorkflowError, workflowsApi } from '@/lib/api/workflows'

export type CadenceStatus =
  /** Nothing to check (manual, or an empty field). */
  | 'idle'
  /** Waiting on the server — the check is debounced. */
  | 'checking'
  /** The server returned real fire times. The ONLY status that may promise. */
  | 'ok'
  /** The server refused the expression, and said why. */
  | 'rejected'
  /** We could not reach the server. Not the user's problem: do not block them. */
  | 'unverified'

export interface CadenceCheck {
  status: CadenceStatus
  /** The next ≤5 fire times, only ever populated when `status === 'ok'`. */
  runs: string[]
  /** The server's own sentence, when it refused. */
  error: string | null
}

export const CADENCE_IDLE: CadenceCheck = { status: 'idle', runs: [], error: null }

interface Snapshot {
  /** WHICH expression this snapshot answers — the reason `checking` and the
   *  cleared state can be derived during render instead of written by the
   *  effect, and the reason the previous cadence's fire times never sit under a
   *  newly typed one. */
  expr: string
  runs: string[]
  error: string | null
  unreachable: boolean
}

const EMPTY: Snapshot = { expr: '', runs: [], error: null, unreachable: false }

/** Debounced `POST /api/workflows/preview` for one expression. */
export function useCadencePreview(
  expr: string | null,
  previewFn: (expression: string) => Promise<{ next_runs: string[] }> = workflowsApi.preview,
): CadenceCheck {
  const [snap, setSnap] = React.useState<Snapshot>(EMPTY)

  React.useEffect(() => {
    if (!expr) return
    let live = true
    const t = setTimeout(() => {
      previewFn(expr)
        .then((r) => {
          if (live) setSnap({ expr, runs: r.next_runs ?? [], error: null, unreachable: false })
        })
        .catch((e: unknown) => {
          if (!live) return
          // status 0 is "we never reached the server" — a different fact from
          // "the server said no", and the only one that must not block a save.
          const unreachable = e instanceof WorkflowError && e.status === 0
          setSnap({ expr, runs: [], error: (e as Error).message, unreachable })
        })
    }, 320)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [expr, previewFn])

  return React.useMemo(() => cadenceCheck(expr, snap), [expr, snap])
}

/** The state machine, pure — so every branch is asserted without a network. */
export function cadenceCheck(expr: string | null, snap: Snapshot): CadenceCheck {
  if (!expr) return CADENCE_IDLE
  if (snap.expr !== expr) return { status: 'checking', runs: [], error: null }
  if (snap.unreachable) return { status: 'unverified', runs: [], error: null }
  if (snap.error) return { status: 'rejected', runs: [], error: snap.error }
  if (snap.runs.length === 0) {
    // A parseable expression that never fires is still not a schedule.
    return { status: 'rejected', runs: [], error: 'That never actually comes round.' }
  }
  return { status: 'ok', runs: snap.runs, error: null }
}

/** What blocks Save, in the words the footer says. `null` means "go". */
export function cadenceProblem(check: CadenceCheck): string | null {
  switch (check.status) {
    case 'checking':
      return 'Working out when that runs…'
    case 'rejected':
      return check.error ?? 'Couldn’t understand that schedule'
    // `idle` is manual (nothing to check) and `unverified` is our outage, not
    // the user's mistake. Neither blocks.
    default:
      return null
  }
}
