/**
 * The full-screen Claude Code cast behind `/dev/focus/:name?screen=cc`.
 * ─────────────────────────────────────────────────────────────────────────────
 * The bench's default screen is the tile's six-line `preview_ansi` tail, which is
 * all a ROSTER TILE ever needs. Focus mode is the other thing entirely: it is the
 * full pty, and a capture of it has to show what a real Claude Code screen shows
 * — receipts, a timing line, and the composer at the bottom with a caret in it.
 * Shot against the tail the pane was three-quarters empty black, which is not
 * what the surface looks like in use.
 *
 * The SHAPE below is not invented. It is the layout Claude Code 2.1.23x actually
 * ships, verified against the captured fixture `tests/fixtures/tui/cc233/
 * 60-streaming-prose.txt` and documented at `components/chat/provisional.ts:95`:
 * a `✻ <verb> for <n>s` timing line, a full-width rule, the bare `❯ ` composer
 * (carrying a draft here, with the block cursor after it), and a second rule.
 * The mode footer the real screen prints below that rule is left OUT: its `⏵⏵`
 * is absent from the mono stack and draws as two blank cells. The CONTENT is the
 * same mock session the rest of the bench uses — `web-app`, wiring the SSE delta
 * merge — so nothing here is a real session, a real name, or real client work.
 *
 * DEV-only: imported by the `/dev/focus` route, which is itself lazy, so none of
 * this reaches a production chunk.
 */

const E = '\x1b'
/** The block cursor a real terminal parks after the draft. A literal block, not
 *  SGR 7 — the renderer draws attributes, not a cursor cell. */
const CURSOR = `${E}[97m█${E}[0m`
/** Claude Code rules the FULL terminal width; 152 cells is the pane the README
 *  still is cropped from, so the rule reaches both edges instead of stopping a
 *  third of the way across. */
const RULE = '─'.repeat(168)

export const CC_SCREEN_ANSI: string[] = [
  `${E}[32m●${E}[0m Read ${E}[36msrc/hooks/use-sessions.ts${E}[0m ${E}[90m(1 file)${E}[0m`,
  '',
  `${E}[32m●${E}[0m ${E}[36mGrep${E}[0m(pattern: "applyDelta")`,
  `  ${E}[90m⎿${E}[0m Found ${E}[33m3${E}[0m files`,
  `     ${E}[90msrc/hooks/use-live-term.ts${E}[0m`,
  `     ${E}[90msrc/components/terminal/live-terminal.tsx${E}[0m`,
  '',
  `${E}[32m●${E}[0m ${E}[36mUpdate${E}[0m(src/hooks/use-sessions.ts)`,
  `  ${E}[90m⎿${E}[0m Updated with ${E}[32m24 additions${E}[0m and ${E}[31m6 removals${E}[0m`,
  `     ${E}[90m142${E}[0m ${E}[32m+  const merged = applyDelta(cache, evt.delta)${E}[0m`,
  `     ${E}[90m143${E}[0m ${E}[32m+  qc.setQueryData(SESSIONS_KEY, merged)${E}[0m`,
  '',
  `${E}[32m●${E}[0m ${E}[36mBash${E}[0m(bun run build)`,
  `  ${E}[90m⎿${E}[0m tsc -b && vite build`,
  `     ${E}[32m✓${E}[0m 2243 modules transformed.`,
  `     ${E}[32m✓${E}[0m built in ${E}[33m245ms${E}[0m`,
  '',
  `${E}[32m●${E}[0m ${E}[36mBash${E}[0m(bun test tests/unit)`,
  `  ${E}[90m⎿${E}[0m ${E}[32m212 pass${E}[0m, 0 fail`,
  '',
  `${E}[32m●${E}[0m The delta merge is wired and the suite is green.`,
  '',
  `${E}[90m✻${E}[0m ${E}[90mBrewed for 34s${E}[0m`,
  '',
  `${E}[90m${RULE}${E}[0m`,
  `❯ now add a case for the out-of-order delta${CURSOR}`,
  `${E}[90m${RULE}${E}[0m`,
]

/** The plain-text twin, for the non-ANSI cached-tail path. */
export const CC_SCREEN_LINES: string[] = CC_SCREEN_ANSI.map((l) =>
  // eslint-disable-next-line no-control-regex
  l.replace(/\x1b\[[0-9;]*m/g, ''),
)
