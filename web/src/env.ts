// Typed accessors for the runtime config the server injects into index.html as
// `window._SUPERMUX_*` globals. Keeping auth-critical data on `window` (NOT
// localStorage) preserves a clean Capacitor wrap path — the native WebView
// injects these via a bootstrap script.

// Relative, not `@/lib/viewer`: env.ts is on the import path of modules whose bun
// unit tests resolve tsconfig paths from the ROOT config, which is a solution
// file with no `paths` (see the same note in lib/api/client.ts). Vite resolves
// both forms identically — this is spelling, not behaviour.
import { storedAccessKey } from './lib/viewer'

declare global {
  interface Window {
    _SUPERMUX_AUTH_TOKEN?: string
    _SUPERMUX_BASE_URL?: string
    _SUPERMUX_WS_URL?: string
    _SUPERMUX_VERSION?: string
    _SUPERMUX_HOME_DIR?: string
    _SUPERMUX_PROJECT_DIR?: string
  }
}

/** Bearer token for HTTP requests + the WS first-frame auth message.
 *
 *  Two sources, in this order:
 *    1. `window._SUPERMUX_AUTH_TOKEN` — the shell splice. Present on a TRUSTED
 *       owner transport only (loopback / `*.ts.net` / a configured owner host);
 *       see `static_assets::should_splice_admin_token`. This is the owner path
 *       and it is unchanged.
 *    2. An access key the owner pasted into the login gate on a host that (by
 *       design) is never given the splice — a company / quick-tunnel host. It is
 *       verified against `/auth/me` BEFORE it is stored, so a stored key is a
 *       key the server accepted.
 *
 *  An invited colleague has neither: they authenticate by the `supermux_hsess`
 *  cookie, which rides same-origin requests on its own. `''` then, exactly as
 *  before. */
export function authToken(): string {
  return window._SUPERMUX_AUTH_TOKEN ?? storedAccessKey()
}

/** API base URL. Falls back to same-origin via `import.meta.env.BASE_URL`. */
export function baseUrl(): string {
  return window._SUPERMUX_BASE_URL ?? import.meta.env.BASE_URL
}

/** WebSocket base URL (ws:// or wss://). Derived from the page origin if unset. */
export function wsUrl(): string {
  if (window._SUPERMUX_WS_URL) return window._SUPERMUX_WS_URL
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

/** Server build version (for the about/settings screen + cache busting). */
export function appVersion(): string {
  return window._SUPERMUX_VERSION ?? 'dev'
}

/** The server's home directory — the sensible default working directory for a
 *  new session. The New-session form pre-fills its directory field with this so
 *  a session can be created in one click without typing a path. Empty string if
 *  the server couldn't resolve it (the create endpoint then falls back to the
 *  home dir server-side anyway). */
export function homeDir(): string {
  return window._SUPERMUX_HOME_DIR ?? ''
}

/** The first deploy-configured project directory (`SUPERMUX_PROJECT_DIRS`'s
 *  first entry; smart default `<home>/projects`, on production hosts often
 *  `/opt/projects`). Start-a-team pre-fills its directory field with this so the
 *  on-focus autocomplete immediately surfaces the project repos — turning "pick
 *  a repo" into a one-click action. Empty string when the env var is unset (the
 *  caller falls back to [`homeDir`]). The returned path has NO trailing slash;
 *  callers that need one for autocomplete-as-children behaviour should append it. */
export function projectsDir(): string {
  return window._SUPERMUX_PROJECT_DIR ?? ''
}
