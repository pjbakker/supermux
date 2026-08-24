// useFiles — TanStack Query bindings for the file browser.
//
// Files USED to be a deliberately non-live surface: the cache was the source of
// truth and only our own mutations invalidated it. That was the least grok-like
// thing about the feature — a bot writing into the directory you are staring at
// was invisible indefinitely. Files v1 (spec §3) fixes it with TWO additive
// mechanisms that both end in the same `invalidateQueries`, so neither can
// regress the other:
//
//   1. the company-stamped `files` SSE frame (`useFilesLive`) — the real
//      signal, emitted by every mutating handler AND by the `post_tool` hook
//      arm, so an agent's Write/Edit lands within a frame;
//   2. a visibility-gated 10s `refetchInterval` on the OPEN directory only —
//      a bounded, foreground-only exception to the project's "no 3s polling"
//      anti-vision, and it exists solely to cover the ONE blind spot the hook
//      arm cannot see: an agent writing through `Bash` (`>`, `sed -i`, build
//      output). It is removed when the `notify` FS watcher lands (v2).
//
// The DIRTY GUARD in `filesLiveActions` is the load-bearing part of (1): a
// refetch under an unsaved editor draft is exactly the data loss the `PUT`
// 409 guard exists to prevent, arriving through the back door.

import * as React from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { filesApi, getSessionDir } from '@/lib/api'
import type { Company, FileMeta, FsListing } from '@/lib/api'
import { companyForPath } from '@/lib/companies'
import { useSse, type SseEventType } from '@/hooks/use-sse'
import {
  activityKey,
  useFilesActivityStore,
} from '@/stores/files-activity-store'

/** The home-directory sentinel the backend expands to $HOME. */
export const HOME_PATH = '~'

const lsKey = (path: string, hidden: boolean) =>
  ['files', 'ls', path, hidden] as const
const fileKey = (path: string) => ['files', 'file', path] as const

/** List a directory. Returns the resolved absolute `path` + `parent` + entries.
 *
 *  `enabled` exists for the two surfaces that hold a path they are not looking
 *  at: the Spaces landing (no directory at all) and a CLOSED destination sheet.
 *  Without it both would fire an `/api/ls` — and the landing's would be for the
 *  empty string. */
export function useDirListing(path: string, hidden: boolean, enabled = true) {
  return useQuery<FsListing>({
    queryKey: lsKey(path, hidden),
    queryFn: () => filesApi.ls(path, hidden),
    enabled: enabled && !!path,
    // Listings change off-app (other agents write files); a short stale window
    // keeps re-navigation snappy without polling.
    staleTime: 5_000,
    // §3.6 — the BACKSTOP, not the mechanism. `useFilesLive` is what makes an
    // agent write appear instantly; this covers the `Bash`-write blind spot the
    // hook plane cannot report. Foreground-only and scoped to the ONE open
    // directory, so a backgrounded tab and every other cached listing cost
    // nothing.
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'visible'
        ? 10_000
        : false,
    refetchIntervalInBackground: false,
    retry: false,
  })
}

/** Read a single file's type-aware payload. Disabled until a file is selected. */
export function useFileContent(path: string | null) {
  return useQuery<FileMeta>({
    queryKey: fileKey(path ?? ''),
    queryFn: () => filesApi.readFile(path as string),
    enabled: !!path,
    staleTime: 0,
    retry: false,
  })
}

/** Resolve the `/files/:name` session root → its working dir (or null). */
export function useSessionDir(name: string | undefined) {
  return useQuery<string | null>({
    queryKey: ['files', 'session-dir', name ?? null],
    queryFn: () => (name ? getSessionDir(name) : Promise.resolve(null)),
    enabled: !!name,
    staleTime: 60_000,
    retry: false,
  })
}

/** Save (PUT) a text file, then refresh its cached content.
 *
 *  `ifModified` is the `modified` epoch-seconds the viewer read from the cached
 *  `['files','file', path]` payload. When it is passed and the file has moved
 *  on since, the server answers **409** and this mutation FAILS — the caller
 *  surfaces that as a conflict the user resolves, never as a silent clobber and
 *  never as a generic error toast (files v1 spec §2.5). Omitting it keeps the
 *  historical blind write for any caller that has no `modified` to offer. */
export function useSaveFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      path,
      content,
      ifModified,
    }: {
      path: string
      content: string
      ifModified?: number
    }) => filesApi.writeFile(path, content, ifModified),
    onSuccess: (_data, { path }) => {
      qc.invalidateQueries({ queryKey: fileKey(path) })
      qc.invalidateQueries({ queryKey: ['files', 'ls'] })
    },
  })
}

/** `POST /api/fs/mkdir` — create a directory, then refresh listings. */
export function useMkdir() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => filesApi.mkdir(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}

/** `POST /api/fs/rename` — rename OR move (same verb, different destination
 *  directory), then refresh listings. Both the source and the destination
 *  listing live under the same `['files','ls']` prefix, so one invalidation
 *  covers the pair. */
export function useMoveEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      from,
      to,
      overwrite,
    }: {
      from: string
      to: string
      overwrite?: boolean
    }) => filesApi.move(from, to, { overwrite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}

/** `POST /api/fs/copy` — copy a single file, then refresh listings. */
export function useCopyEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      from,
      to,
      overwrite,
    }: {
      from: string
      to: string
      overwrite?: boolean
    }) => filesApi.copy(from, to, { overwrite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}

/** Upload one or more files into `dir`, then refresh listings. */
export function useUploadFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ dir, files }: { dir: string; files: File[] }) =>
      filesApi.uploadFiles(dir, files),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}

/** Delete a file or directory, then refresh listings. */
export function useDeleteFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => filesApi.deleteFile(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files', 'ls'] }),
  })
}

// ── Liveness — the `files` SSE frame (spec §3) ────────────────────────────────

/** The `files` frame, after validation. `dir` is computed SERVER-SIDE on
 *  purpose: the FE would otherwise re-implement `dirname` for two transports
 *  and get remote paths wrong, so this type has no derivation in it at all. */
export interface FilesFrame {
  /** `write` | `mkdir` | `rename` | `copy` | `put` | `delete` | `upload`. */
  op: string
  /** Absolute path of the affected entry — the DESTINATION for rename/copy. */
  path: string
  /** Absolute parent dir, server-computed. */
  dir: string | null
  /** Absolute previous path — rename only. */
  from: string | null
  /** Attributed session, or null for a human-initiated verb. */
  session: string | null
}

/** Validate an SSE payload into a `FilesFrame`. Anything without a usable
 *  string `path` is dropped: a frame we can't place is a frame we can't act on,
 *  and guessing is how a stray invalidation storm starts. Pure. */
export function parseFilesFrame(payload: unknown): FilesFrame | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.path !== 'string' || !p.path) return null
  return {
    op: typeof p.op === 'string' ? p.op : 'write',
    path: p.path,
    dir: typeof p.dir === 'string' ? p.dir : null,
    from: typeof p.from === 'string' ? p.from : null,
    session: typeof p.session === 'string' ? p.session : null,
  }
}

/** What the open Files surface should invalidate for one frame. */
export interface FilesLiveContext {
  /** The directory currently listed, or null on the Spaces landing. */
  dirPath: string | null
  /** The file open in the viewer, or null. */
  openPath: string | null
  /** Does the viewer hold an UNSAVED draft of `openPath`? */
  dirty: boolean
}

/**
 * The pure decision behind `useFilesLive`: frame + context → the query keys to
 * invalidate. Extracted so the three rules that matter are unit-testable
 * without a React tree, a query client or an EventSource:
 *
 *   1. a frame whose `dir` IS the open directory refreshes the listing (a
 *      prefix key, so it covers BOTH the hidden and non-hidden variants);
 *   2. a frame for ANOTHER directory refreshes nothing — an agent working in
 *      a different folder must not re-fetch what you are reading;
 *   3. a frame for the OPEN file refreshes it **only when the buffer is
 *      clean**. Under a dirty draft we return no key at all: the caller shows
 *      a "changed on disk" affordance instead. Refetching over an unsaved edit
 *      is precisely the data loss the `PUT` 409 guard exists to prevent.
 *
 * A `rename` also touches its SOURCE directory, which the frame carries as
 * `from` — so a move OUT of the open directory refreshes it too, otherwise the
 * row would linger until the next 10s backstop tick.
 */
export function filesLiveActions(
  frame: FilesFrame,
  ctx: FilesLiveContext,
): { invalidate: (readonly unknown[])[]; staleOpenFile: boolean } {
  const invalidate: (readonly unknown[])[] = []
  const touchesDir =
    (!!ctx.dirPath && frame.dir === ctx.dirPath) ||
    (!!ctx.dirPath && !!frame.from && parentOf(frame.from) === ctx.dirPath)
  if (touchesDir) invalidate.push(['files', 'ls', ctx.dirPath] as const)

  const touchesOpenFile = !!ctx.openPath && frame.path === ctx.openPath
  if (touchesOpenFile && !ctx.dirty) {
    invalidate.push(['files', 'file', ctx.openPath] as const)
  }
  return { invalidate, staleOpenFile: touchesOpenFile && ctx.dirty }
}

/** Lexical parent of an absolute path. Used ONLY for a rename's `from` (the
 *  server gives us `dir` for the destination); a lexical split is right here
 *  because both sides came from the same server-canonicalized string. */
function parentOf(abs: string): string {
  const trimmed = abs.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  if (i < 0) return trimmed
  return i === 0 ? '/' : trimmed.slice(0, i)
}

/**
 * Subscribe the open Files surface to the `files` channel.
 *
 * Shaped like `use-harness-events.ts`: a `useMemo`'d handlers object over the
 * shared SSE singleton, so the subscription never tears down on a re-render.
 * Every frame also feeds the Spaces landing's activity line — stamped by the
 * company that OWNS THE PATH (`companyForPath`, the client mirror of the
 * server's one stamping rule), never by the emitting session's company.
 *
 * Returns the path of the open file when it changed on disk under a DIRTY
 * draft — the caller renders a "changed on disk" affordance and decides; this
 * hook will not refetch over an unsaved buffer.
 */
export function useFilesLive(
  ctx: FilesLiveContext,
  companies: readonly Company[],
): string | null {
  const qc = useQueryClient()
  const record = useFilesActivityStore((s) => s.record)
  const [staleOpen, setStaleOpen] = React.useState<string | null>(null)

  // The context is read through a ref so a keystroke in the editor (which flips
  // `dirty`) does not rebuild the handlers and re-register the subscription.
  // Written in an EFFECT, never during render: a ref mutated while rendering is
  // a torn read under concurrent React.
  const ctxRef = React.useRef(ctx)
  const companiesRef = React.useRef(companies)
  React.useEffect(() => {
    ctxRef.current = ctx
    companiesRef.current = companies
  })

  const handlers = React.useMemo(
    () => ({
      onEvent: (type: SseEventType, payload: unknown) => {
        if (type !== 'files') return
        const frame = parseFilesFrame(payload)
        if (!frame) return

        // The landing line, for EVERY frame — including ones for directories
        // we are not looking at. That is the point: the grid is how you find
        // out a bot is busy in a space you left.
        const owner = companyForPath(frame.path, companiesRef.current)
        record(activityKey(owner ? owner.id : null), {
          at: Date.now(),
          path: frame.path,
          op: frame.op,
          session: frame.session,
        })

        const { invalidate, staleOpenFile } = filesLiveActions(
          frame,
          ctxRef.current,
        )
        for (const key of invalidate) {
          void qc.invalidateQueries({ queryKey: key })
        }
        if (staleOpenFile) setStaleOpen(ctxRef.current.openPath)
      },
      // A wake from a backgrounded tab: everything we missed while the
      // EventSource was suspended is one listing refresh away.
      onResync: () => {
        void qc.invalidateQueries({ queryKey: ['files', 'ls'] })
      },
    }),
    [qc, record],
  )
  useSse(handlers)

  // DERIVED, not cleaned up by an effect: a banner is only meaningful while the
  // same file is still open AND still dirty. Saving it (or opening another
  // file) retires the banner without a second state write.
  return staleOpen && staleOpen === ctx.openPath && ctx.dirty ? staleOpen : null
}
