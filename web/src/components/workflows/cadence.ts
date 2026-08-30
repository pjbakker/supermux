// Cadence — the pure half of "when does this run".
//
// Salvaged wholesale from `components/scheduler/helpers.ts`: the English
// humanizer, the structured recurrence draft and the two serializers were the
// genuinely good part of the old dialog, and a redesign is not a reason to
// re-derive a grammar that already mirrors the server parser line for line.
// What did NOT come across: `KIND_LABEL` and `PROVIDERS`, which described the
// job kinds that no longer exist.
//
// What is NEW is at the bottom: `normalizeCadence`, the forgiving front door.
// The server grammar is exact ("every weekday at 9am"); people type
// "weekdays 9am", "every day at 9", "mondays at 9", "hourly". Repairing those
// into the grammar CLIENT-SIDE is the whole difference between a cadence field
// that feels like a search box and one that feels like a syntax quiz — and it
// costs the server nothing, because what leaves here is always an expression
// the parser already accepted before this file existed.
//
// Pure functions only, no React — the composer, the list and the tests all
// import it without pulling a component tree behind them.


/** Relative + absolute formatting for a next/last-run timestamp (RFC3339). */
export function formatRunTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = Date.now()
  const diff = d.getTime() - now
  const abs = Math.abs(diff)
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour

  let rel: string
  if (abs < min) {
    rel = diff >= 0 ? 'in <1m' : 'just now'
  } else if (abs < hour) {
    // Rounding can land on 60 a second before the hour — "in 60m" is a number
    // no clock says, so it is promoted rather than printed.
    const m = Math.round(abs / min)
    if (m >= 60) rel = diff >= 0 ? 'in 1h' : '1h ago'
    else rel = diff >= 0 ? `in ${m}m` : `${m}m ago`
  } else if (abs < day) {
    const h = Math.round(abs / hour)
    rel = diff >= 0 ? `in ${h}h` : `${h}h ago`
  } else if (abs < 7 * day) {
    const dd = Math.round(abs / day)
    rel = diff >= 0 ? `in ${dd}d` : `${dd}d ago`
  } else {
    rel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return rel
}

/** Full local datetime for tooltips + the preview list. */
export function formatFull(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Time-ago for a `schedule_runs.ran_at` epoch-seconds value. */
export function formatRanAt(epochSeconds: number): string {
  return formatRunTime(new Date(epochSeconds * 1000).toISOString())
}

// ── recurrence composer + English humanizer (frontend-only; the server parser
// already accepts every grammar form below — see scheduler/parser.rs) ──────────

/** Quick-pick frequencies the composer chips serialize to. `custom` is the
 *  raw escape hatch (free-text natural language or cron). */
export type Frequency =
  | 'once'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'interval'
  | 'custom'

/** Sentence-case label for each quick-pick chip. */
export const FREQUENCY_LABEL: Record<Frequency, string> = {
  once: 'Once',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  monthly: 'Monthly',
  interval: 'Interval',
  custom: 'Custom',
}

/** The quick-pick chips, in display order (Custom last — it's the escape hatch). */
export const FREQUENCY_CHIPS: Frequency[] = [
  'once',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'interval',
  'custom',
]

/** Day-of-week tokens the parser accepts (`weekly on <day>` / `every <day>`). */
export const WEEKDAYS = [
  { value: 'mon', label: 'Mon', full: 'Monday' },
  { value: 'tue', label: 'Tue', full: 'Tuesday' },
  { value: 'wed', label: 'Wed', full: 'Wednesday' },
  { value: 'thu', label: 'Thu', full: 'Thursday' },
  { value: 'fri', label: 'Fri', full: 'Friday' },
  { value: 'sat', label: 'Sat', full: 'Saturday' },
  { value: 'sun', label: 'Sun', full: 'Sunday' },
] as const

// Map every day token the server parser accepts (abbrev + full + variants, see
// parser.rs::day_to_std) to its full English name, so the humanizer recognizes
// both `weekly on mon` and `every monday`.
const DAY_FULL: Record<string, string> = {
  sun: 'Sunday',
  sunday: 'Sunday',
  mon: 'Monday',
  monday: 'Monday',
  tue: 'Tuesday',
  tues: 'Tuesday',
  tuesday: 'Tuesday',
  wed: 'Wednesday',
  wednesday: 'Wednesday',
  thu: 'Thursday',
  thurs: 'Thursday',
  thursday: 'Thursday',
  fri: 'Friday',
  friday: 'Friday',
  sat: 'Saturday',
  saturday: 'Saturday',
}

// Map a day token to the short token the composer's day-picker uses.
const DAY_TO_SHORT: Record<string, string> = {
  sun: 'sun',
  sunday: 'sun',
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
}

const ORDINAL = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

/** Pretty-print an HH:MM 24h time as e.g. "09:00". Used in the English render. */
function prettyTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Parse the grammar's clock forms (`9am`, `6pm`, `9:30pm`, `14:30`) → [h, m].
 *  Mirrors server `parse_time`. Returns null when unparseable. */
function readTime(raw: string): [number, number] | null {
  const t = raw.trim().toLowerCase()
  let ampm: 'am' | 'pm' | null = null
  let body = t
  if (t.endsWith('am')) {
    ampm = 'am'
    body = t.slice(0, -2).trim()
  } else if (t.endsWith('pm')) {
    ampm = 'pm'
    body = t.slice(0, -2).trim()
  }
  const [hStr, mStr] = body.includes(':') ? body.split(':') : [body, '0']
  let h = Number(hStr)
  const m = Number(mStr)
  if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return null
  if (ampm === 'pm') h = h === 12 ? 12 : h < 12 ? h + 12 : NaN
  if (ampm === 'am') h = h === 12 ? 0 : h < 12 ? h : NaN
  if (!Number.isInteger(h) || h > 23 || h < 0) return null
  return [h, m]
}

const RE_IN = /^in\s+(\d+)\s*([a-z]+)$/
const RE_EVERY_N = /^every\s+(\d+)\s*([a-z]+)$/
const RE_EVERY_ALIAS = /^every\s+(morning|evening|night)$/
const RE_WEEKDAY = /^every\s+weekday\s+at\s+(.+)$/
const RE_DAILY = /^daily\s+at\s+(.+)$/
const RE_WEEKLY = /^weekly\s+on\s+([a-z]+)\s+at\s+(.+)$/
const RE_MONTHLY = /^monthly\s+on\s+(\d+)\s+at\s+(.+)$/
const RE_EVERY_DAY = /^every\s+([a-z]+)\s+at\s+(.+)$/

const UNIT_WORD: Record<string, string> = {
  s: 'second',
  sec: 'second',
  secs: 'second',
  second: 'second',
  seconds: 'second',
  m: 'minute',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
}

/**
 * Humanize a schedule expression to a friendly English sentence —
 * "Every Monday at 09:00", "Every weekday at 09:00", "Daily at 18:00", etc.
 * Mirrors the grammar the server parser recognizes (scheduler/parser.rs); for a
 * raw 5-field cron we return "Custom schedule" rather than pulling in a heavy
 * cron-humanizer dependency. Falls back to the raw text when nothing matches.
 */
export function describeSchedule(expr: string | null | undefined): string {
  const e = (expr ?? '').trim().toLowerCase()
  if (!e) return '—'

  let c = RE_IN.exec(e)
  if (c) {
    const n = Number(c[1])
    const unit = UNIT_WORD[c[2]] ?? c[2]
    return `Once, in ${n} ${unit}${n === 1 ? '' : 's'}`
  }

  c = RE_EVERY_N.exec(e)
  if (c) {
    const n = Number(c[1])
    const unit = UNIT_WORD[c[2]] ?? c[2]
    return n === 1
      ? `Every ${unit}`
      : `Every ${n} ${unit}${n === 1 ? '' : 's'}`
  }

  c = RE_EVERY_ALIAS.exec(e)
  if (c) {
    const t = c[1] === 'morning' ? '09:00' : '18:00'
    const word = c[1].charAt(0).toUpperCase() + c[1].slice(1)
    return `Every ${word.toLowerCase()} at ${t}`
  }

  c = RE_WEEKDAY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    return tm ? `Every weekday at ${prettyTime(tm[0], tm[1])}` : 'Every weekday'
  }

  c = RE_DAILY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    return tm ? `Daily at ${prettyTime(tm[0], tm[1])}` : 'Daily'
  }

  c = RE_WEEKLY.exec(e)
  if (c) {
    const day = DAY_FULL[c[1]] ?? c[1]
    const tm = readTime(c[2])
    return tm ? `Every ${day} at ${prettyTime(tm[0], tm[1])}` : `Every ${day}`
  }

  c = RE_MONTHLY.exec(e)
  if (c) {
    const dom = Number(c[1])
    const tm = readTime(c[2])
    return tm
      ? `Monthly on the ${ORDINAL(dom)} at ${prettyTime(tm[0], tm[1])}`
      : `Monthly on the ${ORDINAL(dom)}`
  }

  c = RE_EVERY_DAY.exec(e)
  if (c && DAY_FULL[c[1]]) {
    const day = DAY_FULL[c[1]]
    const tm = readTime(c[2])
    return tm ? `Every ${day} at ${prettyTime(tm[0], tm[1])}` : `Every ${day}`
  }

  // A REAL cron, not "five words". Before this was `split(/\s+/).length === 5`,
  // which made "whenever i feel like it" a custom schedule.
  if (isCronExpr(e)) return 'Custom schedule'

  return expr!.trim()
}

/** The composer's structured selection — serializes to a `schedule_expr`. */
export interface RecurrenceDraft {
  frequency: Frequency
  day: string // weekday token for `weekly`
  time: string // HH:MM (24h) for daily/weekdays/weekly/monthly
  dom: number // day-of-month (1–28) for `monthly`
  intervalN: number // count for `interval`
  intervalUnit: string // m/h/d for `interval`
}

export const EMPTY_RECURRENCE: RecurrenceDraft = {
  frequency: 'daily',
  day: 'mon',
  time: '09:00',
  dom: 1,
  intervalN: 30,
  intervalUnit: 'm',
}

/** Render a 24h "HH:MM" string into the parser's `H:MM` time (drops the pad so
 *  the round-trip is clean — both forms parse identically server-side). */
function exprTime(hhmm: string): string {
  const tm = readTime(hhmm)
  if (!tm) return hhmm
  return `${tm[0]}:${String(tm[1]).padStart(2, '0')}`
}

/** Serialize a structured composer selection into a `schedule_expr` the server
 *  parser accepts verbatim. `custom` returns null (caller keeps the free-text). */
export function recurrenceToExpr(r: RecurrenceDraft): string | null {
  switch (r.frequency) {
    case 'once':
      return null // one-shot is composed by the datetime picker → "in <N>m"
    case 'daily':
      return `daily at ${exprTime(r.time)}`
    case 'weekdays':
      return `every weekday at ${exprTime(r.time)}`
    case 'weekly':
      return `weekly on ${r.day} at ${exprTime(r.time)}`
    case 'monthly':
      return `monthly on ${r.dom} at ${exprTime(r.time)}`
    case 'interval':
      return `every ${r.intervalN}${r.intervalUnit}`
    case 'custom':
      return null
  }
}

/** Best-effort: read an existing `schedule_expr` back into a composer draft so
 *  editing an existing schedule lands on the matching chip (else `custom`). */
export function exprToRecurrence(expr: string | null | undefined): RecurrenceDraft {
  const e = (expr ?? '').trim().toLowerCase()
  if (!e) return { ...EMPTY_RECURRENCE }

  let c = RE_DAILY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    if (tm) return { ...EMPTY_RECURRENCE, frequency: 'daily', time: prettyTime(tm[0], tm[1]) }
  }
  c = RE_WEEKDAY.exec(e)
  if (c) {
    const tm = readTime(c[1])
    if (tm) return { ...EMPTY_RECURRENCE, frequency: 'weekdays', time: prettyTime(tm[0], tm[1]) }
  }
  c = RE_WEEKLY.exec(e)
  if (c && DAY_TO_SHORT[c[1]]) {
    const tm = readTime(c[2])
    if (tm)
      return {
        ...EMPTY_RECURRENCE,
        frequency: 'weekly',
        day: DAY_TO_SHORT[c[1]],
        time: prettyTime(tm[0], tm[1]),
      }
  }
  c = RE_EVERY_DAY.exec(e)
  if (c && DAY_TO_SHORT[c[1]]) {
    const tm = readTime(c[2])
    if (tm)
      return {
        ...EMPTY_RECURRENCE,
        frequency: 'weekly',
        day: DAY_TO_SHORT[c[1]],
        time: prettyTime(tm[0], tm[1]),
      }
  }
  c = RE_MONTHLY.exec(e)
  if (c) {
    const tm = readTime(c[2])
    if (tm)
      return {
        ...EMPTY_RECURRENCE,
        frequency: 'monthly',
        dom: Number(c[1]),
        time: prettyTime(tm[0], tm[1]),
      }
  }
  c = RE_EVERY_N.exec(e)
  if (c) {
    return {
      ...EMPTY_RECURRENCE,
      frequency: 'interval',
      intervalN: Number(c[1]),
      intervalUnit: c[2],
    }
  }
  c = RE_IN.exec(e)
  if (c) return { ...EMPTY_RECURRENCE, frequency: 'once' }

  return { ...EMPTY_RECURRENCE, frequency: 'custom' }
}

// ── the forgiving front door (new) ────────────────────────────────────────────
//
// Everything below turns what a person types into what the parser accepts. It
// never invents a cadence the server would reject: `normalizeCadence` returns
// null when it cannot repair the input, and the composer says so in English
// rather than shipping a guess and letting a 400 explain it.

/** Day names + the short tokens, longest-first so "sunday" wins over "sun". */
const DAY_WORDS: Array<[RegExp, string]> = [
  [/^(sundays?|sun)$/, 'sun'],
  [/^(mondays?|mon)$/, 'mon'],
  [/^(tuesdays?|tues|tue)$/, 'tue'],
  [/^(wednesdays?|weds|wed)$/, 'wed'],
  [/^(thursdays?|thurs|thu)$/, 'thu'],
  [/^(fridays?|fri)$/, 'fri'],
  [/^(saturdays?|sat)$/, 'sat'],
]

function dayToken(word: string): string | null {
  for (const [re, token] of DAY_WORDS) if (re.test(word)) return token
  return null
}

/** A bare clock time: `9`, `9am`, `9:30`, `9:30pm`, `21:00`. */
const RE_CLOCK = /^\d{1,2}(:\d{2})?(am|pm)?$/

/**
 * Does this parse under the server grammar?
 *
 * Mirrors `parser.rs`'s own order of attempts AND its own strictness, which is
 * the part that was missing: a regex that matches the SHAPE of an expression
 * says nothing about whether the parser can read the time inside it. Every arm
 * below now validates its payload — the unit, the day name, the day-of-month
 * range, the clock — because "every weekday at potato" matching `RE_WEEKDAY`
 * is not the same thing as it being a schedule.
 *
 * The server stays the authority. This only has to be tight enough that
 * nothing which is obviously not a cadence can ever wear the green check.
 */
export function isCadenceExpr(expr: string): boolean {
  const e = expr.trim().toLowerCase()
  if (!e) return false

  let c = RE_IN.exec(e)
  if (c) return !!unitToken(c[2])
  c = RE_EVERY_N.exec(e)
  if (c) return !!unitToken(c[2]) && Number(c[1]) > 0
  if (RE_EVERY_ALIAS.test(e)) return true

  c = RE_WEEKDAY.exec(e)
  if (c) return readTime(c[1]) !== null
  c = RE_DAILY.exec(e)
  if (c) return readTime(c[1]) !== null
  c = RE_WEEKLY.exec(e)
  if (c) return !!dayToken(c[1]) && readTime(c[2]) !== null
  c = RE_MONTHLY.exec(e)
  if (c) {
    const dom = Number(c[1])
    return dom >= 1 && dom <= 28 && readTime(c[2]) !== null
  }
  c = RE_EVERY_DAY.exec(e)
  if (c && dayToken(c[1])) return readTime(c[2]) !== null

  return isCronExpr(e)
}

/** Month and day NAMES the `cron` crate maps natively (parser.rs passes them
 *  through `translate_dow` untouched). */
const CRON_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const CRON_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** One cron field: `*`, `a`, `a-b`, any of those with `/step`, comma-joined. */
function cronField(field: string, lo: number, hi: number, names: string[]): boolean {
  if (!field) return false
  return field.split(',').every((seg) => {
    if (!seg) return false
    const [base, step, ...rest] = seg.split('/')
    if (rest.length) return false
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false
    if (base === '*') return true
    const token = (t: string): boolean => {
      if (!t) return false
      if (names.includes(t)) return true
      if (!/^\d{1,2}$/.test(t)) return false
      const n = Number(t)
      return n >= lo && n <= hi
    }
    const [a, b, ...more] = base.split('-')
    if (more.length) return false
    return b === undefined ? token(a) : token(a) && token(b)
  })
}

/**
 * A REAL 5-field cron — `MIN HOUR DOM MON DOW`, each field validated against
 * its own range.
 *
 * THE BUG THIS EXISTS TO CLOSE: the previous test was
 * `expr.split(/\s+/).length === 5`, i.e. "any five words". "whenever i feel
 * like it" is five words, so it validated, rendered as "Custom schedule", wore
 * the green check and got a next-fire time. Word count is not a grammar.
 */
export function isCronExpr(raw: string): boolean {
  const fields = raw.trim().toLowerCase().split(/\s+/)
  if (fields.length !== 5) return false
  return (
    cronField(fields[0], 0, 59, []) &&
    cronField(fields[1], 0, 23, []) &&
    cronField(fields[2], 1, 31, []) &&
    cronField(fields[3], 1, 12, CRON_MONTHS) &&
    cronField(fields[4], 0, 7, CRON_DAYS)
  )
}

/** Strip the words that carry no cadence meaning — "run", "please", "at" when
 *  it is doing nothing, the ordinal suffix on a day-of-month. */
function tidy(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[.,!]+$/, '')
    .replace(/^(please\s+)?(run|fire|start|do)\s+(this\s+)?/, '')
    .replace(/\s+/g, ' ')
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bo'?clock\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalize a unit word to the parser's canonical short form. */
function unitToken(word: string): string | null {
  if (/^(s|sec|secs|second|seconds)$/.test(word)) return 's'
  if (/^(m|min|mins|minute|minutes)$/.test(word)) return 'm'
  if (/^(h|hr|hrs|hour|hours)$/.test(word)) return 'h'
  if (/^(d|day|days)$/.test(word)) return 'd'
  return null
}

/**
 * Repair a human phrasing into a `schedule_expr` the server parser accepts, or
 * return null when there is nothing honest to hand it.
 *
 * The repairs, each one a phrasing observed in the wild:
 *   "9am"                    → "daily at 9am"
 *   "every day at 9"         → "daily at 9"          (the parser wants a DAY NAME after "every")
 *   "weekdays 9am"           → "every weekday at 9am"
 *   "mondays at 9am"         → "weekly on mon at 9am"
 *   "hourly" / "every hour"  → "every 1h"
 *   "every 30 minutes"       → "every 30m"
 *   "monthly on the 1st at 9"→ "monthly on 1 at 9"
 */
export function normalizeCadence(raw: string): string | null {
  const e = tidy(raw)
  if (!e) return null
  // Canonicalise the interval unit even when the long form already parses
  // ("every 30 minutes" is legal server-side): one stored spelling per cadence
  // means `exprToRecurrence` lands on the Interval chip rather than on Custom.
  const spelled = /^every\s+(\d+)\s+([a-z]+)$/.exec(e)
  if (spelled) {
    const unit = unitToken(spelled[2])
    if (unit) return `every ${spelled[1]}${unit}`
  }
  if (isCadenceExpr(e)) return e

  // "hourly" / "daily" / "weekly" / "every hour" — bare frequency words.
  if (/^(hourly|every hour)$/.test(e)) return 'every 1h'
  if (/^(daily|every day|each day)$/.test(e)) return 'daily at 9:00'
  if (/^(weekly|every week)$/.test(e)) return 'weekly on mon at 9:00'
  if (/^(monthly|every month)$/.test(e)) return 'monthly on 1 at 9:00'
  if (/^(weekdays?|every weekday|workdays?)$/.test(e)) return 'every weekday at 9:00'

  // A bare clock time means "every day at that time" — the single most common
  // thing a person types into a "when?" box.
  if (RE_CLOCK.test(e)) return `daily at ${e}`

  // "every N <unit>" with a spelled-out unit, and "every other <unit>".
  let c = /^every\s+(\d+)\s+([a-z]+)$/.exec(e)
  if (c) {
    const unit = unitToken(c[2])
    if (unit) return `every ${c[1]}${unit}`
  }
  c = /^every\s+([a-z]+)$/.exec(e)
  if (c) {
    const unit = unitToken(c[1])
    if (unit) return `every 1${unit}`
    const day = dayToken(c[1])
    if (day) return `weekly on ${day} at 9:00`
  }

  // Split off a trailing clock time: "<something> [at] <time>".
  const at = /^(.*?)\s+(?:at\s+|@\s*)?(\d{1,2}(?::\d{2})?(?:am|pm)?)$/.exec(e)
  const head = at ? at[1].trim() : e
  const time = at ? at[2] : null

  if (time) {
    if (/^(every day|each day|day|daily|everyday)$/.test(head)) return `daily at ${time}`
    if (/^(weekdays?|every weekday|workdays?|on weekdays)$/.test(head))
      return `every weekday at ${time}`
    const m = /^(?:every|on|each)?\s*([a-z]+)s?$/.exec(head)
    if (m) {
      const day = dayToken(m[1]) ?? dayToken(`${m[1]}s`)
      if (day) return `weekly on ${day} at ${time}`
    }
    const dom = /^(?:monthly|every month)\s*(?:on\s*(?:the\s*)?)?(\d{1,2})$/.exec(head)
    if (dom) {
      const n = Number(dom[1])
      if (n >= 1 && n <= 28) return `monthly on ${n} at ${time}`
    }
    if (/^(morning)$/.test(head)) return `daily at ${time}`
  }

  // "in 2 hours" / "in an hour" — the one-shot relative form.
  c = /^in\s+(an?|\d+)\s*([a-z]+)$/.exec(e)
  if (c) {
    const unit = unitToken(c[2])
    if (unit) return `in ${/^an?$/.test(c[1]) ? 1 : Number(c[1])}${unit}`
  }

  return null
}

/** A one-shot fire at a wall-clock instant, expressed in the grammar the parser
 *  has: minutes from now. Rounded UP so "in 0m" — which would fire on the very
 *  next tick — is never what a user who picked a future time gets. */
export function onceExprFor(when: Date, now: Date = new Date()): string | null {
  const mins = Math.ceil((when.getTime() - now.getTime()) / 60_000)
  if (!Number.isFinite(mins) || mins < 1) return null
  return `in ${mins}m`
}

/** A one-tap cadence. `expr` is already in the server grammar — a preset can
 *  never be the thing that fails to parse. */
export interface QuickCadence {
  key: string
  label: string
  expr: string
}

/**
 * The five one-tap answers, in the order a person reaches for them. This is the
 * whole point of the trigger control: the median workflow wants one of these,
 * and every one of them is a single tap with no typing at all.
 */
export const QUICK_CADENCES: QuickCadence[] = [
  { key: 'weekday-morning', label: 'Every weekday, 9:00', expr: 'every weekday at 9:00' },
  { key: 'daily-morning', label: 'Every morning, 9:00', expr: 'daily at 9:00' },
  { key: 'daily-evening', label: 'Every evening, 18:00', expr: 'daily at 18:00' },
  { key: 'weekly-monday', label: 'Mondays, 9:00', expr: 'every monday at 9:00' },
  { key: 'hourly', label: 'Every hour', expr: 'every 1h' },
]

// ── the list's hint line ──────────────────────────────────────────────────────

/** What the old table's four text columns said, as one line. Exported so the
 *  anti-drop test asserts the SAME function the list renders from rather than a
 *  re-implementation of it (the rule `scheduleHintParts` established).
 *
 *  Renamed from `scheduleHintParts`: the `target` column is gone with the job
 *  kinds — a workflow's target is its bot, which the row already shows as a
 *  face — and `steps` took its place, because "how much is this thing" is the
 *  question the old `command` column was really answering. */
export function workflowHintParts(w: {
  schedule_expr: string | null
  trigger_kind: string
  enabled: number
  next_run: string | null
  last_run: string | null
  steps?: unknown[]
}): { human: string; next: string; last: string; steps: string } {
  const n = w.steps?.length ?? 0
  return {
    human: w.trigger_kind === 'manual' ? 'When I say' : describeSchedule(w.schedule_expr),
    // A paused workflow has no next fire — say so rather than showing a stale
    // timestamp (the old table did the same, and it is still the honest answer).
    next:
      w.trigger_kind === 'manual'
        ? 'on demand'
        : w.enabled === 1
          ? formatRunTime(w.next_run)
          : 'paused',
    last: w.last_run ? formatRunTime(w.last_run) : 'never',
    steps: n === 1 ? '1 step' : `${n} steps`,
  }
}
