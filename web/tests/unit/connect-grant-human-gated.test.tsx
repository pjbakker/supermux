/**
 * The grant is a HUMAN action — a bot may never grant itself a connector.
 * ─────────────────────────────────────────────────────────────────────────────
 * A bot's `mcp__connect__connect` call raises the in-chat ConnectCard. That call
 * is the bot ASKING; the card is the human ANSWERING. The dangerous shortcut is
 * the auth-`none` lane: there is no credential to collect, so "just land the
 * grant when the card mounts" looks harmless — and it would hand a bot the power
 * to grant itself the shared browser (or any other no-auth connector) with a
 * single tool call and no human in the loop at all.
 *
 * These tests pin the gate from both ends:
 *   · BEHAVIOUR — rendering the flow for an auth-`none` connector calls `onSubmit`
 *     ZERO times and puts a real "Add" button on screen. (`onSubmit` is exactly
 *     what the ConnectCard wires to its `seal`, the only caller of `grant`.)
 *   · STRUCTURE — the sources contain no auto-submit: `submit` is reached only
 *     from the button's `onClick`, and `apiGrant`/`putCredential` live only inside
 *     `seal`, never in an effect.
 *
 * Structure is asserted against the source text because this suite has no DOM (no
 * happy-dom, no testing-library) — the same posture as `chat-renderer-shell`. SSR
 * cannot fire a click, so a behavioural "the tap works" test belongs to e2e; what
 * matters here is that NOTHING fires without one.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConnectFlow } from '../../src/components/store/connect-flow'
import type { ConnectorCard } from '../../src/lib/api/connectors'

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** Comments explain the rule; only CODE can break it, so strip them first. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const FLOW_SRC = code(src('../../src/components/store/connect-flow.tsx'))
const CARD_SRC = code(src('../../src/components/chat/ui/connect-card.tsx'))

/** A no-sign-in connector — the shared browser is the real one. */
const noneCard = (over: Partial<ConnectorCard> = {}): ConnectorCard => ({
  id: 'shared-browser',
  kind: 'builtin_browser',
  display_name: 'Shared Browser',
  icon: '',
  description: 'A browser the bot can drive.',
  tools: [],
  credentials: [],
  auth: { kind: 'none' },
  source: 'local',
  ...over,
})

describe('an auth-none connector still needs a tap', () => {
  test('rendering the flow never calls onSubmit', () => {
    let calls = 0
    renderToStaticMarkup(
      <ConnectFlow
        card={noneCard()}
        variant="chat"
        onSubmit={async () => {
          calls += 1
          return { restartHint: false, accountRef: null, accountLabel: null }
        }}
      />,
    )
    expect(calls).toBe(0)
  })

  test('it offers an Add button instead — the human is the one who acts', () => {
    const out = renderToStaticMarkup(
      <ConnectFlow
        card={noneCard()}
        variant="chat"
        onSubmit={async () => ({ restartHint: false, accountRef: null, accountLabel: null })}
      />,
    )
    expect(out).toContain('data-vr="connect-submit"')
    expect(out).toContain('Add')
    // Not already sealed: no "added" confirmation was rendered on mount.
    expect(out).toContain('No sign-in needed')
  })

  test('the same holds for the builtin browser copy the chat card shows', () => {
    let calls = 0
    const out = renderToStaticMarkup(
      <ConnectFlow
        card={noneCard({ id: 'shared-browser', kind: 'builtin_browser' })}
        variant="chat"
        onSubmit={async () => {
          calls += 1
          return { restartHint: false, accountRef: null, accountLabel: null }
        }}
        onDismiss={() => {}}
      />,
    )
    expect(calls).toBe(0)
    // "Not now" is offered too — declining is a first-class outcome.
    expect(out).toContain('Not now')
  })
})

describe('no code path submits on its own', () => {
  test('<ConnectFlow> reaches submit only from the button', () => {
    // Every mention of the bare identifier: its declaration and the onClick.
    const mentions = FLOW_SRC.match(/\bsubmit\b/g) ?? []
    expect(FLOW_SRC).toContain('onClick={submit}')
    expect(FLOW_SRC).not.toContain('submit()')
    // `onSubmit` is only ever called from inside `submit` itself.
    expect(FLOW_SRC.match(/onSubmit\(/g)?.length ?? 0).toBe(1)
    expect(mentions.length).toBeGreaterThan(0)
  })

  test('<ConnectCard> grants only from seal, never from an effect', () => {
    // The two write calls exist exactly where `seal` is, and `seal` is handed to
    // <ConnectFlow> as onSubmit rather than invoked.
    expect(CARD_SRC).toContain('onSubmit={seal}')
    expect(CARD_SRC).not.toContain('seal(')
    const sealStart = CARD_SRC.indexOf('const seal = async')
    const sealEnd = CARD_SRC.indexOf('\n  }\n', sealStart)
    expect(sealStart).toBeGreaterThan(-1)
    expect(sealEnd).toBeGreaterThan(sealStart)
    const sealBody = CARD_SRC.slice(sealStart, sealEnd)
    for (const write of ['apiGrant(', 'putCredential(']) {
      const total = CARD_SRC.split(write).length - 1
      const inSeal = sealBody.split(write).length - 1
      expect(total).toBeGreaterThan(0)
      expect(inSeal).toBe(total)
    }
    // No effect in this file may touch the grant API at all.
    const effects = CARD_SRC.split('useEffect(').slice(1)
    for (const e of effects) {
      expect(e.slice(0, 800)).not.toContain('apiGrant')
      expect(e.slice(0, 800)).not.toContain('putCredential')
    }
  })
})
