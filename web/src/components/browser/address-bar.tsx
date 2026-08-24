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
import * as React from 'react'

import { Globe, Lock, Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { displayUrl, isSecure, parseAddress, type AddressIntent } from '@/lib/api/browser'

/** `useLayoutEffect` that does not shout on the server. The unit suite renders
 *  this component with `renderToStaticMarkup`, where a layout effect is both
 *  useless and noisy; the browser keeps the pre-paint timing that select-all
 *  needs. */
const useIsoLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

export interface AddressBarProps {
  /** The page's REAL url — the live socket's snapshot when there is one, else
   *  the tab row's. Shown formatted while idle, raw the moment it is focused. */
  url: string
  /** A live page. Drives the padlock's honesty: a tab that is asleep has no
   *  connection to make a claim about, so it gets the neutral globe. */
  live?: boolean
  /** A navigate / wake is in flight → the 2px hairline along the bottom edge.
   *  The prop is the seam the Phase-3 nav-state stream plugs into unchanged. */
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
  className?: string
}

export function AddressBar({
  url,
  live,
  loading,
  placeholder = 'Search or type a URL',
  focusKey = 0,
  onNavigate,
  className,
}: AddressBarProps) {
  // `null` = not editing, so the field FOLLOWS the page: a navigation, an agent
  // driving somewhere else, a tab switch all just re-render. A string means the
  // human owns the field until they submit, blur or press Escape.
  const [draft, setDraft] = React.useState<string | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  // Select-all has to happen AFTER the value swaps from the display form to the
  // raw url, or the selection is dropped by the very re-render that focus
  // caused. A ref + layout effect, not a `setTimeout`.
  const selectRef = React.useRef(false)

  useIsoLayoutEffect(() => {
    if (!selectRef.current) return
    selectRef.current = false
    inputRef.current?.select()
  })

  // Focus only — `onFocus` below does the state work (seed the draft, arm the
  // select), so the caret arrives by exactly the same path a tap takes.
  React.useEffect(() => {
    if (!focusKey) return
    inputRef.current?.focus()
  }, [focusKey])

  const editing = draft !== null
  const value = editing ? draft : displayUrl(url)
  const intent: AddressIntent = editing ? parseAddress(draft) : { kind: 'empty' }

  const restore = () => {
    setDraft(null)
    setRefusal(null)
  }

  const submit = () => {
    const decided = parseAddress(draft ?? url)
    if (decided.kind === 'empty') return
    if (decided.kind === 'refuse') {
      // In place, not a toast: the input is where the mistake is, and a toast
      // about a scheme disappears before the human can edit the scheme.
      setRefusal(decided.reason)
      return
    }
    onNavigate(decided.url)
    setDraft(null)
    setRefusal(null)
    // Drop the phone keyboard: the page is what the human wants to look at now.
    inputRef.current?.blur()
  }

  return (
    <div className={cn('relative flex min-w-0 items-center gap-2', className)}>
      <div
        data-address-bar=""
        data-address-intent={editing ? intent.kind : 'idle'}
        className={cn(
          'relative flex min-h-11 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl border bg-background px-2.5',
          refusal ? 'border-amber-500' : 'border-border focus-within:border-primary',
        )}
      >
        <LeadIcon idle={!editing} kind={intent.kind} secure={isSecure(url)} live={!!live} />
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
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setDraft(e.target.value)
            setRefusal(null)
          }}
          onFocus={() => {
            selectRef.current = true
            // Focus shows the TRUTH: the full url, scheme and all, selected —
            // so typing over it is one gesture, exactly like a desktop browser.
            setDraft(url)
          }}
          onBlur={restore}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              restore()
              inputRef.current?.blur()
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
            className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary motion-reduce:animate-none"
          />
        )}
      </div>
      {refusal && (
        <p
          role="alert"
          data-address-refusal=""
          className="absolute inset-x-0 top-full z-10 mt-1 rounded-lg border border-amber-500/40 bg-card px-2 py-1 text-[12px] text-amber-600 dark:text-amber-500"
        >
          {refusal}
        </p>
      )}
    </div>
  )
}

/** What the Enter key is about to do, drawn before it is pressed.
 *
 *  Idle it is the security chip (§5.3's honest `isSecure`); while typing it
 *  becomes a magnifier for a search and a globe for a page, so the human SEES
 *  the branch the parser took rather than discovering it in a new tab. */
function LeadIcon({
  idle,
  kind,
  secure,
  live,
}: {
  idle: boolean
  kind: AddressIntent['kind']
  secure: boolean
  live: boolean
}) {
  if (!idle) {
    return kind === 'search' ? (
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    ) : (
      <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    )
  }
  // A padlock is a claim about a CONNECTION. An asleep tab has none, so it gets
  // the neutral globe rather than a green lock over a page that is not open.
  return secure && live ? (
    <Lock className="size-4 shrink-0 text-emerald-600" aria-hidden />
  ) : (
    <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  )
}
