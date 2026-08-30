// The shared-browser workspace's data plane — one query, one verb bag.
//
// Mirrors `use-companies` / `use-sessions`: a single `['browser-tabs']` query
// that every surface (the rail, the address bar, the grant sheet) reads, and
// mutations that invalidate exactly that key — so a pin, a grant or a close
// lands on all three at once instead of each keeping its own copy.
//
// The whole workspace is bearer/owner-only server-side (`/api/browser` carries
// `require_admin` and is absent from `member_may_reach`), so there is no
// per-company filtering to do here: what the server returns is what the human
// owns.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  closeTabPage,
  createTab,
  deleteTab,
  grantTab,
  listTabs,
  navControlTab,
  navigateTab,
  openTab,
  patchTab,
  revokeTabGrant,
  sortTabs,
  type BrowserTab,
  type NavControl,
  type TabPatch,
} from '@/lib/api/browser'
import { devMockActive } from '@/hooks/use-sessions'
import { useToast } from '@/components/ui/use-toast'

export const BROWSER_TABS_KEY = ['browser-tabs'] as const

/** What was being attempted, for the failure line. */
export type TabVerb =
  | 'open'
  | 'navigate'
  | 'nav'
  | 'wake'
  | 'sleep'
  | 'pin'
  | 'keepalive'
  | 'update'
  | 'close'
  | 'grant'
  | 'revoke'

const VERB_LEAD: Record<TabVerb, string> = {
  open: "Couldn't open that tab",
  navigate: "Couldn't go there",
  nav: "Couldn't move the page",
  wake: "Couldn't wake the tab",
  sleep: "Couldn't close the page",
  pin: "Couldn't change the pin",
  keepalive: 'Could not change keep-signed-in for this tab',
  update: "Couldn't save that change",
  close: "Couldn't close the tab",
  grant: 'Grant failed',
  revoke: 'Revoke failed',
}

/**
 * The message a FAILED workspace mutation shows.
 *
 * It carries the server's own words, because they are the only ones that say
 * anything useful: a refused grant is almost always company containment
 * ("'Ada' is not in this tab's company"), and swallowing that leaves a human
 * tapping a control that silently does nothing. Exported so the error path is
 * testable without a renderer — the app's idiom for hook logic.
 */
export function tabErrorMessage(verb: TabVerb, error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error ?? '').trim()
  return detail ? `${VERB_LEAD[verb]} — ${detail}` : VERB_LEAD[verb]
}

/**
 * Await a mutation that has ALREADY reported its own failure through `onError`,
 * and resolve `null` instead of rejecting.
 *
 * Not a swallow of the error — the toast has fired by the time this runs
 * (TanStack calls `onError` before it rejects the promise). It exists so a
 * caller's `finally` clears its busy state and no unhandled rejection reaches
 * the console; `null` IS the failure, and every caller branches on it.
 */
export async function settled<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work
  } catch {
    return null
  }
}

export interface UseBrowserTabsResult {
  /** Already in rail order (pinned first, then most-recently-used). */
  tabs: BrowserTab[]
  isLoading: boolean
  isError: boolean
}

/** `GET /api/browser/tabs`. Polled slowly rather than pushed: `live` and
 *  `login_state` change on a Chrome reap or a probe, both of which are minutes-
 *  scale events — an SSE channel for that would be new plumbing for no gain. */
export function useBrowserTabs(): UseBrowserTabsResult {
  const query = useQuery({
    queryKey: BROWSER_TABS_KEY,
    queryFn: listTabs,
    staleTime: 10_000,
    refetchInterval: 30_000,
    // DEV `?mock`: the bench seeds the cache; a live fetch would overwrite it.
    enabled: !devMockActive(),
  })
  return {
    tabs: sortTabs(query.data ?? []),
    isLoading: query.isLoading,
    isError: query.isError,
  }
}

export interface BrowserTabActions {
  pending: boolean
  /** Mint a tab AND open it (`?open=true`), because a human who typed an
   *  address meant "load this", not "insert a row". Stamped into the active
   *  company (`null`/omitted = HQ), so a tab opened while a company is in scope
   *  belongs to it. `null` return = it failed, and the human has been told why. */
  create: (url: string, companyId?: number | null) => Promise<BrowserTab | null>
  /** Point an EXISTING tab at a url — waking it first if it is asleep. This is
   *  the address bar's Enter. */
  navigate: (id: string, url: string) => Promise<BrowserTab | null>
  /** Wake a dehydrated tab where it stands, at its own url. */
  wake: (id: string) => Promise<BrowserTab | null>
  /** back / forward / reload / stop over HTTP — the door used when no takeover
   *  socket is attached (it wakes the tab first). `false` = the page did not
   *  move, which for Back at the start of a history is a state, not a failure. */
  navControl: (id: string, verb: NavControl) => Promise<boolean>
  /** Close the PAGE and keep the tab — the inverse of `wake`. Not `close`,
   *  which drops the row. */
  sleep: (id: string) => Promise<BrowserTab | null>
  /** Pin / unpin — a pinned tab is not reaped and sorts first. */
  setPinned: (id: string, pinned: boolean) => Promise<boolean>
  /** "Keep me signed in". A pure DB write server-side — the first check lands
   *  within a minute, and the sweep learns the cadence from the cookie jar.
   *  `false` = the server refused (a non-web page, or the fifth tab), and the
   *  human has already been told why. */
  setKeepAlive: (id: string, on: boolean, host?: string) => Promise<boolean>
  patch: (id: string, patch: TabPatch) => Promise<boolean>
  /** Close the tab. Does NOT sign anything out — same jar, same cookies. */
  close: (id: string) => Promise<boolean>
  /** Lend the tab to a bot slug / `@company:<id>` / `*`. `false` = refused
   *  (cross-company containment is a 400), and the toast said so. */
  grant: (id: string, grantee: string) => Promise<boolean>
  revoke: (id: string, grantee: string) => Promise<boolean>
}

export function useBrowserTabActions(): BrowserTabActions {
  const qc = useQueryClient()
  const { toast } = useToast()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: BROWSER_TABS_KEY })
  }
  // EVERY mutation reports. A grant the server refused used to clear its
  // spinner and change nothing, which reads exactly like a grant that worked —
  // the sibling connector store has always toasted here, and a lent tab is the
  // higher-consequence of the two.
  const fail = (verb: TabVerb) => (e: unknown) =>
    toast({ message: tabErrorMessage(verb, e), tone: 'error', duration: 5000 })

  // A tab the server just navigated or woke comes back ALREADY LIVE. Writing it
  // straight into the cache is what makes the UI flip to the viewport on the
  // same tick — the list is polled every 30 s, and waiting for that poll is the
  // "I pressed Go and nothing happened" half-minute the audit measured.
  const settle = (tab: BrowserTab) => {
    qc.setQueryData<BrowserTab[]>(BROWSER_TABS_KEY, (prev) =>
      prev ? prev.map((t) => (t.id === tab.id ? tab : t)) : prev,
    )
    invalidate()
  }

  const createM = useMutation({
    // `open: true` — see [[createTab]]. The lazy path stays the agent's.
    // `companyId` stamps the row into the active scope (see `create` below).
    mutationFn: (v: { url: string; companyId: number | null }) =>
      createTab(v.url, v.companyId, true),
    onSuccess: (tab) => {
      qc.setQueryData<BrowserTab[]>(BROWSER_TABS_KEY, (prev) =>
        prev ? [...prev.filter((t) => t.id !== tab.id), tab] : prev,
      )
      invalidate()
    },
    onError: fail('open'),
  })
  const navigateM = useMutation({
    mutationFn: (v: { id: string; url: string }) => navigateTab(v.id, v.url),
    onSuccess: settle,
    onError: fail('navigate'),
  })
  const wakeM = useMutation({
    mutationFn: (id: string) => openTab(id),
    onSuccess: settle,
    onError: fail('wake'),
  })
  const navM = useMutation({
    mutationFn: (v: { id: string; verb: NavControl }) => navControlTab(v.id, v.verb),
    onSuccess: settle,
    onError: fail('nav'),
  })
  const sleepM = useMutation({
    mutationFn: (id: string) => closeTabPage(id),
    onSuccess: settle,
    onError: fail('sleep'),
  })
  const patchM = useMutation({
    mutationFn: (v: { id: string; patch: TabPatch; verb: TabVerb }) =>
      patchTab(v.id, v.patch),
    onSuccess: invalidate,
    onError: (e: unknown, v) => fail(v.verb)(e),
  })
  const closeM = useMutation({
    mutationFn: (id: string) => deleteTab(id),
    onSuccess: invalidate,
    onError: fail('close'),
  })
  const grantM = useMutation({
    mutationFn: (v: { id: string; grantee: string }) => grantTab(v.id, v.grantee),
    onSuccess: invalidate,
    onError: fail('grant'),
  })
  const revokeM = useMutation({
    mutationFn: (v: { id: string; grantee: string }) => revokeTabGrant(v.id, v.grantee),
    onSuccess: invalidate,
    onError: fail('revoke'),
  })

  return {
    pending:
      createM.isPending ||
      navigateM.isPending ||
      wakeM.isPending ||
      navM.isPending ||
      sleepM.isPending ||
      patchM.isPending ||
      closeM.isPending ||
      grantM.isPending ||
      revokeM.isPending,
    create: (url, companyId = null) => settled(createM.mutateAsync({ url, companyId })),
    navigate: (id, url) => settled(navigateM.mutateAsync({ id, url })),
    wake: (id) => settled(wakeM.mutateAsync(id)),
    navControl: async (id, verb) => {
      const out = await settled(navM.mutateAsync({ id, verb }))
      return out !== null && out.moved
    },
    sleep: (id) => settled(sleepM.mutateAsync(id)),
    setPinned: async (id, pinned) =>
      (await settled(patchM.mutateAsync({ id, patch: { pinned }, verb: 'pin' }))) !== null,
    // The ⋯ menu CLOSES on select, so a success that changes nothing on screen
    // needs a word. Failures already speak through `patchM`'s `fail(verb)`,
    // which is how the server's two refusals reach the owner.
    setKeepAlive: async (id, on, host) => {
      const out = await settled(
        patchM.mutateAsync({ id, patch: { keepalive_enabled: on }, verb: 'keepalive' }),
      )
      if (out === null) return false
      const what = host ?? 'this tab'
      toast({
        message: on
          ? `Keeping ${what} signed in — first check within a minute.`
          : `Stopped keeping ${what} signed in.`,
        duration: 4000,
      })
      return true
    },
    patch: async (id, patch) =>
      (await settled(patchM.mutateAsync({ id, patch, verb: 'update' }))) !== null,
    close: async (id) => (await settled(closeM.mutateAsync(id))) !== null,
    grant: async (id, grantee) =>
      (await settled(grantM.mutateAsync({ id, grantee }))) !== null,
    revoke: async (id, grantee) =>
      (await settled(revokeM.mutateAsync({ id, grantee }))) !== null,
  }
}
