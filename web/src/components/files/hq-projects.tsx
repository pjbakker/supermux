// HQ's landing CONTENTS — the projects list (owner decision D1).
//
// HQ is a space with contents, not an exception and not `$HOME`: its top level
// is the subdir list of the first `SUPERMUX_PROJECT_DIRS` entry, the same list
// the "Where" picker already renders (`GET /api/projects/repos`). `$HOME` stays
// reachable by walking the crumbs up from any project — HQ sets no floor — and
// when no project root is configured this offers that door directly rather than
// showing an empty page.
//
// The endpoint is deliberately NOT member-reachable and returns an empty list
// to a scoped human, which is exactly right: a member never renders HQ at all.

import { FolderGit2, FolderOpen, House } from 'lucide-react'

import { EmptyStatePlaceholder } from '@/components/empty-state'
import type { ProjectRepo } from '@/lib/api'

export interface HqProjectsProps {
  /** The scanned root (`SUPERMUX_PROJECT_DIRS`'s first entry), '' when unset. */
  root: string
  entries: readonly ProjectRepo[]
  onOpen: (path: string) => void
  /** Browse `$HOME` — the owner's unrestricted door, offered explicitly when
   *  there is no project root to list. */
  onOpenHome: () => void
}

export function HqProjects({ root, entries, onOpen, onOpenHome }: HqProjectsProps) {
  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyStatePlaceholder
          icon={<FolderOpen />}
          message={
            root
              ? `Nothing under ${root} yet.`
              : 'No project root configured (SUPERMUX_PROJECT_DIRS).'
          }
          cta={{ label: 'Browse home', onClick: onOpenHome }}
        />
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <span className="truncate font-mono">{root}</span>
      </div>
      <ul className="flex flex-col gap-0.5 p-2">
        {entries.map((p) => (
          <li key={p.path}>
            <button
              type="button"
              onClick={() => onOpen(p.path)}
              className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-accent active:bg-accent"
            >
              {p.is_git_repo ? (
                <FolderGit2 className="size-5 shrink-0 text-primary" />
              ) : (
                <FolderOpen className="size-5 shrink-0 text-primary" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.path}
                </span>
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={onOpenHome}
            className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
          >
            <House className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm">Home</span>
          </button>
        </li>
      </ul>
    </div>
  )
}
