// "Who may use this tab" — the per-tab lending sheet.
//
// This is where the human hands an agent a tab they are ALREADY signed into, so
// it is the highest-consequence control in the workspace and it deliberately
// reuses the store's `GrantControl` rather than growing a second, subtly
// different grant UI. Same three tiers (this bot / this company / all agents),
// same `@company:<id>` keyspace, same hide-at-HQ rule, and — the part that
// matters — the same honesty rule: a grant that reaches a bot via a BROADER
// scope is read-only here, because revoking it from one bot would be a phantom
// revoke that changes nothing (shared-browser v1 §6.5).
//
// A `ResponsiveSheet`, so this is a drag-detent bottom sheet on a phone and a
// side panel on a mouse — one component, both shells, `pb-safe` handled there.
//
// EVERYTHING HERE STATES ITS EVIDENCE. The header repeats the tab's honest
// state (`tabState`), the origin list says an agent can never widen it, and the
// close-tab note says a delete is not a sign-out — because it is not.
import * as React from 'react'

import { Loader2, Pin, PinOff, Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ALL_AGENTS, companyGrantKey } from '@/lib/api/connectors'
import {
  activeGrantees,
  granteeLabel,
  tabHost,
  tabState,
  type BrowserTab,
} from '@/lib/api/browser'
import { GrantControl, type GrantScope } from '@/components/store/grant-control'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useCompanies } from '@/hooks/use-companies'
import { useUI } from '@/stores/ui-store'

export interface TabGrantSheetProps {
  tab: BrowserTab | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Candidate grantees (bot slugs). Injected so the bench needs no server. */
  bots: string[]
  onGrant: (grantee: string) => Promise<void>
  onRevoke: (grantee: string) => Promise<void>
  onPin: (pinned: boolean) => void
  /** Replace the origin allowlist. Omit to render it read-only. */
  onOrigins?: (origins: string[]) => void
  /** Offline bench only — see `ResponsiveSheet.contentTheme`. */
  contentTheme?: 'light' | 'dark'
}

export function TabGrantSheet({
  tab,
  open,
  onOpenChange,
  bots,
  onGrant,
  onRevoke,
  onPin,
  onOrigins,
  contentTheme,
}: TabGrantSheetProps) {
  const activeCompany = useUI((s) => s.activeCompany)
  const { companies } = useCompanies()
  const company =
    activeCompany !== null ? companies.find((c) => c.id === activeCompany) ?? null : null
  const [bot, setBot] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const granted = React.useMemo(() => (tab ? activeGrantees(tab) : []), [tab])

  // The SAME precedence the store uses: own > company > all. A bot that is
  // covered by `*` shows as `all`, which is what makes the shared-grant line
  // and the disabled per-bot revoke correct rather than merely tidy.
  const scope: GrantScope = React.useMemo(() => {
    if (granted.includes(ALL_AGENTS)) return 'all'
    if (company && granted.includes(companyGrantKey(company.id))) return 'company'
    if (bot && granted.includes(bot)) return 'bot'
    return null
  }, [granted, company, bot])

  const state = tab ? tabState(tab) : null

  const revoke = async (grantee: string) => {
    setBusy(grantee)
    try {
      await onRevoke(grantee)
    } finally {
      setBusy(null)
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Who may use this tab"
      description={
        tab
          ? `${tab.title || tabHost(tab.url)} — ${state?.detail ?? ''}`
          : 'No tab selected.'
      }
      className="sm:max-w-md"
      contentTheme={contentTheme}
    >
      {!tab ? null : (
        <div
          // `px-5` matches the sheet header's own gutter in BOTH shells — the
          // body slot ships without padding on purpose.
          className="flex flex-col gap-5 px-5 pb-5 pt-4"
          data-tab-sheet={tab.id}
        >
          {/* A tab that needs a sign-in refuses agent verbs server-side (409).
              Say so HERE too — an agent blocked by a state the human cannot see
              is the failure this whole surface exists to prevent. */}
          {state?.tone === 'needs-login' && (
            <p
              data-tab-needs-login=""
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground"
            >
              <span className="font-medium">Sign-in needed.</span> Agents granted this
              tab are refused until you take the wheel and sign in again — they will
              not read the login page and call it data.
            </p>
          )}

          {/* Pin — explicit, not a hidden long-press. */}
          <button
            type="button"
            onClick={() => onPin(!tab.pinned)}
            className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-3 text-left transition-colors hover:bg-secondary/60 motion-reduce:transition-none"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-foreground">
                {tab.pinned ? 'Pinned' : 'Not pinned'}
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {tab.pinned
                  ? 'Kept across restarts and never closed by the idle reaper.'
                  : 'An unpinned tab may be closed when the browser goes idle.'}
              </span>
            </span>
            {tab.pinned ? (
              <PinOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Pin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </button>

          {/* Pick the bot the "This bot" tier targets. Without one, only the
              company / all-agents tiers are reachable — GrantControl already
              disables its own bot tier when `botName` is null. */}
          {bots.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Bot
              </div>
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {bots.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setBot(bot === name ? null : name)}
                    aria-pressed={bot === name}
                    className={cn(
                      'min-h-11 shrink-0 rounded-xl border px-3 text-[12.5px] font-medium transition-colors motion-reduce:transition-none',
                      bot === name
                        ? 'border-transparent bg-secondary text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <GrantControl
            connectorId={`tab:${tab.id}`}
            botName={bot}
            scope={scope}
            resourceLabel="this tab"
            api={{ grant: onGrant, revoke: onRevoke }}
          />

          {/* Who holds it right now — the blast radius, spelled out. */}
          <div className="flex flex-col gap-2">
            <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Currently lent to
            </div>
            {granted.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                Nobody. This tab is yours alone until you lend it.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {granted.map((grantee) => (
                  <li
                    key={grantee}
                    data-tab-grantee={grantee}
                    className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border px-3"
                  >
                    <span className="min-w-0 truncate text-[12.5px] text-foreground">
                      {granteeLabel(grantee, company?.display_name)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void revoke(grantee)}
                      disabled={busy !== null}
                      className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 motion-reduce:transition-none"
                    >
                      {busy === grantee && (
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                      )}
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <OriginList tab={tab} onOrigins={onOrigins} />

          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Closing a tab does not sign you out — the cookies live in one shared
            browser profile. The only real eraser is resetting the profile, which
            signs out everything.
          </p>
        </div>
      )}
    </ResponsiveSheet>
  )
}

/** Where an agent may steer this tab. Widening it is a HUMAN act — the server
 *  refuses an agent `navigate` off-list with a 403, so this list is a real
 *  boundary and not a preference. */
function OriginList({
  tab,
  onOrigins,
}: {
  tab: BrowserTab
  onOrigins?: (origins: string[]) => void
}) {
  const [draft, setDraft] = React.useState('')
  const add = () => {
    const host = draft.trim().toLowerCase()
    if (!host || tab.origins.includes(host)) return
    onOrigins?.([...tab.origins, host])
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
        Agents may open
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {tab.origins.map((host) => (
          <li
            key={host}
            data-tab-origin={host}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 font-mono text-[11.5px] text-foreground"
          >
            {host}
            {onOrigins && (
              <button
                type="button"
                aria-label={`Remove ${host}`}
                onClick={() => onOrigins(tab.origins.filter((h) => h !== host))}
                className="relative text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </li>
        ))}
        {tab.origins.length === 0 && (
          <li className="text-[12.5px] text-muted-foreground">
            Nothing — an agent cannot navigate this tab anywhere at all.
          </li>
        )}
      </ul>
      {onOrigins && (
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="mail.example.com or .example.com"
            aria-label="Allow another host on this tab"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          <button
            type="button"
            onClick={add}
            aria-label="Allow this host"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
