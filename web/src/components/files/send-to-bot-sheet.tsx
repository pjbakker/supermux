// "Send to bot" — hand a file to an agent's composer.
//
// The highest value-per-line integration in the whole feature, and ZERO server
// work: the path becomes `attachmentSentence([abs])` — the canonical wire
// format, already pinned byte-identical to `buildAttachmentPrompt` by
// `chat-composer-insert.test.ts` — inserted into the target session's composer
// draft, then we navigate to that session. `insertIntoComposer` handles a
// not-yet-mounted composer correctly (it writes the module-level,
// sessionStorage-backed draft and returns), so the text survives the navigation
// and is there when the panel mounts.
//
// THE PICKER IS SCOPED. It lists only sessions in the CURRENT space, so the
// action can never hand a company's file to a bot outside it.

import { CornerDownRight } from 'lucide-react'

import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

export interface SendToBotSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Basename of the file being handed over — the sheet says WHAT, not just
   *  who, because the row menu that opened it is already gone by now. */
  fileName: string
  /** Sessions in the active space, pre-filtered by the caller. */
  sessions: readonly { name: string }[]
  onPick: (session: string) => void
}

export function SendToBotSheet({
  open,
  onOpenChange,
  fileName,
  sessions,
  onPick,
}: SendToBotSheetProps) {
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Send to bot"
      description={fileName}
    >
      <div className="flex flex-col p-2">
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No bots in this space yet.
          </p>
        ) : (
          sessions.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => onPick(s.name)}
              className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-accent active:bg-accent"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <CornerDownRight className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
            </button>
          ))
        )}
      </div>
    </ResponsiveSheet>
  )
}
