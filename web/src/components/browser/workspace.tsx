// The shared-browser WORKSPACE — the human's persistent browser, on one route.
//
//   ┌─ /browser ────────────────────────────┐
//   │ [◀ tab strip — the only overflow  +▶] │  the rail (tab-strip.tsx)
//   │ ┌───────────────────────────────────┐ │
//   │ │ 🔒 example.com/inbox          ⋯   │ │  where the tab actually is
//   │ │ ◉ Watch  ○ Drive      2 agents    │ │  who holds the wheel
//   │ ├───────────────────────────────────┤ │
//   │ │        <TakeoverPanel/>           │ │  reused verbatim, tab subject
//   │ └───────────────────────────────────┘ │
//   └───────────────────────────────────────┘
//
// WATCH IS THE DEFAULT, AND THAT IS THE POINT. The tab socket attaches
// watch-first (`/ws/browser/tab/{id}`): frames flow, input is refused until the
// human presses Drive. Without that, merely LOOKING at a tab would silently
// block every agent granted on it — the one footgun a workspace surface would
// hit constantly. Drive sends `take_over`, Watch hands it straight back.
//
// A DEHYDRATED TAB IS NOT MOUNTED. The server refuses to rehydrate from a
// takeover socket on purpose ("a takeover takes over something" — it will not
// let a viewer spawn chrome, nor present a freshly-opened page as if it were
// what was there). So an asleep tab renders an honest card instead of a canvas
// that would sit black behind a 4404.
//
// PRESENTATIONAL ON PURPOSE. Every verb is a prop, so `/browser` wires the live
// hooks and `/dev/browser-workspace` wires fixtures — the same component, and
// the bench cannot drift from the product.
import * as React from 'react'

import { Globe, Lock, MoreHorizontal, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  activeGrantees,
  isSecure,
  normalizeUrl,
  tabHost,
  tabState,
  type BrowserTab,
} from '@/lib/api/browser'
import type { TakeoverOptions } from '@/lib/browser/takeover-socket'
import {
  TakeoverPanel,
  type TakeoverControls,
} from '@/components/browser/takeover-panel'
import { TabStrip } from '@/components/browser/tab-strip'
import { TabGrantSheet } from '@/components/browser/tab-grant-sheet'

/** The state line is tinted by tone for the same reason the dot is: an expired
 *  tab that reads in the same grey as a healthy one is a state nobody notices. */
const STATE_TINT: Record<string, string> = {
  ok: 'text-muted-foreground',
  'needs-login': 'text-amber-600 dark:text-amber-500',
  dehydrated: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
}

export interface BrowserWorkspaceProps {
  tabs: BrowserTab[]
  activeId: string | null
  onActivate: (id: string) => void
  /** Mint a tab at this URL. The page opens lazily, on first use. */
  onNew: (url: string) => void
  onClose: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onGrant: (id: string, grantee: string) => Promise<void>
  onRevoke: (id: string, grantee: string) => Promise<void>
  onOrigins?: (id: string, origins: string[]) => void
  /** Candidate grantees for the sheet's "This bot" tier. */
  bots: string[]
  /** Injected for the bench; production passes nothing. */
  panelOptions?: TakeoverOptions
  /** Bench only: mount the live panel even for an asleep tab, so the offline
   *  rig can screenshot the viewport with a fake socket. */
  forceLive?: boolean
  /** Offline bench only — see `ResponsiveSheet.contentTheme`. */
  contentTheme?: 'light' | 'dark'
  className?: string
}

export function BrowserWorkspace({
  tabs,
  activeId,
  onActivate,
  onNew,
  onClose,
  onPin,
  onGrant,
  onRevoke,
  onOrigins,
  bots,
  panelOptions,
  forceLive,
  contentTheme,
  className,
}: BrowserWorkspaceProps) {
  // The live socket's wheel verbs, published by the panel while it is mounted.
  // Read only from event handlers (a Watch/Drive tap), never during render.
  const ctl = React.useRef<TakeoverControls | null>(null)
  const [sheetFor, setSheetFor] = React.useState<string | null>(null)
  const [composing, setComposing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const composeRef = React.useRef<HTMLInputElement | null>(null)

  // Focus the new-tab box when it appears. A ref + effect rather than
  // `autoFocus`, which fires on mount regardless of why the node appeared.
  React.useEffect(() => {
    if (composing) composeRef.current?.focus()
  }, [composing])

  const active = tabs.find((t) => t.id === activeId) ?? null
  const sheetTab = tabs.find((t) => t.id === sheetFor) ?? null

  const openNew = () => {
    const url = normalizeUrl(draft)
    if (!url) return
    onNew(url)
    setDraft('')
    setComposing(false)
  }

  return (
    <div
      data-browser-workspace=""
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onSelect={onActivate}
        onClose={onClose}
        onMenu={setSheetFor}
        onNew={() => setComposing(true)}
      />

      {composing && (
        <div
          data-tab-compose=""
          className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-3 py-2"
        >
          <input
            ref={composeRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                openNew()
              }
              if (e.key === 'Escape') setComposing(false)
            }}
            placeholder="https://mail.example.com"
            aria-label="URL for the new tab"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          <button
            type="button"
            onClick={openNew}
            className="min-h-11 shrink-0 rounded-xl bg-primary px-4 text-[12.5px] font-medium text-primary-foreground"
          >
            Open
          </button>
        </div>
      )}

      {!active ? (
        <EmptyState onNew={() => setComposing(true)} />
      ) : active.live || forceLive ? (
        <TakeoverPanel
          subject={{ kind: 'tab', id: active.id }}
          options={panelOptions}
          controlsRef={ctl}
          className="min-h-0 flex-1"
          renderHeader={(head) => (
            <TabHeader
              tab={active}
              url={head.snapshot.url || active.url}
              driving={head.driving}
              canDrive={head.snapshot.state === 'live'}
              onWatch={() => ctl.current?.handBack()}
              onDrive={() => ctl.current?.takeOver()}
              onMenu={() => setSheetFor(active.id)}
            />
          )}
        />
      ) : (
        <AsleepState tab={active} onMenu={() => setSheetFor(active.id)} />
      )}

      <TabGrantSheet
        tab={sheetTab}
        open={sheetFor !== null}
        onOpenChange={(o) => setSheetFor(o ? sheetFor : null)}
        bots={bots}
        onGrant={(g) => (sheetTab ? onGrant(sheetTab.id, g) : Promise.resolve())}
        onRevoke={(g) => (sheetTab ? onRevoke(sheetTab.id, g) : Promise.resolve())}
        onPin={(pinned) => sheetTab && onPin(sheetTab.id, pinned)}
        onOrigins={
          onOrigins && sheetTab ? (origins) => onOrigins(sheetTab.id, origins) : undefined
        }
        contentTheme={contentTheme}
      />
    </div>
  )
}

/** The panel's chrome, replaced: where the tab IS, and who holds the wheel.
 *
 *  Two rows rather than one, because at 390px a URL, a two-state control and a
 *  menu on one line means all three get squeezed. Row 1 truncates the URL (it
 *  is `min-w-0`, so it shrinks instead of pushing the row wide); row 2 carries
 *  the Watch/Drive pair at full 44px and the grantee count. */
function TabHeader({
  tab,
  url,
  driving,
  canDrive,
  onWatch,
  onDrive,
  onMenu,
}: {
  tab: BrowserTab
  url: string
  driving: boolean
  canDrive: boolean
  onWatch: () => void
  onDrive: () => void
  onMenu: () => void
}) {
  const state = tabState(tab)
  const lent = activeGrantees(tab).length
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {isSecure(url) ? (
          <Lock className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
        ) : (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground"
          title={url}
          data-tab-url
        >
          {url || '—'}
        </span>
        <button
          type="button"
          onClick={onMenu}
          aria-label="Tab settings and sharing"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {/* Watch / Drive. Watch is not "off" — frames keep flowing; it is the
            state in which the agent still owns the wheel. */}
        <div
          role="radiogroup"
          aria-label="Who is driving"
          data-drive-mode={driving ? 'human' : 'agent'}
          className="inline-flex items-stretch gap-0.5 rounded-xl bg-secondary p-1"
        >
          <DriveButton selected={!driving} label="Watch" onClick={onWatch} />
          <DriveButton
            selected={driving}
            label="Drive"
            disabled={!canDrive}
            onClick={onDrive}
          />
        </div>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={onMenu}
          data-tab-lent={lent}
          className="relative inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-[11.5px] text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground"
        >
          <Users className="size-3.5" aria-hidden />
          {lent === 0 ? 'Not lent' : `${lent} ${lent === 1 ? 'agent' : 'agents'}`}
        </button>
      </div>
      {/* The state gets a row of its own rather than a share of row 2: at 390px
          the Watch/Drive pair and the grantee count already own that line, and a
          truncated "Signed in · verifi…" is the bare green dot §7.3 forbids —
          the age IS the evidence, so it must not be the half that is cut. */}
      <p
        data-tab-state={state.tone}
        className={cn('min-w-0 truncate text-[11.5px]', STATE_TINT[state.tone])}
      >
        {state.detail}
      </p>
    </header>
  )
}

function DriveButton({
  selected,
  label,
  disabled,
  onClick,
}: {
  selected: boolean
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-9 items-center rounded-lg px-3 text-[12.5px] font-medium transition-colors motion-reduce:transition-none',
        selected
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-default opacity-60',
      )}
    >
      {label}
    </button>
  )
}

/** No tabs at all — the first-run surface. */
function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Globe className="size-7 text-muted-foreground" aria-hidden />
      <p className="max-w-[42ch] text-[13px] leading-relaxed text-muted-foreground">
        One real browser you log into once. Open a tab, sign in, pin it — then lend
        that tab to the agents that need it.
      </p>
      <button
        type="button"
        onClick={onNew}
        className="min-h-11 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground"
      >
        New tab
      </button>
    </div>
  )
}

/** Dehydrated: the row is here, the page is not. Says exactly that, and does
 *  not offer a button that would be a lie — nothing on the human's API can
 *  rehydrate a tab; the next agent verb (or a keep-alive) does. */
function AsleepState({ tab, onMenu }: { tab: BrowserTab; onMenu: () => void }) {
  const state = tabState(tab)
  return (
    <div
      data-tab-asleep={tab.id}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <span className="text-[13px] font-medium text-foreground">
        {tab.title || tabHost(tab.url)} — {state.label}
      </span>
      <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-muted-foreground">
        {state.detail}
      </p>
      <button
        type="button"
        onClick={onMenu}
        className="min-h-11 rounded-xl border border-border px-4 text-[12.5px] font-medium text-foreground"
      >
        Tab settings
      </button>
    </div>
  )
}
