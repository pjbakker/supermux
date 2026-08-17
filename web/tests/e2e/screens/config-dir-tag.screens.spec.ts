// Screenshot capture for the config-dir PR. Opens the DEV tiles harness (the
// smoke backend serves the Vite dev server, so /dev/tiles is available) and
// shoots the tile grid in light and dark, plus a crop of the one tile that
// carries an account tag. Writes PNGs to screens-out/ for the PR. Not an
// assertion suite.

import { test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { injectGlobals, startBackend } from '../smoke/harness'

const OUT = join(process.cwd(), 'screens-out')

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true })
})

for (const theme of ['light', 'dark'] as const) {
  test(`session tile - config dir tag (${theme})`, async ({ page }) => {
    const backend = await startBackend()
    try {
      await page.setViewportSize({ width: 1200, height: 900 })
      await page.addInitScript(injectGlobals(backend.token))
      await page.addInitScript((value) => {
        window.localStorage.setItem('supermux-theme', value)
      }, theme)
      await page.goto(`${backend.baseUrl}/dev/tiles`)
      const tag = page.getByText('.claude-second').first()
      await tag.waitFor()
      await page.waitForTimeout(400)
      await page.screenshot({
        path: join(OUT, `config-dir-tag-${theme}.png`),
        fullPage: true,
      })
      // The tag is a few pixels tall in the full grid, so also shoot the tile it
      // sits on: that is the shot a reviewer can actually read.
      const tile = page.getByRole('button').filter({ hasText: '.claude-second' })
      await tile.first().screenshot({
        path: join(OUT, `config-dir-tag-${theme}-tile.png`),
      })
    } finally {
      await backend.dispose()
    }
  })
}
