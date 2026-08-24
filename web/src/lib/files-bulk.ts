// The honest summary line for a bulk file action.
//
// Files' bulk bar fans out N single verbs at concurrency 4 (`mapWithLimit`) and
// reports the outcome in ONE toast. The rule this module encodes — files v1
// spec §4.5 — is that a partial failure is reported AS a partial failure:
//
//   • never rounded up to success ("Moved 5 items" when one 409'd),
//   • never rolled back (there is nothing to roll back to — the moves that
//     succeeded really did happen),
//   • and the REASON is the server's own words, not a generic "something went
//     wrong". `destination exists` is actionable; "failed" is not.
//
// Pure: no DOM, no toast import, no fetch — the toast call site just renders
// what this returns, and this is what the unit tests pin.

import type { Settled } from '@/lib/concurrency'

/** The verbs the bulk bar offers. The value is the PAST tense used in the
 *  summary ("4 moved"), which is why it is a map and not a `toLowerCase()`. */
export const BULK_VERB_PAST = {
  move: 'moved',
  copy: 'copied',
  download: 'downloaded',
  delete: 'deleted',
} as const

export type BulkVerb = keyof typeof BULK_VERB_PAST

export interface BulkSummary {
  message: string
  /** `error` the moment ANYTHING failed — a partial failure is not a success
   *  with a footnote, and the toast tone is the first thing the user reads. */
  tone: 'default' | 'error'
  ok: number
  failed: number
}

/** The message a rejected item contributes. An `Error` (incl. `FsError`, which
 *  carries the server's `{error}` string) reports its message; anything else
 *  degrades to a truthful placeholder rather than `[object Object]`. */
function reasonOf(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message
  if (typeof reason === 'string' && reason) return reason
  return 'unknown error'
}

/**
 * Turn N settled outcomes into one line.
 *
 *   all ok        → `"4 moved"`
 *   partial       → `"4 moved · 1 failed: destination exists"`
 *   mixed reasons → `"1 copied · 3 failed: destination exists (+1 other reason)"`
 *   nothing ok    → `"0 moved · 3 failed: permission denied"`
 *
 * When the failures disagree, the first reason is shown and the count is of
 * OTHER DISTINCT REASONS — `(+1 other reason)` says "there is one more kind of
 * failure here", which is a claim that is true. `(+1 more)` would be read as
 * "one more failure", which for 3 failures sharing 2 reasons is not.
 */
export function summarizeBulk<R>(
  verb: BulkVerb,
  results: readonly Settled<R>[],
): BulkSummary {
  const past = BULK_VERB_PAST[verb]
  const reasons: string[] = []
  let ok = 0
  for (const r of results) {
    // A slot can be undefined only if a caller hands us a sparse array; treat
    // that as a failure with an honest reason rather than counting it as ok.
    if (r && r.status === 'fulfilled') ok += 1
    else reasons.push(reasonOf(r ? r.reason : undefined))
  }
  const failed = reasons.length
  if (failed === 0) {
    return { message: `${ok} ${past}`, tone: 'default', ok, failed }
  }
  const first = reasons[0]!
  const others = new Set(reasons.filter((r) => r !== first)).size
  const detail =
    others > 0
      ? `${first} (+${others} other reason${others === 1 ? '' : 's'})`
      : first
  return {
    message: `${ok} ${past} · ${failed} failed: ${detail}`,
    tone: 'error',
    ok,
    failed,
  }
}

/** The destination path a bulk Move/Copy of `name` into `dir` targets. Kept
 *  here (and not inlined at the call site) because the bulk bar, the row menu's
 *  Move…/Copy… and the tests must agree on exactly one join. */
export function bulkTarget(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/**
 * The name "Duplicate" proposes: `report.md` → `report (copy).md`, and on a
 * 409 retry `report (copy 2).md`, `report (copy 3).md`, …
 *
 * `attempt` is 1-based (the first try). A dotfile with no stem (`.env`) keeps
 * its whole name as the stem, so it becomes `.env (copy)` and not `(copy).env`.
 */
export function duplicateName(name: string, attempt: number): string {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const stem = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  const tag = attempt <= 1 ? '(copy)' : `(copy ${attempt})`
  return `${stem} ${tag}${ext}`
}
