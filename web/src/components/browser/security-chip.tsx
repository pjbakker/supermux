// THE PADLOCK — and what it is honestly allowed to claim.
//
// THREE STATES, AND THE MIDDLE ONE IS THE POINT:
//
//   https:  → padlock, emerald.        "the transport is encrypted"
//   http:   → "Not secure", IN WORDS, amber. Not a neutral grey globe: a plain
//             globe under-reports, and under-reporting is the failure mode that
//             matters — this workspace lends signed-in tabs to agents, so the
//             one thing the chip must never do is make a cleartext page look
//             unremarkable.
//   nothing → neutral globe, no claim at all. A tab that is asleep has no
//             connection to be encrypted, and a padlock over a page that is not
//             open is a lie about a connection that does not exist.
//
// WHAT IT IS NOT. `secure` is TRANSPORT ONLY, and the server says so where it
// is computed (`secure_scheme`): it answers "is this connection encrypted", it
// does NOT answer "is this certificate trusted". So the panel says exactly that
// in words, rather than letting a green padlock imply the stronger claim every
// consumer browser has spent a decade walking back.
//
// THE PANEL IS WHERE `origins` FINALLY MAKES SENSE. Tapping the chip shows the
// tab's origin allowlist — the hosts on which agents may use this tab — next to
// the host the human is actually on. That adjacency is the whole explanation:
// it is the moment somebody understands why their agent "can't see" the page
// they just navigated to, and the Manage link is one tap from there.
import { Globe, Lock, ShieldAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import { tabHost } from '@/lib/api/browser'

/** The chip's three states, resolved once so the trigger and the panel can
 *  never disagree about which one is being drawn. */
export type SecurityTone = 'secure' | 'insecure' | 'none'

export function securityTone(url: string, secure: boolean, live: boolean): SecurityTone {
  // No page, or nothing attached: no connection to make a claim about.
  if (!live || !url) return 'none'
  if (secure) return 'secure'
  // A page that is live and NOT https is cleartext, and it gets said out loud.
  return url.toLowerCase().startsWith('http://') ? 'insecure' : 'none'
}

export interface SecurityChipProps {
  tone: SecurityTone
  open: boolean
  onToggle: () => void
  className?: string
}

/** The leading affordance INSIDE the address bar. Trigger only — the panel is a
 *  sibling of the field (see `address-bar.tsx`), because the field itself is
 *  `overflow-hidden` for the loading hairline and would clip a popover. */
export function SecurityChip({ tone, open, onToggle, className }: SecurityChipProps) {
  const label =
    tone === 'secure'
      ? 'Connection is encrypted — site information'
      : tone === 'insecure'
        ? 'Not secure — site information'
        : 'No page — site information'
  return (
    <button
      type="button"
      // Blur-before-click would restore the field and close the panel out from
      // under the tap, exactly like the clear button next door.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      aria-label={label}
      title={label}
      aria-expanded={open}
      data-security-chip={tone}
      className={cn(
        'relative flex shrink-0 items-center gap-1 rounded-md px-0.5 py-0.5 after:absolute after:-inset-2 after:content-[\'\']',
        tone === 'insecure' && 'text-amber-600 dark:text-amber-500',
        tone === 'secure' && 'text-emerald-600',
        tone === 'none' && 'text-muted-foreground',
        className,
      )}
    >
      {tone === 'secure' ? (
        <Lock className="size-4 shrink-0" aria-hidden />
      ) : tone === 'insecure' ? (
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
      ) : (
        <Globe className="size-4 shrink-0" aria-hidden />
      )}
      {/* The words only appear for the state that needs them. An always-on
          label would cost a 390px address bar four characters of host. */}
      {tone === 'insecure' && (
        <span className="text-[11px] font-medium leading-none">Not secure</span>
      )}
    </button>
  )
}

export interface SecurityPanelProps {
  tone: SecurityTone
  url: string
  /** The tab's origin allowlist — the hosts agents may use this tab on. */
  origins: string[]
  /** The tab's own state line (`tabState().detail`) — the evidence and its age,
   *  which is why the chrome no longer needs a third row for it. */
  detail?: string
  /** How many agents this tab is lent to right now. */
  lent?: number
  /** Open the grant sheet — where origins and grants are actually edited. */
  onManage?: () => void
  onClose: () => void
  className?: string
}

/** The popover. Deliberately small: everything editable lives in the grant
 *  sheet, and this is the read-only summary that points at it. */
export function SecurityPanel({
  tone,
  url,
  origins,
  detail,
  lent,
  onManage,
  onClose,
  className,
}: SecurityPanelProps) {
  const host = url ? tabHost(url) : ''
  const covered = host
    ? origins.some((o) =>
        o.startsWith('.') ? host === o.slice(1) || host.endsWith(o) : host === o,
      )
    : false

  return (
    <div
      role="dialog"
      aria-label="Site information"
      data-security-panel={tone}
      className={cn(
        'absolute inset-x-0 top-full z-20 mt-1 flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3 shadow-lg',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {tone === 'secure' ? (
          <Lock className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        ) : tone === 'insecure' ? (
          <ShieldAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500"
            aria-hidden
          />
        ) : (
          <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12.5px] text-foreground">{host || '—'}</p>
          {/* The exact scope of the claim, in words. A padlock that quietly
              means more than it can prove is the failure this line prevents. */}
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {tone === 'secure'
              ? 'The connection to this site is encrypted. That is a claim about the transport, not about who is on the other end.'
              : tone === 'insecure'
                ? 'This page is served over plain http. Anything typed into it — including a sign-in — travels unencrypted.'
                : 'No page is open, so there is no connection to describe.'}
          </p>
        </div>
      </div>

      {detail && (
        <p data-security-state="" className="text-[11.5px] text-muted-foreground">
          {detail}
        </p>
      )}

      <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Agents may use this tab on
        </p>
        {origins.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">
            Nothing yet — this tab is not usable by an agent anywhere.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {origins.map((o) => (
              <span
                key={o}
                data-security-origin={o}
                className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {o}
              </span>
            ))}
          </div>
        )}
        {/* THE CROSS-ORIGIN NUDGE. A human navigation that landed off the
            allowlist is not blocked — the human owns the browser — but it is
            said, once, right where `origins` is explained. */}
        {host && !covered && (
          <p
            data-security-offlist=""
            className="text-[11.5px] text-amber-600 dark:text-amber-500"
          >
            {`Agents can't use this tab on ${host}. Add it under Manage.`}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-muted-foreground">
          {lent === undefined ? '' : lent === 0 ? 'Not lent to anyone' : `Lent to ${lent}`}
        </span>
        <div className="flex items-center gap-1.5">
          {onManage && (
            <button
              type="button"
              onClick={() => {
                onClose()
                onManage()
              }}
              className="min-h-9 rounded-lg border border-border px-3 text-[12.5px] text-foreground hover:border-primary"
            >
              Manage
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            data-security-close=""
            className="min-h-9 rounded-lg px-3 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
