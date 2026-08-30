/**
 * `logo-image.ts` — the client-side prep that makes "set our logo" work from a
 * phone's camera roll. Only the arithmetic is pure (the canvas half needs a DOM),
 * and the arithmetic is where the icon actually gets its shape.
 */
import { describe, expect, test } from 'bun:test'

import { fitWithin, LOGO_MAX_EDGE } from '../../src/lib/logo-image'

describe('fitWithin — the icon box', () => {
  test('a camera-roll photo is scaled to the box, aspect kept', () => {
    expect(fitWithin(4032, 3024, LOGO_MAX_EDGE)).toEqual({ width: 256, height: 192 })
  })

  test('a tall image is bounded by its LONGEST edge', () => {
    expect(fitWithin(1000, 2000, 256)).toEqual({ width: 128, height: 256 })
  })

  test('a small favicon is never upscaled (blowing it up only blurs it)', () => {
    expect(fitWithin(32, 32, 256)).toEqual({ width: 32, height: 32 })
  })

  test('an already-square icon at the box size is untouched', () => {
    expect(fitWithin(256, 256, 256)).toEqual({ width: 256, height: 256 })
  })

  test('an extreme ratio still leaves at least one pixel', () => {
    expect(fitWithin(4000, 3, 256)).toEqual({ width: 256, height: 1 })
  })

  test('a degenerate size is zero, not NaN', () => {
    expect(fitWithin(0, 0, 256)).toEqual({ width: 0, height: 0 })
  })
})
