// THE NEW-TAB PAGE — what `+` lands on, and what an empty workspace looks like.
//
// IT REPLACES A TRANSIENT FORM. `+` used to mount a one-shot compose input that
// vanished on submit, which meant the workspace had TWO places to type an
// address — one permanent and read-only, one temporary and the only one that
// worked. This page has none of its own: it points at the address bar above it,
// which is already focused by the time it renders. One mental model, one field.
//
// AND IT REPLACES A ROW INSERT. `+` no longer mints a tab. A row minted before
// anybody typed anything is the bookmark-not-a-page bug in miniature: it shows
// up in the rail, in the agent's tab list and in the reaper, having never been
// a page. The row is minted by the address, so an abandoned new-tab page leaves
// nothing behind.
//
// WHAT IT OFFERS is deliberately what this workspace HAS, not a link farm:
//   · pinned tabs as tiles — the ones worth keeping signed in, one tap to
//     switch (switch, never re-open: a second copy of a signed-in tab is the
//     thing the whole feature exists to avoid);
//   · the recently-used tabs under them, same rule;
//   · the hosts the tabs' `origins` already trust, as one-tap destinations —
//     these are the places where an agent can actually use the tab afterwards.
import * as React from 'react'

import { Globe, Pin } from 'lucide-react'

import { cn } from '@/lib/utils'
import { tabHost, tabState, type BrowserTab } from '@/lib/api/browser'
import { faviconTile, originOf, prettyHost } from '@/lib/browser/nav-state'

export interface NewTabPageProps {
  tabs: BrowserTab[]
  /** Open a NEW tab at this url (the row is minted here, not by `+`). */
  onOpen: (url: string) => void
  /** Switch to an existing tab — never a second copy of a signed-in page. */
  onSelect?: (id: string) => void
  /** Put the caret in the chrome's address bar. The page has no field of its
   *  own; this is the affordance that teaches where the one field lives. */
  onFocusAddress?: () => void
  /** origin → `data:` favicon, same memo the rail reads. */
  favicons?: Record<string, string>
  className?: string
}

export function NewTabPage({
  tabs,
  onOpen,
  onSelect,
  onFocusAddress,
  favicons,
  className,
}: NewTabPageProps) {
  const pinned = tabs.filter((t) => t.pinned).slice(0, 8)
  const recent = tabs.filter((t) => !t.pinned).slice(0, 6)
  const hosts = React.useMemo(() => {
    const seen: string[] = []
    for (const t of tabs) {
      for (const o of t.origins) {
        // A leading-dot suffix is a RULE, not a place: there is no page at
        // `https://.example`, so it is never offered as a destination.
        if (!o || o.startsWith('.') || seen.includes(o)) continue
        seen.push(o)
      }
    }
    // Anything already on screen as a tab tile would be a duplicate one-tap.
    const shown = new Set(tabs.map((t) => tabHost(t.url)))
    return seen.filter((h) => !shown.has(h)).slice(0, 6)
  }, [tabs])

  return (
    <div
      data-new-tab-page=""
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto p-6 text-center',
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3 pt-4">
        <Globe className="size-7 text-muted-foreground" aria-hidden />
        <p className="max-w-[42ch] text-[13px] leading-relaxed text-muted-foreground">
          One real browser you log into once. Type an address above, sign in, pin it
          — then lend that tab to the agents that need it.
        </p>
        {onFocusAddress && (
          <button
            type="button"
            onClick={onFocusAddress}
            data-new-tab-focus=""
            className="min-h-11 rounded-xl border border-border px-4 text-[12.5px] font-medium text-foreground hover:border-primary"
          >
            Type an address
          </button>
        )}
      </div>

      {pinned.length > 0 && (
        <Section label="Pinned" icon={Pin}>
          <div className="flex flex-wrap items-start justify-center gap-2">
            {pinned.map((t) => (
              <TabTile
                key={t.id}
                tab={t}
                favicon={favicons?.[originOf(t.url) ?? ''] ?? null}
                onClick={() => onSelect?.(t.id)}
              />
            ))}
          </div>
        </Section>
      )}

      {recent.length > 0 && (
        <Section label="Recent tabs">
          <div className="flex flex-wrap items-start justify-center gap-2">
            {recent.map((t) => (
              <TabTile
                key={t.id}
                tab={t}
                favicon={favicons?.[originOf(t.url) ?? ''] ?? null}
                onClick={() => onSelect?.(t.id)}
              />
            ))}
          </div>
        </Section>
      )}

      {hosts.length > 0 && (
        <Section label="Sites your agents may use">
          <div className="flex max-w-[40ch] flex-wrap items-center justify-center gap-2">
            {hosts.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => onOpen(`https://${h}`)}
                data-new-tab-host={h}
                className="min-h-11 max-w-[18ch] truncate rounded-xl border border-border px-3 text-[12.5px] text-foreground hover:border-primary"
              >
                {h}
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon?: typeof Pin
  children: React.ReactNode
}) {
  return (
    <section className="flex w-full max-w-[38rem] flex-col items-center gap-2">
      <h3 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="size-3" aria-hidden />}
        {label}
      </h3>
      {children}
    </section>
  )
}

/** One tab as a tile: the site's icon (or its hashed letter), its host, and its
 *  state as a dot — the same three facts the rail's chip carries, because a
 *  tile that hid the sign-in state would be the one place a stale tab looked
 *  healthy. */
function TabTile({
  tab,
  favicon,
  onClick,
}: {
  tab: BrowserTab
  favicon: string | null
  onClick: () => void
}) {
  const tile = faviconTile(tab.url)
  const state = tabState(tab)
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${tab.title || prettyHost(tab.url)} — ${state.detail}`}
      data-new-tab-tile={tab.id}
      className="flex w-[104px] flex-col items-center gap-1.5 rounded-xl border border-border p-2 hover:border-primary"
    >
      <span className="relative flex size-8 items-center justify-center">
        {favicon ? (
          <img src={favicon} alt="" aria-hidden className="size-6 rounded object-contain" />
        ) : (
          <span
            aria-hidden
            style={{ backgroundColor: `hsl(${tile.hue} 60% 45%)` }}
            className="flex size-6 items-center justify-center rounded text-[12px] font-bold leading-none text-white"
          >
            {tile.letter}
          </span>
        )}
        <span
          aria-hidden
          data-tile-tone={state.tone}
          className={cn(
            'absolute bottom-0 right-0 size-2 rounded-full ring-2 ring-background',
            state.tone === 'ok'
              ? 'bg-emerald-500'
              : state.tone === 'needs-login'
                ? 'bg-amber-500'
                : 'bg-slate-400',
          )}
        />
      </span>
      <span className="w-full truncate text-[11px] leading-tight text-muted-foreground">
        {prettyHost(tab.url)}
      </span>
    </button>
  )
}
