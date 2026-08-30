/**
 * The LOGIN GATE's markup — owner bug #1.
 * ─────────────────────────────────────────────────────────────────────────────
 * Opening the app URL on a company / quick-tunnel host with no credentials used
 * to render the Bot-Mode onboarding intro: a five-screen story pitching a mode
 * switch, shown to somebody who had not signed in and could not. There was no
 * login screen in the product at all.
 *
 * This repo has no jsdom (see `chat-attachment-chips.test.tsx`), so a real typed
 * submit is Playwright's job; what a unit test pins is the STRUCTURE — that the
 * gate is a sign-in screen with a key field and a connect button, that it names
 * the invite path for the colleague who has no key, and that it never leaks an
 * app affordance.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { LoginGate } from '../../src/components/auth/login-gate'

const html = renderToStaticMarkup(<LoginGate onAuthenticated={() => undefined} />)

describe('<LoginGate>', () => {
  test('says what this is, honestly and without jargon', () => {
    expect(html).toContain('This is a private workspace')
    expect(html).toContain('Sign in to continue.')
  })

  test('offers exactly one credential field, labelled, masked, and a11y-wired', () => {
    expect(html).toContain('id="supermux-access-key"')
    expect(html).toContain('type="password"')
    expect(html).toContain('for="supermux-access-key"')
    expect(html).toContain('Access key')
    expect(html).toContain('Paste your access key')
    // One field only — a login screen that also asks for a username would be
    // asking for something this server has no concept of.
    expect(html.match(/<input/g) ?? []).toHaveLength(1)
  })

  test('the connect button starts disabled — nothing to submit yet', () => {
    expect(html).toContain('Connect')
    expect(html).toContain('disabled=""')
  })

  test('names the invited colleague’s path, who has no key at all', () => {
    expect(html).toContain('Got an invite link? Open it')
  })

  test('shows no error before anything was tried', () => {
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain("wasn't accepted")
  })

  test('is a full-screen replacement for the app, not an overlay on it', () => {
    expect(html).toContain('data-login-gate=""')
    expect(html).toContain('min-h-dvh')
    // Theme-correct by construction: every surface, ink and ring the gate paints
    // is a semantic token, so the shell's `.dark` class drives it and neither
    // theme needs its own branch. (The only literal colours in the markup are
    // the brand mark's own gradient stops, which are theme-independent pigment.)
    for (const token of [
      'bg-background',
      'text-foreground',
      'bg-card',
      'border-input',
      'text-muted-foreground',
      'bg-primary',
      'ring-ring',
    ]) {
      expect(html).toContain(token)
    }
  })

  test('carries none of the app: no nav, no roster, no onboarding story', () => {
    for (const leak of ['Start a company', 'New company', 'HQ', 'Settings', 'Archived']) {
      expect(html).not.toContain(leak)
    }
  })
})
