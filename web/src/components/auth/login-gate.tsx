/**
 * `<LoginGate>` — the full-screen sign-in wall for an ANONYMOUS visitor.
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER BUG #1: opening the app URL on a company / quick-tunnel host with no
 * credentials rendered the Bot-Mode onboarding intro — a five-screen story
 * pitching a product the visitor cannot use, before any login existed. There was
 * no login screen at all: the web client had no identity concept, so an
 * unauthenticated shell simply behaved like a signed-in one with a broken API.
 *
 * This replaces the entire app for `viewer.kind === 'anon'`, mounted ABOVE the
 * routes and above `<OnboardingHost>` (App.tsx), so nothing else can paint first.
 *
 * Two audiences, one screen:
 *   • the OWNER, reaching their own box on a host that (by design) never gets the
 *     spliced admin bearer — they paste their access key. It is VERIFIED against
 *     `/auth/me` before it is stored, so a wrong key can never be persisted into
 *     a half-broken session.
 *   • an INVITED colleague, who has no key at all — they open their invite link,
 *     which mints the session cookie server-side. That is the secondary line.
 *
 * Mobile-first: one column, 44px targets, safe-area padding, nothing wider than
 * the viewport at 390px. Theme-correct in both light and dark (all colours are
 * semantic tokens, so the shell's `.dark` class drives it).
 */
import * as React from 'react'

import { Logo } from '@/components/logo'
import { verifyAccessKey } from '@/lib/api/auth'
import { storeAccessKey } from '@/lib/viewer'

export interface LoginGateProps {
  /** Called with the verified key once the server has accepted it. Defaults to a
   *  full reload, which is what production wants: every store, query and socket
   *  re-reads the now-authenticated world from scratch. Injected by tests. */
  onAuthenticated?: (key: string) => void
}

export function LoginGate({ onAuthenticated }: LoginGateProps) {
  const [key, setKey] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const candidate = key.trim()
    if (!candidate || busy) return
    setBusy(true)
    setError(null)
    const result = await verifyAccessKey(candidate)
    if (result === 'ok') {
      // Honest about the ONE way this can half-succeed: the key works, but
      // private-mode storage refused to keep it, so the next load asks again.
      const kept = storeAccessKey(candidate)
      if (!kept) {
        setError("Signed in, but this browser wouldn't remember the key.")
      }
      if (onAuthenticated) {
        onAuthenticated(candidate)
      } else {
        window.location.reload()
      }
      return
    }
    setBusy(false)
    setError(
      result === 'rejected'
        ? "That access key wasn't accepted."
        : "Couldn't reach the server. Check your connection and try again.",
    )
  }

  return (
    <div
      data-login-gate=""
      className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-6 py-10 pb-safe pt-safe text-foreground"
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <Logo className="h-10 w-auto" />
          <h1 className="mt-5 text-xl font-semibold tracking-tight">
            This is a private workspace
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to continue.
          </p>
        </div>

        <form onSubmit={submit} className="mt-7 flex flex-col gap-3">
          <label htmlFor="supermux-access-key" className="text-sm font-medium">
            Access key
          </label>
          <input
            id="supermux-access-key"
            name="access-key"
            type="password"
            value={key}
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste your access key"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'supermux-access-key-error' : undefined}
            onChange={(e) => {
              setKey(e.target.value)
              if (error) setError(null)
            }}
            className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          {error && (
            <p
              id="supermux-access-key-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || key.trim() === ''}
            className="h-11 w-full rounded-lg bg-primary text-base font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Connect'}
          </button>
        </form>

        {/* The invited colleague's path. They have no key — the magic link IS
            their credential (`GET /auth/invite?token=…` mints the cookie). */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Got an invite link? Open it — it signs you in.
        </p>
      </div>
    </div>
  )
}
