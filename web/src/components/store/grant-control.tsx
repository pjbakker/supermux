// The per-bot grant control — the differentiator, shown not hidden.
//
// "Grant to → This bot · All agents", a segmented control that lands a grant on
// the exact scope (`POST /{id}/grant { session_name }` — a bot slug or the `*`
// all-agents sentinel), plus a Revoke. Reused on the card, the detail sheet, and
// the bot-panel Tools-tab row.
//
// Honest about a shared grant: when a connector is granted via `*`, the "This
// bot" side reads "via all agents" and per-bot revoke is disabled — you revoke
// the `*` grant globally, never phantom-revoke a shared one from one bot.
import * as React from 'react'
import { Check, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ALL_AGENTS, companyGrantKey } from '@/lib/api/connectors'
import { useConnectorActions } from '@/stores/connectors-store'
import { useUI } from '@/stores/ui-store'
import { useCompanies } from '@/hooks/use-companies'
import type { Company } from '@/lib/api'
import { CompanyMark } from '@/components/roster/company-mark'

export type GrantScope = 'bot' | 'company' | 'all' | null

/** Grant/revoke overrides, so ONE control can lend a connector *or* a workspace
 *  browser tab (shared-browser v1 §6.5). Absent ⇒ today's behaviour, byte for
 *  byte: `useConnectorActions()` against `connectorId`. Present ⇒ the same three
 *  tiers, the same honesty rule, a different resource underneath. */
export interface GrantApi {
  grant: (target: string) => Promise<void>
  revoke: (target: string) => Promise<void>
}

export function GrantControl({
  connectorId,
  botName,
  scope,
  onGranted,
  onRevoked,
  compact,
  accountRef,
  resourceLabel,
  api,
  companyOverride,
  allowAll = true,
  allowBot = true,
}: {
  connectorId: string
  /** The bot this control grants to. `null` = library view (only All agents). */
  botName: string | null
  /** Current grant state for this connector against this scope. */
  scope: GrantScope
  onGranted?: (target: string, restartHint: boolean) => void
  onRevoked?: (target: string) => void
  compact?: boolean
  /** Multi-account (Installed detail): pin grants to THIS account. When set, a
   *  grant routes through the account-aware `reconnect` path so the server binds
   *  the account's KEPT secret (the plain grant can't — the client never sees a
   *  secret_ref). Absent everywhere else, so the legacy behaviour is unchanged. */
  accountRef?: string | null
  /** What is being lent, for the shared-grant line ("this tab"). Defaults to the
   *  connector wording. */
  resourceLabel?: string
  /** Lend something that is NOT a connector (a browser tab). See [[GrantApi]]. */
  api?: GrantApi
  /** Which company the "This company" tier targets, when the RESOURCE has an
   *  owning company of its own. `undefined` (the default, and every connector
   *  call site) keeps today's behaviour: the currently-active UI company.
   *  `null` means the resource is HQ-owned, so there is no company tier at all
   *  — never the globally-active one, which the server would refuse. */
  companyOverride?: Company | null
  /** Offer the all-agents tier. `false` where `*` cannot be a legal target — a
   *  company-owned resource, since `*` resolves to NO company server-side. */
  allowAll?: boolean
  /** Offer the "This bot" tier. `false` where there is NO single-bot context to
   *  target — the shared browser is never opened "as" one bot, so a per-bot
   *  grant there is made by picking a bot from the roster, not by this tier. */
  allowBot?: boolean
}) {
  const actions = useConnectorActions()
  const [busy, setBusy] = React.useState<'bot' | 'company' | 'all' | 'revoke' | null>(null)

  // The company tier targets the CURRENTLY-ACTIVE company (the roster scope). It
  // only makes sense inside one company, so at HQ (`activeCompany === null`) the
  // tier is hidden — a grant to "this company" has no referent there.
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const inferred =
    activeCompany !== null ? companies.find((c) => c.id === activeCompany) ?? null : null
  // A resource that OWNS a company overrides the roster scope entirely: the
  // grant has to land in the resource's company or the server refuses it.
  const company = companyOverride !== undefined ? companyOverride : inferred
  const companyTarget = company ? companyGrantKey(company.id) : null

  const grantTo = async (which: 'bot' | 'company' | 'all') => {
    if (busy) return
    const target =
      which === 'all' ? ALL_AGENTS : which === 'company' ? companyTarget : botName
    if (!target) return
    setBusy(which)
    try {
      // Account-aware grant rides `reconnect` (server reuses the account's kept
      // secret); the legacy grant is used only when no account is in scope.
      // The override owns the whole write when present — no connector call is
      // made at all, so a tab grant can never touch `session_connectors`.
      if (api) {
        await api.grant(target)
        onGranted?.(target, false)
        return
      }
      const restart = accountRef
        ? await actions.reconnect(connectorId, accountRef, target)
        : await actions.grant(connectorId, target)
      onGranted?.(target, restart)
    } finally {
      setBusy(null)
    }
  }

  const revoke = async () => {
    if (busy) return
    const target =
      scope === 'all' ? ALL_AGENTS : scope === 'company' ? companyTarget : botName
    if (!target) return
    setBusy('revoke')
    try {
      if (api) await api.revoke(target)
      else await actions.revoke(connectorId, target)
      onRevoked?.(target)
    } finally {
      setBusy(null)
    }
  }

  // A grant reaching this bot via a broader scope (all-agents OR its company) is
  // read-only here — you revoke it from that scope, never phantom-revoke it from
  // one bot.
  const sharedGrant = scope === 'all' || scope === 'company'
  const sharedVia =
    scope === 'company' ? company?.display_name ?? 'this company' : 'all agents'

  return (
    <div className={cn('flex flex-col gap-2', compact && 'gap-1.5')}>
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
        Grant to
      </div>
      <div
        role="radiogroup"
        aria-label="Grant scope"
        className="inline-flex items-stretch gap-0.5 self-start rounded-xl bg-secondary p-1"
      >
        {allowBot && (
          <ScopeButton
            selected={scope === 'bot'}
            disabled={!botName || busy !== null}
            busy={busy === 'bot'}
            onClick={() => grantTo('bot')}
            label="This bot"
            sub={botName ?? undefined}
          />
        )}
        {company && (
          <ScopeButton
            selected={scope === 'company'}
            disabled={busy !== null}
            busy={busy === 'company'}
            onClick={() => grantTo('company')}
            label="This company"
            sub={company.display_name}
            mark={<CompanyMark slug={company.slug} name={company.display_name} logo={company} size={16} />}
          />
        )}
        {allowAll && (
          <ScopeButton
            selected={scope === 'all'}
            disabled={busy !== null}
            busy={busy === 'all'}
            onClick={() => grantTo('all')}
            label="All agents"
          />
        )}
      </div>

      {scope !== null && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {sharedGrant && botName ? (
            <span>
              Shared via <span className="font-medium text-foreground">{sharedVia}</span> — revoke it
              {resourceLabel
                ? ' from that scope to remove it everywhere.'
                : ' from the store to remove it everywhere.'}
            </span>
          ) : (
            <button
              type="button"
              onClick={revoke}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
            >
              {busy === 'revoke' && <Loader2 className="size-3 animate-spin" aria-hidden />}
              Revoke
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ScopeButton({
  selected,
  disabled,
  busy,
  onClick,
  label,
  sub,
  mark,
}: {
  selected: boolean
  disabled?: boolean
  busy?: boolean
  onClick: () => void
  label: string
  sub?: string
  /** Optional identity glyph (e.g. a `CompanyMark`), shown at rest in place of
   *  the selection check. */
  mark?: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors',
        selected
          ? 'bg-white text-foreground shadow-sm dark:bg-white/15'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-default opacity-60',
      )}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : selected ? (
        <Check className="size-3.5" aria-hidden />
      ) : mark ? (
        mark
      ) : null}
      <span className="flex flex-col items-start leading-none">
        <span>{label}</span>
        {sub && <span className="mt-0.5 max-w-[9ch] truncate text-[10px] text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}
