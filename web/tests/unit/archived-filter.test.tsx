/**
 * The Archived sheet's filter: the sheet stays usable at 1100 rows.
 * ─────────────────────────────────────────────────────────────────────────────
 * The sheet renders every archived session as one flat list, ordered by last
 * activity, with no way to reach a row except scrolling. On a real fleet that is
 * a thousand rows deep, which makes "restore the one I archived last Tuesday" a
 * scrolling exercise. The filter is the whole answer, and four of its properties
 * are the ones that can quietly rot:
 *
 *   1. WHAT IT SEARCHES. The rows show `displayLabel(session)`, so a filter that
 *      only reads `session.name` misses every renamed session: the user types
 *      what is ON SCREEN and gets nothing back. Name, label, description and
 *      tags all match; `task_summary` deliberately does not (archived rows never
 *      carry one, and it is not rendered here).
 *   2. WHAT THE COUNT SAYS. "12 archived sessions" over a list showing three is
 *      a lie the moment a filter is active, so a filtered sheet says "3 of 12".
 *   3. WHAT "DELETE ALL" MEANS. It purges the FULL archive, irreversibly. Read
 *      over a filtered list it says "delete these three", so while a filter is
 *      active the action is not offered at all.
 *   4. WHO OWNS ESCAPE. Inside the filter box, Escape on a typed query clears
 *      the query; on an empty one it belongs to the overlay, which closes.
 *
 * No DOM: the behaviour lives in pure functions and presentational components
 * rendered through `react-dom/server`, which is what the whole app's unit net
 * runs on (`bun test`).
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ArchivedFilterField,
  NoArchivedMatches,
} from '../../src/components/archived/archived-sheet'
import {
  archivedDescription,
  filterArchived,
  filterEscapeIntent,
  matchesArchivedQuery,
  showsDeleteAll,
  showsFilterField,
} from '../../src/components/archived/archived-filter'
import type { ApiSession } from '../../src/lib/api'

const session = (partial: Partial<ApiSession> & { name: string }): ApiSession => ({
  status: 'stopped',
  dir: '/home/agent/work',
  provider: 'claude',
  preview_lines: [],
  ...partial,
})

const ROWS: ApiSession[] = [
  session({ name: 'release-train', updated_at: '2026-08-20T10:00:00Z' }),
  session({
    name: 'quiet-otter',
    display_name: 'Billing migration',
    updated_at: '2026-08-19T10:00:00Z',
  }),
  session({
    name: 'brave-comet',
    desc: 'Nightly invoice reconciliation',
    updated_at: '2026-08-18T10:00:00Z',
  }),
  session({
    name: 'plain-lake',
    tags: ['infra', 'billing'],
    updated_at: '2026-08-17T10:00:00Z',
  }),
]

const names = (rows: ApiSession[]) => rows.map((s) => s.name)

describe('what the filter searches', () => {
  test('an empty query keeps every row', () => {
    expect(names(filterArchived(ROWS, ''))).toEqual(names(ROWS))
  })

  test('a whitespace-only query is an empty query', () => {
    expect(names(filterArchived(ROWS, '   '))).toEqual(names(ROWS))
  })

  test('the slug matches, case-insensitively', () => {
    expect(names(filterArchived(ROWS, 'TRAIN'))).toEqual(['release-train'])
  })

  test('the label on the row matches, not just the slug', () => {
    // The row renders `displayLabel(session)`. Typing what is on screen has to
    // work, or a renamed session is unreachable by the name the user knows it by.
    expect(names(filterArchived(ROWS, 'billing migration'))).toEqual([
      'quiet-otter',
    ])
  })

  test('the description matches', () => {
    expect(names(filterArchived(ROWS, 'invoice'))).toEqual(['brave-comet'])
  })

  test('a tag matches', () => {
    expect(names(filterArchived(ROWS, 'infra'))).toEqual(['plain-lake'])
  })

  test('one query can hit several fields at once', () => {
    // "billing" is a display name on one row and a tag on another. Both come
    // back. The filter is a union over the fields, not a first-hit lookup.
    expect(names(filterArchived(ROWS, 'billing'))).toEqual([
      'quiet-otter',
      'plain-lake',
    ])
  })

  test('the query is trimmed before it is matched', () => {
    // The box holds whatever was typed or pasted, padding and all. A query of
    // "  billing  " is a query for "billing".
    const [, renamed] = ROWS
    expect(matchesArchivedQuery(renamed, '  billing  ')).toBe(true)
    expect(names(filterArchived(ROWS, '  billing  '))).toEqual([
      'quiet-otter',
      'plain-lake',
    ])
  })

  test('a miss is a miss', () => {
    expect(filterArchived(ROWS, 'zzz')).toEqual([])
  })

  test('task_summary is NOT searched, it is not on the row', () => {
    // Archived rows never render a chat title, so matching one would return a
    // row with nothing in it that explains the hit.
    const withSummary = [session({ name: 'silent-fox', task_summary: 'zzz' })]
    expect(filterArchived(withSummary, 'zzz')).toEqual([])
  })

  test('the API order survives the filter', () => {
    // The list arrives sorted by last activity. Filtering selects; it never
    // re-ranks.
    expect(names(filterArchived(ROWS, 'a'))).toEqual([
      'release-train',
      'quiet-otter',
      'brave-comet',
      'plain-lake',
    ])
  })
})

describe('the count is honest about what the list shows', () => {
  test('while loading it says so', () => {
    expect(
      archivedDescription({ isLoading: true, total: 0, shown: 0, filtering: false }),
    ).toBe('Loading…')
  })

  test('an empty archive says nothing is archived', () => {
    expect(
      archivedDescription({ isLoading: false, total: 0, shown: 0, filtering: false }),
    ).toBe('Nothing archived')
  })

  test('unfiltered, it counts the archive', () => {
    expect(
      archivedDescription({ isLoading: false, total: 12, shown: 12, filtering: false }),
    ).toBe('12 archived sessions')
    expect(
      archivedDescription({ isLoading: false, total: 1, shown: 1, filtering: false }),
    ).toBe('1 archived session')
  })

  test('filtered, it counts BOTH: shown and total', () => {
    expect(
      archivedDescription({ isLoading: false, total: 12, shown: 3, filtering: true }),
    ).toBe('3 of 12 archived sessions')
  })

  test('a filter that matches nothing still names the archive it searched', () => {
    expect(
      archivedDescription({ isLoading: false, total: 12, shown: 0, filtering: true }),
    ).toBe('0 of 12 archived sessions')
  })

  test('the plural follows the archive, not the match count', () => {
    expect(
      archivedDescription({ isLoading: false, total: 1, shown: 0, filtering: true }),
    ).toBe('0 of 1 archived session')
  })
})

describe('"Delete all" is not offered over a filtered list', () => {
  test('it shows on the full archive', () => {
    expect(showsDeleteAll(12, false)).toBe(true)
  })

  test('it is gone while a query is typed', () => {
    // It purges everything archived, not the rows on screen. Over a filtered
    // list the label reads as "delete these", which is the one misreading that
    // cannot be undone.
    expect(showsDeleteAll(12, true)).toBe(false)
  })

  test('a box holding only spaces still hides it, though the list is whole', () => {
    // The one asymmetry in this module, stated as a pair. A box holding "   "
    // reports hasText, so the ACTION goes (something is in the box, so its
    // label is ambiguous), while the COUNT stays unfiltered on the very same
    // keystroke (whitespace matches every row, so nothing left the list). The
    // two lines below are that one moment, read from both sides; anyone
    // "tidying" the pair into a single trimmed rule has to break this test.
    expect(showsDeleteAll(12, true)).toBe(false)
    expect(
      archivedDescription({ isLoading: false, total: 12, shown: 12, filtering: false }),
    ).toBe('12 archived sessions')
  })

  test('an empty archive has nothing to delete', () => {
    expect(showsDeleteAll(0, false)).toBe(false)
    // And a typed query over an empty archive is still nothing to delete: the
    // two reasons to withhold the action are independent, so pin both together.
    expect(showsDeleteAll(0, true)).toBe(false)
  })
})

describe('who owns Escape', () => {
  test('a typed query is cleared, and the key goes no further', () => {
    expect(filterEscapeIntent('Escape', 'billing')).toBe('clear')
  })

  test('spaces count as typed, the box is not empty on screen', () => {
    expect(filterEscapeIntent('Escape', '  ')).toBe('clear')
  })

  test('on an empty query Escape belongs to the overlay', () => {
    expect(filterEscapeIntent('Escape', '')).toBe('pass')
  })

  test('every other key passes through', () => {
    expect(filterEscapeIntent('Enter', 'billing')).toBe('pass')
    expect(filterEscapeIntent('a', 'billing')).toBe('pass')
  })
})

describe('the field is only offered over a list worth filtering', () => {
  test('it is offered over an archive with rows in it', () => {
    expect(showsFilterField({ isLoading: false, isError: false, total: 12 })).toBe(true)
  })

  test('it is offered over the loading skeleton too, so the strip cannot pop in', () => {
    // The strip carries its own border and padding in both overlay shells, so a
    // field that only appears once the request lands shoves the list down (and
    // re-centres the whole desktop frame) a beat after the sheet opens. It is
    // rendered disabled instead: see the field's own `disabled` case below.
    expect(showsFilterField({ isLoading: true, isError: false, total: 0 })).toBe(true)
  })

  test('not over a load error, filtering a stale list narrows a lie', () => {
    // `count` can still be non-zero here (the cached list survives a failed
    // refetch), so the error has to be checked in its own right.
    expect(showsFilterField({ isLoading: false, isError: true, total: 12 })).toBe(false)
  })

  test('an error wins over a load in flight', () => {
    // A refetch that errors reports both flags at once on some paths; the lie
    // the error would narrow is the stronger reason, so it decides.
    expect(showsFilterField({ isLoading: true, isError: true, total: 12 })).toBe(false)
  })

  test('not over an empty archive, a box that can only return nothing', () => {
    expect(showsFilterField({ isLoading: false, isError: false, total: 0 })).toBe(false)
  })
})

describe('the filter field', () => {
  // The typed string is the field's OWN state now (it is what keeps a keystroke
  // off the sheet and its thousand rows), so `react-dom/server` can only ever
  // see the resting, empty box: there is no prop to hand it a typed value with.
  // What the box looks like once something is in it, including the clear
  // control and what clicking it does, is asserted in the browser instead
  // (`tests/e2e/smoke/archived-filter.spec.ts`).
  const render = (disabled?: boolean) =>
    renderToStaticMarkup(
      <ArchivedFilterField
        open
        onQueryChange={() => {}}
        onHasTextChange={() => {}}
        disabled={disabled}
      />,
    )

  test('it is labelled for screen readers and prompts in the box', () => {
    const html = render()
    expect(html).toContain('aria-label="Filter archived sessions"')
    expect(html).toContain('Filter archived sessions…')
  })

  test('the resting box carries no clear control', () => {
    // Nothing to clear, and an always-on ✕ over an empty search box reads as a
    // control that does nothing.
    expect(render()).not.toContain('Clear filter')
  })

  test('it is on screen but dead while the list is still loading', () => {
    expect(render(true)).toContain('disabled')
  })

  test('the wrapper opts out of the mobile sheet drag', () => {
    // Vaul drags its drawer from anywhere in the header, exempting only a
    // <select> or a `[data-vaul-no-drag]` subtree. Without the opt-out, pressing
    // into the box and moving a few pixels dismisses the sheet and the
    // close-time reset wipes the query.
    expect(render()).toContain('data-vaul-no-drag')
  })
})

describe('a filter that matches nothing says what it searched for', () => {
  const html = renderToStaticMarkup(
    <NoArchivedMatches query="billing" onClear={() => {}} />,
  )
  const text = html
    .replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&#x27;|&#39;/g, "'")

  test('the query is echoed back', () => {
    // Without the query on screen, an empty list is indistinguishable from an
    // empty archive.
    expect(text).toContain('No archived sessions match')
    expect(text).toContain('billing')
  })

  test('the way out is one control away', () => {
    expect(text).toContain('Clear filter')
  })
})
