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
// LAYOUT (390px first, and it must not overflow there):
//
//   ┌──────────────────────────────────────────────┐
//   │ 🔒 mail.example/inbox                 ×   ⋯  │  row 1 · 44px  the omnibox
//   │ ⟳  ⤢                    [ Watch | Drive ] 2👤│  row 2 · 44px  the verbs
//   │ Signed in · verified 6 min ago                │  row 3         the evidence
//   └──────────────────────────────────────────────┘
//
// Row 2's left slot is a POWER TOGGLE, not two different buttons: Wake on an
// asleep tab, "Put to sleep" on a live one — one cell, two states, so waking a
// tab does not reflow the row the human is looking at. Reload and Resync keep
// their own cells and grey out while there is no page, for the same reason.
import * as React from 'react'

import { Aperture, MoreHorizontal, Power, RotateCw, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { activeGrantees, tabState, type BrowserTab } from '@/lib/api/browser'
import { AddressBar } from '@/components/browser/address-bar'

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
  /** The page's real url — the live socket's snapshot when it has one. */
  url: string
  /** A live CDP target exists right now. */
  live: boolean
  /** The human holds the wheel (the socket's `human_driving`). */
  driving: boolean
  /** The socket is live, so Drive can succeed. */
  canDrive: boolean
  /** A navigate / wake / create is in flight. */
  busy?: boolean
  /** Bump to put the caret in the omnibox (the `+` cell does). */
  focusKey?: number
  /** Resolved destination from the omnibox — a page url or a search url. */
  onNavigate: (url: string) => void
  /** Wake a dehydrated tab where it stands (`POST …/open`). */
  onWake: () => void
  /** Close the PAGE and keep the tab (`POST …/close`) — the inverse of wake.
   *  Absent = the host has no such verb and the toggle greys out. */
  onSleep?: () => void
  /** Re-navigate to the current url. Real back/forward/stop are Phase 3. */
  onReload: () => void
  /** Ask the socket for a fresh full frame — the picture, not the page. */
  onResync?: () => void
  onWatch: () => void
  onDrive: () => void
  onMenu: () => void
  className?: string
}

export function BrowserChrome({
  tab,
  url,
  live,
  driving,
  canDrive,
  busy,
  focusKey,
  onNavigate,
  onWake,
  onSleep,
  onReload,
  onResync,
  onWatch,
  onDrive,
  onMenu,
  className,
}: BrowserChromeProps) {
  const state = tab ? tabState(tab) : null
  const lent = tab ? activeGrantees(tab).length : 0

  return (
    <div
      data-browser-chrome=""
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-3 py-2',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AddressBar
          url={url}
          live={live}
          loading={busy}
          focusKey={focusKey}
          onNavigate={onNavigate}
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          onClick={onMenu}
          disabled={!tab}
          aria-label="Tab settings and sharing"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground disabled:opacity-40"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2">
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
        <ChromeButton
          label="Reload"
          icon={RotateCw}
          disabled={!live || busy}
          onClick={onReload}
          data-chrome-reload=""
        />
        {/* Not the page — the PICTURE. `resync` asks the socket for a fresh full
            frame, which is the fix for a canvas that has drifted, and it has
            been implemented and unwired since the panel was written. A distinct
            icon from Reload on purpose: they repair different things. */}
        <ChromeButton
          label="Refresh the picture"
          icon={Aperture}
          disabled={!live || !onResync}
          onClick={() => onResync?.()}
          data-chrome-resync=""
        />
        <span className="min-w-0 flex-1" />
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
            className="relative inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-[11.5px] text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground"
          >
            <Users className="size-3.5" aria-hidden />
            {lent === 0 ? 'Not lent' : `${lent}`}
          </button>
        )}
      </div>

      {/* The state gets a row of its own rather than a share of row 2: at 390px
          the Watch/Drive pair already owns that line, and a truncated
          "Signed in · verifi…" is the bare green dot §7.3 forbids — the age IS
          the evidence, so it must not be the half that is cut. */}
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

/** A 36px icon button with a 44px+ hit box — the invisible `::after` trick the
 *  tab strip already uses, so the target is thumb-sized without the row being
 *  44px of border. The words live on `aria-label` + `title`. */
function ChromeButton({
  label,
  icon: Icon,
  disabled,
  onClick,
  ...rest
}: {
  label: string
  icon: typeof RotateCw
  disabled?: boolean
  onClick: () => void
} & React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground after:absolute after:-inset-1 after:content-[''] hover:text-foreground disabled:opacity-40"
      {...rest}
    >
      <Icon className="size-4" aria-hidden />
    </button>
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
