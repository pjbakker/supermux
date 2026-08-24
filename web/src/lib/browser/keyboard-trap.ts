/**
 * Typing into somebody else's page from a phone — the rules, kept pure.
 * ─────────────────────────────────────────────────────────────────────────────
 * A `<canvas>` cannot raise a soft keyboard. No amount of `tabIndex` changes
 * that: iOS and Android raise the keyboard for a focused EDITABLE element and
 * for nothing else. So the drivable viewport carries a real, visually-hidden
 * `<input>` — the keyboard trap — and a tap on the page focuses it. Everything
 * the human then types is relayed to the page and the trap is emptied again, so
 * it never accumulates text of its own and there is never a second cursor to
 * disagree with the page's.
 *
 * TWO RELAY PATHS, AND PICKING BETWEEN THEM IS THIS FILE'S JOB.
 *
 *   · `insert` — a printable character. It is NOT sent as a key event: the
 *     `input` event carries it as text (`ClientMsg::Text` → CDP `insertText`),
 *     which is the only path that survives emoji, dead keys, and an IME
 *     composing three keystrokes into one glyph. Android's GBoard does not even
 *     send a usable `key` for most presses (`Unidentified`) — the text is all
 *     there is.
 *   · `relay` — a key that inserts nothing but MEANS something: Enter,
 *     Backspace, Tab, the arrows, Escape, or any Ctrl/Alt chord. These go as
 *     `ClientMsg::Key` pairs, because "submit the form" is not text.
 *
 * Sending both for one press would type every character twice — the bug this
 * split exists to make impossible.
 */

/** What to do with a `keydown` that lands in the trap. */
export type TrapKeyAction =
  /** Forward as a key event (down+up). */
  | 'relay'
  /** Leave it to the `input` event, which will carry the text. */
  | 'insert'
  /** Neither: a bare modifier, a platform shortcut, or a key the engine
   *  refused to name. */
  | 'ignore'

/** Keys that are only ever a modifier — a page gets them from the modifier
 *  bitmask on the events that follow, never on their own. */
const BARE_MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead']

export function trapKeyAction(e: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): TrapKeyAction {
  const key = e.key
  if (!key) return 'ignore'
  // Android soft keyboards report this for ordinary letters; the `input` event
  // is the real signal there.
  if (key === 'Unidentified') return 'ignore'
  if (BARE_MODIFIERS.includes(key)) return 'ignore'
  // ⌘-anything stays with the platform (⌘R, ⌘L, the app's own shortcuts): a
  // relay that swallows them is a trap in the bad sense.
  if (e.metaKey) return 'ignore'
  // A chord inserts nothing — Ctrl+A is select-all, not the letter "a" — so it
  // has to travel as a key event even though `key` is printable.
  if (e.ctrlKey || e.altKey) return 'relay'
  return [...key].length === 1 ? 'insert' : 'relay'
}

/** How far above the keyboard the tapped field should sit, as a fraction of
 *  the space that is left. Not centred: a form field is usually followed by the
 *  thing you are about to press. */
const REST_FRACTION = 0.45

/** Slack at the bottom edge — a field this close to the keyboard is covered by
 *  it in practice, whatever the arithmetic says. */
const EDGE_MARGIN = 32

/**
 * How far to scroll the PAGE so the thing the human just tapped is not behind
 * the soft keyboard.
 *
 * The keyboard is the supermux app's, not the page's: chrome renders into a box
 * we told it about and knows nothing about a keyboard on the phone in front of
 * it. What we do know is (a) the page point that was tapped and (b) the height
 * the page is now laid out at, because the viewport shrank above the keyboard
 * and we re-sent `ClientMsg::Viewport`. If the tap is below the visible band,
 * this is the wheel delta that brings it back into it.
 *
 * Positive = scroll the page DOWN (content up), the sign `Input.dispatchMouse
 * Event`'s `deltaY` takes. `0` = already visible, and the caller sends nothing:
 * a zero-delta wheel on a page with scroll listeners is not free.
 */
export function keyboardScrollDelta(
  tapPageY: number,
  visibleHeight: number,
  margin = EDGE_MARGIN,
): number {
  if (!(visibleHeight > 0) || !Number.isFinite(tapPageY)) return 0
  if (tapPageY <= visibleHeight - margin) return 0
  const rest = visibleHeight * REST_FRACTION
  return Math.round(tapPageY - rest)
}
