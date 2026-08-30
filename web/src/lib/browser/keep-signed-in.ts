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
//     line clamps at two lines, which is 88 characters. The test asserts it.
//
// HONESTY RULES, in the same order the branches are written:
//   1. Never say "you are signed in". Say when it last CHECKED, or say why it
//      cannot.
//   2. `needs_login` outranks everything except "not started yet": a signed-out
//      tab 409s every bot on it, and that is the fact the owner has to act on.
//   3. A tab that has fallen behind says so with the age, rather than showing a
//      cadence it is not keeping.
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
  if (tab.last_keepalive_at === null) {
    return { label: ON_LABEL, detail: 'Starting — first check within a minute.' }
  }
  if (tab.login_state === 'needs_login') {
    return { label: ON_LABEL, detail: 'Signed out — take the wheel and sign in again.' }
  }
  const age = Math.max(0, now - tab.last_keepalive_at)
  if (age > STALE_INTERVALS * Math.max(1, tab.keepalive_every) * 60) {
    return { label: ON_LABEL, detail: `Hasn't been able to check since ${ago(age)}.` }
  }
  if (isWatching(tab)) {
    return {
      label: ON_LABEL,
      // The full reason ("refreshing would fight a deliberate security control")
      // does not fit two clamped lines and lives in the sheet, which has room.
      detail: 'Watching only — this site signs out in minutes.',
    }
  }
  return {
    label: ON_LABEL,
    detail: `Every ${everyLabel(tab.keepalive_every)} · checked ${ago(age)}.`,
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
}

export function keepAliveSheetRow(tab: BrowserTab): KeepAliveSheetRow {
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
  return {
    on: true,
    title: 'Keeping you signed in',
    detail:
      'Refreshes this tab quietly so bots stay signed in. Holds the page open in the browser — up to 4 tabs.',
  }
}
