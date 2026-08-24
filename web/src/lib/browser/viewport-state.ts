/**
 * What the viewport is doing right now — the whole matrix, as one pure
 * function.
 * ─────────────────────────────────────────────────────────────────────────────
 * The audit's §5.7 verdict in one line: **every state is a state screen with an
 * action, never a pill.** "Connecting…" floating over a black rectangle tells a
 * human nothing they can act on; "This tab is asleep — Wake it" does.
 *
 * It is a pure function because the precedence is the part that goes wrong. A
 * tab can be asleep AND reconnecting AND signed out at the same time, and the
 * order those are resolved in is the difference between "Wake this tab" and a
 * spinner that never ends. Pinning it here means the order is a test, not a
 * chain of ternaries inside a render.
 *
 * TWO KINDS OF COVER, and the difference matters:
 *   · `screen` — there is nothing truthful to show, so the state owns the box.
 *   · `banner` — the page IS live and worth looking at; the state sits over it.
 *     Signed-out is the case that must never blank the page: the sign-in form
 *     the human needs is ON that page.
 */

import type { DriveMode, TakeoverState } from './takeover-socket'

export type ViewportPhase =
  /** No tab at all — the host draws its new-tab page. */
  | 'empty'
  /** The row exists, the page does not. */
  | 'asleep'
  /** A wake is in flight (ours, or the socket's rehydrate-on-attach). */
  | 'waking'
  /** Dialling a tab that IS open. */
  | 'connecting'
  /** Frames are flowing. */
  | 'live'
  /** Live, but the page says signed out. */
  | 'needs-login'
  /** Another viewer holds this page's socket. */
  | 'busy'
  /** The socket dropped and is backing off — the last frame is still true of a
   *  moment ago, so it stays, dimmed. */
  | 'reconnecting'
  /** Refused, or retries exhausted. */
  | 'offline'
  /** The page's renderer died. */
  | 'crashed'

/** The one thing the human can do about it. */
export type ViewportVerb = 'wake' | 'drive' | 'reload' | 'retry'

export interface ViewportView {
  phase: ViewportPhase
  title: string
  detail: string
  /** `null` = nothing to offer (live, or the host passed no handler). */
  action: { verb: ViewportVerb; label: string } | null
  cover: 'screen' | 'banner' | 'none'
  /** Keep painting the frame we already hold underneath. */
  keepFrame: boolean
  /** …but dim it: it is a picture of a moment ago, not a claim about now. */
  dim: boolean
  spinner: boolean
}

export interface ViewportInputs {
  /** A tab is selected. */
  hasTab: boolean
  /** The tab row says a live CDP target exists. */
  tabLive: boolean
  /** A wake / navigate / create mutation is in flight. */
  waking: boolean
  /** The takeover socket's state, or `null` when no socket is mounted. */
  socket: TakeoverState | null
  /** Who holds the wheel, per the socket. */
  mode: DriveMode | null
  /** The tab's last login probe said the page is signed out. */
  needsLogin: boolean
  /** The renderer crashed. Nothing sets this in production yet — the
   *  `Inspector.targetCrashed` relay is phase 3 — so today only the bench does,
   *  and it is wired here rather than invented later. */
  crashed: boolean
  /** WHAT is attached. A tab's "no context" and a session's are different
   *  facts: a workspace TAB has a row and a profile on disk and is simply not
   *  open (so waking it is a real verb the human owns), while a SCRATCH session
   *  has no page because the AGENT has not opened one — and no button on this
   *  surface can change that. Saying "wake this tab" there would be a lie with
   *  a button attached. Defaults to the tab reading. */
  subject?: 'tab' | 'session'
}

const LIVE: ViewportView = {
  phase: 'live',
  title: '',
  detail: '',
  action: null,
  cover: 'none',
  keepFrame: true,
  dim: false,
  spinner: false,
}

export function viewportState(input: ViewportInputs): ViewportView {
  const driving = input.mode === 'human_driving'

  if (!input.hasTab) {
    return {
      phase: 'empty',
      title: 'No tab open',
      detail: 'Type an address above to open one.',
      action: null,
      cover: 'screen',
      keepFrame: false,
      dim: false,
      spinner: false,
    }
  }

  // A dead renderer outranks everything: whatever else is true, the pixels are
  // a corpse and the only verb that helps is Reload.
  if (input.crashed) {
    return {
      phase: 'crashed',
      title: 'This page crashed',
      detail: 'The page’s renderer died. Reloading opens it again at the same address.',
      action: { verb: 'reload', label: 'Reload' },
      cover: 'screen',
      keepFrame: false,
      dim: false,
      spinner: false,
    }
  }

  // Terminal socket states, in the order they matter. `no-context` is NOT a
  // dead end any more — it means asleep, and asleep has a button.
  if (input.socket === 'no-context') {
    return asleep(input.waking, input.subject === 'session')
  }
  if (input.socket === 'busy') {
    return {
      phase: 'busy',
      title: 'Someone else is driving this page',
      detail:
        'One viewer at a time, so two people cannot fight over the same cursor. Retry once they are done.',
      action: { verb: 'retry', label: 'Retry' },
      cover: 'screen',
      keepFrame: false,
      dim: false,
      spinner: false,
    }
  }
  if (input.socket === 'offline') {
    return {
      phase: 'offline',
      title: 'Not connected',
      detail: 'The live connection was refused or gave up. Nothing on screen is current.',
      action: { verb: 'retry', label: 'Retry now' },
      cover: 'screen',
      keepFrame: true,
      dim: true,
      spinner: false,
    }
  }
  if (input.socket === 'reconnecting') {
    return {
      phase: 'reconnecting',
      title: 'Not live · reconnecting',
      detail: 'The last frame is still on screen. It is a picture of a moment ago, not of now.',
      action: { verb: 'retry', label: 'Retry now' },
      cover: 'banner',
      keepFrame: true,
      dim: true,
      spinner: true,
    }
  }

  // Not dialled yet. An asleep row with a mutation in flight is WAKING; an
  // asleep row with no socket at all is asleep; anything else is connecting.
  if (input.socket === null) {
    if (input.waking) return waking()
    return input.tabLive ? connecting() : asleep(false, input.subject === 'session')
  }
  if (input.socket === 'connecting') {
    // The tab route rehydrates on attach, so dialling an asleep tab really IS
    // waking it — saying "connecting" there would undersell a five-second wait.
    return input.tabLive && !input.waking ? connecting() : waking()
  }

  // Live.
  if (input.needsLogin) {
    return {
      phase: 'needs-login',
      title: 'Signed out',
      detail: driving
        ? 'Sign in on the page — you have the wheel.'
        : 'Take the wheel and sign in; the session is saved to this tab’s profile.',
      action: driving ? null : { verb: 'drive', label: 'Drive' },
      // Over the page, NEVER instead of it: the sign-in form the human needs is
      // on the page this would otherwise cover.
      cover: 'banner',
      keepFrame: true,
      dim: false,
      spinner: false,
    }
  }
  return LIVE
}

function asleep(pending: boolean, session = false): ViewportView {
  if (pending) return waking()
  if (session) {
    // Nothing here is the human's to fix, so nothing here is offered as if it
    // were. The old veil said exactly this; it just said it in a pill.
    return {
      phase: 'asleep',
      title: 'No page open yet',
      detail:
        'This session has no open page — the agent has to open one before you can take over.',
      action: null,
      cover: 'screen',
      keepFrame: false,
      dim: false,
      spinner: false,
    }
  }
  return {
    phase: 'asleep',
    title: 'This tab is asleep',
    detail:
      'The page is not open right now — its sign-in is kept on disk, so waking it comes back to the same session.',
    action: { verb: 'wake', label: 'Wake this tab' },
    cover: 'screen',
    keepFrame: false,
    dim: false,
    spinner: false,
  }
}

function waking(): ViewportView {
  return {
    phase: 'waking',
    title: 'Waking the browser…',
    detail: 'This can take a few seconds — a real browser is starting behind it.',
    action: null,
    cover: 'screen',
    keepFrame: false,
    dim: false,
    spinner: true,
  }
}

function connecting(): ViewportView {
  return {
    phase: 'connecting',
    title: 'Connecting…',
    detail: 'Attaching to the page. The first frame arrives as soon as it does.',
    action: null,
    cover: 'screen',
    keepFrame: true,
    dim: true,
    spinner: true,
  }
}
