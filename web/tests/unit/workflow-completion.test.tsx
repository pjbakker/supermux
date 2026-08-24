/**
 * T5.8 — the `command:` regression guard, on the client.
 *
 * The old scheduler had `done_action: command:<text>`: a string the operator
 * typed and the server executed. It is gone from the server (`complete.rs` is a
 * typed enum with no free-text arm), and this suite is the other half — the
 * property that no UI field can grow back into it.
 *
 * The strong assertion is the third one: every expanded state is rendered and
 * the markup is searched for text inputs. The only ones allowed are the typed
 * fields, each marked `data-typed-field`. A textarea, a contenteditable, or an
 * unmarked text input anywhere in this subtree fails here — which is what makes
 * "there is no free-text box" a fact rather than a promise.
 *
 * The fourth is the honesty rule. supermux has no MCP client; a connector
 * completion is an instruction delivered to a pane. Every string says "will be
 * asked to send". The word "send" never takes supermux as its subject, and no
 * string in the file claims anything in the past tense.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  COMPLETION_OPTIONS,
  CompletionActionRow,
  completionProblem,
  completionSentence,
} from '../../src/components/workflows/completion-action-row'
import type { SessionConnector } from '../../src/lib/api/connectors'
import type { CompletionAction } from '../../src/lib/api/workflows'

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acct-1',
  account_label: 'sander@acme.com',
  status: 'active',
  has_secret: true,
  last_used_at: 0,
  health: 'ok',
  grant_level: 'bot',
  ...over,
})

const GRANTS = [
  {
    connector_id: 'gmail',
    has_secret: true,
    enabled: true,
    card: { id: 'gmail', display_name: 'Gmail', accounts: [account()] },
  },
] as unknown as SessionConnector[]

const render = (value: CompletionAction, grants: SessionConnector[] = GRANTS): string => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <CompletionActionRow
        value={value}
        onChange={() => {}}
        session="scout"
        bots={[{ name: 'scout' }, { name: 'inbox', display_name: 'Inbox' }]}
        connectorsOverride={grants}
      />
    </QueryClientProvider>,
  )
}

const EVERY_STATE: CompletionAction[] = [
  { kind: 'none' },
  { kind: 'notify' },
  { kind: 'disable' },
  { kind: 'connector_send', connector_id: 'gmail', account_ref: 'acct-1', to: 'client@example.com', subject: 'Weekly report' },
  { kind: 'message_bot', session: 'inbox' },
]

describe('exactly five options, and no more', () => {
  test('the labels are the five, in order', () => {
    expect(COMPLETION_OPTIONS.map((o) => o.label)).toEqual([
      'Do nothing',
      'Notify me',
      'Send with a connector…',
      'Message another bot…',
      'Pause this workflow',
    ])
  })

  test('the kinds are exactly the server enum’s arms', () => {
    expect(COMPLETION_OPTIONS.map((o) => o.kind).sort()).toEqual(
      ['connector_send', 'disable', 'message_bot', 'none', 'notify'].sort() as never,
    )
  })
})

describe('there is no free-text input anywhere in the completion subtree', () => {
  test.each(EVERY_STATE.map((v) => [v.kind, v] as const))('%s', (_kind, value) => {
    const html = render(value)
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('contenteditable')
    // Every text input must be one of the TYPED fields.
    const inputs = Array.from(html.matchAll(/<input[^>]*>/g)).map((m) => m[0])
    for (const tag of inputs) {
      if (!tag.includes('type="text"')) continue
      expect(tag).toContain('data-typed-field=')
    }
  })

  test('the typed fields are exactly `to` and `subject`', () => {
    const html = render(EVERY_STATE[3])
    const marked = Array.from(html.matchAll(/data-typed-field="([^"]+)"/g)).map((m) => m[1])
    expect(marked.sort()).toEqual(['subject', 'to'])
  })

  test('"message another bot" has no message box — the body is the run summary', () => {
    const html = render({ kind: 'message_bot', session: 'inbox' })
    expect(html).not.toContain('data-typed-field=')
    expect(html).toContain('There is no message to write')
  })
})

describe('the honesty rule', () => {
  test('a connector send is "will be asked to send", never "will send"', () => {
    const s = completionSentence(EVERY_STATE[3], 'scout', [
      { connector_id: 'gmail', connector_name: 'Gmail', account_ref: 'acct-1', account_label: 'sander@acme.com' },
    ])
    expect(s).toContain('scout will be asked to send')
    expect(s).toContain('client@example.com')
    expect(s).toContain('Gmail')
    expect(s).not.toContain('supermux will send')
  })

  test('nothing in the rendered subtree claims anything was sent', () => {
    for (const v of EVERY_STATE) {
      const html = render(v)
      expect(html).not.toContain('was sent')
      expect(html).not.toContain('has been sent')
      expect(html.toLowerCase()).not.toContain('we sent')
    }
  })

  test('a dead account is never offered as available', () => {
    const dead = [
      {
        connector_id: 'gmail',
        has_secret: true,
        enabled: true,
        card: {
          id: 'gmail',
          display_name: 'Gmail',
          accounts: [account({ status: 'disconnected' }), account({ id: 'a2', health: 'expired' })],
        },
      },
    ] as unknown as SessionConnector[]
    const html = render(EVERY_STATE[3], dead)
    expect(html).not.toContain('sander@acme.com')
    expect(html).toContain('has no connected account yet')
    // …and it says so instead of pretending, which is the whole point.
    expect(html).toContain('we will not pretend it can send without it')
  })
})

describe('an incomplete action is refused with a reason, not a disabled button', () => {
  test('the reasons are sentences a person can act on', () => {
    expect(completionProblem({ kind: 'none' })).toBeNull()
    expect(completionProblem({ kind: 'connector_send', connector_id: '', account_ref: '', to: '' })).toBe(
      'Pick the account to send from',
    )
    expect(
      completionProblem({ kind: 'connector_send', connector_id: 'gmail', account_ref: 'a1', to: '  ' }),
    ).toBe('Say who the summary goes to')
    expect(completionProblem({ kind: 'message_bot', session: '' })).toBe(
      'Pick which bot gets the summary',
    )
  })
})
