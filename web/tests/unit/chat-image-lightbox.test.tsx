/**
 * The captured frame opens — the image is a door, and the door has four exits.
 * ─────────────────────────────────────────────────────────────────────────────
 * `CapturedFrameCard` renders a 16:10 `object-cover` CROP. Before this slice the
 * only thing you could click was the caption, and nothing in the app passed
 * `onOpen` — so a screenshot in a transcript was a 340px illustration of itself
 * with no way to read it. The card's image is now a button onto
 * `<ImageLightbox>`.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. This repo has no jsdom (see
 * `chat-composer-mic.test.tsx` for the same split stated at length), so the real
 * gestures — the drag, the double-click, focus landing in the trap — are
 * Playwright's job. What a static render CAN pin is everything a refactor
 * silently deletes: that the image is a BUTTON rather than a bare `<img>`, that
 * the caption row did not regress, and that the open overlay carries its dialog
 * role, its filename label, its 44px close target, its safe-area insets and its
 * `object-contain` fit. The one piece of the gesture that is a DECISION rather
 * than an event — the dismissal threshold — is a pure exported function, and is
 * asserted as one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { CapturedFrameCard } from '../../src/components/chat/ui/captured-frame-card'
import { ImageLightboxBody, swipeDismisses } from '../../src/components/chat/ui/image-lightbox'

const html = renderToStaticMarkup

const SHOT = '/api/files/raw?path=/tmp/release-run.png'

describe('CapturedFrameCard — the image is the door', () => {
  test('a real capture wraps its image in a button with a zoom affordance', () => {
    const out = html(<CapturedFrameCard caption="release-run.png" src={SHOT} />)
    expect(out).toContain('data-testid="captured-frame-open"')
    expect(out).toContain('cursor-zoom-in')
    // Named for a screen reader by the file it opens, not "button".
    expect(out).toContain('aria-label="Open release-run.png full screen"')
    // …and the image itself survived intact underneath it.
    expect(out).toContain(`src="${SHOT}"`)
    expect(out).toContain('object-cover')
  })

  test('the placeholder has no door — there is nothing behind it to open', () => {
    const out = html(<CapturedFrameCard caption="release-run.png" />)
    expect(out).not.toContain('captured-frame-open')
    expect(out).not.toContain('cursor-zoom-in')
  })

  test('the caption row keeps the onOpen its consumer passed (no regression)', () => {
    const out = html(
      <CapturedFrameCard caption="release-run.png" src={SHOT} onOpen={() => undefined} />,
    )
    // A caption <button>, as before — the deep link is a different intent from
    // "show me this bigger", so the lightbox does not steal it.
    expect(out).toContain('sm-t-hover')
    expect(out).toContain('release-run.png')
  })

  test('with a capture and no onOpen the caption opens the lightbox instead of going dead', () => {
    const out = html(<CapturedFrameCard caption="release-run.png" src={SHOT} />)
    // Two buttons: the frame and the caption row under it.
    expect(out.split('<button').length - 1).toBe(2)
  })

  test('a placeholder with no onOpen has no buttons at all — nothing to open', () => {
    const out = html(<CapturedFrameCard caption="release-run.png" />)
    expect(out.split('<button').length - 1).toBe(0)
    expect(out).toContain('release-run.png')
  })
})

describe('ImageLightbox — the overlay', () => {
  const open = (over: { caption?: string } = {}) =>
    html(
      <ImageLightboxBody
        open
        onOpenChange={() => undefined}
        src={SHOT}
        caption={over.caption ?? 'release-run.png'}
      />,
    )

  test('closed renders nothing at all', () => {
    expect(
      html(
        <ImageLightboxBody open={false} onOpenChange={() => undefined} src={SHOT} caption="a.png" />,
      ),
    ).toBe('')
  })

  test('it is a real dialog, labelled by the file it is showing', () => {
    const out = open()
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-modal="true"')
    expect(out).toContain('aria-label="Image: release-run.png"')
  })

  test('the image is CONTAINED, never cropped — that is the whole point', () => {
    const out = open()
    expect(out).toContain('object-contain')
    expect(out).not.toContain('object-cover')
    expect(out).toContain(`src="${SHOT}"`)
  })

  test('the close button is a ≥44px target with a real label', () => {
    const out = open()
    expect(out).toContain('data-testid="image-lightbox-close"')
    expect(out).toContain('aria-label="Close"')
    // size-11 is 44px — the touch-target floor this app holds everywhere else.
    expect(out).toContain('size-11')
  })

  test('the zoom control is a labelled toggle, not a mystery glyph', () => {
    const out = open()
    expect(out).toContain('aria-label="View at actual size"')
    expect(out).toContain('aria-pressed="false"')
  })

  test('the caption bar names the file and links the original at the same URL', () => {
    const out = open()
    expect(out).toContain('release-run.png')
    expect(out).toContain(`href="${SHOT}"`)
    expect(out).toContain('Open original')
    expect(out).toContain('rel="noreferrer"')
  })

  test('it respects the safe area on all four edges and never scrolls the page', () => {
    const out = open()
    for (const cls of ['pt-safe', 'pb-safe', 'pl-safe', 'pr-safe']) expect(out).toContain(cls)
    // The root is fixed and clips: a lightbox that gives the page a horizontal
    // scrollbar has moved the transcript under the user.
    expect(out).toContain('fixed inset-0 overflow-hidden')
  })

  test('it stacks above the sheets the chat surface can be sitting inside', () => {
    // z-50 focus sheet / z-65 compose panel — the ladder token, not a literal.
    expect(open()).toContain('var(--sm-z-actionsheet)')
  })
})

describe('swipe-to-dismiss — the threshold is a decision, so it is asserted', () => {
  test('a short drag springs back', () => {
    expect(swipeDismisses(40, 0)).toBe(false)
  })

  test('a long drag dismisses, however slowly it was made', () => {
    expect(swipeDismisses(140, 0)).toBe(true)
  })

  test('a fast flick dismisses from a third of the distance', () => {
    expect(swipeDismisses(60, 900)).toBe(true)
    // …but the same distance without the speed does not.
    expect(swipeDismisses(60, 100)).toBe(false)
  })

  test('dragging UP is a look behind the frame, never a dismissal', () => {
    expect(swipeDismisses(-200, -2000)).toBe(false)
  })
})

describe('the gesture wiring, as a source scan', () => {
  /**
   * A regression that a render CANNOT catch, so it is pinned as a scan — the
   * same idiom as `motion-tokens.test.ts`.
   *
   * The obvious way to write "no swipe while zoomed" is `drag={zoomed ? false :
   * 'y'}`. It is also wrong: toggling framer's `drag` on a mounted node drops
   * that node's exit-complete callback, so `AnimatePresence` never unmounts the
   * overlay. It fades to opacity 0 and then STAYS — a full-viewport invisible
   * layer swallowing every click on the transcript. Measured on /dev/chat-ui at
   * 390px (open → zoom → unzoom → Esc); `dragListener` has no such effect.
   */
  const src = readFileSync(
    fileURLToPath(new URL('../../src/components/chat/ui/image-lightbox.tsx', import.meta.url)),
    'utf8',
  )
  const card = readFileSync(
    fileURLToPath(new URL('../../src/components/chat/ui/captured-frame-card.tsx', import.meta.url)),
    'utf8',
  )

  test('the swipe is started by us, never by framer — and never by changing `drag`', () => {
    expect(src).toContain('dragListener={false}')
    expect(src).toContain('dragControls={dragControls}')
    expect(src).not.toContain('drag={zoomed')
  })

  test('a MOUSE never starts one — that movement is how a desktop user selects text', () => {
    // The concrete bug: dragging across the caption to select the filename
    // cleared the flick threshold and dismissed the lightbox mid-selection.
    // framer's own listener cannot see `pointerType`; our pointerdown can.
    expect(src).toContain("e.pointerType === 'mouse'")
  })

  test('`touch-action` is written by hand at BOTH ends of the zoom', () => {
    // Taking the listener means framer stops writing one. Left at `auto`, the
    // browser claims the vertical gesture ~16px in and fires `pointercancel` —
    // the swipe rubber-bands and never dismisses. Left at framer's `pan-x`, the
    // zoom scroller cannot be panned vertically at all. Both were measured.
    expect(src).toContain("touchAction: zoomed ? 'auto' : 'none'")
  })

  test('a single click zooms, and a double click is still ONE toggle', () => {
    // The cursor on that element promises `zoom-in`/`zoom-out`; before this it
    // answered only to a double click, so the single click the cursor advertised
    // did nothing at all. `detail > 1` drops a multi-click's repeats so a double
    // click is a toggle rather than a toggle plus its own undo.
    expect(src).toContain('if (e.detail > 1) return')
    expect(src).toContain('cursor-zoom-out')
  })

  test('BOTH images handle a load failure — a 404 is not a broken glyph', () => {
    // `src` present is not the same claim as `src` fetchable. Unhandled, the
    // lightbox draws the browser's broken-image icon at full-viewport size.
    expect(src).toContain('onError={() => setFailed(true)}')
    expect(src).toContain('This image could not be loaded.')
    expect(card).toContain('onError={() => setBroken(true)}')
    // …and the failed capture retires the door with it: no button, no caption
    // fallback, no overlay to open onto nothing.
    expect(card).toContain('const capture = broken ? undefined : src')
    expect(card).toContain('{capture && (')
  })
})
