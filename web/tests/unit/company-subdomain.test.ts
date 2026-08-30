/**
 * The invite wizard's editable subdomain — the pure half.
 * ─────────────────────────────────────────────────────────────────────────────
 * The bug this pins: "Choose your domain" SUGGESTED `<company-slug>.<zone>` and
 * then hard-coded it (`${company.slug}.${chosen}`), so an owner could pick the
 * zone but never the name in front of it. The suggestion was right; being unable
 * to change it was not.
 *
 * Three things are pinned here, none of which a type could catch:
 *
 *  1. The validation rule, which must mirror the server's `is_dns_label`
 *     (`server/src/config.rs`) EXACTLY — a client that accepts what the API
 *     refuses turns a typo into a failed POST instead of an inline hint. One
 *     label, `a-z0-9-`, no leading/trailing hyphen, ≤63 chars. No dots: every
 *     company address rides one wildcard `*.<base>` CNAME, which covers exactly
 *     one level.
 *
 *  2. The POST body. `subdomain` must be OMITTED when the caller has no opinion,
 *     because the server reads an absent field as "keep the label this company
 *     already publishes". Sending an empty string (or the slug) from the Google
 *     mini-step would silently rename an owner-chosen address back.
 *
 *  3. The suggestion. It is derived from the slug but must always be a label the
 *     server will accept, so a company whose slug carries a dot or an underscore
 *     does not open the step already in an error state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { externalAccessApi } from '@/lib/api'
import {
  hostPayload,
  labelOf,
  previewHost,
  subdomainError,
  suggestLabel,
} from '../../src/lib/company-subdomain'

describe('subdomainError', () => {
  test('accepts a single DNS label', () => {
    for (const good of ['a', 'acme', 'team', 'team-2', 'x1', 'a'.repeat(63)]) {
      expect(subdomainError(good)).toBeNull()
    }
  })

  test('accepts what the server accepts after trimming + lower-casing', () => {
    // The server trims + lower-cases before validating, so the field must not
    // scold someone for typing a capital or leaving a trailing space.
    expect(subdomainError('  Team  ')).toBeNull()
    expect(subdomainError('ACME')).toBeNull()
  })

  test('refuses everything the server refuses, and says why', () => {
    expect(subdomainError('')).toBe('Pick a name for the address')
    expect(subdomainError('   ')).toBe('Pick a name for the address')
    expect(subdomainError('-team')).toBe('Cannot start or end with a hyphen')
    expect(subdomainError('team-')).toBe('Cannot start or end with a hyphen')
    // A dot is a SECOND level — the one wildcard CNAME would never serve it.
    expect(subdomainError('eu.team')).toBe('Use only letters, numbers and hyphens')
    expect(subdomainError('team_eu')).toBe('Use only letters, numbers and hyphens')
    expect(subdomainError('team eu')).toBe('Use only letters, numbers and hyphens')
    expect(subdomainError('a'.repeat(64))).toBe('Keep it to 63 characters or fewer')
  })
})

describe('previewHost', () => {
  test('is the address as it will be typed into a browser', () => {
    expect(previewHost('team', 'example.com')).toBe('team.example.com')
    expect(previewHost('  Team ', 'example.com')).toBe('team.example.com')
  })

  test('never renders a half-built host as if it were real', () => {
    expect(previewHost('', 'example.com')).toBe('<name>.example.com')
    expect(previewHost('team', null)).toBe('team.<your-domain>')
  })
})

describe('hostPayload', () => {
  test('omits subdomain when the caller has no opinion', () => {
    // An ABSENT field is what tells the server "keep the current label".
    expect(hostPayload()).toEqual({})
    expect(hostPayload('')).toEqual({})
    expect(hostPayload('   ')).toEqual({})
    expect('subdomain' in hostPayload()).toBe(false)
  })

  test('normalises the label it does send', () => {
    expect(hostPayload('Team')).toEqual({ subdomain: 'team' })
    expect(hostPayload('  hq  ')).toEqual({ subdomain: 'hq' })
  })
})

describe('suggestLabel', () => {
  test('suggests the slug when the slug is already a legal label', () => {
    expect(suggestLabel('enverder')).toBe('enverder')
    expect(suggestLabel('Acme')).toBe('acme')
  })

  test('always suggests something the server would accept', () => {
    for (const slug of ['acme_eu', 'acme.eu', '  Acme  EU ', '--acme--', 'a'.repeat(80), '____']) {
      expect(subdomainError(suggestLabel(slug))).toBeNull()
    }
    expect(suggestLabel('acme_eu')).toBe('acme-eu')
    expect(suggestLabel('acme.eu')).toBe('acme-eu')
    expect(suggestLabel('____')).toBe('team')
  })
})

describe('labelOf', () => {
  test('recovers the editable part of the address already published', () => {
    expect(labelOf('team.example.com', 'example.com')).toBe('team')
    expect(labelOf('TEAM.Example.com', 'example.com')).toBe('team')
  })

  test('is empty when the host does not sit directly under the zone', () => {
    // A stale base domain, a quick-tunnel host, or a deeper name — nothing to
    // pre-fill, so the field falls back to the suggestion instead of lying.
    expect(labelOf('team.other.test', 'example.com')).toBe('')
    expect(labelOf('eu.team.example.com', 'example.com')).toBe('')
    expect(labelOf('', 'example.com')).toBe('')
  })
})

/**
 * …and the same decisions ON THE WIRE. `externalAccessApi.host` used to POST with
 * NO body at all, which is why the label had nowhere to ride. The endpoint still
 * has to tolerate a bodyless-in-spirit call (an empty object), so both shapes are
 * pinned here rather than left to the call site.
 */
describe('externalAccessApi.host on the wire', () => {
  const captured: { url: string; method: string; body: unknown }[] = []
  const realFetch = globalThis.fetch
  const hadWindow = 'window' in globalThis

  beforeEach(() => {
    captured.length = 0
    // `apiUrl`/`apiToken` read `window` at CALL time by design.
    ;(globalThis as { window?: unknown }).window = {
      _SUPERMUX_BASE_URL: '',
      _SUPERMUX_AUTH_TOKEN: 'tok',
    }
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response(
        JSON.stringify({ ok: true, data: { host: 'team.example.com', redirect_uri: 'x' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (!hadWindow) delete (globalThis as { window?: unknown }).window
  })

  test('carries the owner-chosen label', async () => {
    await externalAccessApi.host(7, 'Team')
    expect(captured[0].method).toBe('POST')
    expect(captured[0].url).toContain('/api/companies/7/host')
    expect(captured[0].body).toEqual({ subdomain: 'team' })
  })

  test('sends no label when there is none to send', async () => {
    await externalAccessApi.host(7)
    expect(captured[0].body).toEqual({})
  })
})
