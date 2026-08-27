// ArchivedSheet — browse + restore/purge archived sessions (feat-archive-recover).
//
// Archive is a soft delete (the row survives with `archived = 1`), but archived
// sessions are otherwise unbrowsable + unrecoverable from the UI. This is the
// opt-in recovery surface — NO permanent screen estate.
//
// B1 T6: this is <ShellOverlay>'s FIRST CONSUMER. On mobile nothing changes —
// ShellOverlay renders <ResponsiveSheet> verbatim, so the Vaul drag-detent
// bottom sheet is byte-identical. On desktop the right-side dialog becomes the
// shell overlay: a frame centred in the content column, with the nav rail and
// route header still visible beside its scrim. Chosen as the first consumer
// because it is shell-mounted (layout.tsx), low-traffic, and reversible in one
// import.
//
// Each row shows the session name + when it was archived, with two actions:
//   • Restore  → unarchive (the row springs back into the live overview via the
//                existing SSE delta) and drops out of this sheet.
//   • Delete forever → purge (hard delete, irreversible) behind an INLINE
//                confirm so a stray tap can't nuke a session.
//
// A filter box sits in the sheet HEADER (a production archive runs to ~1100
// rows, and a box inside the scrolling body would be gone by the time it is
// wanted). Its rules live in `archived-filter.ts`; what it changes HERE is the
// count on the description row ("3 of 12"), the absence of "Delete all" while a
// query is typed, since that action purges the whole archive rather than the
// rows on screen, and the row animation, which is switched off while filtering.
//
// VISUAL: ≥44pt row actions (h-11 controls), sentence-case labels (no
// UPPERCASE), spring transitions (springs.*), design tokens throughout.

import * as React from 'react'

import { useArmedConfirm } from '@/hooks/use-armed-confirm'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Archive, RotateCcw, Search, Trash2, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton'
import { motionOff, springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ShellOverlay } from '@/components/shell/shell-overlay'
import { StatusDot } from '@/components/session-tile/status-dot'
import { useToast } from '@/components/ui/use-toast'
import {
  useArchivedSessions,
  type UseArchivedSessionsResult,
} from '@/hooks/use-archived-sessions'
import { displayLabel, type ApiSession } from '@/lib/api'
import { LIFECYCLE, PURGE_DISPOSITION } from '@/brand/copy'
import {
  archivedDescription,
  FILTER_AUTOFOCUS_QUERY,
  filterArchived,
  filterEscapeIntent,
  showsDeleteAll,
  showsFilterField,
} from './archived-filter'

export interface ArchivedSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Relative "when archived" label. We have no `archived_at` column, so the
 *  server orders by — and we display — the newest activity timestamp
 *  (`updated_at`), the closest proxy for "when it was last touched / archived". */
function whenArchived(updatedAt?: string): string {
  if (!updatedAt) return 'Archived'
  const t = Date.parse(updatedAt)
  if (Number.isNaN(t)) return 'Archived'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'Archived just now'
  const m = Math.round(s / 60)
  if (m < 60) return `Archived ${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `Archived ${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `Archived ${d}d ago`
  return `Archived ${new Date(t).toLocaleDateString()}`
}

export function ArchivedSheet({ open, onOpenChange }: ArchivedSheetProps) {
  // Only fetch while the sheet is open — opt-in, no always-on request.
  const recovery = useArchivedSessions(open)
  const { archived, isLoading, isError } = recovery

  // B5/T7.2 — the bulk-delete confirm is armed in the header's trailing slot,
  // but the disposition it needs to state is far too big to live on that
  // 28px-high row. Lifting just the armed flag lets the table render in the
  // sheet BODY, where there is room to be honest, while the buttons stay where
  // the user's finger already is.
  // B5/T9.2 keeps the flag lifted (rather than owning a hook here) precisely so
  // the table above can see it; the ARMING itself lives in `DeleteAllAction`.
  const [confirmingPurgeAll, setConfirmingPurgeAll] = React.useState(false)

  // The filter. Production archives run to ~1100 rows, where "restore the one I
  // archived on Tuesday" is a scrolling exercise; this is the only way to reach
  // a row without scrolling to it.
  //
  // The RAW string in the box is deliberately NOT state here. It lives inside
  // `ArchivedFilterField`, which reports two things upward: `query`, the
  // 200ms-debounced value the list is filtered by, and `hasText`, whether the
  // box holds anything at all. The reason is measured rather than stylistic.
  // This component renders inside `ShellOverlay`'s motion frame, so every render
  // of it makes framer-motion re-measure the projection tree beneath that frame,
  // and at ~1100 rows carrying `layout` that pass costs ~330ms of main thread.
  // Memoizing the rows does not touch it, because the cost is not React
  // re-rendering them. Keeping the keystrokes inside the field means this
  // component renders once per debounce landing and once per empty/non-empty
  // flip, instead of once per key.
  //
  // `hasText` is tracked apart from `query` because the two rules that describe
  // the BOX rather than the list ("Delete all", and the Escape arbitration
  // inside the field) must not lag a fifth of a second behind what the user can
  // see. Same split the overview keeps (`overview.tsx`), one level down.
  const [query, setQuery] = React.useState('')
  const [hasText, setHasText] = React.useState(false)
  const fieldRef = React.useRef<ArchivedFilterFieldHandle | null>(null)

  // Clearing is the one transition that must NOT wait for the debounce: the
  // whole list comes back, and 200ms of a stale filtered list after an explicit
  // "show me everything" reads as a control that did not work. The field owns
  // the raw string, so it owns the clear: `clear()` drops all three halves (box,
  // query, hasText) in one commit and puts the caret back where the user was
  // typing, because both clear controls unmount themselves on click and focus
  // would otherwise land on <body> for the focus trap to reel into the frame.
  const clearFilter = React.useCallback(() => {
    fieldRef.current?.clear()
  }, [])

  const count = archived.length
  const visible = React.useMemo(
    () => filterArchived(archived, query),
    [archived, query],
  )
  // Two notions of "filtering", and each is keyed on what the user is reading:
  // the COUNT describes the list (a whitespace-only query filters nothing, and
  // the list is the debounced one), the Delete-all action describes the BOX
  // (anything typed hides it, at once).
  const filteringList = query.trim().length > 0
  const description = archivedDescription({
    isLoading,
    total: count,
    shown: visible.length,
    filtering: filteringList,
  })
  const showDeleteAll = showsDeleteAll(count, hasText)
  const filterable = showsFilterField({ isLoading, isError, total: count })
  // Offered during the load (so the header strip does not pop in after the
  // skeleton and shove the list down), but dead until there is a list to type
  // against.
  const filterEnabled = filterable && !isLoading

  // A closed sheet keeps no filter. This one is shell-mounted (layout.tsx) and
  // so never unmounts, which means the query outlives the close unless it is
  // dropped: reopening would come up still filtered by the last visit. Adjusted
  // during render (React's documented reset-on-prop-change) rather than in an
  // effect, so the first frame of the reopened sheet is already unfiltered.
  //
  // A field that stops being offered drops its query for a second reason: with
  // the box gone (a refetch that errors, say) a surviving query would keep
  // "Delete all" suppressed with nothing on screen explaining why.
  //
  // Only the two values this component holds are reset here. The raw string in
  // the box belongs to the field, which drops it on the same signal (`open`) in
  // the same render-time way; a setter reaching down into it during render is
  // exactly the update-while-rendering React refuses.
  const [wasOpen, setWasOpen] = React.useState(open)
  const [wasFilterable, setWasFilterable] = React.useState(filterable)
  const dropped = (!open && wasOpen !== open) || (!filterable && wasFilterable !== filterable)
  if (wasOpen !== open) setWasOpen(open)
  if (wasFilterable !== filterable) setWasFilterable(filterable)
  if (dropped && (query || hasText)) {
    setQuery('')
    setHasText(false)
  }

  // Desktop opens with the caret already in the field; a coarse pointer does
  // not, or the keyboard covers the list. Deferred a frame so it lands AFTER
  // the overlay's own focus trap has placed initial focus, rather than fighting
  // it.
  //
  // Waits for the field to be ENABLED, not merely rendered: during the load it
  // is on screen but disabled, and a disabled input cannot take focus, so
  // focusing it then would silently do nothing and the latch would burn the one
  // shot. On a first open that means focus lands a beat after the request
  // resolves, which is the same beat the list itself arrives on.
  //
  // Latched to ONE shot per open, with `filterEnabled` deliberately out of the
  // condition's memory: it flips whenever a background refetch errors and
  // recovers, and an unlatched effect would then yank focus off whatever the
  // user was doing (an armed "Delete forever", say) with no user action at all.
  // The latch is set INSIDE the frame, so a dep change that cancels the frame
  // before it runs leaves the shot unspent rather than losing it.
  const autoFocus = useMediaQuery(FILTER_AUTOFOCUS_QUERY)
  const focusedForOpen = React.useRef(false)
  React.useEffect(() => {
    if (!open) focusedForOpen.current = false
  }, [open])
  React.useEffect(() => {
    if (!open || !autoFocus || !filterEnabled || focusedForOpen.current) return
    const id = requestAnimationFrame(() => {
      focusedForOpen.current = true
      fieldRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open, autoFocus, filterEnabled])

  return (
    <ShellOverlay
      open={open}
      onOpenChange={onOpenChange}
      title="Archived sessions"
      description={description}
      // Bulk "Delete all" lives INLINE on the description row, right of
      // the count — saves a whole row of vertical space vs sitting above the
      // list, keeps the action discoverable at the same eye line as the count
      // it modifies ("N items · delete them all").
      descriptionTrailing={
        showDeleteAll ? (
          <DeleteAllAction
            recovery={recovery}
            onArmedChange={setConfirmingPurgeAll}
          />
        ) : null
      }
      // The field belongs in the header slot, not at the top of the body: the
      // body is the scroll container, and a filter that scrolls away with a
      // 1100-row list is unreachable at exactly the moment it is wanted. Both
      // overlay forms give this slot its own horizontal padding, so the field
      // is passed bare.
      headerActions={
        filterable ? (
          <>
            {/* `setQuery` and `setHasText` are passed bare on purpose: a
                useState setter keeps one identity for the life of this
                component, so the field's debounce effect is never restarted by
                a fresh callback arriving as a prop. */}
            <ArchivedFilterField
              ref={fieldRef}
              open={open}
              onQueryChange={setQuery}
              onHasTextChange={setHasText}
              disabled={!filterEnabled}
            />
            {/* The list narrowing is a silent change: the count lives in the
                header's plain <span> and the rows just go. Spoken here instead,
                and only while filtering, so an unfiltered sheet announces
                nothing. Not on the list itself, or every restore/purge speaks.

                THE ONLY live region in this sheet. The no-match paragraph used
                to carry a second one, which queued two polite announcements for
                one keystroke and put the more useful of the two in a region born
                in the same commit as its text (unreliable across readers). So
                both cases are said here, from a region that was already mounted.

                Distinct wording, not a copy of `description`: the overlay renders
                that string visibly in its own header span, so repeating it here
                would put "3 of 12 archived sessions" in the dialog twice. */}
            <span className="sr-only" role="status" aria-live="polite">
              {filteringList
                ? visible.length === 0
                  ? `No matches for “${query.trim()}”`
                  : `${visible.length} of ${count} shown`
                : ''}
            </span>
          </>
        ) : null
      }
      className="sm:max-w-md"
    >
      <div className="px-2 py-2 sm:px-3">
        {/* B5/T7.2 — the disposition, shown at the moment it is decided rather
            than buried in docs. Only while the irreversible bulk delete is
            armed: on the resting sheet it would be a wall of rules about an
            action nobody has reached for. */}
        {/* Gated on `showDeleteAll` as well as the armed flag: typing while the
            bulk confirm is armed unmounts the button, and the disposition it
            explains would otherwise be left on screen with nothing to cancel. */}
        {confirmingPurgeAll && showDeleteAll ? (
          <div className="px-1 pb-2">
            <DispositionTable />
          </div>
        ) : null}
        {isError ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            Couldn’t load archived sessions.
          </p>
        ) : isLoading && count === 0 ? (
          <SkeletonRegion
            label="Loading archived sessions…"
            className="flex flex-col gap-1"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg bg-muted/50" />
            ))}
          </SkeletonRegion>
        ) : count === 0 ? (
          <EmptyArchived />
        ) : visible.length === 0 ? (
          <NoArchivedMatches query={query} onClear={clearFilter} />
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Archived sessions">
            {/* The restore/purge exit animation is free when rows leave
                one at a time, and ruinous when they leave by the hundred: every
                row `AnimatePresence` holds back runs a height spring for ~0.4s,
                and a seven-character query is seven of those waves stacked. So
                while a filter is active the rows run their transitions at zero
                duration (`animated={false}`), and the unfiltered list keeps the
                animation it was written for.

                ONE `AnimatePresence`, mounted in both states, with the switch on
                the child. Swapping the element for a bare array instead would
                put an element and an array in the same child slot, which React
                cannot reconcile: it tears down all ~1100 <li> subtrees at each
                filter boundary and rebuilds them, losing every armed
                "Delete forever" along the way.

                The honest cost of keying this on "is a filter active" rather
                than "why did this row leave": with a query typed, restoring the
                single matching row also disappears with no transition. The
                transition is fixed at the row's LAST render, which cannot tell a
                query change from a restore, so the two cases share one answer
                and this is the safe one. */}
            <AnimatePresence initial={false}>
              {visible.map((s) => (
                <ArchivedRow
                  key={s.name}
                  session={s}
                  recovery={recovery}
                  animated={!filteringList}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
        {/* B5/T5.3 — the archive/schedule contract, stated where the archived
            rows are. This is the SAME sentence the archive confirm renders
            (`LIFECYCLE.archivePausesSchedules`), imported rather than retyped,
            so the two can never drift. Shown only when there is something
            archived: on an empty sheet it would be a rule about nothing. */}
        {count > 0 && !isError ? (
          <p className="px-3 pb-1 pt-3 text-[12px] leading-snug text-muted-foreground">
            {LIFECYCLE.archiveIsTheUndo} {LIFECYCLE.archivePausesSchedules}
          </p>
        ) : null}
      </div>
    </ShellOverlay>
  )
}

/** What the sheet can still DO to the box now that it no longer holds the text.
 *  Two verbs, both of which have to reach the real <input>: the no-match button
 *  clears it, and the sheet focuses it once per open on a fine pointer. */
export interface ArchivedFilterFieldHandle {
  /** Empty the box, cancel the pending debounce, report both halves upward and
   *  put the caret back in the field. */
  clear: () => void
  focus: () => void
}

/** The filter field. Deliberately the overview's search field, not a second
 *  design of one: same h-9 control, same leading magnifier, same trailing
 *  clear button, same icon inset, on the shared `<Input>` primitive. Two search
 *  boxes in one product should feel like one thing.
 *
 *  It renders bare: the overlay's header slot owns its padding, in both the
 *  desktop frame and the mobile sheet.
 *
 *  It owns the typed string, the 200ms debounce and the Escape arbitration, so
 *  that a keystroke re-renders this ~30-node subtree rather than the sheet and
 *  the 1100-row list underneath it. See the note on the sheet's filter state for
 *  what that costs when the string lives one level up. */
export const ArchivedFilterField = React.forwardRef<
  ArchivedFilterFieldHandle,
  {
    /** On screen but dead, while the list it filters is still loading. */
    disabled?: boolean
    /** Whether the sheet is open. A closed sheet keeps no filter, and the field
     *  outlives the close by the length of the overlay's exit animation, so the
     *  box empties itself here rather than waiting for the unmount. Adjusted
     *  during render (React's documented reset-on-prop-change), the same way the
     *  sheet resets its own two values, so no effect can leave a frame of stale
     *  text on a sheet that is on its way out. */
    open: boolean
    /** The query the list should filter by: 200ms behind the box while typing,
     *  and reported at once with '' when the box is cleared. */
    onQueryChange: (query: string) => void
    /** Whether the box holds anything. Called on the empty/non-empty
     *  transition and on mount, so the sheet re-renders when the box goes empty
     *  or non-empty (which is what "Delete all" and the live region are keyed
     *  on) and not on every key. */
    onHasTextChange: (hasText: boolean) => void
  }
>(function ArchivedFilterField(
  { disabled, open, onQueryChange, onHasTextChange },
  ref,
) {
  const [value, setValue] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const [wasOpen, setWasOpen] = React.useState(open)
  const closing = !open && wasOpen !== open
  if (wasOpen !== open) setWasOpen(open)
  if (closing && value) setValue('')

  // The debounce. One timer, restarted on every change to the box and cleared
  // on unmount by this effect's own cleanup. The match then runs over the
  // thousand rows once per pause rather than once per keystroke, and the sheet
  // above renders once per pause with it.
  //
  // `clear()` reports '' upward itself and sets `value` in the same commit, and
  // that state change runs this cleanup, so a timer holding the abandoned query
  // can never land afterwards. The redundant ''-commit it schedules in place is
  // a no-op: the sheet is already unfiltered, and React bails out of a setState
  // to the value it already holds.
  React.useEffect(() => {
    const id = setTimeout(() => onQueryChange(value), 200)
    return () => clearTimeout(id)
  }, [value, onQueryChange])

  // The transition report inside `onChange` below is synchronous, so
  // "Delete all" leaves in the same commit as the first character. This effect
  // covers MOUNT, which that report never reaches: `ShellOverlay` picks its
  // shell from `(min-width: 768px) and (pointer: fine)` and renders a different
  // component on either side of it, so crossing that breakpoint remounts this
  // field with an empty box. Without a report from here the sheet's `hasText`
  // stays true for text that no longer exists, and "Delete all" never comes
  // back. After a transition report this is a no-op, because React bails out of
  // a setState to the value it already holds.
  const nonEmpty = value.length > 0
  React.useEffect(() => {
    onHasTextChange(nonEmpty)
  }, [nonEmpty, onHasTextChange])

  const clear = React.useCallback(() => {
    setValue('')
    onQueryChange('')
    onHasTextChange(false)
    inputRef.current?.focus()
  }, [onQueryChange, onHasTextChange])

  React.useImperativeHandle(
    ref,
    () => ({ clear, focus: () => inputRef.current?.focus() }),
    [clear],
  )

  // Escape, arbitrated. `ShellOverlay` closes on a keydown captured at the
  // DOCUMENT, which runs before any React handler on the field, so a bubbling
  // onKeyDown could never win. A capture listener on the WINDOW sits one node
  // earlier in the propagation path, which is what lets a typed query eat the
  // key before the overlay ever sees it. An empty box passes the key straight
  // on, so Escape closes the sheet exactly as it does today.
  //
  // The target check is the FIELD only, so Escape pressed while focus sits on
  // the no-match "Clear filter" button closes the sheet rather than clearing the
  // query. Deliberate: outside the box Escape means "get me out of here", which
  // is what it means everywhere else in the app, and the button under the caret
  // already clears with a single Enter or Space.
  //
  // The query is read through a ref rather than the deps, so the listener is
  // registered once per mount instead of being torn down and re-added on every
  // keystroke.
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  }, [value])
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== inputRef.current) return
      if (filterEscapeIntent(e.key, valueRef.current) !== 'clear') return
      e.stopPropagation()
      clear()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [clear])

  return (
    // Vaul drags the mobile sheet from anywhere in its header, and only a
    // <select> or a `[data-vaul-no-drag]` subtree is exempt. Without this, a
    // press inside the box to place the caret, plus a few pixels of movement,
    // is read as a dismiss gesture: the drawer follows the finger, closes, and
    // the close-time reset then wipes what was typed. Same opt-out the mobile
    // key bar, the snippet panel and the focus-mode panels use.
    <div className="relative" data-vaul-no-drag>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => {
          const next = e.target.value
          // Only the empty/non-empty TRANSITION goes upward. Reporting every
          // keystroke would put the sheet back on the main thread for each one,
          // which is the whole cost this split exists to avoid.
          if ((next.length > 0) !== (value.length > 0)) {
            onHasTextChange(next.length > 0)
          }
          setValue(next)
        }}
        disabled={disabled}
        placeholder="Filter archived sessions…"
        aria-label="Filter archived sessions"
        // The ring loses its offset: this field is focused the moment the sheet
        // opens on desktop, and the primitive's offset halo would then be the
        // loudest thing in a small, quiet panel. Same ring the overview's search
        // field draws. The native WebKit cancel button is hidden because the
        // field already carries an explicit clear control, and two ✕ glyphs in
        // one box is a question ("which one?"), not an affordance.
        className="pl-9 pr-9 focus-visible:ring-offset-0 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear filter"
          className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  )
})

/** The filtered-to-nothing state. NOT `EmptyArchived`: that one means the
 *  archive is empty, and showing it here would tell a user with 1100 archived
 *  sessions that they have none. This one names the query it searched for (an
 *  empty list is otherwise indistinguishable from an empty archive) and keeps
 *  the way back to the full list one control away. Quieter than the empty
 *  state by design: no icon, no 56px medallion, because the sheet is not empty
 *  and should not read as if it were. */
export function NoArchivedMatches({
  query,
  onClear,
}: {
  query: string
  onClear: () => void
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? motionOff : springs.cardExpand}
      className="flex flex-col items-center gap-3 px-6 py-10 text-center"
    >
      {/* Plain text, NOT a live region. The empty result is announced by the
          sheet's one live region, next to the filter field, which was already
          mounted before this paragraph existed; a region created in the same
          commit as its content is unreliable across screen readers, and two
          polite regions firing on one keystroke queue two announcements for one
          action. The echo is trimmed, so a query of spaces does not render as
          padding inside the quotes. */}
      <p className="max-w-full break-words text-sm text-muted-foreground">
        No archived sessions match “{query.trim()}”
      </p>
      <button
        type="button"
        onClick={onClear}
        // The X in the field carries the same visible words, and two buttons
        // reading "Clear filter" in one dialog are indistinguishable in a screen
        // reader's element list. This one says what it does to the list.
        aria-label="Clear filter and show all archived sessions"
        className="flex h-11 items-center rounded-md border border-hairline px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
      >
        Clear filter
      </button>
    </motion.div>
  )
}

/** "Delete all" row — irreversible, inline-confirm matching the per-row
 *  delete pattern. Disabled while any individual purge is in flight (we'd be
 *  fighting the per-row mutation otherwise). On confirm, fans out every
 *  archived row's purge in parallel; the sheet empties progressively as each
 *  request resolves. */
function DeleteAllAction({
  recovery,
  onArmedChange,
}: {
  recovery: UseArchivedSessionsResult
  /** B5/T7.2 — the arming lives HERE (it is this button's state), but the
   *  disposition table it should reveal lives in the sheet body, where there is
   *  room to be honest. So the flag is reported upward rather than owned there:
   *  one source of truth, two places that need to see it. */
  onArmedChange: (armed: boolean) => void
}) {
  const { archived, purgeAll, pending } = recovery
  const { toast } = useToast()
  const reduce = useReducedMotion()
  const [busy, setBusy] = React.useState(false)
  // Lock out the bulk action while ANY individual purge is mid-flight to avoid
  // racing with a per-row delete-confirm the user already kicked off.
  const anyPending = pending.size > 0 || busy
  const count = archived.length

  const onPurgeAll = React.useCallback(async () => {
    setBusy(true)
    try {
      const { ok, failed } = await purgeAll()
      if (failed === 0) {
        toast({ message: `Deleted ${ok} session${ok === 1 ? '' : 's'}` })
      } else if (ok === 0) {
        toast({
          message: 'Couldn’t delete archived sessions',
          tone: 'error',
        })
      } else {
        // Partial — be specific so the user knows what's left.
        toast({
          message: `Deleted ${ok}, ${failed} couldn’t be deleted`,
          tone: 'error',
        })
      }
    } finally {
      setBusy(false)
    }
  }, [purgeAll, toast])

  // Compact inline action sized to fit ON the description row (h-7 / text-xs)
  // so the sheet header gains zero vertical space vs the count alone. The
  // confirm morph keeps the same height so the row never reflows.
  // B5/T9.2 — variant C → the shared idiom. Untimed before: "Delete all" armed
  // and forgotten stayed one click from purging every archived session.
  const confirming = useArmedConfirm({ onConfirm: () => void onPurgeAll() })
  // The cleanup is the load-bearing half. This button unmounts whenever the
  // filter box gains a character (and on every close), and without it the
  // parent is left holding `armed: true` for a button that no longer exists:
  // clearing the query then paints the disposition table for one frame under an
  // unarmed "Delete all" before the remounted effect corrects it.
  React.useEffect(() => {
    onArmedChange(confirming.armed)
    return () => onArmedChange(false)
  }, [confirming.armed, onArmedChange])

  if (confirming.armed) {
    return (
      <motion.div
        initial={reduce ? false : { opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={springs.snappy}
        className="flex items-center gap-1"
      >
        <button
          type="button"
          onClick={confirming.cancel}
          disabled={anyPending}
          className="flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirming.press}
          disabled={anyPending}
          className="flex h-7 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
          Delete {count}
        </button>
      </motion.div>
    )
  }
  return (
    <button
      type="button"
      onClick={confirming.press}
      disabled={anyPending}
      aria-label={`Delete all ${count} archived sessions forever`}
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <Trash2 className="size-3.5" aria-hidden />
      Delete all
    </button>
  )
}

/** B5/T7.2 — the disposition, rendered. "Delete forever" is the only truly
 *  irreversible verb in supermux, and until now it asked for confirmation
 *  without ever saying what it disposed of. This renders `PURGE_DISPOSITION`
 *  row by row (archive vs purge, side by side) so the comparison the user is
 *  actually making is on screen instead of in their head.
 *
 *  It is driven by the exported table rather than hand-written markup, and
 *  `delete-honesty.test.tsx` asserts every row reaches the DOM — so a row added
 *  to the table cannot be silently left out of the dialog (R3). */
export function DispositionTable() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
      <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        What happens
      </p>
      <dl className="flex flex-col gap-1">
        {PURGE_DISPOSITION.map((row) => (
          <div
            key={row.thing}
            className="flex items-baseline justify-between gap-3 px-1"
          >
            <dt className="text-[12px] text-muted-foreground">{row.thing}</dt>
            <dd className="shrink-0 text-[12px] font-medium text-foreground">
              {row.purge}
            </dd>
          </div>
        ))}
      </dl>
      <p className="px-1 pt-2 text-[11px] leading-snug text-muted-foreground">
        {LIFECYCLE.purgeLeavesYourFilesAlone}
      </p>
    </div>
  )
}

function EmptyArchived() {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.cardExpand}
      className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center"
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
        <Archive aria-hidden />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">
        No archived sessions.
      </p>
    </motion.div>
  )
}

/** A single archived session row: name + when archived, with Restore +
 *  Delete-forever (inline confirm) actions.
 *
 *  MEMOIZED, and load-bearing at ~1100 rows: every keystroke in the filter box
 *  re-renders the sheet, and without this each of those keystrokes re-runs a
 *  `useToast`, a `useReducedMotion` and a `useArmedConfirm` subscription per row
 *  between keypresses. It only holds because `recovery` is referentially stable
 *  (`use-archived-sessions.ts` memoizes the object and its callbacks); hand this
 *  a fresh object per render and the memo is dead weight. */
const ArchivedRow = React.memo(function ArchivedRow({
  session,
  recovery,
  animated = true,
}: {
  session: ApiSession
  recovery: UseArchivedSessionsResult
  /** False while a filter is active. Rows then leave and arrive in bulk on
   *  every debounce, and a 0.4s enter/exit height spring each is a wave of them
   *  stacked, which is per-row work the list cannot afford at that scale. It
   *  switches the TRANSITION off (see the `motion.li` below), not the
   *  animation's values, and not `layout`. */
  animated?: boolean
}) {
  const { restore, purge, pending } = recovery
  const { toast } = useToast()
  const reduce = useReducedMotion()
  const busy = pending.has(session.name)
  const label = displayLabel(session)

  const onRestore = React.useCallback(() => {
    restore(session.name)
      .then(() => toast({ message: `Restored ${label}` }))
      .catch(() =>
        toast({ message: 'Couldn’t restore session', tone: 'error' }),
      )
  }, [restore, session.name, label, toast])

  const onPurge = React.useCallback(() => {
    purge(session.name)
      .then(() => toast({ message: `Deleted ${label}` }))
      .catch(() =>
        toast({ message: 'Couldn’t delete session', tone: 'error' }),
      )
  }, [purge, session.name, label, toast])

  // B5/T9.2 — variant C → the shared idiom. Untimed before: a row armed and
  // forgotten was one click from an irreversible delete, indefinitely.
  const confirming = useArmedConfirm({ onConfirm: onPurge })

  return (
    <motion.li
      // `layout` is deliberately NOT gated on `animated`, though a layout
      // projection per row is real work and switching it off while filtering was
      // the obvious saving. It cannot be had, because of what the exit animates:
      // `height: 'auto'` cannot resolve to a number without layout projection,
      // so `exit: { height: 0 }` on a row with `layout={false}` never completes
      // and `AnimatePresence` never removes it. The row then sits in the list at
      // opacity 0 forever, so a query that dropped a row would strand it.
      // The `!reduce` gate is safe for the same reason read the other way: under
      // reduced motion the exit is opacity-only, which needs no projection.
      // Caught in the browser, and pinned by
      // `tests/e2e/smoke/archived-filter.spec.ts` (the tag-only and desc-only
      // queries each leave exactly one row, which is what makes a stranded row
      // fail an assertion rather than hide behind it).
      layout={!reduce}
      // No enter animation, in either motion mode. Rows only ever ARRIVE here
      // through a refetch or a filter clear, and neither wants a wave of them:
      // clearing a query over the ~1100-row archive remounts a thousand rows at
      // once, and an enter spring on each is exactly what `animated` exists to
      // prevent. The restore/purge EXIT below, which is the animation this list
      // was written for, is untouched by this.
      initial={false}
      animate={{ opacity: 1, height: 'auto' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      // This is what `animated` buys, and it is the expensive half that is left:
      // while a filter is active rows leave by the hundred on every debounce,
      // and a 0.4s height spring each is a wave of them stacked. `motionOff` is
      // a zero duration, so a filtered row is simply there or not.
      transition={animated ? springs.smooth : motionOff}
      className="overflow-hidden"
    >
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg px-3 py-2',
          'hover:bg-secondary/60',
          busy && 'opacity-60',
        )}
      >
        {/* Archived sessions are stopped; the dot keeps the row visually
            consistent with the overview tiles / palette. */}
        <StatusDot status="stopped" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-foreground">
            {displayLabel(session)}
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            {whenArchived(session.updated_at)}
          </p>
        </div>

        {confirming.armed ? (
          // Inline destructive confirm — the row morphs into "Cancel / Delete"
          // so a stray tap can never nuke a session. Matches the tile's
          // archive-confirm pattern.
          <motion.div
            initial={reduce ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={springs.snappy}
            className="flex shrink-0 items-center gap-1"
          >
            <button
              type="button"
              onClick={confirming.cancel}
              disabled={busy}
              className="flex h-11 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onPurge}
              disabled={busy}
              className="flex h-11 items-center gap-1.5 rounded-md bg-destructive px-3 text-[13px] font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden />
              Delete forever
            </button>
          </motion.div>
        ) : (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onRestore}
              disabled={busy}
              aria-label={`Restore ${displayLabel(session)}`}
              title="Restore"
              className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <RotateCcw className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={confirming.press}
              disabled={busy}
              aria-label={`Delete ${displayLabel(session)} forever`}
              title="Delete forever"
              className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </motion.li>
  )
})

export default ArchivedSheet
