// Bot Mode intro gate — show the "Run a company of bots" onboarding ONCE to a
// user who has not turned Bot Mode on, on their first run OR the first load after
// this feature shipped (whichever comes first). It is a sibling of
// `lib/onboarding.ts` (the v2-migration first-launch gate) and shares its shape:
// every access is try/catch-wrapped so a private-mode storage throw degrades to
// "don't show" rather than crashing the shell.
//
// Why a single "seen" key and not a per-version re-show: the intro is a
// recommendation, not a changelog. Once a user has answered it (enabled Bot Mode
// or said "not now"), we never nag again — a bundle that first carries this code
// finds the key absent and shows exactly once, which is precisely "first run OR
// first update that brought Bot Mode." A user already in Bot Mode never sees it.

const SEEN_KEY = 'supermux-botmode-intro-seen'

/** Should the Bot Mode intro run? Only when Bot Mode is OFF and the user has not
 *  yet answered the intro. `botModeOn` is passed in (the caller reads the store)
 *  so this stays a pure predicate over storage. */
export function shouldShowBotModeIntro(botModeOn: boolean): boolean {
  if (botModeOn) return false
  try {
    return localStorage.getItem(SEEN_KEY) === null
  } catch {
    return false
  }
}

/** Mark the intro answered (enabled or dismissed) — it never shows again. Stamps
 *  the build sha it was answered at, purely for debuggability. */
export function completeBotModeIntro(): void {
  try {
    localStorage.setItem(SEEN_KEY, (typeof __APP_BUILD_SHA__ === 'string' && __APP_BUILD_SHA__) || '1')
  } catch {
    // Private mode: nothing to persist. The intro simply may show again next
    // load — acceptable, and better than throwing in the shell.
  }
}

/** Re-arm the intro (the Settings "replay" control). */
export function resetBotModeIntro(): void {
  try {
    localStorage.removeItem(SEEN_KEY)
  } catch {
    // ignore
  }
}
