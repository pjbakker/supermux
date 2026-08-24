// The omnibox — the one control that turns a row of database CRUD into a
// browser.
//
// THREE DEFECTS ARE FIXED HERE, AND EVERY ONE OF THEM IS AN ATTRIBUTE OR A
// BRANCH, NOT A COAT OF PAINT:
//
//  1. IT CAPITALISES. The box this replaces carried `ref/value/onChange/
//     onKeyDown/placeholder/aria-label/className` and nothing else, so iOS and
//     Android did what they do to an unmarked text field: capitalised the first
//     letter, autocorrected `github` to `GitHub`, offered form-fill, and raised
//     a SENTENCE keyboard with no `/`, no `.`, no `:`. Every attribute below is
//     the direct answer to one of those.
//
//  2. IT ZOOMS. `web/index.html` deliberately ships NO `user-scalable=no` (that
//     is an a11y regression) and says in a comment that the iOS focus-zoom is
//     solved by ≥16px inputs instead. The old box was `text-[12.5px]`, so
//     tapping the address field zoomed and panned the whole supermux shell.
//     This one is 16px on the phone and may only grow.
//
//  3. IT IS NOT AN ADDRESS BAR. The old input existed only while `composing`
//     was true, was always seeded EMPTY, and vanished on submit — a row-creation
//     form wearing an address bar's clothes; the live tab's URL was a read-only
//     `<span>` you could not click. This one is ALWAYS mounted, always shows the
//     current page, is editable for an existing tab, selects on focus, restores
//     on Escape, and clears with a 44px `×`.
//
// AND IT SEARCHES. `normalizeUrl` used to prefix `https://` to anything without
// a scheme, so `how to bake bread` became `https://how to bake bread` → a 400 →
// a red toast reading "a tab needs an http(s) URL". `parseAddress` decides
// between GO and SEARCH the way every browser does, and the leading icon shows
// WHICH ONE the Enter key is about to take, before it is pressed.
//
// ── PHASE 3 ──────────────────────────────────────────────────────────────────
//
// THE FIELD NOW FOLLOWS A LIVE PAGE. `url` used to be the fire-once `target`
// frame's snapshot; it is the `nav_state` feed's url now, so a redirect, an
// OAuth hop or an agent clicking a link all move the address bar — EXCEPT while
// the human is editing it, which is what `draft !== null` has always meant. A
// bar that overwrites what somebody is typing because the page moved is worse
// than a stale one.
//
// THE LEAD ICON GREW A PANEL (`SecurityChip`), and the parse grew a list
// (`OmniboxSuggestions`). Both are the same idea as the lead icon itself: show
// the human what is true and what the next keystroke will do, in the place they
// are already looking.
import * as React from 'react'

import { Globe, Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { displayUrl, isSecure, parseAddress, type AddressIntent, type BrowserTab } from '@/lib/api/browser'
import { moveHighlight, omniboxRows, type OmniboxRow } from '@/lib/browser/omnibox'
import { OmniboxSuggestions, rowDomId } from '@/components/browser/omnibox-suggestions'
import {
  SecurityChip,
  SecurityPanel,
  securityTone,
} from '@/components/browser/security-chip'

/** `useLayoutEffect` that does not shout on the server. The unit suite renders
 *  this component with `renderToStaticMarkup`, where a layout effect is both
 *  useless and noisy; the browser keeps the pre-paint timing that select-all
 *  needs. */
const useIsoLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

export interface AddressBarProps {
  /** The page's REAL url — the live nav-state feed's when there is one, else
   *  the tab row's. Shown formatted while idle, raw the moment it is focused. */
  url: string
  /** A live page. Drives the padlock's honesty: a tab that is asleep has no
   *  connection to make a claim about, so it gets the neutral globe. */
  live?: boolean
  /** The SERVER's transport claim off the nav-state feed. Undefined ⇒ fall back
   *  to the url-only guess, which is all there is before a socket attaches. */
  secure?: boolean
  /** A navigate / wake / page load is in flight → the 2px hairline. */
  loading?: boolean
  /** No tab at all: the bar still stands (chrome is persistent), and Enter
   *  mints one. */
  placeholder?: string
  /** Bump to take the caret — `+` / the new-tab page. A token rather than
   *  `autoFocus`, which fires on MOUNT regardless of why the node appeared, and
   *  would raise the phone keyboard every time the route opened. `0` (the
   *  default) never focuses. */
  focusKey?: number
  /** Fired with the RESOLVED destination — a page url, or the search url. The
   *  host never re-parses; there is one parser. */
  onNavigate: (url: string) => void
  /** PHASE 4 — the caret arrived or left. The chrome uses it to let the field
   *  grow on desktop (§5.8's focus expand); nobody is required to listen. */
  onEditing?: (editing: boolean) => void
  /** The open tabs, for the suggestion list. A tab row SWITCHES rather than
   *  navigating — nobody wants a ninth copy of the same inbox. */
  tabs?: BrowserTab[]
  onSwitchTab?: (id: string) => void
  /** The active tab's origin allowlist + evidence line, for the chip's panel. */
  origins?: string[]
  stateDetail?: string
  lent?: number
  /** Open the grant sheet from the chip's panel — where origins are edited. */
  onManage?: () => void
  className?: string
}

export function AddressBar({
  url,
  live,
  secure,
  loading,
  placeholder = 'Search or type a URL',
  focusKey = 0,
  onNavigate,
  onEditing,
  tabs,
  onSwitchTab,
  origins,
  stateDetail,
  lent,
  onManage,
  className,
}: AddressBarProps) {
  // `null` = not editing, so the field FOLLOWS the page: a navigation, an agent
  // driving somewhere else, a tab switch all just re-render. A string means the
  // human owns the field until they submit, blur or press Escape.
  const [draft, setDraft] = React.useState<string | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const [highlight, setHighlight] = React.useState(-1)
  const [chipOpen, setChipOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  // Select-all has to happen AFTER the value swaps from the display form to the
  // raw url, or the selection is dropped by the very re-render that focus
  // caused. A ref + layout effect, not a `setTimeout`.
  const selectRef = React.useRef(false)

  useIsoLayoutEffect(() => {
    if (!selectRef.current) return
    selectRef.current = false
    inputRef.current?.select()
  })

  // A popover that only closes from its own Close button is a popover that
  // covers the page until somebody finds the button. Pointer-down (not click)
  // so it closes on the same gesture that starts the next action, and Escape
  // for the keyboard.
  React.useEffect(() => {
    if (!chipOpen) return
    const away = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setChipOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChipOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [chipOpen])

  // Focus only — `onFocus` below does the state work (seed the draft, arm the
  // select), so the caret arrives by exactly the same path a tap takes.
  React.useEffect(() => {
    if (!focusKey) return
    inputRef.current?.focus()
  }, [focusKey])

  const editing = draft !== null
  // Reported in an EFFECT, never during render: the listener is a parent's
  // setState, and calling it inline would be a render-phase update of an
  // ancestor — React's one hard rule.
  React.useEffect(() => {
    onEditing?.(editing)
  }, [editing, onEditing])
  const value = editing ? draft : displayUrl(url)
  const intent: AddressIntent = editing ? parseAddress(draft) : { kind: 'empty' }
  // The chip's claim is the SERVER's when a socket is attached (it is derived
  // where the connection actually is) and the url-only guess otherwise.
  const tone = securityTone(url, secure ?? isSecure(url), !!live)

  // The suggestion rows are derived, not stored: a list in state is a list that
  // can disagree with the field that produced it, one keystroke later.
  const rows = React.useMemo(
    () => (editing && draft ? omniboxRows(draft, tabs ?? []) : []),
    [editing, draft, tabs],
  )
  // A highlight that outlived its list would send Enter to whatever row slid
  // into that index. Clamped here rather than reset in three handlers.
  const active = highlight >= 0 && highlight < rows.length ? highlight : -1
  const listId = 'omnibox-suggestions'

  const restore = () => {
    setDraft(null)
    setRefusal(null)
    setHighlight(-1)
  }

  const go = (dest: string) => {
    onNavigate(dest)
    restore()
    // Drop the phone keyboard: the page is what the human wants to look at now.
    inputRef.current?.blur()
  }

  const pick = (row: OmniboxRow) => {
    if (row.action.kind === 'switch') {
      onSwitchTab?.(row.action.tabId)
      restore()
      inputRef.current?.blur()
      return
    }
    go(row.action.url)
  }

  const submit = () => {
    // A highlighted row outranks the parse — that is what highlighting MEANS.
    if (active >= 0) {
      pick(rows[active])
      return
    }
    const decided = parseAddress(draft ?? url)
    if (decided.kind === 'empty') return
    if (decided.kind === 'refuse') {
      // In place, not a toast: the input is where the mistake is, and a toast
      // about a scheme disappears before the human can edit the scheme.
      setRefusal(decided.reason)
      return
    }
    go(decided.url)
  }

  return (
    <div ref={rootRef} className={cn('relative flex min-w-0 items-center gap-2', className)}>
      <div
        data-address-bar=""
        data-address-intent={editing ? intent.kind : 'idle'}
        className={cn(
          'relative flex min-h-11 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl border bg-background px-2.5',
          refusal ? 'border-amber-500' : 'border-border focus-within:border-primary',
        )}
      >
        {/* Idle: the security chip, which is a claim about the connection and
            opens the panel. Typing: the PARSE, so the human sees whether Enter
            searches or navigates before pressing it. */}
        {editing ? (
          intent.kind === 'search' ? (
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )
        ) : (
          <SecurityChip
            tone={tone}
            open={chipOpen}
            onToggle={() => setChipOpen((o) => !o)}
          />
        )}
        <input
          ref={inputRef}
          // ── the hygiene. Each line is a reproduced defect. ──
          type="text" // NOT type="url": it rejects a search query on submit
          inputMode="url" // the URL keyboard: / . : and .com
          enterKeyHint="go" // the phone's Enter key says Go, not return
          autoCapitalize="none" // ← the "even CAPITALISES" complaint
          autoCorrect="off" // github → GitHub, localhost → autocorrected
          spellCheck={false} // no red squiggle under every hostname
          autoComplete="off" // no password-manager junk in an address bar
          name="address"
          aria-label="Address and search"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? rowDomId(listId, active) : undefined}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setDraft(e.target.value)
            setRefusal(null)
            // A new query is a new list; keeping the old index would point the
            // highlight at a row that no longer means what it did.
            setHighlight(-1)
          }}
          onFocus={() => {
            selectRef.current = true
            setChipOpen(false)
            // Focus shows the TRUTH: the full url, scheme and all, selected —
            // so typing over it is one gesture, exactly like a desktop browser.
            setDraft(url)
          }}
          onBlur={restore}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              // Escape peels one layer at a time: the list first, the edit
              // second. Collapsing both at once loses the draft of anybody who
              // only wanted the popover out of the way.
              if (rows.length > 0 && active >= 0) {
                setHighlight(-1)
                return
              }
              restore()
              inputRef.current?.blur()
              return
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (rows.length === 0) return
              e.preventDefault()
              setHighlight((h) =>
                moveHighlight(h, e.key === 'ArrowDown' ? 1 : -1, rows.length),
              )
            }
          }}
          // 16px FLOOR, never below — index.html's viewport contract depends on
          // it. `font-mono` at 16px is wider than the sans at 16px, so the host
          // still fits at 390px because the field is `min-w-0` and truncates.
          className="min-w-0 flex-1 bg-transparent font-mono text-[16px] leading-none text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        {editing && value.length > 0 && (
          <button
            type="button"
            // Blur would fire before the click and restore the field out from
            // under it, so the clear button never lets focus leave.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft('')
              setRefusal(null)
              setHighlight(-1)
              inputRef.current?.focus()
            }}
            aria-label="Clear the address"
            data-address-clear=""
            className="relative flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
        {loading && (
          // The ONLY loading signal — a hairline on the chrome, never a spinner
          // over the page (the page is the thing you are trying to look at).
          <span
            aria-hidden
            data-address-loading=""
            className="sm-browser-hairline absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
          />
        )}
      </div>
      {/* All three overlays hang off the OUTER wrapper: the field itself is
          `overflow-hidden` so the loading hairline can follow its rounded
          corners, and anything rendered inside it would be clipped. */}
      {refusal && (
        <p
          role="alert"
          data-address-refusal=""
          className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-amber-500/40 bg-card px-2 py-1 text-[12px] text-amber-600 dark:text-amber-500"
        >
          {refusal}
        </p>
      )}
      {!refusal && (
        <OmniboxSuggestions
          id={listId}
          rows={rows}
          highlighted={active}
          onPick={pick}
          onHighlight={setHighlight}
        />
      )}
      {chipOpen && !editing && (
        <SecurityPanel
          tone={tone}
          url={url}
          origins={origins ?? []}
          detail={stateDetail}
          lent={lent}
          onManage={onManage}
          onClose={() => setChipOpen(false)}
        />
      )}
    </div>
  )
}
