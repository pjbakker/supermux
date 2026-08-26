/**
 * `<DeleteCompanySheet>` — the DESTRUCTIVE, irreversible "Delete company" flow,
 * gated behind a strong TYPE-TO-CONFIRM. Deleting a company is not a per-row
 * archive: the server cascade tears down EVERYTHING the company owns — every
 * bot (the Main Assistant included; a running pane is KILLED, not refused), its
 * files root on disk, its group-chat history, its `@company` connector grants —
 * then the companies row. There is no undo, so this is deliberately NOT a
 * one-tap action.
 *
 * Reuses the app's canonical detail shell `<ResponsiveSheet>` (the same
 * Vaul drag-detent bottom sheet the create/switch flows use), so the destroy
 * flow feels like part of one system rather than a bolt-on `confirm()`. The
 * confirm idiom mirrors the "name what dies, then make the user type the name"
 * pattern: the sheet
 *   1. names the company (its live `<CompanyMark>` + display name),
 *   2. lists EXACTLY what the cascade removes — N teammate bots including the
 *      Main Assistant, all files under the company root, the group chat and its
 *      history — each as a concrete line, ending on "This cannot be undone",
 *   3. requires the owner to TYPE the company name verbatim to arm the
 *      destructive button (an accidental tap on a primed button still can't
 *      fire — the text gate is the real guard), and
 *   4. on success switches scope away to HQ and, when the cascade rode through
 *      any non-fatal problem, HOLDS OPEN on an honest result view naming each
 *      `warning` rather than swallowing it. A clean sweep just closes.
 *
 * The bot count is read live from the roster (`useSessions`, filtered to this
 * company) purely for the copy; the SERVER is authoritative — the result view
 * reports the actual `deleted_bots` it tore down, never the pre-count.
 */
import * as React from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { CompanyMark } from '@/components/roster/company-mark'
import { useDeleteCompany } from '@/hooks/use-companies'
import { useSessions } from '@/hooks/use-sessions'
import { SessionError, type DeleteCompanyResult } from '@/lib/api'

export function DeleteCompanySheet({
  open,
  onOpenChange,
  company,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  company: { id: number; slug: string; display_name: string }
  /** Called the instant the row is gone, with the server's cascade result. The
   *  switcher uses it to switch scope away to HQ. The sheet itself owns whether
   *  it then closes (clean sweep) or holds open on the warnings view. */
  onDeleted: (result: DeleteCompanyResult) => void
}) {
  const del = useDeleteCompany()
  const { sessions, isLoading } = useSessions()

  const [typed, setTyped] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<DeleteCompanyResult | null>(null)

  // Live bot count for the copy only — every session scoped to this company,
  // the Main Assistant among them. `undefined` while the roster is still
  // loading so the copy degrades to "every bot" rather than a wrong "0".
  const botCount = React.useMemo(() => {
    if (isLoading) return undefined
    return sessions.filter((s) => s.company_id === company.id).length
  }, [sessions, isLoading, company.id])

  // Reset every field on the open TRANSITION (the "adjust state when a prop
  // changes" pattern — one fewer commit than an effect, no set-state-in-effect).
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setTyped('')
      setError(null)
      setResult(null)
    }
  }

  const target = company.display_name.trim()
  // The text gate: an exact, trimmed match of the company NAME arms the button.
  // Case-sensitive on purpose — typing the name is a deliberate act, not a
  // fuzzy nicety, and a company can legitimately differ only by case.
  const armed = typed.trim() === target && target.length > 0 && !del.isPending

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!armed) return
    setError(null)
    try {
      const res = await del.mutateAsync(company.id)
      // Row is gone — hand the result up so scope leaves this company at once.
      onDeleted(res)
      if (res.warnings.length > 0) {
        // Rode through non-fatal problems — hold open and name them honestly.
        setResult(res)
      } else {
        onOpenChange(false)
      }
    } catch (err) {
      if (err instanceof SessionError && err.status === 404) {
        // Already gone (a concurrent delete, or a member who never had it).
        // Treat as done so the UI doesn't dangle on a company that isn't there.
        setError('That company is already gone.')
      } else if (err instanceof SessionError && err.status === 0) {
        setError('Can’t reach supermux-server. Check it’s running, then try again.')
      } else if (err instanceof SessionError && err.status === 403) {
        setError('Only an owner or admin can delete a company.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not delete the company.')
      }
    }
  }

  // ── Result view: the cascade removed the row but flagged something ──────────
  if (result) {
    return (
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={`Deleted ${company.display_name}`}
        description="The company is gone, but a few items need a look."
        footer={
          <div className="flex items-center justify-end">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        }
      >
        <div className="space-y-4 px-5 py-5">
          <p className="text-sm text-muted-foreground">
            Removed {result.deleted_bots.length}{' '}
            {result.deleted_bots.length === 1 ? 'bot' : 'bots'} and the company
            row. These couldn’t be fully cleaned up and may need a manual sweep:
          </p>
          <ul className="space-y-1.5">
            {result.warnings.map((w, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-foreground"
              >
                <AlertTriangle
                  size={15}
                  className="mt-0.5 shrink-0 text-destructive"
                  aria-hidden
                />
                <span className="min-w-0 break-words">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      </ResponsiveSheet>
    )
  }

  // ── Arm view: name what dies, then require typing the name ──────────────────
  const botsLine =
    botCount === undefined
      ? 'Every teammate bot, including the Main Assistant'
      : botCount === 1
        ? 'Its 1 teammate bot (the Main Assistant)'
        : `All ${botCount} teammate bots, including the Main Assistant`

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Delete company"
      description="This removes the company and everything in it. It can’t be undone."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="delete-company-form"
            variant="destructive"
            disabled={!armed}
            style={{
              // The sheet portals to `document.body`, outside `[data-grok]`,
              // where the bare token can resolve to nothing — supply the same
              // hard fallbacks the create CTA uses so the danger fill never
              // drops to a colourless button.
              background: 'var(--destructive, #ff3b30)',
              color: 'var(--destructive-foreground, #fff)',
            }}
          >
            {del.isPending ? 'Deleting…' : 'Delete company'}
          </Button>
        </div>
      }
    >
      <form id="delete-company-form" onSubmit={submit} className="px-5 py-5">
        {/* Identity — the company being destroyed, unmistakable. */}
        <div className="flex items-center gap-3">
          <CompanyMark
            slug={company.slug}
            name={company.display_name}
            size={40}
            className="grok-identity"
          />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-foreground">
              {company.display_name}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {company.slug}
            </p>
          </div>
        </div>

        {/* Exactly what the cascade removes — concrete lines, danger-tinted. */}
        <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle size={15} className="shrink-0" aria-hidden />
            This permanently deletes:
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-foreground">
            <li className="flex gap-2">
              <span aria-hidden className="text-destructive">
                •
              </span>
              <span>{botsLine} — running bots are stopped first</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-destructive">
                •
              </span>
              <span>All of the company’s files</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-destructive">
                •
              </span>
              <span>The group chat and its whole history</span>
            </li>
          </ul>
          <p className="mt-2.5 text-xs font-medium text-destructive">
            This cannot be undone.
          </p>
        </div>

        {/* The text gate — type the name verbatim to arm the button. */}
        <div className="mt-5 space-y-1.5">
          <label
            htmlFor="delete-company-confirm"
            className="block text-sm text-foreground"
          >
            Type{' '}
            <span className="font-mono font-medium text-foreground">
              {company.display_name}
            </span>{' '}
            to confirm
          </label>
          <Input
            id="delete-company-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={company.display_name}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={typed.length > 0 && !armed && !del.isPending}
          />
          {error && <p className="pt-1 text-sm text-destructive">{error}</p>}
        </div>
      </form>
    </ResponsiveSheet>
  )
}

export default DeleteCompanySheet
