/**
 * The Bot Mode intro gate — the predicate the e2e suite now stamps past.
 * ─────────────────────────────────────────────────────────────────────────────
 * `BotModeIntro` is a `fixed inset-0` opaque modal on `/`. Because it covered
 * the overview for every fresh profile, the smoke harness now pre-answers it
 * for every spec (`tests/e2e/smoke/harness.ts` → `FIRST_RUN_ANSWERED`), which
 * removes the last automated proof that the gate itself is correct. This file
 * is that proof, at the only level it can be pinned without a DOM: the pure
 * predicate over storage.
 *
 * This repo has no jsdom (see `chat-attachment-chips.test.tsx`), so
 * `localStorage` is installed as a minimal in-memory double — which is also the
 * only way to reach the two branches that matter most: the key being absent,
 * and storage THROWING (private mode), where "don't show" is the required
 * answer rather than a crash in the shell.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const KEY = 'supermux-botmode-intro-seen'

type Store = Record<string, string>

/** Install a localStorage double. `throws` models private-mode storage. */
function installStorage(opts: { seed?: Store; throws?: boolean } = {}) {
  const map: Store = { ...(opts.seed ?? {}) }
  const boom = () => {
    throw new Error('storage disabled')
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (opts.throws ? boom() : (k in map ? map[k] : null)),
    setItem: (k: string, v: string) => {
      if (opts.throws) boom()
      map[k] = v
    },
    removeItem: (k: string) => {
      if (opts.throws) boom()
      delete map[k]
    },
  }
  return map
}

// The module reads `localStorage` at CALL time, not at import time, so a fresh
// double per test is enough — no module cache dance.
const gate = await import('../../src/lib/botmode-onboarding')

beforeEach(() => installStorage())
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('shouldShowBotModeIntro', () => {
  test('shows on a first run: Bot Mode off and the key absent', () => {
    installStorage()
    expect(gate.shouldShowBotModeIntro(false)).toBe(true)
  })

  test('never shows to a user already in Bot Mode', () => {
    installStorage()
    expect(gate.shouldShowBotModeIntro(true)).toBe(false)
  })

  test('never shows again once answered — a recommendation, not a changelog', () => {
    installStorage()
    gate.completeBotModeIntro()
    expect(gate.shouldShowBotModeIntro(false)).toBe(false)
  })

  test('an empty-string stamp still counts as answered (only `null` re-arms)', () => {
    installStorage({ seed: { [KEY]: '' } })
    expect(gate.shouldShowBotModeIntro(false)).toBe(false)
  })

  test('storage that throws degrades to "do not show", never to a crash', () => {
    installStorage({ throws: true })
    expect(() => gate.shouldShowBotModeIntro(false)).not.toThrow()
    expect(gate.shouldShowBotModeIntro(false)).toBe(false)
    // The writers swallow it too — the shell must survive private mode.
    expect(() => gate.completeBotModeIntro()).not.toThrow()
    expect(() => gate.resetBotModeIntro()).not.toThrow()
  })

  test('the Settings replay control re-arms it', () => {
    installStorage()
    gate.completeBotModeIntro()
    gate.resetBotModeIntro()
    expect(gate.shouldShowBotModeIntro(false)).toBe(true)
  })
})

describe('the e2e stamp answers the real key', () => {
  // The harness writes this exact key before the first navigation. If the
  // product ever renames it, the suite would silently go back to being
  // overlaid — so the two are pinned to each other here.
  test('the seen-key the smoke harness stamps is the one the gate reads', () => {
    installStorage({ seed: { [KEY]: 'e2e' } })
    expect(gate.shouldShowBotModeIntro(false)).toBe(false)
  })
})
