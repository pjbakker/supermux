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

import {
  afterUndo,
  coreNotesBudget,
  CORE_MAX_CHARS,
  CORE_MAX_LINES,
  handoffView,
  lastExchange,
  normalizeTab,
  TABS,
  type AppliedPreset,
} from '../../src/components/roster/bot-panel'
import { insertPreset, makeDescHandle } from '../../src/components/focus-mode/session-info-panel'
import type { LastSend } from '../../src/components/focus-mode/last-send-recall'
import type { DelegationEdge } from '../../src/lib/api/agents'
import type { RecallEntry } from '../../src/lib/api/sessions'

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
 * 2 — Five tabs folded to THREE, and the config tab keeps its key.
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner found five settings screens (Overview · Instructions · Connectors ·
 * Memory · Workflows) redundant and nerdy — the core-notes editor even appeared
 * on two of them — and they overflowed the phone tab bar. Instructions +
 * Connectors + Memory folded into ONE "Setup" tab; Overview and Workflows stay.
 *
 * The KEY is router state (`panelTab` in history, `initialTab`/`infoTab` on the
 * two routes, the `data-vr-tab` bench hook), so the config tab stays keyed
 * `'instructions'` even though its LABEL is now "Setup" — the same key-vs-label
 * split the panel already used. A bookmarked `tools`/`memory` panelTab is
 * re-pointed onto Setup by `normalizeTab`, never landing on a dead body.
 */
describe('the three-tab fold', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  test('the bot panel is three tabs, config keyed instructions and labelled Setup', () => {
    expect(TABS.map((t) => [t.key, t.label])).toEqual([
      ['overview', 'Overview'],
      ['instructions', 'Setup'],
      ['workflows', 'Workflows'],
    ])
    const src = read('../../src/components/roster/bot-panel.tsx')
    // The two folded keys are no longer their own tabs.
    expect(src).not.toContain("key: 'tools'")
    expect(src).not.toContain("key: 'memory'")
    // The key is still what the routes and the deep-link state speak.
    expect(src).toContain('initialTab?: TabKey')
    expect(src).toContain("{tab === 'instructions' && (")
    expect(src).toContain('<SetupTab')
  })

  test('normalizeTab re-points every legacy key onto a tab that still exists', () => {
    // The folded-away keys land on Setup; the survivors pass through; junk falls
    // back to Overview rather than a blank panel.
    expect(normalizeTab('tools')).toBe('instructions')
    expect(normalizeTab('memory')).toBe('instructions')
    expect(normalizeTab('instructions')).toBe('instructions')
    expect(normalizeTab('overview')).toBe('overview')
    expect(normalizeTab('workflows')).toBe('workflows')
    expect(normalizeTab(undefined)).toBe('overview')
    expect(normalizeTab('nonsense')).toBe('overview')
  })

  test('the team panel mirrors the fold — three tabs, Setup keyed instructions', () => {
    const src = read('../../src/components/roster/team-panel.tsx')
    expect(src).toContain("{ key: 'instructions', label: 'Setup' }")
    expect(src).not.toContain("label: 'Connectors' }")
    expect(src).not.toContain("key: 'tools'")
  })

  test('Setup keeps every capability the three folded tabs held', () => {
    const src = read('../../src/components/roster/bot-panel.tsx')
    // Instructions: role presets + model. Connectors: the grants surface.
    // Memory: core notes AND the learned notes. Nothing deleted, only grouped.
    expect(src).toContain('<RoleField')
    expect(src).toContain('<ModelPicker')
    expect(src).toContain('<GrantedConnectors')
    expect(src).toContain('<NotesEditor')
    expect(src).toContain('<LearnedNotes')
    expect(src).toContain('<NotifPolicyControl')
    // The nerdy launch internals are folded under one Advanced disclosure, not
    // dropped.
    expect(src).toContain('<LaunchInternals')
  })

  test("a connector's OWN tools keep their name", () => {
    // `tool_count` / `ConnectorTool` mean the tools inside one connector — a
    // different thing entirely, and untouched by the fold.
    const api = read('../../src/lib/api/connectors.ts')
    expect(api).toContain('tool_count')
  })
})

/**
 * 2b — The tab bar FITS the phone, and the body (not the bar) scrolls.
 * ─────────────────────────────────────────────────────────────────────────────
 * The five-tab bar was `flex gap-1` over intrinsic-width tabs: at 390px it
 * overflowed and the last tab ("Workflows") was clipped. Three equal-width tabs
 * (`flex-1 basis-0`) divide the width instead — there is no per-tab fixed width
 * to sum past the viewport, and the bar declares no horizontal scroll. bun has
 * no layout engine, so this is a STRUCTURAL proof (the class contract that makes
 * overflow impossible), asserted on both the bot and team bars.
 */
describe('the tab bar fits a 390 / 320px phone', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  for (const file of ['bot-panel.tsx', 'team-panel.tsx']) {
    test(`${file}: the tablist is equal-width and never scrolls sideways`, () => {
      const src = read(`../../src/components/roster/${file}`)
      const bar = src.slice(src.indexOf('role="tablist"'))
      const openTag = bar.slice(0, bar.indexOf('>'))
      // The container fills the width and lays its tabs out as flex cells…
      expect(openTag).toContain('flex w-full')
      // …and it does NOT opt into horizontal scrolling (which would mean it can
      // exceed the width) — the fix is fitting, not scrolling.
      expect(openTag).not.toContain('overflow-x')
      // Each tab is an equal share of the row, so N tabs can never sum wider
      // than the row regardless of label length or viewport.
      expect(bar).toContain('flex-1 basis-0')
      // 44px minimum touch target survives the redesign.
      expect(bar).toContain('min-h-11')
    })
  }
})

/**
 * 2c — Advanced clips its long values instead of panning the panel sideways.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Flags value was a bare `<code className="max-w-full truncate …">`. `<code>`
 * is `display: inline`, and on an inline box BOTH of those are inert — so a real
 * launch line (`--dangerously-skip-permissions --permission-mode …`) measured
 * 474px inside a 390px column and took the whole `#bot-tabpanel` with it
 * (scrollWidth 557 vs clientWidth 390). The sibling MCP row had it right.
 *
 * Structural proof again — bun has no layout engine — but a precise one: every
 * `<code>` inside `<LaunchInternals>` must be a BLOCK box before `truncate` can
 * mean anything.
 */
describe('the Advanced disclosure cannot overflow its column', () => {
  test('every code value in LaunchInternals is a block box, so truncate applies', () => {
    const src = readFileSync(
      new URL('../../src/components/roster/bot-panel.tsx', import.meta.url),
      'utf8',
    )
    const start = src.indexOf('function LaunchInternals(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}', start))
    const codes = body.match(/<code className="[^"]*"/g) ?? []
    // MCP and Flags — the two values long enough to overflow a phone.
    expect(codes.length).toBe(2)
    for (const c of codes) {
      expect(c).toContain('block')
      expect(c).toContain('truncate')
      expect(c).toContain('max-w-full')
    }
  })
})

/**
 * 2d — A tab opens at its own top.
 * ─────────────────────────────────────────────────────────────────────────────
 * One scroller serves all three tabs, so switching carried the previous tab's
 * offset over: from a scrolled Overview, the header's "Say what this bot does →"
 * landed on Setup at scrollTop 869 of 869 — Notifications/Advanced, with the
 * field the button names entirely off-screen. Asserted structurally on both
 * panels: the scrolling body takes a ref, and an effect keyed on `tab` zeroes it.
 */
describe('switching tabs does not carry the previous tab’s scroll', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  for (const file of ['bot-panel.tsx', 'team-panel.tsx']) {
    test(`${file}: the tab body is reset when \`tab\` changes`, () => {
      const src = read(`../../src/components/roster/${file}`)
      const at = src.indexOf('const body = React.useRef<HTMLDivElement | null>(null)')
      expect(at).toBeGreaterThan(-1)
      const effect = src.slice(at, at + 300)
      expect(effect).toContain('if (body.current) body.current.scrollTop = 0')
      // Keyed on the tab, not on mount — a mount-only reset is the bug itself.
      expect(effect).toContain('}, [tab])')
      // …and the ref is actually attached to the scroller.
      const panel = src.slice(src.indexOf('{/* scrolling tab body */}'))
      expect(panel.slice(0, panel.indexOf('>'))).toContain('ref={body}')
    })
  }
})

/**
 * 3 — The glance stopped rendering fields no server writes.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Overview opened on a 2×2 grid — Context ring / Tokens / Provider / Status
 * — over `session.tokens`, a key `ApiSession` declares and NOTHING in
 * `server/src` produces. The ring was permanently `—`, Tokens permanently
 * `0 · cumulative`, and the "Latest" bubble beside them read `chat_tail ??
 * task_summary`: one SSE-delta-only (absent on every fresh open), the other with
 * no producer either. Four cards and a bubble, empty on every live install.
 *
 * A field with no producer is DELETED, not em-dashed — and `<TeamPanel>` kept
 * its OWN copy of the same dead ring, so it goes in the same pass or the lie
 * survives one tap away.
 */
describe('the dead glance is gone from both panels', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

  for (const file of ['bot-panel.tsx', 'team-panel.tsx']) {
    test(`${file}: no context ring, no token readout`, () => {
      const src = read(`../../src/components/roster/${file}`)
      expect(src).not.toContain('conic-gradient(')
      expect(src).not.toContain('ctxPct')
      expect(src).not.toContain('fmtTokens')
      expect(src).not.toContain('CTX_WINDOW')
    })
  }

  test('the bot panel reads the fields that ARE populated instead', () => {
    const src = read('../../src/components/roster/bot-panel.tsx')
    // The live row, the prompt off the session row, and the two cheap reads.
    expect(src).toContain('<ActivityLine')
    expect(src).toContain('<BlockedBadge')
    expect(src).toContain('useLastSend')
    expect(src).toContain('sessionsApi.recall')
    expect(src).toContain('agentsApi.delegations')
    // …and nothing that only a mock can fill (the prose above still names the
    // three dead fields, which is the point — they are documented, not read).
    expect(src).not.toContain('session?.tokens')
    expect(src).not.toContain('session?.task_summary')
    expect(src).not.toContain('session?.chat_tail')
  })

  test('the bench seeds the shipped panel, not the deleted one', () => {
    // A bench fed by dead fields frames a panel nobody ships — the design review
    // would sign off on a surface that cannot exist.
    const src = read('../../src/routes/dev-roster.tsx')
    const seed = src.slice(src.indexOf('const MOCK_BOT'), src.indexOf('const benchStep'))
    expect(seed).not.toContain('tokens:')
    expect(seed).not.toContain('task_summary:')
    expect(seed).toContain('last_send_text:')
    expect(seed).toContain('activity:')
  })
})

/**
 * 3b — The core-notes counter states the budget the SERVER applies.
 * ─────────────────────────────────────────────────────────────────────────────
 * The editor said `~N / 2000 chars`. `cap_core_notes`
 * (`server/src/sessions/lifecycle.rs`) truncates at 40 LINES or 6,000 CHARS,
 * whichever bites first — so the old counter was wrong on both axes and silent
 * about the budget that usually bites. This is the mirror; if the Rust moves,
 * these numbers must move with it.
 */
describe('coreNotesBudget mirrors cap_core_notes', () => {
  test('the server-side budgets, verbatim', () => {
    expect(CORE_MAX_LINES).toBe(40)
    expect(CORE_MAX_CHARS).toBe(6_000)
  })

  test('an empty field is ZERO lines, not one', () => {
    // Rust's `str::lines()` yields nothing for ""; JS's `''.split('\n')` yields
    // one entry. Counting the JS way would open every fresh bot on "1 / 40".
    expect(coreNotesBudget('')).toEqual({ lines: 0, chars: 0, overLines: false, overChars: false })
    expect(coreNotesBudget('   \n\n ')).toEqual({ lines: 0, chars: 0, overLines: false, overChars: false })
  })

  test('an ordinary index is under both budgets', () => {
    const notes = '- the build gate is bun run build:perf\n- never edit server/migrations'
    const b = coreNotesBudget(notes)
    expect(b.lines).toBe(2)
    expect(b.chars).toBe(notes.length)
    expect(b.overLines).toBe(false)
    expect(b.overChars).toBe(false)
  })

  test('41 lines is over the LINE budget only', () => {
    const b = coreNotesBudget(Array.from({ length: 41 }, (_, i) => `- fact ${i}`).join('\n'))
    expect(b.lines).toBe(41)
    expect(b.overLines).toBe(true)
    expect(b.overChars).toBe(false)
  })

  test('one 6,001-char line is over the CHAR budget only', () => {
    const b = coreNotesBudget('x'.repeat(6_001))
    expect(b.lines).toBe(1)
    expect(b.chars).toBe(6_001)
    expect(b.overChars).toBe(true)
    expect(b.overLines).toBe(false)
  })

  test('characters are Unicode scalars, matching Rust chars().count()', () => {
    // `'👍'.length` is 2 (UTF-16 units) but `chars().count()` is 1 — an
    // emoji-heavy index would otherwise read as twice its real token cost.
    expect(coreNotesBudget('👍👍👍').chars).toBe(3)
  })

  test('a trailing newline is not a line', () => {
    expect(coreNotesBudget('- one\n- two\n').lines).toBe(2)
  })
})

/**
 * 3c — What the Overview shows of the last turn.
 * ─────────────────────────────────────────────────────────────────────────────
 * The "Latest" bubble read two fields that are never on a fresh panel open, so
 * it was blank every time. Its replacement selects out of ONE `?chat=true`
 * recall page; the selection is pure so it is pinned here rather than through a
 * live panel.
 */
describe('lastExchange', () => {
  const entry = (over: Partial<RecallEntry> & { kind: RecallEntry['kind'] }): RecallEntry => ({
    uuid: `u-${Math.random()}`,
    ts: 1_788_079_360,
    sessionId: 's',
    text: '',
    sidechain: false,
    ...over,
  })

  test('an empty page selects nothing at all', () => {
    expect(lastExchange([])).toEqual({ receipts: [] })
  })

  test('the NEWEST assistant line wins (the page is newest-first)', () => {
    const out = lastExchange([
      entry({ kind: 'assistant', text: 'Shipped it.' }),
      entry({ kind: 'assistant', text: 'Working on it.' }),
    ])
    expect(out.answer).toBe('Shipped it.')
  })

  test('receipts cap at three and carry a failure through', () => {
    const out = lastExchange([
      entry({ kind: 'tool_use', text: 'Bash cargo check', ok: false }),
      entry({ kind: 'tool_use', text: 'Read /opt/projects/supermux/server/src/main.rs' }),
      entry({ kind: 'tool_use', text: 'Edit /opt/projects/supermux/web/src/app.tsx' }),
      entry({ kind: 'tool_use', text: 'Read /never/rendered.ts' }),
    ])
    expect(out.receipts).toHaveLength(3)
    expect(out.receipts[0].ok).toBe(false)
    // Condensed to the part that identifies the call — a basename, not a path.
    expect(out.receipts[1].label).toContain('main.rs')
    expect(out.receipts[1].label).not.toContain('/opt/projects')
    expect(out.receipts[1].ok).toBe(true)
  })

  /* THE TURN BOUND. The card files everything this selects under ONE prompt and
     one timestamp — `lastSend` — so an entry from a different turn rendered
     beneath it is a false grouping. All three fixtures below are the shapes that
     were measured live before the fix. */

  test('with no lastSend the walk stops at the turn boundary', () => {
    const out = lastExchange([
      entry({ kind: 'assistant', text: 'Shipped it.' }),
      entry({ kind: 'tool_use', text: 'Bash cargo check' }),
      entry({ kind: 'prompt', text: 'ship it' }),
      // Everything below belongs to the turn BEFORE the one being rendered.
      entry({ kind: 'assistant', text: 'An older answer.' }),
      entry({ kind: 'tool_use', text: 'Read /never/rendered.ts' }),
    ])
    expect(out.answer).toBe('Shipped it.')
    expect(out.receipts).toHaveLength(1)
  })

  test('receipts older than the prompt above them are NOT its receipts', () => {
    // `Mail`, verbatim: the reply landed after the send, the three tool calls did
    // not, and all four were rendered under one "You asked · 12d ago".
    const sent: LastSend = { text: 'Done', sentAt: new Date(1_787_064_835 * 1000) }
    const out = lastExchange(
      [
        entry({ kind: 'assistant', ts: 1_787_064_878, text: 'Weer verbonden.' }),
        entry({ kind: 'tool_use', ts: 1_787_064_832, text: 'Bash cat devicelogin.txt' }),
        entry({ kind: 'tool_use', ts: 1_787_064_754, text: 'Bash F=devicelogin.txt' }),
      ],
      sent,
    )
    expect(out.answer).toBe('Weer verbonden.')
    expect(out.receipts).toEqual([])
  })

  test('a LATER user turn is walked past, not treated as the end of the page', () => {
    // `Research`: a `/exit` typed after the prompt the row recorded. Its own turn
    // produced nothing, and stopping at it would blank a card whose answer sits
    // one row further down.
    const sent: LastSend = { text: 'claude update', sentAt: new Date(1_787_609_207 * 1000) }
    const out = lastExchange(
      [
        entry({ kind: 'command', ts: 1_787_609_243, text: '/exit' }),
        entry({ kind: 'assistant', ts: 1_787_609_211, text: 'Up-to-date — niks te doen.' }),
        entry({ kind: 'assistant', ts: 1_787_609_191, text: 'An older answer.' }),
      ],
      sent,
    )
    expect(out.answer).toBe('Up-to-date — niks te doen.')
  })

  test('…and what that later turn DID produce is not filed under this prompt', () => {
    const sent: LastSend = { text: 'ship it', sentAt: new Date(1_787_609_207 * 1000) }
    const out = lastExchange(
      [
        entry({ kind: 'assistant', ts: 1_787_609_260, text: 'Answer to the LATER question.' }),
        entry({ kind: 'tool_use', ts: 1_787_609_250, text: 'Read /never/rendered.ts' }),
        entry({ kind: 'command', ts: 1_787_609_243, text: '/exit' }),
        entry({ kind: 'assistant', ts: 1_787_609_211, text: 'Shipped it.' }),
        entry({ kind: 'tool_use', ts: 1_787_609_210, text: 'Bash cargo check' }),
      ],
      sent,
    )
    expect(out.answer).toBe('Shipped it.')
    expect(out.receipts).toHaveLength(1)
    expect(out.receipts[0].label).toContain('cargo check')
  })

  test('kinds the panel does not render are ignored — a delegation included', () => {
    // The sender of an inbound delegation is NOT read out of the recall page any
    // more: the graph owns that fact (see `handoffView` below), so one source
    // answers "who asked" and the panel cannot state it twice.
    const out = lastExchange([
      entry({ kind: 'prompt', text: 'do the thing' }),
      entry({ kind: 'system', text: 'noise' }),
      entry({ kind: 'delegation', text: 'review the diff', label: 'mena' }),
    ])
    expect(out).toEqual({ receipts: [] })
  })
})

/**
 * 3b — One edge, said once.
 * ─────────────────────────────────────────────────────────────────────────────
 * A bot-delegated turn used to be printed three times on one screen: the card's
 * "You asked" headline over the sender's text, a "↳ from X" line under it, and
 * the top Handoffs row carrying the same partner, prompt and timestamp. Worse,
 * "You asked" was simply false — `last_send_text` is the last prompt written
 * INTO the session no matter who wrote it.
 *
 * `handoffView` is the join that fixes both: it recognises the edge the card is
 * already showing, hands its sender up as the card's label, and drops that row
 * from the list.
 */
describe('handoffView', () => {
  const edge = (over: Partial<DelegationEdge> & { id: number }): DelegationEdge => ({
    from_session: 'Invulboekjes',
    to_session: 'mena',
    prompt: 'Hoi Mena — due diligence op invulboekjes.nl.',
    ts: 1_788_079_360,
    ...over,
  })
  const sent = (text: string): LastSend => ({ text, sentAt: new Date(1_788_079_360_000) })

  test('no graph, no rows and no sender', () => {
    expect(handoffView(undefined, sent('anything'))).toEqual({ askedBy: undefined, rows: [] })
  })

  test('the edge behind the last send names the card and leaves the list', () => {
    const carrier = edge({ id: 1 })
    const older = edge({ id: 2, prompt: 'kijk even naar de bol-analyse', ts: 1_788_000_000 })
    const view = handoffView({ incoming: [carrier, older], outgoing: [] }, sent(carrier.prompt))
    expect(view.askedBy).toBe('Invulboekjes')
    expect(view.rows.map((r) => r.edge.id)).toEqual([2])
  })

  test('a send the owner typed leaves every edge standing', () => {
    const view = handoffView({ incoming: [edge({ id: 1 })], outgoing: [] }, sent('run the tests'))
    expect(view.askedBy).toBeUndefined()
    expect(view.rows).toHaveLength(1)
  })

  test('an OUTBOUND edge never becomes "who asked me"', () => {
    // Same prompt string, wrong direction: this bot sent it, so the card must
    // keep saying "You asked" and the row must stay in the list.
    const out = edge({ id: 1, from_session: 'mena', to_session: 'Invulboekjes' })
    const view = handoffView({ incoming: [], outgoing: [out] }, sent(out.prompt))
    expect(view.askedBy).toBeUndefined()
    expect(view.rows).toHaveLength(1)
  })

  test('both directions are merged newest-first and capped at three', () => {
    const view = handoffView(
      {
        incoming: [edge({ id: 1, ts: 40 }), edge({ id: 2, ts: 10 })],
        outgoing: [edge({ id: 3, ts: 30 }), edge({ id: 4, ts: 20 })],
      },
      null,
    )
    expect(view.rows.map((r) => r.edge.id)).toEqual([1, 3, 4])
    expect(view.rows[0].inbound).toBe(true)
    expect(view.rows[1].inbound).toBe(false)
    expect(view.rows[1].partner).toBe('mena')
  })

  test('a send stored at the server cap still matches the whole prompt', () => {
    // `last_send_text` is cut at 8000 chars; the edge keeps the prompt entire.
    const whole = `${'x'.repeat(8_000)} …and the rest of it`
    const view = handoffView(
      { incoming: [edge({ id: 1, prompt: whole })], outgoing: [] },
      sent(whole.slice(0, 8_000)),
    )
    expect(view.askedBy).toBe('Invulboekjes')
    expect(view.rows).toHaveLength(0)
  })

  test('a SHORT send is matched exactly — never as a prefix', () => {
    // Otherwise "ok" would claim every edge whose prompt starts with it.
    const view = handoffView(
      { incoming: [edge({ id: 1, prompt: 'ok, ship it and tell me when it is live' })], outgoing: [] },
      sent('ok'),
    )
    expect(view.askedBy).toBeUndefined()
    expect(view.rows).toHaveLength(1)
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
