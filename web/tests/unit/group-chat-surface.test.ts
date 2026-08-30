/**
 * WHICH group-chat doorway a viewport gets.
 * ─────────────────────────────────────────────────────────────────────────────
 * The desktop change (the channel as a PINNED ROSTER ROW opening the right pane)
 * had exactly one way to break mobile: the rule that picks the doorway. So the
 * rule is a pure function and this is where it is pinned down — including the
 * clause that keeps the phone dock byte-identical (search-blind, as it always
 * was) while the desktop row is search-aware.
 */
import { describe, expect, test } from 'bun:test'

import {
  CHANNEL_ROW_LABEL,
  channelPreview,
  channelPreviewLine,
  channelRowMatches,
  groupChatSurface,
} from '../../src/components/chat/group-chat/surface'

const ACME = { displayName: 'Acme Robotics', slug: 'acme' }

describe('groupChatSurface — the doorway rule', () => {
  test('no channel ⇒ no doorway, on either viewport', () => {
    expect(groupChatSurface({ enabled: false, isPhone: true, ...ACME })).toBe('none')
    expect(groupChatSurface({ enabled: false, isPhone: false, ...ACME })).toBe('none')
  })

  test('HQ (no company, so no channel) renders nothing', () => {
    expect(groupChatSurface({ enabled: false, isPhone: false })).toBe('none')
  })

  test('phone keeps the compact dock', () => {
    expect(groupChatSurface({ enabled: true, isPhone: true, ...ACME })).toBe('dock')
  })

  test('the phone dock is search-BLIND — exactly as it shipped', () => {
    expect(
      groupChatSurface({ enabled: true, isPhone: true, query: 'zzz-no-match', ...ACME }),
    ).toBe('dock')
  })

  test('desktop pins the roster row', () => {
    expect(groupChatSurface({ enabled: true, isPhone: false, ...ACME })).toBe('row')
  })

  test('a desktop search the row does not answer hides it', () => {
    expect(
      groupChatSurface({ enabled: true, isPhone: false, query: 'quill', ...ACME }),
    ).toBe('none')
  })

  test('a desktop search the row DOES answer keeps it pinned', () => {
    for (const query of ['company', 'chat', 'acme', 'Acme Rob']) {
      expect(groupChatSurface({ enabled: true, isPhone: false, query, ...ACME })).toBe('row')
    }
  })

  test('whitespace-only search is no search', () => {
    expect(groupChatSurface({ enabled: true, isPhone: false, query: '   ', ...ACME })).toBe('row')
  })
})

describe('channelRowMatches', () => {
  test('matches its own label, case-insensitively', () => {
    expect(channelRowMatches('COMPANY CHAT', ACME)).toBe(true)
    expect(channelRowMatches(CHANNEL_ROW_LABEL.toLowerCase(), ACME)).toBe(true)
  })

  test('matches the slug and the display name', () => {
    expect(channelRowMatches('acme', ACME)).toBe(true)
    expect(channelRowMatches('robotics', ACME)).toBe(true)
  })

  test('a company with neither name nor slug still answers its own label', () => {
    expect(channelRowMatches('chat', {})).toBe(true)
    expect(channelRowMatches('acme', {})).toBe(false)
  })
})

describe('channelPreview — one sentence for both doorways', () => {
  test('"we do not know yet" is not "there is nothing"', () => {
    expect(channelPreview(null, true)).toBe('Opening the channel…')
    expect(channelPreview(null, false)).toBe('No messages yet — start the conversation')
  })

  test('the newest row is "author: body", on one line', () => {
    expect(
      channelPreview({ authorName: 'Quill', body: 'shipped   the\n  fix' }, false),
    ).toBe('Quill: shipped the fix')
  })

  test('an author-less row is just its body', () => {
    expect(channelPreviewLine({ body: '  Nudged Patch  ' })).toBe('Nudged Patch')
  })
})
