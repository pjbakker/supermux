/**
 * THE LIVE ADDRESS BAR — one page's nav state, as the socket reports it.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the client half of `ServerMsg::NavState` (`connectors/browser/
 * takeover.rs`), whose wire shape is pinned by a Rust test precisely because
 * this file parses those names:
 *
 *   {"type":"nav_state","url":…,"title":…,"favicon":…,"loading":…,
 *    "can_go_back":…,"can_go_forward":…,"secure":…,"dialog":…}
 *
 * It REPLACES the fire-once `target` frame as the omnibox's feed. `target` is a
 * snapshot taken at attach; a page that navigates itself (a redirect, an OAuth
 * hop, an agent clicking a link) leaves it stale within seconds, and a stale
 * address bar over a live page is the same class of lie as a green dot over an
 * expired sign-in.
 *
 * THREE THINGS ARE DELIBERATELY DEFENSIVE HERE:
 *
 *  1. **The parse is total.** Every field is optional on the way in and has a
 *     falsy default on the way out. A nav frame from an older server, or one
 *     that lost a field to a serde rename, must degrade to "we don't know" —
 *     greyed arrows, a globe, no spinner — never to a thrown exception inside
 *     a socket `onmessage`, which would take the whole relay down.
 *
 *  2. **The favicon is untrusted input.** It is a `data:` URI the SERVER read
 *     out of the page, which means the page chose its bytes. `safeFavicon`
 *     admits `data:image/*` and `https:` and nothing else — no `javascript:`,
 *     no `data:text/html`, and no `http:` (a mixed-content icon that leaks the
 *     fact that this profile is on that site). An `<img>` does not execute SVG
 *     script, but "does not execute" is a property of the sink, and this is the
 *     cheaper place to be sure.
 *
 *  3. **`secure` is the SERVER's claim, not ours.** `isSecure()` (the url-only
 *     guess) is what the bar falls back to when nothing is attached; when the
 *     socket is live, `secure` off the feed wins, because it is derived where
 *     the connection actually is. Both are transport-only claims: neither says
 *     the certificate is trusted, so neither may be drawn as if it did.
 */

/** The modal blocking the page right now — CDP's `Page.javascriptDialogOpening`,
 *  relayed. Mirrors `context::PageDialog`. */
export interface PageDialog {
  /** `alert` | `confirm` | `prompt` | `beforeunload`. */
  kind: string
  message: string
  /** The prefilled value of a `prompt()`; empty for the other kinds. */
  default_prompt: string
}

/** What the chrome renders from while a socket is attached. */
export interface NavState {
  url: string
  title: string
  /** A `data:` URI, already filtered by [[safeFavicon]]. `null` = draw the
   *  fallback tile; never a stale icon for a site the human left. */
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Transport only — `https:`/`wss:`. NOT a claim about the certificate. */
  secure: boolean
  dialog: PageDialog | null
}

/** Nothing known yet: no page, no history, no claim. Every flag false, so a
 *  chrome that renders this greys every control instead of inventing one. */
export const EMPTY_NAV: NavState = {
  url: '',
  title: '',
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  secure: false,
  dialog: null,
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * A favicon we are willing to put in an `<img src>`, or `null`.
 *
 * The allowlist is deliberately shorter than "what a browser would load":
 * `data:image/*` is the shape the server actually sends (it fetches the icon
 * INSIDE the page, where the cookies are, and hands over base64), `https:` is
 * the only remote scheme worth honouring, and everything else — `javascript:`,
 * `data:text/html`, `blob:`, plain `http:` — is dropped in favour of the
 * letter tile, which is never wrong.
 */
export function safeFavicon(raw: unknown): string | null {
  const v = str(raw).trim()
  if (!v) return null
  const lower = v.toLowerCase()
  if (lower.startsWith('data:image/')) return v
  if (lower.startsWith('https://')) return v
  return null
}

/** One `nav_state` frame → the state the UI renders. Total: a missing or
 *  mistyped field becomes its falsy default rather than an exception. */
export function parseNavState(msg: Record<string, unknown>): NavState {
  const d = msg.dialog
  const dialog =
    d && typeof d === 'object'
      ? {
          kind: str((d as Record<string, unknown>).kind) || 'alert',
          message: str((d as Record<string, unknown>).message),
          default_prompt: str((d as Record<string, unknown>).default_prompt),
        }
      : null
  return {
    url: str(msg.url),
    title: str(msg.title),
    favicon: safeFavicon(msg.favicon),
    loading: msg.loading === true,
    canGoBack: msg.can_go_back === true,
    canGoForward: msg.can_go_forward === true,
    secure: msg.secure === true,
    dialog,
  }
}

/** The host with `www.` trimmed — the strip's title fallback, and a far better
 *  one than the raw URL it replaces: `reseller.example` beats
 *  `https://reseller.example/back-office/invoices?period=q3&view=settlement` in
 *  a 112px chip by every measure. Unparseable input is echoed unchanged. */
export function prettyHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host.replace(/^www\./i, '') || url
  } catch {
    return url
  }
}

/** `scheme://host[:port]` — the key the favicon memo is stored under.
 *
 *  ORIGIN, not tab id, and that is the honesty: the icon we cached is a fact
 *  about a SITE. Keyed by tab, a tab that navigated from mail to a bank would
 *  keep wearing the mail icon; keyed by origin, the cache simply misses and the
 *  tile takes over. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (!u.host) return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** The fallback icon: a letter and a stable hue, never a blank square.
 *
 *  The hue is a hash of the host, so a site keeps the same colour across
 *  reloads, tabs and sessions — which is what makes a favicon-only pinned chip
 *  identifiable at all before its real icon has ever loaded. */
export function faviconTile(hostOrUrl: string): { letter: string; hue: number } {
  const host = prettyHost(hostOrUrl) || hostOrUrl
  const letter = (host.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
  let h = 0
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) % 360
  return { letter, hue: h }
}
