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
  /** Smart sign-in — the server can scan the page for a login form, focus a
   *  detected field, and type a secret into it on the trusted keystroke path.
   *  See `login-detect.ts` for the detector and `takeover-socket.ts` for the
   *  three verbs this gates. */
  signIn: boolean
}

/** An older server, or one that has not spoken yet. */
export const NO_CAPS: PageCaps = { find: false, copy: false, signIn: false }

/**
 * One `caps` frame → the flags. Total, like every other parse here: a garbled
 * frame degrades to "cannot", which is the safe direction.
 *
 * The wire is `takeover.rs`'s `ServerMsg::Caps`, serialised
 * `#[serde(rename_all = "snake_case")]` — so the third flag arrives as
 * **`sign_in`** (snake_case), pinned by that file's
 * `the_sign_in_answer_frames_are_the_shapes_the_client_parses` test. It is NOT
 * `signIn` on the wire; we read `sign_in` and expose `signIn`.
 */
export function parseCaps(msg: Record<string, unknown>): PageCaps {
  return {
    find: msg.find === true,
    copy: msg.copy === true,
    signIn: msg.sign_in === true,
  }
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

/* ── SMART SIGN-IN (phase 3 wiring) ──────────────────────────────────────────
 *
 * Three outbound verbs and one inbound answer, mirroring the find/copy plumbing
 * above. The detector itself lives in `login-detect.ts`; here we only shape the
 * wire and parse the server's reply.
 *
 * WIRE NAMES ARE THE SERVER'S, verified against
 * `connectors/browser/takeover.rs` (do NOT trust a summary — the enum is
 * `#[serde(rename_all = "snake_case")]`):
 *   · OUTBOUND `ClientMsg`: `{"type":"scan_login"}`,
 *     `{"type":"focus_field","selector":…}`,
 *     `{"type":"fill_field","selector":…,"value":…,"role":…}`.
 *   · INBOUND `ServerMsg::LoginFields`:
 *     `{"type":"login_fields","form":…,"reason":…,"fields":…,"otp":…,
 *       "multi_step":…,"frame_hint":…}` — note `multi_step`/`frame_hint` are
 *     **snake_case** on the wire; we map them to the camelCase `LoginScan`
 *     (`multiStep`/`frameHint`) the detector already owns.
 *   · INBOUND `Focused`/`Filled`: `{"type":"focused"|"filled","selector":…,
 *     "ok":…}`.
 */

// The one source of truth for the scan's shape is the detector; reuse it rather
// than redefining a parallel type (spec §1.1).
import type { LoginField, LoginScan } from './login-detect'
export type { LoginField, LoginScan } from './login-detect'

/** The wire shape of `ClientMsg::ScanLogin`. */
export function scanLoginPayload(): Record<string, unknown> {
  return { type: 'scan_login' }
}

/** The wire shape of `ClientMsg::FocusField`. */
export function focusFieldPayload(selector: string): Record<string, unknown> {
  return { type: 'focus_field', selector }
}

/**
 * The wire shape of `ClientMsg::FillField`. `value` is the secret; this function
 * only spells the frame — the socket sends it and NEVER parks it in state, so
 * the secret's whole lifetime is this one message (spec §5, "secret lifetime").
 */
export function fillFieldPayload(
  selector: string,
  value: string,
  role: string,
): Record<string, unknown> {
  return { type: 'fill_field', selector, value, role }
}

const LOGIN_REASONS: ReadonlySet<string> = new Set([
  'no-password-field',
  'all-hidden',
  'too-many-fields',
  'cross-origin-frame',
  'scan-error',
])
const MULTI_STEPS: ReadonlySet<string> = new Set([
  'combined',
  'username-only',
  'password-only',
])
const FIELD_ROLES: ReadonlySet<string> = new Set(['username', 'password', 'otp'])
const FIELD_SOURCES: ReadonlySet<string> = new Set([
  'autocomplete',
  'type',
  'adjacency',
  'keyword',
])

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function toLoginField(v: unknown): LoginField | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const selector = typeof o.selector === 'string' ? o.selector : ''
  if (!selector) return null
  const role = FIELD_ROLES.has(o.role as string)
    ? (o.role as LoginField['role'])
    : 'username'
  const source = FIELD_SOURCES.has(o.source as string)
    ? (o.source as LoginField['source'])
    : 'keyword'
  const r = (o.rect && typeof o.rect === 'object' ? o.rect : {}) as Record<string, unknown>
  return {
    selector,
    role,
    label: typeof o.label === 'string' ? o.label : '',
    visible: o.visible !== false,
    source,
    rect: { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) },
  }
}

function toOtp(v: unknown): LoginScan['otp'] {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const selector = typeof o.selector === 'string' ? o.selector : ''
  if (!selector) return null
  return { selector, label: typeof o.label === 'string' ? o.label : '' }
}

/**
 * One `login_fields` frame → a [[LoginScan]] for the snapshot. Total and
 * fail-closed: a garbled or hostile frame degrades to a disabled offer
 * (`form:false`) rather than a wrong one, and the three small vocabularies are
 * clamped to their known constants so a page cannot smuggle an arbitrary role,
 * reason or multi-step string past the server into our UI.
 *
 * Reads the server's **snake_case** `multi_step`/`frame_hint` and exposes the
 * detector's camelCase `multiStep`/`frameHint`.
 */
export function parseLoginScan(msg: Record<string, unknown>): LoginScan {
  const form = msg.form === true
  const fields =
    form && Array.isArray(msg.fields)
      ? (msg.fields.map(toLoginField).filter(Boolean) as LoginField[])
      : []
  const reasonRaw = typeof msg.reason === 'string' ? msg.reason : null
  const reason =
    !form && reasonRaw && LOGIN_REASONS.has(reasonRaw)
      ? (reasonRaw as LoginScan['reason'])
      : null
  const multiRaw = typeof msg.multi_step === 'string' ? msg.multi_step : ''
  const multiStep = (MULTI_STEPS.has(multiRaw) ? multiRaw : 'combined') as LoginScan['multiStep']
  const frameRaw = typeof msg.frame_hint === 'string' ? msg.frame_hint : null
  const frameHint =
    frameRaw === 'cross-origin-iframe' ? 'cross-origin-iframe' : null
  return {
    form,
    reason,
    fields,
    otp: form ? toOtp(msg.otp) : null,
    multiStep,
    frameHint,
  }
}
