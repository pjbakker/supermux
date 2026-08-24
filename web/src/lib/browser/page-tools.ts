/**
 * FIND-IN-PAGE AND COPY-OUT — the two verbs that need the page's DOM, and the
 * feature check that keeps them from lying about it.
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything else in this browser is pixels and input events. These two are
 * not: a find needs the page's TEXT and a copy needs its SELECTION, and both
 * live inside the chrome the server is holding, not inside the JPEG we are
 * painting. So both are the one shape a client must never fake.
 *
 * ── WHAT THE SERVER STILL OWES, EXACTLY ──────────────────────────────────────
 *
 * `connectors/browser/takeover.rs` has no arm for either verb today. Three
 * frames close the gap, and all three are small because CDP already does the
 * work:
 *
 *   1. `ClientMsg::Find { query, forward, case_sensitive }`
 *        → `DOM.performSearch` (or `Page.searchInResource`), keep the
 *          `searchId` on the relay, `DOM.getSearchResults` for the hit, then
 *          `DOM.scrollIntoViewIfNeeded` + an overlay highlight.
 *        ← `ServerMsg::FindResult { query, index, total }`
 *   2. `ClientMsg::FindClose` → `DOM.discardSearchResults`, so a relay does not
 *      leak a search per keystroke.
 *   3. `ClientMsg::Copy` → `Runtime.evaluate("getSelection().toString()")` in
 *      the page's own world.
 *        ← `ServerMsg::Copied { text }` — and this one needs a LENGTH CAP on
 *          the server (a selected page can be megabytes) and a note in the
 *          grant sheet, because "copy the selection" is a read of a signed-in
 *          page's content flowing to whoever is watching.
 *   4. `ServerMsg::Caps { find, copy }`, sent once after `auth_ok`. THE
 *      IMPORTANT ONE: without it the client cannot tell "the server does not
 *      do this" from "the server did not answer yet", and a find bar that
 *      spins forever against an older server is worse than one that says it
 *      cannot.
 *
 * ── HOW IT DEGRADES UNTIL THEN ───────────────────────────────────────────────
 *
 * No `caps` frame → [[NO_CAPS]] → both verbs are DISABLED with the reason
 * written on them, and nothing is ever put on the wire that the server would
 * silently drop. `Copy current URL` is exempt and works today, because the url
 * is a fact this client already holds — which is why the find bar ships with
 * one control that works and one that explains itself, rather than with two
 * that pretend.
 */

/** What this relay can do beyond pixels. Every flag defaults FALSE: a missing
 *  frame is "no", never "probably". */
export interface PageCaps {
  find: boolean
  copy: boolean
}

/** An older server, or one that has not spoken yet. */
export const NO_CAPS: PageCaps = { find: false, copy: false }

/** One `caps` frame → the flags. Total, like every other parse here: a garbled
 *  frame degrades to "cannot", which is the safe direction. */
export function parseCaps(msg: Record<string, unknown>): PageCaps {
  return { find: msg.find === true, copy: msg.copy === true }
}

/** Where a find is: the query the SERVER answered for, and the position in its
 *  own result set. `total: 0` with a non-empty query is "no matches". */
export interface FindResult {
  query: string
  /** 1-based, the way every find bar in the world counts. 0 = no current hit. */
  index: number
  total: number
}

export const NO_FIND: FindResult = { query: '', index: 0, total: 0 }

export function parseFindResult(msg: Record<string, unknown>): FindResult {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
  const total = Math.max(0, n(msg.total))
  return {
    query: typeof msg.query === 'string' ? msg.query : '',
    index: Math.min(Math.max(0, n(msg.index)), total),
    total,
  }
}

/** The wire shape of `ClientMsg::Find`, spelled in the server's snake_case so
 *  the day it is implemented this file needs no edit. */
export function findPayload(
  query: string,
  opts: { forward?: boolean; caseSensitive?: boolean } = {},
): Record<string, unknown> {
  return {
    type: 'find',
    query,
    forward: opts.forward !== false,
    case_sensitive: !!opts.caseSensitive,
  }
}

export function findClosePayload(): Record<string, unknown> {
  return { type: 'find_close' }
}

export function copyPayload(): Record<string, unknown> {
  return { type: 'copy' }
}

/** The count, as the bar shows it. Three states, and the empty query is one of
 *  them — "0/0" over an empty field reads as "nothing matches", which is a
 *  claim about a search nobody has run. */
export function findLabel(result: FindResult, query: string, searching: boolean): string {
  if (!query) return ''
  if (searching && result.query !== query) return '…'
  if (result.query !== query) return '…'
  if (result.total === 0) return 'No matches'
  return `${result.index}/${result.total}`
}

/**
 * Put text on the clipboard. `navigator.clipboard` is absent on http origins
 * and inside some webviews, so the legacy path stays — a copy button that
 * silently does nothing is the papercut this whole file exists to avoid.
 * Returns whether it actually landed, so the caller can say so honestly.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
