// The Archived sheet's filter: the matching, counting and key rules behind
// `archived-sheet.tsx`'s filter box.
//
// They live in their own module because every rule here is a decision a user can
// be misled by, and each one is a pure function of its inputs: kept out of the
// sheet they can be asserted directly in `tests/unit/archived-filter.test.tsx`,
// on the values themselves, rather than inferred from rendered markup.

import { displayLabel, type ApiSession } from '@/lib/api'

/** Does this archived row answer the typed query? Case-insensitive substring
 *  over the slug, the LABEL the row actually renders (`displayLabel`, i.e. a
 *  rename), the description and the tags. `task_summary` is deliberately not
 *  searched: archived rows never render one, so a hit on it would return a row
 *  with nothing in it that explains the hit. Mirrors the overview's `matches()`
 *  minus that field. */
export function matchesArchivedQuery(session: ApiSession, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (session.name.toLowerCase().includes(needle)) return true
  // Only when the row renders something OTHER than the slug. `displayLabel`
  // falls back to `session.name`, so on an unrenamed session this second test
  // is the first one again: a wasted `toLowerCase()` per row per keystroke,
  // which at ~1100 rows is worth not doing.
  const label = displayLabel(session)
  if (label !== session.name && label.toLowerCase().includes(needle)) return true
  if (session.desc?.toLowerCase().includes(needle)) return true
  if (session.tags?.some((t) => t.toLowerCase().includes(needle))) return true
  return false
}

/** Select, never re-rank: the list arrives sorted by last activity and the
 *  filtered list keeps that order. */
export function filterArchived(
  sessions: ApiSession[],
  query: string,
): ApiSession[] {
  if (!query.trim()) return sessions
  return sessions.filter((s) => matchesArchivedQuery(s, query))
}

/** The sheet's description line. "12 archived sessions" over a list showing
 *  three is a lie the moment a filter is active, so a filtered sheet counts
 *  BOTH: what is on screen, and the archive it was drawn from. The plural
 *  follows the archive, which is the noun being counted. */
export function archivedDescription({
  isLoading,
  total,
  shown,
  filtering,
}: {
  isLoading: boolean
  total: number
  shown: number
  filtering: boolean
}): string {
  if (isLoading) return 'Loading…'
  if (total === 0) return 'Nothing archived'
  const noun = `archived session${total === 1 ? '' : 's'}`
  return filtering ? `${shown} of ${total} ${noun}` : `${total} ${noun}`
}

/** "Delete all" purges the FULL archive, irreversibly. Read over a filtered
 *  list its label says "delete these", which is the one misreading that cannot
 *  be undone, so while there is anything in the filter box the action is not
 *  offered at all. Per-row Restore / Delete keep working on the filtered rows.
 *
 *  Deliberately keyed on whether the box has text, not on whether the trimmed
 *  query filters anything: the box, not the list, is what the user is reading
 *  the action against. */
export function showsDeleteAll(total: number, hasText: boolean): boolean {
  return total > 0 && !hasText
}

/** Is there a list here worth filtering? Not over the load error (the list on
 *  screen is stale or absent, so a filter would narrow a lie), and not over an
 *  empty archive (a box that can only ever return nothing).
 *
 *  The loading skeleton DOES get the field, disabled: the strip carries its own
 *  border and padding in both overlay shells, so withholding it until the
 *  request lands pops ~52px in between the header and the list and re-centres
 *  the whole desktop frame. Shown-but-dead costs nothing and the layout is
 *  settled before the user looks at it. Extracted rather than left inline in the
 *  sheet because it is the first rule of the feature and the cheapest to assert. */
export function showsFilterField({
  isLoading,
  isError,
  total,
}: {
  isLoading: boolean
  isError: boolean
  total: number
}): boolean {
  return !isError && (isLoading || total > 0)
}

/** Escape inside the filter box. A typed query is cleared and the key stops
 *  there; on an empty box Escape belongs to the overlay, which closes on it. */
export function filterEscapeIntent(key: string, query: string): 'clear' | 'pass' {
  return key === 'Escape' && query.length > 0 ? 'clear' : 'pass'
}

/** Autofocus is a fine-pointer contract. On a phone, focusing the field on open
 *  raises the keyboard over the very list the user came to read. */
export const FILTER_AUTOFOCUS_QUERY = '(pointer: fine)'

