/**
 * SEND LATER — the delay chooser, in the composer's two shells.
 * ─────────────────────────────────────────────────────────────────────────────
 * One authored list (`DELAY_OPTIONS`), two surfaces, the same fork the `+` menu
 * already makes and for the same reason: a coarse pointer gets the thumb-reachable
 * Vaul sheet (`MobileActionSheet` — backdrop, drag-to-dismiss, safe-area), a fine
 * one gets the anchored Radix popover in the composer's own glass (focus trap,
 * Esc, outside-click, return-focus). Neither shell authors a row: they draw the
 * options the composer hands them, so the phone and the desktop can never offer
 * different delays.
 *
 * EACH ROW SAYS WHAT TIME IT IS. "In 1 hour" is arithmetic; "In 1 hour · 14:35"
 * is a decision — the row carries the wall-clock moment the message actually
 * lands, in the reader's own locale and 12/24h convention, so nobody has to do
 * the sum while holding a half-typed thought.
 *
 * THE LAST ROW IS THE DOOR OUT. Three round numbers cover the case this feature
 * exists for; anything else — a date, a recurrence, another session — belongs to
 * the Schedules sheet, and `onPickTime` opens it with the same draft carried
 * over. So the ladder from "in an hour" to a real job is one tap, never a fork.
 */
import * as React from 'react'
import { CalendarClock, Clock } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MobileActionSheet } from '../focus-mode/mobile-action-sheet'
import { PopoverContent } from '../ui/popover'
import { arrivalLabel, type DelayOption } from './delay-send'

export interface DelaySendMenuProps {
  /** The delays to offer, in order. */
  options: readonly DelayOption[]
  /** The clock the arrival times are computed against. */
  nowMs: number
  /**
   * The delay rows cannot act right now — a write is in flight, or the same gate
   * that greys the trailing clock has closed (`delay-send.ts::delayGateReason`).
   *
   * LIVE, not read once at open: a file dropped on the composer or a session
   * that goes blocked while this menu is up must take the rows with it, or the
   * menu would file a schedule the control that opened it says is unavailable.
   */
  disabled?: boolean
  /** Why, when there is a reason worth saying out loud (the gate's sentence). */
  reason?: string
  onPick: (option: DelayOption) => void
  /** Open the full Schedules sheet with this draft; omitted → no row. */
  onPickTime?: () => void
}

/** The sheet's / popover's own title — one phrase, both shells. */
const TITLE = 'Send later'

// ── fine pointer: the anchored popover ───────────────────────────────────────

export function DelaySendPopover({
  options,
  nowMs,
  disabled,
  reason,
  onPick,
  onPickTime,
  onClose,
}: DelaySendMenuProps & { onClose: () => void }) {
  // Roving ↑/↓ (wrap) + Home/End over real `menuitem` buttons — the same
  // keyboard model `chat-actions-menu.tsx` uses, so the two menus behave
  // identically under a screen reader.
  const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const { key } = e
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-menu-row]'),
    )
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (key === 'Home') next = 0
    else if (key === 'End') next = items.length - 1
    else if (key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length
    else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }, [])

  const run = React.useCallback(
    (fn: () => void) => {
      fn()
      onClose()
    },
    [onClose],
  )

  return (
    <PopoverContent
      side="top"
      // `end`: the trigger is the LAST disc on the bar, so a menu that grew to
      // the right would leave the pane. It grows from its own corner instead.
      align="end"
      sideOffset={10}
      collisionPadding={12}
      role="menu"
      aria-label={TITLE}
      onKeyDown={onKeyDown}
      onCloseAutoFocus={(e) => e.preventDefault()}
      className={cn(
        // The composer's own glass — the same recipe the `+` menu wears, so the
        // two surfaces read as the same material lifting off the same bar.
        'w-[248px] rounded-2xl border-[0.5px] border-hairline bg-surface p-1.5',
        'backdrop-blur-[60px] backdrop-saturate-[180%] shadow-[var(--sm-popover-shadow)]',
        'origin-[100%_100%] text-ink motion-reduce:animate-none',
      )}
    >
      <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-2">
        {TITLE}
      </p>
      {options.map((option) => (
        <MenuRow
          key={option.key}
          icon={Clock}
          label={option.label}
          hint={arrivalLabel(nowMs + option.ms)}
          disabled={disabled}
          testId={`chat-delay-${option.key}`}
          onRun={() => run(() => onPick(option))}
        />
      ))}
      {disabled && reason && (
        <p
          data-testid="chat-delay-reason"
          className="px-2 pb-1 pt-0.5 text-[11.5px] leading-snug text-ink-2"
        >
          {reason}.
        </p>
      )}
      {onPickTime && (
        <>
          <div className="my-1 h-px bg-border/60" role="separator" />
          <MenuRow
            icon={CalendarClock}
            label="Pick a time…"
            testId="chat-delay-pick-time"
            onRun={() => run(onPickTime)}
          />
        </>
      )}
    </PopoverContent>
  )
}

/** One popover row — icon tile, label, and the arrival time as the key hint. */
function MenuRow({
  icon: Icon,
  label,
  hint,
  disabled,
  testId,
  onRun,
}: {
  icon: typeof Clock
  label: string
  hint?: string
  disabled?: boolean
  testId: string
  onRun: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row=""
      data-testid={testId}
      disabled={disabled}
      onClick={onRun}
      className={cn(
        'flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left',
        'text-ink transition-colors hover:bg-fill-soft focus:bg-fill-soft focus:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <span className="grid size-7 flex-none place-items-center rounded-lg bg-fill-soft text-ink-2">
        <Icon className="size-[17px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{label}</span>
      {hint && <span className="flex-none text-[11.5px] tabular-nums text-ink-2">{hint}</span>}
    </button>
  )
}

// ── coarse pointer: the bottom sheet ─────────────────────────────────────────

export function DelaySendSheet({
  open,
  onOpenChange,
  options,
  nowMs,
  disabled,
  reason,
  onPick,
  onPickTime,
}: DelaySendMenuProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  // Run and dismiss — the sheet is a launcher, not a home. What the user is
  // looking at a beat later is the composer, with the chip on it.
  const run = React.useCallback(
    (fn: () => void) => {
      fn()
      onOpenChange(false)
    },
    [onOpenChange],
  )
  return (
    <MobileActionSheet open={open} onOpenChange={onOpenChange} title={TITLE}>
      <div className="flex flex-col px-2 pb-2 pt-1">
        {options.map((option) => (
          <SheetRow
            key={option.key}
            icon={Clock}
            label={option.label}
            hint={arrivalLabel(nowMs + option.ms)}
            disabled={disabled}
            testId={`chat-delay-${option.key}`}
            onTap={() => run(() => onPick(option))}
          />
        ))}
        {disabled && reason && (
          <p
            data-testid="chat-delay-reason"
            className="px-3 pb-1 pt-1 text-[12.5px] leading-snug text-muted-foreground"
          >
            {reason}.
          </p>
        )}
        {onPickTime && (
          <>
            <div className="my-1.5 h-px bg-border/60" />
            <SheetRow
              icon={CalendarClock}
              label="Pick a time…"
              testId="chat-delay-pick-time"
              onTap={() => run(onPickTime)}
            />
          </>
        )}
      </div>
    </MobileActionSheet>
  )
}

/** One sheet row — the 44pt target the `+` sheet's rows are, same materials. */
function SheetRow({
  icon: Icon,
  label,
  hint,
  disabled,
  testId,
  onTap,
}: {
  icon: typeof Clock
  label: string
  hint?: string
  disabled?: boolean
  testId: string
  onTap: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onTap}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left',
        // `tap-transparent`: iOS paints its native tap-flash against the row's
        // document box inside Vaul's transformed content — offset from the row
        // that was pressed. The composited `active:bg` is the honest feedback.
        'tap-transparent active:bg-muted/60 disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted/60 text-foreground">
        <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{label}</span>
      {hint && (
        <span className="flex-none text-[12.5px] tabular-nums text-muted-foreground">{hint}</span>
      )}
    </button>
  )
}

export default DelaySendPopover
