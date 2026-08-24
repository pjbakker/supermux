// ConnectorHintPicker — "the bot should use these for this step".
//
// A HINT, and the copy says so: the bot is told to prefer these, and it may
// still choose others. Claiming otherwise would be claiming a guarantee the
// agent loop does not give.
//
// Two rules, both borrowed from the connector store because they were learned
// the hard way there:
//
//  * granted connectors come FIRST, each with the account it would use, so
//    "Gmail" is never ambiguous between two mailboxes;
//  * an ungranted connector is shown in its own group with a Grant… deep link,
//    never silently mixed in — and a disconnected or expired account never
//    renders as available. Dead connections look dead.

import * as React from 'react'
import { Check, ExternalLink, Plug } from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { useConnectors, useSessionConnectors } from '@/stores/connectors-store'
import type { ConnectorCard, SessionConnector } from '@/lib/api/connectors'

export interface ConnectorHintPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bot the step belongs to — whose grants decide the two groups. */
  session: string
  /** Currently hinted connector ids. */
  value: string[]
  onChange: (next: string[]) => void
  /** Offline bench: the grants and the catalog the live queries would return. */
  grantsOverride?: SessionConnector[]
  catalogOverride?: ConnectorCard[]
}

/** One offerable row: a connector, and the account it would actually use. */
export interface HintRow {
  id: string
  name: string
  /** "sander@acme.com", or null when the connector needs no account. */
  account: string | null
  granted: boolean
  /** The reason it cannot be used, if any — rendered, never hidden. */
  dead: string | null
}

/**
 * Split what this bot could be told to use into the two groups. PURE, so the
 * "never offer a dead account" rule is asserted directly.
 */
export function hintRows(
  grants: SessionConnector[],
  catalog: ConnectorCard[],
): { granted: HintRow[]; ungranted: HintRow[] } {
  const granted: HintRow[] = []
  const seen = new Set<string>()
  for (const g of grants) {
    if (!g.enabled) continue
    seen.add(g.connector_id)
    const card = g.card
    const accounts = card?.accounts ?? []
    const live = accounts.find(
      (a) => a.status === 'active' && a.health !== 'expired' && a.health !== 'error',
    )
    const broken = accounts.find((a) => !live && a)
    granted.push({
      id: g.connector_id,
      name: card?.display_name || g.connector_id,
      account: live?.account_label ?? broken?.account_label ?? null,
      granted: true,
      dead: live
        ? null
        : broken
          ? broken.status !== 'active'
            ? 'Disconnected'
            : 'Needs sign-in'
          : null,
    })
  }
  const ungranted: HintRow[] = catalog
    .filter((c) => !seen.has(c.id))
    .map((c) => ({ id: c.id, name: c.display_name || c.id, account: null, granted: false, dead: null }))
  return { granted, ungranted }
}

export function ConnectorHintPicker({
  open,
  onOpenChange,
  session,
  value,
  onChange,
  grantsOverride,
  catalogOverride,
}: ConnectorHintPickerProps) {
  const liveGrants = useSessionConnectors(grantsOverride ? null : session)
  const liveCatalog = useConnectors(catalogOverride ? { source: 'local' } : {})
  const grants = grantsOverride ?? liveGrants.data ?? []
  const catalog = catalogOverride ?? liveCatalog.data ?? []
  const { granted, ungranted } = React.useMemo(
    () => hintRows(grants, catalog),
    [grants, catalog],
  )

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Must use"
      description={`Tools ${session} should reach for at this step.`}
    >
      <div className="flex flex-col gap-4 pb-4">
        <p className="text-[12.5px] leading-snug text-muted-foreground">
          The bot is told to use these. It may still choose others.
        </p>

        {granted.length > 0 && (
          <Group title="Connected for this bot">
            {granted.map((r) => (
              <Row key={r.id} row={r} picked={value.includes(r.id)} onPick={() => toggle(r.id)} />
            ))}
          </Group>
        )}

        {granted.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            {session} has no connectors yet. Add one and it shows up here.
          </p>
        )}

        {ungranted.length > 0 && (
          <Group title="Not connected for this bot">
            {ungranted.map((r) => (
              <div
                key={r.id}
                className="flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1.5 opacity-70"
              >
                <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">
                  {r.name}
                </span>
                <Link
                  to="/store"
                  className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-secondary px-3 text-[12.5px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Grant…
                  <ExternalLink className="size-3" aria-hidden="true" />
                </Link>
              </div>
            ))}
          </Group>
        )}
      </div>
    </ResponsiveSheet>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Row({ row, picked, onPick }: { row: HintRow; picked: boolean; onPick: () => void }) {
  const usable = !row.dead
  return (
    <button
      type="button"
      onClick={usable ? onPick : undefined}
      aria-pressed={picked}
      disabled={!usable}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        usable ? 'hover:bg-secondary' : 'opacity-60',
      )}
    >
      <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-foreground">
          {row.name}
          {row.account && <span className="text-muted-foreground"> · {row.account}</span>}
        </span>
        {row.dead && (
          <span className="block text-[11.5px] text-amber-600 dark:text-amber-500">{row.dead}</span>
        )}
      </span>
      {picked && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
    </button>
  )
}
