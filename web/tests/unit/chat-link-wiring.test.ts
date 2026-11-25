/**
 * The real wiring between the chat socket and the app-wide link aggregate
 * (`use-chat-ws.ts::chatStore` -> `connection-store.ts`).
 *
 * The global `<ReconnectBanner>` is about the network. A transcript tail that
 * says `reconnecting` (a newer sibling transcript, a pointer re-resolving)
 * over a perfectly healthy socket used to reach it and made the banner flicker
 * every ~10 s. These tests drive a real `ChatSocket` through `chatStore` with a
 * fake WebSocket and read the aggregate, so they fail on the old wiring.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import type { SocketLike } from '../../src/components/chat/chat-socket'
import { chatStore } from '../../src/components/chat/use-chat-ws'
import { useConnection } from '../../src/stores/connection-store'

class FakeSocket implements SocketLike {
  static open: FakeSocket[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.open.push(this)
  }
  send(): void {}
  close(): void {}
  deliver(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  seed(state = 'live', reason?: string): void {
    this.onopen?.(null)
    this.deliver({ type: 'auth_ok' })
    this.deliver({ type: 'seed', entries: [], has_more: false, next_before: null })
    this.deliver({ type: 'seed_done', state, reason, resync_epoch: 0, high_water: 1 })
  }
}

function mount(name: string, path?: string) {
  FakeSocket.open = []
  useConnection.setState({ links: {}, state: 'idle', justRecovered: false })
  const timers = new Map<number, () => void>()
  let seq = 1
  const store = chatStore(name, true, path, {
    connect: (url) => new FakeSocket(url),
    token: () => 't',
    baseUrl: () => 'ws://h',
    fetchFull: () => Promise.reject(new Error('no fetch expected')),
    schedule: (fn) => {
      const id = seq++
      timers.set(id, fn)
      return id
    },
    cancel: (id) => {
      timers.delete(id)
    },
    rand: () => 0.5,
  })
  const unsubscribe = store.subscribe(() => {})
  const ws = () => FakeSocket.open[FakeSocket.open.length - 1]
  const runTimers = () => {
    const due = [...timers.values()]
    timers.clear()
    for (const fn of due) fn()
  }
  const link = () => useConnection.getState().links[`chat:${path ?? name}`]?.state
  const banner = () => useConnection.getState().state
  return { store, unsubscribe, ws, runTimers, link, banner }
}

afterEach(() => {
  useConnection.setState({ links: {}, state: 'idle', justRecovered: false })
})

describe('the chat socket in the global link aggregate', () => {
  test('a tail that says reconnecting over an open socket keeps the banner connected', () => {
    const m = mount('flicker')
    m.ws().onopen?.(null)
    m.ws().deliver({ type: 'auth_ok' })
    m.ws().deliver({ type: 'seed', entries: [], has_more: false, next_before: null })
    expect(m.link()).toBe('connecting')
    m.ws().seed()
    expect(m.link()).toBe('connected')
    m.ws().deliver({ type: 'state', state: 'reconnecting', reason: 'newer conversation in this project' })
    expect(m.store.get().state).toBe('reconnecting')
    expect(m.link()).toBe('connected')
    expect(m.banner()).toBe('connected')
    m.ws().deliver({ type: 'state', state: 'no_hooks' })
    expect(m.banner()).toBe('connected')
    m.ws().deliver({ type: 'state', state: 'live' })
    expect(m.banner()).toBe('connected')
    m.unsubscribe()
    expect(m.link()).toBeUndefined()
  })

  test('a session with no transcript yet is a connected link', () => {
    const m = mount('fresh')
    m.ws().seed('reconnecting', 'no transcript for the tracked conversation')
    expect(m.link()).toBe('connected')
    m.unsubscribe()
  })

  test('a real drop still reaches the banner, and the recovery clears it', () => {
    const m = mount('drop')
    m.ws().seed()
    m.ws().onclose?.({ code: 1006 })
    expect(m.link()).toBe('reconnecting')
    expect(m.banner()).toBe('reconnecting')
    m.runTimers()
    m.ws().seed()
    expect(m.link()).toBe('connected')
    m.unsubscribe()
  })

  test('a foreground redial keeps a healthy link connected until the new socket answers', () => {
    const m = mount('redial')
    m.ws().seed()
    m.store.redial()
    expect(m.link()).toBe('connected')
    m.ws().seed()
    expect(m.link()).toBe('connected')
    // A redial whose new socket drops is a real outage.
    m.store.redial()
    m.ws().onclose?.({ code: 1006 })
    expect(m.link()).toBe('reconnecting')
    m.unsubscribe()
  })

  test('the company group chat socket reports under its path, by the same rule', () => {
    const path = '/ws/companies/c1/groupchat'
    const m = mount('ops', path)
    expect(m.ws().url).toBe(`ws://h${path}`)
    m.ws().seed()
    m.ws().deliver({ type: 'state', state: 'reconnecting', reason: 'x' })
    expect(m.link()).toBe('connected')
    expect(useConnection.getState().links['chat:ops']).toBeUndefined()
    m.ws().onclose?.({ code: 4404, reason: 'no such session' })
    expect(m.link()).toBe('gone')
    m.unsubscribe()
  })
})
