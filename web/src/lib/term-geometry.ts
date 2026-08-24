// ONE RESIZE PER ATTACH — the decision, on its own, so it can be tested.
//
// A resize frame is not free and it is not idempotent. It re-forks
// `tmux resize-window`; tmux's `refresh-client` schedules a redraw even when the
// size did not change; an inline TUI (Claude Code / Ink) answers that redraw by
// re-emitting its whole screen; and the server arms a full mid-stream RE-SEED
// 300 ms after any resize (`ws/mod.rs` `RESYNC_SETTLE`). The re-seed then lands
// in the MIDDLE of the repaint it caused, and a cursor-relative repaint applied
// on top of a re-seeded screen rewrites lines at the wrong column with no erase.
// That is what the owner saw as a doubled, spliced footer hint under an
// interactive question:
//
//   Enter to select · Tab/Arrow keys to navigate · Esc totcancelselect ·
//   Tab/Arrow keys to navigate · Esc to cancel
//
// Before this, EVERY attach sent the same cols×rows three times: batched with
// `auth` (that one is load-bearing — the server applies it before the seed
// capture), pushed again on `auth_ok`, and pushed a third time by the
// ResizeObserver's first debounced fit, whose "last sent" counters started at 0.
//
// Kept in a tiny standalone module for the same reason `term-history-flag.ts`
// is: the hook imports one function, and the rule is unit-testable without
// xterm, a DOM or a WebSocket.

/** The geometry a socket has already told the server about. `null` = it has told
 *  it nothing (a fresh socket, or one whose terminal had not laid out yet). */
export interface TermGeometry {
  cols: number
  rows: number
}

/**
 * Does the server still need to be told about this geometry?
 *
 * Two refusals, and they are different facts:
 *   · `0×0` is a terminal that has not laid out yet — there is nothing true to
 *     send, and the server's pre-seed peek would apply a degenerate size;
 *   · a repeat of what this socket already sent is not a resize at all.
 *
 * Every other case sends: the caller records the result as the new `sent`.
 */
export function geometryNeedsSend(
  sent: TermGeometry | null,
  cols: number,
  rows: number,
): boolean {
  if (!(cols > 0) || !(rows > 0)) return false
  return cols !== sent?.cols || rows !== sent?.rows
}
