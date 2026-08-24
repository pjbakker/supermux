/**
 * SEND LATER — the composer's delay plane (delay-send).
 * ─────────────────────────────────────────────────────────────────────────────
 * Three things are worth pinning here, and they are the three a screenshot
 * cannot see:
 *
 *   1. THE WIRE BODY. A delayed send is a ONE-SHOT SCHEDULE and nothing else:
 *      `kind: 'tmux'`, the typed text as `prompt`, no command, and a relative
 *      expression the server's own parser reads as `sched_type "once"`
 *      (`server/src/scheduler/parser.rs`, `RE_IN` + its unit table — both
 *      restated here, so a rename on either side fails a test instead of
 *      shipping a schedule that never fires). No server change was needed for
 *      this feature, and this test is what says so out loud.
 *
 *   2. THE UNDO PATH. Cancel deletes the schedule by id and hands the MESSAGE
 *      back — verbatim, so the composer can restore it — and a DELETE that fails
 *      puts the receipt back, because a chip that vanished over a schedule the
 *      server is still holding would be the one lie this feature must not tell.
 *
 *   3. THE COMPOSER'S OWN GATES. The clock is drawn beside Send, disabled with
 *      an empty box and disabled (with the reason) while attachments are staged,
 *      and it REPLACES the leading schedule clock rather than adding a second
 *      one. A pick / a tap / the sheet's motion are Playwright's job.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, test, beforeEach } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatComposer } from '../../src/components/chat/composer'
import {
  cancelDelayedSend,
  countdownLabel,
  delayGateReason,
  delayScheduleInput,
  delayTitle,
  DELAY_OPTIONS,
  hydrateQueue,
  isCancellable,
  isDelayRow,
  isRetired,
  queueDelayedSend,
  queuedFor,
  resetQueues,
  SETTLE_MS,
  type DelaySendPort,
  type QueuedSend,
} from '../../src/components/chat/delay-send'
import type { DelaySend } from '../../src/components/chat/use-delay-send'
import type { ScheduleCreateInput, ScheduleRow } from '../../src/lib/api/scheduler'
import type { ComposerField, ComposerHandle } from '../../src/components/chat/use-composer'
import type {
  StagedAttachment,
  UseStagedAttachmentsResult,
} from '../../src/components/focus-mode/use-staged-attachments'

// ── the fake scheduler ───────────────────────────────────────────────────────

function row(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'SCHED-abc12345',
    title: 'Send later · hi',
    session: 'release-train',
    command: '',
    prompt: 'hi',
    kind: 'tmux',
    boot_dir: '',
    boot_provider: 'claude',
    boot_worktree: 0,
    bypass_permissions: 0,
    sched_type: 'once',
    recurrence: null,
    run_at: null,
    next_run: '2026-08-24T10:10:00+00:00',
    last_run: null,
    enabled: 1,
    run_count: 0,
    schedule_expr: 'in 10 minutes',
    watch: 0,
    watch_timeout: 900,
    done_pattern: null,
    done_action: 'disable',
    confirm_finish: 0,
    created: 0,
    updated: 0,
    deleted: null,
    ...over,
  }
}

interface Spy extends DelaySendPort {
  created: ScheduleCreateInput[]
  removed: string[]
  listed: number
}

function port(over: Partial<DelaySendPort> = {}): Spy {
  const spy: Spy = {
    created: [],
    removed: [],
    listed: 0,
    list: async () => {
      spy.listed += 1
      return []
    },
    create: async (input) => {
      spy.created.push(input)
      return row({ prompt: input.prompt ?? '', schedule_expr: input.schedule_expr })
    },
    remove: async (id) => {
      spy.removed.push(id)
      return { deleted: true }
    },
    ...over,
  }
  return spy
}

beforeEach(() => resetQueues())

// ═══ 1 — the wire body ══════════════════════════════════════════════════════

describe('the one-shot schedule a delay writes', () => {
  test('every offered delay is an expression the server parses as ONE-SHOT', () => {
    // `server/src/scheduler/parser.rs`: `^in\s+(\d+)\s*([a-z]+)$` is the only
    // branch that returns `sched_type: "once"`, and these are its units.
    const RE_IN = /^in\s+(\d+)\s*([a-z]+)$/
    const UNITS = new Set([
      's', 'sec', 'secs', 'second', 'seconds',
      'm', 'min', 'mins', 'minute', 'minutes',
      'h', 'hr', 'hrs', 'hour', 'hours',
      'd', 'day', 'days',
    ])
    const SECS: Record<string, number> = { minutes: 60, hours: 3600 }
    expect(DELAY_OPTIONS.map((o) => o.expr)).toEqual([
      'in 10 minutes',
      'in 1 hour',
      'in 3 hours',
    ])
    for (const option of DELAY_OPTIONS) {
      const m = RE_IN.exec(option.expr)
      expect(m).not.toBeNull()
      const [, n, unit] = m!
      expect(UNITS.has(unit!)).toBe(true)
      // The expression and the local countdown must mean the SAME delay, or the
      // chip would count down to a moment the server does not fire at.
      const secs = SECS[unit!.replace(/s$/, '') + 's'] ?? SECS[unit!]
      expect(Number(n) * (secs ?? 0) * 1000).toBe(option.ms)
    }
  })

  test('the create body is a prompt-only tmux job aimed at THIS session', () => {
    const input = delayScheduleInput('release-train', 'ship the release notes', DELAY_OPTIONS[1]!)
    expect(input).toEqual({
      title: 'Send later · ship the release notes',
      command: '',
      prompt: 'ship the release notes',
      kind: 'tmux',
      session: 'release-train',
      schedule_expr: 'in 1 hour',
    })
    // Nothing else is offered — no shell, no boot, no watch, no done-action.
    expect(Object.keys(input).sort()).toEqual([
      'command',
      'kind',
      'prompt',
      'schedule_expr',
      'session',
      'title',
    ])
  })

  test('the title quotes the message on one line, and never runs away', () => {
    expect(delayTitle('  two\nlines  ')).toBe('Send later · two lines')
    const long = delayTitle('x'.repeat(200))
    expect(long.length).toBeLessThan(70)
    expect(long.endsWith('…')).toBe(true)
    // An empty draft never reaches this, but the stem must still be a title.
    expect(delayTitle('   ')).toBe('Send later')
  })

  test('queueing creates exactly one schedule and files the receipt', async () => {
    const api = port()
    const item = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'hi',
      option: DELAY_OPTIONS[0]!,
      nowMs: 1_000,
    })
    expect(api.created).toHaveLength(1)
    expect(api.created[0]!.schedule_expr).toBe('in 10 minutes')
    expect(api.created[0]!.session).toBe('release-train')
    expect(api.created[0]!.prompt).toBe('hi')
    // The countdown is read off the SERVER's next_run, not off `now + delay`.
    expect(item.dueMs).toBe(Date.parse('2026-08-24T10:10:00+00:00'))
    expect(item.text).toBe('hi')
    expect(queuedFor('release-train')).toEqual([item])
    // …and only in that session's queue.
    expect(queuedFor('other')).toEqual([])
  })

  test('a create that fails files NO receipt (the chip cannot promise first)', async () => {
    const api = port({
      create: async () => {
        throw new Error('invalid time expression')
      },
    })
    await expect(
      queueDelayedSend(api, {
        session: 'release-train',
        text: 'hi',
        option: DELAY_OPTIONS[0]!,
        nowMs: 1_000,
      }),
    ).rejects.toThrow('invalid time expression')
    expect(queuedFor('release-train')).toEqual([])
  })

  test('a row with no next_run falls back to the local clock, never to NaN', async () => {
    const api = port({ create: async () => row({ next_run: null }) })
    const item = await queueDelayedSend(api, {
      session: 's',
      text: 'hi',
      option: DELAY_OPTIONS[2]!,
      nowMs: 5_000,
    })
    expect(item.dueMs).toBe(5_000 + DELAY_OPTIONS[2]!.ms)
  })
})

// ═══ 2 — cancel / undo ══════════════════════════════════════════════════════

describe('cancel puts the schedule AND the words back', () => {
  test('it deletes by id and hands the message back verbatim', async () => {
    const api = port()
    const queued = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'the exact words  typed',
      option: DELAY_OPTIONS[0]!,
      nowMs: 1_000,
    })
    const undone = await cancelDelayedSend(api, {
      session: 'release-train',
      id: queued.id,
      nowMs: 2_000,
    })
    expect(api.removed).toEqual([queued.id])
    expect(undone?.text).toBe('the exact words  typed')
    expect(queuedFor('release-train')).toEqual([])
  })

  test('a DELETE that fails RESTORES the receipt — the schedule is still live', async () => {
    const api = port({
      remove: async () => {
        throw new Error('Can’t reach supermux-server.')
      },
    })
    const queued = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'hi',
      option: DELAY_OPTIONS[0]!,
      nowMs: 1_000,
    })
    await expect(
      cancelDelayedSend(api, { session: 'release-train', id: queued.id, nowMs: 2_000 }),
    ).rejects.toThrow('supermux-server')
    expect(queuedFor('release-train')).toEqual([queued])
  })

  test('cancelling an id that is not queued is a no-op, not a stray DELETE', async () => {
    const api = port()
    expect(
      await cancelDelayedSend(api, { session: 'release-train', id: 'SCHED-ghost', nowMs: 1 }),
    ).toBeNull()
    expect(api.removed).toEqual([])
  })
})

// ═══ 2b — the cancel WINDOW (the fired-schedule race) ═══════════════════════

describe('the cancel window closes at dueMs, not at the end of the chip', () => {
  /**
   * The race this guards: the runner delivers a due one-shot on its next tick
   * (≤10s), and `DELETE /api/schedules/{id}` soft-deletes by id ALONE — it does
   * not check `enabled` or `run_count`, and it must not (the Schedules admin
   * legitimately deletes finished jobs). So a Cancel offered after `dueMs` can
   * come back 200 on a message that is already IN the session, and the composer
   * would hand the words back as though nothing had been sent — inviting a
   * duplicate. The guard is here, on the client, and it is time-based.
   */
  test('isCancellable is true only strictly BEFORE the fire time', () => {
    const item = { dueMs: 10_000 }
    expect(isCancellable(item, 9_999)).toBe(true)
    expect(isCancellable(item, 10_000)).toBe(false)
    // …including everywhere inside the settle window the chip is still shown.
    expect(isCancellable(item, 10_000 + SETTLE_MS - 1)).toBe(false)
  })

  test('a due item is REFUSED — no DELETE, no restore, receipt untouched', async () => {
    const api = port()
    const queued = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'hi',
      option: DELAY_OPTIONS[0]!,
      nowMs: 1_000,
    })
    // One millisecond past the server's own next_run.
    const undone = await cancelDelayedSend(api, {
      session: 'release-train',
      id: queued.id,
      nowMs: queued.dueMs + 1,
    })
    expect(undone).toBeNull()
    // The words are NOT handed back (the caller restores only what it is given)…
    expect(api.removed).toEqual([])
    // …and the chip stays, because the schedule is not deleted either.
    expect(queuedFor('release-train')).toEqual([queued])
  })

  test('the same item one millisecond earlier still cancels', async () => {
    const api = port()
    const queued = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'hi',
      option: DELAY_OPTIONS[0]!,
      nowMs: 1_000,
    })
    const undone = await cancelDelayedSend(api, {
      session: 'release-train',
      id: queued.id,
      nowMs: queued.dueMs - 1,
    })
    expect(undone?.text).toBe('hi')
    expect(api.removed).toEqual([queued.id])
  })
})

// ═══ 2c — the cold mount (hydration from the schedules table) ═══════════════

describe('the chips are rebuilt from the server on a cold mount', () => {
  const live = (over: Partial<ScheduleRow> = {}) =>
    row({
      id: 'SCHED-live1',
      title: 'Send later · ship it',
      prompt: 'ship it',
      next_run: new Date(50_000 + 3_600_000).toISOString(),
      ...over,
    })

  test('a live delayed send of THIS session comes back with its words', async () => {
    const api = port({ list: async () => [live()] })
    await hydrateQueue(api, 'release-train', 50_000)
    const queued = queuedFor('release-train')
    expect(queued).toHaveLength(1)
    // The MESSAGE survives a closed tab because it is the row's own prompt —
    // which is what lets Undo still hand back the real words.
    expect(queued[0]!.text).toBe('ship it')
    expect(queued[0]!.id).toBe('SCHED-live1')
    expect(queued[0]!.dueMs).toBe(Date.parse(live().next_run!))
  })

  test('nothing else in the schedules table becomes a chip', () => {
    const now = 50_000
    const ok = live()
    expect(isDelayRow(ok, 'release-train', now)).toBe(true)
    // Another session's job, a recurring one, a boot/shell job, a disabled or
    // deleted row, a job this feature did not write, and one already past.
    expect(isDelayRow(live({ session: 'other' }), 'release-train', now)).toBe(false)
    expect(isDelayRow(live({ sched_type: 'recurring' }), 'release-train', now)).toBe(false)
    expect(isDelayRow(live({ kind: 'shell' }), 'release-train', now)).toBe(false)
    expect(isDelayRow(live({ enabled: 0 }), 'release-train', now)).toBe(false)
    expect(isDelayRow(live({ deleted: 1 }), 'release-train', now)).toBe(false)
    expect(isDelayRow(live({ title: 'Nightly digest' }), 'release-train', now)).toBe(false)
    expect(isDelayRow(live({ next_run: new Date(now - 1).toISOString() }), 'release-train', now)).toBe(false)
  })

  test('a message queued WHILE the listing was in flight is not eaten', async () => {
    let release: (rows: ScheduleRow[]) => void = () => undefined
    const api = port({ list: () => new Promise<ScheduleRow[]>((r) => (release = r)) })
    const hydrating = hydrateQueue(api, 'release-train', 50_000)
    // The user taps a delay before the list comes back.
    const fresh = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'typed during boot',
      option: DELAY_OPTIONS[0]!,
      nowMs: 50_000,
    })
    release([live()])
    await hydrating
    const ids = queuedFor('release-train').map((it) => it.id)
    expect(ids).toContain(fresh.id)
    expect(ids).toContain('SCHED-live1')
  })

  test('a failed listing changes nothing — the local view stands', async () => {
    const api = port({
      list: async () => {
        throw new Error('Can’t reach supermux-server.')
      },
    })
    const queued = await queueDelayedSend(api, {
      session: 'release-train',
      text: 'hi',
      option: DELAY_OPTIONS[0]!,
      nowMs: 1_000,
    })
    await expect(hydrateQueue(api, 'release-train', 1_000)).rejects.toThrow('supermux-server')
    expect(queuedFor('release-train')).toEqual([queued])
  })

  test('four panes opening in a row cost ONE listing', async () => {
    const api = port()
    await Promise.all([
      hydrateQueue(api, 'a', 50_000),
      hydrateQueue(api, 'b', 50_100),
      hydrateQueue(api, 'c', 50_200),
      hydrateQueue(api, 'd', 50_300),
    ])
    expect(api.listed).toBe(1)
  })
})

// ═══ the countdown copy ═════════════════════════════════════════════════════

describe('what the chip says', () => {
  test('the countdown rounds UP, so a fresh 10-minute queue reads 10m', () => {
    expect(countdownLabel(10 * 60_000 - 1)).toBe('sends in 10m')
    expect(countdownLabel(59_000)).toBe('sends in 59s')
    expect(countdownLabel(3 * 3_600_000)).toBe('sends in 3h')
    expect(countdownLabel(3_600_000 + 4 * 60_000)).toBe('sends in 1h 4m')
    expect(countdownLabel(0)).toBe('sending now')
    expect(countdownLabel(-5_000)).toBe('sending now')
  })

  test('a fired chip retires only after the runner has had its tick', () => {
    const item: Pick<QueuedSend, 'dueMs'> = { dueMs: 1_000 }
    expect(isRetired(item, 1_000)).toBe(false)
    expect(isRetired(item, 1_000 + SETTLE_MS)).toBe(false)
    expect(isRetired(item, 1_000 + SETTLE_MS + 1)).toBe(true)
  })
})

// ═══ 3 — the composer's gates ═══════════════════════════════════════════════

function handle(over: Partial<ComposerHandle> = {}): ComposerHandle {
  return {
    draft: '',
    setDraft: () => undefined,
    fieldRef: React.createRef<ComposerField | null>(),
    sending: false,
    notice: null,
    dismissNotice: () => undefined,
    submit: () => undefined,
    stop: () => undefined,
    insert: () => undefined,
    handoff: null,
    handoffPending: null,
    picker: {
      open: false,
      kind: '@',
      query: '',
      pick: () => undefined,
      close: () => undefined,
      bind: () => undefined,
    },
    onChange: () => undefined,
    onKeyDown: () => undefined,
    onSelect: () => undefined,
    ...over,
  }
}

function delaySend(over: Partial<DelaySend> = {}): DelaySend {
  return {
    options: DELAY_OPTIONS,
    queued: [],
    nowMs: 1_700_000_000_000,
    busy: false,
    error: null,
    dismissError: () => undefined,
    queue: () => undefined,
    cancel: () => undefined,
    ...over,
  }
}

function staged(list: StagedAttachment[] = []): UseStagedAttachmentsResult {
  return {
    attachments: list,
    uploading: list.some((a) => a.uploading),
    handleFiles: () => undefined,
    dismiss: () => undefined,
    readyPaths: () =>
      list.filter((a) => !a.uploading && !a.error && a.path).map((a) => a.path as string),
    reset: () => undefined,
  }
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

/** Is the rendered control actually disabled? The ATTRIBUTE, not the class
 *  list — `disabled:opacity-40` is a Tailwind variant and says nothing. */
function isDisabled(tag: string): boolean {
  return / disabled=""/.test(tag)
}

/** The clock disc's `<button>`, as rendered. */
function delayDisc(out: string): string {
  const at = out.indexOf('data-testid="chat-delay-send"')
  if (at < 0) return ''
  const open = out.lastIndexOf('<button', at)
  return out.slice(open, out.indexOf('>', at) + 1)
}

describe('the composer draws the clock beside Send, and says why when it cannot act', () => {
  test('unwired: no clock, no receipts — byte-identical to today', () => {
    const out = html(<ChatComposer name="s" label="S" handle={handle({ draft: 'hi' })} />)
    expect(out).not.toContain('chat-delay-send')
    expect(out).not.toContain('chat-queued-sends')
  })

  test('an empty box disables it, with the reason on the control', () => {
    const out = html(
      <ChatComposer name="s" label="S" handle={handle()} delay={delaySend()} />,
    )
    const disc = delayDisc(out)
    expect(isDisabled(disc)).toBe(true)
    expect(disc).toContain('Type a message')
  })

  test('a draft arms it, and it says what it does', () => {
    const out = html(
      <ChatComposer name="s" label="S" handle={handle({ draft: 'ship it' })} delay={delaySend()} />,
    )
    const disc = delayDisc(out)
    expect(isDisabled(disc)).toBe(false)
    expect(disc).toContain('Send later')
  })

  test('staged attachments disable it — v1 queues text, and says so', () => {
    const out = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle({ draft: 'look at this' })}
        delay={delaySend()}
        attachments={staged([
          { id: '1', name: 'a.png', kind: 'image', uploading: false, path: '/tmp/a.png' },
        ] as StagedAttachment[])}
      />,
    )
    const disc = delayDisc(out)
    expect(isDisabled(disc)).toBe(true)
    expect(disc).toContain('attachments')
  })

  test('the gate is ONE reading, and the chooser wears it too', () => {
    // The order matters: the loudest true reason wins, so a blocked session
    // never reads as "type a message first".
    expect(delayGateReason({ blocked: 'gone', attachments: 2, draft: 'hi' })).toContain(
      'can’t take messages',
    )
    expect(delayGateReason({ attachments: 1, draft: 'hi' })).toContain('attachments')
    expect(delayGateReason({ draft: '   ' })).toContain('Type a message')
    expect(delayGateReason({ draft: 'hi' })).toBeNull()
    // The chooser's rows read the SAME function, not a second copy of the rule —
    // asserted against the source, because the menu only exists while open.
    const menu = readFileSync(
      new URL('../../src/components/chat/composer.tsx', import.meta.url),
      'utf8',
    )
    expect(menu).toContain('delayGateReason({ blocked, attachments: stagedFiles.length, draft })')
    // Three call sites wear the live gate: the trailing disc, and BOTH chooser
    // shells (a menu already open when a file lands must go inert in place).
    expect(menu.match(/disabled=\{delayDisabled\}/g)?.length).toBe(3)
  })

  test('a blocked session disables it — no queueing into a dead pty', () => {
    const out = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle({ draft: 'hi' })}
        delay={delaySend()}
        blocked="This session is gone"
      />,
    )
    const disc = delayDisc(out)
    expect(isDisabled(disc)).toBe(true)
    expect(disc).toContain('can’t take messages')
  })

  test('a write in flight disables it — one schedule at a time', () => {
    const out = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle({ draft: 'hi' })}
        delay={delaySend({ busy: true })}
      />,
    )
    expect(isDisabled(delayDisc(out))).toBe(true)
  })

  test('the bar never carries two clocks: send-later REPLACES the leading one', () => {
    const withDelay = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle({ draft: 'hi' })}
        onSchedule={() => undefined}
        delay={delaySend()}
      />,
    )
    expect(withDelay).toContain('chat-delay-send')
    expect(withDelay).not.toContain('chat-composer-schedule')
    // …and without the delay plane the old control is exactly what it was.
    const without = html(
      <ChatComposer name="s" label="S" handle={handle({ draft: 'hi' })} onSchedule={() => undefined} />,
    )
    expect(without).toContain('chat-composer-schedule')
  })

  test('a queued send renders its receipt: the countdown, and a Cancel', () => {
    const now = 1_700_000_000_000
    const out = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle()}
        delay={delaySend({
          nowMs: now,
          queued: [{ id: 'SCHED-1', text: 'ship it', dueMs: now + 3_600_000, optionKey: '1h' }],
        })}
      />,
    )
    expect(out).toContain('chat-queued-chip')
    expect(out).toContain('Queued')
    expect(out).toContain('sends in 1h')
    expect(out).toContain('chat-queued-cancel')
    // The spoken sentence is stable; the ticking number is hidden from it.
    expect(out).toContain('Message queued')
  })

  test('a due chip says "Sending…" instead of counting past zero', () => {
    const now = 1_700_000_000_000
    const out = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle()}
        delay={delaySend({
          nowMs: now,
          queued: [{ id: 'SCHED-1', text: 'ship it', dueMs: now - 2_000, optionKey: '10m' }],
        })}
      />,
    )
    expect(out).toContain('Sending…')
    expect(out).not.toContain('sends in')
    // THE BLOCKER: no Cancel once the send is committed (see below).
    expect(out).not.toContain('chat-queued-cancel')
    // …and what a screen reader hears is the same truth, not the old promise.
    expect(out).toContain('being sent now')
  })

  test('a failed write is shown where the chip would be, with a way out', () => {
    const out = html(
      <ChatComposer
        name="s"
        label="S"
        handle={handle({ draft: 'hi' })}
        delay={delaySend({ error: 'invalid time expression' })}
      />,
    )
    expect(out).toContain('chat-queued-error')
    expect(out).toContain('invalid time expression')
    expect(out).toContain('Dismiss')
  })
})
