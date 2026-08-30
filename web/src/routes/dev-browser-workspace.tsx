// DEV bench (/dev/browser-workspace) — the shared-browser workspace, offline.
//
// No server behind it: fixture tabs, local state for pin/close/grant, and the
// takeover bench's fake socket replaying one authentic captured JPEG, so the
// rail, the viewport, the Watch/Drive pair and the per-tab grant sheet can all
// be screenshotted with nothing running. Not a product route.
//
// FLAGS
//   ?phone=1        render ONLY the 390px frame (shoot it at a 390px viewport)
//   ?desktop=1      render ONLY the wide frame
//   (neither)       both frames, stacked — the review page
//   ?theme=dark     force the dark slab
//   ?tab=<id>       start on a specific fixture tab (`tb_bank` is the
//                   needs-login one, `tb_crm` the dehydrated one)
//   ?sheet=1        open the per-tab grant sheet on the active tab
//   ?live=1         mount the takeover canvas even for an asleep tab
//   ?empty=1        the no-tabs-at-all first-run surface
//   ?busy=1         a navigate/wake in flight — the chrome's loading hairline
//                   and the asleep card's "Waking…"
//   ?address=<txt>  seed the omnibox as if it had been typed into, so the
//                   GO/SEARCH lead icon and the clear (×) are screenshot-able
//   ?drive=1        the human holds the wheel — the accent ring, the live
//                   keyboard trap, the drive-profile negotiation
//   ?kb=<px>        pretend a soft keyboard that tall is up (the rig has none):
//                   the viewport lifts above it and the Done bar appears
//   ?nav=<flags>    PHASE 3 — the nav-state feed, faked (comma-separated):
//                     back      · there is history behind  → Back lights up
//                     forward   · …and ahead               → Forward lights up
//                     loading   · a load is in flight      → Reload becomes
//                                 Stop, the chip spins, the hairline shimmers
//                     insecure  · an http page             → "Not secure"
//                     icon      · the page has a favicon   → the real icon
//                                 replaces the letter tile in the rail
//   ?dialog=<kind>  PHASE 3 — the page opened a modal: alert | confirm |
//                   prompt | beforeunload. Drawn OVER the viewport.
//   ?chip=1         open the security chip's panel (origins + the nudge)
//   ?newtab=1       the NEW-TAB page — what `+` lands on, with pinned tiles
//   ?address=<txt>  ALSO drives the omnibox suggestion list: `?address=mail`
//                   shows "Go to …" plus the matching open tabs
//   ?state=<name>   PHASE 2 — force one viewport state, each with its own fake
//                   socket (a real close code, not a faked state), so all of
//                   them are screenshot-able offline:
//                     live · needs-login · asleep · waking · connecting
//                     busy · offline · reconnecting · crashed
//                   `asleep`/`waking` pick the dehydrated fixture tab, which is
//                   also the pair that must NOT dial: attaching would rehydrate.
//
// PHASE 4 — THE JOY LAYER. A swipe, a pinch and a long-press are things a
// FINGER does, and a screenshot rig has no fingers. So each of these freezes
// the state a finger would have produced and hands it to the SAME overlay the
// real gesture drives — there is no bench-only branch behind any of them.
//   ?swipe=<edge>[:p]  the edge-swipe peek, mid-gesture: `left` (back) or
//                      `right` (forward), optional progress 0…1
//                      (`?swipe=left:1` is the armed "let go and it goes")
//   ?zoom=<n>          the visual zoom at n× — the reset chip appears with it
//   ?ripple=1          the 300ms tap confirmation on the canvas
//   ?menu=<what>       a context menu, open: `tab` (long-press / right-click a
//                      chip) or `page` (the chrome's ⋯)
//   ?find=1            the find bar — DISABLED by default, because that is the
//                      state every server ships today
//   ?caps=find,copy    …pretend a relay that HAS the DOM verbs, so the enabled
//                      bar and its live count are screenshot-able too
//   ?undo=1            close the active tab, so the "Closed · Reopen" bar is up
//   ?drag=1            a tab chip mid-drag, with the rail reflowed around it
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserWorkspace } from '@/components/browser/workspace'
import type { BrowserTab } from '@/lib/api/browser'
import { EMPTY_NAV, type NavState } from '@/lib/browser/nav-state'
import type { TakeoverOptions } from '@/lib/browser/takeover-socket'
import { commitDistance, rubberBand, type EdgePeek } from '@/lib/browser/edge-swipe'
import type { MockFailure } from './dev-browser-takeover.fixture'
import { BENCH_BOTS, BENCH_TABS } from './dev-browser-workspace.fixture'

/** The phase-2 viewport states, as `?state=` spells them. */
type ViewportBenchState =
  | ''
  | 'live'
  | 'needs-login'
  | 'asleep'
  | 'waking'
  | 'connecting'
  | 'busy'
  | 'offline'
  | 'reconnecting'
  | 'crashed'

/** Each terminal state is a real close code off the real close-code table —
 *  the bench socket does not fake the STATE, it fakes the CLOSE that produces
 *  it, so a change to the table shows up here rather than being papered over. */
const SOCKET_FAILURE: Partial<Record<ViewportBenchState, MockFailure>> = {
  asleep: { code: 4404, reason: 'no browser context' },
  busy: { code: 1013, reason: 'already attached' },
  offline: { code: 1008, reason: 'auth required' },
  // Keeps the frame, THEN drops: the state that must show the last picture,
  // dimmed, rather than a blank box.
  reconnecting: { code: 1006, reason: '', afterSeed: true },
}

/** States where the socket simply never answers the handshake. */
const SILENT_STATES: ViewportBenchState[] = ['connecting', 'waking']

/** A real 16px favicon with no network behind it: one inline SVG as a `data:`
 *  URI, which is the same shape the server relays (it reads the icon INSIDE the
 *  page and hands over base64). Lets the rail's icon path be screenshot offline
 *  without the bench inventing a second one. */
const BENCH_FAVICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect width="16" height="16" rx="3" fill="#2563eb"/>' +
      '<path d="M3 5h10v6H3z" fill="none" stroke="#fff" stroke-width="1.4"/>' +
      '<path d="M3 5l5 4 5-4" fill="none" stroke="#fff" stroke-width="1.4"/>' +
      '</svg>',
  )

/** `?nav=` → the nav-state feed the socket would have pushed. Fake state, real
 *  component: the chrome, the rail and the padlock all read this through the
 *  exact prop the live feed writes. */
function benchNavState(flags: string, dialogKind: string): NavState | undefined {
  const on = flags
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
  if (on.length === 0 && !dialogKind) return undefined
  const insecure = on.includes('insecure')
  const url = insecure ? 'http://docs.internal/handbook' : 'https://mail.acme.example/inbox'
  return {
    ...EMPTY_NAV,
    url,
    title: insecure ? 'Handbook' : 'Inbox (3) — Acme Mail',
    favicon: on.includes('icon') ? BENCH_FAVICON : null,
    loading: on.includes('loading'),
    canGoBack: on.includes('back'),
    canGoForward: on.includes('forward'),
    secure: !insecure,
    dialog: dialogKind
      ? {
          kind: dialogKind,
          message:
            dialogKind === 'prompt'
              ? 'What should we call this export?'
              : dialogKind === 'beforeunload'
                ? ''
                : "This export will overwrite last week's file. Continue?",
          default_prompt: dialogKind === 'prompt' ? 'settlement-q3' : '',
        }
      : null,
  }
}

/** States that only exist on a particular kind of tab. */
const STATE_TAB: Partial<Record<ViewportBenchState, string>> = {
  'needs-login': 'tb_bank',
  asleep: 'tb_crm',
  waking: 'tb_crm',
}

const BENCH_QC = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
})

export default function DevBrowserWorkspace() {
  const params = new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.search,
  )
  const dark = params.get('theme') === 'dark'
  const onlyPhone = params.get('phone') === '1'
  const onlyDesktop = params.get('desktop') === '1'
  const empty = params.get('empty') === '1'
  const live = params.get('live') === '1'
  const busy = params.get('busy') === '1'
  const address = params.get('address')
  const sheet = params.get('sheet') === '1'
  const drive = params.get('drive') === '1'
  const kb = Number(params.get('kb') ?? '') || 0
  const state = (params.get('state') ?? '') as ViewportBenchState
  const navFlags = params.get('nav') ?? ''
  const dialogKind = params.get('dialog') ?? ''
  const chip = params.get('chip') === '1'
  const newtab = params.get('newtab') === '1'
  const swipe = params.get('swipe') ?? ''
  const zoomAt = Number(params.get('zoom') ?? '') || 0
  const ripple = params.get('ripple') === '1'
  const menu = params.get('menu') ?? ''
  const find = params.get('find') === '1'
  const capFlags = params.get('caps') ?? ''
  const undo = params.get('undo') === '1'
  const drag = params.get('drag') === '1'
  // A state that only exists on a particular KIND of tab picks that tab, so the
  // flag is one flag: `?state=needs-login` is the signed-out one, `?state=asleep`
  // the dehydrated one.
  const startTab = params.get('tab') ?? STATE_TAB[state] ?? null

  // The takeover fixture carries a 17 KB base64 frame; import it lazily, exactly
  // like the takeover bench does.
  const [options, setOptions] = React.useState<TakeoverOptions | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    void import('./dev-browser-takeover.fixture').then((m) => {
      if (!alive) return
      const mode = drive ? 'human_driving' : 'agent_driving'
      const fail = SOCKET_FAILURE[state]
      // The nav state goes in at the SOCKET, so the address bar, the padlock,
      // the arrows, the rail's icon/spinner and the dialog surface all reach
      // their state through the real `nav_state` frame and the real parse.
      const caps = capFlags
        ? {
            find: capFlags.includes('find'),
            copy: capFlags.includes('copy'),
          }
        : undefined
      setOptions(
        m.mockOptions(
          mode,
          fail,
          SILENT_STATES.includes(state),
          benchNavState(navFlags, dialogKind),
          caps,
        ),
      )
    })
    return () => {
      alive = false
    }
  }, [drive, state, navFlags, dialogKind, capFlags])

  return (
    <QueryClientProvider client={BENCH_QC}>
      <TooltipProvider delayDuration={200}>
        <ToastProvider>
          <div
            data-theme={dark ? 'dark' : 'light'}
            className={dark ? 'dark min-h-dvh bg-background' : 'min-h-dvh bg-background'}
          >
            <div className="mx-auto flex min-h-dvh max-w-[980px] flex-col gap-5 p-4">
              {!onlyDesktop && (
                <Frame
                  label="390 × 780 (phone)"
                  vr={`browser-workspace-phone-${dark ? 'dark' : 'light'}`}
                  width={onlyPhone ? undefined : 390}
                  height={onlyPhone ? undefined : 780}
                  full={onlyPhone}
                >
                  <Bench
                    empty={empty}
                    live={live}
                    busy={busy}
                    address={address}
                    startTab={startTab}
                    sheet={sheet}
                    state={state}
                    kb={kb}
                    chip={chip}
                    newtab={newtab}
                    options={options}
                    swipe={swipe}
                    zoomAt={zoomAt}
                    ripple={ripple}
                    menu={menu}
                    find={find}
                    undo={undo}
                    drag={drag}
                    contentTheme={dark ? 'dark' : 'light'}
                  />
                </Frame>
              )}
              {!onlyPhone && (
                <Frame
                  label="desktop"
                  vr={`browser-workspace-desktop-${dark ? 'dark' : 'light'}`}
                  height={620}
                  full={onlyDesktop}
                >
                  <Bench
                    empty={empty}
                    live={live}
                    busy={busy}
                    address={address}
                    startTab={startTab}
                    sheet={sheet && onlyDesktop}
                    state={state}
                    kb={kb}
                    chip={chip && onlyDesktop}
                    newtab={newtab}
                    options={options}
                    swipe={onlyDesktop ? swipe : ''}
                    zoomAt={onlyDesktop ? zoomAt : 0}
                    ripple={onlyDesktop ? ripple : false}
                    menu={onlyDesktop ? menu : ''}
                    find={find}
                    undo={onlyDesktop ? undo : false}
                    drag={onlyDesktop ? drag : false}
                    contentTheme={dark ? 'dark' : 'light'}
                  />
                </Frame>
              )}
            </div>
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** One slab. `full` drops the frame entirely so `?phone=1` is a real 390px page
 *  rather than a 390px box inside a wider one — the rail's overflow rule can
 *  only be judged when the DOCUMENT is the narrow thing. */
function Frame({
  label,
  vr,
  width,
  height,
  full,
  children,
}: {
  label: string
  vr: string
  width?: number
  height?: number
  full?: boolean
  children: React.ReactNode
}) {
  if (full) {
    return (
      <div data-vr={vr} className="flex min-h-dvh flex-col">
        {children}
      </div>
    )
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</h2>
      <div
        data-vr={vr}
        style={{ width, height }}
        className="flex flex-col overflow-hidden rounded-2xl border border-border shadow-[var(--sm-card-shadow)]"
      >
        {children}
      </div>
    </section>
  )
}

/** The workspace on local state — every verb mutates the fixture array in place
 *  of a server, so pin/close/grant/revoke are all clickable on the bench. */
function Bench({
  empty,
  live,
  busy,
  address,
  startTab,
  sheet,
  state,
  kb,
  chip,
  newtab,
  options,
  swipe,
  zoomAt,
  ripple,
  menu,
  find,
  undo,
  drag,
  contentTheme,
}: {
  empty: boolean
  live: boolean
  busy: boolean
  address: string | null
  startTab: string | null
  sheet: boolean
  state: ViewportBenchState
  kb: number
  chip: boolean
  newtab: boolean
  options?: TakeoverOptions
  swipe: string
  zoomAt: number
  ripple: boolean
  menu: string
  find: boolean
  undo: boolean
  drag: boolean
  contentTheme: 'light' | 'dark'
}) {
  const [tabs, setTabs] = React.useState<BrowserTab[]>(empty ? [] : BENCH_TABS)
  const [activeId, setActiveId] = React.useState<string | null>(
    empty ? null : startTab ?? BENCH_TABS[0].id,
  )

  // `?sheet=1` opens the grant sheet on mount by synthesising the long-press the
  // human would make. Done via a ref on the rendered chip so the bench exercises
  // the real open path rather than a second, bench-only one.
  React.useEffect(() => {
    if (!sheet) return
    const id = activeId
    if (!id) return
    const chip = document.querySelector<HTMLElement>(`[data-tab-chip="${CSS.escape(id)}"]`)
    chip?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }, [sheet, activeId])

  // `?newtab=1` presses the REAL `+`, so the bench lands on the new-tab page by
  // the same path a human does — the workspace owns that state, and a bench-only
  // door into it is a door that can drift from the product.
  React.useEffect(() => {
    if (!newtab) return
    document.querySelector<HTMLElement>('[data-tab-new]')?.click()
  }, [newtab])

  // `?chip=1` opens the security panel the same way: by clicking the chip.
  //
  // The latch is not superstition. The chip is a TOGGLE, StrictMode runs every
  // effect twice in dev, and both runs happen before React flushes the state
  // update — so the DOM still reads `aria-expanded="false"` on the second pass
  // and a guard that reads the DOM would click twice and close it again. A ref
  // survives the double-invoke; the attribute does not.
  const chipArmed = React.useRef(true)
  React.useEffect(() => {
    if (!chip || !chipArmed.current) return
    chipArmed.current = false
    document.querySelector<HTMLElement>('[data-security-chip]')?.click()
  }, [chip])

  // `?address=` types into the REAL omnibox rather than adding a bench-only
  // prop: the lead icon, the clear button and the refusal line are all driven
  // by the component's own draft state, so the capture has to go through it.
  React.useEffect(() => {
    if (address === null) return
    const input = document.querySelector<HTMLInputElement>('[data-address-bar] input')
    if (!input) return
    const proto = Object.getPrototypeOf(input) as object
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    input.focus()
    setter?.call(input, address)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [address])

  // `?find=1` presses the REAL ⌘F, and `?undo=1` presses the REAL close button:
  // both reach their state through the product's own path, so a bench capture
  // cannot show a surface the app has no door to.
  const findArmed = React.useRef(true)
  React.useEffect(() => {
    if (!find || !findArmed.current) return
    findArmed.current = false
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }),
    )
  }, [find])

  // NO CLEANUP-CANCELLED TIMERS IN ANY OF THE THREE DRIVERS BELOW. StrictMode
  // runs every effect twice in dev: the first pass would arm the latch AND
  // schedule the work, and its cleanup would then cancel that work before the
  // second pass declined to re-schedule it. The latch survives the double
  // invoke; a timer does not. So each of these does its work through a raf
  // chain that nothing cancels — the same reason `?chip=1` is a bare latch.
  const undoArmed = React.useRef(true)
  React.useEffect(() => {
    if (!undo || !undoArmed.current) return
    undoArmed.current = false
    // The first CLOSABLE chip — a pinned tab is favicon-only and has no close
    // affordance at all, which is what pinning is. The rail collapses it, THEN
    // the row goes and the "Closed · Reopen" bar arrives: the whole sequence,
    // not a faked end state.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-tab-close]')?.click()
    })
  }, [undo])

  // `?menu=tab|page` opens the context menu through the same two doors a human
  // has: a right-click on the chip, and the chrome's ⋯.
  const menuArmed = React.useRef(true)
  React.useEffect(() => {
    if (!menu || !menuArmed.current) return
    menuArmed.current = false
    requestAnimationFrame(() => {
      if (menu === 'page') {
        document.querySelector<HTMLElement>('[data-chrome-page-menu]')?.click()
        return
      }
      const id = activeId
      if (!id) return
      document
        .querySelector<HTMLElement>(`[data-tab-chip="${CSS.escape(id)}"]`)
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
  }, [menu, activeId])

  // `?drag=1` puts a chip in the air with real PointerEvents, so the rail's own
  // measure-and-reflow runs — a faked transform would screenshot a layout the
  // drag code never produced.
  const dragArmed = React.useRef(true)
  React.useEffect(() => {
    if (!drag || !dragArmed.current) return
    dragArmed.current = false
    // Two frames: one for the rail to lay out, one for the drag to measure it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-chip]'))
      const held = chips[2] ?? chips[0]
      if (!held) return
      const r = held.getBoundingClientRect()
      const at = (type: string, x: number) =>
        held.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: x,
            clientY: r.top + r.height / 2,
          }),
        )
      at('pointerdown', r.left + 20)
      at('pointermove', r.left + 20 - Math.round(r.width * 0.9))
    }))
  }, [drag])

  const patch = (id: string, fn: (t: BrowserTab) => BrowserTab) =>
    setTabs((prev) => prev.map((t) => (t.id === id ? fn(t) : t)))

  return (
    <BrowserWorkspace
      tabs={tabs}
      activeId={activeId}
      onActivate={setActiveId}
      onNew={(url) => {
        const id = `tb_new${tabs.length}`
        setTabs((prev) => [
          ...prev,
          {
            id,
            title: url,
            url,
            pinned: false,
            company_id: null,
            origins: [],
            login_state: 'unknown',
            last_probe_at: null,
            live: true,
            grants: [],
            created_at: Math.floor(Date.now() / 1000),
            last_used_at: null,
          },
        ])
        setActiveId(id)
      }}
      onClose={(id) => {
        setTabs((prev) => prev.filter((t) => t.id !== id))
        setActiveId((cur) => (cur === id ? null : cur))
      }}
      onPin={(id, pinned) => patch(id, (t) => ({ ...t, pinned }))}
      onGrant={async (id, grantee) => {
        patch(id, (t) => ({
          ...t,
          grants: [
            ...t.grants.filter((g) => g.grantee !== grantee),
            { tab_id: id, grantee, enabled: 1, granted_at: Math.floor(Date.now() / 1000) },
          ],
        }))
      }}
      onRevoke={async (id, grantee) => {
        patch(id, (t) => ({ ...t, grants: t.grants.filter((g) => g.grantee !== grantee) }))
      }}
      onNavigate={(id, url) => patch(id, (t) => ({ ...t, url, live: true }))}
      onWake={(id) => patch(id, (t) => ({ ...t, live: true }))}
      // No history behind a fixture, so the REST fallbacks are wired to the one
      // honest thing they can do offline: nothing, loudly, in the console. The
      // bench exists to screenshot the CONTROLS, and `?nav=back,forward` is what
      // makes them lit.
      onBack={() => undefined}
      onForward={() => undefined}
      onReload={() => undefined}
      onStop={() => undefined}
      onSleep={(id) => patch(id, (t) => ({ ...t, live: false }))}
      onOrigins={(id, origins) => patch(id, (t) => ({ ...t, origins }))}
      busy={busy || state === 'waking'}
      bots={BENCH_BOTS}
      panelOptions={options}
      // `?state=asleep|waking` wants the ROW to say asleep, so the state matrix
      // reaches those branches rather than being overridden into "live".
      forceLive={live && state !== 'asleep' && state !== 'waking'}
      crashed={state === 'crashed'}
      benchKeyboard={kb || undefined}
      benchGesture={benchGesture(swipe, zoomAt, ripple)}
      contentTheme={contentTheme}
      className="min-h-0 flex-1"
    />
  )
}

/** `?swipe=`/`?zoom=`/`?ripple=` → the state a finger would have produced.
 *
 *  The peek's `offset` is computed by the SAME `rubberBand` the gesture uses,
 *  from the same commit distance, so what the rig captures is the curve that
 *  ships — not a plausible-looking number typed into a bench. */
function benchGesture(
  swipe: string,
  zoomAt: number,
  ripple: boolean,
): { peek?: EdgePeek; zoom?: number; ripple?: boolean } | undefined {
  const [edge, at] = swipe.split(':')
  const progress = Math.min(1, Math.max(0, Number(at ?? '') || 0.62))
  const peek: EdgePeek | undefined =
    edge === 'left' || edge === 'right'
      ? {
          edge,
          progress,
          armed: progress >= 1,
          // 390px is the mandated baseline and the width the phone frame is,
          // so the offset the rig sees is the offset a thumb would produce.
          offset: rubberBand(progress * commitDistance(390), commitDistance(390)),
        }
      : undefined
  if (!peek && !zoomAt && !ripple) return undefined
  return { peek, zoom: zoomAt || undefined, ripple: ripple || undefined }
}
