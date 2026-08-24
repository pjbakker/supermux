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

export const BROWSER_TABS_KEY = ['browser-tabs'] as const

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
  /** Mint a tab row (the page opens lazily on first use). */
  create: (url: string) => Promise<BrowserTab>
  /** Pin / unpin — a pinned tab is not reaped and sorts first. */
  setPinned: (id: string, pinned: boolean) => Promise<BrowserTab>
  patch: (id: string, patch: TabPatch) => Promise<BrowserTab>
  /** Close the tab. Does NOT sign anything out — same jar, same cookies. */
  close: (id: string) => Promise<void>
  /** Lend the tab to a bot slug / `@company:<id>` / `*`. */
  grant: (id: string, grantee: string) => Promise<void>
  revoke: (id: string, grantee: string) => Promise<void>
}

export function useBrowserTabActions(): BrowserTabActions {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: BROWSER_TABS_KEY })
  }

  const createM = useMutation({
    mutationFn: (url: string) => createTab(url),
    onSuccess: invalidate,
  })
  const patchM = useMutation({
    mutationFn: (v: { id: string; patch: TabPatch }) => patchTab(v.id, v.patch),
    onSuccess: invalidate,
  })
  const closeM = useMutation({
    mutationFn: (id: string) => deleteTab(id),
    onSuccess: invalidate,
  })
  const grantM = useMutation({
    mutationFn: (v: { id: string; grantee: string }) => grantTab(v.id, v.grantee),
    onSuccess: invalidate,
  })
  const revokeM = useMutation({
    mutationFn: (v: { id: string; grantee: string }) => revokeTabGrant(v.id, v.grantee),
    onSuccess: invalidate,
  })

  return {
    pending:
      createM.isPending ||
      patchM.isPending ||
      closeM.isPending ||
      grantM.isPending ||
      revokeM.isPending,
    create: (url) => createM.mutateAsync(url),
    setPinned: (id, pinned) => patchM.mutateAsync({ id, patch: { pinned } }),
    patch: (id, patch) => patchM.mutateAsync({ id, patch }),
    close: async (id) => {
      await closeM.mutateAsync(id)
    },
    grant: async (id, grantee) => {
      await grantM.mutateAsync({ id, grantee })
    },
    revoke: async (id, grantee) => {
      await revokeM.mutateAsync({ id, grantee })
    },
  }
}
