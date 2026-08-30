// useDelaySend — the composer's SEND-LATER handle (queue, cancel, countdown).
//
// Thin on purpose. Everything that can be decided without React — the wire body,
// the store, the countdown copy, the retire rule — is `delay-send.ts`; this owns
// the three things that cannot be: the subscription, the ticker, and the
// composer's own text (clear it on queue, give it back on cancel).
//
// THE DRAFT IS MOVED, NOT COPIED. `onSchedule`'s sheet copies the draft (the
// composer keeps every character, because the sheet may be abandoned); a delay
// pick is a SEND — the message leaves the box the way it does on Enter, and the
// chip is the receipt that says where it went. Cancel puts it back.
//
// ONE FLIGHT AT A TIME. `busy` is a ref as well as state, for the same reason
// `use-composer.ts::submit` keeps one: a second tap arriving before React has
// re-rendered must still be refused, and state alone would let it through.

import * as React from 'react'

import { getDraft, setDraft } from './composer-draft'
import {
  cancelDelayedSend,
  delayErrorText,
  DELAY_OPTIONS,
  hydrateQueue,
  pruneQueued,
  queueDelayedSend,
  queuedFor,
  workflowsPort,
  subscribeQueued,
  tickMs,
  type DelayOption,
  type DelaySendPort,
  type QueuedSend,
} from './delay-send'

export interface DelaySend {
  /** The delays this composer offers, in the order they are drawn. */
  options: readonly DelayOption[]
  /** This session's queued sends, soonest first. */
  queued: readonly QueuedSend[]
  /** The clock the chips count against — advanced by the ticker below. */
  nowMs: number
  /** A create or a delete is in flight: the chooser's rows go inert. */
  busy: boolean
  /** The last failure, in the server's own words. */
  error: string | null
  dismissError: () => void
  /** Queue the composer's text. No-op on blank text or while busy. */
  queue: (text: string, option: DelayOption) => void
  /** Delete the workflow and put the words back in the composer. */
  cancel: (id: string) => void
}

export interface UseDelaySendOptions {
  /** The session slug — the workflow's target AND the queue's key. */
  name: string
  /** The workflows API, injectable so a test can assert the POST body. */
  port?: DelaySendPort
}

export function useDelaySend({ name, port = workflowsPort }: UseDelaySendOptions): DelaySend {
  const queued = React.useSyncExternalStore(
    React.useCallback((fn) => subscribeQueued(name, fn), [name]),
    React.useCallback(() => queuedFor(name), [name]),
    React.useCallback(() => queuedFor(name), [name]),
  )
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const aliveRef = React.useRef(true)
  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // THE COLD MOUNT. The store and its `sessionStorage` twin survive a remount
  // and a reload, but not the tab closing — and the WORKFLOW survives all three.
  // So on mount the chips are rebuilt from `GET /api/workflows` (shared across
  // panes for 15s, `delay-send.ts::hydrateQueue`), which is also what makes Undo
  // able to hand back the real words after the tab that typed them is gone: the
  // message is the row's own `prompt`. A failed listing is silent — the local
  // view stands and the next mount asks again.
  React.useEffect(() => {
    void hydrateQueue(port, name, Date.now()).catch(() => undefined)
  }, [name, port])

  // THE COUNTDOWN, as one self-rescheduling timeout rather than an interval:
  // the cadence is the countdown's own (`tickMs` — a second while seconds show,
  // fifteen while minutes do), and there is NO timer at all while the queue is
  // empty, which is nearly always. The same tick retires a fired chip, so the
  // settle window costs no second timer either.
  React.useEffect(() => {
    if (!queued.length) return
    const soonest = queued[0]!.dueMs
    const id = window.setTimeout(() => {
      const now = Date.now()
      pruneQueued(name, now)
      setNowMs(now)
    }, tickMs(soonest - nowMs))
    return () => window.clearTimeout(id)
  }, [queued, name, nowMs])

  const dismissError = React.useCallback(() => setError(null), [])

  const queue = React.useCallback(
    (text: string, option: DelayOption) => {
      const body = text.trim()
      if (!body || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setError(null)
      // The box clears NOW: the tap has to feel like a send, and the receipt
      // that follows is what says it is not gone. If the write fails the words
      // come straight back (below) — the one state this must never leave the
      // user in is "my message is nowhere".
      setDraft(name, '')
      void (async () => {
        try {
          await queueDelayedSend(port, { session: name, text: body, option, nowMs: Date.now() })
          // Re-read the clock the countdown is measured against. It is only
          // advanced by the ticker, so a chip filed against a `nowMs` taken at
          // mount would open at "sends in 1h 1m" and correct itself a tick
          // later — the one moment this feature has to look exact.
          if (aliveRef.current) setNowMs(Date.now())
        } catch (err) {
          setDraft(name, body)
          if (aliveRef.current) setError(delayErrorText(err))
        } finally {
          busyRef.current = false
          if (aliveRef.current) setBusy(false)
        }
      })()
    },
    [name, port],
  )

  const cancel = React.useCallback(
    (id: string) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setError(null)
      void (async () => {
        try {
          // `nowMs: Date.now()`, not the ticker's clock: the guard that refuses
          // a DUE item has to read the real time, or a stale tick could let a
          // cancel through a second after the engine took the message.
          const item = await cancelDelayedSend(port, { session: name, id, nowMs: Date.now() })
          // The words go back where they came from. A draft typed in the
          // meantime is not thrown away for it — the restored message joins it
          // below, so nothing anybody typed is ever lost to an Undo.
          if (item) {
            const current = getDraft(name)
            setDraft(name, current.trim() ? `${current}\n\n${item.text}` : item.text)
          }
        } catch (err) {
          if (aliveRef.current) setError(delayErrorText(err))
        } finally {
          busyRef.current = false
          if (aliveRef.current) setBusy(false)
        }
      })()
    },
    [name, port],
  )

  return { options: DELAY_OPTIONS, queued, nowMs, busy, error, dismissError, queue, cancel }
}

export default useDelaySend
