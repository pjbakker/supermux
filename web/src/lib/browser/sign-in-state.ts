/**
 * The smart sign-in STATE MACHINE, kept pure (spec §3).
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Everything the field-aware sheet decides — is the control usable, is the
 * auto-map confident, which detected selector carries which role, and what a
 * per-site recipe remembers — lives here as data-in/data-out functions, so it is
 * a unit test rather than a thing you can only see by driving a real browser.
 * The React shell (`sign-in-sheet.tsx`) only renders these answers and collects
 * the secret; the panel (`takeover-panel.tsx`) only relays the fills.
 *
 * THE ONE HONESTY RULE THAT OUTRANKS THE REST (spec §3.5): the gate is computed
 * from `caps.signIn` + the scan, never from a label or a look. No fields → the
 * control is DISABLED with the reason on it; an older server with no caps → the
 * blind text/Tab path, never a spinner against a verb it will never answer.
 */

import type { LoginField, LoginScan } from './login-detect'

/** A role the user can assign in the mapper. `ignore` drops the field from the
 *  fill entirely — the "that's not a credential" escape (spec §3.3). */
export type FieldRole = 'username' | 'password' | 'otp' | 'ignore'

/** One row of the field-mapper: a detected field, its detector guess, and the
 *  role currently chosen for it (guess, recipe, or a user override). */
export interface RoleChoice {
  selector: string
  label: string
  /** What the detector (or the per-site recipe) proposed. */
  guess: FieldRole
  /** What will be filled — starts at `guess`, changes when the user picks. */
  role: FieldRole
  /** For provenance/telemetry only — the detector's winning signal. */
  source: LoginField['source'] | 'otp' | 'recipe'
}

/**
 * Whether the Sign-in control is usable, and if not, why — the whole of the
 * owner's "shouldn't be usable when there are no fields", computed honestly.
 *
 *   · `blind`    — no `caps.signIn` (older server): today's text/Tab path. The
 *                  control stays enabled; the sheet degrades, it does not spin.
 *   · `ready`    — capable, and either a login form is detected or the scan has
 *                  not answered yet (we never claim "no form" before we know).
 *   · `frame`    — the form is in a cross-origin iframe we cannot script: the
 *                  control opens the blind Password-only path with the reason.
 *   · `disabled` — the scan came back `form:false`: DISABLED, reason shown.
 */
export type SignInGate =
  | { kind: 'blind' }
  | { kind: 'ready' }
  | { kind: 'frame'; reason: string }
  | { kind: 'disabled'; reason: string }

/** The human sentence for each `form:false` reason / a cross-origin frame. Kept
 *  here (not in JSX) so the wording is asserted in a test and cannot rot. */
export function reasonText(
  reason: LoginScan['reason'] | 'scan-error',
  frameHint: LoginScan['frameHint'],
): string {
  if (frameHint === 'cross-origin-iframe' || reason === 'cross-origin-frame') {
    return 'The sign-in form is in an embedded frame — focus it and use Password only'
  }
  switch (reason) {
    case 'all-hidden':
      return 'No sign-in fields are visible on this page'
    case 'too-many-fields':
      return 'Too many fields to read safely — focus a field and use Password only'
    case 'scan-error':
      return "Couldn't read this page's fields — focus a field and use Password only"
    case 'no-password-field':
    default:
      return 'No sign-in fields on this page'
  }
}

/** The gate (spec §3.1). Fail-closed: a `form:false` scan disables the offer,
 *  and only a present `caps.signIn` unlocks the field-aware path at all. */
export function signInGate(capsSignIn: boolean, scan: LoginScan | null): SignInGate {
  if (!capsSignIn) return { kind: 'blind' }
  if (scan && !scan.form) {
    const reason = reasonText(scan.reason, scan.frameHint)
    if (scan.frameHint === 'cross-origin-iframe' || scan.reason === 'cross-origin-frame') {
      return { kind: 'frame', reason }
    }
    return { kind: 'disabled', reason }
  }
  return { kind: 'ready' }
}

/** A signup/change page whose only password is `new-password` — detected as a
 *  form, but nothing is fillable (spec §1.3(d)). The sheet says so and offers
 *  the blind path, never a wrong credential into a new-password field. */
export function isGenerateOnly(scan: LoginScan | null): boolean {
  return !!scan && scan.form && scan.fields.length === 0 && scan.generateOnly === true
}

/**
 * Is the auto-map UNSURE enough to open the mapper unprompted (spec §3.3)?
 *
 * The detector always returns its single best guess per role, so "ambiguous"
 * here means low CONFIDENCE, read off the winning `source`: an `autocomplete`
 * token or a typed `type=email`/`type=password` is authoritative; an
 * `adjacency` or `keyword` guess is the detector reaching, and exactly when the
 * human should get to confirm. A `combined` form that resolved no username is
 * also ambiguous (we expected one and did not find it).
 */
export function isAmbiguous(scan: LoginScan | null): boolean {
  if (!scan || !scan.form) return false
  if (isGenerateOnly(scan)) return false
  const hasUser = scan.fields.some((f) => f.role === 'username')
  if (scan.multiStep === 'combined' && !hasUser) return true
  return scan.fields.some((f) => f.source === 'adjacency' || f.source === 'keyword')
}

/** host → the selectors the user last confirmed for it (spec §3.3, mirroring
 *  Firefox password-recipes). Consulted BEFORE the detector's guesses. */
export interface LoginRecipe {
  username?: string
  password?: string
  otp?: string
}

const RECIPE_KEY = 'supermux.signin.recipes'

/** The bare host of a page url, for provenance + as the recipe key. Empty on a
 *  url we cannot parse — an empty host never keys a recipe. */
export function hostOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** All stored recipes, or `{}` — every read tolerant of blocked/absent storage
 *  (a private window, a webview with site-data off) so the sheet still works. */
function readAll(): Record<string, LoginRecipe> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(RECIPE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, LoginRecipe>) : {}
  } catch {
    return {}
  }
}

/** The recipe for a host, or `null`. */
export function loadRecipe(host: string): LoginRecipe | null {
  if (!host) return null
  const all = readAll()
  const r = all[host]
  return r && typeof r === 'object' ? r : null
}

/** Persist a host's recipe. A no-op (never a throw) when storage is blocked —
 *  the fill still happened, only the memory of it is lost. */
export function saveRecipe(host: string, recipe: LoginRecipe): void {
  if (!host) return
  // Nothing worth remembering — do not park an empty object per host.
  if (!recipe.username && !recipe.password && !recipe.otp) return
  try {
    if (typeof localStorage === 'undefined') return
    const all = readAll()
    all[host] = recipe
    localStorage.setItem(RECIPE_KEY, JSON.stringify(all))
  } catch {
    /* blocked storage — the fill is unaffected */
  }
}

/**
 * The mapper's starting rows (spec §3.3): every detected field + the OTP field,
 * each pre-filled with its guess. A per-site recipe is consulted FIRST — a
 * field whose selector the recipe remembers takes the recipe's role, overriding
 * the heuristic — so a correction sticks across visits.
 */
export function initialChoices(
  scan: LoginScan | null,
  recipe: LoginRecipe | null,
): RoleChoice[] {
  if (!scan || !scan.form) return []
  const rows: RoleChoice[] = []
  for (const f of scan.fields) {
    rows.push({
      selector: f.selector,
      label: f.label || f.selector,
      guess: f.role,
      role: f.role,
      source: f.source,
    })
  }
  if (scan.otp) {
    rows.push({
      selector: scan.otp.selector,
      label: scan.otp.label || scan.otp.selector,
      guess: 'otp',
      role: 'otp',
      source: 'otp',
    })
  }
  if (!recipe) return rows
  // Recipe overrides the heuristic where the selector still exists on the page.
  const bySelector = (sel: string | undefined, role: FieldRole) => {
    if (!sel) return
    const row = rows.find((r) => r.selector === sel)
    if (row) {
      row.guess = role
      row.role = role
      row.source = 'recipe'
    }
  }
  bySelector(recipe.username, 'username')
  bySelector(recipe.password, 'password')
  bySelector(recipe.otp, 'otp')
  return rows
}

/** One field to type a secret into: the detected selector, the value, and the
 *  role the server re-checks before it types (spec §3.5.3). */
export interface DetectedFill {
  selector: string
  value: string
  role: 'username' | 'password' | 'otp'
}

/**
 * The ordered fills a confirmed mapping becomes: username, then password, then
 * otp — each only when the human actually supplied a value for that role. An
 * `ignore` row, or a role with no value, contributes nothing (so a blank field
 * is never a write, and a password is never scoped to a username input).
 */
export function buildFills(
  choices: RoleChoice[],
  values: { username: string; password: string; otp: string },
): DetectedFill[] {
  const pick = (role: 'username' | 'password' | 'otp'): DetectedFill | null => {
    const value = values[role]
    if (!value) return null
    const row = choices.find((c) => c.role === role)
    if (!row) return null
    return { selector: row.selector, value, role }
  }
  const order: ('username' | 'password' | 'otp')[] = ['username', 'password', 'otp']
  const fills: DetectedFill[] = []
  for (const role of order) {
    const f = pick(role)
    if (f) fills.push(f)
  }
  return fills
}

/** The recipe a confirmed mapping teaches — the selector chosen for each role.
 *  `ignore` rows are omitted; the first row wins a role picked twice. */
export function recipeFromChoices(choices: RoleChoice[]): LoginRecipe {
  const recipe: LoginRecipe = {}
  for (const c of choices) {
    if (c.role === 'username' && !recipe.username) recipe.username = c.selector
    else if (c.role === 'password' && !recipe.password) recipe.password = c.selector
    else if (c.role === 'otp' && !recipe.otp) recipe.otp = c.selector
  }
  return recipe
}
