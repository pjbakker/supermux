// `configDirTag` - the tile's account marker.
//
// The server sends the full config dir; the tile shows only the last path
// segment (`/home/agent/.claude-second` -> `.claude-second`) because that is
// the part that names the account. An unset value renders nothing at all.

import { describe, expect, test } from 'bun:test'

import { configDirTag } from '../../src/lib/api/sessions'

describe('configDirTag', () => {
  test('keeps the last path segment', () => {
    expect(configDirTag('/home/agent/.claude-second')).toBe('.claude-second')
    expect(configDirTag('/home/agent/.claude')).toBe('.claude')
  })

  test('ignores a trailing slash', () => {
    expect(configDirTag('/home/agent/.claude-second/')).toBe('.claude-second')
  })

  test('renders nothing when there is no config dir', () => {
    expect(configDirTag(undefined)).toBeNull()
    expect(configDirTag('')).toBeNull()
    expect(configDirTag('   ')).toBeNull()
  })

  test('degrades to the whole value when there is no segment to take', () => {
    expect(configDirTag('/')).toBe('/')
  })
})
