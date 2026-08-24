// /dev/composer-attach — the wired-composer bench for the attachment upgrade.
//
// DEV-only + lazy (tree-shaken from prod — verified absent from dist, like the
// other /dev/* benches). Unlike /dev/chat-live's frozen `BenchComposer` (a
// static handle), this mounts the REAL data plane: `useComposer` + the REST
// input + `useStagedAttachments`, wired exactly as `chat-panel.tsx` wires them.
// So an offline Playwright rig can drive the whole flow — pick a file (upload
// intercepted), watch the chip go ready, hit Send — and assert the POST body of
// `/api/sessions/{name}/send` carries the quoted upload path. The rig owns the
// network: it fulfils `/api/upload` with a fake absolute path and captures the
// `/send` body; no server is involved.
//
// `?surface=phone` renders the phone bar with the `+` add-menu (its Attach group
// is what the mobile screenshot captures); default is the desktop pair with the
// direct attach disc. `?delay=1` wires SEND LATER against an in-browser stub
// scheduler, so the chooser (sheet on coarse, popover on fine), the queued chip's
// countdown and its Cancel are all drivable with no server at all.
import * as React from 'react'

import { ChatComposer } from '@/components/chat/composer'
import { DELAY_OPTIONS, type DelaySendPort } from '@/components/chat/delay-send'
import type { ScheduleRow } from '@/lib/api/scheduler'
import { useDelaySend } from '@/components/chat/use-delay-send'
import { useComposer } from '@/components/chat/use-composer'
import { attachmentSentence } from '@/components/chat/composer-insert'
import { useStagedAttachments } from '@/components/focus-mode/use-staged-attachments'
import { restSessionInput } from '@/lib/session-input'

const NAME = 'release-train'
const noop = () => undefined

/**
 * The SEND-LATER port, faked in the browser (`?delay=1`). It answers a create
 * the way `/api/schedules` does — an id and a `next_run` — so the rig can drive
 * the whole flow offline: pick a delay, watch the composer clear, read the chip's
 * countdown, cancel it and get the words back. Only `id` and `next_run` are read
 * (`delay-send.ts::queueDelayedSend`), hence the cast: a bench does not need to
 * invent the other twenty columns of a schedules row.
 */
const BENCH_ROWS = 'supermux-bench-schedules'

/** The bench's "schedules table", in `localStorage` so it OUTLIVES the tab —
 *  which is the whole point of the cold-mount hydration this bench exercises. */
function benchRows(): ScheduleRow[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BENCH_ROWS) ?? '[]')
    return Array.isArray(raw) ? (raw as ScheduleRow[]) : []
  } catch {
    return []
  }
}
function writeBenchRows(rows: ScheduleRow[]): void {
  try {
    localStorage.setItem(BENCH_ROWS, JSON.stringify(rows))
  } catch {
    /* a bench is a nicety */
  }
}

let benchSchedules = 0
const BENCH_PORT: DelaySendPort = {
  create: async (input) => {
    const option = DELAY_OPTIONS.find((o) => o.expr === input.schedule_expr)
    const row = {
      id: `SCHED-bench${Date.now().toString(36)}${++benchSchedules}`,
      title: input.title,
      session: input.session ?? NAME,
      prompt: input.prompt ?? '',
      command: '',
      kind: 'tmux',
      sched_type: 'once',
      enabled: 1,
      deleted: null,
      schedule_expr: input.schedule_expr,
      next_run: new Date(Date.now() + (option?.ms ?? 600_000)).toISOString(),
    } as unknown as ScheduleRow
    writeBenchRows([...benchRows(), row])
    return row
  },
  remove: async (id) => {
    writeBenchRows(benchRows().filter((r) => r.id !== id))
    return { deleted: true }
  },
  // The cold-mount hydration asks for the live list — and the bench answers with
  // its own persisted rows, so "queue it, close the tab, come back" is drivable
  // here exactly as it is against a real server.
  list: async () => benchRows(),
}

export default function DevComposerAttach() {
  const input = React.useMemo(() => restSessionInput(NAME), [])
  const staged = useStagedAttachments()
  const handle = useComposer({
    name: NAME,
    input,
    active: false,
    // The exact seam chat-panel uses: fold the quoted paths at submit time,
    // clear the chips on a resolved POST. No `peek` ⇒ the pre-send gate is
    // skipped (the fail-open path), so the bench never needs a peek server.
    getOutgoingPrefix: React.useCallback(
      () => attachmentSentence(staged.readyPaths()),
      [staged],
    ),
    onSent: staged.reset,
  })

  const q =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams()
  const phone = q.get('surface') === 'phone'
  // `?grok=1` stamps `data-grok` so the grok-scoped composer CSS (leading-cluster
  // gap, disc sizing) actually applies — this is how the rig reviews the grok
  // CHAT pane's real full-width 📎·@·🕐 trio at 390px (that pane ships
  // `surface="desktop"` on the phone). `?schedule=1` wires an inert `onSchedule`
  // so the 🕐 (the third leading icon) is drawn. Both DEV-only, prod-inert.
  const grok = q.get('grok') === '1'
  const schedulable = q.get('schedule') === '1'
  // `?delay=1` wires the send-later plane against the local stub above — no
  // server, real hook, real store — so the chooser, the chip and the undo are
  // all screenshot-able offline. The hook is called unconditionally (it is one);
  // the FLAG decides whether the composer is handed it.
  const delayable = q.get('delay') === '1'
  const delay = useDelaySend({ name: NAME, port: BENCH_PORT })

  return (
    <div
      {...(grok ? { 'data-grok': '' } : {})}
      className="flex min-h-dvh items-end justify-center bg-paper p-8 text-ink"
    >
      <div className="w-full max-w-[840px]">
        <ChatComposer
          name={NAME}
          label="Release Train"
          handle={handle}
          surface={phone ? 'phone' : 'desktop'}
          attachments={staged}
          onSchedule={schedulable ? noop : undefined}
          delay={delayable ? delay : undefined}
          // The leading `+` add-menu renders whenever `actions` is present — now
          // on BOTH surfaces (the shipped wiring: mobile.tsx + desktop-split.tsx).
          // Faithful to production: the phone sheet carries Switch-session, the
          // desktop popover omits it (its persistent session list makes it
          // redundant). Inert callbacks — this is a screenshot bench.
          actions={
            phone
              ? { onSwitchSession: noop, onCommandPalette: noop, onSnippets: noop }
              : { onCommandPalette: noop, onSnippets: noop }
          }
        />
      </div>
    </div>
  )
}
