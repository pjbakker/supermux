/**
 * `<MoveToCompanySheet>` — move a bot between companies (bot-move, migration
 * 0032), the web half of `POST /api/sessions/{name}/company`.
 *
 * One `<ResponsiveSheet>` (Vaul bottom-sheet on touch · shadcn side-panel on
 * desktop — the app's canonical detail shell, same as create-company), three
 * phases:
 *   1. `pick`    — the shared `<CompanyPicker>` destination list, the bot's
 *                  CURRENT company excluded (a bot can't be moved in place).
 *   2. `confirm` — names WHAT MOVES (files → new root, connector/tab grants,
 *                  group chat) and WHAT MAY BREAK (inherited old-company grants,
 *                  old chat history), plus the "restart required" note. The move
 *                  is destructive-adjacent (revokes leaking grants), so it is
 *                  always behind this explicit confirm.
 *   3. `done`    — the honest server receipt: `warnings[]` shown verbatim (they
 *                  already list the dropped grants + dead tabs by name), with a
 *                  Restart action so the deferred confinement/cwd apply now.
 *
 * The server is FS-first + a single atomic DB tx; the mutation invalidates the
 * `['sessions']` + `['companies']` caches so the moved tile re-homes on its own.
 * Mobile-first: every row ≥44px, no fixed widths, copy wraps — nothing clips at
 * 390px.
 */
import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  FolderInput,
  MessageSquare,
  Plug,
  RotateCcw,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { CompanyPicker } from '@/components/roster/company-picker'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import { useCompanies } from '@/hooks/use-companies'
import { useMoveSessionCompany } from '@/hooks/use-move-session-company'
import { useSessionActions } from '@/hooks/use-session-actions'
import {
  displayLabel,
  type ApiSession,
  type MoveCompanyResult,
} from '@/lib/api/sessions'

type Phase = 'pick' | 'confirm' | 'done'

export function MoveToCompanySheet({
  open,
  onOpenChange,
  session,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The bot to move — its slug identity, label, and current company scope. */
  session: Pick<ApiSession, 'name' | 'display_name' | 'company_id'>
}) {
  const { companies } = useCompanies()
  const move = useMoveSessionCompany()
  const { restart } = useSessionActions(session.name)

  const label = displayLabel(session)
  const currentCid = session.company_id ?? null

  const [phase, setPhase] = React.useState<Phase>('pick')
  // The chosen destination — `null` = HQ, a number = that company. `undefined`
  // until a row is picked.
  const [dest, setDest] = React.useState<number | null | undefined>(undefined)
  const [result, setResult] = React.useState<MoveCompanyResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // Reset to the picker each time the sheet opens fresh (open-transition pattern,
  // no effect — same idiom as create-company-sheet).
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPhase('pick')
      setDest(undefined)
      setResult(null)
      setError(null)
    }
  }

  const destCompany =
    dest == null ? null : (companies.find((c) => c.id === dest) ?? null)
  const destLabel = destCompany ? destCompany.display_name : 'HQ'
  const oldCompany =
    currentCid == null
      ? null
      : (companies.find((c) => c.id === currentCid) ?? null)

  const onPick = (id: number | null) => {
    setDest(id)
    setError(null)
    setPhase('confirm')
  }

  const onConfirm = async () => {
    if (dest === undefined) return
    setError(null)
    try {
      const res = await move.mutateAsync({ name: session.name, companyId: dest })
      setResult(res)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed.')
    }
  }

  // ── What moves / what may break — honest, direction-aware bullets (§5) ────────
  const moves: string[] = [
    destCompany
      ? `Files move to ${destLabel}'s folder.`
      : 'Files move to the HQ home folder.',
    destCompany
      ? `Connector & browser-tab access re-scope to ${destLabel}.`
      : 'Connector & browser-tab access drop company scoping.',
    destCompany && oldCompany
      ? `Joins the ${destLabel} group chat, leaves #${oldCompany.slug}.`
      : destCompany
        ? `Joins the ${destLabel} group chat.`
        : oldCompany
          ? `Leaves the #${oldCompany.slug} group chat.`
          : 'Group-chat membership re-derives.',
  ]

  const breaks: string[] = []
  if (oldCompany) {
    breaks.push(
      `Inherited ${oldCompany.display_name} connectors & tab grants stop applying; own-slug grants that leaked its credentials are revoked.`,
    )
    breaks.push('Old group-chat history stays in the old channel.')
  }
  if (destCompany && !oldCompany) {
    breaks.push(`This bot becomes confined to ${destLabel} on restart.`)
  }
  if (!destCompany) {
    breaks.push('Confinement drops on restart.')
  }

  const title =
    phase === 'done' ? `Moved ${label}` : `Move ${label}`
  const description =
    phase === 'pick'
      ? 'Choose a destination company'
      : phase === 'confirm'
        ? `to ${destLabel}`
        : undefined

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
    >
      {phase === 'pick' && (
        <div role="menu" aria-label="Move destination" className="flex flex-col gap-0.5 px-2 py-2">
          <CompanyPicker
            variant="sheet"
            companies={companies}
            onPick={onPick}
            excludeId={currentCid}
          />
        </div>
      )}

      {phase === 'confirm' && (
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Destination identity */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-3.5 py-3">
            {destCompany ? (
              <CompanyMark
                slug={destCompany.slug}
                name={destCompany.display_name}
                size={32}
                className="shrink-0"
                logo={destCompany}
              />
            ) : (
              <HqMark size={32} />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-semibold text-foreground">
                {destLabel}
              </span>
              <span className="truncate text-[12.5px] text-muted-foreground">
                {destCompany ? destCompany.slug : 'PA · tech-admin · sees everything'}
              </span>
            </div>
          </div>

          {/* What moves */}
          <ul className="flex flex-col gap-2.5 text-[13.5px] text-foreground">
            {moves.map((line, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>
                  {i === 0 ? (
                    <FolderInput className="size-4" />
                  ) : i === 1 ? (
                    <Plug className="size-4" />
                  ) : (
                    <MessageSquare className="size-4" />
                  )}
                </span>
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>

          {/* What may break */}
          {breaks.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3">
              <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-amber-600 dark:text-amber-500">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                May break
              </div>
              <ul className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
                {breaks.map((line, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span aria-hidden className="mt-1 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Restart note — always true for a real move */}
          <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
            <RotateCcw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium text-foreground">Restart required.</span>{' '}
              Confinement and the working directory apply on the next start.
            </span>
          </p>

          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPhase('pick')}
              disabled={move.isPending}
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </Button>
            <Button size="sm" onClick={() => void onConfirm()} disabled={move.isPending}>
              {move.isPending ? 'Moving…' : `Move to ${destLabel}`}
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* The honest receipt — server `warnings[]`, verbatim (they already
              name the dropped grants + dead tabs). Nothing here is silent. */}
          <ul className="flex flex-col gap-2 text-[13px] text-foreground">
            {result.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>

          {result.restart_required && (
            <div className="rounded-xl border border-border bg-muted/30 px-3.5 py-3">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                <RotateCcw className="size-3.5 shrink-0" aria-hidden />
                Restart to apply confinement + working directory
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                The live pane keeps its old folder until it restarts.
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
            {result.restart_required && (
              <Button
                size="sm"
                onClick={() => {
                  void restart()
                  onOpenChange(false)
                }}
              >
                <RotateCcw className="size-4" aria-hidden />
                Restart now
              </Button>
            )}
          </div>
        </div>
      )}
    </ResponsiveSheet>
  )
}
