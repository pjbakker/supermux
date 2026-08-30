// `<SpacesGrid>` — the Files landing: HQ + one card per company.
//
// The top level of Files is WHO, not where (files v1 spec §4.1). Marks are the
// shared identity tiles reused verbatim (`<CompanyMark>` / `<HqMark>`) — the
// hue firewall means a company's colour here is the same colour it has in the
// roster and the switcher, and there is deliberately no Files-specific avatar.
//
// PRESENTATIONAL ON PURPOSE: every card is built by `spaceCards()` (pure, and
// unit-tested), so the honesty rules — bot counts, no invented recency — are
// pinned by tests instead of buried in JSX. This component only draws them.
//
// At 390px: two columns, 40px marks, one-line clamped activity, each card a
// ≥44px target, the grid padded with the shared safe-area utilities.

import { FolderOpen } from 'lucide-react'

import { cn } from '@/lib/utils'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import { EmptyStatePlaceholder } from '@/components/empty-state'
import { activityName, botLine, type SpaceCard } from './spaces'
import { relativeStamp } from '@/stores/files-activity-store'

export interface SpacesGridProps {
  cards: readonly SpaceCard[]
  /** The space the whole app is currently scoped to (`useUI().activeCompany`),
   *  so the landing shows where you already are instead of pretending every
   *  door is equally open. */
  activeCompany: number | null
  onOpen: (card: SpaceCard) => void
  /** Injected so the relative stamp is deterministic in tests. Omitted in the
   *  app: `relativeStamp` reads the clock itself (a plain module function —
   *  reading it during render would be impure). */
  now?: number
}

export function SpacesGrid({
  cards,
  activeCompany,
  onOpen,
  now,
}: SpacesGridProps) {
  if (cards.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyStatePlaceholder
          icon={<FolderOpen />}
          message="No spaces yet. Create a company to give your bots a shared drive."
        />
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul
        aria-label="Spaces"
        // 2 columns at 390px — the mark + two short lines fit a ~180px card
        // with room for a 44px tap target; wider viewports just get more
        // columns, never a different card.
        className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4"
      >
        {cards.map((card) => {
          const active = card.id === activeCompany
          return (
            <li key={card.key} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(card)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex min-h-[104px] w-full min-w-0 flex-col gap-2 rounded-xl border p-3 text-left transition-colors',
                  active
                    ? 'border-primary/60 bg-accent'
                    : 'border-border hover:bg-accent active:bg-accent',
                )}
              >
                {card.kind === 'hq' ? (
                  <HqMark size={40} />
                ) : (
                  <CompanyMark slug={card.slug} name={card.name} size={40} logo={card.logo} />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {card.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {botLine(card.bots)}
                  </span>
                  {/* The live line. Rendered ONLY for a space we have actually
                      observed a `files` frame for — otherwise an em dash, never
                      a fabricated "idle · 3d". Clamped to one line at 390px. */}
                  <span
                    className={cn(
                      'block truncate text-xs',
                      card.activity
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/50',
                    )}
                  >
                    {card.activity
                      ? `✎ ${activityName(card.activity.path)} · ${relativeStamp(card.activity.at, now)}`
                      : '—'}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
