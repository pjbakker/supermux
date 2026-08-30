/**
 * `anchoredMenuStyle` — the PURE placement math behind the company switcher's
 * desktop menu (`company-switcher.tsx`).
 *
 * WHY this is a fixed-position, portalled menu at all: the nav rail the scope
 * circle docks in is `overflow: hidden` at ≥768px (the floating window's rounded
 * left corners) AND shares `z-index: 1` with the later-painting content column.
 * An `absolute` menu inside the rail is therefore clipped to the 64px column and
 * painted under the roster — it opens, but nothing is ever visible. Escaping
 * that means leaving the rail's box, which means a viewport-relative rect.
 *
 * Placement is load-bearing (a wrong clamp puts the menu off-screen, which is
 * indistinguishable from the bug it fixes), and it is pure — so it lives here,
 * pinned by `tests/unit/anchored-menu.test.ts`, instead of inside the component.
 */

/** The anchor's viewport rect — the subset of `DOMRect` placement needs. */
export interface AnchorRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** The viewport the menu must stay inside. */
export interface Viewport {
  width: number
  height: number
}

export interface AnchoredMenuOptions {
  /** `'side'` = bottom-aligned to the anchor and opening to its RIGHT (the rail
   *  circle, which sits at the bottom-left corner, so a downward drop would run
   *  off the screen). `'below'` = the classic under-the-trigger drop (the chip). */
  side: 'side' | 'below'
  /** The menu's ideal width, capped so it can never spill past an edge. */
  width?: number
  /** Minimum distance to any viewport edge. */
  gutter?: number
  /** The gap between the anchor and the menu. */
  gap?: number
}

/** The computed `position: fixed` box. `bottom` and `top` are exclusive: `side`
 *  pins the bottom edge, `below` pins the top. */
export interface AnchoredMenuBox {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
}

/** Never collapse the menu to nothing on a tiny viewport — it scrolls instead. */
const MIN_HEIGHT = 120

/**
 * Place a menu against `anchor` inside `viewport`, clamped to the gutter on
 * every edge. Returns `null` when the anchor has no box at all — a trigger in a
 * `display:none` dock (the app mounts the switcher TWICE, one per dock, and the
 * hidden one measures 0×0). A portalled menu is not hidden by its owner's
 * `display:none`, so that case must be refused here rather than inherited.
 */
export function anchoredMenuStyle(
  anchor: AnchorRect | null,
  viewport: Viewport,
  { side, width: ideal = 300, gutter = 12, gap = 8 }: AnchoredMenuOptions,
): AnchoredMenuBox | null {
  if (!anchor) return null
  if (anchor.width === 0 && anchor.height === 0) return null

  const width = Math.max(0, Math.min(ideal, viewport.width - 2 * gutter))
  const clampLeft = (x: number) =>
    Math.max(gutter, Math.min(x, viewport.width - width - gutter))

  if (side === 'side') {
    // Bottom edge on the anchor's bottom, opening to its right. The space it has
    // is everything ABOVE that bottom edge, less the top gutter.
    const bottom = Math.max(gutter, viewport.height - anchor.bottom)
    return {
      left: clampLeft(anchor.right + gap),
      bottom,
      width,
      maxHeight: Math.max(MIN_HEIGHT, viewport.height - bottom - gutter),
    }
  }

  const top = anchor.bottom + gap
  return {
    left: clampLeft(anchor.left),
    top,
    width,
    maxHeight: Math.max(MIN_HEIGHT, viewport.height - top - gutter),
  }
}
