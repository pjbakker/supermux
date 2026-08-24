// The FIELD-AWARE sign-in helper — a password manager's fill, mapped onto the
// login fields we actually detected on the remote page (spec §3).
// ─────────────────────────────────────────────────────────────────────────────
// The shared browser is a REMOTE Chrome painted onto a canvas; the human's own
// password manager (iOS Keychain, 1Password, Bitwarden, Chrome autofill) cannot
// see those fields because they live in a picture, not in this DOM. So we put a
// real form HERE — inputs carrying the exact `autocomplete` tokens a manager
// fills (`username` / `current-password`) inside a `<form>` — and relay whatever
// it fills into the page.
//
// WHAT MAKES THIS THE SMART VERSION (the dumb one typed username→Tab→password
// into whatever was focused): the panel has SCANNED the page (`scanLogin()`),
// so we know the real fields and their roles. The primary fill types each value
// into its DETECTED selector via `fillField(role)` — never blindly into the
// focused field — and when the detector is unsure, the field-mapper lets the
// human say which field is which. A correction is remembered per-site.
//
// Four things this must not do (spec §3.5):
//   • KEEP THE SECRET. Every value clears the moment the sheet closes.
//   • ZOOM iOS. 16px inputs, the same rule the address bar was fixed for.
//   • SUBMIT BY SURPRISE. Enter is a checkbox, default OFF.
//   • GUESS ACROSS FIELDS. A password is only ever typed into a field the
//     detector (or the human) marked `password`; the server re-checks before it
//     types. No fields at all → the control never opened this sheet.
import * as React from 'react'

import { ChevronDown, KeyRound, ShieldCheck } from 'lucide-react'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import type { LoginScan } from '@/lib/browser/login-detect'
import {
  buildFills,
  hostOf,
  initialChoices,
  isAmbiguous,
  isGenerateOnly,
  loadRecipe,
  recipeFromChoices,
  saveRecipe,
  type DetectedFill,
  type FieldRole,
  type RoleChoice,
  type SignInGate,
} from '@/lib/browser/sign-in-state'

/** Today's blind fill (the degrade path): username → Tab → password. */
export interface SignInCreds {
  username?: string
  password?: string
  submit?: boolean
}

export interface SignInSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Usable-or-not, computed from `caps.signIn` + the scan (`signInGate`). */
  gate: SignInGate
  /** The last login scan; `null` until `scanLogin()` answers. */
  scan: LoginScan | null
  /** The verified remote url — provenance + the per-site recipe key. */
  url: string
  /** Relay a field-scoped fill onto the DETECTED selectors (the caps path). */
  onFillDetected: (fills: DetectedFill[], submit: boolean) => void
  /** Relay today's blind text/Tab fill (older server, or a cross-origin frame). */
  onBlindFill: (creds: SignInCreds) => void
  /** Scroll a detected field into view + focus it, so the human can see where a
   *  fill will land before they tap it (spec §3.2). */
  onFocusField?: (selector: string) => void
  /** Bench only: force the sheet's theme on the portaled content root. */
  contentTheme?: 'light' | 'dark'
}

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-surface px-3 py-2.5 text-[16px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-primary focus:ring-2 focus:ring-primary/30 motion-reduce:transition-none'

const SELECT_CLASS =
  'w-full appearance-none rounded-lg border border-hairline bg-surface py-2 pl-2.5 pr-8 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30 motion-reduce:transition-none'

const ROLE_OPTIONS: { value: FieldRole; label: string }[] = [
  { value: 'username', label: 'Username' },
  { value: 'password', label: 'Password' },
  { value: 'otp', label: 'One-time code' },
  { value: 'ignore', label: 'Ignore' },
]

export function SignInSheet({
  open,
  onOpenChange,
  gate,
  scan,
  url,
  onFillDetected,
  onBlindFill,
  onFocusField,
  contentTheme,
}: SignInSheetProps) {
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [otp, setOtp] = React.useState('')
  const [submit, setSubmit] = React.useState(false)

  const host = hostOf(url)

  // The scan came back `form:false` for a reason that is not a scriptable
  // frame: there is genuinely nothing to fill, so the sheet offers nothing and
  // only explains why (the honest, mobile-legible half of a "disabled" control).
  const noForm = gate.kind === 'disabled'
  // The blind path: no caps (older server) or a cross-origin frame we cannot
  // script. Everything else with a detected form is the field-aware path.
  const blind = gate.kind === 'blind' || gate.kind === 'frame'
  const detected = !blind && !noForm && !!scan && scan.form && !isGenerateOnly(scan)
  const generateOnly = !blind && !noForm && isGenerateOnly(scan)

  // The mapper's BASE rows, derived from the scan + the per-site recipe — pure,
  // so it re-derives when the scan changes without a reset effect. The human's
  // corrections ride a separate `overrides` map keyed by selector, cleared on
  // close; `choices` is the base with the overrides applied.
  const baseChoices = React.useMemo<RoleChoice[]>(
    () => (detected ? initialChoices(scan, loadRecipe(host)) : []),
    [detected, scan, host],
  )
  const [overrides, setOverrides] = React.useState<Record<string, FieldRole>>({})
  const choices = React.useMemo(
    () => baseChoices.map((c) => (overrides[c.selector] ? { ...c, role: overrides[c.selector] } : c)),
    [baseChoices, overrides],
  )

  // Open the mapper unprompted when the detector was unsure; the human can also
  // open it on a confident guess to double-check ("Choose fields").
  const ambiguous = detected && isAmbiguous(scan)
  const [mapperOpen, setMapperOpen] = React.useState(false)
  const showMapper = detected && (ambiguous || mapperOpen)

  const hasOtpField = detected && choices.some((c) => c.role === 'otp')

  // Never leave a secret behind the sheet. Clearing on close (not open) lets a
  // manager that fills the instant the sheet mounts still find the fields, and
  // nothing survives the dismiss.
  const close = React.useCallback(
    (next: boolean) => {
      if (!next) {
        setUsername('')
        setPassword('')
        setOtp('')
        setSubmit(false)
        setMapperOpen(false)
        setOverrides({})
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const setRole = (selector: string, role: FieldRole) => {
    setOverrides((prev) => ({ ...prev, [selector]: role }))
  }

  const hasUser = username.trim().length > 0
  const hasPass = password.length > 0
  const hasOtp = otp.trim().length > 0

  const doDetectedFill = () => {
    const fills = buildFills(choices, { username, password, otp })
    if (fills.length === 0) return
    // Remember the mapping for this host BEFORE the values leave — the recipe is
    // selectors only, never the secret (spec §3.3 / §5).
    saveRecipe(host, recipeFromChoices(choices))
    onFillDetected(fills, submit)
    close(false)
  }

  const doBlindFill = (creds: SignInCreds) => {
    onBlindFill(creds)
    close(false)
  }

  // Which detected roles the human has actually supplied a value for — the
  // primary is dead until at least one lands, so a tap is never an empty relay.
  const detectedReady =
    detected &&
    choices.some(
      (c) =>
        (c.role === 'username' && hasUser) ||
        (c.role === 'password' && hasPass) ||
        (c.role === 'otp' && hasOtp),
    )

  const identity = hasUser ? username.trim() : 'sign-in'

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={close}
      title="Sign in to this page"
      description={
        detected
          ? 'Your password manager fills here; supermux types it into the fields it found on the page.'
          : 'Your password manager fills here; supermux types it into the page. Tap the sign-in field on the page first.'
      }
      className="sm:max-w-sm"
      contentTheme={contentTheme}
    >
      <div className="flex flex-col gap-3 px-1 pb-2" data-signin-mode={blind ? 'blind' : detected ? 'detected' : 'generate-only'}>
        {/* PROVENANCE (spec §3.5.4): the vault, not the page, is offering — and
            it names the site so a fill can never be phished onto a look-alike. */}
        <div
          className="flex items-center gap-2 rounded-lg border border-hairline bg-fill-soft px-2.5 py-1.5 text-[12px] text-ink-2"
          data-signin-provenance
        >
          <ShieldCheck className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate">
            supermux · <span className="font-medium text-ink">{host || 'this page'}</span>
          </span>
        </div>

        {/* NO FORM (spec §3.1 no-form): the scan found nothing fillable. The
            control is not usable — we show the reason and offer nothing, never
            a spinner and never a wrong field. */}
        {noForm && (
          <p
            className="rounded-lg bg-fill-soft px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-2"
            data-signin-no-form
          >
            {gate.reason}
          </p>
        )}

        {/* The cross-origin-frame reason, when we degraded to the blind path
            because the form lives in an iframe we cannot script. */}
        {gate.kind === 'frame' && (
          <p className="rounded-lg bg-fill-soft px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-2" data-signin-frame-reason>
            {gate.reason}
          </p>
        )}

        {/* A sign-up / change-password field: nothing to fill (spec §1.3(d)).
            We say so and leave the blind Password-only path as the manual out. */}
        {generateOnly && (
          <p className="rounded-lg bg-fill-soft px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-2" data-signin-generate-only>
            This looks like a sign-up or change-password field — there's nothing saved to fill
            here. Focus a field on the page and use Password only if you mean to.
          </p>
        )}

        {/* A real form so a password manager recognises the pair and offers the
            key. onSubmit is the primary fill — the manager's own "fill & go",
            and the Enter key inside either input. Omitted entirely in the
            no-form state: there is nothing on the page to fill. */}
        {!noForm && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (detected) {
              if (detectedReady) doDetectedFill()
            } else if (hasUser || hasPass) {
              doBlindFill({ username, password, submit })
            }
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
              enterKeyHint={hasOtpField ? 'next' : 'go'}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {/* The OTP field, only when the page actually has one (spec §1.2 STEP
              7). A separate input so a one-time code is never typed into the
              password field. */}
          {hasOtpField && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">One-time code</span>
              <input
                className={INPUT_CLASS}
                type="text"
                name="one-time-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
              />
            </label>
          )}

          {/* THE DETECTED SUMMARY / MAPPER (spec §3.3). When the auto-map is
              confident this is a read-only line naming the fields we found and a
              link to override; when it is unsure (or the human asked), it is the
              role-picker per field. */}
          {detected && !generateOnly && (
            <div className="rounded-xl border border-hairline bg-fill-soft/60 p-2.5" data-signin-fields>
              {showMapper ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] font-medium text-ink-2">
                    Which field is which?
                  </p>
                  {choices.map((c) => (
                    <div key={c.selector} className="flex items-center gap-2" data-signin-row={c.selector}>
                      <button
                        type="button"
                        onClick={() => onFocusField?.(c.selector)}
                        disabled={!onFocusField}
                        title={onFocusField ? 'Show this field on the page' : undefined}
                        className="min-w-0 flex-1 truncate rounded-lg border border-hairline bg-surface px-2.5 py-2 text-left text-[13px] text-ink transition-colors enabled:hover:bg-fill-soft disabled:cursor-default motion-reduce:transition-none"
                      >
                        {c.label}
                      </button>
                      <div className="relative shrink-0">
                        <select
                          aria-label={`Role for ${c.label}`}
                          data-signin-role={c.selector}
                          value={c.role}
                          onChange={(e) => setRole(c.selector, e.target.value as FieldRole)}
                          className={SELECT_CLASS}
                        >
                          {ROLE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <ChevronDown
                          className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
                          aria-hidden
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-[12.5px] text-ink-2">
                    <span className="text-ink-3">Found: </span>
                    <span className="text-ink">{detectedSummary(choices)}</span>
                  </div>
                  <button
                    type="button"
                    data-signin-choose
                    onClick={() => setMapperOpen(true)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10 motion-reduce:transition-none"
                  >
                    Choose fields
                  </button>
                </div>
              )}
            </div>
          )}

          {/* NEVER AUTO-SUBMIT (spec §3.5.2). Enter is opt-in, default off: a
              fill into the wrong field is recoverable, a submit into it is not. */}
          <label className="flex items-center gap-2 py-1 text-[13px] text-ink-2">
            <input
              type="checkbox"
              data-signin-submit
              className="size-4 rounded border-hairline accent-primary"
              checked={submit}
              onChange={(e) => setSubmit(e.target.checked)}
            />
            Press Enter to submit after filling
          </label>

          {detected && !generateOnly ? (
            <button
              type="submit"
              disabled={!detectedReady}
              data-signin-fill
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 motion-reduce:transition-none"
            >
              <KeyRound className="size-4" aria-hidden />
              Fill {identity}
            </button>
          ) : (
            <>
              <button
                type="submit"
                disabled={!hasUser && !hasPass}
                data-signin-fill
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
                  onClick={() => doBlindFill({ username })}
                  className="min-h-11 flex-1 rounded-xl border border-hairline bg-fill-soft px-3 text-[13px] font-medium text-ink transition-colors hover:bg-fill-soft-2 disabled:opacity-50 motion-reduce:transition-none"
                >
                  Username only
                </button>
                <button
                  type="button"
                  disabled={!hasPass}
                  onClick={() => doBlindFill({ password })}
                  className="min-h-11 flex-1 rounded-xl border border-hairline bg-fill-soft px-3 text-[13px] font-medium text-ink transition-colors hover:bg-fill-soft-2 disabled:opacity-50 motion-reduce:transition-none"
                >
                  Password only
                </button>
              </div>
            </>
          )}
        </form>
        )}
      </div>
    </ResponsiveSheet>
  )
}

/** The one-line "Found: …" summary of a confident auto-map. */
function detectedSummary(choices: RoleChoice[]): string {
  const parts: string[] = []
  const user = choices.find((c) => c.role === 'username')
  const pass = choices.find((c) => c.role === 'password')
  const otp = choices.find((c) => c.role === 'otp')
  if (user) parts.push(`username (${user.label})`)
  if (pass) parts.push(`password (${pass.label})`)
  if (otp) parts.push(`one-time code (${otp.label})`)
  return parts.length ? parts.join(', ') : 'no fillable fields'
}
