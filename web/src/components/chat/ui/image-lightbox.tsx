/**
 * The captured frame, opened — a full-viewport look at one image.
 * ─────────────────────────────────────────────────────────────────────────────
 * `CapturedFrameCard` renders a 340×212 crop (`object-cover`) of something the
 * session made or saw. A crop is the right thing in the column and the WRONG
 * thing the moment somebody wants to read it: a terminal screenshot at 340px is
 * an illustration of a screenshot. So the card's image is a button, and this is
 * what it opens.
 *
 * WHY IT IS NOT `<Dialog>` (components/ui/dialog.tsx). That component is a
 * centred card with 24px padding, a border and a `max-w-lg` ceiling — every one
 * of which is wrong for a full-bleed photo view, so consuming it would mean
 * overriding all of it. What IS reused is the pattern `shell-overlay.tsx`
 * already proved on this codebase: `createPortal` + Radix `FocusScope` +
 * `AnimatePresence`, with Esc and focus-restore wired by hand. Same primitives,
 * one layer lower.
 *
 * THE FOUR DISMISSALS, and why there are four:
 *   · Esc            — captured at the document, so it fires wherever focus sits
 *   · the letterbox  — a click that lands on the stage rather than the image
 *   · the ✕          — a 44px target, top-right, inside the safe-area inset
 *   · swipe down     — touch ONLY (see the drag node): it is the gesture a phone
 *                      user reaches for first, and it is also the one that must
 *                      never fire for a mouse, where the same movement is how a
 *                      person selects the filename in the caption bar
 *
 * A CAPTURE THAT WILL NOT LOAD says so. `src` present is not the same claim as
 * `src` fetchable — the file can be deleted, still being written, or outside
 * what the server will serve — and the failure mode of an unhandled `<img>` here
 * is a broken-image glyph the size of the screen. `onError` swaps in a stated
 * reason instead, and the card does the same with its warm placeholder.
 *
 * ZOOM is fit ↔ actual size, and it is deliberately NOT a transform. A scaled
 * `<img>` needs pan maths, drag constraints that have to be recomputed on every
 * viewport change, and momentum that has to be hand-written; a natural-size
 * image inside an `overflow-auto` box needs none of that, because the browser's
 * own scroller already does panning, momentum, and bounds — correctly, on every
 * engine. `m-auto` (not `justify-center`) is what keeps it centred while it is
 * SMALLER than the box without clipping the top-left once it is bigger.
 *
 * Relative imports, like everything else in `components/chat/ui/`: `bun test`
 * resolves these files directly and does not read the app tsconfig's aliases.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion'
import { FocusScope } from '@radix-ui/react-focus-scope'
import { ExternalLink, ImageOff, X, ZoomIn, ZoomOut } from 'lucide-react'

import { cn } from '../../../lib/utils'
import { motionOff, springs, tweens } from '../../../lib/springs'

import { FileIcon } from './icons'

/** Drop far enough and it is a dismissal rather than a look-behind. */
const SWIPE_DISMISS_PX = 110
/** …or flick fast enough, from a third of that distance (px/s). */
const SWIPE_FLICK_PX_S = 650

/**
 * Has this drag earned a dismissal?
 *
 * Exported and pure because it is the one piece of the gesture a unit test can
 * actually hold: this repo has no jsdom, so the drag ITSELF is Playwright's job
 * (the same split `chat-composer-mic.test.tsx` names), but the threshold is a
 * decision, and a decision with nothing asserting it drifts.
 */
export function swipeDismisses(offsetY: number, velocityY: number): boolean {
  if (offsetY <= 0) return false // upward rubber-band is a look, not a dismissal
  return offsetY > SWIPE_DISMISS_PX || (offsetY > SWIPE_DISMISS_PX / 3 && velocityY > SWIPE_FLICK_PX_S)
}

/** `useLayoutEffect` warns off the DOM, and the unit tests render on the server. */
const useIsoLayoutEffect = typeof document === 'undefined' ? React.useEffect : React.useLayoutEffect

export interface ImageLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The served-file URL — the same `rawUrl(path)` the card's `<img>` uses. */
  src: string
  /** The filename. Names the dialog, and labels its caption bar. */
  caption: string
  alt?: string
}

export function ImageLightbox({ open, onOpenChange, src, caption, alt }: ImageLightboxProps) {
  const reduce = useReducedMotion()

  // Esc closes. Captured at the document so it fires wherever focus sits inside
  // the trapped frame — the same reason shell-overlay.tsx captures it.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onOpenChange])

  // The transcript behind the scrim must not scroll under the finger. `fixed
  // inset-0` alone does not stop that on touch — the body does.
  React.useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Focus returns to the frame that opened it, captured on open rather than
  // trusting the trigger to still be mounted (a streaming transcript re-renders
  // under the overlay).
  const restoreRef = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null
      return
    }
    restoreRef.current?.focus?.()
  }, [open])

  if (typeof document === 'undefined') return null

  return createPortal(
    <ImageLightboxBody
      open={open}
      onOpenChange={onOpenChange}
      src={src}
      caption={caption}
      alt={alt}
      reduce={!!reduce}
    />,
    document.body,
  )
}

/** The 44px chrome buttons — a floating glass circle over an unknown image, so
 *  the ink is fixed white rather than themed: the surface under it is the
 *  user's screenshot, not the app's paper. */
const CHROME_BTN =
  'flex size-11 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/85 backdrop-blur-md sm-t-hover hover:bg-black/65 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80'

/**
 * The overlay's markup, WITHOUT the portal.
 *
 * Split out for exactly the reason `ShellOverlayBody` is: `react-dom/server`
 * does not execute `createPortal`, so a test that renders `<ImageLightbox>`
 * gets an empty string and can prove nothing.
 */
export function ImageLightboxBody({
  open,
  onOpenChange,
  src,
  caption,
  alt,
  reduce = false,
}: ImageLightboxProps & { reduce?: boolean }) {
  const [zoomed, setZoomed] = React.useState(false)
  // A capture that 404s (deleted, still uploading, a path the server will not
  // serve) must not become a full-viewport broken-image glyph. Same honesty rule
  // the card's warm placeholder is built on: say so, do not draw a lie.
  const [failed, setFailed] = React.useState(false)
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  const imgRef = React.useRef<HTMLImageElement | null>(null)
  const dragControls = useDragControls()

  // The drag offset, shared with the scrim so the background lightens under the
  // finger — the swipe reads as "putting it back" instead of as a stuck sheet.
  const y = useMotionValue(0)
  const scrimFade = useTransform(y, [0, SWIPE_DISMISS_PX * 2], [1, 0.45])

  // A dismissing drag unmounts the frame with `y` still parked where the finger
  // left it, and the motion value outlives the frame. Re-seat it BEFORE paint on
  // the way back in, or the next open starts halfway down the screen.
  useIsoLayoutEffect(() => {
    if (!open) return
    y.set(0)
    setZoomed(false)
    setFailed(false)
  }, [open, y])

  /** Fit ↔ actual size. An image that already fits stays fit — zooming it would
   *  be a no-op that leaves the control looking broken. */
  const toggleZoom = React.useCallback(() => {
    setZoomed((was) => {
      if (was) return false
      if (!imgRef.current) return false // nothing loaded to zoom INTO
      const stage = stageRef.current
      const img = imgRef.current
      if (stage && img && img.naturalWidth > 0) {
        if (img.naturalWidth <= stage.clientWidth && img.naturalHeight <= stage.clientHeight) {
          return false
        }
      }
      return true
    })
  }, [])

  return (
    <AnimatePresence initial={false}>
      {open && (
        <div
          data-testid="image-lightbox"
          className="fixed inset-0 overflow-hidden"
          // Above the focus sheet (z-50) and the compose panel (z-65) that the
          // chat surface can be sitting inside — a lightbox opened from a
          // message must be the top layer of that stack.
          style={{ zIndex: 'var(--sm-z-actionsheet)' }}
        >
          {/* Scrim, in two layers on purpose: the outer one owns the enter/exit
              fade, the inner one the drag-linked one. One element cannot carry
              two independent opacities. A near-opaque fixed black — the app's
              `--sm-scrim` is a 38% dim, which is right over paper and far too
              light behind a photograph. */}
          <motion.div
            data-testid="image-lightbox-scrim"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: reduce ? motionOff : tweens.popoverOut }}
            transition={reduce ? motionOff : tweens.popoverIn}
            className="absolute inset-0"
          >
            <motion.div
              className="size-full"
              style={{ opacity: scrimFade, background: 'rgba(6,4,3,0.96)' }}
            />
          </motion.div>

          <FocusScope asChild trapped loop>
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label={`Image: ${caption}`}
              data-testid="image-lightbox-frame"
              tabIndex={-1}
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              // Faster out than in — the rule is stated in lib/springs.ts.
              exit={
                reduce
                  ? { opacity: 0, transition: motionOff }
                  : { opacity: 0, scale: 0.96, transition: tweens.overlayExit }
              }
              transition={reduce ? motionOff : springs.settle}
              className="absolute inset-0 outline-none"
            >
              {/* Swipe down to dismiss. Two things about this element are load
                  bearing, and both were found by measurement rather than by
                  reading the docs (/dev/chat-ui at 390px — open, zoom, unzoom,
                  Esc):

                  1. THE DRAG IS GATED WITH `dragListener`, NEVER BY CHANGING
                     `drag`. Toggling `drag` on a mounted node drops its
                     exit-complete callback, and `AnimatePresence` then never
                     unmounts the overlay — it finishes fading to opacity 0 and
                     sits there, invisible, eating every click on the transcript
                     underneath. `dragListener` only gates the pointer listener,
                     so the presence bookkeeping survives.
                  2. IT IS ITS OWN ELEMENT, one inside the dialog. The dialog
                     animates `scale` on the way in and out; the drag writes
                     `y`. Two owners for one transform matrix is a fight nobody
                     wins, so they get one node each.

                  `touch-action` IS OURS TO WRITE, and it has to be written.
                  framer only sets one while it owns the listener, so taking the
                  listener (3 below) silently handed it back to `auto` — and the
                  browser then claimed the vertical gesture ~16px in and fired
                  `pointercancel`, which reads as a swipe that rubber-bands and
                  refuses to dismiss. `none` while fit: we own the gesture, the
                  transcript behind cannot scroll, and the browser stops eating
                  the double-tap. `auto` while zoomed, or it would veto every pan
                  inside the scroller below.

                  3. IT IS A TOUCH GESTURE, AND ONLY A TOUCH GESTURE. framer's own
                     listener cannot tell a finger from a mouse, so on the desktop
                     a drag across the caption — the ordinary way anyone selects a
                     filename — cleared the flick threshold and DISMISSED the
                     lightbox mid-selection. `dragControls` moves the decision to
                     our own pointerdown, where `pointerType` is readable, so a
                     mouse never starts one and text selection is left alone. */}
              <motion.div
                drag="y"
                // Never `dragListener` — see 3 above; we start drags ourselves.
                dragListener={false}
                dragControls={dragControls}
                onPointerDown={(e) => {
                  if (zoomed || e.pointerType === 'mouse') return
                  dragControls.start(e)
                }}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={0.55}
                dragMomentum={false}
                onDragEnd={(_event, info) => {
                  if (swipeDismisses(info.offset.y, info.velocity.y)) onOpenChange(false)
                }}
                style={{ y, touchAction: zoomed ? 'auto' : 'none' }}
                className="flex size-full flex-col"
              >
                {/* The safe-area inset and the chrome's own padding sit on
                    SEPARATE elements: `pt-safe` and `p-2` both write
                    `padding-top`, and two utilities fighting over one property is
                    a coin-flip on cascade order. */}
                <div className="shrink-0 pl-safe pr-safe pt-safe">
                  <div className="flex items-start justify-end gap-2 p-2">
                    {!failed && (
                      <button
                        type="button"
                        onClick={toggleZoom}
                        aria-pressed={zoomed}
                        aria-label={zoomed ? 'Fit image to the screen' : 'View at actual size'}
                        className={CHROME_BTN}
                      >
                        {zoomed ? (
                          <ZoomOut className="size-[18px]" />
                        ) : (
                          <ZoomIn className="size-[18px]" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenChange(false)}
                      aria-label="Close"
                      data-testid="image-lightbox-close"
                      className={CHROME_BTN}
                    >
                      <X className="size-[18px]" />
                    </button>
                  </div>
                </div>

                {/* The stage owns BOTH clicks, told apart by where they landed.
                    On the stage itself — the letterbox around the picture — a
                    click dismisses. On anything inside it (the picture) it
                    toggles the zoom, because the cursor on that element has been
                    promising exactly that (`zoom-in` / `zoom-out`) since it was
                    drawn and used to answer only a DOUBLE click. `detail > 1`
                    drops the repeats of a multi-click, so a double click stays
                    one toggle rather than a toggle plus its own undo.

                    The handler is here rather than on the `<img>` because an
                    `<img onClick>` is a non-interactive element with a mouse
                    listener — two `jsx-a11y` errors, and a keyboard user with no
                    way to fire it. The zoom's keyboard route is the labelled
                    toggle in the chrome above, which is a real button. */}
                <motion.div
                  ref={stageRef}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) {
                      onOpenChange(false)
                      return
                    }
                    if (e.detail > 1) return
                    toggleZoom()
                  }}
                  className={cn(
                    'flex min-h-0 flex-1 pl-safe pr-safe',
                    zoomed ? 'overflow-auto overscroll-contain' : 'overflow-hidden',
                  )}
                >
                  {failed ? (
                    <div
                      data-testid="image-lightbox-failed"
                      className="m-auto flex max-w-[19rem] flex-col items-center gap-2 px-6 text-center"
                    >
                      <ImageOff className="size-6 text-white/45" />
                      <p className="text-[13.5px] leading-snug text-white/70">
                        This image could not be loaded.
                      </p>
                      <p className="text-[12.6px] leading-snug tracking-[-0.05px] text-white/45">
                        The file may have moved, or the session may not have finished writing it.
                      </p>
                    </div>
                  ) : (
                    <img
                      ref={imgRef}
                      src={src}
                      alt={alt ?? caption}
                      draggable={false}
                      onError={() => setFailed(true)}
                      className={cn(
                        'm-auto block select-none',
                        zoomed
                          ? 'max-w-none cursor-zoom-out'
                          : 'max-h-full max-w-full cursor-zoom-in object-contain',
                      )}
                    />
                  )}
                </motion.div>

                <div className="shrink-0 pb-safe pl-safe pr-safe">
                  <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                    <span className="flex flex-none text-white/55">
                      <FileIcon />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.6px] tracking-[-0.05px] text-white/70">
                      {caption}
                    </span>
                    <a
                      href={src}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-11 flex-none items-center gap-1.5 rounded-full px-3 text-[12.6px] tracking-[-0.05px] text-white/70 sm-t-hover hover:text-white"
                    >
                      Open original
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          </FocusScope>
        </div>
      )}
    </AnimatePresence>
  )
}
