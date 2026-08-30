/**
 * The sign-in bridge: the sequence a password-manager fill becomes, and the
 * attributes that let a manager fill it at all.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The shared browser is a remote Chrome on a canvas — the human's own manager
 * cannot see its fields — so a real form here carries the fill and `signInOps`
 * turns it into the ordered relay (`text → Tab → text → Enter`) the takeover
 * socket plays into the page. Two invariants are load-bearing and pinned:
 *
 *   1. A blank field is SKIPPED, and the Tab rides ONLY between two filled
 *      fields — that one rule is what makes "username only" and "password only"
 *      the same function with a field left out, instead of a stray Tab leaving
 *      the field it just typed into.
 *   2. Enter is opt-in — a submit into the wrong field is not recoverable, a
 *      fill into it is.
 */
import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import { signInOps } from '../../src/lib/browser/takeover-socket'

describe('signInOps', () => {
  test('both fields: username, Tab, password — in that order', () => {
    expect(signInOps({ username: 'ada@x.io', password: 'hunter2' })).toEqual([
      { kind: 'text', text: 'ada@x.io' },
      { kind: 'key', key: 'Tab' },
      { kind: 'text', text: 'hunter2' },
    ])
  })

  test('username only: no Tab, no password — types into the focused field', () => {
    expect(signInOps({ username: 'ada@x.io' })).toEqual([{ kind: 'text', text: 'ada@x.io' }])
  })

  test('password only: no Tab out of the field it just filled', () => {
    expect(signInOps({ password: 'hunter2' })).toEqual([{ kind: 'text', text: 'hunter2' }])
  })

  test('submit appends a single Enter, and only when something was typed', () => {
    expect(signInOps({ username: 'ada@x.io', password: 'hunter2', submit: true })).toEqual([
      { kind: 'text', text: 'ada@x.io' },
      { kind: 'key', key: 'Tab' },
      { kind: 'text', text: 'hunter2' },
      { kind: 'key', key: 'Enter' },
    ])
    // A submit with nothing to submit is not an Enter into an empty page.
    expect(signInOps({ submit: true })).toEqual([])
    // Password-only still submits (one field, one Enter, no Tab).
    expect(signInOps({ password: 'hunter2', submit: true })).toEqual([
      { kind: 'text', text: 'hunter2' },
      { kind: 'key', key: 'Enter' },
    ])
  })

  test('an empty fill is an empty relay, never a poke', () => {
    expect(signInOps({})).toEqual([])
    expect(signInOps({ username: '', password: '' })).toEqual([])
  })
})

/**
 * The manager only offers the key if it recognises the pair: the two inputs
 * MUST carry `autocomplete="username"` and `autocomplete="current-password"`,
 * and they must be 16px or iOS zooms the whole shell (the address bar's lesson).
 * The password must clear when the sheet closes — a secret must not sit in a
 * React tree behind it. Asserted on the source so a later tidy cannot quietly
 * drop one and leave the fill working but un-fillable.
 */
describe('the sign-in sheet keeps the password-manager contract', () => {
  const src = readFileSync(new URL('../../src/components/browser/sign-in-sheet.tsx', import.meta.url), 'utf8')

  test('the fields carry the autocomplete tokens a manager fills', () => {
    expect(src).toContain('autoComplete="username"')
    expect(src).toContain('autoComplete="current-password"')
    expect(src).toContain('type="password"')
    // A real <form>, or a manager treats the inputs as unrelated singletons.
    expect(src).toContain('<form')
  })

  test('inputs are 16px so focusing one does not zoom iOS', () => {
    expect(src).toContain('text-[16px]')
  })

  test('the password is cleared when the sheet closes', () => {
    expect(src).toContain("setPassword('')")
  })
})
