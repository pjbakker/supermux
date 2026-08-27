// The Archived sheet's filter box, end-to-end through the REAL binary + UI.
//
// A production archive runs to ~1100 rows and the sheet renders them as one flat
// list, so the filter is the only way to reach a row without scrolling to it. The
// rules it enforces are all decisions a user can be misled by, and none of them
// are reachable from `bun test` (there is no DOM harness in `web/node_modules`),
// so they are pinned here instead:
//
//   1. The field lives in the sheet HEADER, above the scroll container.
//   2. Typing narrows the rows and the count says "x of y", not a flat "y".
//   3. A query that only matches a TAG, and one that only matches a DESCRIPTION,
//      each find their row: the box searches what the row is, not just its slug.
//   4. No match names the query it searched for, and its "Clear filter" button
//      brings the whole list back and puts the caret back in the box.
//   5. "Delete all" is withheld while anything is typed (it purges the FULL
//      archive, and read over a filtered list its label says "delete these"), and
//      typing while it is ARMED takes the disposition table down with it.
//   6. Escape on a typed query clears the query; Escape on an empty box closes
//      the sheet. Reopening starts unfiltered.
//   7. Crossing the shell breakpoint while a query is typed remounts the field
//      with an empty box, so the sheet must come back unfiltered with it and
//      show "Delete all" again. Desktop run only: it is the only one that
//      starts on the wide shell.
//
// Run on desktop (1440) and at 430x932. Both runs render the SAME sheet body,
// the Radix right-side one: `ResponsiveSheet` forks on `(pointer: coarse)`, not
// on width, and the chromium project in `playwright.config.ts` sets no touch
// emulation. So what the narrow run buys is that body at a phone width, and the
// Vaul drawer branch is never entered by this spec.

import { expect, test, type Locator, type Page } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

/** Archive a session straight through the backend (the tile's archive flow
 *  needs no tmux for the DB flip). */
async function archive(backend: Backend, name: string): Promise<void> {
  const res = await fetch(
    `${backend.backendUrl}/api/sessions/${encodeURIComponent(name)}/archive`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}` },
    },
  )
  expect(res.status, `archive ${name}`).toBe(202)
}

/** Eight rows, each reachable by a word that appears in exactly ONE of them, and
 *  in exactly one FIELD of that one: `otter` is only a slug, `finance` is only a
 *  tag, `terraform` is only a description. That is what makes the per-field
 *  assertions below mean something rather than passing on a slug hit. */
const SEEDS = [
  { name: 'release-train', desc: 'ships every night', tags: ['ops'] },
  { name: 'quiet-otter', desc: 'ledger reconciliation', tags: ['finance'] },
  { name: 'bold-heron', desc: 'auth rewrite', tags: ['security'] },
  { name: 'calm-badger', desc: 'docs cleanup', tags: ['writing'] },
  { name: 'swift-marmot', desc: 'flame graphs', tags: ['perf'] },
  { name: 'brave-lynx', desc: 'terraform modules', tags: ['infra'] },
  { name: 'merry-finch', desc: 'index rebuild', tags: ['search'] },
  { name: 'lucky-stoat', desc: 'welcome flow', tags: ['growth'] },
] as const

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 430, height: 932 },
] as const

/** The sheet's own list, by its accessible name. `getByRole('listitem')` is
 *  page-wide and the overview behind the sheet renders list rows of its own, so
 *  every row assertion here goes through this. */
function archivedList(page: Page): Locator {
  return page.getByRole('list', { name: 'Archived sessions' })
}

function rows(page: Page): Locator {
  return archivedList(page).getByRole('listitem')
}

function filterField(page: Page): Locator {
  return page.getByRole('searchbox', { name: 'Filter archived sessions' })
}

/** The bulk action, by its full accessible name so the count is part of the
 *  match and the per-row "Delete <name> forever" buttons cannot answer for it. */
function deleteAll(page: Page): Locator {
  return page.getByRole('button', {
    name: /^Delete all \d+ archived sessions forever$/,
  })
}

for (const vp of VIEWPORTS) {
  test.describe(`archived filter (${vp.label})`, () => {
    let backend: Backend

    test.beforeEach(async ({ page }) => {
      backend = await startBackend()
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.addInitScript(injectGlobals(backend.token))
    })
    test.afterEach(async () => {
      await backend?.dispose()
    })

    test('filter narrows the archive, withholds "Delete all", and clears back to whole', async ({
      page,
    }) => {
      // ISOLATION, ASSERTED RATHER THAN ASSUMED. Teams are read from
      // `$CLAUDE_CONFIG_DIR/teams`, NOT from `SUPERMUX_DATA_DIR`, so a "fresh
      // backend on a fresh temp dir" can still serve the developer's real team
      // and put extra rows on the overview. Fail here with a readable reason
      // instead of on a confusing strict-mode violation further down.
      const teams = await fetch(`${backend.backendUrl}/api/teams`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      }).then((r) => r.json())
      expect(teams.data, 'a fresh backend must see no teams').toEqual([])

      for (const seed of SEEDS) {
        expect(
          (
            await api(backend).createSession({
              name: seed.name,
              provider: 'shell',
              dir: backend.dataDir,
              desc: seed.desc,
              tags: [...seed.tags],
            })
          ).status,
          `create ${seed.name}`,
        ).toBe(201)
        await archive(backend, seed.name)
      }

      await page.goto(backend.baseUrl)

      // Open the sheet from the overview overflow item.
      await page.getByRole('button', { name: /archived/i }).first().click()
      await expect(rows(page)).toHaveCount(SEEDS.length)

      // ── 1. The field is in the HEADER, outside the list it filters ──────────
      const field = filterField(page)
      await expect(field).toBeVisible()
      expect(
        await archivedList(page)
          .getByRole('searchbox', { name: 'Filter archived sessions' })
          .count(),
        'the field must not scroll away with the list',
      ).toBe(0)

      // On open, the caret is already in the box. NOTE: this holds on BOTH
      // viewports here, and that is a property of the harness, not of a phone.
      // The autofocus is gated on `(pointer: fine)`, and `setViewportSize`
      // alone still reports a fine pointer to Chromium; only `hasTouch` context
      // emulation would flip it. So this asserts what this harness actually
      // gives us, and the real coarse-pointer branch (no autofocus, no keyboard
      // over the list) is not exercised by this spec.
      await expect(field).toBeFocused()

      await expect(
        page.getByText('8 archived sessions', { exact: true }),
      ).toBeVisible()
      await expect(deleteAll(page)).toBeVisible()

      // ── 2. Typing narrows the rows, and the count says so ───────────────────
      // One assertion, not a count followed by a text check: consecutive
      // queries here can both leave exactly one row, so a bare `toHaveCount(1)`
      // is satisfied by the PREVIOUS query's row and the check races the
      // 200ms debounce. `toHaveText` over the whole list pins the count and
      // which row it is in the same retrying assertion.
      await field.fill('otter')
      await expect(rows(page)).toHaveText([/quiet-otter/])
      await expect(page.getByText('1 of 8 archived sessions')).toBeVisible()

      // ── 5a. "Delete all" is gone the moment anything is typed ───────────────
      await expect(deleteAll(page)).toHaveCount(0)

      // ── 7. Crossing the shell breakpoint drops the query AND the flag ───────
      // `ShellOverlay` picks its shell from `(min-width: 768px) and
      // (pointer: fine)` and renders a different component on either side of it,
      // so narrowing the window past 768 remounts the header and the filter box
      // with it. The box comes back empty and the debounce reports '' behind it,
      // so the sheet has to report itself unfiltered too: whole list, plain
      // count, and "Delete all" back on screen. Left stranded, the sheet would
      // sit on a whole archive with its bulk action missing and nothing on
      // screen to explain why.
      if (vp.label === 'desktop') {
        await page.setViewportSize({ width: 700, height: 900 })
        await expect(field).toHaveValue('')
        await expect(rows(page)).toHaveCount(SEEDS.length)
        await expect(
          page.getByText('8 archived sessions', { exact: true }),
        ).toBeVisible()
        await expect(deleteAll(page)).toBeVisible()

        // And back on the shell it started on, which is a second remount.
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await expect(deleteAll(page)).toBeVisible()
      }

      // ── 3. A tag-only query and a desc-only query each find their row ───────
      await field.fill('finance')
      await expect(rows(page)).toHaveText([/quiet-otter/])

      await field.fill('terraform')
      await expect(rows(page)).toHaveText([/brave-lynx/])

      // ── 4. No match names the query, and the way back is one control ────────
      await field.fill('zzz')
      await expect(rows(page)).toHaveCount(0)
      await expect(page.getByText('No archived sessions match “zzz”')).toBeVisible()

      const clearAndShowAll = page.getByRole('button', {
        name: 'Clear filter and show all archived sessions',
      })
      await clearAndShowAll.click()
      await expect(rows(page)).toHaveCount(SEEDS.length)
      // The button unmounts itself on click, so without an explicit hand-back
      // focus lands on <body> and the overlay's trap quietly reels it into the
      // frame.
      await expect(field).toBeFocused()

      // ── 4b. The ✕ inside the box does the same, from the box ────────────────
      // The typed string is the field's own state, so "is the clear control
      // there once something is typed, and does it clear" is only assertable
      // here; `react-dom/server` can only render the resting empty box.
      // `exact`, or the substring match also answers for the no-match
      // "Clear filter and show all archived sessions" button.
      const clearInBox = page.getByRole('button', {
        name: 'Clear filter',
        exact: true,
      })
      await expect(clearInBox).toHaveCount(0)
      await field.fill('otter')
      await expect(rows(page)).toHaveText([/quiet-otter/])
      await clearInBox.click()
      await expect(field).toHaveValue('')
      await expect(rows(page)).toHaveCount(SEEDS.length)
      await expect(field).toBeFocused()
      await expect(clearInBox).toHaveCount(0)

      // ── 5b. "Delete all" is back over the whole archive ─────────────────────
      await expect(deleteAll(page)).toBeVisible()

      // ── 5c. Arming it, then typing, takes the disposition table down too ────
      // The armed confirm's own button unmounts when the query hides the
      // action; the table it explains must not be left on screen with nothing
      // to cancel, and clearing must not resurrect an arming nobody renewed.
      await deleteAll(page).click()
      await expect(page.getByText('What happens')).toBeVisible()
      await field.fill('otter')
      await expect(page.getByText('What happens')).toHaveCount(0)
      await field.fill('')
      await expect(rows(page)).toHaveCount(SEEDS.length)
      await expect(page.getByText('What happens')).toHaveCount(0)
      await expect(deleteAll(page)).toBeVisible()

      // ── 6. Escape: query first, then the sheet ──────────────────────────────
      await field.fill('heron')
      await expect(rows(page)).toHaveText([/bold-heron/])
      await field.press('Escape')
      await expect(field).toHaveValue('')
      await expect(rows(page)).toHaveCount(SEEDS.length)
      // Still open: the key stopped at the box.
      await expect(archivedList(page)).toBeVisible()

      await field.press('Escape')
      await expect(archivedList(page)).toHaveCount(0)

      // Reopening starts unfiltered: the sheet is shell-mounted and never
      // unmounts, so a surviving query would come back with it.
      await page.getByRole('button', { name: /archived/i }).first().click()
      await expect(rows(page)).toHaveCount(SEEDS.length)
      await expect(filterField(page)).toHaveValue('')
      await expect(
        page.getByText('8 archived sessions', { exact: true }),
      ).toBeVisible()
    })
  })
}
