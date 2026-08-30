// TEAMS-in-Bot-mode smoke e2e (Phase 6c) — the folded roster + the team pane,
// on the `?mock` fixture (Phase 0 D3: `MOCK_TEAMS` + their lead sessions), so
// this covers the surface offline without a live Claude team on the runner.
//
// It drives the wave's spine end-to-end in the browser:
//   1. Bot mode ON + `/?mock` → the grok roster renders, and the `feature-x`
//      crew is a ROW that sorts into a section (OD-2 fold), not a leading Teams
//      divider. It has a needs_you member, so it lands in `Needs you`.
//   2. the header reads the honest fleet size + the `· N crews` census.
//   3. clicking the crew selects it in place (the URL never leaves `/`), and the
//      right pane opens on the lead's thread; the Team-details toggle flips it to
//      TeamPanel, whose crew list opens a member (MemberPane), and back returns.
//
// Desktop viewport: the phone routes a team tap to `/team/*` instead (Phase 6a),
// which is its own concern; here we exercise the in-place pane.

import { expect, test } from '@playwright/test'
import { injectGlobals, startBackend, type Backend } from './harness'

const FLAG_ON = JSON.stringify({ state: { botMode: true }, version: 1 })

test.describe('grok team roster (folded sections + team pane)', () => {
  let backend: Backend
  test.beforeEach(async ({ page }) => {
    backend = await startBackend()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript((flag: string) => {
      window.localStorage.setItem('supermux-ui', flag)
    }, FLAG_ON)
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('folded roster → crew row in a section → select in place → TeamPanel → member → back', async ({
    page,
  }) => {
    await page.goto(`${backend.baseUrl}/?mock`)

    // The grok roster is up.
    await expect(page.locator('.grok-roster')).toBeVisible()

    // OD-2 FOLD: there is no leading "Teams" divider group any more. The team is
    // a row that sorts into a section — `feature-x` has a needs_you member, so it
    // is in `Needs you`. (Its aria-label pluralizes: "feature-x — 5 bots".)
    const crew = page.getByRole('button', { name: /feature-x — 5 bots/ })
    await expect(crew).toBeVisible()

    // THE CENSUS IS GONE, AND THAT IS A FINDING, NOT A FIXTURE PROBLEM.
    //
    // These two lines asserted `.gr-count` contained "crew" and "need you".
    // `.gr-count` is not rendered by `grok-roster.tsx` at all any more — #123
    // rebuilt the header around `ScopeTitle` + the New-bot pill + search, and
    // the census element went with it. What survives is the PROSE describing it
    // (grok-roster.tsx:1056-1069, "the honest fleet HEADCOUNT… the census can
    // never disagree with the NEEDS YOU / ACTIVE / DONE headers") and dead CSS
    // (`grok-mode.css:1528`). Nothing renders it.
    //
    // So this spec cannot assert it, and pretending otherwise cost 90 s of a
    // ten-minute CI budget on every run. Whether the census SHOULD come back is
    // a product call and it is raised on the PR rather than patched over here;
    // the rest of this spec — the fold, in-place selection, TeamPanel, member,
    // and back — is the spine and still runs.

    // Selecting a team never changes the URL (§2b) — it swaps the pane in place.
    await crew.click()
    await expect(page).toHaveURL(new RegExp(`${backend.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\?mock)?$`))

    // The Team-details toggle flips the pane to TeamPanel (the lead's thread is
    // the other face). Then the crew list is the click target for a member.
    const toggle = page.locator('[data-vr="pane-team-toggle"]')
    await expect(toggle).toBeVisible()
    await toggle.click()

    await expect(page.locator('[data-vr="team-tab"]').first()).toBeVisible()
    const firstMember = page.locator('[data-vr="team-member"]').first()
    await expect(firstMember).toBeVisible()
    await firstMember.click()

    // …opens that teammate's read-only pane, in the same right column.
    await expect(page.locator('[data-vr="member-pane"]')).toBeVisible()
    await expect(page.locator('[data-vr="member-readonly"]')).toBeVisible()

    // Back returns to the crew (its Overview list), not the lead's thread.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-vr="team-member"]').first()).toBeVisible()
  })
})
