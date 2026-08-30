// /dev/files — the 390px bench for the Bot Company Drive's new surfaces.
//
// DEV-ONLY and lazy (`App.tsx`), so the production bundle pays nothing.
//
// WHY IT EXISTS. Three of files v1's surfaces are the ones a phone can most
// easily get wrong — the Spaces grid (does a 2-up card fit 390px without
// clipping the activity line?), the destination sheet (does the dir-only
// browser scroll horizontally?), and the multi-select bottom bar (does it clear
// the home indicator, and is the last row reachable?). All three need data the
// server would otherwise have to supply, so this bench feeds them by hand and
// SEEDS the query cache for the listing — it fetches nothing, exactly like the
// components it is showing.
//
//   ?surface=spaces   the Spaces grid (default)
//   ?surface=picker   the destination sheet, open
//   ?surface=new      the + New sheet, open
//   ?surface=select   a file list in select mode + the bottom action bar

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'

import { DirPickerSheet } from '@/components/files/dir-picker-sheet'
import { FileList } from '@/components/files/file-list'
import { NewEntrySheet } from '@/components/files/new-entry-sheet'
import { SelectBar } from '@/components/files/select-bar'
import { SpacesGrid } from '@/components/files/spaces-grid'
import { spaceCards } from '@/components/files/spaces'
import type { Company } from '@/lib/companies'
import type { FsEntry } from '@/lib/api'

const COMPANIES: Company[] = [
  { id: 1, slug: 'acme', display_name: 'Acme', root_dir: '/srv/acme', archived: 0 },
  { id: 2, slug: 'globex', display_name: 'Globex Corporation', root_dir: '/srv/globex', archived: 0 },
  { id: 3, slug: 'contoso', display_name: 'Contoso', root_dir: '/srv/contoso', archived: 0 },
]

const SESSIONS = [
  { company_id: null }, { company_id: null }, { company_id: null }, { company_id: null },
  { company_id: 1 }, { company_id: 1 }, { company_id: 1 },
  { company_id: 1 }, { company_id: 1 }, { company_id: 1 },
  { company_id: 2 }, { company_id: 2 },
]

const ACTIVITY = {
  '1': {
    at: 0,
    // A deliberately long name: the activity line must CLAMP, not wrap or push.
    path: '/srv/acme/reports/quarterly-revenue-breakdown-2026.md',
    op: 'write',
    session: 'analyst',
  },
}

const ENTRIES: FsEntry[] = [
  { name: 'reports', type: 'dir', size: 0, modified: 1_755_000_000 },
  { name: 'archive', type: 'dir', size: 0, modified: 1_755_000_000 },
  { name: 'a-deliberately-long-file-name-for-truncation.md', type: 'file', size: 12_345, modified: 1_755_000_000 },
  { name: 'notes.md', type: 'file', size: 812, modified: 1_755_000_000 },
  { name: '.env', type: 'file', size: 96, modified: 1_755_000_000 },
  { name: 'report.pdf', type: 'file', size: 2_400_000, modified: 1_755_000_000 },
]

const noop = () => {}

export default function DevFiles() {
  const [params] = useSearchParams()
  const surface = params.get('surface') ?? 'spaces'
  const qc = useQueryClient()

  // Seed the listing the destination sheet reads, so the bench needs no server.
  React.useEffect(() => {
    qc.setQueryData(['files', 'ls', '/srv/acme', false], {
      path: '/srv/acme',
      parent: '/srv',
      entries: ENTRIES,
    })
  }, [qc])

  const [checked, setChecked] = React.useState<ReadonlySet<string>>(
    () => new Set(['/srv/acme/notes.md', '/srv/acme/report.pdf']),
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="glass safe-header flex shrink-0 items-center border-b border-hairline px-3 text-sm font-medium">
        /dev/files · {surface}
      </header>

      {surface === 'spaces' && (
        <SpacesGrid
          cards={spaceCards(COMPANIES, SESSIONS, ACTIVITY, { includeHq: true })}
          activeCompany={1}
          onOpen={noop}
          now={0}
        />
      )}

      {surface === 'select' && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto pb-24">
            <FileList
              dirPath="/srv/acme"
              entries={ENTRIES}
              selectedPath={null}
              onOpenDir={noop}
              onOpenFile={noop}
              onDelete={noop}
              selectMode
              selectedPaths={checked}
              onToggleSelect={(p) =>
                setChecked((prev) => {
                  const next = new Set(prev)
                  if (next.has(p)) next.delete(p)
                  else next.add(p)
                  return next
                })
              }
            />
          </div>
          <SelectBar
            count={checked.size}
            canCopy
            onMove={noop}
            onCopy={noop}
            onDownload={noop}
            onDelete={noop}
            onCancel={noop}
          />
        </>
      )}

      {surface === 'picker' && (
        <DirPickerSheet
          open
          onOpenChange={noop}
          title="Move to…"
          actionLabel="Move here"
          startDir="/srv/acme"
          floor="/srv/acme"
          onPick={noop}
        />
      )}

      {surface === 'new' && (
        <NewEntrySheet open onOpenChange={noop} dirPath="/srv/acme" onCreate={noop} />
      )}
    </div>
  )
}
