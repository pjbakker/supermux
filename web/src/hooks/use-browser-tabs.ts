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
  createTab,
  deleteTab,
  grantTab,
  listTabs,
  patchTab,
  revokeTabGrant,
  sortTabs,
  type BrowserTab,
  type TabPatch,
} from '@/lib/api/browser'
import { devMockActive } from '@/hooks/use-sessions'
import { useToast } from '@/components/ui/use-toast'

export const BROWSER_TABS_KEY = ['browser-tabs'] as const

/** What was being attempted, for the failure line. */
export type TabVerb = 'open' | 'pin' | 'update' | 'close' | 'grant' | 'revoke'

const VERB_LEAD: Record<TabVerb, string> = {
  open: "Couldn't open that tab",
  pin: "Couldn't change the pin",
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
  /** Mint a tab row (the page opens lazily on first use). `null` = it failed,
   *  and the human has already been told why. */
  create: (url: string) => Promise<BrowserTab | null>
  /** Pin / unpin — a pinned tab is not reaped and sorts first. */
  setPinned: (id: string, pinned: boolean) => Promise<boolean>
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

  const createM = useMutation({
    mutationFn: (url: string) => createTab(url),
    onSuccess: invalidate,
    onError: fail('open'),
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
      patchM.isPending ||
      closeM.isPending ||
      grantM.isPending ||
      revokeM.isPending,
    create: (url) => settled(createM.mutateAsync(url)),
    setPinned: async (id, pinned) =>
      (await settled(patchM.mutateAsync({ id, patch: { pinned }, verb: 'pin' }))) !== null,
    patch: async (id, patch) =>
      (await settled(patchM.mutateAsync({ id, patch, verb: 'update' }))) !== null,
    close: async (id) => (await settled(closeM.mutateAsync(id))) !== null,
    grant: async (id, grantee) =>
      (await settled(grantM.mutateAsync({ id, grantee }))) !== null,
    revoke: async (id, grantee) =>
      (await settled(revokeM.mutateAsync({ id, grantee }))) !== null,
  }
}
