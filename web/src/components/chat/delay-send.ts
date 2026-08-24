// SEND LATER — the composer's delay plane: what the delays ARE, the one-shot
// schedule each one writes, and the queue the confirmation chip reads back.
//
// NO SERVER CHANGE. A delayed send is a schedule the backend has served since
// B4: `kind: 'tmux'` + `schedule_expr: 'in 10 minutes'` parses to `sched_type
// "once"` (server/src/scheduler/parser.rs, `RE_IN` → `Recurrence::Once`) and the
// runner delivers `prompt` into THIS session on the next 10s tick after it comes
// due. That is the whole feature: it survives a server restart, a phone reload
// and a closed tab, because the thing that remembers is the schedules table and
// not this browser.
//
// WHY A MODULE STORE (the same reasoning as `composer-draft.ts`). The chip is a
// RECEIPT for a write that already landed; it must survive the chat panel
// unmounting — a renderer toggle, a session switch and back — or the app would
// look like it forgot a message the server is still holding. Module Maps survive
// a remount, `sessionStorage` survives this tab reloading, and a fired item
// prunes itself, so a stale chip cannot outlive its schedule by more than the
// settle window. React never sees any of this except through
// `useSyncExternalStore` in `use-delay-send.ts`.
//
// The API surface is a PORT, not a direct `schedulerApi` call, for one reason:
// the queue/cancel arithmetic — the body that goes on the wire, what the chip
// remembers, what Undo puts back — is the part worth pinning in a unit test, and
// a port lets that test be a real assertion about the POST body rather than a
// mocked module.

import {
  schedulerApi,
  type ScheduleCreateInput,
  type ScheduleRow,
} from '@/lib/api/scheduler'

/** One offered delay. `expr` is the ONLY thing the backend sees of it. */
export interface DelayOption {
  key: '10m' | '1h' | '3h'
  /** The chooser row's copy. */
  label: string
  /** The compact tail the chip and the button title use ("sends in 1h"). */
  short: string
  /**
   * The cadence expression, in the scheduler's own relative grammar
   * (`^in\s+(\d+)\s*([a-z]+)$`, units s/m/h/d). It is what makes the schedule a
   * ONE-SHOT: `in …` is the only expression that parses to `sched_type "once"`,
   * so a delayed send can never turn into a recurring job.
   */
  expr: string
  /** The same delay in milliseconds — the chip's local countdown floor. */
  ms: number
}

/**
 * THE THREE DELAYS, and only three.
 *
 * A chooser is a decision, and four rows of round numbers is already the ceiling
 * of what someone will read while holding a half-typed thought. Anything else —
 * "tomorrow at 09:00", a recurrence, a different session — is the SCHEDULES
 * SHEET's job, and the chooser's last row is the door to it (`onPickTime`), so
 * the ladder from "in an hour" to a full job is one tap and never a fork.
 */
export const DELAY_OPTIONS: readonly DelayOption[] = [
  { key: '10m', label: 'In 10 minutes', short: '10m', expr: 'in 10 minutes', ms: 10 * 60_000 },
  { key: '1h', label: 'In 1 hour', short: '1h', expr: 'in 1 hour', ms: 60 * 60_000 },
  { key: '3h', label: 'In 3 hours', short: '3h', expr: 'in 3 hours', ms: 3 * 60 * 60_000 },
]

/** A queued send, as the chip needs it: what it says, when it goes, and the row
 *  Undo has to delete. `text` is kept verbatim — Undo gives the words back, so
 *  a cancelled delay costs nothing but the tap. */
export interface QueuedSend {
  /** The schedule's id (`SCHED-xxxxxxxx`) — the address `DELETE` needs. */
  id: string
  /** The message itself, exactly as it was typed. */
  text: string
  /** When the server says it fires (its `next_run`), as epoch ms. */
  dueMs: number
  optionKey: DelayOption['key']
}

/** The scheduler, as the three calls this feature makes. Injected so the queue
 *  arithmetic is testable without a network or a module mock. */
export interface DelaySendPort {
  create: (input: ScheduleCreateInput) => Promise<ScheduleRow>
  remove: (id: string) => Promise<unknown>
  /** Every live schedule — the source of truth the chips are rebuilt from on a
   *  cold mount (see `hydrateQueue`). */
  list: () => Promise<ScheduleRow[]>
}

/** The real port — the shipped scheduler client, no wrapper. */
export const schedulerPort: DelaySendPort = {
  create: (input) => schedulerApi.create(input),
  remove: (id) => schedulerApi.remove(id),
  list: () => schedulerApi.list(),
}

// ── what goes on the wire ────────────────────────────────────────────────────

/** The title's stem. It is what the Schedules sheet lists the job under, and
 *  what the transcript's schedule line will say when it fires. */
export const DELAY_TITLE = 'Send later'

/** How much of the message the title quotes. Long enough to recognise which
 *  message it is in a list, short enough to stay one line in the sheet. */
const TITLE_PREVIEW_CHARS = 48

/** `Send later · the first words of it` — a title someone can recognise a day
 *  later in the Schedules sheet, with the newlines flattened out of it. */
export function delayTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return DELAY_TITLE
  const preview =
    flat.length > TITLE_PREVIEW_CHARS ? `${flat.slice(0, TITLE_PREVIEW_CHARS - 1)}…` : flat
  return `${DELAY_TITLE} · ${preview}`
}

/**
 * The create body — a one-shot prompt into THIS session, and nothing else.
 *
 * `command` is deliberately empty: this is a message a person typed, not a
 * command run on their behalf, and the scheduler accepts a prompt-only tmux job
 * (`create()`: "command or prompt required"). No boot dir, no shell, no watch,
 * no done-action — a delayed send has exactly the authority the Send button has.
 */
export function delayScheduleInput(
  session: string,
  text: string,
  option: DelayOption,
): ScheduleCreateInput {
  return {
    title: delayTitle(text),
    command: '',
    prompt: text,
    kind: 'tmux',
    session,
    schedule_expr: option.expr,
  }
}

/** When the server says it fires. `next_run` is the authority (the schedule is
 *  the thing that will actually deliver); the local `now + delay` is only the
 *  fallback for a row that came back without one. */
export function dueAtMs(row: Pick<ScheduleRow, 'next_run'>, fallbackMs: number): number {
  const parsed = row.next_run ? Date.parse(row.next_run) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallbackMs
}

// ── what the chip says ───────────────────────────────────────────────────────

/**
 * The settle window: how long a due item stays on screen before it retires.
 *
 * The runner ticks every 10s (`server/src/scheduler/runner.rs`), so a schedule
 * fires WITHIN ten seconds of coming due, not at it. The chip therefore says
 * "sending now" across that window instead of vanishing a beat before the words
 * arrive — the transcript's own arrival line is the confirmation, and this is
 * the honest bridge to it.
 */
export const SETTLE_MS = 20_000

/** Has this item been due long enough that the chip is no longer telling the
 *  truth about it? */
export function isRetired(item: Pick<QueuedSend, 'dueMs'>, nowMs: number): boolean {
  return nowMs - item.dueMs > SETTLE_MS
}

/**
 * CAN THIS STILL BE CALLED BACK? Only strictly BEFORE it comes due.
 *
 * The window closes at `dueMs`, not at the end of the settle window, and that is
 * a correctness rule rather than a nicety. The runner delivers a due one-shot on
 * its next tick, and `DELETE /api/schedules/{id}` soft-deletes by id ALONE — it
 * does not care whether the job has already fired (nor should it: the Schedules
 * admin legitimately deletes finished jobs). So a Cancel offered after `dueMs`
 * can come back 200 on a schedule whose prompt is already IN the session, and
 * the composer would hand the words back as though nothing had been sent —
 * inviting the user to send them a second time.
 *
 * Fail closed: past `dueMs` the send is committed, the chip says "Sending…" and
 * offers no Cancel. The cost is a ≤10s window where a technically-deletable row
 * cannot be cancelled from here; the alternative is a cancel this app cannot
 * honestly promise is pre-delivery.
 */
export function isCancellable(item: Pick<QueuedSend, 'dueMs'>, nowMs: number): boolean {
  return nowMs < item.dueMs
}

/**
 * WHY THE DELAY CONTROL CANNOT ACT, or null when it can — one reading, shared by
 * the trailing clock and by the chooser's rows.
 *
 * It is one function rather than two call sites because the chooser can be OPEN
 * when the answer changes: a file lands on the composer, or the session goes
 * blocked, and rows that were offered a moment ago must go inert in place rather
 * than file a schedule the control beside them says is unavailable.
 */
export function delayGateReason(state: {
  /** The composer's blocked sentence, when the session cannot take messages. */
  blocked?: string
  /** How many attachments are staged. */
  attachments?: number
  /** The current draft. */
  draft?: string
}): string | null {
  if (state.blocked) return 'Send later is off while this session can’t take messages'
  if (state.attachments) return 'Send later doesn’t carry attachments — send now, or remove the files'
  if (!(state.draft ?? '').trim()) return 'Type a message, then choose when it should send'
  return null
}

/**
 * The countdown, rounded UP so it never undersells the wait: a message queued
 * for ten minutes reads "sends in 10m" the moment it is queued, not "9m".
 * Seconds only appear in the last minute, where they are the interesting number.
 */
export function countdownLabel(msLeft: number): string {
  if (msLeft <= 0) return 'sending now'
  if (msLeft < 60_000) return `sends in ${Math.ceil(msLeft / 1000)}s`
  const mins = Math.ceil(msLeft / 60_000)
  if (mins < 60) return `sends in ${mins}m`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `sends in ${hours}h ${rest}m` : `sends in ${hours}h`
}

/** The wall-clock time a delay lands at — "14:35", in the viewer's own locale
 *  and 12/24h convention. The chooser shows it beside each row so the choice is
 *  made against the clock, not against arithmetic. */
export function arrivalLabel(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** How long until the countdown's next VISIBLE change: one second while seconds
 *  are on screen, fifteen while minutes are. A chip that repaints every second
 *  for three hours is a battery cost with nothing to show for it. */
export function tickMs(msLeft: number): number {
  return msLeft < 90_000 ? 1_000 : 15_000
}

// ── the queue store (module-level, per session) ───────────────────────────────

const EMPTY: readonly QueuedSend[] = []

const queues = new Map<string, readonly QueuedSend[]>()
const listeners = new Map<string, Set<() => void>>()

// The receipt outlives the DOCUMENT too, for the same reason the draft does
// (`composer-draft.ts`): the service worker adopting a new shell, a
// pull-to-refresh, a crash reload. `sessionStorage` — this tab's scratch paper —
// because the schedule itself is the durable record and the Schedules sheet is
// where it is read a day later.
const STORE_PREFIX = 'supermux-delaysend:'
const hydrated = new Set<string>()

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    // Safari private mode / a blocked storage partition throws on ACCESS.
    return null
  }
}

function hydrate(name: string): void {
  if (hydrated.has(name)) return
  hydrated.add(name)
  try {
    const saved = store()?.getItem(STORE_PREFIX + name)
    if (!saved) return
    const parsed: unknown = JSON.parse(saved)
    if (!Array.isArray(parsed)) return
    const now = Date.now()
    const items = parsed.filter(
      (it): it is QueuedSend =>
        !!it &&
        typeof (it as QueuedSend).id === 'string' &&
        typeof (it as QueuedSend).text === 'string' &&
        typeof (it as QueuedSend).dueMs === 'number' &&
        !isRetired(it as QueuedSend, now),
    )
    if (items.length) queues.set(name, items)
  } catch {
    /* a receipt is a nicety; never let it break the composer */
  }
}

function persist(name: string, items: readonly QueuedSend[]): void {
  try {
    const s = store()
    if (!s) return
    if (!items.length) s.removeItem(STORE_PREFIX + name)
    else s.setItem(STORE_PREFIX + name, JSON.stringify(items))
  } catch {
    /* quota, private mode, disabled storage — the in-memory queue still works */
  }
}

function emit(name: string): void {
  listeners.get(name)?.forEach((fn) => fn())
}

function write(name: string, items: readonly QueuedSend[]): void {
  if (items.length) queues.set(name, items)
  else queues.delete(name)
  persist(name, items)
  emit(name)
}

/** This session's queued sends, soonest first. The SAME array identity until
 *  something actually changes — `useSyncExternalStore` compares by reference. */
export function queuedFor(name: string): readonly QueuedSend[] {
  hydrate(name)
  return queues.get(name) ?? EMPTY
}

export function subscribeQueued(name: string, fn: () => void): () => void {
  const set = listeners.get(name) ?? new Set<() => void>()
  listeners.set(name, set)
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) listeners.delete(name)
  }
}

export function addQueued(name: string, item: QueuedSend): void {
  const next = [...queuedFor(name), item].sort((a, b) => a.dueMs - b.dueMs)
  write(name, next)
}

/** Remove one item and hand it BACK — Undo needs the text it was holding. */
export function removeQueued(name: string, id: string): QueuedSend | null {
  const items = queuedFor(name)
  const found = items.find((it) => it.id === id) ?? null
  if (!found) return null
  write(
    name,
    items.filter((it) => it !== found),
  )
  return found
}

/** Drop everything the settle window has passed. Called by the countdown's own
 *  tick, so a fired chip retires itself without a second timer. */
export function pruneQueued(name: string, nowMs: number): void {
  const items = queuedFor(name)
  const live = items.filter((it) => !isRetired(it, nowMs))
  if (live.length !== items.length) write(name, live)
}

/** TEST SEAM — drop every session's queue and the shared listing. Never called
 *  by the app. */
export function resetQueues(): void {
  for (const name of [...queues.keys()]) write(name, EMPTY)
  hydrated.clear()
  listedAtMs = 0
  listing = null
}

// ── the two operations ───────────────────────────────────────────────────────

/**
 * Queue `text` for delivery after `option`. Creates the one-shot schedule, and
 * only then records the receipt — the chip cannot claim a message is queued
 * before the row that will deliver it exists.
 *
 * Throws whatever the API threw (a `SchedError` carrying the server's own
 * sentence), so the caller can put the words back in the box.
 */
export async function queueDelayedSend(
  port: DelaySendPort,
  args: { session: string; text: string; option: DelayOption; nowMs: number },
): Promise<QueuedSend> {
  const { session, text, option, nowMs } = args
  const row = await port.create(delayScheduleInput(session, text, option))
  const item: QueuedSend = {
    id: row.id,
    text,
    dueMs: dueAtMs(row, nowMs + option.ms),
    optionKey: option.key,
  }
  addQueued(session, item)
  return item
}

/**
 * Cancel a queued send: the chip goes at once (the tap must feel like the
 * answer), the schedule is deleted, and the item comes back so the words can be
 * put back in the composer. If the DELETE fails the receipt is RESTORED — the
 * schedule is still live and a chip that had vanished would be a lie — and the
 * error is re-thrown for the caller to show.
 *
 * A DUE item is refused outright — no DELETE, no restore, receipt untouched. See
 * `isCancellable`: past `dueMs` the words are already on their way, and a
 * "successful" cancel there would put a sent message back in the box. The UI does
 * not offer the control after `dueMs`; this is the same rule stated where it
 * cannot be missed by a second caller.
 */
export async function cancelDelayedSend(
  port: DelaySendPort,
  args: { session: string; id: string; nowMs: number },
): Promise<QueuedSend | null> {
  const { session, id, nowMs } = args
  const found = queuedFor(session).find((it) => it.id === id)
  if (!found || !isCancellable(found, nowMs)) return null
  const item = removeQueued(session, id)
  if (!item) return null
  try {
    await port.remove(id)
  } catch (err) {
    addQueued(session, item)
    throw err
  }
  return item
}

// ── the cold mount: rebuilding the chips from the server ─────────────────────

/**
 * Is this schedules row one of THIS composer's delayed sends, still ahead of us?
 *
 * Deliberately narrow: the session, the shape this feature writes (a live
 * one-shot tmux prompt), the title stem it stamps, and a `next_run` that has not
 * passed. Anything else in the table — a recurring job, a boot job, someone's
 * shell cron, a finished one-shot — belongs to the Schedules sheet, not to a
 * composer chip.
 */
export function isDelayRow(row: ScheduleRow, session: string, nowMs: number): boolean {
  if (row.session !== session) return false
  if (row.kind !== 'tmux' || row.sched_type !== 'once') return false
  if (row.enabled !== 1 || row.deleted != null) return false
  if (!row.title.startsWith(DELAY_TITLE)) return false
  if (!row.prompt.trim()) return false
  const due = row.next_run ? Date.parse(row.next_run) : Number.NaN
  return Number.isFinite(due) && due > nowMs
}

/** The row, as the chip needs it. The PROMPT is the message — which is why Undo
 *  still returns the real words after the tab that typed them is gone. */
export function rowToQueued(row: ScheduleRow): QueuedSend {
  const option = DELAY_OPTIONS.find((o) => o.expr === row.schedule_expr)
  return {
    id: row.id,
    text: row.prompt,
    dueMs: dueAtMs(row, Date.now()),
    optionKey: option?.key ?? '1h',
  }
}

/**
 * How long a listing is reused before another mount re-fetches it. Opening four
 * chat panes in a row should cost one `GET /api/schedules`, not four — the list
 * is small, but the panel's own rule is that no session anybody merely LOOKS at
 * subscribes to the scheduler.
 */
export const LIST_TTL_MS = 15_000

let listedAtMs = 0
let listing: Promise<ScheduleRow[]> | null = null

function sharedList(port: DelaySendPort, nowMs: number): Promise<ScheduleRow[]> {
  if (!listing || nowMs - listedAtMs > LIST_TTL_MS) {
    listedAtMs = nowMs
    listing = port.list().catch((err) => {
      // A failed listing must not be cached as "there is nothing" — the next
      // mount should be free to ask again.
      listing = null
      listedAtMs = 0
      throw err
    })
  }
  return listing
}

/**
 * REBUILD THIS SESSION'S CHIPS FROM THE SERVER (one call, at mount).
 *
 * The module store and its `sessionStorage` twin survive a remount and a reload;
 * they do NOT survive the tab closing, and the schedule does. Without this, a
 * message queued yesterday would be delivered by a server the composer had
 * stopped mentioning — the feature's one silent state. The schedules table is
 * the record, so on a cold mount it is what the chips are drawn from.
 *
 * The server wins for everything it knows about; anything queued WHILE the
 * request was in flight is kept, so a fast tap during boot is never eaten. A
 * failed listing changes nothing — the local view (possibly restored from
 * storage) stands, and the next mount tries again.
 */
export async function hydrateQueue(
  port: DelaySendPort,
  session: string,
  nowMs: number,
): Promise<void> {
  const before = queuedFor(session)
  const rows = await sharedList(port, nowMs)
  const fromServer = rows.filter((row) => isDelayRow(row, session, nowMs)).map(rowToQueued)
  const ids = new Set(fromServer.map((it) => it.id))
  // Items filed after this request left — they cannot be in its answer.
  const inFlight = queuedFor(session).filter((it) => !before.includes(it) && !ids.has(it.id))
  const next = [...fromServer, ...inFlight].sort((a, b) => a.dueMs - b.dueMs)
  const current = queuedFor(session)
  const same =
    current.length === next.length &&
    current.every((it, i) => it.id === next[i]!.id && it.dueMs === next[i]!.dueMs)
  if (!same) write(session, next)
}

/** The sentence to show when either operation fails. `SchedError` already
 *  carries the server's own words; anything else gets a plain one. */
export function delayErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : ''
  return message || 'Couldn’t reach the scheduler.'
}
