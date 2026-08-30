/**
 * `anchoredMenuStyle` — the placement math for the company switcher's desktop
 * menu (`lib/anchored-menu.ts`).
 *
 * This is the regression net for the owner-reported "the desktop company
 * switcher is dead" bug: the menu docked in the nav rail opened correctly (state
 * flipped, every row rendered) but was CLIPPED away by the rail's
 * `overflow: hidden` and painted under the content column, which shares its
 * `z-index`. The fix portals it out and places it `fixed` from the trigger's
 * measured rect — so a wrong number here is once again an invisible menu, which
 * is exactly the failure it replaced. Hence: pinned, not assumed.
 */
import { describe, expect, test } from 'bun:test'

import { anchoredMenuStyle, type AnchorRect } from '@/lib/anchored-menu'

/** The desktop rail's scope circle: 44px, bottom-left, inside a 10px window
 *  gutter — the real geometry measured on a 1440×900 viewport. */
const RAIL_CIRCLE: AnchorRect = {
  left: 20,
  right: 64,
  top: 790,
  bottom: 834,
  width: 44,
  height: 44,
}
const DESKTOP = { width: 1440, height: 900 }

describe('anchoredMenuStyle — the rail circle (side)', () => {
  test('opens to the RIGHT of the circle, bottom-aligned to it', () => {
    const box = anchoredMenuStyle(RAIL_CIRCLE, DESKTOP, { side: 'side' })!
    expect(box.left).toBe(72) // 64 (circle right) + 8 gap — clear of the rail
    expect(box.bottom).toBe(66) // 900 − 834: bottom edge on the circle's bottom
    expect(box.top).toBeUndefined() // bottom-pinned, never both
    expect(box.width).toBe(300)
  })

  test('the max-height is the room ABOVE it, so a long list never runs off the top', () => {
    const box = anchoredMenuStyle(RAIL_CIRCLE, DESKTOP, { side: 'side' })!
    // 900 − 66 (bottom) − 12 (top gutter) = 822 — and the menu itself is ~453px.
    expect(box.maxHeight).toBe(822)
    expect(box.bottom! + box.maxHeight).toBeLessThanOrEqual(DESKTOP.height)
  })

  test('a short viewport still leaves a scrollable menu, never a zero-height one', () => {
    const low = { left: 20, right: 64, top: 60, bottom: 104, width: 44, height: 44 }
    const box = anchoredMenuStyle(low, { width: 1440, height: 120 }, { side: 'side' })!
    expect(box.maxHeight).toBeGreaterThanOrEqual(120)
  })
})

describe('anchoredMenuStyle — the chip (below)', () => {
  const chip: AnchorRect = { left: 96, right: 260, top: 24, bottom: 56, width: 164, height: 32 }

  test('drops under the trigger, left-aligned to it', () => {
    const box = anchoredMenuStyle(chip, DESKTOP, { side: 'below', gap: 6 })!
    expect(box.left).toBe(96)
    expect(box.top).toBe(62) // 56 + 6
    expect(box.bottom).toBeUndefined()
    expect(box.top! + box.maxHeight).toBeLessThanOrEqual(DESKTOP.height)
  })
})

describe('anchoredMenuStyle — viewport safety', () => {
  test('a right-edge anchor is pulled back inside instead of spilling', () => {
    const right: AnchorRect = {
      left: 1380,
      right: 1424,
      top: 790,
      bottom: 834,
      width: 44,
      height: 44,
    }
    const box = anchoredMenuStyle(right, DESKTOP, { side: 'side' })!
    // Ideal left would be 1432 (off-screen); clamped to 1440 − 300 − 12.
    expect(box.left).toBe(1128)
    expect(box.left + box.width).toBeLessThanOrEqual(DESKTOP.width)
  })

  test('a viewport narrower than the menu shrinks the menu, not the gutters', () => {
    const box = anchoredMenuStyle(RAIL_CIRCLE, { width: 280, height: 900 }, { side: 'side' })!
    expect(box.width).toBe(256) // 280 − 2×12
    expect(box.left).toBe(12)
    expect(box.left + box.width).toBeLessThanOrEqual(280)
  })

  test('the left clamp never pushes the menu off the LEFT edge either', () => {
    const offLeft: AnchorRect = {
      left: -400,
      right: -356,
      top: 790,
      bottom: 834,
      width: 44,
      height: 44,
    }
    const box = anchoredMenuStyle(offLeft, DESKTOP, { side: 'side' })!
    expect(box.left).toBe(12)
  })
})

describe('anchoredMenuStyle — the hidden-dock refusal', () => {
  // The app mounts the switcher TWICE (desktop rail + mobile bar), one always
  // inside a `display:none` wrapper. A portalled menu is NOT hidden by its
  // owner's `display:none`, so the 0×0 rect has to be refused here or the hidden
  // dock's menu would float over the app.
  test('a 0×0 anchor (display:none dock) places nothing', () => {
    const hidden: AnchorRect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
    expect(anchoredMenuStyle(hidden, DESKTOP, { side: 'side' })).toBeNull()
  })

  test('no anchor measured yet places nothing', () => {
    expect(anchoredMenuStyle(null, DESKTOP, { side: 'side' })).toBeNull()
  })

  test('a real anchor that merely SITS at the origin is still placed', () => {
    const atOrigin: AnchorRect = { left: 0, right: 44, top: 0, bottom: 44, width: 44, height: 44 }
    expect(anchoredMenuStyle(atOrigin, DESKTOP, { side: 'side' })).not.toBeNull()
  })
})
