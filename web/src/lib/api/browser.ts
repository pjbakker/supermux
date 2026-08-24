// The shared-browser WORKSPACE client — the human's tab CRUD + per-tab grants.
//
// Mirrors `server/src/connectors/browser/api.rs` (the BEARER door) exactly; the
// agent's door (`/api/hook/browser/*`, hook-token) is deliberately somewhere
// else and this module never touches it. Every call rides the same
// `settingsRequest` the rest of the app uses — one fetch discipline, one bearer,
// one `ApiError` carrying the status code.
//
// HONESTY LIVES HERE, NOT IN THE COMPONENTS. A tab has two orthogonal states —
// *persisted* (the row: id/title/url/pinned/grants/login_state) and *live* (a
// CDP target inside a running Chrome). A tab that is not `live` is DEHYDRATED,
// not lost, and a tab whose `login_state` is `needs_login` must read as such
// wherever it is drawn. `tabState()` below is the single place that resolves
// those two axes into one label + tone, so no surface can invent a green dot
// (spec §7.3).

import { settingsRequest } from './client'
import { ALL_AGENTS, COMPANY_PREFIX } from './connectors'

// ── wire types (mirror the Rust `tab_json` / `TabGrant`) ─────────────────────

/** `ok` | `needs_login` | `unknown` — `db::browser_tabs::LOGIN_*`. */
export type LoginState = 'ok' | 'needs_login' | 'unknown'

/** One grantee of one tab. The keyspace is the connector store's, unchanged:
 *  a bot slug, `@company:<id>`, or the `*` all-agents sentinel. */
export interface TabGrant {
  tab_id: string
  grantee: string
  /** SQLite integer bool — `0` is a grant that exists but is switched off. */
  enabled: number
  granted_at: number
}

/** One workspace tab, as `GET /api/browser/tabs` renders it. */
export interface BrowserTab {
  id: string
  title: string
  url: string
  pinned: boolean
  /** Owning company (`null` = HQ / global). The containment axis of §8.3. */
  company_id: number | null
  /** Host rules — an exact host, or a leading-dot suffix the human opted into. */
  origins: string[]
  login_state: LoginState
  /** Unix seconds of the last probe, or `null` when nothing has ever checked. */
  last_probe_at: number | null
  /** Transient: a live CDP target exists right now. `false` = dehydrated. */
  live: boolean
  grants: TabGrant[]
  created_at: number
  last_used_at: number | null
}

interface TabsResponse {
  tabs: BrowserTab[]
}
interface GrantsResponse {
  grants: TabGrant[]
}

// ── the seven endpoints ──────────────────────────────────────────────────────

function enc(id: string): string {
  return encodeURIComponent(id)
}

/** `GET /api/browser/tabs` — EVERY tab. The human owns the browser and sees all
 *  of it; the grant-filtered view is the agent's (`browser_list_tabs`). */
export async function listTabs(): Promise<BrowserTab[]> {
  const r = await settingsRequest<TabsResponse>('/api/browser/tabs')
  return r.tabs ?? []
}

/** `POST /api/browser/tabs` — mint a tab row, seeded with the exact host of its
 *  first URL. Does NOT open the page (lazy start: Chrome spawns on first use). */
export async function createTab(
  url: string,
  companyId?: number | null,
): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>('/api/browser/tabs', {
    method: 'POST',
    body: JSON.stringify({ url, company_id: companyId ?? null }),
  })
}

export async function getTab(id: string): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs/${enc(id)}`)
}

/** The patchable half. `origins` and `login_state` are HUMAN acts — an agent can
 *  never widen an allowlist or clear a stale sign-in state. */
export interface TabPatch {
  title?: string
  url?: string
  pinned?: boolean
  origins?: string[]
  login_state?: LoginState
}

/** `PATCH /api/browser/tabs/{id}` — pin/unpin, rename, re-scope, clear a state. */
export async function patchTab(id: string, patch: TabPatch): Promise<BrowserTab> {
  return settingsRequest<BrowserTab>(`/api/browser/tabs/${enc(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** `DELETE /api/browser/tabs/{id}` — closes the target and drops the row.
 *
 *  **This signs nothing out.** The cookies live in one shared profile; the
 *  honest eraser is the profile reset. The server says so in its response and
 *  the UI must repeat it rather than implying a delete is a sign-out (§8.5). */
export interface DeleteTabResult {
  deleted: boolean
  cookies_cleared: boolean
  note: string
}
export async function deleteTab(id: string): Promise<DeleteTabResult> {
  return settingsRequest<DeleteTabResult>(`/api/browser/tabs/${enc(id)}`, {
    method: 'DELETE',
  })
}

export async function tabGrants(id: string): Promise<TabGrant[]> {
  const r = await settingsRequest<GrantsResponse>(`/api/browser/tabs/${enc(id)}/grants`)
  return r.grants ?? []
}

/** `POST /api/browser/tabs/{id}/grant` — lend ONE tab to ONE grantee.
 *  Cross-company grants are refused server-side with a 400 (§8.3), so the
 *  `ApiError` this throws is the honest answer, not a UI guess. */
export async function grantTab(
  id: string,
  grantee: string,
  enabled = true,
): Promise<TabGrant[]> {
  const r = await settingsRequest<GrantsResponse>(`/api/browser/tabs/${enc(id)}/grant`, {
    method: 'POST',
    body: JSON.stringify({ grantee, enabled }),
  })
  return r.grants ?? []
}

/** `DELETE /api/browser/tabs/{id}/grant/{grantee}`. */
export async function revokeTabGrant(id: string, grantee: string): Promise<TabGrant[]> {
  const r = await settingsRequest<GrantsResponse>(
    `/api/browser/tabs/${enc(id)}/grant/${enc(grantee)}`,
    { method: 'DELETE' },
  )
  return r.grants ?? []
}

// ── derived, pure, and tested ────────────────────────────────────────────────

/** The host of a tab's URL, for the chip and the address bar. Falls back to the
 *  raw string rather than throwing — a half-typed URL still has to render. */
export function tabHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** `https:` ⇒ the padlock is honest. Anything else (http, about:blank, a typo)
 *  is NOT drawn as secure. */
export function isSecure(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** How the tab reads, in one word for the dot and one line for the human.
 *
 *  `tone` drives colour ONLY: `needs-login` amber, `ok` green, `dehydrated`
 *  slate, `unknown` slate. The order below is the honesty order — a
 *  `needs_login` tab says so even while it is live, and a live-but-never-probed
 *  tab never claims to be signed in. */
export type TabTone = 'ok' | 'needs-login' | 'dehydrated' | 'unknown'

export interface TabState {
  tone: TabTone
  /** Short, for the chip's `title` + the sheet's header. */
  label: string
  /** The evidence and its age — never a bare green dot (§7.3). */
  detail: string
}

/** `now` is injectable so the age line is testable without a clock. */
export function tabState(tab: BrowserTab, now: number = Date.now() / 1000): TabState {
  const age = tab.last_probe_at === null ? null : ago(now - tab.last_probe_at)
  if (tab.login_state === 'needs_login') {
    return {
      tone: 'needs-login',
      label: 'Sign-in needed',
      // A restart is the single most common cause and the one the human can do
      // nothing about, so name it rather than leaving them hunting (§7.1a).
      detail: tab.live
        ? `Signed out${age ? ` — seen ${age}` : ''}. Take the wheel and sign in again.`
        : 'Signed out by a browser restart. Open the tab and sign in again.',
    }
  }
  if (!tab.live) {
    return {
      tone: 'dehydrated',
      label: 'Asleep',
      // Deliberately NOT "open it to come back": nothing on the human's API
      // rehydrates a tab (the takeover socket refuses to, on purpose — a viewer
      // must not be able to spawn Chrome). The next agent verb or keep-alive
      // wakes it, and saying otherwise would offer a button that cannot exist.
      detail:
        'Not open right now. The sign-in is kept on disk; the tab wakes the next time a granted agent uses it.',
    }
  }
  if (tab.login_state === 'ok') {
    return {
      tone: 'ok',
      label: 'Signed in',
      detail: age ? `Signed in · verified ${age}` : 'Signed in · not verified yet',
    }
  }
  return {
    tone: 'unknown',
    label: 'Not verified',
    detail: 'Open, but nothing has checked whether the sign-in is still good.',
  }
}

/** "6 min ago" / "just now" — seconds in, one short phrase out. Negative (a
 *  clock skew) reads as "just now" rather than a time-travelling probe. */
export function ago(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 45) return 'just now'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Pinned first, then most-recently-used, then title — the rail's order. Pure,
 *  so the strip never sorts differently from the sheet's list. */
export function sortTabs(tabs: BrowserTab[]): BrowserTab[] {
  return [...tabs].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const au = a.last_used_at ?? a.created_at
    const bu = b.last_used_at ?? b.created_at
    if (au !== bu) return bu - au
    return (a.title || a.url).localeCompare(b.title || b.url)
  })
}

/** A bare host typed into the new-tab box becomes `https://…`; anything already
 *  carrying a scheme is left alone, and a NON-http scheme (`javascript:`,
 *  `file:`) is refused outright rather than handed to the server to reject —
 *  the one place a typo could become a scheme the workspace never opens. */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  return `https://${raw}`
}

/** How a grantee reads to a human. The keyspace is the connector store's,
 *  unchanged: a bot slug, `@company:<id>`, or the `*` all-agents sentinel. */
export function granteeLabel(grantee: string, companyName?: string): string {
  if (grantee === ALL_AGENTS) return 'All agents'
  if (grantee.startsWith(COMPANY_PREFIX)) return companyName ?? 'This company'
  return grantee
}

/** The grants that actually confer access — a row with `enabled = 0` exists but
 *  grants nothing, and drawing it as a grantee would be a lie about the blast
 *  radius. */
export function activeGrantees(tab: BrowserTab): string[] {
  return tab.grants.filter((g) => g.enabled !== 0).map((g) => g.grantee)
}

/** A bot the workspace could lend a tab to. `company_id` is what decides
 *  whether the SERVER will accept it — see [[grantCandidates]]. */
export interface GrantCandidate {
  name: string
  company_id: number | null
}

/**
 * The bots the server will actually accept for THIS tab.
 *
 * `api.rs::grant_handler` refuses (400) unless
 * `company_of_grant_target(grantee) == tab.company_id`, and `has_tab_grant`
 * re-checks the same predicate on every agent call — a tab is never shared
 * across companies. Offering a bot from another company is therefore not a
 * hole (the server holds), it is a control that can only ever fail, so it is
 * not offered.
 */
export function grantCandidates(bots: GrantCandidate[], tab: BrowserTab): GrantCandidate[] {
  const owner = tab.company_id ?? null
  return bots.filter((b) => (b.company_id ?? null) === owner)
}

/** `company_of_grant_target('*')` resolves to NO company, so the all-agents
 *  sentinel is a legal target only for an HQ tab (`company_id === null`). On a
 *  company-owned tab the tier is hidden rather than drawn and refused. */
export function mayGrantAll(tab: BrowserTab): boolean {
  return (tab.company_id ?? null) === null
}
