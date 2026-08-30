/**
 * The invite wizard's temporary-link decisions — the pure half of the
 * "Create a temporary link does nothing" bug.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two things are pinned here, both of which the sheet got wrong in a way no
 * type could catch:
 *
 *  1. The POST body. `POST /api/external-access/quick-tunnel` REQUIRES
 *     `company_id` — the server answers a bare body with 422
 *     "missing field `company_id`". The shape now lives in one named function
 *     instead of an inline `JSON.stringify`, so it is assertable.
 *
 *  2. The three-state view. `box_status.quick_tunnel` can be absent (no tunnel),
 *     present+active (a live link), or present+INACTIVE — the box started a
 *     tunnel and the tunnel is gone. The wizard used to test `qt?.active` and
 *     treat the third case as the first, which is what made the button look
 *     inert: it silently re-rendered the very chooser the operator had just
 *     tapped. `stopped` must stay its own answer.
 */
import { describe, expect, test } from 'bun:test'

import { quickTunnelPayload, quickTunnelView } from '../../src/lib/quick-tunnel'

const QT = (over: Record<string, unknown> = {}) =>
  ({
    active: true,
    url: 'https://calm-frog-1234.trycloudflare.com',
    host: 'calm-frog-1234.trycloudflare.com',
    company_id: 1,
    ephemeral: true,
    ...over,
  }) as Parameters<typeof quickTunnelView>[0]

describe('quickTunnelPayload', () => {
  test('always carries company_id — the server 422s without it', () => {
    expect(quickTunnelPayload(1)).toEqual({ company_id: 1 })
    expect(JSON.parse(JSON.stringify(quickTunnelPayload(7)))).toEqual({ company_id: 7 })
  })

  test('keeps the id even when it is falsy-looking (id 0 is still an id)', () => {
    expect('company_id' in quickTunnelPayload(0)).toBe(true)
    expect(JSON.stringify(quickTunnelPayload(0))).toBe('{"company_id":0}')
  })
})

describe('quickTunnelView', () => {
  test('no tunnel on the box → none', () => {
    expect(quickTunnelView(undefined)).toBe('none')
    expect(quickTunnelView(null)).toBe('none')
  })

  test('a running tunnel → live', () => {
    expect(quickTunnelView(QT())).toBe('live')
  })

  test('a tunnel the box knows about but is NOT running → stopped, never none', () => {
    const view = quickTunnelView(QT({ active: false }))
    expect(view).toBe('stopped')
    expect(view).not.toBe('none')
  })

  test('a record with no host is not a link to show', () => {
    expect(quickTunnelView(QT({ host: '', active: false }))).toBe('none')
  })
})
