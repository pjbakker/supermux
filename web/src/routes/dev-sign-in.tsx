// /dev/sign-in — the FIELD-AWARE sign-in sheet, on a bench, offline.
//
// DEV-only + lazy, like every other /dev/* page: neither the route nor its
// mock scans reach the production bundle. This is what the offline 390px
// Playwright rig screenshots and what a subagent Reads the PNGs of — every
// state of the smart sign-in reached through the REAL `signInGate` + the REAL
// `SignInSheet`, driven by a hand-built `LoginScan` instead of a live browser.
//
//   ?state=no-form        the scan found nothing — control not usable, reason.
//   ?state=detected       one username + one current-password, confident map.
//   ?state=ambiguous      low-confidence guesses → the field-mapper is open.
//   ?state=otp            username + password + a one-time-code field.
//   ?state=generate-only  a sign-up / new-password field — nothing to fill.
//   ?state=frame          the form is in a cross-origin iframe → blind path.
//   ?state=blind          an older relay with no `caps.signIn` → today's path.
//   ?theme=dark           force the dark slab (the rig shoots both).
import * as React from 'react'

import { SignInSheet, type SignInCreds } from '@/components/browser/sign-in-sheet'
import type { LoginScan } from '@/lib/browser/login-detect'
import { signInGate, type DetectedFill } from '@/lib/browser/sign-in-state'

type BenchState =
  | 'no-form'
  | 'detected'
  | 'ambiguous'
  | 'otp'
  | 'generate-only'
  | 'frame'
  | 'blind'

/** The mock `LoginScan` for each state — the exact shape the server's
 *  `login_fields` frame parses into (`parseLoginScan`), so the bench exercises
 *  the gate/sheet on real data, not a stand-in. */
function mockScan(state: BenchState): { caps: boolean; scan: LoginScan | null } {
  const rect = (y: number) => ({ x: 40, y, w: 280, h: 44 })
  switch (state) {
    case 'no-form':
      return {
        caps: true,
        scan: {
          form: false,
          reason: 'no-password-field',
          fields: [],
          otp: null,
          multiStep: 'combined',
          frameHint: null,
        },
      }
    case 'detected':
      return {
        caps: true,
        scan: {
          form: true,
          reason: null,
          fields: [
            { selector: '#email', role: 'username', label: 'Email address', visible: true, source: 'autocomplete', rect: rect(120) },
            { selector: '#password', role: 'password', label: 'Password', visible: true, source: 'autocomplete', rect: rect(180) },
          ],
          otp: null,
          multiStep: 'combined',
          frameHint: null,
        },
      }
    case 'ambiguous':
      return {
        caps: true,
        scan: {
          form: true,
          reason: null,
          // Low-confidence signals (keyword / adjacency) → the mapper opens so
          // the human confirms which field is which.
          fields: [
            { selector: '#field_a', role: 'username', label: 'Account', visible: true, source: 'keyword', rect: rect(120) },
            { selector: '#field_b', role: 'password', label: 'Secret', visible: true, source: 'type', rect: rect(180) },
          ],
          otp: null,
          multiStep: 'combined',
          frameHint: null,
        },
      }
    case 'otp':
      return {
        caps: true,
        scan: {
          form: true,
          reason: null,
          fields: [
            { selector: '#user', role: 'username', label: 'Username', visible: true, source: 'autocomplete', rect: rect(120) },
            { selector: '#pass', role: 'password', label: 'Password', visible: true, source: 'autocomplete', rect: rect(180) },
          ],
          otp: { selector: '#code', label: 'Verification code' },
          multiStep: 'combined',
          frameHint: null,
        },
      }
    case 'generate-only':
      return {
        caps: true,
        scan: {
          form: true,
          reason: null,
          fields: [],
          otp: null,
          multiStep: 'combined',
          frameHint: null,
          generateOnly: true,
        },
      }
    case 'frame':
      return {
        caps: true,
        scan: {
          form: false,
          reason: 'cross-origin-frame',
          fields: [],
          otp: null,
          multiStep: 'combined',
          frameHint: 'cross-origin-iframe',
        },
      }
    case 'blind':
    default:
      // No caps at all — the older-relay degrade path.
      return { caps: false, scan: null }
  }
}

const STATES: BenchState[] = [
  'no-form',
  'detected',
  'ambiguous',
  'otp',
  'generate-only',
  'frame',
  'blind',
]

export default function DevSignIn() {
  const params = new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.search,
  )
  const state = (params.get('state') as BenchState) || 'detected'
  const dark = params.get('theme') === 'dark'

  const { caps, scan } = mockScan(state)
  const gate = signInGate(caps, scan)

  // Open on mount (the rig navigates by full URL per state, so a fresh mount
  // per capture starts open); the "Reopen sheet" button covers a manual close.
  const [open, setOpen] = React.useState(true)

  // The relays just record — a bench has no page to type into. A subagent can
  // still assert the sheet PRODUCED the right calls by reading the log.
  const log = React.useRef<string[]>([])
  const onFillDetected = (fills: DetectedFill[], submit: boolean) => {
    log.current.push(`detected:${fills.map((f) => `${f.role}=${f.selector}`).join(',')}${submit ? '+enter' : ''}`)
  }
  const onBlindFill = (creds: SignInCreds) => {
    log.current.push(`blind:${creds.username ? 'u' : ''}${creds.password ? 'p' : ''}${creds.submit ? '+enter' : ''}`)
  }

  return (
    <div
      data-theme={dark ? 'dark' : 'light'}
      className={dark ? 'dark min-h-dvh bg-background' : 'min-h-dvh bg-background'}
    >
      <div className="mx-auto flex min-h-dvh max-w-[420px] flex-col gap-3 p-4">
        <h1 className="text-sm font-medium text-foreground">
          Smart sign-in — {state}
        </h1>
        <p className="text-[12px] text-muted-foreground">
          gate: <code>{gate.kind}</code>
          {'reason' in gate ? ` — ${gate.reason}` : ''}
        </p>
        <div className="flex flex-wrap gap-1.5" data-vr={`sign-in-${state}${dark ? '-dark' : ''}`}>
          {STATES.map((s) => (
            <a
              key={s}
              href={`?state=${s}${dark ? '&theme=dark' : ''}`}
              className={
                s === state
                  ? 'rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground'
                  : 'rounded-md border border-border px-2 py-1 text-[11px] text-foreground'
              }
            >
              {s}
            </a>
          ))}
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-fit rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground"
          >
            Reopen sheet
          </button>
        )}
        <SignInSheet
          open={open}
          onOpenChange={setOpen}
          gate={gate}
          scan={scan}
          url="https://accounts.example.com/login"
          onFillDetected={onFillDetected}
          onBlindFill={onBlindFill}
          onFocusField={(sel) => log.current.push(`focus:${sel}`)}
          contentTheme={dark ? 'dark' : 'light'}
        />
      </div>
    </div>
  )
}
