// The DESTINATION SHEET — shared by Move…, Copy… and the bulk bar.
//
// A dir-only browser inside a `<ResponsiveSheet>`: crumb, folder rows, a
// typeahead, and a sticky footer. Deliberately NOT a column view and NOT a
// tree — both are desktop idioms that scroll horizontally on a phone, and this
// app's answer at 390px is breadcrumb + list, which is already built and
// already correct (files v1 spec §4.4).
//
// The crumb is floored exactly like the main breadcrumb, so a company-scoped
// owner cannot pick a destination outside the company by walking up inside the
// picker — the same lens the browser itself applies, not a second one.

import * as React from 'react'
import { CornerLeftUp, Folder, LoaderCircle, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { Breadcrumb } from '@/components/files/breadcrumb'
import { useDirListing } from '@/hooks/use-files'
import { sessionsApi } from '@/lib/api'
import { confineToCompanyRoot } from '@/lib/companies'
import { childPath } from './file-list'

export interface DirPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** What the footer's confirm button says — "Move here" / "Copy here". */
  actionLabel: string
  /** Where the picker opens. */
  startDir: string
  /** Company root, or null. Crumbs are floored here and every navigation is
   *  confined to it — the same owner-lens the main browser applies. */
  floor: string | null
  /** Paths that must NOT be offered as a destination (you cannot move a folder
   *  into itself). Compared as `/`-delimited prefixes. */
  forbidden?: readonly string[]
  onPick: (dir: string) => void
  pending?: boolean
}

export function DirPickerSheet({
  open,
  onOpenChange,
  title,
  actionLabel,
  startDir,
  floor,
  forbidden,
  onPick,
  pending,
}: DirPickerSheetProps) {
  // Anchored at the caller's directory on MOUNT. The caller keys this sheet on
  // its open state, so re-opening it is a fresh mount — no effect syncs state
  // to a prop, and there is no stale `dir` from a previous open.
  const [dir, setDir] = React.useState(startDir)
  const [query, setQuery] = React.useState('')
  const [suggestions, setSuggestions] = React.useState<string[]>([])

  // Typeahead over `GET /api/autocomplete/dir` with `hidden=0`, debounced. The
  // endpoint already exists and already caps at 10 results; this is a field on
  // top of it, not a second search. An EMPTY query clears the list by
  // DERIVATION (`shown` below) rather than by a synchronous setState in the
  // effect body — same result, no cascading render.
  React.useEffect(() => {
    const q = query.trim()
    if (!q) return
    let alive = true
    const t = window.setTimeout(() => {
      void sessionsApi.autocompleteDir(q, true).then((rows) => {
        if (alive) setSuggestions(rows)
      })
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [query])

  const shown = query.trim() ? suggestions : []

  const listing = useDirListing(dir, false, open)
  const dirs = React.useMemo(
    () => (listing.data?.entries ?? []).filter((e) => e.type === 'dir'),
    [listing.data],
  )

  const go = (next: string) => {
    setQuery('')
    setDir(confineToCompanyRoot(next, floor))
  }

  const blocked = (candidate: string) =>
    (forbidden ?? []).some(
      (f) => candidate === f || candidate.startsWith(f.replace(/\/+$/, '') + '/'),
    )

  const here = listing.data?.path ?? dir
  const canConfirm = !pending && !blocked(here)

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={here}
      className="sm:max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onPick(here)} disabled={!canConfirm}>
            {actionLabel}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2">
          <Breadcrumb path={here} onNavigate={go} floor={floor} />
          {listing.data?.parent && (
            <button
              type="button"
              onClick={() => go(listing.data!.parent!)}
              aria-label="Go up one level"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CornerLeftUp className="size-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a folder…"
            aria-label="Jump to a folder"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-9 min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
          />
        </div>

        <ul className="flex flex-col gap-0.5 p-2">
          {shown.length > 0
            ? shown.map((s) => (
                <DirRow
                  key={s}
                  label={s}
                  disabled={blocked(s)}
                  onClick={() => go(s)}
                />
              ))
            : listing.isLoading
              ? (
                  <li className="flex items-center justify-center py-8">
                    <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  </li>
                )
              : listing.isError
                ? (
                    <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                      {(listing.error as Error)?.message ??
                        'Could not list this directory.'}
                    </li>
                  )
                : dirs.length === 0
                  ? (
                      <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                        No sub-folders here. “{actionLabel}” drops it in this
                        folder.
                      </li>
                    )
                  : dirs.map((e) => {
                      const p = childPath(here, e.name)
                      return (
                        <DirRow
                          key={e.name}
                          label={e.name}
                          disabled={blocked(p)}
                          onClick={() => go(p)}
                        />
                      )
                    })}
        </ul>
      </div>
    </ResponsiveSheet>
  )
}

function DirRow({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        title={disabled ? 'You can’t move a folder into itself.' : label}
        className={cn(
          'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors',
          disabled
            ? 'cursor-not-allowed text-muted-foreground/50'
            : 'hover:bg-accent active:bg-accent',
        )}
      >
        <Folder className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      </button>
    </li>
  )
}
