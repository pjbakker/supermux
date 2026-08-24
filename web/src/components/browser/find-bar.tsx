// FIND IN PAGE — the shell, and the honest disabled state under it.
//
// THIS BAR CANNOT WORK YET AND IT SAYS SO. Find needs the page's DOM
// (`DOM.performSearch` inside the profile that is signed in), which the relay
// does not expose: `ClientMsg::Find` / `FindClose` and `ServerMsg::FindResult`
// + `Caps` are the four frames it is waiting on, spelled out in
// `lib/browser/page-tools.ts`. Until a `caps` frame says otherwise the field is
// DISABLED with the reason on it, and nothing is put on the wire that would be
// silently dropped — which is the difference between "not built yet" and a
// search box that spins forever.
//
// WHAT DOES WORK TODAY, in the same bar, on purpose: **Copy link**. The url is
// a fact this client already holds, so the bar ships with one control that
// works and one that explains itself. A surface where every control is dead
// teaches people to stop pressing things.
//
// MOBILE-FIRST. One row, 44px tall, a 16px field (anything smaller and iOS
// zooms the whole shell — the bug the address bar was fixed for in phase 1),
// and the count between the field and the arrows so a thumb never covers it.
// At 320px the label collapses to the count alone and nothing wraps.
//
// KEYS. Enter = next, ⇧Enter = previous, Escape = close and give focus back to
// the page. The same three every find bar has had for thirty years.
import * as React from 'react'

import { ChevronDown, ChevronUp, Link2, TextSelect, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { findLabel, type FindResult, type PageCaps } from '@/lib/browser/page-tools'

export interface FindBarProps {
  query: string
  onQuery: (q: string) => void
  result: FindResult
  /** What this relay can actually do. Both false today. */
  caps: PageCaps
  /** A find is on the wire and has not been answered. */
  searching?: boolean
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  /** Works today — the url is a fact the client holds. */
  onCopyUrl: () => void
  /** Needs `ClientMsg::Copy`; greyed with the reason until then. */
  onCopySelection: () => void
  /** The last copy landed — a 1.5s receipt, because a clipboard write is
   *  invisible and a button that does nothing visible reads as broken. */
  copied?: string | null
  /** Bump to put the caret in the field. */
  focusKey?: number
  className?: string
}

export function FindBar({
  query,
  onQuery,
  result,
  caps,
  searching,
  onNext,
  onPrev,
  onClose,
  onCopyUrl,
  onCopySelection,
  copied,
  focusKey = 0,
  className,
}: FindBarProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  React.useEffect(() => {
    if (!focusKey) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusKey])

  const label = findLabel(result, query, !!searching)
  const none = !!query && caps.find && result.query === query && result.total === 0

  return (
    <div
      data-find-bar=""
      data-find-supported={caps.find ? '' : undefined}
      className={cn(
        'flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-3 py-1.5',
        className,
      )}
    >
      <div
        className={cn(
          'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border bg-background px-2.5',
          none ? 'border-amber-500' : 'border-border focus-within:border-primary',
        )}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={!caps.find}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            }
          }}
          placeholder={caps.find ? 'Find in page' : 'Find needs a server update'}
          aria-label="Find in page"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          data-find-input=""
          className="min-w-0 flex-1 bg-transparent text-[16px] leading-none text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {label && (
          <span
            data-find-count={label}
            className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground"
          >
            {label}
          </span>
        )}
      </div>
      <FindButton
        label="Previous match"
        icon={ChevronUp}
        disabled={!caps.find || result.total === 0}
        onClick={onPrev}
      />
      <FindButton
        label="Next match"
        icon={ChevronDown}
        disabled={!caps.find || result.total === 0}
        onClick={onNext}
      />
      {/* The one that works today, kept beside the one that does not so the
          difference is visible rather than explained. */}
      <FindButton
        label={copied === 'url' ? 'Link copied' : 'Copy link'}
        icon={Link2}
        active={copied === 'url'}
        onClick={onCopyUrl}
        testId="find-copy-url"
      />
      <FindButton
        label={
          caps.copy
            ? copied === 'selection'
              ? 'Selection copied'
              : 'Copy the page selection'
            : 'Copying the page selection needs a server update'
        }
        icon={TextSelect}
        active={copied === 'selection'}
        disabled={!caps.copy}
        onClick={onCopySelection}
        testId="find-copy-selection"
      />
      <FindButton label="Close find" icon={X} onClick={onClose} testId="find-close" />
    </div>
  )
}

function FindButton({
  label,
  icon: Icon,
  disabled,
  active,
  onClick,
  testId,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  disabled?: boolean
  active?: boolean
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-find-button={testId}
      className={cn(
        // 32px of ink, 44px of hit box — the same trick `ChromeButton` uses, so
        // five controls still fit inside 320px.
        "relative flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground after:absolute after:-inset-1.5 after:content-[''] transition-colors hover:text-foreground disabled:opacity-40 motion-reduce:transition-none",
        active && 'text-emerald-600 dark:text-emerald-500',
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}
