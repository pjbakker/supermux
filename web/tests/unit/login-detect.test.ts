/**
 * Anchor-first login detection, exercised over real DOM fixtures (spec §1.2).
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `login-detect.ts` is the ONE source of truth: the same `LOGIN_DETECT_BODY` the
 * remote page runs is what these tests run, via `detectLogin(document)` under a
 * jsdom `Window`. The last test reads the Rust `SCAN_LOGIN_JS` const back out of
 * `takeover.rs` and asserts it is byte-identical to the TS `SCAN_LOGIN_JS`, so
 * the server can never ship a detector these fixtures did not cover.
 *
 * jsdom does no layout, so `getClientRects()` is empty and `offsetWidth` is 0;
 * the detector probes for a layout engine and, finding none, leans on computed
 * style (which honours inline `display:none` / `visibility:hidden`). In real
 * Chrome the probe passes and the full rect gate applies — same code, both ways.
 */
import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'

import { detectLogin, SCAN_LOGIN_JS, type LoginScan } from '../../src/lib/browser/login-detect'

/** Build a scan over an HTML `<body>` fragment on a stated origin. */
function scan(bodyHtml: string, url = 'https://acme.test/login'): LoginScan {
  const dom = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', { url })
  return detectLogin(dom.window.document, dom.window as unknown as Window & typeof globalThis)
}

const roles = (s: LoginScan) => s.fields.map((f) => f.role)
const byRole = (s: LoginScan, role: string) => s.fields.filter((f) => f.role === role)

describe('the anchor-first login detector', () => {
  test('a classic username+password form → both roles, autocomplete then type', () => {
    const s = scan(`
      <form>
        <label>Email <input id="email" type="email" autocomplete="username" /></label>
        <label>Password <input id="pw" type="password" /></label>
        <button type="submit">Sign in</button>
      </form>
    `)
    expect(s.form).toBe(true)
    expect(s.reason).toBeNull()
    expect(roles(s)).toEqual(['username', 'password'])
    const u = byRole(s, 'username')[0]
    const p = byRole(s, 'password')[0]
    expect(u.selector).toBe('#email')
    expect(u.source).toBe('autocomplete')
    expect(p.selector).toBe('#pw')
    expect(p.source).toBe('type')
    expect(s.multiStep).toBe('combined')
    // Every field carries a rect for Phase-4 anchoring (zeros without layout).
    expect(p.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  test('no password field and no username step → form:false, no-password-field', () => {
    const s = scan(`
      <form>
        <input id="q" type="search" placeholder="Search" />
        <input id="qty" type="number" />
        <button type="submit">Go</button>
      </form>
    `)
    expect(s.form).toBe(false)
    expect(s.reason).toBe('no-password-field')
    expect(s.fields).toEqual([])
  })

  test('signup with two identical passwords → generate-only, neither fillable', () => {
    const s = scan(`
      <form>
        <input id="email" type="email" autocomplete="username" />
        <input id="pw1" type="password" value="s3cret-pass" />
        <input id="pw2" type="password" value="s3cret-pass" />
        <button type="submit">Create account</button>
      </form>
    `)
    expect(s.form).toBe(true)
    expect(s.generateOnly).toBe(true)
    // Nothing offered to fill — both passwords are a new+confirm pair.
    expect(byRole(s, 'password')).toEqual([])
  })

  test('change-password (current + new) → only the current field is fillable', () => {
    const s = scan(`
      <form>
        <input id="cur" type="password" autocomplete="current-password" />
        <input id="new" type="password" autocomplete="new-password" />
        <input id="confirm" type="password" autocomplete="new-password" />
        <button type="submit">Change</button>
      </form>
    `)
    expect(s.form).toBe(true)
    const pws = byRole(s, 'password')
    expect(pws.length).toBe(1)
    expect(pws[0].selector).toBe('#cur')
    expect(pws[0].source).toBe('autocomplete')
    // The new-password / confirm fields are never in the offer.
    expect(s.fields.some((f) => f.selector === '#new' || f.selector === '#confirm')).toBe(false)
  })

  test('username-first multi-step (text field, no password) → multiStep:username-only', () => {
    const s = scan(`
      <form>
        <input id="ident" type="text" autocomplete="username" />
        <button type="submit">Next</button>
      </form>
    `)
    expect(s.form).toBe(true)
    expect(s.multiStep).toBe('username-only')
    expect(roles(s)).toEqual(['username'])
    expect(s.fields[0].selector).toBe('#ident')
  })

  test('password-only step (lone password, no username) → multiStep:password-only', () => {
    const s = scan(`
      <form>
        <input id="pw" type="password" autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    `)
    expect(s.form).toBe(true)
    expect(s.multiStep).toBe('password-only')
    expect(roles(s)).toEqual(['password'])
  })

  test('a one-time-code field surfaces as the otp slot, never as a password', () => {
    const s = scan(`
      <form>
        <input id="email" type="email" autocomplete="username" />
        <input id="pw" type="password" autocomplete="current-password" />
        <input id="code" type="text" autocomplete="one-time-code" maxlength="6" inputmode="numeric" />
        <button type="submit">Verify</button>
      </form>
    `)
    expect(s.otp).not.toBeNull()
    expect(s.otp!.selector).toBe('#code')
    // The OTP is surfaced separately, not folded into fields as a password.
    expect(s.fields.some((f) => f.selector === '#code')).toBe(false)
    expect(roles(s)).toEqual(['username', 'password'])
  })

  test('a hidden autocomplete=username carrier is kept; a hidden plain input is dropped', () => {
    const s = scan(`
      <form>
        <input id="carrier" type="text" autocomplete="username" style="display:none" value="ada@acme.test" />
        <input id="noise" type="text" style="display:none" name="csrf" />
        <input id="pw" type="password" autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    `)
    const u = byRole(s, 'username')
    expect(u.length).toBe(1)
    expect(u[0].selector).toBe('#carrier')
    expect(u[0].visible).toBe(false)
    // The hidden non-autocomplete input is never offered.
    expect(s.fields.some((f) => f.selector === '#noise')).toBe(false)
  })

  test('data-1p-ignore on <body> silences the whole page', () => {
    const s = scan(
      `<input id="email" type="email" autocomplete="username" /><input id="pw" type="password" />`,
      'https://acme.test/login',
    )
    // Sanity: without the opt-out this WOULD be a form.
    expect(s.form).toBe(true)

    const dom = new JSDOM(
      '<!doctype html><html><body data-1p-ignore><input id="email" type="email" autocomplete="username" /><input id="pw" type="password" /></body></html>',
      { url: 'https://acme.test/login' },
    )
    const opted = detectLogin(dom.window.document, dom.window as unknown as Window & typeof globalThis)
    expect(opted.form).toBe(false)
    expect(opted.fields).toEqual([])
  })

  test('data-1p-ignore on a field drops only that field', () => {
    const s = scan(`
      <form>
        <input id="email" type="email" autocomplete="username" data-1p-ignore />
        <input id="pw" type="password" autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    `)
    expect(s.form).toBe(true)
    // The ignored username is gone; the password still stands.
    expect(byRole(s, 'username')).toEqual([])
    expect(byRole(s, 'password').length).toBe(1)
    expect(s.multiStep).toBe('password-only')
  })

  test('a keyword-only username never overrides a sibling carrying autocomplete=username', () => {
    const s = scan(`
      <form>
        <input id="kw" type="text" name="user_login" />
        <input id="ac" type="text" autocomplete="username" />
        <input id="pw" type="password" autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    `)
    const u = byRole(s, 'username')
    expect(u.length).toBe(1)
    // The autocomplete token wins over the keyword-only sibling.
    expect(u[0].selector).toBe('#ac')
    expect(u[0].source).toBe('autocomplete')
  })

  test('a plain text field before the password is the username by adjacency', () => {
    // With no autocomplete anywhere, the backward walk (spec §1.2 STEP 2) claims
    // the last username-typed field before the anchor — a higher signal than the
    // keyword tie-breaker (STEP 3.4), so `source` is adjacency, not keyword.
    const s = scan(`
      <form>
        <input id="kw" type="text" name="user_login" />
        <input id="pw" type="password" />
        <button type="submit">Sign in</button>
      </form>
    `)
    const u = byRole(s, 'username')
    expect(u.length).toBe(1)
    expect(u[0].selector).toBe('#kw')
    expect(u[0].source).toBe('adjacency')
  })

  test('a search field before the password is NOT taken as the username', () => {
    // spec §1.2 STEP 2 excludes search/number/etc. as username candidates, so a
    // lone password with only a search box beside it is a password-only step.
    const s = scan(`
      <form>
        <input id="q" type="search" name="search" />
        <input id="pw" type="password" autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    `)
    expect(byRole(s, 'username')).toEqual([])
    expect(s.multiStep).toBe('password-only')
  })

  test('an input inside an OPEN shadow root is pierced and found', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acme.test/login' })
    const doc = dom.window.document
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML =
      '<form><input id="email" type="email" autocomplete="username" /><input id="pw" type="password" autocomplete="current-password" /></form>'
    const s = detectLogin(doc, dom.window as unknown as Window & typeof globalThis)
    expect(s.form).toBe(true)
    expect(roles(s)).toEqual(['username', 'password'])
    // Shadow fields carry a frame token the fill verb re-resolves (spec §1.4).
    expect(byRole(s, 'password')[0].selector.startsWith('__frame(')).toBe(true)
  })

  test('a cross-origin iframe sets frameHint and never throws', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acme.test/login' })
    const doc = dom.window.document
    doc.body.innerHTML = '<input id="email" type="email" autocomplete="username" /><iframe id="widget"></iframe>'
    const frame = doc.getElementById('widget')!
    // Simulate the cross-origin SecurityError a real browser throws on access.
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new dom.window.DOMException('cross-origin', 'SecurityError')
      },
    })
    let s: LoginScan | undefined
    expect(() => {
      s = detectLogin(doc, dom.window as unknown as Window & typeof globalThis)
    }).not.toThrow()
    expect(s!.frameHint).toBe('cross-origin-iframe')
  })

  test('more than MAX_PARSEABLE_FIELDS candidates → too-many-fields, bail', () => {
    let html = '<form>'
    for (let i = 0; i < 101; i++) html += '<input type="text" name="f' + i + '" />'
    html += '<input id="pw" type="password" /></form>'
    const s = scan(html)
    expect(s.form).toBe(false)
    expect(s.reason).toBe('too-many-fields')
  })

  test('all candidates hidden → all-hidden', () => {
    const s = scan(`
      <form>
        <input id="email" type="email" autocomplete="username" style="display:none" />
        <input id="pw" type="password" style="visibility:hidden" />
        <button type="submit">Sign in</button>
      </form>
    `)
    // The hidden autocomplete=username carrier alone is not a form without a
    // visible (or carrier) password anchor.
    expect(s.form).toBe(false)
    expect(s.reason).toBe('all-hidden')
  })
})

describe('the detector is ONE source of truth with the server', () => {
  test('SCAN_LOGIN_JS is byte-identical to the Rust const', () => {
    const rust = readFileSync(new URL('../../../server/src/connectors/browser/takeover.rs', import.meta.url), 'utf8')
    const start = 'pub const SCAN_LOGIN_JS: &str = r##"'
    const si = rust.indexOf(start)
    expect(si).toBeGreaterThan(-1)
    const from = si + start.length
    const ei = rust.indexOf('"##;', from)
    expect(ei).toBeGreaterThan(-1)
    const embedded = rust.slice(from, ei)
    expect(embedded).toBe(SCAN_LOGIN_JS)
  })

  test('the embedded body is a self-contained IIFE that never uses a bare CSS global', () => {
    // Under `new Function` (the jsdom path) a bare `CSS` reference would throw;
    // the body must reach it through `window.CSS`. This guards the invariant the
    // shadow/selector tests depend on.
    expect(SCAN_LOGIN_JS.startsWith('(() => {')).toBe(true)
    expect(SCAN_LOGIN_JS.endsWith('})()')).toBe(true)
    expect(SCAN_LOGIN_JS.includes('win.CSS')).toBe(true)
    // No bare `CSS.escape(` CALL — every invocation goes through `win.` (a
    // comment mentioning CSS.escape is not a call and does not count).
    expect(/[^.]CSS\.escape\(/.test(SCAN_LOGIN_JS)).toBe(false)
  })
})
