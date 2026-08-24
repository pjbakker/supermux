// The shared-browser WORKSPACE — the human's persistent browser, on one route.
//
//   ┌─ /browser ────────────────────────────┐
//   │ [◀ tab strip — the only overflow  +▶] │  the rail (tab-strip.tsx)
//   │ ┌───────────────────────────────────┐ │
//   │ │ 🔒 example.com/inbox        ×  ⋯  │ │  the CHROME (browser-chrome.tsx)
//   │ │ ⟳ ⤢          [ Watch | Drive ] 2👤│ │  always mounted, never a lie
//   │ │ Signed in · verified 6 min ago    │ │
//   │ ├───────────────────────────────────┤ │
//   │ │  <TakeoverPanel/> · Asleep · New   │ │  the VIEWPORT — the only part
//   │ └───────────────────────────────────┘ │  that changes
//   └───────────────────────────────────────┘
//
// THE CHROME IS A SIBLING OF THE VIEWPORT, NOT ITS HEADER. It used to live in
// the takeover panel's `renderHeader` slot, which meant it existed only while a
// tab was live — and since nothing on the human's API could make a tab live,
// the address bar was unreachable from a cold start by construction. Now the
// panel publishes its snapshot OUT through `<PanelBridge/>` (a render-slot
// component that draws nothing and reports the live url / driving flag in an
// effect), and the chrome above reads it. One chrome, three viewport states.
//
// WATCH IS THE DEFAULT, AND THAT IS THE POINT. The tab socket attaches
// watch-first (`/ws/browser/tab/{id}`): frames flow, input is refused until the
// human presses Drive. Without that, merely LOOKING at a tab would silently
// block every agent granted on it — the one footgun a workspace surface would
// hit constantly. Drive sends `take_over`, Watch hands it straight back.
//
// A DEHYDRATED TAB IS STILL NOT MOUNTED — the server refuses to rehydrate from
// a takeover socket on purpose ("a takeover takes over something"). But the
// dead end is gone: `POST …/open` is a human verb now, so the asleep card
// offers **Wake tab**, and Enter in the address bar wakes-and-navigates in one
// call. The honesty is kept; the cul-de-sac is not.
//
// PRESENTATIONAL ON PURPOSE. Every verb is a prop, so `/browser` wires the live
// hooks and `/dev/browser-workspace` wires fixtures — the same component, and
// the bench cannot drift from the product.
import * as React from 'react'

import { Globe, Power } from 'lucide-react'

import { cn } from '@/lib/utils'
import { tabHost, tabState, type BrowserTab, type GrantCandidate } from '@/lib/api/browser'
import type { TakeoverOptions, TakeoverSnapshot } from '@/lib/browser/takeover-socket'
import {
  TakeoverPanel,
  type TakeoverControls,
  type TakeoverHeaderState,
} from '@/components/browser/takeover-panel'
import { BrowserChrome } from '@/components/browser/browser-chrome'
import { TabStrip } from '@/components/browser/tab-strip'
import { TabGrantSheet } from '@/components/browser/tab-grant-sheet'

/** What the live socket knows that the tab row does not. Flat values only —
 *  the snapshot object itself is re-created every frame, and storing it would
 *  re-render the chrome sixty times a second. */
interface PanelHead {
  url: string
  driving: boolean
  state: TakeoverSnapshot['state']
}

export interface BrowserWorkspaceProps {
  tabs: BrowserTab[]
  activeId: string | null
  onActivate: (id: string) => void
  /** Mint a tab AND open it (`POST /api/browser/tabs?open=true`). */
  onNew: (url: string) => void
  /** Navigate the active tab — wakes it first if it is asleep. Absent = the
   *  host has no navigate verb, and the omnibox falls back to minting a tab. */
  onNavigate?: (id: string, url: string) => void
  /** Wake a dehydrated tab where it stands (`POST …/open`). */
  onWake?: (id: string) => void
  /** Close the PAGE, keep the tab (`POST …/close`) — the inverse of wake, and
   *  a different act from `onClose`, which drops the row. */
  onSleep?: (id: string) => void
  onClose: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
  onGrant: (id: string, grantee: string) => Promise<unknown>
  onRevoke: (id: string, grantee: string) => Promise<unknown>
  onOrigins?: (id: string, origins: string[]) => void
  /** A workspace mutation is in flight — drives the chrome's loading hairline
   *  and the asleep card's "Waking…". */
  busy?: boolean
  /** Candidate grantees WITH their company — the sheet offers only the ones the
   *  active tab's company containment will accept. */
  bots: GrantCandidate[]
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
  onNavigate,
  onWake,
  onSleep,
  onClose,
  onPin,
  onGrant,
  onRevoke,
  onOrigins,
  busy,
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
  const [head, setHead] = React.useState<PanelHead | null>(null)
  // `+` does not mint a row up front (that is how the old flow ended up with
  // bookmarks nobody opened). It shows the new-tab page and puts the caret in
  // the address bar; the row is minted by the address the human then types.
  const [newTab, setNewTab] = React.useState(false)
  const [focusKey, setFocusKey] = React.useState(0)

  const chosen = tabs.find((t) => t.id === activeId) ?? null
  const active = newTab ? null : chosen
  const sheetTab = tabs.find((t) => t.id === sheetFor) ?? null
  const live = !!active && (active.live || !!forceLive)
  // The live page's own url outranks the row's: an agent that navigated three
  // pages deep must not leave the human's address bar showing where the tab
  // STARTED. Falls back to the row when nothing is attached yet.
  const url = (live && head?.url) || active?.url || ''

  /** Enter in the omnibox. With a tab: navigate it (waking it if need be) —
   *  browser semantics, the current tab goes there. Without one: mint a tab at
   *  that address, already open. */
  const go = (dest: string) => {
    setNewTab(false)
    if (active && onNavigate) onNavigate(active.id, dest)
    else onNew(dest)
  }

  return (
    <div
      data-browser-workspace=""
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      <TabStrip
        tabs={tabs}
        activeId={newTab ? null : activeId}
        onSelect={(id) => {
          setNewTab(false)
          onActivate(id)
        }}
        onClose={onClose}
        onMenu={setSheetFor}
        // `+` no longer opens a transient form: it shows the new-tab page and
        // puts the caret in the one address bar there has ever been.
        onNew={() => {
          setNewTab(true)
          setFocusKey((n) => n + 1)
        }}
      />

      <BrowserChrome
        tab={active}
        url={url}
        live={live}
        driving={head?.driving ?? false}
        canDrive={head?.state === 'live'}
        busy={busy}
        focusKey={focusKey}
        onNavigate={go}
        onWake={() => active && onWake?.(active.id)}
        onSleep={onSleep && active ? () => onSleep(active.id) : undefined}
        onReload={() => active && url && onNavigate?.(active.id, url)}
        onResync={() => ctl.current?.resync()}
        onWatch={() => ctl.current?.handBack()}
        onDrive={() => ctl.current?.takeOver()}
        onMenu={() => active && setSheetFor(active.id)}
      />

      {!active ? (
        <NewTabPage tabs={tabs} onOpen={(u) => onNew(u)} />
      ) : live ? (
        <TakeoverPanel
          // KEYED BY TAB. A tab switch is a different page, so the panel starts
          // over: a fresh canvas (never the previous tab's pixels under this
          // tab's address bar) and a fresh snapshot, so the chrome goes back to
          // "Connecting…" and Drive is disabled until THIS tab's socket is live
          // — instead of inheriting the tab we just left.
          key={active.id}
          subject={{ kind: 'tab', id: active.id }}
          options={panelOptions}
          controlsRef={ctl}
          className="min-h-0 flex-1"
          renderHeader={(state) => <PanelBridge head={state} onChange={setHead} />}
        />
      ) : (
        <AsleepState
          tab={active}
          waking={!!busy}
          onWake={onWake ? () => onWake(active.id) : undefined}
          onMenu={() => setSheetFor(active.id)}
        />
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

/** Draws nothing; carries the socket's truth OUT of the panel's header slot.
 *
 *  The panel hands its snapshot to `renderHeader` during ITS render, so the
 *  hoisted chrome cannot read it directly without a setState-in-render. This
 *  child reports in an EFFECT instead, keyed on the three flat values the
 *  chrome actually uses — so a 60fps frame stream produces no re-renders at
 *  all, and only a real navigation or a wheel change reaches the chrome. */
function PanelBridge({
  head,
  onChange,
}: {
  head: TakeoverHeaderState
  onChange: (head: PanelHead | null) => void
}) {
  const url = head.snapshot.url
  const state = head.snapshot.state
  const driving = head.driving
  React.useEffect(() => {
    onChange({ url, state, driving })
  }, [url, state, driving, onChange])
  // Unmounting means the socket is gone: the chrome must fall back to the tab
  // row rather than keep showing the last page a dead socket was on.
  React.useEffect(() => () => onChange(null), [onChange])
  return null
}

/** No tabs at all — the first-run surface, and the destination of `+`.
 *
 *  The transient compose bar is gone: the address bar above is ALREADY the
 *  place you type, so this page points at it instead of growing a second one.
 *  Recent hosts come straight off the tabs' own `origins`, one tap each. */
function NewTabPage({
  tabs,
  onOpen,
}: {
  tabs: BrowserTab[]
  onOpen: (url: string) => void
}) {
  const hosts = React.useMemo(() => {
    const seen: string[] = []
    for (const t of tabs) {
      const h = tabHost(t.url)
      if (h && !h.startsWith('.') && !seen.includes(h)) seen.push(h)
    }
    return seen.slice(0, 6)
  }, [tabs])

  return (
    <div
      data-new-tab-page=""
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <Globe className="size-7 text-muted-foreground" aria-hidden />
      <p className="max-w-[42ch] text-[13px] leading-relaxed text-muted-foreground">
        One real browser you log into once. Type an address above, sign in, pin it
        — then lend that tab to the agents that need it.
      </p>
      {hosts.length > 0 && (
        <div className="flex max-w-[40ch] flex-wrap items-center justify-center gap-2">
          {hosts.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => onOpen(`https://${h}`)}
              className="min-h-9 max-w-[18ch] truncate rounded-xl border border-border px-3 text-[12.5px] text-foreground hover:border-primary"
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Dehydrated: the row is here, the page is not. Says exactly that — and now
 *  offers the verb that fixes it, because one exists: `POST …/open` wakes the
 *  tab at its own url with the on-disk profile, so the sign-in comes back with
 *  the page. (When the host passes no `onWake`, the card keeps the old honest
 *  dead end rather than drawing a button that would do nothing.) */
function AsleepState({
  tab,
  waking,
  onWake,
  onMenu,
}: {
  tab: BrowserTab
  waking?: boolean
  onWake?: () => void
  onMenu: () => void
}) {
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
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onWake && (
          <button
            type="button"
            onClick={onWake}
            disabled={waking}
            data-tab-wake={tab.id}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground disabled:opacity-60"
          >
            <Power className="size-4" aria-hidden />
            {waking ? 'Waking…' : 'Wake tab'}
          </button>
        )}
        <button
          type="button"
          onClick={onMenu}
          className="min-h-11 rounded-xl border border-border px-4 text-[12.5px] font-medium text-foreground"
        >
          Tab settings
        </button>
      </div>
    </div>
  )
}
