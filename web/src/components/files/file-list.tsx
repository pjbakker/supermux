import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Check,
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  EllipsisVertical,
  Folder,
  FolderInput,
  PencilLine,
  Send,
  Share2,
  Trash2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { filesApi, type FsEntry } from '@/lib/api'
import { downloadEntry } from './download'
import { formatBytes, formatMtime, iconForEntry } from './file-types'

/** Join a directory with a child name, collapsing the root-slash case. */
export function childPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

export interface FileListProps {
  dirPath: string
  entries: FsEntry[]
  selectedPath: string | null
  onOpenDir: (path: string) => void
  onOpenFile: (entry: FsEntry, path: string) => void
  onDelete: (path: string, isDir: boolean) => void
  // ── files v1 · row menu (§4.3) ──────────────────────────────────────────
  // All four are offered for FILES AND DIRECTORIES alike (except Copy on a
  // dir, which the server refuses until recursive copy lands in v2):
  // `WRITABLE_EXTS` deliberately does not gate them. Renaming a `.pdf` or a
  // `.sqlite` is a NAMESPACE op, not a write, and blocking it would make the
  // feature useless on exactly the files people most want to tidy.
  onRename?: (entry: FsEntry, path: string) => void
  onMove?: (entry: FsEntry, path: string) => void
  onCopy?: (entry: FsEntry, path: string) => void
  onDuplicate?: (entry: FsEntry, path: string) => void
  onSendToBot?: (entry: FsEntry, path: string) => void
  // ── files v1 · multi-select (§4.5) ──────────────────────────────────────
  /** Select mode reveals a checkbox per row and re-points the row's PRIMARY
   *  tap at "toggle". A toolbar toggle, never a long-press: long-press
   *  collides with iOS text selection, and this codebase has a documented
   *  history of selection bugs. */
  selectMode?: boolean
  selectedPaths?: ReadonlySet<string>
  onToggleSelect?: (path: string) => void
}

/** Detected once per mount: does this browser support sharing files via the Web
 *  Share API? iOS Safari and Android Chrome on HTTPS contexts return true here;
 *  desktop browsers usually false (Chrome desktop on HTTPS does support it). We
 *  probe with a tiny text File so we hide the menu item only when the API genuinely
 *  can't accept files (some browsers expose share() for text/url but not files). */
function detectCanShareFiles(): boolean {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.share !== 'function') return false
  if (typeof navigator.canShare !== 'function') return false
  try {
    const probe = new File([''], 'probe.txt', { type: 'text/plain' })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

export function FileList({
  dirPath,
  entries,
  selectedPath,
  onOpenDir,
  onOpenFile,
  onDelete,
  onRename,
  onMove,
  onCopy,
  onDuplicate,
  onSendToBot,
  selectMode,
  selectedPaths,
  onToggleSelect,
}: FileListProps) {
  const { toast } = useToast()
  const [canShareFiles] = React.useState(detectCanShareFiles)

  const handleDownload = async (path: string, name: string) => {
    try {
      // Shared with the bulk bar (`download.ts`) so a row download and a
      // selection download are the same code path.
      await downloadEntry(path, name)
    } catch (e) {
      toast({
        message: `Download failed — ${(e as Error).message}`,
        tone: 'error',
        duration: 4000,
      })
    }
  }

  const handleShare = async (path: string, name: string) => {
    try {
      const res = await fetch(filesApi.rawUrl(path))
      if (!res.ok) throw new Error(`fetch failed (${res.status})`)
      const blob = await res.blob()
      const file = new File(
        [blob],
        name,
        { type: blob.type || 'application/octet-stream' },
      )
      const data: ShareData = { files: [file], title: name }
      // canShare with the real file: some types are blocked by the OS share sheet
      // even when the API exists (e.g. .exe on iOS). Surface that as a clean toast.
      if (navigator.canShare && !navigator.canShare(data)) {
        throw new Error('this file type can’t be shared')
      }
      await navigator.share(data)
    } catch (e) {
      // User dismissed the share sheet → silent, not an error.
      if ((e as { name?: string })?.name === 'AbortError') return
      toast({
        message: `Share failed — ${(e as Error).message}`,
        tone: 'error',
        duration: 4000,
      })
    }
  }

  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {entries.map((entry) => {
        const path = childPath(dirPath, entry.name)
        const isDir = entry.type === 'dir'
        const selected = !isDir && path === selectedPath
        const checked = !!selectedPaths?.has(path)
        const Icon = isDir ? Folder : iconForEntry(entry)
        return (
          <li key={entry.name} className="relative flex items-stretch">
            {selected && !selectMode && (
              <motion.span
                layoutId="file-selection"
                transition={springs.snappy}
                className="absolute inset-0 rounded-lg bg-accent"
              />
            )}
            <motion.button
              type="button"
              whileTap={{ scale: 0.985 }}
              transition={springs.buttonPress}
              // In select mode the row's PRIMARY tap toggles instead of
              // opening — one target per row, so a phone never has to hit a
              // checkbox that is smaller than a fingertip.
              onClick={() =>
                selectMode
                  ? onToggleSelect?.(path)
                  : isDir
                    ? onOpenDir(path)
                    : onOpenFile(entry, path)
              }
              aria-pressed={selectMode ? checked : undefined}
              className={cn(
                'relative flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 text-left transition-colors',
                selected && !selectMode
                  ? 'text-foreground'
                  : 'hover:bg-accent active:bg-accent',
                selectMode && checked && 'bg-accent',
              )}
            >
              {selectMode && (
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors',
                    checked
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border',
                  )}
                >
                  {checked && <Check className="size-3.5" />}
                </span>
              )}
              <Icon
                className={cn(
                  'size-5 shrink-0',
                  isDir ? 'text-primary' : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{entry.name}</span>
                {!isDir && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatBytes(entry.size)}
                    {entry.modified ? ` · ${formatMtime(entry.modified)}` : ''}
                  </span>
                )}
              </span>
              {isDir && !selectMode && (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
              )}
            </motion.button>

            {/* The row menu is hidden in select mode: the bottom bar owns the
                verbs there, and two competing action surfaces on one row is
                how a phone user hits the wrong one. */}
            {!selectMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${entry.name}`}
                  className="relative flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <EllipsisVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onRename && (
                  <DropdownMenuItem onClick={() => onRename(entry, path)}>
                    <PencilLine className="size-4" />
                    Rename…
                  </DropdownMenuItem>
                )}
                {onMove && (
                  <DropdownMenuItem onClick={() => onMove(entry, path)}>
                    <FolderInput className="size-4" />
                    Move…
                  </DropdownMenuItem>
                )}
                {onCopy && (
                  <DropdownMenuItem
                    disabled={isDir}
                    // The honest reason, not a hidden item: the verb exists,
                    // it just refuses a directory until recursive copy lands.
                    title={
                      isDir ? 'Copying a folder isn’t supported yet.' : undefined
                    }
                    onClick={() => !isDir && onCopy(entry, path)}
                  >
                    <Copy className="size-4" />
                    Copy…
                  </DropdownMenuItem>
                )}
                {onDuplicate && !isDir && (
                  <DropdownMenuItem onClick={() => onDuplicate(entry, path)}>
                    <CopyPlus className="size-4" />
                    Duplicate
                  </DropdownMenuItem>
                )}
                {onSendToBot && !isDir && (
                  <DropdownMenuItem onClick={() => onSendToBot(entry, path)}>
                    <Send className="size-4" />
                    Send to bot…
                  </DropdownMenuItem>
                )}
                {!isDir && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => void handleDownload(path, entry.name)}
                    >
                      <Download className="size-4" />
                      Download
                    </DropdownMenuItem>
                    {canShareFiles && (
                      <DropdownMenuItem
                        onClick={() => void handleShare(path, entry.name)}
                      >
                        <Share2 className="size-4" />
                        Share…
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(path, isDir)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </li>
        )
      })}
    </ul>
  )
}
