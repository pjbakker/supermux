// "KEEP ME SIGNED IN" — the copy, as a pure function.
//
// The whole feature has exactly one control (a ⋯ menu row) and one sentence of
// state under it, so that sentence is the entire interface and it has to be
// right in seven distinct situations. It lives here, away from React, because:
//
//   · it is the only place that decides what supermux CLAIMS about a sign-in,
//     and that claim is checkable — see `browser-keep-signed-in.test.ts`;
//   · a phone has no hover, so the ⋯ row's `hint` (a `title=` attribute) is
//     invisible there. The detail line is the state, not a tooltip;
//   · every string has to FIT: the menu is a fixed 232px popup and the detail
//     line clamps at two lines, which is `DETAIL_MAX` characters — the MEASURED
//     54, not an estimate. The test asserts it against the constant.
//
// HONESTY RULES, in the same order the branches are written:
//   1. Never say "you are signed in". Say when it last CHECKED, or say why it
//      cannot. "Checked" means a PING happened — `last_probe_at`, never
//      `last_keepalive_at`. The latter is only the scheduler's cursor: the
//      sweep stamps it on every tick it completes, INCLUDING the ticks that
//      learned nothing (an unclear streak backing off, a wake that failed, a
//      page that cannot be pinged). Reading the age off it renders
//      "checked 1 min ago" over a tab whose every ping has failed for a day —
//      the false green light this whole surface exists to prevent.
//   2. `needs_login` outranks EVERYTHING once the toggle is on — "starting"
//      included. A signed-out tab 409s every bot on it, that is the fact the
//      owner has to act on, and re-toggling the feature nulls the schedule
//      stamp without clearing the gate.
//   3. A tab that has fallen behind says so with the age, rather than showing a
//      cadence it is not keeping — and it says it in the ATTENTION tint, not in
//      the same grey as a healthy line. The two states that need the owner
//      (signed out, cannot check) are the two the whole surface exists for.
//   4. Watch mode says supermux is WATCHING, never refreshing — because it is
//      deliberately not refreshing, and claiming otherwise on a bank tab would
//      be the worst lie this surface could tell.
import { ago, tabHost, type BrowserTab } from '@/lib/api/browser'

/** The longest a detail line may be.
 *
 *  MEASURED, not estimated. In the 232px menu the detail column is **176px**
 *  (the row's padding plus the 16px icon and its gap take the rest) at
 *  11.5px/15.8px, and it clamps at two lines — so about 27 characters per line.
 *  A 61-character line already truncates: the rig read `scrollHeight 47` against
 *  `clientHeight 32` on `Refresh crm.example in the background so bots stay
 *  signed in.`, which is the honest half of the sentence going invisible on the
 *  device this feature is for.
 *
 *  54 is that measurement with a character of slack, and the test holds every
 *  string this module can produce — hostnames interpolated — under it. */
export const DETAIL_MAX = 54

/** A tab is "behind" once it has missed three of its own intervals. Three, not
 *  one: a single skipped tick is normal (the owner was driving, the box was
 *  busy, a wake was deferred by the per-tick budget). */
export const STALE_INTERVALS = 3

/** What the ⋯ menu row renders. `label` is the VERB (the Pin/Unpin precedent),
 *  `detail` is the evidence. */
export interface KeepAliveRow {
  label: string
  detail?: string
  disabled?: boolean
  hint?: string
  /** This row's STATE needs the owner: it is signed out, or supermux can no
   *  longer check it. The menu tints the detail line and the icon; the label
   *  stays neutral, because the VERB is not the problem.
   *
   *  Without this the two states the feature exists to surface rendered in the
   *  same muted grey as "Every 45 min · checked 12 min ago." — a day of failed
   *  checks looked exactly like a healthy day. */
  attention?: boolean
}

/** `ago()` with its "ago" removed — a DURATION, not a moment.
 *
 *  `ago()` already appends "ago", so "since 1 d ago" was a grammatical slip on
 *  the one line that has to carry a whole day of failure. "just now" has no
 *  duration reading at all, hence "a moment". */
export function span(seconds: number): string {
  const phrase = ago(seconds)
  return phrase === 'just now' ? 'a moment' : phrase.replace(/ ago$/, '')
}

/** Seconds since this tab was last actually CHECKED, and the window it has to
 *  beat. `last_probe_at` is the only honest clock (a tick that learned nothing
 *  still stamps `last_keepalive_at`); a tab that has never been probed measures
 *  from its first completed tick instead, so "hasn't checked yet" can still
 *  escalate rather than reading as fine forever. */
function checkGap(tab: BrowserTab, now: number): { since: number; stale: boolean } {
  const clock = tab.last_probe_at ?? tab.last_keepalive_at ?? now
  const since = Math.max(0, now - clock)
  return { since, stale: since > STALE_INTERVALS * Math.max(1, tab.keepalive_every) * 60 }
}

/** Coarse on purpose: nobody acts on the difference between 46 and 45 minutes,
 *  and a precise number invites the interval picker this feature does not have. */
export function everyLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '15 min'
  if (minutes < 120) return `${Math.round(minutes)} min`
  return `${Math.round(minutes / 60)} h`
}

/** Is this a page the ping can even reach? `location.origin` on `about:blank`
 *  is the string `'null'`, so there is nothing to fetch and nothing to learn. */
export function canKeepSignedIn(url: string | undefined): boolean {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'))
}

/** Is this tab in watch mode? Any unrecognised value — including the column's
 *  legacy `reload` default — means soft, exactly as the server reads it. */
export function isWatching(tab: BrowserTab): boolean {
  return tab.keepalive_action === 'watch'
}

/** The ⋯ row. `now` is injectable so the age lines are testable without a clock. */
export function keepAliveRow(
  tab: BrowserTab | null | undefined,
  now: number = Date.now() / 1000,
): KeepAliveRow {
  const OFF_LABEL = 'Keep me signed in'
  const ON_LABEL = 'Stop keeping signed in'

  if (!tab || !canKeepSignedIn(tab.url)) {
    // An ENABLED tab that has drifted to a non-http page must stay SWITCHABLE.
    // Greying it here stranded the setting: the row still held one of the four
    // slots and the sweep still stamped it, with no way for the owner to reach
    // the toggle short of navigating back to the site first.
    if (tab?.keepalive_enabled) {
      return { label: ON_LABEL, detail: 'Not a web page — nothing to check here.' }
    }
    return {
      label: OFF_LABEL,
      disabled: true,
      hint: 'Only web pages can be kept signed in',
    }
  }
  if (!tab.keepalive_enabled) {
    const host = tabHost(tab.url)
    const named = `Refresh ${host} so bots stay signed in.`
    return {
      label: OFF_LABEL,
      // A host long enough to overflow loses its NAME rather than the sentence:
      // a truncated line is worse than an unnamed one.
      detail: named.length <= DETAIL_MAX ? named : 'Refresh this site so bots stay signed in.',
    }
  }
  // Enabled from here down.
  //
  // `needs_login` FIRST — before "Starting". Turning the toggle off and on again
  // nulls `last_keepalive_at` (that is how the first tick is scheduled) without
  // touching `login_state`, so a "Starting" line ordered above this one hid a
  // LIVE enforcement gate — every bot on the tab 409ing — behind an optimistic
  // sentence, until the next tick happened to correct it.
  if (tab.login_state === 'needs_login') {
    return {
      label: ON_LABEL,
      detail: 'Signed out — take the wheel and sign in again.',
      attention: true,
    }
  }
  if (tab.last_keepalive_at === null) {
    // NOT "within a minute": the sweep skips a tab whose wheel a human is
    // holding (2 minutes), and the natural gesture is exactly that — take the
    // wheel, sign in, ⋯, Keep me signed in — so the honest promise is vaguer.
    return { label: ON_LABEL, detail: 'Starting — the first check is due shortly.' }
  }
  // Watch mode BEFORE any age line: it deliberately pings nothing, so
  // `last_probe_at` stands still by design and an age would read as neglect.
  if (isWatching(tab)) {
    return {
      label: ON_LABEL,
      // The full reason ("refreshing would fight a deliberate security control")
      // does not fit two clamped lines and lives in the sheet, which has room.
      detail: 'Watching only — this site signs out in minutes.',
    }
  }
  // `last_probe_at`, NOT `last_keepalive_at` — see honesty rule 1. A tab whose
  // every ping fails (a 404/5xx root, a cross-origin SSO bounce the fetch
  // rejects, a wake that keeps failing) is still stamped every tick, so an age
  // taken from the stamp can never go stale and the row lies indefinitely.
  const { since, stale } = checkGap(tab, now)
  if (tab.last_probe_at === null) {
    return { label: ON_LABEL, detail: "Hasn't been able to check yet.", attention: stale }
  }
  if (stale) {
    return {
      label: ON_LABEL,
      detail: `Hasn't been able to check for ${span(since)}.`,
      attention: true,
    }
  }
  // The owner asked to SEE the schedule, not infer it: name the next check.
  // `last_keepalive_at` is the scheduler's own cursor (every tick stamps it),
  // so cursor + interval IS the next due time; "~" because the sweep runs on a
  // minute tick with jitter, and a human holding the wheel defers it.
  const nextIn = Math.max(0, tab.last_keepalive_at + tab.keepalive_every * 60 - now)
  return {
    label: ON_LABEL,
    detail: `Checked ${ago(since)} · next in ~${everyLabel(Math.max(1, Math.round(nextIn / 60)))}.`,
  }
}

/** The sheet's row — state-first, because there is room here for the COST.
 *
 *  The cost is real and is stated rather than hidden: an enabled tab is held
 *  live, and a live tab keeps the browser up. That is why there is a cap. */
export interface KeepAliveSheetRow {
  title: string
  detail: string
  on: boolean
  /** Same meaning as on the ⋯ row: the state needs the owner, so the icon must
   *  not be a check mark. */
  attention?: boolean
}

export function keepAliveSheetRow(
  tab: BrowserTab,
  now: number = Date.now() / 1000,
): KeepAliveSheetRow {
  if (tab.keepalive_enabled && !canKeepSignedIn(tab.url)) {
    // Still ON, and still switchable off from here — but claiming it is being
    // kept signed in would be a lie: there is no origin to ping.
    return {
      on: true,
      title: 'Paused on this page',
      detail:
        'This tab is not on a web page, so there is nothing to check. Go back to the site, or turn this off.',
    }
  }
  if (!tab.keepalive_enabled) {
    return {
      on: false,
      title: 'Not kept signed in',
      detail: 'Bots lose access when the site signs this tab out.',
    }
  }
  if (isWatching(tab)) {
    return {
      on: true,
      title: 'Watching this tab',
      detail:
        "This site expires sessions in minutes. supermux won't hammer it; it will tell you when you're signed out.",
    }
  }
  // A streak of failed checks says so HERE too — this is the surface the
  // "Can't check …" notification lands on, and a check mark over "Keeping you
  // signed in" would be the false green light the module header opens with.
  const { since, stale } = checkGap(tab, now)
  if (stale && tab.last_keepalive_at !== null) {
    return {
      on: true,
      attention: true,
      title: "Can't check this tab",
      detail: `Nothing has answered here for ${span(since)}. The sign-in may already be gone — take the wheel and look.`,
    }
  }
  return {
    on: true,
    title: 'Keeping you signed in',
    detail:
      'Refreshes this tab quietly so bots stay signed in. Holds the page open in the browser — up to 4 tabs.',
  }
}
