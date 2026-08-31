/**
 * The shell overlay's Grok-mode ground — asserted by parsing grok-mode.css.
 *
 * THE INVARIANT: `[data-grok]` re-points `--sm-paper-raised` to `transparent`
 * so the chat transcript rides the substrate as one glass. The shell overlay
 * frame (`<ShellOverlayBody>`, e.g. the Archived-sessions panel) wears
 * `bg-paper-raised` + `shadow-[var(--sm-card-shadow)]` — which that re-point
 * (plus `--sm-card-shadow: none`) turns into an invisible, shadowless pane the
 * route content reads straight through. grok-mode.css therefore re-solidifies
 * exactly this frame with an opaque ground and the popover lift; this test
 * keeps both declarations from regressing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const CSS_PATH = fileURLToPath(
  new URL('../../src/styles/grok-mode.css', import.meta.url),
)

const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The body of the first block whose selector chain contains `sel`. */
function blockFor(sel: string): string {
  const at = css.indexOf(sel)
  expect(at).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('shell overlay frame under [data-grok]', () => {
  const body = blockFor("[data-grok] [data-testid='shell-overlay-frame']")

  test('gets an OPAQUE ground (the chrome token, never transparent)', () => {
    expect(body).toContain('background: var(--sm-bg-chrome)')
  })

  test('gets the popover lift back (card shadows are none under Grok)', () => {
    expect(body).toContain('box-shadow: var(--sm-shadow-popover)')
  })

  test('the transcript glass re-point it protects against still exists', () => {
    // If the transparent re-point is ever removed wholesale, this override can
    // go too — this test then fails as the signal to delete both together.
    expect(css).toContain('--sm-paper-raised: transparent')
  })
})
