// The shared-browser WORKSPACE — the human's persistent browser, on one route.
//
//   ┌─ /browser ────────────────────────────┐
//   │ [◀ tab strip — the only overflow  +▶] │  the rail (tab-strip.tsx)
//   │ ┌───────────────────────────────────┐ │
//   │ │ ◀ ▶ ⟳ │ 🔒 example.com/inbox  × ⋯ │ │  the CHROME (browser-chrome.tsx)
//   │ │ ⏻ ⤢         [ Watch | Drive ] 2👤 │ │  always mounted, never a lie
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
// component that draws nothing and reports the live nav state in an effect),
// and the chrome above reads it. One chrome, three viewport states.
//
// WATCH IS THE DEFAULT, AND THAT IS THE POINT. The tab socket attaches
// watch-first (`/ws/browser/tab/{id}`): frames flow, input is refused until the
// human presses Drive. Without that, merely LOOKING at a tab would silently
// block every agent granted on it — the one footgun a workspace surface would
// hit constantly. Drive sends `take_over`, Watch hands it straight back.
//
// THE LIVE PANEL IS THE DEFAULT FOR ANY TAB (phase 2). The tab route
// rehydrates on attach (`tab_takeover_socket`), so attaching to an asleep tab
// IS waking it: the panel is mounted for every selected tab and its own state
// matrix draws asleep / waking / connecting / busy / crashed, each with the one
// verb that fixes it.
//
// ── PHASE 3: TWO DOORS TO THE SAME VERB, AND WHICH ONE WE USE ────────────────
//
// Back / forward / reload / stop / navigate exist on BOTH the REST door
// (`POST /api/browser/tabs/{id}/…`, which wakes the tab first) and the takeover
// socket (`ClientMsg::Back` &c). `drive()` below prefers the SOCKET whenever one
// is live, because that frame lands in the relay that is already holding the
// page — no row load, no wake, no row re-read between a thumb and a page — and
// falls back to REST otherwise, which is the door that can wake a sleeping tab
// in the first place. The two are not redundant: they are the moving and the
// standing-still cases of the same verb.
//
// PRESENTATIONAL ON PURPOSE. Every verb is a prop, so `/browser` wires the live
// hooks and `/dev/browser-workspace` wires fixtures — the same component, and
// the bench cannot drift from the product.
import * as React from 'react'

import { cn } from '@/lib/utils'
import type { BrowserTab, GrantCandidate } from '@/lib/api/browser'
import { EMPTY_NAV, originOf, type NavState } from '@/lib/browser/nav-state'
import type { TakeoverOptions, TakeoverSnapshot } from '@/lib/browser/takeover-socket'
import {
  TakeoverPanel,
  type TakeoverControls,
  type TakeoverHeaderState,
} from '@/components/browser/takeover-panel'
import { BrowserChrome } from '@/components/browser/browser-chrome'
import { NewTabPage } from '@/components/browser/new-tab-page'
import { TabStrip } from '@/components/browser/tab-strip'
import { TabGrantSheet } from '@/components/browser/tab-grant-sheet'

/** What the live socket knows that the tab row does not. Flat values plus the
 *  nav state — which is itself flat, changes a few times per navigation, and is
 *  compared field-by-field by the bridge below, so a 60 fps frame stream still
 *  produces no re-renders at all. */
interface PanelHead {
  driving: boolean
  state: TakeoverSnapshot['state']
  nav: NavState
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
  /** The REST half of the nav controls (`POST …/{back,forward,reload,stop}`),
   *  used when no socket is attached — they wake the tab and then act. */
  onBack?: (id: string) => void
  onForward?: (id: string) => void
  onReload?: (id: string) => void
  onStop?: (id: string) => void
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
  /** Bench only: tell the viewport the row is live even when the fixture says
   *  asleep, so the offline rig can screenshot a driving viewport. */
  forceLive?: boolean
  /** Bench only: draw the crashed state. */
  crashed?: boolean
  /** Bench only — see `TakeoverPanel.benchKeyboard`. */
  benchKeyboard?: number
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
  onBack,
  onForward,
  onReload,
  onStop,
  onClose,
  onPin,
  onGrant,
  onRevoke,
  onOrigins,
  busy,
  bots,
  panelOptions,
  forceLive,
  crashed,
  benchKeyboard,
  contentTheme,
  className,
}: BrowserWorkspaceProps) {
  // The live socket's verbs, published by the panel while it is mounted. Read
  // only from event handlers (a tap), never during render.
  const ctl = React.useRef<TakeoverControls | null>(null)
  const [sheetFor, setSheetFor] = React.useState<string | null>(null)
  const [head, setHead] = React.useState<PanelHead | null>(null)
  // `+` does not mint a row up front (that is how the old flow ended up with
  // bookmarks nobody opened). It shows the new-tab page and puts the caret in
  // the address bar; the row is minted by the address the human then types.
  const [newTab, setNewTab] = React.useState(false)
  const [focusKey, setFocusKey] = React.useState(0)
  /** origin → the last favicon we saw there. Only the ACTIVE tab has a socket,
   *  so without this the other seven chips could never wear their own icon.
   *  Keyed by origin, never by tab id: the icon is a fact about a SITE, so a
   *  tab that navigated elsewhere misses the memo and falls back to its letter
   *  tile rather than keeping the previous site's face. */
  const [favicons, setFavicons] = React.useState<Record<string, string>>({})

  const chosen = tabs.find((t) => t.id === activeId) ?? null
  const active = newTab ? null : chosen
  const sheetTab = tabs.find((t) => t.id === sheetFor) ?? null
  // "There is a page" — the row's flag, or the socket's own attachment, which
  // outranks it: a tab the socket just rehydrated is live before the next poll
  // says so.
  const live = !!active && (active.live || !!forceLive || head?.state === 'live')
  const nav = head?.nav ?? EMPTY_NAV
  // The live page's own url outranks the row's: an agent that navigated three
  // pages deep must not leave the human's address bar showing where the tab
  // STARTED. Falls back to the row when nothing is attached yet.
  const url = (live && nav.url) || active?.url || ''


  /** What the panel's bridge reports, in one callback: the head the chrome
   *  renders from, and the favicon memo the rail reads. One subscription, one
   *  handler — rather than a second effect watching the first effect's state. */
  const receive = React.useCallback((next: PanelHead | null) => {
    setHead(next)
    const icon = next?.nav.favicon
    const origin = next ? originOf(next.nav.url) : null
    if (!icon || !origin) return
    setFavicons((prev) => (prev[origin] === icon ? prev : { ...prev, [origin]: icon }))
  }, [])

  /**
   * One verb, two doors. The socket wins whenever it is live (the page is
   * already in its hand); REST is the fallback, and the only door that can wake
   * a tab that is asleep.
   */
  const drive = (socket: (c: TakeoverControls) => void, rest?: () => void) => {
    const c = ctl.current
    if (live && c) {
      socket(c)
      return
    }
    rest?.()
  }

  /** Enter in the omnibox. With a tab: navigate it (waking it if need be) —
   *  browser semantics, the current tab goes there. Without one: mint a tab at
   *  that address, already open. */
  const go = (dest: string) => {
    setNewTab(false)
    if (!active) {
      onNew(dest)
      return
    }
    drive(
      (c) => c.navigate(dest),
      () => onNavigate?.(active.id, dest),
    )
  }

  const select = (id: string) => {
    setNewTab(false)
    onActivate(id)
  }

  return (
    <div
      data-browser-workspace=""
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      <TabStrip
        tabs={tabs}
        activeId={newTab ? null : activeId}
        onSelect={select}
        onClose={onClose}
        onMenu={setSheetFor}
        // The socket's live title / favicon / spinner, for the ONE tab it is
        // attached to. Every other chip renders from its row, which the server
        // now writes the page's real url and title through to.
        live={
          active && live
            ? {
                tabId: active.id,
                title: nav.title,
                favicon: nav.favicon,
                loading: nav.loading,
              }
            : null
        }
        favicons={favicons}
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
        nav={nav}
        driving={head?.driving ?? false}
        canDrive={head?.state === 'live'}
        busy={busy}
        focusKey={focusKey}
        tabs={tabs}
        onSwitchTab={select}
        onNavigate={go}
        onWake={() => active && onWake?.(active.id)}
        onSleep={onSleep && active ? () => onSleep(active.id) : undefined}
        onReload={(hard) =>
          active &&
          drive(
            (c) => c.reload(hard),
            // The REST door has no hard-reload flag; a soft reload of a tab
            // that may be asleep is the honest fallback, not a silent lie
            // about the cache.
            () => (onReload ? onReload(active.id) : url && onNavigate?.(active.id, url)),
          )
        }
        onBack={() =>
          active &&
          drive(
            (c) => c.back(),
            () => onBack?.(active.id),
          )
        }
        onForward={() =>
          active &&
          drive(
            (c) => c.forward(),
            () => onForward?.(active.id),
          )
        }
        onStop={() =>
          active &&
          drive(
            (c) => c.stop(),
            () => onStop?.(active.id),
          )
        }
        onResync={() => ctl.current?.resync()}
        onWatch={() => ctl.current?.handBack()}
        onDrive={() => ctl.current?.takeOver()}
        onMenu={() => active && setSheetFor(active.id)}
      />

      {!active ? (
        <NewTabPage
          tabs={tabs}
          onOpen={(u) => onNew(u)}
          onSelect={select}
          onFocusAddress={() => setFocusKey((n) => n + 1)}
          favicons={favicons}
        />
      ) : (
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
          tabLive={active.live || !!forceLive}
          // Only an OPEN tab is attached on sight. Attaching rehydrates, and a
          // human selecting a row must not start a browser by looking at it.
          attach={active.live || !!forceLive}
          waking={busy}
          needsLogin={active.login_state === 'needs_login'}
          crashed={crashed}
          benchKeyboard={benchKeyboard}
          onWake={onWake ? () => onWake(active.id) : undefined}
          onReload={onNavigate && url ? () => onNavigate(active.id, url) : undefined}
          className="min-h-0 flex-1"
          renderHeader={(state) => <PanelBridge head={state} onChange={receive} />}
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
 *  child reports in an EFFECT instead, keyed on the flat values the chrome
 *  actually uses — so a 60 fps frame stream produces no re-renders at all, and
 *  only a real navigation, a load, or a wheel change reaches the chrome. */
function PanelBridge({
  head,
  onChange,
}: {
  head: TakeoverHeaderState
  onChange: (head: PanelHead | null) => void
}) {
  const state = head.snapshot.state
  const driving = head.driving
  const nav = head.snapshot.nav
  // Field-by-field, not by object identity: the snapshot object is rebuilt on
  // every patch, so depending on it would re-run this effect for a `refused`
  // banner or a mode echo that the chrome does not read.
  const { url, title, favicon, loading, canGoBack, canGoForward, secure, dialog } = nav
  React.useEffect(() => {
    // Rebuilt from the destructured FIELDS rather than passed through, so the
    // dependency list is exhaustive and a new snapshot object carrying
    // identical values does not wake the chrome.
    onChange({
      state,
      driving,
      nav: { url, title, favicon, loading, canGoBack, canGoForward, secure, dialog },
    })
  }, [
    state,
    driving,
    onChange,
    url,
    title,
    favicon,
    loading,
    canGoBack,
    canGoForward,
    secure,
    dialog,
  ])
  // Unmounting means the socket is gone: the chrome must fall back to the tab
  // row rather than keep showing the last page a dead socket was on.
  React.useEffect(() => () => onChange(null), [onChange])
  return null
}
