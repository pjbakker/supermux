// The Invite-a-teammate wizard, end to end — the three bugs the owner hit, in
// the browser, on the real app.
// ─────────────────────────────────────────────────────────────────────────────
// 1. "Create a temporary link" showed a spinner and then NOTHING. The POST
//    returned a URL, cloudflared died on a closed stderr pipe, `status` said
//    `active:false`, and the sheet silently re-rendered its own chooser. Here
//    the link has to APPEAR.
// 2. The "Connect your own domain" instructions sent people into a zone menu
//    hunting for a "Cloudflare Tunnel" item that lives at account level. The
//    rewritten step has to name BOTH real token pages.
// 3. A valid account-owned token (`cfat_…`) was rejected as "not active",
//    because verification asked the user-token-only endpoint. Here an invalid
//    token must produce the honest mapped error AND a `cfat_` token must be
//    accepted and move the wizard on.
//
// WHY the Cloudflare surface is mocked at the network layer: every endpoint
// under `/api/external-access` ends at a real Cloudflare account or a real
// `cloudflared` child. CI has neither, and a test that needed them would be a
// test of the runner's internet. The BACKEND is real (companies, the shell, the
// switcher); only the four external-access calls are answered from this file,
// with the exact envelopes the server sends — so what is exercised is the whole
// client path: the wizard, the hooks, the payload, the status gating, and the
// error mapping.
//
// One test, one backend boot: the boot dominates the runtime (~20 s), so the
// whole journey is one spec rather than four that each pay for it. It stays
// untagged (PR-gated) because it lands well inside the per-test budget.

import { expect, test } from '@playwright/test'

import { injectGlobals, startBackend, type Backend } from './harness'

/** The token the mocked verify accepts — Cloudflare's ACCOUNT-OWNED shape, the
 *  kind the old `/user/tokens/verify` gate rejected as "not active". */
const ACCOUNT_OWNED_TOKEN = 'cfat_e2e_account_owned_token_value'
/** What the server answers for a token Cloudflare refuses (CfError::TokenInactive). */
const REFUSED_MESSAGE =
  'Cloudflare rejected this API token. Check you pasted the whole token, and that it has not been revoked or expired.'

const QUICK_HOST = 'e2e-temporary-link.trycloudflare.com'

test.describe('invite wizard (temporary link, domain instructions, token verify)', () => {
  let backend: Backend

  test.beforeEach(async ({ page }) => {
    backend = await startBackend()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addInitScript(injectGlobals(backend.token))
  })

  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('temporary link appears, the domain step names both token pages, a cfat_ token verifies', async ({
    page,
  }) => {
    // ── A company to invite INTO (the wizard is scoped to one). ──────────────
    const created = await page.request.post(`${backend.backendUrl}/api/companies`, {
      headers: { Authorization: `Bearer ${backend.token}` },
      data: { slug: 'acme', display_name: 'Acme' },
    })
    expect(created.ok()).toBeTruthy()
    const companyId = (await created.json()).data.id as number
    await page.addInitScript(
      (id: number) =>
        window.localStorage.setItem(
          'supermux-ui',
          JSON.stringify({ state: { botMode: true, activeCompany: id }, version: 1 }),
        ),
      companyId,
    )

    // ── The mocked Cloudflare surface: one mutable box state, four routes. ───
    // Mutations move this object exactly as the server would, and `status`
    // serves it — so the wizard's own gating decides what renders.
    const box: Record<string, unknown> = {
      cf_token: 'none',
      tunnel: 'none',
      dns_ok: false,
      google: 'unset',
    }
    const envelope = (data: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data }),
    })

    await page.route('**/api/external-access/status**', (route) =>
      route.fulfill(
        envelope({
          box_status: box,
          company: {
            company_id: companyId,
            company_host_written: false,
            redirect_registered: 'unknown',
            reachable: false,
            host: '',
            redirect_uri: '',
          },
        }),
      ),
    )

    await page.route('**/api/external-access/quick-tunnel', async (route) => {
      const method = route.request().method()
      if (method === 'DELETE') {
        delete box.quick_tunnel
        return route.fulfill(envelope({ torn_down: true }))
      }
      // The payload MUST carry the company id — a bare body is a 422 server-side.
      expect(route.request().postDataJSON()).toEqual({ company_id: companyId })
      box.quick_tunnel = {
        active: true,
        url: `https://${QUICK_HOST}`,
        host: QUICK_HOST,
        company_id: companyId,
        ephemeral: true,
      }
      return route.fulfill(
        envelope({
          url: `https://${QUICK_HOST}`,
          host: QUICK_HOST,
          ephemeral: true,
          company_id: companyId,
        }),
      )
    })

    await page.route('**/api/external-access/cf-token', (route) => {
      const token = String(route.request().postDataJSON()?.token ?? '')
      if (token !== ACCOUNT_OWNED_TOKEN) {
        // The server's honest refusal, verbatim.
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: REFUSED_MESSAGE }),
        })
      }
      box.cf_token = 'valid'
      return route.fulfill(envelope({ valid: true, account_id: 'acct-e2e' }))
    })

    await page.route('**/api/external-access/zones**', (route) =>
      route.fulfill(envelope({ zones: ['example.com'] })),
    )

    // ── Open the wizard from the company switcher. ──────────────────────────
    // The scope is SELECTED here rather than only seeded into storage: the
    // persisted id fails open to HQ until the company list has loaded, and the
    // "Invite a teammate" row only exists while a company is in scope.
    await page.goto(`${backend.baseUrl}/`)
    const switcher = page.getByRole('combobox', { name: /Company scope/i })
    await switcher.click()
    await page.getByRole('menuitemradio', { name: /Acme/ }).click()
    await expect(switcher).toHaveAccessibleName(/Acme/)
    await switcher.click()
    await page.getByRole('menuitem', { name: 'Invite a teammate' }).click()

    // ── 1. The temporary link. ──────────────────────────────────────────────
    const chooser = page.locator('[data-vr="qt-choice"]')
    await expect(chooser).toBeVisible()
    await page.getByRole('button', { name: 'Create a temporary link' }).click()

    const live = page.locator('[data-vr="qt-success"]')
    await expect(live).toBeVisible()
    await expect(live).toContainText('Temporary link — active')
    // The LINK itself, not just a happy chip — that is what was missing.
    await expect(live).toContainText(QUICK_HOST)

    // Clear it to reach the other branch (and prove the teardown path).
    await page.getByRole('button', { name: 'Stop / replace link' }).click()
    await expect(chooser).toBeVisible()

    // ── 2. The rewritten domain instructions. ───────────────────────────────
    await page.getByRole('button', { name: /Set up a domain/ }).click()
    const sheet = page.locator('[role="dialog"]').first()
    // BOTH token pages, because both kinds of token now work (bug 3's fix).
    await expect(sheet).toContainText('My Profile → API Tokens')
    await expect(sheet).toContainText('Manage Account → API Tokens')
    // The permission rows name the account-level Tunnel permission, which is
    // what nobody could find in a zone's menu.
    await expect(sheet).toContainText('Account · Cloudflare Tunnel · Edit')
    // And it says supermux makes the tunnel, so nobody goes hunting for one.
    await expect(sheet).toContainText('supermux builds the Cloudflare tunnel')

    // ── 3a. An invalid token gets the honest, mapped message. ───────────────
    await page.locator('#cf-token').fill('not-a-real-token')
    await page.getByRole('button', { name: 'Check the token' }).click()
    await expect(sheet).toContainText('Cloudflare rejected this API token')

    // ── 3b. An account-owned `cfat_` token is accepted and the wizard moves on.
    await page.locator('#cf-token').fill(ACCOUNT_OWNED_TOKEN)
    await page.getByRole('button', { name: 'Check the token' }).click()
    await expect(sheet).toContainText('Choose your domain')
    await expect(sheet).toContainText('example.com')
  })
})
