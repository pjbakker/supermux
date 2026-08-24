// `+ New` — one toolbar button, one sheet, a segmented Folder | File.
//
// Two buttons competing for the 44px budget in an already-crowded 390px header
// is how a toolbar stops being usable; one button that asks "which?" costs one
// tap and keeps the header legible (files v1 spec §4.4).
//
// A NEW FILE IS NOT A NEW ENDPOINT: it is `PUT /api/file` with `content: ""`
// and `if_modified: 0`, which is the server's "I am creating a new file"
// assertion — it 409s on an existing path instead of silently truncating it.
//
// The name is validated with the SAME `isWritable` the viewer gates editing on,
// BEFORE the call, so the user reads "supermux can only create text files here
// — .xlsx isn't in the writable list" instead of a raw 403 from the server's
// `is_writable_target`.

import * as React from 'react'
import { File, Folder } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { extOf, isWritable } from './file-types'

export type NewEntryKind = 'folder' | 'file'

export interface NewEntrySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The directory the new entry lands in — shown so the sheet is honest about
   *  WHERE, which matters the moment more than one space exists. */
  dirPath: string
  onCreate: (kind: NewEntryKind, name: string) => void
  pending?: boolean
}

/** Why this name can't be created, or null. Exported for the unit tests: the
 *  point of client-side validation is the MESSAGE, so the message is pinned. */
export function newEntryError(kind: NewEntryKind, name: string): string | null {
  if (name.includes('/')) {
    return 'A name can’t contain “/” — create the folder first, then the file inside it.'
  }
  if (name === '.' || name === '..') return 'That name is reserved.'
  if (kind === 'folder') return null
  if (isWritable(name)) return null
  const ext = extOf(name)
  return ext
    ? `supermux can only create text files here — “.${ext}” isn’t in the writable list.`
    : 'supermux can only create text files here.'
}

export function NewEntrySheet({
  open,
  onOpenChange,
  dirPath,
  onCreate,
  pending,
}: NewEntrySheetProps) {
  // Fresh state per OPEN: the caller keys this sheet on its open state, so a
  // mount is the reset — no prop-syncing effect.
  const [kind, setKind] = React.useState<NewEntryKind>('folder')
  const [name, setName] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [open])

  const trimmed = name.trim()
  const error = trimmed ? newEntryError(kind, trimmed) : null
  const canSubmit = !!trimmed && !error && !pending

  const submit = () => {
    if (!canSubmit) return
    onCreate(kind, trimmed)
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="New"
      description={dirPath}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            Create
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <div
          role="group"
          aria-label="What to create"
          className="flex h-12 items-center rounded-lg border border-border bg-card p-1"
        >
          <SegButton
            active={kind === 'folder'}
            onClick={() => setKind('folder')}
            icon={<Folder className="size-4" />}
            label="Folder"
          />
          <SegButton
            active={kind === 'file'}
            onClick={() => setKind('file')}
            icon={<File className="size-4" />}
            label="File"
          />
        </div>

        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={kind === 'folder' ? 'reports' : 'notes.md'}
          aria-label={kind === 'folder' ? 'Folder name' : 'File name'}
          aria-invalid={!!error}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-12 w-full rounded-lg border border-border bg-card px-3 font-mono text-sm outline-none focus:border-primary"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </ResponsiveSheet>
  )
}

function SegButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
