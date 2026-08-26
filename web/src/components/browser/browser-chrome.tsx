// The browser CHROME — always mounted, always truthful.
//
// THE DESIGN PRINCIPLE, IN ONE LINE: the chrome is persistent and the page is
// the only thing that changes. It never disappears because the tab is asleep —
// it REPORTS that the tab is asleep and offers the one button that fixes it.
//
// That is the structural half of the "I enter an address, it doesn't work"
// complaint. The chrome this replaces lived INSIDE the takeover panel's header
// slot, so it existed only while a tab was live — and since nothing a human
// could do made a tab live, from a cold start the address bar was unreachable
// by construction. Here it is a sibling of the viewport, mounted for a live
// tab, an asleep tab and no tab at all.
//
// LAYOUT — ONE `flex-wrap` ROW THAT IS TWO ROWS ON A PHONE. 390px first:
//
//   ┌──────────────────────────────────────────────┐
//   │ 🔒 mail.example/inbox                 ×   ⋯  │  the omnibox (basis-full)
//   │ ◀ ▶ ⟳ │ ⏻ ⤢          [ Watch | Drive ]        │  the verbs (wrapped)
//   │ Signed in · verified 6 min ago                │  the evidence
//   └──────────────────────────────────────────────┘
//
// …and on ≥md the address bar stops being `basis-full`, so the whole thing
// collapses to the single toolbar row a desktop browser has:
//
//   ◀ ▶ ⟳ │ 🔒 mail.example/inbox …  × ⋯ │ ⏻ ⤢ [Watch|Drive] 2 👤
//
// `order-*` is what keeps the omnibox FIRST on the phone (thumb-reachable, and
// the thing you came here to use) and SECOND on desktop (where the arrows have
// been on the left since Mosaic). One DOM order, two readings, no duplication.
//
// Row 2's power cell is a TOGGLE, not two different buttons: Wake on an asleep
// tab, "Put to sleep" on a live one — one cell, two states, so waking a tab
// does not reflow the row the human is looking at. Reload/Stop, Back, Forward
// and Resync keep their own cells and grey out while there is no page, for the
// same reason.
import * as React from 'react'

import { ClipboardPaste, KeyRound, MoreHorizontal, Power, UserPlus, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { activeGrantees, tabState, type BrowserTab } from '@/lib/api/browser'
import { EMPTY_NAV, type NavState } from '@/lib/browser/nav-state'
import { AddressBar } from '@/components/browser/address-bar'
import { ChromeButton } from '@/components/browser/chrome-button'
import { NavControls } from '@/components/browser/nav-controls'

/** The state line is tinted by tone for the same reason the dot is: an expired
 *  tab that reads in the same grey as a healthy one is a state nobody notices. */
const STATE_TINT: Record<string, string> = {
  ok: 'text-muted-foreground',
  'needs-login': 'text-amber-600 dark:text-amber-500',
  dehydrated: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
}

export interface BrowserChromeProps {
  /** `null` = no tab at all. The bar still stands; Enter mints one. */
  tab: BrowserTab | null
  /** The page's real url — the nav-state feed's when a socket is attached. */
  url: string
  /** A live CDP target exists right now. */
  live: boolean
  /**
   * THE LIVE PAGE, as the socket reports it: title, favicon, spinner, honest
   * back/forward affordances, the padlock. [[EMPTY_NAV]] (every flag false)
   * whenever nothing is attached, which is what greys the arrows instead of
   * letting them claim a history nobody has read.
   */
  nav?: NavState
  /** The human holds the wheel (the socket's `human_driving`). */
  driving: boolean
  /** The socket is live, so Drive can succeed. */
  canDrive: boolean
  /** A navigate / wake / create MUTATION is in flight. Distinct from the page's
   *  own `nav.loading`; both light the hairline. */
  busy?: boolean
  /** Bump to put the caret in the omnibox (the `+` cell does). */
  focusKey?: number
  /** Every open tab — the omnibox suggests switching to one rather than
   *  opening a second copy of a page that is already signed in. */
  tabs?: BrowserTab[]
  onSwitchTab?: (id: string) => void
  /** Resolved destination from the omnibox — a page url or a search url. */
  onNavigate: (url: string) => void
  /** Wake a dehydrated tab where it stands (`POST …/open`). */
  onWake: () => void
  /** Close the PAGE and keep the tab (`POST …/close`) — the inverse of wake.
   *  Absent = the host has no such verb and the toggle greys out. */
  onSleep?: () => void
  /** `hard` = ignore the cache (press-and-hold / right-click on Reload). */
  onReload: (hard?: boolean) => void
  onBack?: () => void
  onForward?: () => void
  onStop?: () => void
  /** Type the clipboard into the focused page field (driving only). */
  onPaste?: () => void
  /** Open the field-aware sign-in sheet (driving only). */
  onSignIn?: () => void
  /** When set, Sign-in is disabled and carries this reason (no login form on the
   *  page / the form is in a cross-origin frame). */
  signInDisabledReason?: string
  onWatch: () => void
  onDrive: () => void
  onMenu: () => void
  /** PHASE 4 — the ⋯ beside the omnibox opens the PAGE MENU at a point (find,
   *  copy link, reload, sharing…). Absent = it opens the sheet directly, which
   *  is what phases 1-3 did. */
  onPageMenu?: (at: { x: number; y: number }) => void
  className?: string
}

export function BrowserChrome({
  tab,
  url,
  live,
  nav = EMPTY_NAV,
  driving,
  canDrive,
  busy,
  focusKey,
  tabs,
  onSwitchTab,
  onNavigate,
  onWake,
  onSleep,
  onReload,
  onBack,
  onForward,
  onStop,
  onPaste,
  onSignIn,
  signInDisabledReason,
  onWatch,
  onDrive,
  onMenu,
  onPageMenu,
  className,
}: BrowserChromeProps) {
  /** The omnibox has the caret. On DESKTOP the toolbar yields to it — the field
   *  grows and the verbs recede — which is the §5.8 "focus expand" on the
   *  surface that has room for it. On a phone the bar is already `basis-full`,
   *  so there the same state only softens the row below it. */
  const [typing, setTyping] = React.useState(false)
  const state = tab ? tabState(tab) : null
  const lent = tab ? activeGrantees(tab).length : 0
  // Two different facts, one hairline: OUR mutation is in flight, or the PAGE
  // is loading. Both mean "something is on its way", and the human does not
  // care which side of the socket it is on.
  const loading = !!busy || nav.loading

  return (
    <div
      data-browser-chrome=""
      data-chrome-typing={typing ? '' : undefined}
      className={cn(
        'relative flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-3 py-2',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <NavControls
          canGoBack={nav.canGoBack}
          canGoForward={nav.canGoForward}
          loading={nav.loading}
          disabled={!tab || !live}
          onBack={() => onBack?.()}
          onForward={() => onForward?.()}
          onReload={onReload}
          onStop={() => onStop?.()}
          className="order-2 md:order-1"
        />
        {/* The omnibox and the tab's ⋯ share a cell, and that cell is
            `basis-full` on a phone — which is what wraps the verbs onto their
            own row. On ≥md it lets go and the toolbar becomes one line, capped
            so a 1920px window does not stretch one URL across the screen. */}
        <div
          className={cn(
            'order-1 flex min-w-0 basis-full items-center gap-2 transition-[max-width] duration-150 ease-out md:order-2 md:min-w-[16rem] md:flex-1 md:basis-auto motion-reduce:transition-none',
            typing ? 'md:max-w-[72rem]' : 'md:max-w-[56rem]',
          )}
        >
          <AddressBar
            url={url}
            live={live}
            secure={live ? nav.secure : undefined}
            loading={loading}
            focusKey={focusKey}
            tabs={tabs}
            onSwitchTab={onSwitchTab}
            origins={tab?.origins ?? []}
            stateDetail={state?.detail}
            lent={tab ? lent : undefined}
            onManage={tab ? onMenu : undefined}
            onNavigate={onNavigate}
            onEditing={setTyping}
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={(e) => {
              if (!onPageMenu) {
                onMenu()
                return
              }
              // Anchored under the BUTTON, not at the click point: a keyboard
              // "click" carries (0,0) and would open the menu in the corner.
              const r = e.currentTarget.getBoundingClientRect()
              onPageMenu({ x: r.left, y: r.bottom + 6 })
            }}
            disabled={!tab}
            aria-haspopup={onPageMenu ? 'menu' : undefined}
            aria-label={onPageMenu ? 'Page menu' : 'Tab settings and sharing'}
            data-chrome-page-menu=""
            className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground after:absolute after:-inset-2 after:content-[''] transition-colors hover:bg-secondary hover:text-foreground active:scale-95 disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </div>
        {/* The verbs. `flex-wrap` + `justify-end` is the guarantee, not the
            layout: at 390px the cells below FIT (that is measured, not hoped),
            and if a future label or a 320px phone ever makes them not fit, they
            wrap onto another line instead of pushing the document sideways —
            the one thing this app's layout rules never allow. */}
        <div data-chrome-verbs="" className="order-3 flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 md:flex-none md:gap-1.5">
          {live ? (
            <ChromeButton
              label="Put the page to sleep"
              icon={Power}
              disabled={!tab || busy || !onSleep}
              onClick={() => onSleep?.()}
              data-chrome-sleep=""
            />
          ) : (
            <ChromeButton
              label="Wake tab"
              icon={Power}
              disabled={!tab || busy}
              onClick={onWake}
              data-chrome-wake=""
            />
          )}
          {/* One slot, context-appropriate. WHILE DRIVING it holds Paste +
              Sign-in — a canvas cannot be autofilled (the human's clipboard and
              password manager cannot see fields that live in a picture), so they
              reach the page from HERE rather than floating over — and covering —
              the page's own buttons. WHILE WATCHING it holds the SHARE affordance:
              the toolbar's own way in to "Who may use this tab", so handing a bot
              this tab is one tap from the surface you are already looking at
              (and reachable on a phone, where the desktop-only lent-count is not). */}
          {driving ? (
            <>
              <ChromeButton
                label="Paste into the focused field"
                icon={ClipboardPaste}
                disabled={!live || !onPaste}
                onClick={() => onPaste?.()}
                data-chrome-paste=""
              />
              {/* Disabled with a reason when the page has no login form (the
                  smart sign-in's "not usable when there are no fields"); it still
                  opens the sheet on tap so the reason is legible on a phone. */}
              <ChromeButton
                label={signInDisabledReason ?? 'Sign in to this page'}
                icon={KeyRound}
                disabled={!live || !onSignIn}
                onClick={() => onSignIn?.()}
                data-chrome-signin=""
                data-signin-disabled={signInDisabledReason ? '' : undefined}
              />
            </>
          ) : (
            <ChromeButton
              label="Give a bot access to this tab"
              icon={UserPlus}
              disabled={!tab}
              onClick={onMenu}
              data-chrome-grant=""
            />
          )}
          {/* No flex-1 spacer here: in a WRAPPING row a growing spacer eats
              the first line and pushes the Watch/Drive pair onto a second one.
              `justify-end` on the group does the same job without competing
              for width. */}
          {/* Watch / Drive. Watch is not "off" — frames keep flowing; it is the
              state in which the agent still owns the wheel. Hidden only when
              there is no tab at all: an asleep tab keeps the pair (disabled, so
              waking it does not reflow the row), but with nothing open there is
              no wheel to have an opinion about. */}
          {tab && (
            <div
              role="radiogroup"
              aria-label="Who is driving"
              data-drive-mode={driving ? 'human' : 'agent'}
              className="inline-flex shrink-0 items-stretch gap-0.5 rounded-xl bg-secondary p-1"
            >
              <DriveButton selected={!driving} label="Watch" onClick={onWatch} />
              <DriveButton
                selected={driving}
                label="Drive"
                disabled={!canDrive}
                onClick={onDrive}
              />
            </div>
          )}
          {tab && (
            <button
              type="button"
              onClick={onMenu}
              data-tab-lent={lent}
              // Hidden on a phone, where the row cannot afford 70px for a
              // count: the same fact is one tap away in the security chip's
              // panel ("Lent to 2") and in the sheet the ⋯ opens. Nothing is
              // lost, and the row stays inside 390px.
              className="relative hidden min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-[11.5px] text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground md:inline-flex"
            >
              <Users className="size-3.5" aria-hidden />
              {lent === 0 ? 'Not lent' : `${lent}`}
            </button>
          )}
        </div>
      </div>

      {/* The state gets a row of its own rather than a share of the toolbar: at
          390px the Watch/Drive pair already owns that line, and a truncated
          "Signed in · verifi…" is the bare green dot §7.3 forbids — the age IS
          the evidence, so it must not be the half that is cut. The same line is
          repeated inside the security chip's panel, which is where somebody
          looking for it will actually go. */}
      {/* THE LOADING HAIRLINE — 2px along the bottom of the chrome, and the
          only thing that signals a load. It is deliberately NOT over the page:
          the page is the thing you are trying to look at. Indeterminate,
          because a relayed page's progress is not a number anybody has, and a
          fake percentage would be the one dishonest pixel here. */}
      {loading && (
        <span
          aria-hidden
          data-chrome-hairline=""
          className="sm-browser-hairline pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
        />
      )}

      <p
        data-tab-state={state?.tone ?? 'none'}
        className={cn(
          'min-w-0 truncate text-[11.5px]',
          state ? STATE_TINT[state.tone] : 'text-muted-foreground',
        )}
      >
        {state ? state.detail : 'No tab open — type an address and press Go.'}
      </p>
    </div>
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
        'inline-flex min-h-9 items-center rounded-lg px-2.5 text-[12.5px] font-medium transition-colors motion-reduce:transition-none md:px-3',
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
