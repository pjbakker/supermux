// The sign-in helper — a password manager's fill, relayed into a page the
// screencast cannot autofill.
// ─────────────────────────────────────────────────────────────────────────────
// The shared browser is a REMOTE Chrome painted onto a canvas; the human's own
// password manager (iOS Keychain, 1Password, Bitwarden, Chrome autofill) cannot
// see those fields because they live in a picture, not in this DOM. So we put a
// real form HERE — two inputs carrying the exact `autocomplete` tokens a manager
// fills (`username` / `current-password`), inside a `<form>` so the manager
// recognises the pair and offers the key — and relay whatever it fills into the
// page over the takeover socket (`text → Tab → text`, see `signInOps`).
//
// Three things this must not do:
//   • KEEP THE PASSWORD. The fields clear the moment the sheet closes — a
//     signed-in page's secret must not sit in a React tree behind it.
//   • ZOOM iOS. 16px inputs, the same rule the address bar was fixed for.
//   • SUBMIT BY SURPRISE. Enter is a checkbox, default OFF: filling the wrong
//     field is recoverable, a submit into it is not.
//
// The two "only" buttons exist because Tab is a heuristic: on a form whose
// password field is not the next tab stop, the human focuses each field on the
// page and fills it alone. Same function (`signInOps`), one field blank.
import * as React from 'react'

import { KeyRound } from 'lucide-react'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

export interface SignInCreds {
  username?: string
  password?: string
  submit?: boolean
}

export interface SignInSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Relay a fill into the page. Called with both fields (Tab between), or one
   *  field alone for the "only" buttons. The sheet closes itself after. */
  onFill: (creds: SignInCreds) => void
}

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-surface px-3 py-2.5 text-[16px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-primary focus:ring-2 focus:ring-primary/30 motion-reduce:transition-none'

export function SignInSheet({ open, onOpenChange, onFill }: SignInSheetProps) {
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [submit, setSubmit] = React.useState(false)

  // Never leave a secret behind the sheet. Clearing on close (rather than on
  // open) means a manager that fills the fields the instant the sheet mounts
  // still finds them, and nothing survives the dismiss.
  const close = React.useCallback(
    (next: boolean) => {
      if (!next) {
        setUsername('')
        setPassword('')
        setSubmit(false)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const fill = (creds: SignInCreds) => {
    onFill(creds)
    close(false)
  }

  const hasUser = username.trim().length > 0
  const hasPass = password.length > 0

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={close}
      title="Sign in to this page"
      description="Your password manager fills here; supermux types it into the page. Tap the sign-in field on the page first."
      className="sm:max-w-sm"
    >
      {/* A real form so a password manager recognises the pair and offers the
          key. onSubmit is the primary "fill both" path — the manager's own
          "fill & go", and the Enter key inside either input. */}
      <form
        className="flex flex-col gap-3 px-1 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (hasUser || hasPass) fill({ username, password, submit })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">Username or email</span>
          <input
            className={INPUT_CLASS}
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            enterKeyHint="next"
            placeholder="you@example.com"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink-2">Password</span>
          <input
            className={INPUT_CLASS}
            type="password"
            name="password"
            autoComplete="current-password"
            enterKeyHint="go"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label className="flex items-center gap-2 py-1 text-[13px] text-ink-2">
          <input
            type="checkbox"
            className="size-4 rounded border-hairline accent-primary"
            checked={submit}
            onChange={(e) => setSubmit(e.target.checked)}
          />
          Press Enter to submit after filling
        </label>

        <button
          type="submit"
          disabled={!hasUser && !hasPass}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 motion-reduce:transition-none"
        >
          <KeyRound className="size-4" aria-hidden />
          Fill sign-in
        </button>

        {/* Tab is a heuristic; these fill ONE field into whatever the human
            focused on the page, for forms it does not fit. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!hasUser}
            onClick={() => fill({ username })}
            className="min-h-11 flex-1 rounded-xl border border-hairline bg-fill-soft px-3 text-[13px] font-medium text-ink transition-colors hover:bg-fill-soft-2 disabled:opacity-50 motion-reduce:transition-none"
          >
            Username only
          </button>
          <button
            type="button"
            disabled={!hasPass}
            onClick={() => fill({ password })}
            className="min-h-11 flex-1 rounded-xl border border-hairline bg-fill-soft px-3 text-[13px] font-medium text-ink transition-colors hover:bg-fill-soft-2 disabled:opacity-50 motion-reduce:transition-none"
          >
            Password only
          </button>
        </div>
      </form>
    </ResponsiveSheet>
  )
}
