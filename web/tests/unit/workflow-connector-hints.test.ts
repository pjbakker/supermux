/**
 * T5.7 — never offer a connector the bot cannot use.
 *
 * The split is a pure function (`hintRows`) precisely so this can be asserted
 * without a sheet: what the picker renders is a rendering decision, but WHICH
 * group a connector lands in — and whether a dead account is offered at all —
 * is a correctness decision, and it is the one the connector store already
 * learned the hard way.
 */
import { describe, expect, test } from 'bun:test'

import { hintRows } from '../../src/components/workflows/connector-hint-picker'
import type { ConnectorCard, SessionConnector } from '../../src/lib/api/connectors'

const acct = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  account_label: 'sander@acme.com',
  status: 'active',
  has_secret: true,
  last_used_at: 0,
  health: 'ok',
  grant_level: 'bot',
  ...over,
})

const grant = (id: string, accounts: unknown[], enabled = true) =>
  ({
    connector_id: id,
    has_secret: true,
    enabled,
    card: { id, display_name: id === 'gmail' ? 'Gmail' : id, accounts },
  }) as unknown as SessionConnector

const card = (id: string, name: string) => ({ id, display_name: name }) as unknown as ConnectorCard

describe('granted first, each with the account it would actually use', () => {
  const { granted } = hintRows([grant('gmail', [acct()])], [])

  test('the account label rides along, so "Gmail" is never ambiguous', () => {
    expect(granted).toHaveLength(1)
    expect(granted[0].name).toBe('Gmail')
    expect(granted[0].account).toBe('sander@acme.com')
    expect(granted[0].dead).toBeNull()
  })
})

describe('ungranted connectors are their own group, never mixed in', () => {
  test('a catalog card the bot has no grant for lands in the second group', () => {
    const { granted, ungranted } = hintRows(
      [grant('gmail', [acct()])],
      [card('gmail', 'Gmail'), card('github', 'GitHub')],
    )
    expect(granted.map((r) => r.id)).toEqual(['gmail'])
    expect(ungranted.map((r) => r.id)).toEqual(['github'])
    expect(ungranted[0].granted).toBe(false)
  })
})

describe('dead connections look dead', () => {
  test('a disconnected account is surfaced as disconnected, not as available', () => {
    const { granted } = hintRows([grant('gmail', [acct({ status: 'disconnected' })])], [])
    expect(granted[0].dead).toBe('Disconnected')
  })

  test('an expired account is not treated as live either', () => {
    const { granted } = hintRows([grant('gmail', [acct({ health: 'expired' })])], [])
    expect(granted[0].dead).toBe('Needs sign-in')
  })

  test('a live account beside a dead one wins — the connector IS usable', () => {
    const { granted } = hintRows(
      [grant('gmail', [acct({ id: 'dead', status: 'disconnected' }), acct({ id: 'live' })])],
      [],
    )
    expect(granted[0].dead).toBeNull()
    expect(granted[0].account).toBe('sander@acme.com')
  })

  test('a revoked grant is not offered at all', () => {
    const { granted } = hintRows([grant('gmail', [acct()], false)], [])
    expect(granted).toHaveLength(0)
  })
})
