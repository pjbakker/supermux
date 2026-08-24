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
// ── PHASE 4: THE JOY LAYER, AND WHERE ITS STATE LIVES ────────────────────────
//
// Four things arrived here rather than in the components that draw them,
// because all four are facts about the WORKSPACE and not about one control:
//
//   · the CLOSED-TAB STACK. Undo has to outlive the chip that was closed, so it
//     cannot live in the rail. Re-opening mints a NEW row at the same address —
//     the cookies are on the server and survive, the GRANTS do not — which is
//     why the affordance says "Reopen" and never "Restore".
//   · the SESSION ORDER. Dragged order is client-only for v1: there is no
//     `position` column on `browser_tabs` and adding one is a migration, which
//     is the single thing in this repo that cannot be taken back. See
//     `lib/browser/tab-order.ts` for the exact field it wants.
//   · the CONTEXT MENUS. One menu component, two item lists, one open-at-a-time
//     state — a tab menu and a page menu that could both be open would be two
//     menus arguing about one Escape key.
//   · the FIND BAR, whose two verbs the server cannot do yet. It is mounted,
//     honest and disabled, and NOTHING it offers goes on a wire that would drop
//     it — see `lib/browser/page-tools.ts` for the four frames it is waiting on.
//
// PRESENTATIONAL ON PURPOSE. Every verb is a prop, so `/browser` wires the live
// hooks and `/dev/browser-workspace` wires fixtures — the same component, and
// the bench cannot drift from the product.
import * as React from 'react'

import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Link2,
  Pin,
  RotateCw,
  Search,
  TextSelect,
  Users,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { BrowserTab, GrantCandidate } from '@/lib/api/browser'
import { EMPTY_NAV, originOf, type NavState } from '@/lib/browser/nav-state'
import type { TakeoverOptions, TakeoverSnapshot } from '@/lib/browser/takeover-socket'
import {
  TakeoverPanel,
  type TakeoverControls,
  type TakeoverHeaderState,
  type TakeoverPanelProps,
} from '@/components/browser/takeover-panel'
import { BrowserChrome } from '@/components/browser/browser-chrome'
import { NewTabPage } from '@/components/browser/new-tab-page'
import { TabStrip } from '@/components/browser/tab-strip'
import { TabGrantSheet } from '@/components/browser/tab-grant-sheet'
import { BrowserMenu, type BrowserMenuItem } from '@/components/browser/browser-menu'
import { FindBar } from '@/components/browser/find-bar'
import { UndoBar } from '@/components/browser/undo-bar'
import {
  popClosed,
  pushClosed,
  UNDO_WINDOW_MS,
  type ClosedTab,
} from '@/lib/browser/closed-tabs'
import { applyOrder } from '@/lib/browser/tab-order'
import { NO_CAPS, NO_FIND, copyText, type FindResult, type PageCaps } from '@/lib/browser/page-tools'

/** What the live socket knows that the tab row does not. Flat values plus the
 *  nav state — which is itself flat, changes a few times per navigation, and is
 *  compared field-by-field by the bridge below, so a 60 fps frame stream still
 *  produces no re-renders at all. */
interface PanelHead {
  driving: boolean
  state: TakeoverSnapshot['state']
  nav: NavState
  /** What this relay can do beyond pixels (phase 4). Both false on every
   *  server today — the find bar reads it and says so. */
  caps: PageCaps
  find: FindResult
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
  /** Bench only — see `TakeoverPanel.benchGesture`: a swipe peek, a pinch or a
   *  tap ripple, frozen, so a rig with no fingers can shoot them. */
  benchGesture?: TakeoverPanelProps['benchGesture']
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
  benchGesture,
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
  /** PHASE 4 — the dragged order, ids only, client-only for this session. Empty
   *  = the server's order, untouched. `applyOrder` is total: a tab an agent
   *  opened mid-drag lands at the end rather than disappearing. */
  const [order, setOrder] = React.useState<string[]>([])
  /** The tabs we closed, newest first — see `lib/browser/closed-tabs.ts`. */
  const [closed, setClosed] = React.useState<ClosedTab[]>([])
  /** One menu at a time, or two menus argue about one Escape key. */
  const [menu, setMenu] = React.useState<
    { kind: 'tab' | 'page'; id: string; at: { x: number; y: number } } | null
  >(null)
  const [finding, setFinding] = React.useState(false)
  const [findQuery, setFindQuery] = React.useState('')
  const [findFocus, setFindFocus] = React.useState(0)
  /** Which copy just landed, for the 1.5s receipt. A clipboard write is
   *  invisible, and a button with no visible effect reads as broken. */
  const [copied, setCopied] = React.useState<string | null>(null)

  const ordered = React.useMemo(() => applyOrder(tabs, order), [tabs, order])
  const chosen = ordered.find((t) => t.id === activeId) ?? null
  const active = newTab ? null : chosen
  const sheetTab = ordered.find((t) => t.id === sheetFor) ?? null
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

  // ── close, and the way back ────────────────────────────────────────────────
  /** Close, remembering enough to offer the way back. The rail has already
   *  played the chip's collapse by the time this runs — see `TabStrip`. */
  const close = (id: string) => {
    const row = ordered.find((t) => t.id === id)
    if (row) {
      setClosed((prev) =>
        pushClosed(prev, {
          id: row.id,
          url: row.url,
          title: row.title,
          pinned: !!row.pinned,
          index: ordered.findIndex((t) => t.id === id),
          at: Date.now(),
        }),
      )
    }
    onClose(id)
  }

  /** REOPEN, NOT RESTORE. `onNew` mints a fresh row at the same address: the
   *  browser profile's cookies are on the server and survive, the tab's GRANTS
   *  do not — a permission is not decoration, and silently re-granting one from
   *  an undo would be the worst kind of convenience. */
  const reopen = () => {
    const taken = popClosed(closed)
    if (!taken) return
    setClosed(taken.rest)
    onNew(taken.entry.url)
  }

  // The affordance expires by itself, so a stale "Closed · Undo" cannot outlive
  // its own promise. One timer for the newest entry, re-armed as they arrive.
  const newestClosed = closed[0] ?? null
  React.useEffect(() => {
    if (!newestClosed) return
    const t = setTimeout(() => {
      setClosed((prev) => prev.filter((c) => c.id !== newestClosed.id))
    }, UNDO_WINDOW_MS)
    return () => clearTimeout(t)
  }, [newestClosed])

  // ── copy ───────────────────────────────────────────────────────────────────
  const receipt = (what: string) => {
    setCopied(what)
    setTimeout(() => setCopied((cur) => (cur === what ? null : cur)), 1_500)
  }
  const copyUrl = () => {
    if (!url) return
    void copyText(url).then((ok) => ok && receipt('url'))
  }
  /** Needs `ClientMsg::Copy`. `copySelection()` returns false when the relay
   *  cannot, and then nothing at all is sent — see `lib/browser/page-tools.ts`. */
  const copySelection = () => {
    if (ctl.current?.copySelection()) receipt('selection')
  }

  // ── find ───────────────────────────────────────────────────────────────────
  const caps = head?.caps ?? NO_CAPS
  const findResult = head?.find ?? NO_FIND
  const openFind = () => {
    setFinding(true)
    setFindFocus((n) => n + 1)
  }
  const closeFind = () => {
    setFinding(false)
    setFindQuery('')
    ctl.current?.findClose()
  }
  const runFind = (query: string, forward: boolean) => {
    // `find` returns false on a relay that cannot search, and then NOTHING goes
    // on the wire — the bar has already said why.
    ctl.current?.find(query, { forward })
  }
  /** Next / previous. The DIRECTION goes on the wire and the COUNT comes back
   *  — the client never advances its own index, because the server is the only
   *  side that knows how many matches there are or where the page is now. */
  const stepTo = (forward: boolean) => {
    if (!findQuery) return
    runFind(findQuery, forward)
  }

  // ── the shortcuts ──────────────────────────────────────────────────────────
  // CAPTURE PHASE, at the workspace root: the takeover panel relays keystrokes
  // into the page, so ⌘F would otherwise open the PAGE's find (inside a chrome
  // the human cannot see the chrome of) and ⌘⇧T would reach the site. These
  // three are the workspace's, and they have to win before the relay reads them.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        openFind()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        e.stopPropagation()
        reopen()
        return
      }
      if (e.key === 'Escape' && (menu || finding)) {
        // The menu owns its own Escape (and gives focus back); this is the
        // find bar's, and only when no menu is up.
        if (menu) return
        e.preventDefault()
        e.stopPropagation()
        closeFind()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ── the menus ──────────────────────────────────────────────────────────────
  // The ROWS are data and the VERBS are a table, which is why every ref the
  // verbs touch is read inside an event handler rather than inside a closure
  // built during render — see `browser-menu.tsx`.
  const menuTab = menu ? ordered.find((t) => t.id === menu.id) ?? null : null

  const tabRows = (t: BrowserTab): BrowserMenuItem[] => [
    {
      id: 'reload',
      label: 'Reload',
      icon: RotateCw,
      disabled: !t.live,
      hint: t.live ? undefined : 'This tab is asleep — wake it first',
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      icon: Copy,
      hint: 'Opens a NEW tab at the same address — a separate browser profile, not a copy of this one',
    },
    { id: 'copy-url', label: 'Copy link', icon: Link2, disabled: !t.url },
    { id: 'pin', label: t.pinned ? 'Unpin' : 'Pin', icon: Pin },
    { id: 'sharing', label: 'Sharing & settings…', icon: Users, separated: true },
    {
      id: 'close-others',
      label: 'Close other tabs',
      icon: X,
      danger: true,
      separated: true,
      disabled: ordered.length < 2,
    },
    { id: 'close', label: 'Close', icon: X, danger: true },
  ]

  const pageRows = (): BrowserMenuItem[] => [
    { id: 'back', label: 'Back', icon: ArrowLeft, disabled: !nav.canGoBack },
    { id: 'forward', label: 'Forward', icon: ArrowRight, disabled: !nav.canGoForward },
    { id: 'reload', label: 'Reload', icon: RotateCw, disabled: !active },
    {
      id: 'find',
      label: 'Find in page',
      icon: Search,
      separated: true,
      // NOT disabled: the bar is where the honest "needs a server update" line
      // lives, and hiding the door to it would hide the explanation too.
      hint: caps.find ? undefined : 'Find needs a server update — the bar says so',
    },
    { id: 'copy-url', label: 'Copy link', icon: Link2, disabled: !url },
    {
      id: 'copy-selection',
      label: 'Copy selection',
      icon: TextSelect,
      disabled: !caps.copy,
      hint: caps.copy ? undefined : 'Reading the page selection needs a server update',
    },
    { id: 'sharing', label: 'Sharing & settings…', icon: Users, separated: true, disabled: !active },
  ]

  /** The verb table. One place, one ref read, and it runs from a click. */
  const runMenu = (id: string) => {
    const t = menuTab
    if (menu?.kind === 'tab' && t) {
      switch (id) {
        case 'reload':
          select(t.id)
          if (t.id === active?.id) {
            drive(
              (c) => c.reload(false),
              () => (onReload ? onReload(t.id) : t.url && onNavigate?.(t.id, t.url)),
            )
          } else onReload?.(t.id)
          return
        case 'duplicate':
          onNew(t.url)
          return
        case 'copy-url':
          void copyText(t.url).then((ok) => ok && receipt('url'))
          return
        case 'pin':
          onPin(t.id, !t.pinned)
          return
        case 'sharing':
          setSheetFor(t.id)
          return
        case 'close-others':
          for (const other of ordered) if (other.id !== t.id) close(other.id)
          return
        case 'close':
          close(t.id)
          return
        default:
          return
      }
    }
    switch (id) {
      case 'back':
        if (active) drive((c) => c.back(), () => onBack?.(active.id))
        return
      case 'forward':
        if (active) drive((c) => c.forward(), () => onForward?.(active.id))
        return
      case 'reload':
        if (active) {
          drive(
            (c) => c.reload(false),
            () => (onReload ? onReload(active.id) : url && onNavigate?.(active.id, url)),
          )
        }
        return
      case 'find':
        openFind()
        return
      case 'copy-url':
        copyUrl()
        return
      case 'copy-selection':
        copySelection()
        return
      case 'sharing':
        if (active) setSheetFor(active.id)
        return
      default:
        return
    }
  }

  return (
    <div
      data-browser-workspace=""
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      <TabStrip
        tabs={ordered}
        activeId={newTab ? null : activeId}
        onSelect={select}
        onClose={close}
        onMenu={setSheetFor}
        onContext={(id, at) => setMenu({ kind: 'tab', id, at })}
        onReorder={setOrder}
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
        onPageMenu={(at) => active && setMenu({ kind: 'page', id: active.id, at })}
      />

      {/* Mounted only when asked for: a bar that is always there is a bar that
          is always in the way on a 390px phone, and its own controls say what
          this relay can and cannot do. */}
      {finding && (
        <FindBar
          query={findQuery}
          onQuery={(q) => {
            setFindQuery(q)
            if (q) runFind(q, true)
            else ctl.current?.findClose()
          }}
          result={findResult}
          caps={caps}
          searching={!!findQuery && findResult.query !== findQuery}
          onNext={() => stepTo(true)}
          onPrev={() => stepTo(false)}
          onClose={closeFind}
          onCopyUrl={copyUrl}
          onCopySelection={copySelection}
          copied={copied}
          focusKey={findFocus}
        />
      )}

      {!active ? (
        <NewTabPage
          tabs={ordered}
          onOpen={(u) => onNew(u)}
          onSelect={select}
          onFocusAddress={() => setFocusKey((n) => n + 1)}
          favicons={favicons}
        />
      ) : (
        // THE PAGE SWAP. Keyed by the tab, so switching tabs fades the new
        // viewport IN over 260ms rather than cutting. It fades from the neutral
        // surface, never from the OUTGOING tab's pixels — one tab's page under
        // another tab's address bar is the one thing a workspace must not show,
        // and a crossfade between two live pages would be exactly that.
        <div
          key={active.id}
          data-browser-viewport={active.id}
          className="sm-browser-fade-in relative flex min-h-0 flex-1 flex-col"
          onContextMenu={(e) => {
            // The PAGE menu, at the pointer. The panel already calls
            // `preventDefault` on its own context menu (it relays a right-click
            // into the page while driving), so this one only ever fires where
            // that did not.
            e.preventDefault()
            setMenu({ kind: 'page', id: active.id, at: { x: e.clientX, y: e.clientY } })
          }}
        >
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
          benchGesture={benchGesture}
          onWake={onWake ? () => onWake(active.id) : undefined}
          onReload={onNavigate && url ? () => onNavigate(active.id, url) : undefined}
          className="min-h-0 flex-1"
          renderHeader={(state) => <PanelBridge head={state} onChange={receive} />}
        />
        {/* At the THUMB end of the screen and inside the workspace, not the
            app's top-anchored toast — see `undo-bar.tsx`. */}
        <UndoBar
          entry={newestClosed}
          onUndo={reopen}
          onDismiss={() => setClosed((prev) => prev.slice(1))}
        />
        </div>
      )}

      {menu && (
        <BrowserMenu
          at={menu.at}
          label={menu.kind === 'tab' ? 'Tab menu' : 'Page menu'}
          items={menu.kind === 'tab' ? (menuTab ? tabRows(menuTab) : []) : pageRows()}
          onSelect={runMenu}
          onClose={() => setMenu(null)}
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
  const caps = head.snapshot.caps
  const find = head.snapshot.find
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
      caps,
      find,
      nav: { url, title, favicon, loading, canGoBack, canGoForward, secure, dialog },
    })
  }, [
    state,
    driving,
    caps,
    find,
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
