/**
 * OMNIBOX SUGGESTIONS — what one half-typed line could mean, ranked.
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, and separate from the component, for the reason every other decision in
 * this feature is: the RANKING is the part that goes wrong, and a ranking that
 * lives inside a render is a ranking nobody can test.
 *
 * The order is fixed and it is not a preference:
 *
 *  1. **What Enter does right now.** Row 0 mirrors `parseAddress` exactly, so
 *     the human SEES which branch the key is about to take — "Search for «q3
 *     numbers»" or "Go to mail.example" — before pressing it. This is the whole
 *     reason the list exists; the rest is convenience.
 *  2. **Tabs you already have open.** Switching beats opening: nothing is more
 *     maddening than a ninth copy of the same inbox, each signed in, each
 *     lent to a different agent. A tab row NEVER navigates — it selects.
 *  3. **Hosts this workspace already trusts** — the tabs' own `origins`
 *     allowlists. These are the destinations where an agent can actually use
 *     the tab afterwards, which makes them the useful ones to offer.
 *
 * Deduplication is by DESTINATION, not by label: if row 0 already goes to
 * `https://mail.example` there must not be an origin row that goes to the same
 * place two lines below it, or ↓↓Enter and Enter do the same thing and the list
 * has taught the human nothing.
 */

import { parseAddress, tabHost, type BrowserTab } from '@/lib/api/browser'

import { prettyHost } from './nav-state'

/** What picking a row does. Two acts, never conflated. */
export type OmniboxAction =
  | { kind: 'navigate'; url: string }
  /** The tab is already open — select it. */
  | { kind: 'switch'; tabId: string }

export interface OmniboxRow {
  /** Stable across keystrokes, so React does not remount the highlighted row
   *  out from under an arrow key. */
  id: string
  /** Drives the leading icon: magnifier / globe / tab / shield. */
  kind: 'search' | 'navigate' | 'tab' | 'origin'
  /** The line the human reads. */
  label: string
  /** The quiet second line — a url, a state, a host. */
  detail: string
  action: OmniboxAction
}

/** Six rows at 44px is 264px — about as much as fits under the bar on a 780px
 *  phone with the keyboard up, which is the constraint that sets the cap. */
export const MAX_OMNIBOX_ROWS = 6

function destination(row: OmniboxRow): string {
  return row.action.kind === 'navigate' ? row.action.url : `tab:${row.action.tabId}`
}

/**
 * The rows for one query. Empty query ⇒ no list at all (a popover over an
 * untouched address bar is noise, and on a phone it covers the page).
 *
 * A REFUSED parse (`javascript:`, `file:`) produces no row 0 on purpose: the
 * bar's own in-place refusal line says why, and offering a row that cannot be
 * taken is worse than offering nothing.
 */
export function omniboxRows(
  query: string,
  tabs: BrowserTab[],
  limit: number = MAX_OMNIBOX_ROWS,
): OmniboxRow[] {
  const raw = query.trim()
  if (!raw) return []
  const rows: OmniboxRow[] = []

  const intent = parseAddress(raw)
  if (intent.kind === 'search') {
    rows.push({
      id: 'intent',
      kind: 'search',
      label: `Search for “${intent.query}”`,
      detail: prettyHost(intent.url),
      action: { kind: 'navigate', url: intent.url },
    })
  } else if (intent.kind === 'navigate') {
    rows.push({
      id: 'intent',
      kind: 'navigate',
      label: `Go to ${prettyHost(intent.url)}`,
      detail: intent.url,
      action: { kind: 'navigate', url: intent.url },
    })
  }

  const needle = raw.toLowerCase()
  for (const tab of tabs) {
    if (rows.length >= limit) break
    const hay = `${tab.title} ${tab.url}`.toLowerCase()
    if (!hay.includes(needle)) continue
    rows.push({
      id: `tab:${tab.id}`,
      kind: 'tab',
      label: tab.title || prettyHost(tab.url),
      // Switching is a different act from opening, and the row says so — this
      // is the line that stops the ninth copy of the inbox.
      detail: `Switch to this tab · ${tabHost(tab.url)}`,
      action: { kind: 'switch', tabId: tab.id },
    })
  }

  const seen = new Set(rows.map(destination))
  for (const tab of tabs) {
    for (const origin of tab.origins) {
      if (rows.length >= limit) break
      // A leading-dot suffix (`.example`) is a RULE, not a destination: there
      // is no page at `https://.example`, so it is never offered as one.
      if (!origin || origin.startsWith('.')) continue
      if (!origin.toLowerCase().includes(needle)) continue
      const url = `https://${origin}`
      if (seen.has(url)) continue
      seen.add(url)
      rows.push({
        id: `origin:${origin}`,
        kind: 'origin',
        label: origin,
        detail: 'Agents may use a tab here',
        action: { kind: 'navigate', url },
      })
    }
  }

  // One last pass by destination: a tab whose url IS the parsed url would
  // otherwise sit two rows under an identical row 0.
  const out: OmniboxRow[] = []
  const taken = new Set<string>()
  for (const row of rows) {
    const key = destination(row)
    if (taken.has(key)) continue
    taken.add(key)
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

/** ↑/↓ over a list that starts with NOTHING highlighted.
 *
 *  `-1` is "no row picked — Enter takes the bar's own parse", which is the
 *  state the bar is in the instant after a keystroke. ↓ from there enters the
 *  list at row 0; ↑ from there enters at the END (every browser does this);
 *  and walking off either edge returns to `-1` rather than wrapping straight
 *  through, so there is always a way back to plain typing.
 */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1
  const next = current + delta
  if (next < -1) return count - 1
  if (next >= count) return -1
  return next
}
