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
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastProvider } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserWorkspace } from '@/components/browser/workspace'
import type { BrowserTab } from '@/lib/api/browser'
import type { TakeoverOptions } from '@/lib/browser/takeover-socket'
import { BENCH_BOTS, BENCH_TABS } from './dev-browser-workspace.fixture'

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
  const startTab = params.get('tab')
  const sheet = params.get('sheet') === '1'

  // The takeover fixture carries a 17 KB base64 frame; import it lazily, exactly
  // like the takeover bench does.
  const [options, setOptions] = React.useState<TakeoverOptions | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    void import('./dev-browser-takeover.fixture').then((m) => {
      if (alive) setOptions(m.mockOptions('agent_driving'))
    })
    return () => {
      alive = false
    }
  }, [])

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
                    options={options}
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
                    options={options}
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
  options,
  contentTheme,
}: {
  empty: boolean
  live: boolean
  busy: boolean
  address: string | null
  startTab: string | null
  sheet: boolean
  options?: TakeoverOptions
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
      onSleep={(id) => patch(id, (t) => ({ ...t, live: false }))}
      onOrigins={(id, origins) => patch(id, (t) => ({ ...t, origins }))}
      busy={busy}
      bots={BENCH_BOTS}
      panelOptions={options}
      forceLive={live}
      contentTheme={contentTheme}
      className="min-h-0 flex-1"
    />
  )
}
