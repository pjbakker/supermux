// `<NameSheet>` — one text input in a bottom sheet, for Rename.
//
// A `<ResponsiveSheet>` rather than a `<Dialog>` because it contains a text
// input, and every bottom-anchored surface with an input in this app rides the
// keyboard contract (the mode-9 lesson): the sheet lifts by `--kb` and caps at
// `--vvh`, and the footer carries the safe-area pad. That is already true of
// `ResponsiveSheet`; using it is how this surface inherits it instead of
// re-deriving it.
//
// Autofocus + STEM SELECTION on open: renaming `report-final.md` almost always
// means editing `report-final`, so the extension is left out of the selection.
//
// The sheet is REMOUNTED per target by its caller (`key`), so the input's value
// is seeded from the prop rather than synced to it by an effect.

import * as React from 'react'

import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

export interface NameSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** Pre-filled value; the stem is selected on open. */
  initial: string
  submitLabel: string
  /** Return an error string to REFUSE the submit and show it inline; return
   *  null to accept. Runs on every keystroke so the button state is honest. */
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
  pending?: boolean
}

export function NameSheet({
  open,
  onOpenChange,
  title,
  description,
  initial,
  submitLabel,
  validate,
  onSubmit,
  pending,
}: NameSheetProps) {
  // Seeded from the prop, NOT synced by an effect: the caller REMOUNTS this
  // sheet per target (`key={…}`), so a fresh mount is the reset. Syncing state
  // to a prop in an effect is a cascading render the linter is right about.
  const [value, setValue] = React.useState(initial)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // DOM only — focus + STEM SELECTION. Renaming `report-final.md` almost
  // always means editing `report-final`, so the extension is left out.
  React.useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const dot = initial.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : initial.length)
    }, 60)
    return () => window.clearTimeout(t)
  }, [open, initial])

  const trimmed = value.trim()
  const error = trimmed ? (validate?.(trimmed) ?? null) : null
  const canSubmit = !!trimmed && !error && !pending

  const submit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <div className="flex items-center justify-end gap-2">
          {/* h-11: the shared `Button` default is h-9, which is below the
              44px floor this app holds every PHONE target to. The footer of a
              bottom sheet is the most thumb-reachable row on the screen and the
              worst place to be 8px short. */}
          <Button
            variant="outline"
            className="h-11"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button className="h-11" onClick={submit} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 p-4">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          aria-label={title}
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
