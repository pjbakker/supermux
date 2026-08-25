/**
 * SMART sign-in — the field-aware state machine (spec §3), pinned as data.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The dumb sign-in typed username→Tab→password into whatever was focused. The
 * smart one gates on a real page SCAN, maps each value onto the DETECTED
 * selector, lets the human correct a wrong guess, and remembers the correction.
 * None of that is visible in a screenshot and all of it is decided in
 * `sign-in-state.ts`, so it is tested there — and the two component invariants
 * that keep it honest (the mapper's role picker, the never-auto-submit checkbox,
 * the caps-absent blind fallback, the field-scoped fill) are pinned on the
 * source the way the password-manager contract already is.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import type { LoginScan } from '../../src/lib/browser/login-detect'
import {
  buildFills,
  hostOf,
  initialChoices,
  isAmbiguous,
  isGenerateOnly,
  loadRecipe,
  reasonText,
  recipeFromChoices,
  saveRecipe,
  signInGate,
  type RoleChoice,
} from '../../src/lib/browser/sign-in-state'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const field = (over: Partial<LoginScan['fields'][number]>): LoginScan['fields'][number] => ({
  selector: '#x',
  role: 'username',
  label: 'Field',
  visible: true,
  source: 'autocomplete',
  rect: { x: 0, y: 0, w: 0, h: 0 },
  ...over,
})

const scanOf = (over: Partial<LoginScan>): LoginScan => ({
  form: true,
  reason: null,
  fields: [],
  otp: null,
  multiStep: 'combined',
  frameHint: null,
  ...over,
})

const CONFIDENT = scanOf({
  fields: [
    field({ selector: '#email', role: 'username', label: 'Email', source: 'autocomplete' }),
    field({ selector: '#pw', role: 'password', label: 'Password', source: 'autocomplete' }),
  ],
})

/* ── the gate: no-form disabled + reason, blind fallback, cross-origin frame ── */

describe('signInGate — the owner\'s "not usable when there are no fields"', () => {
  test('no caps.signIn (older relay) ⇒ blind, NEVER a spinner', () => {
    // The whole degrade path in one line: an older server that never sends caps
    // leaves the sheet on today's text/Tab fill, not a wheel spinning against a
    // verb it will never answer.
    expect(signInGate(false, null)).toEqual({ kind: 'blind' })
    expect(signInGate(false, CONFIDENT)).toEqual({ kind: 'blind' })
  })

  test('capable but not scanned yet ⇒ ready (we never claim "no form" before we know)', () => {
    expect(signInGate(true, null)).toEqual({ kind: 'ready' })
  })

  test('form:false ⇒ disabled, carrying the human reason', () => {
    const gate = signInGate(true, scanOf({ form: false, reason: 'no-password-field' }))
    expect(gate.kind).toBe('disabled')
    expect(gate.kind === 'disabled' && gate.reason).toBe('No sign-in fields on this page')
  })

  test('a cross-origin frame degrades to the blind Password-only path, with the reason', () => {
    const gate = signInGate(true, scanOf({ form: false, reason: 'cross-origin-frame', frameHint: 'cross-origin-iframe' }))
    expect(gate.kind).toBe('frame')
    expect(gate.kind === 'frame' && gate.reason).toContain('embedded frame')
  })

  test('a detected form ⇒ ready', () => {
    expect(signInGate(true, CONFIDENT)).toEqual({ kind: 'ready' })
  })

  test('reasonText spells every form:false reason', () => {
    expect(reasonText('no-password-field', null)).toBe('No sign-in fields on this page')
    expect(reasonText('all-hidden', null)).toContain('visible')
    expect(reasonText('too-many-fields', null)).toContain('Too many')
    expect(reasonText('scan-error', null)).toContain("Couldn't read")
    // A frame hint wins over any reason — that is the "use Password only" case.
    expect(reasonText('no-password-field', 'cross-origin-iframe')).toContain('embedded frame')
  })
})

/* ── auto-map vs ambiguous ────────────────────────────────────────────────── */

describe('isAmbiguous — when the human is asked to confirm', () => {
  test('two authoritative signals (autocomplete/type) ⇒ confident, no mapper', () => {
    expect(isAmbiguous(CONFIDENT)).toBe(false)
  })

  test('a keyword- or adjacency-guessed field ⇒ ambiguous', () => {
    const s = scanOf({
      fields: [
        field({ selector: '#a', role: 'username', source: 'keyword' }),
        field({ selector: '#b', role: 'password', source: 'type' }),
      ],
    })
    expect(isAmbiguous(s)).toBe(true)
  })

  test('a combined form that resolved NO username ⇒ ambiguous', () => {
    const s = scanOf({
      multiStep: 'combined',
      fields: [field({ selector: '#b', role: 'password', source: 'autocomplete' })],
    })
    expect(isAmbiguous(s)).toBe(true)
  })

  test('a username-only step with one autocomplete field ⇒ confident', () => {
    const s = scanOf({
      multiStep: 'username-only',
      fields: [field({ selector: '#u', role: 'username', source: 'autocomplete' })],
    })
    expect(isAmbiguous(s)).toBe(false)
  })

  test('generateOnly is not "ambiguous" — it is "nothing to fill"', () => {
    const s = scanOf({ fields: [], generateOnly: true })
    expect(isGenerateOnly(s)).toBe(true)
    expect(isAmbiguous(s)).toBe(false)
  })
})

/* ── the mapper rows + recipe consult ─────────────────────────────────────── */

describe('initialChoices — the mapper, guesses pre-filled, recipe consulted first', () => {
  test('each detected field becomes a row pre-set to its guess; OTP is a row too', () => {
    const s = scanOf({
      fields: [
        field({ selector: '#email', role: 'username', label: 'Email', source: 'autocomplete' }),
        field({ selector: '#pw', role: 'password', label: 'Password', source: 'type' }),
      ],
      otp: { selector: '#code', label: 'Code' },
    })
    const rows = initialChoices(s, null)
    expect(rows.map((r) => [r.selector, r.role])).toEqual([
      ['#email', 'username'],
      ['#pw', 'password'],
      ['#code', 'otp'],
    ])
  })

  test('a per-site recipe OVERRIDES the detector guess where the selector still exists', () => {
    // The page mis-guessed #a as username; the remembered recipe says it is the
    // password. The recipe wins, and is marked as its source.
    const s = scanOf({
      fields: [
        field({ selector: '#a', role: 'username', source: 'keyword' }),
        field({ selector: '#b', role: 'password', source: 'keyword' }),
      ],
    })
    const rows = initialChoices(s, { username: '#b', password: '#a' })
    const byId = (id: string) => rows.find((r) => r.selector === id)!
    expect(byId('#a').role).toBe('password')
    expect(byId('#a').source).toBe('recipe')
    expect(byId('#b').role).toBe('username')
  })

  test('a recipe selector that no longer exists is simply ignored', () => {
    const rows = initialChoices(CONFIDENT, { username: '#gone' })
    // #email keeps its detected role; nothing throws.
    expect(rows.find((r) => r.selector === '#email')!.role).toBe('username')
  })
})

/* ── buildFills: field-scoped, ordered, blank-skipping, NEVER an Enter ─────── */

describe('buildFills — one value per matched role, scoped and ordered', () => {
  const rows: RoleChoice[] = [
    { selector: '#u', label: 'User', guess: 'username', role: 'username', source: 'autocomplete' },
    { selector: '#p', label: 'Pass', guess: 'password', role: 'password', source: 'autocomplete' },
  ]

  test('maps each value onto its role\'s selector, username then password', () => {
    expect(buildFills(rows, { username: 'ada@x.io', password: 'hunter2', otp: '' })).toEqual([
      { selector: '#u', value: 'ada@x.io', role: 'username' },
      { selector: '#p', value: 'hunter2', role: 'password' },
    ])
  })

  test('a blank value for a role is SKIPPED — a fill is never an empty write', () => {
    expect(buildFills(rows, { username: '', password: 'hunter2', otp: '' })).toEqual([
      { selector: '#p', value: 'hunter2', role: 'password' },
    ])
  })

  test('an "ignore" row contributes nothing, so a password never lands in a search box', () => {
    const ignored: RoleChoice[] = [
      { selector: '#p', label: 'Pass', guess: 'password', role: 'ignore', source: 'keyword' },
    ]
    expect(buildFills(ignored, { username: '', password: 'hunter2', otp: '' })).toEqual([])
  })

  test('NEVER AUTO-SUBMIT: the fills are selectors+values only — no Enter is ever synthesised here', () => {
    const fills = buildFills(rows, { username: 'a', password: 'b', otp: 'c' })
    // A DetectedFill has exactly {selector,value,role}; there is no key/submit
    // shape it could carry. Submit is a separate, opt-in step in the panel.
    for (const f of fills) {
      expect(Object.keys(f).sort()).toEqual(['role', 'selector', 'value'])
    }
  })
})

/* ── recipe round-trip through (a stubbed) localStorage ───────────────────── */

describe('per-site recipe persistence (tolerant of blocked storage)', () => {
  const store = new Map<string, string>()
  const original = (globalThis as { localStorage?: unknown }).localStorage

  beforeEach(() => {
    store.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = original
  })

  test('recipeFromChoices records the selector chosen for each role, dropping ignores', () => {
    const rows: RoleChoice[] = [
      { selector: '#u', label: 'U', guess: 'username', role: 'username', source: 'recipe' },
      { selector: '#p', label: 'P', guess: 'password', role: 'password', source: 'recipe' },
      { selector: '#j', label: 'J', guess: 'username', role: 'ignore', source: 'keyword' },
    ]
    expect(recipeFromChoices(rows)).toEqual({ username: '#u', password: '#p' })
  })

  test('save then load round-trips for the host, and initialChoices consults it', () => {
    saveRecipe('accounts.example.com', { username: '#b', password: '#a' })
    expect(loadRecipe('accounts.example.com')).toEqual({ username: '#b', password: '#a' })
    // A different host is untouched.
    expect(loadRecipe('other.example')).toBeNull()

    const s = scanOf({
      fields: [
        field({ selector: '#a', role: 'username', source: 'keyword' }),
        field({ selector: '#b', role: 'password', source: 'keyword' }),
      ],
    })
    const rows = initialChoices(s, loadRecipe('accounts.example.com'))
    expect(rows.find((r) => r.selector === '#a')!.role).toBe('password')
    expect(rows.find((r) => r.selector === '#b')!.role).toBe('username')
  })

  test('an empty recipe is not parked, and a blocked store never throws', () => {
    saveRecipe('h', {})
    expect(loadRecipe('h')).toBeNull()
    // Storage that throws on write must not surface — the fill already happened.
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => saveRecipe('h', { username: '#u' })).not.toThrow()
    expect(loadRecipe('h')).toBeNull()
  })
})

describe('hostOf', () => {
  test('extracts the bare host, empty on an unparseable url', () => {
    expect(hostOf('https://accounts.example.com/login?x=1')).toBe('accounts.example.com')
    expect(hostOf('not a url')).toBe('')
    expect(hostOf('')).toBe('')
  })
})

/* ── the two component contracts that keep the machine honest ─────────────── */

describe('the SignInSheet keeps the field-aware contract', () => {
  const src = readFileSync(new URL('../../src/components/browser/sign-in-sheet.tsx', import.meta.url), 'utf8')

  test('still carries the password-manager tokens + 16px + clear-on-close', () => {
    expect(src).toContain('autoComplete="username"')
    expect(src).toContain('autoComplete="current-password"')
    expect(src).toContain('text-[16px]')
    expect(src).toContain("setPassword('')")
  })

  test('the field-mapper offers a role picker with Username / Password / One-time code / Ignore', () => {
    for (const role of ['Username', 'Password', 'One-time code', 'Ignore']) {
      expect(src).toContain(role)
    }
    expect(src).toContain('data-signin-role')
  })

  test('the OTP field carries the one-time-code token so a code never lands in the password', () => {
    expect(src).toContain('autoComplete="one-time-code"')
  })

  test('NEVER AUTO-SUBMIT — the Enter checkbox defaults OFF', () => {
    expect(src).toContain("const [submit, setSubmit] = React.useState(false)")
    expect(src).toContain('Press Enter to submit after filling')
  })

  test('the fill goes through the DETECTED selectors, not a blind Tab', () => {
    expect(src).toContain('buildFills(choices')
    expect(src).toContain('onFillDetected(fills, submit)')
    expect(src).toContain('saveRecipe(host, recipeFromChoices(choices))')
  })

  test('a no-form / generate-only state renders a reason and NO fill form', () => {
    expect(src).toContain('data-signin-no-form')
    expect(src).toContain('data-signin-generate-only')
    expect(src).toContain('{!noForm && (')
  })
})

describe('the TakeoverPanel wires the smart path', () => {
  const src = readFileSync(new URL('../../src/components/browser/takeover-panel.tsx', import.meta.url), 'utf8')

  test('proactively scans, feeds the gate to the sheet, and exposes the toolbar triggers', () => {
    expect(src).toContain('signInGate(snap.caps.signIn, snap.loginScan)')
    expect(src).toContain('socketRef.current?.scanLogin()')
    // The gate still drives the sheet; the Paste/Sign-in TRIGGERS moved OUT of a
    // canvas overlay and onto the chrome toolbar via the control bridge.
    expect(src).toContain('gate={signIn}')
    expect(src).toContain('openSignIn:')
    expect(src).toContain('paste:')
    // No floating cluster over the page any more.
    expect(src).not.toContain('data-takeover-signin')
    expect(src).not.toContain('data-takeover-paste')
  })

  test('the detected fill types each value into its selector via fillField; Enter only on opt-in', () => {
    expect(src).toContain('sock.fillField(f.selector, f.value, f.role)')
    expect(src).toContain("if (submit && fills.length > 0) sock.pressKey('Enter')")
  })

  test('caps-absent still hands the sheet the blind relay (degrade, not spin)', () => {
    expect(src).toContain('onBlindFill={relaySignIn}')
    expect(src).toContain('onFillDetected={relayDetectedFill}')
  })
})

describe('the toolbar hosts Paste + Sign-in (out of the page)', () => {
  const chrome = readFileSync(
    new URL('../../src/components/browser/browser-chrome.tsx', import.meta.url),
    'utf8',
  )
  const ws = readFileSync(
    new URL('../../src/components/browser/workspace.tsx', import.meta.url),
    'utf8',
  )

  test('driving shows Paste + Sign-in in the toolbar slot; watching shows resync', () => {
    // One slot, forked on `driving` — Paste/Sign-in while driving, the resync
    // ("refresh the picture") while watching.
    expect(chrome).toContain('driving ? (')
    expect(chrome).toContain('data-chrome-paste')
    expect(chrome).toContain('data-chrome-signin')
    expect(chrome).toContain('data-chrome-resync')
  })

  test('Sign-in carries the no-form reason (the "not usable when no fields" rule)', () => {
    expect(chrome).toContain('signInDisabledReason')
    // The workspace computes the gate and passes the reason + the triggers.
    expect(ws).toContain('signInGate(caps.signIn')
    expect(ws).toContain('onPaste={() => ctl.current?.paste()}')
    expect(ws).toContain('onSignIn={() => ctl.current?.openSignIn()}')
  })
})
