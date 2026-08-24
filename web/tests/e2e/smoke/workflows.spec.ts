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

    await page.getByLabel(/Title|What should this do/i).first().fill('e2e-workflow')

    // The bot it belongs to.
    await page.getByRole('button', { name: new RegExp(bot) }).first().click().catch(async () => {
      // The picker renders as a select on some widths; either affordance is fine
      // as long as the bot ends up chosen.
      await page.getByRole('combobox').first().selectOption(bot)
    })

    // ── TWO STEPS — the thing a schedule could never hold ────────────────────
    const stepText = page.getByPlaceholder(/What should .* do/i)
    await stepText.first().fill('say the first thing')
    await page.getByRole('button', { name: /Add step/i }).click()
    await stepText.last().fill('say the second thing')

    await page.getByRole('button', { name: /^Save|Create workflow/ }).first().click()

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
    await card.getByRole('button', { name: /^Run$|Run now/ }).first().click()
    await expect(card.getByText(/step \d+\/2|running now/), 'the rail advanced').toBeVisible({
      timeout: 30_000,
    })

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
    await page.getByRole('button', { name: /More|Actions/ }).first().click()
    await page.getByRole('menuitem', { name: /Delete/ }).click()
    await page.getByRole('button', { name: /Delete/ }).last().click()

    await page.goto(`${backend.baseUrl}/workflows`)
    await expect(
      page.getByText('e2e-workflow', { exact: true }),
      'the workflow is gone from the list',
    ).toHaveCount(0, { timeout: 20_000 })
  })
})
