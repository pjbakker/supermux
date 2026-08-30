// Workflows v1 — the whole loop, against a real backend.
//
// This replaces `scheduler-fold.spec.ts` and `scheduler-fires.spec.ts`. It is
// the same kind of proof for a different shape: not "does the page render", but
// "does a capability survive a redesign". The old spec drove the settings fold
// through create → toggle → open → run → fire log → delete; this drives the
// workflow's own route through the same inventory, plus the two things a
// schedule never had — an ORDERED CHAIN, and a rail that says where it is.
//
// One deliberate difference: v1 has no `shell` kind, so there is no job that
// runs without a bot. The old spec used one precisely to avoid the session
// machinery; this one creates a shell-provider session and points the workflow
// at it. That is not a workaround, it is the model: a workflow IS a bot with a
// list of prompts, and a workflow with no bot has nowhere to deliver.

import { expect, test } from '@playwright/test'

import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('workflows', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('create → two steps → run now → the rail advances → the run timeline → delete', async ({
    page,
  }) => {
    test.setTimeout(120_000)

    // The owning bot. A shell provider needs no agent credentials, and the
    // workflow only has to REACH a pane — what the pane does with the prompt is
    // the engine's business, and `workflows_chain.rs` already proves it.
    const bot = 'e2e-wf-bot'
    expect(
      (await api(backend).createSession({ name: bot, provider: 'shell', dir: backend.dataDir }))
        .ok,
      'the owning bot exists',
    ).toBe(true)

    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(() => {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
      localStorage.setItem('supermux-first-launch', String(Date.now()))
    })
    await page.setViewportSize({ width: 1440, height: 900 })

    // ── The old URL still works ─────────────────────────────────────────────
    await page.goto(`${backend.baseUrl}/scheduler`)
    await expect(page, '/scheduler redirects to the workflows route').toHaveURL(
      /\/workflows$/,
      { timeout: 20_000 },
    )

    // ── CREATE — the composer is a PAGE, not a modal ────────────────────────
    await page.getByRole('link', { name: /New/ }).first().click()
    await expect(page, 'the composer has its own route').toHaveURL(/\/workflows\/new/, {
      timeout: 15_000,
    })

    // The composer's own accessible names — `workflow-composer.tsx` labels the
    // name field "Workflow name" (the visible caption above it says "Called")
    // and the bot picker through `SessionPicker`'s `ariaLabel`. Matching on
    // those is the point: a rename that breaks a screen reader breaks this test
    // too, which is exactly what the loose `/Title|.../` guess did NOT do — it
    // simply stopped matching anything when the editor panel was rebuilt, and
    // the spec timed out on a page that was working fine.
    await page.getByLabel('Workflow name').fill('e2e-workflow')

    // The bot it belongs to. `SessionPicker` is a dropdown of radio items on a
    // desktop width (the viewport this spec sets) and a Vaul sheet of buttons on
    // a phone; the trigger carries the same aria-label in both.
    await page.getByRole('button', { name: /Which bot runs this/ }).click()
    await page
      .getByRole('menuitemradio', { name: new RegExp(bot) })
      .click()
      .catch(async () => {
        // Phone form: the sheet lists plain buttons.
        await page.getByRole('button', { name: new RegExp(bot) }).last().click()
      })

    // ── TWO STEPS — the thing a schedule could never hold ────────────────────
    const stepText = page.getByPlaceholder(/What should .* do/i)
    await stepText.first().fill('say the first thing')
    await page.getByRole('button', { name: /Add step/i }).click()
    await stepText.last().fill('say the second thing')

    await page.getByRole('button', { name: /^Save|Create workflow/ }).first().click()

    // Saving lands on the workflow's OWN page, not back on the list — the
    // composer navigates to `workflowHref(savedId)`. Assert that, then walk to
    // the list, which is where the card + rail + toggle + row menu live.
    await expect(page, 'saving opens the workflow it just created').toHaveURL(
      /\/workflows\/[^/]+$/,
      { timeout: 20_000 },
    )
    await page.goto(`${backend.baseUrl}/workflows`)

    // ── LIST — the card, with its step rail ─────────────────────────────────
    const card = page.locator('li', { hasText: 'e2e-workflow' }).first()
    await expect(card, 'the created workflow is listed').toBeVisible({ timeout: 20_000 })
    await expect(
      card.locator('[data-status]').first(),
      'the step rail renders a node per step',
    ).toBeVisible()

    // ── PAUSE / RESUME — the enable toggle, as a real switch ────────────────
    const toggle = card.getByRole('switch').first()
    const wasOn = await toggle.getAttribute('aria-checked')
    await toggle.click()
    await expect(async () => {
      expect(await toggle.getAttribute('aria-checked')).not.toBe(wasOn)
    }).toPass({ timeout: 8_000 })
    await expect(card.getByText('next paused')).toBeVisible({ timeout: 8_000 })
    await toggle.click()
    await expect(async () => {
      expect(await toggle.getAttribute('aria-checked')).toBe(wasOn)
    }).toPass({ timeout: 8_000 })

    // ── RUN NOW — and WATCH THE RAIL MOVE ───────────────────────────────────
    // The rail is the whole reason the redesign exists: a cron table could say
    // "it ran", never "it is on step 2 of 4". The assertion is on the live
    // position, pushed over SSE — not on a refetch this test triggered.
    // "Run now" is a row-menu item, not a button on the card face — the card
    // face carries the title, the rail and the enable switch, and nothing else.
    await card.getByRole('button', { name: /^More for/ }).click()
    await page.getByRole('menuitem', { name: /Run now/ }).click()
    // `.first()`: the card says it twice on purpose — the live position rides
    // beside the rail, and the hint line underneath swaps "next …" for "running
    // now". Either one is the proof; a strict locator would only be proof that
    // the card is redundant.
    await expect(
      card.getByText(/step \d+\/2|running now/).first(),
      'the rail advanced',
    ).toBeVisible({ timeout: 30_000 })

    // ── THE RUN TIMELINE — on the workflow's own page ───────────────────────
    await card.getByText('e2e-workflow').first().click()
    await expect(page, 'the card opens the detail route').toHaveURL(/\/workflows\/[^/]+$/, {
      timeout: 15_000,
    })
    await expect(
      page.getByText(/Today|Yesterday/).first(),
      'the run history is filed under a day header',
    ).toBeVisible({ timeout: 30_000 })

    // ── DELETE — behind the armed confirm, then gone from the list ──────────
    // Back on the list, and through the row menu's ArmedButton: press once to
    // arm ("Delete"), once more to fire ("Delete it"). It is a button inside the
    // menu, deliberately not a menuitem — a one-press destructive menuitem is
    // exactly what `use-armed-confirm` exists to stop.
    await page.goto(`${backend.baseUrl}/workflows`)
    await page.getByRole('button', { name: /^More for e2e-workflow$/ }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete it' }).click()

    await page.goto(`${backend.baseUrl}/workflows`)
    await expect(
      page.getByText('e2e-workflow', { exact: true }),
      'the workflow is gone from the list',
    ).toHaveCount(0, { timeout: 20_000 })
  })
})
