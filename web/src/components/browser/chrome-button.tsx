// One icon button, shared by every row of the browser chrome.
//
// 36px OF INK, 44px OF HIT BOX. The invisible `::after { inset: -1 }` is the
// same trick the tab rail uses: the target is thumb-sized without the row being
// 44px of visible border, which is what lets the whole chrome stay compact on a
// 390px phone while still passing the project's touch-target rule.
//
// DISABLED, NEVER HIDDEN. Back on the first page of a history, Reload with no
// page, Resync with no socket — all of them grey out and keep their cell. A
// control that disappears when it cannot be used reflows the row the human is
// aiming at, which is worse than a grey button in every case.
import * as React from 'react'

import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface ChromeButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type'> {
  /** The words. Lives on `aria-label` + `title`; the button itself is an icon. */
  label: string
  icon: LucideIcon
  disabled?: boolean
  onClick: () => void
  /** Press-and-hold handlers (the reload button's hard-reload). */
  press?: Partial<React.HTMLAttributes<HTMLButtonElement>>
}

export function ChromeButton({
  label,
  icon: Icon,
  disabled,
  onClick,
  press,
  className,
  ...rest
}: ChromeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground after:absolute after:-inset-1 after:content-[\'\'] hover:text-foreground disabled:opacity-40',
        className,
      )}
      {...press}
      {...rest}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  )
}
