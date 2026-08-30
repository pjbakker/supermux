/**
 * `<MemberWelcomeSheet>` — the ONE thing an invited colleague is asked on arrival.
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER BUG #2 + #3. A member used to land on the Bot-Mode intro — a five-screen
 * story whose whole point is a MODE SWITCH they must never be offered (they are
 * always in bot mode). And nothing ever asked their name, so the group chat and
 * their avatar had nothing to show but a placeholder the owner typed.
 *
 * So for a member the intro is replaced by exactly one sheet: "Welcome to
 * <Company>" and a name field → `POST /auth/profile`. A member whose
 * `display_name` is already set never sees it (see `needsDisplayName`).
 *
 * Reuses the app's canonical `<ResponsiveSheet>` — bottom sheet on touch, side
 * panel on a mouse — so it is mobile-first and consistent by construction.
 */
import * as React from 'react'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { authApi } from '@/lib/api/auth'
import { useOverlayGate } from '@/stores/overlay-gate-store'

export interface MemberWelcomeSheetProps {
  open: boolean
  /** The company they were invited into (its name leads the sheet). */
  companyName: string
  /** Resolves once the name is saved — the host adopts it into the viewer. */
  onSaved: (displayName: string) => void
  /** Close without naming. The sheet is a courtesy, not a wall: the ✕ and the
   *  backdrop have to do something. Their `display_name` is still empty, so the
   *  sheet simply asks again on their next load — and the avatar falls back to
   *  their email until then. */
  onDismiss: () => void
  /** Test seam: the save call. Defaults to `authApi.setDisplayName`. */
  save?: (displayName: string) => Promise<void>
}

export function MemberWelcomeSheet({
  open,
  companyName,
  onSaved,
  onDismiss,
  save = authApi.setDisplayName,
}: MemberWelcomeSheetProps) {
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Raise the shared overlay gate while this is up, so no coachmark paints over
  // it. On an iPhone the "Install supermux on your home screen" sheet self-gates
  // to exactly this load — the first non-standalone iOS visit — and covered the
  // name question outright. The gate is a counter with a disposer, so the
  // cleanup below is the whole contract.
  React.useEffect(() => {
    if (!open) return
    return useOverlayGate.getState().openOverlay()
  }, [open])

  const trimmed = name.trim()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await save(trimmed)
      onSaved(trimmed)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : "Couldn't save your name.")
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
      title={`Welcome to ${companyName}`}
      description="What should your teammates call you?"
      footer={
        <button
          type="submit"
          form="supermux-member-welcome"
          disabled={busy || trimmed === ''}
          className="h-11 w-full rounded-lg bg-primary text-base font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Continue'}
        </button>
      }
    >
      <form
        id="supermux-member-welcome"
        onSubmit={submit}
        className="flex flex-col gap-3 px-4 py-4"
      >
        <label htmlFor="supermux-member-name" className="text-sm font-medium">
          Your name
        </label>
        <input
          id="supermux-member-name"
          value={name}
          maxLength={64}
          autoComplete="name"
          placeholder="e.g. Sam Rivera"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'supermux-member-name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          Shown on your messages and your avatar. You can be informal.
        </p>
        {error && (
          <p
            id="supermux-member-name-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </form>
    </ResponsiveSheet>
  )
}
