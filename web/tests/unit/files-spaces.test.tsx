/**
 * The Spaces landing — the first test under `components/files`, and the one
 * that makes the landing's HONESTY RULES executable.
 * ─────────────────────────────────────────────────────────────────────────────
 * Three of them, and each fails silently when it is wrong:
 *
 *   1. bot counts come from the live session list, HQ's being the sessions with
 *      no company. A wrong split says "Acme: 6 bots" for bots that are not in
 *      Acme — a claim the user has no way to check from this screen.
 *   2. an ARCHIVED company has no card. It is not filtered here on purpose
 *      (`GET /api/companies` already excludes it, and a second definition of
 *      "live" is how two definitions drift) — so what is pinned is that the
 *      grid renders exactly what it is handed, and that a company with no
 *      `root_dir` (a card that would navigate nowhere) is dropped.
 *   3. the activity line is rendered ONLY for a space we have OBSERVED an event
 *      for. There is no `idle · 3d`: nothing on the server persists a per-company
 *      last-write time, and deriving one from the root's mtime would be a number
 *      that does not mean what it says. Absent activity renders an em dash.
 *
 * Plus the "one card is condescending" rule — `spacesSkipTarget` — which is the
 * only place this client makes a decision about a scope it cannot ask about, so
 * exactly what it keys on is pinned rather than described.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ThemeProvider } from '@/components/theme-provider'
import { SpacesGrid } from '@/components/files/spaces-grid'
import {
  activityName,
  botLine,
  spaceCards,
  spacesSkipTarget,
} from '@/components/files/spaces'
import { newEntryError } from '@/components/files/new-entry-sheet'
import { relativeStamp } from '@/stores/files-activity-store'
import type { Company } from '@/lib/companies'

const ACME: Company = {
  id: 1,
  slug: 'acme',
  display_name: 'Acme',
  root_dir: '/srv/acme',
  archived: 0,
}
const GLOBEX: Company = {
  id: 2,
  slug: 'globex',
  display_name: 'Globex',
  root_dir: '/srv/globex',
  archived: 0,
}

const SESSIONS = [
  { company_id: null },
  { company_id: null },
  { company_id: 1 },
  { company_id: 1 },
  { company_id: 1 },
  { company_id: 2 },
  {}, // no company_id at all — an HQ bot, same as explicit null
]

describe('spaceCards — what the landing is allowed to claim', () => {
  test('HQ leads, then one card per company, in the given order', () => {
    const cards = spaceCards([ACME, GLOBEX], SESSIONS, {}, { includeHq: true })
    expect(cards.map((c) => c.name)).toEqual(['HQ', 'Acme', 'Globex'])
    expect(cards[0]!.id).toBe(null)
  })

  test('bot counts split by company; a missing company_id folds into HQ', () => {
    const cards = spaceCards([ACME, GLOBEX], SESSIONS, {}, { includeHq: true })
    expect(cards[0]!.bots).toBe(3) // two explicit nulls + one absent
    expect(cards[1]!.bots).toBe(3)
    expect(cards[2]!.bots).toBe(1)
  })

  test('a company with no root_dir is dropped — a card that goes nowhere', () => {
    const cards = spaceCards(
      [{ ...ACME, root_dir: '' }],
      [],
      {},
      { includeHq: false },
    )
    expect(cards).toEqual([])
  })

  test('HQ can be omitted entirely (a scoped member has no HQ to show)', () => {
    const cards = spaceCards([ACME], [], {}, { includeHq: false })
    expect(cards.map((c) => c.name)).toEqual(['Acme'])
  })

  test('activity attaches to the space it was recorded for, and NOWHERE else', () => {
    const cards = spaceCards(
      [ACME, GLOBEX],
      [],
      { '1': { at: 1_000, path: '/srv/acme/report.md', op: 'write', session: 'bo' } },
      { includeHq: true },
    )
    expect(cards[1]!.activity?.path).toBe('/srv/acme/report.md')
    // The honesty rule: nothing observed ⇒ null, never a synthesised recency.
    expect(cards[0]!.activity).toBe(null)
    expect(cards[2]!.activity).toBe(null)
  })
})

describe('spacesSkipTarget — a one-card chooser is condescending', () => {
  test('exactly one company AND no projects ⇒ route straight to its root', () => {
    expect(spacesSkipTarget([ACME], 0)).toBe('/srv/acme')
  })

  test('two companies ⇒ the grid (there is a choice to make)', () => {
    expect(spacesSkipTarget([ACME, GLOBEX], 0)).toBe(null)
  })

  test('projects present ⇒ the grid, because HQ has real contents to offer', () => {
    expect(spacesSkipTarget([ACME], 3)).toBe(null)
  })

  test('no companies at all ⇒ the grid', () => {
    expect(spacesSkipTarget([], 0)).toBe(null)
  })

  test('a rootless company does not count as the one', () => {
    expect(spacesSkipTarget([{ ...ACME, root_dir: '' }], 0)).toBe(null)
  })
})

describe('the small strings the cards render', () => {
  test('botLine pluralises, and an empty space is an em dash not "0 bots"', () => {
    expect(botLine(0)).toBe('—')
    expect(botLine(1)).toBe('1 bot')
    expect(botLine(4)).toBe('4 bots')
  })

  test('activityName is the basename of the server-canonical path', () => {
    expect(activityName('/srv/acme/docs/report.md')).toBe('report.md')
    expect(activityName('/srv/acme/docs/')).toBe('docs')
  })

  test('relativeStamp reads "now" under a minute, then m/h/d', () => {
    const t = 1_000_000
    expect(relativeStamp(t, t + 5_000)).toBe('now')
    expect(relativeStamp(t, t + 120_000)).toBe('2m')
    expect(relativeStamp(t, t + 3 * 3_600_000)).toBe('3h')
    expect(relativeStamp(t, t + 5 * 86_400_000)).toBe('5d')
    // A clock that went backwards must not render a negative age.
    expect(relativeStamp(t, t - 10_000)).toBe('now')
  })
})

describe('<SpacesGrid> — what actually reaches the screen', () => {
  function render(cards: ReturnType<typeof spaceCards>, active: number | null = null) {
    return renderToStaticMarkup(
      <ThemeProvider>
        <SpacesGrid cards={cards} activeCompany={active} onOpen={() => {}} now={0} />
      </ThemeProvider>,
    )
  }

  test('renders one card per space, with its name and bot line', () => {
    const html = render(spaceCards([ACME, GLOBEX], SESSIONS, {}, { includeHq: true }))
    expect(html).toContain('HQ')
    expect(html).toContain('Acme')
    expect(html).toContain('Globex')
    expect(html).toContain('3 bots')
    expect(html).toContain('1 bot')
  })

  test('an ARCHIVED company simply is not in the list it is handed', () => {
    // `GET /api/companies` excludes archived rows; the grid renders what it is
    // given, so "archived is absent" is a property of the INPUT — pinned here
    // so nobody adds a second, divergent filter inside the component.
    const html = render(spaceCards([ACME], SESSIONS, {}, { includeHq: true }))
    expect(html).not.toContain('Globex')
  })

  test('a space with no observed activity renders the em dash, not a fake age', () => {
    const html = render(spaceCards([ACME], [], {}, { includeHq: false }))
    expect(html).toContain('—')
    expect(html).not.toContain('idle')
  })

  test('an observed write renders the basename + stamp', () => {
    const html = render(
      spaceCards(
        [ACME],
        [],
        { '1': { at: 0, path: '/srv/acme/report.md', op: 'write', session: 'bo' } },
        { includeHq: false },
      ),
    )
    expect(html).toContain('report.md')
    expect(html).toContain('now')
  })

  test('the active space is marked, so the landing shows where you already are', () => {
    const html = render(spaceCards([ACME], [], {}, { includeHq: true }), 1)
    expect(html).toContain('aria-current="true"')
  })

  test('an empty grid says so instead of rendering nothing', () => {
    const html = render([])
    expect(html).toContain('No spaces yet')
  })
})

describe('newEntryError — the message is the point of client-side validation', () => {
  test('a folder accepts any plain name', () => {
    expect(newEntryError('folder', 'reports')).toBe(null)
    expect(newEntryError('folder', '.hidden')).toBe(null)
  })

  test('a writable text file is accepted', () => {
    expect(newEntryError('file', 'notes.md')).toBe(null)
    expect(newEntryError('file', '.env')).toBe(null)
  })

  test('a non-writable extension names ITSELF, instead of a raw 403 later', () => {
    const msg = newEntryError('file', 'book.xlsx')
    expect(msg).toContain('.xlsx')
    expect(msg).toContain('writable list')
  })

  test('a slash is refused for both kinds, pointing at Move… instead', () => {
    expect(newEntryError('folder', 'a/b')).toContain('/')
    expect(newEntryError('file', 'a/b.md')).toContain('/')
  })

  test('. and .. are refused', () => {
    expect(newEntryError('folder', '..')).toBe('That name is reserved.')
  })
})
