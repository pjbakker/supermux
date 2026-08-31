/**
 * The viewer STORE's resolution — the boot-time `/auth/me` round-trip, the owner
 * short-circuit that keeps the owner path free, and the member lock it raises.
 *
 * Split from `viewer-identity.test.ts` because the store is a module singleton
 * whose initial state is computed at import: a separate file gets a fresh module
 * registry, so the "owner shells never fetch" claim can be made against a real
 * import rather than a hand-set state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

type Store = Record<string, string>

const storageMap: Store = {}
const storageDouble = {
  getItem: (k: string) => (k in storageMap ? storageMap[k] : null),
  setItem: (k: string, v: string) => {
    storageMap[k] = v
  },
  removeItem: (k: string) => {
    delete storageMap[k]
  },
}
function installStorage(seed: Store = {}) {
  for (const k of Object.keys(storageMap)) delete storageMap[k]
  Object.assign(storageMap, seed)
  ;(globalThis as { localStorage?: unknown }).localStorage = storageDouble
}

function installWindow(token?: string) {
  ;(globalThis as { window?: unknown }).window = {
    _SUPERMUX_AUTH_TOKEN: token,
    _SUPERMUX_BASE_URL: '',
    location: { search: '', pathname: '/', protocol: 'https:', host: 'acme.test' },
    localStorage: storageDouble,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}

function installFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  ;(globalThis as { fetch?: unknown }).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Promise.resolve(handler(String(url), init))
  }
  return calls
}

const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })
const realFetch = globalThis.fetch

// Install the environment BEFORE the first import: the store's initial state is
// computed at module evaluation.
installStorage()
installWindow()

const { useViewer, isOwnerShell } = await import('../../src/stores/viewer-store')
const { useUI } = await import('../../src/stores/ui-store')

/** Put both stores back to a just-booted, token-less, unresolved state. */
function reset() {
  installStorage()
  installWindow()
  useViewer.setState({ viewer: { kind: 'pending' }, started: false })
  useUI.setState({ botMode: false, activeCompany: null, memberCompany: null })
}

beforeEach(reset)
afterEach(() => {
  ;(globalThis as { fetch?: unknown }).fetch = realFetch
})

describe('isOwnerShell — the owner short-circuit', () => {
  test('a shell carrying the spliced admin bearer is the owner, with no round-trip', () => {
    installWindow('owner-token')
    expect(isOwnerShell()).toBe(true)
  })

  test('a token-less shell (a company / quick-tunnel host) is NOT', () => {
    installWindow()
    expect(isOwnerShell()).toBe(false)
  })

  test('an empty token string does not count as a splice', () => {
    installWindow('')
    expect(isOwnerShell()).toBe(false)
  })
})

describe('resolve()', () => {
  test('an owner shell resolves synchronously and never calls /auth/me', async () => {
    installWindow('owner-token')
    const calls = installFetch(() => jsonRes({ authenticated: false }))
    await useViewer.getState().resolve()
    expect(useViewer.getState().viewer.kind).toBe('owner')
    expect(calls).toHaveLength(0)
    // …and it raises no lock: the owner's stores are untouched.
    expect(useUI.getState().memberCompany).toBe(null)
    expect(useUI.getState().botMode).toBe(false)
  })

  test('an authenticated colleague resolves to MEMBER and raises the lock', async () => {
    installFetch(() =>
      jsonRes({
        authenticated: true,
        identity: {
          user_id: 7,
          email: 'sam@acme.test',
          display_name: '',
          company_id: 3,
          role: 'member',
        },
      }),
    )
    await useViewer.getState().resolve()

    const v = useViewer.getState().viewer
    expect(v.kind).toBe('member')
    if (v.kind === 'member') {
      expect(v.companyId).toBe(3)
      expect(v.userId).toBe(7)
    }
    // Bug #2 + #4: always bot mode, always their own company, never HQ.
    expect(useUI.getState().botMode).toBe(true)
    expect(useUI.getState().activeCompany).toBe(3)
    expect(useUI.getState().memberCompany).toBe(3)
  })

  test('a persisted HQ scope from an earlier visit cannot survive the lock', async () => {
    // The exact owner-reported shape: a browser that once browsed HQ, then an
    // invite link. The persisted blob must not win.
    useUI.setState({ botMode: false, activeCompany: null })
    installFetch(() =>
      jsonRes({ authenticated: true, identity: { user_id: 1, company_id: 9, role: 'member' } }),
    )
    await useViewer.getState().resolve()
    expect(useUI.getState().activeCompany).toBe(9)
    // And a later stray write still cannot move it.
    useUI.getState().setActiveCompany(null)
    expect(useUI.getState().activeCompany).toBe(9)
  })

  test('nobody signed in resolves to ANON — the login gate', async () => {
    installFetch(() => jsonRes({ authenticated: false }))
    await useViewer.getState().resolve()
    expect(useViewer.getState().viewer.kind).toBe('anon')
    expect(useUI.getState().memberCompany).toBe(null)
  })

  test('an unreachable server is ANON, not a blank screen', async () => {
    ;(globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('offline'))
    await useViewer.getState().resolve()
    expect(useViewer.getState().viewer.kind).toBe('anon')
  })

  test('a stored access key rides as the Bearer on the resolve call', async () => {
    installStorage({ 'supermux:access-key': 'pasted-key' })
    const calls = installFetch(() => jsonRes({ authenticated: true, identity: { role: 'owner' } }))
    await useViewer.getState().resolve()
    expect(useViewer.getState().viewer.kind).toBe('owner')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer pasted-key')
  })

  test('resolution runs at most once per load (StrictMode double-mount)', async () => {
    const calls = installFetch(() => jsonRes({ authenticated: false }))
    await Promise.all([
      useViewer.getState().resolve(),
      useViewer.getState().resolve(),
      useViewer.getState().resolve(),
    ])
    expect(calls).toHaveLength(1)
  })
})

describe('signOut', () => {
  test('drops the stored key and falls back to the gate', async () => {
    installStorage({ 'supermux:access-key': 'pasted-key' })
    useViewer.getState().signOut()
    expect(useViewer.getState().viewer.kind).toBe('anon')
    expect(globalThis.localStorage.getItem('supermux:access-key')).toBe(null)
  })
})
