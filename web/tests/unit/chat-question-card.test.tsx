/**
 * The ANSWERABLE question card (verify matrix finding 4, as it appeared in
 * production).
 * ─────────────────────────────────────────────────────────────────────────────
 * When a bot calls AskUserQuestion, chat used to show a generic tool-permission
 * card — ``Run `AskUserQuestion`?`` with three inert buttons and "chat can't
 * answer this one yet" — because the answerable path depended on a pty SIGHTING
 * (`dialog`, the `question` family) the current Claude Code does not reliably
 * produce. The fix drives the card from the STRUCTURED `session.question_request`
 * the server parses off the tool call, so the real question and its real options
 * are on the card regardless of what the terminal draws, and clicking an option
 * answers it in the pty.
 *
 * Rendered through `renderToStaticMarkup` like every other chat unit test — no
 * DOM, no network. The CLICK is proven at the transport level (`answerQuestion`
 * over a mock `sendKey`), which is the same seam the card's `onAnswer` calls.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ASK_SAY, LiveLayer, QuestionCard, askKind } from '../../src/components/chat/live-layer'
import { answerQuestion, questionAnswerKeys } from '../../src/components/chat/question-answer'
import { askKey, canAnswerQuestion } from '../../src/components/chat/use-question-answer'
import type { KeyName } from '../../src/lib/session-input/types'
import type { QuestionRequestInfo } from '../../src/lib/api/sessions'
import type { TileSession } from '../../src/components/session-tile/types'

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

function session(over: Partial<TileSession> = {}): TileSession {
  return {
    name: 'release-train',
    status: 'active',
    updated_at: '',
    ...over,
  } as TileSession
}

const FRUIT: QuestionRequestInfo = {
  header: 'Fruit choice',
  question: 'Which fruit do you want?',
  options: ['Apple', 'Banana', 'Cherry'],
  multi_select: false,
}

/* ── the card renders the real ask, not the permission dead-end ──────────── */

describe('the AskUserQuestion card is answerable', () => {
  test('it draws the real question and every option — not the generic permission card', () => {
    const out = html(
      <LiveLayer name="release-train" session={session({ question_request: FRUIT })} turnStart={1} />,
    )
    // The model's own words reach the surface: the header chip, the question, and
    // each option as its own control.
    expect(out).toContain('Fruit choice')
    expect(out).toContain('Which fruit do you want?')
    for (const label of FRUIT.options) expect(out).toContain(label)
    expect(out).toContain('chat-question-card')
    // The stable bench marker a 390px rig screenshots.
    expect(out).toContain('data-vr="qq-card"')
    // …and NONE of the old dead-end: no permission card, no ``Run `AskUserQuestion`?``,
    // no "chat can't answer this one yet".
    expect(out).not.toContain('chat-permission-card')
    expect(out).not.toContain('can’t answer this one yet')
    expect(out).not.toContain('AskUserQuestion')
  })

  test('the structured question outranks a generic permission card if both are set', () => {
    // Belt-and-suspenders: the server suppresses `permission_request` for
    // AskUserQuestion, but the chain must draw the question even if one slips
    // through — the two must never fight over the card slot.
    const out = html(
      <LiveLayer
        name="release-train"
        session={session({
          question_request: FRUIT,
          permission_request: { tool: 'AskUserQuestion', summary: 'AskUserQuestion', kind: 'tool' },
        })}
        turnStart={1}
      />,
    )
    expect(out).toContain('chat-question-card')
    expect(out).not.toContain('chat-permission-card')
  })

  test('askKind ranks a structured question above permission — and never says "permission"', () => {
    const K = { form: false, permission: false, signIn: false }
    expect(askKind({ ...K, question: true })).toBe('question')
    // A question and a permission at once is still a question (the ranking that
    // keeps the wrong word off a screen reader).
    expect(askKind({ ...K, question: true, permission: true })).toBe('question')
    expect(ASK_SAY.question).not.toContain('permission')
  })

  test('a multiSelect question is drawn but points at the terminal — no single answer sent', () => {
    let chosen: number | null = null
    const out = html(
      <QuestionCard
        ask={{ ...FRUIT, multi_select: true }}
        onAnswer={(i) => {
          chosen = i
        }}
      />,
    )
    // The options are all there…
    for (const label of FRUIT.options) expect(out).toContain(label)
    // …but drawn inert (a wrong single answer is worse than the old dead-end),
    // with the terminal hint.
    expect(out).toContain('disabled')
    expect(out).toContain('answers a single choice for now')
    // A static render fires no click; the guarantee that matters is that the card
    // wired NO live `onChoose` for multi-select, so `onAnswer` can never run.
    expect(chosen).toBeNull()
  })
})

/* ── clicking option N sends the right keys ──────────────────────────────── */

describe('answering a question maps the option index to keys', () => {
  test('the caret starts on option 0, so option i is Down × i then Enter', () => {
    expect(questionAnswerKeys(0)).toEqual(['Enter'])
    expect(questionAnswerKeys(1)).toEqual(['Down', 'Enter'])
    expect(questionAnswerKeys(2)).toEqual(['Down', 'Down', 'Enter'])
  })

  test('a nonsense index refuses rather than throwing — nothing goes on the wire', () => {
    expect(questionAnswerKeys(-1)).toEqual([])
    expect(questionAnswerKeys(1.5)).toEqual([])
  })

  test('answerQuestion sends exactly those keys, in order, over the transport', async () => {
    const sent: KeyName[] = []
    const sendKey = async (k: KeyName) => {
      sent.push(k)
    }
    const returned = await answerQuestion(sendKey, 2)
    expect(sent).toEqual(['Down', 'Down', 'Enter'])
    expect(returned).toEqual(['Down', 'Down', 'Enter'])
  })

  test('answerQuestion sends NOTHING for a nonsense index', async () => {
    const sent: KeyName[] = []
    await answerQuestion(async (k) => {
      sent.push(k)
    }, -1)
    expect(sent).toEqual([])
  })
})

/* ── the safety gate: when a click may press keys, and when it may NOT ─────── */

describe('canAnswerQuestion — the whole gate, pure', () => {
  test('a real row on a fresh single-select ask, nothing in flight → yes', () => {
    expect(canAnswerQuestion(FRUIT, null, false, 0)).toBe(true)
    expect(canAnswerQuestion(FRUIT, null, false, 2)).toBe(true)
  })

  test('a sequence already in flight → no (two taps must not both answer)', () => {
    expect(canAnswerQuestion(FRUIT, null, true, 1)).toBe(false)
  })

  test('a choice already made on this ask → no (a late click must not answer the NEXT question)', () => {
    expect(canAnswerQuestion(FRUIT, 0, false, 1)).toBe(false)
  })

  test('nothing is asking → no', () => {
    expect(canAnswerQuestion(null, null, false, 0)).toBe(false)
    expect(canAnswerQuestion(undefined, null, false, 0)).toBe(false)
  })

  test('a multi-select ask → no (it is toggled-and-confirmed in the terminal for now)', () => {
    expect(canAnswerQuestion({ ...FRUIT, multi_select: true }, null, false, 0)).toBe(false)
  })

  test('an index outside the option list → no', () => {
    expect(canAnswerQuestion(FRUIT, null, false, -1)).toBe(false)
    expect(canAnswerQuestion(FRUIT, null, false, 3)).toBe(false) // == options.length
    expect(canAnswerQuestion(FRUIT, null, false, 1.5)).toBe(false)
  })
})

describe('askKey — a fresh ask is a fresh chance, the same ask is not', () => {
  test('nothing asking → null', () => {
    expect(askKey(null)).toBeNull()
    expect(askKey(undefined)).toBeNull()
  })

  test('the same ask yields the same key; a changed question/options/header yields a new one', () => {
    expect(askKey(FRUIT)).toBe(askKey({ ...FRUIT }))
    expect(askKey(FRUIT)).not.toBe(askKey({ ...FRUIT, question: 'Which vegetable?' }))
    expect(askKey(FRUIT)).not.toBe(askKey({ ...FRUIT, options: ['Apple', 'Banana'] }))
    expect(askKey(FRUIT)).not.toBe(askKey({ ...FRUIT, header: 'Snack choice' }))
  })
})

/* ── once answered, the card shows WHICH and goes inert ───────────────────── */

describe('the answered question card', () => {
  test('the chosen option is lit and the rest recede — none pressable again', () => {
    // Banana (index 1) picked.
    const out = html(<QuestionCard ask={FRUIT} onAnswer={() => {}} chosen={1} />)
    // Every label is still on screen (the question stays readable).
    for (const label of FRUIT.options) expect(out).toContain(label)
    // The picked pill carries the selection cursor (accent), and it is NOT one of
    // the disabled ones.
    expect(out).toContain('data-selected="true"')
    // Exactly the two NON-chosen options are inert (`disabled=""`), so a click
    // landing after the answer cannot press a second selection.
    expect((out.match(/disabled=""/g) ?? []).length).toBe(2)
  })

  test('an unanswered single-select card disables nothing — every option is live', () => {
    const out = html(<QuestionCard ask={FRUIT} onAnswer={() => {}} />)
    expect(out).not.toContain('disabled=""')
    expect(out).not.toContain('data-selected="true"')
  })
})
