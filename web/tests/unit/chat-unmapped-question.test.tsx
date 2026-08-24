/**
 * The UNMAPPED question card — the owner's "garbled overlay" report.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS ON SCREEN. A live AskUserQuestion whose header chip this build could
 * not sight falls through `readDialog`'s fingerprints to `family: 'unknown'`.
 * That path published the FOLDED option rows — label plus the dim description
 * line under it, as one string — so the card drew chips reading
 * `Apple A crisp and refreshing fruit`, `Banana A soft and sweet tropical
 * fruit`, … next to `Type something.` and `Chat about this`.
 *
 * WHY THAT GARBLED. `ChoiceButton` was a FIXED `h-[34px]` pill with
 * `items-center` and no clipping, and the row it sits in is `flex-wrap gap-2`.
 * A two-sentence label wraps to three or four lines — a 56-75px box centred in
 * a 34px one — so 11-20px of it hangs out of each end while the next row sits
 * 42px away. The rows paint through each other and the card is illegible.
 * Measured in a real engine at 390px with a real permission label: option 1's
 * text bottom 117px, option 2's text top 114px.
 *
 * THE FIX IS TWO-PART, and this file pins both halves:
 *   · the lens lifts the descriptions off an `unknown` row exactly as it does
 *     for a sighted `question` (the same `WRAP_COL` discriminator), so the chip
 *     is the label and the meaning is prose under the ask;
 *   · the pill's 34px becomes a FLOOR, so any long label anywhere in the
 *     product (a permission grant names a directory) grows its own pill instead
 *     of spilling onto the row below it.
 *
 * `renderToStaticMarkup` like every other chat unit test — no DOM, no network.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChoiceCard } from '../../src/components/chat/ui'
import { DialogCard } from '../../src/components/chat/live-layer'
import { dialogCardView } from '../../src/components/chat/dialog-answer'
import { readLens } from '../../src/components/chat/peek-lens'

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

/**
 * The live AskUserQuestion screen (CC 2.1.233, `server/tests/fixtures/pty/
 * ask-user-question.txt`) with the ONE line this app fingerprints on removed —
 * the ` ☐ Fruit choice ` header chip — which is what a build that draws it
 * differently looks like to the lens. Everything else is the real capture,
 * footer included.
 */
const UNCHIPPED = [
  '❯ Ask me one multiple-choice question: which fruit do I want.',
  '────────────────────────────────────────────────────────────',
  '',
  'Which fruit do you want?',
  '',
  '❯ 1. Apple',
  '     A crisp and refreshing fruit',
  '  2. Banana',
  '     A soft and sweet tropical fruit',
  '  3. Cherry',
  '     A small and tart stone fruit',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

describe('an unmapped question publishes labels, not label-plus-description', () => {
  test('the lens still refuses to map it — the fingerprint is not relaxed', () => {
    expect(readLens(UNCHIPPED).dialog?.family).toBe('unknown')
  })

  test('every option is its own label, with the description lifted off it', () => {
    const sighting = readLens(UNCHIPPED).dialog!
    expect(sighting.options).toEqual([
      'Apple',
      'Banana',
      'Cherry',
      'Type something.',
      'Chat about this',
    ])
    expect(sighting.descriptions).toEqual([
      'A crisp and refreshing fruit',
      'A soft and sweet tropical fruit',
      'A small and tart stone fruit',
      undefined,
      undefined,
    ])
    // The regression itself: not one chip carries two sentences.
    for (const label of sighting.options) expect(label).not.toContain('A crisp')
  })

  test('a row that reached the wrap column keeps its continuation folded in', () => {
    // `WRAP_COL` is the discriminator, and it is what stops this fix from eating
    // half of a genuinely long label: a label line that ran to CC's wrap column
    // continues on the next line, and dropping that continuation would change
    // what the option says.
    const wrapped = [
      '❯ 1. Yes, and do not ask again for cargo check commands in',
      '     /opt/projects/supermux for the rest of this session',
      '  2. No, not this time',
      '',
      ' Esc to cancel',
    ].join('\n')
    const sighting = readLens(wrapped).dialog!
    expect(sighting.family).toBe('unknown')
    expect(sighting.options[0]).toContain('/opt/projects/supermux')
    expect(sighting.descriptions).toBeUndefined()
  })

  test('an unmapped modal with no descriptions carries none — no empty rows', () => {
    const plain = [
      ' Something this app has never seen',
      '',
      '❯ 1. Carry on',
      '  2. Stop',
      '',
      ' Esc to cancel',
    ].join('\n')
    expect(readLens(plain).dialog?.descriptions).toBeUndefined()
  })
})

describe('the unmapped card reads as a card', () => {
  const view = dialogCardView(readLens(UNCHIPPED), '2.1.233')!

  test('the meanings are prose under the ask, and the chips are the labels', () => {
    const out = html(<DialogCard view={view} />)
    // The meanings block — the same one a sighted question gets.
    expect(out).toContain('chat-dialog-meanings')
    expect(out).toContain('A crisp and refreshing fruit')
    // …and the button itself says `Apple`, not `Apple A crisp and refreshing fruit`.
    expect(out).not.toContain('Apple A crisp')
    // Still refused, and still says so: nothing here presses a key.
    expect(out).toContain('chat won’t press a key it can’t verify')
    expect(out).toContain('data-state="degraded"')
  })

  test('it never renders a verbatim body it has no bounds for', () => {
    // `readBody` is permission/startup/paused only — an unknown screen has no
    // verified shape, so nothing above its rows is known to belong to it.
    expect(view.body).toBeUndefined()
    expect(html(<DialogCard view={view} />)).not.toContain('chat-dialog-body')
  })
})

describe('a long option grows its pill instead of overlapping the next row', () => {
  // The LAYOUT invariant behind the garble, asserted on the class contract
  // because a static render has no layout: a fixed height on a box that wraps
  // and does not clip is what put one option's text on top of another's.
  const LONG =
    'Yes, and do not ask again for cargo check commands in /opt/projects/supermux this session'
  const out = html(
    <ChoiceCard
      question="Run cargo check?"
      options={[{ label: LONG, primary: true, kbd: '1' }, { label: 'Not now', kbd: '2' }]}
    />,
  )

  test('the pill has a minimum height, never a fixed one', () => {
    expect(out).toContain('min-h-[34px]')
    // The exact class that caused it. `min-h-[34px]` contains no `h-[34px]`
    // token boundary, so this cannot pass by accident.
    expect(out).not.toContain(' h-[34px]')
  })

  test('a wrapped label is left-aligned and cannot widen the card', () => {
    expect(out).toContain('text-left')
    expect(out).toContain('max-w-full')
    expect(out).toContain(LONG)
  })
})
