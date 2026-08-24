/**
 * The bot settings surface: the role pills, and the tab they sit beside.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 1 — The role pills must never eat an authored instruction.
 * ─────────────────────────────────────────────────────────────────────────────
 * A preset used to `setDesc(name, p.text)` — one tap REPLACED the whole standing
 * instruction, through a PATCH the field then re-seeded from, with nothing to
 * undo. The fix moves the pills onto `DescEditorHandle`, whose insert rule is
 * this pure function; the contract it has to keep is the only one that matters:
 *
 *   nothing that was already written comes out.
 *
 * The rest — where the block lands, how it is spaced — is taste, and pinned here
 * so a later "tidy" cannot quietly turn insert back into overwrite.
 */
import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import { afterUndo, type AppliedPreset } from '../../src/components/roster/bot-panel'
import { insertPreset, makeDescHandle } from '../../src/components/focus-mode/session-info-panel'

const PRESET = 'You review changes for correctness and clarity.'
const MINE = 'Never touch main. Always run the unit suite before you claim done.'

describe('insertPreset', () => {
  test('an empty field is simply filled', () => {
    expect(insertPreset('', PRESET, null)).toEqual({ next: PRESET, caret: PRESET.length })
    // Whitespace is not content — a field holding only a stray newline fills too.
    expect(insertPreset('\n  \n', PRESET, 2).next).toBe(PRESET)
  })

  test('an authored instruction SURVIVES the preset', () => {
    const { next } = insertPreset(MINE, PRESET, null)
    expect(next).toContain(MINE)
    expect(next).toContain(PRESET)
    // Appended, as its own paragraph, after what was there.
    expect(next).toBe(`${MINE}\n\n${PRESET}`)
  })

  test('the caret decides where the block lands — and both halves stay', () => {
    const head = 'Ship small.'
    const tail = 'Ask before deleting anything.'
    const { next, caret } = insertPreset(`${head}\n\n${tail}`, PRESET, head.length)
    expect(next).toBe(`${head}\n\n${PRESET}\n\n${tail}`)
    // The caret comes back at the END of the inserted block, so the user types on
    // from the preset rather than in front of the text below it.
    expect(next.slice(0, caret)).toBe(`${head}\n\n${PRESET}`)
    expect(next).toContain(tail)
  })

  test('a preset never glues itself onto the middle of a sentence', () => {
    const { next } = insertPreset('Read the diff and ', PRESET, 18)
    expect(next).toBe(`Read the diff and\n\n${PRESET}`)
    expect(next).not.toContain(`and ${PRESET}`)
  })

  test('an out-of-range or missing caret falls back to the end', () => {
    expect(insertPreset(MINE, PRESET, 9999).next).toBe(`${MINE}\n\n${PRESET}`)
    expect(insertPreset(MINE, PRESET, -1).next).toBe(`${MINE}\n\n${PRESET}`)
    expect(insertPreset(MINE, PRESET, null).next).toBe(`${MINE}\n\n${PRESET}`)
  })

  test('two presets in a row keep BOTH, and the first is still there', () => {
    const one = insertPreset(MINE, PRESET, null)
    const two = insertPreset(one.next, 'You keep things running.', one.caret)
    expect(two.next).toContain(MINE)
    expect(two.next).toContain(PRESET)
    expect(two.next).toContain('You keep things running.')
  })
})

/**
 * 2 — The tab is CALLED "Connectors" and keyed `'tools'`.
 * ─────────────────────────────────────────────────────────────────────────────
 * The word was wrong (its own body leads with connectors, and the store, the
 * grants list and the mail card all say "connectors"), but the KEY is router
 * state: `panelTab` in history, `initialTab`/`infoTab` on the two routes, the
 * `data-vr-tab` bench hook. Renaming the key would break every deep link that
 * already exists, so exactly one of the two changed — and this pins which.
 */
describe('the Connectors tab', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  test('the bot panel shows the word and keeps the key', () => {
    const src = read('../../src/components/roster/bot-panel.tsx')
    expect(src).toContain("{ key: 'tools', label: 'Connectors' }")
    expect(src).not.toContain("label: 'Tools'")
    // The key is still what the routes and the deep-link state speak.
    expect(src).toContain('initialTab?: TabKey')
    expect(src).toContain("{tab === 'tools' && <ToolsTab")
  })

  test('the team panel says the same word (it mounts the same tab body)', () => {
    const src = read('../../src/components/roster/team-panel.tsx')
    expect(src).toContain("{ key: 'tools', label: 'Connectors' }")
    expect(src).not.toContain("label: 'Tools'")
  })

  test("a connector's OWN tools keep their name", () => {
    // `tool_count` / `ConnectorTool` mean the tools inside one connector — a
    // different thing entirely, and untouched by the relabel.
    const api = read('../../src/lib/api/connectors.ts')
    expect(api).toContain('tool_count')
  })
})

/**
 * 3 — The context ring paints.
 * ─────────────────────────────────────────────────────────────────────────────
 * `--status-active-ink` is a bare HSL TRIPLET (`38 92% 33%`), not a colour, so
 * `conic-gradient(var(--status-active-ink) 48%, …)` was invalid at
 * computed-value time and the glance's hero stat rendered a percentage on a
 * blank card. The `--color-*` tokens are the same values already wrapped in
 * `hsl()` — the only form a gradient can consume.
 */
describe('the context ring', () => {
  const src = readFileSync(
    new URL('../../src/components/roster/bot-panel.tsx', import.meta.url),
    'utf8',
  )

  test('colours the ring with real colours, never raw triplets', () => {
    expect(src).toContain('conic-gradient(')
    expect(src).toContain('var(--color-status-ready-ink')
    expect(src).toContain('var(--color-status-active-ink')
    expect(src).toContain('var(--color-status-error-ink')
    expect(src).not.toContain('var(--status-active-ink')
    expect(src).not.toContain('var(--status-waiting-ink')
    expect(src).not.toContain('var(--status-error-ink')
  })
})

/**
 * 4 — The Undo path, at the seam.
 * ─────────────────────────────────────────────────────────────────────────────
 * `bun test` has no DOM, so the handle is built by a pure factory
 * (`makeDescHandle`) over the field's state and the receipt row's transition is a
 * pure function (`afterUndo`). Both decision points are therefore reachable here:
 *
 *   · an insert edits the draft and does NOT write (blur-commit owns that);
 *   · an undo REFUSES once the field has moved on — and the row must then STAY,
 *     re-worded, because clearing it would claim an undo that never happened;
 *   · an undo that lands is PERSISTED immediately, not left to an incidental
 *     unmount.
 */
describe('the undo path', () => {
  /** A stand-in for the live field: records every call the handle makes. */
  function field(draft: string, caret: number | null = null) {
    const calls = { draft, caret, setDraft: [] as string[], persist: [] as string[], refocus: [] as number[] }
    const handle = makeDescHandle({
      get draft() {
        return calls.draft
      },
      caret: () => calls.caret,
      setDraft: (v) => {
        calls.setDraft.push(v)
        calls.draft = v
      },
      setCaret: (n) => {
        calls.caret = n
      },
      persist: (v) => calls.persist.push(v),
      refocus: (n) => calls.refocus.push(n),
    })
    return { handle, calls }
  }

  test('an insert edits the draft, focuses it, and writes NOTHING', () => {
    const { handle, calls } = field(MINE)
    const { prev, next } = handle.insert(PRESET)
    expect(prev).toBe(MINE)
    expect(next).toBe(`${MINE}\n\n${PRESET}`)
    expect(calls.setDraft).toEqual([next])
    // The blur-commit owns persistence — an insert that PATCHed is exactly the
    // bug this whole path exists to remove.
    expect(calls.persist).toEqual([])
    expect(calls.refocus).toEqual([next.length])
  })

  test('an undo the field has moved on from is REFUSED and changes nothing', () => {
    const { handle, calls } = field(MINE)
    const { prev, next } = handle.insert(PRESET)
    // …the user types on, without blurring.
    calls.draft = `${next} And never force-push.`
    calls.setDraft.length = 0

    expect(handle.restore(prev, next)).toBe(false)
    expect(calls.setDraft).toEqual([])
    expect(calls.persist).toEqual([])
    expect(calls.draft).toContain('And never force-push.')
  })

  test('a refused undo KEEPS the receipt row and re-words it', () => {
    const applied: AppliedPreset = { label: 'Reviewer', prev: MINE, after: `${MINE}\n\n${PRESET}` }
    const kept = afterUndo(applied, false)
    expect(kept).not.toBeNull()
    expect(kept?.refused).toBe(true)
    // The undo stays offered-but-honest: nothing about the insert is forgotten.
    expect(kept?.prev).toBe(MINE)
    expect(kept?.after).toBe(applied.after)
  })

  test('an undo that lands reverts, PERSISTS, and clears the row', () => {
    const { handle, calls } = field(MINE)
    const { prev, next } = handle.insert(PRESET)
    calls.setDraft.length = 0

    expect(handle.restore(prev, next)).toBe(true)
    expect(calls.setDraft).toEqual([MINE])
    // Written through immediately: the preset may already have been
    // blur-committed, and a revert that only lived in React state would leave
    // the server holding the preset text.
    expect(calls.persist).toEqual([MINE])
    expect(afterUndo({ label: 'Reviewer', prev, after: next }, true)).toBeNull()
  })

  test('an unguarded restore still works (no `expect` passed)', () => {
    const { handle, calls } = field(`${MINE} edited`)
    expect(handle.restore(MINE)).toBe(true)
    expect(calls.setDraft).toEqual([MINE])
    expect(calls.persist).toEqual([MINE])
  })
})
