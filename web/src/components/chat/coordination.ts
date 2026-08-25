/**
 * Cross-session COORDINATION messages → calm event rows.
 * ─────────────────────────────────────────────────────────────────────────────
 * In bot/grok mode this is how one session talks to another: the harness
 * delivers a teammate's message into this session as a USER-role prompt, wrapped
 * in a shape `classifyPrompt` does not have an arm for, so it fell through to a
 * raw prompt bubble — the owner report ("ugly, not grok-standard"). The whole
 * text looks like:
 *
 *     Another Claude session sent a message:
 *     <teammate-message teammate_id="pagina-catalogus" color="pink">{JSON}</teammate-message>
 *     <teammate-message teammate_id="system">{JSON}</teammate-message>
 *     This came from another Claude session — … (a long block of agent-only
 *     guidance about permission laundering, which the human never needs to read)
 *
 * Two things make it fall through `classifyPrompt`: the `Another Claude session
 * sent a message:` PREFIX (so the leading tag is not the wrapper), and the fact
 * that the `<teammate-message>` blocks carry a JSON PROTOCOL payload
 * (`type: idle_notification | teammate_terminated | shutdown_approved | …`)
 * rather than the prose the single-block teammate arm already understands.
 *
 * This module is the missing parser: pure, dependency-free (only `sanitiseText`
 * from its sibling), and unit-tested block by block. It:
 *
 *   · DETECTS a cross-session wrapper — the prefix, and/or ≥1 protocol block.
 *   · EXTRACTS each `<teammate-message>` block into a `CoordinationBlock`
 *     ({teammateId, color, type, payload} | {…, plainText}). Everything OUTSIDE
 *     the blocks — the prefix and the agent-only guidance suffix — is simply not
 *     read, which is the `stripConfirmFooter` idea in its most literal form: the
 *     human's transcript keeps the event, never the machine's guidance.
 *   · MAPS each protocol type to a calm human line (`coordinationEvent`),
 *     reusing the surface's own event vocabulary. An UNKNOWN type degrades to a
 *     safe `<teammate> · <type>` chip — never raw JSON.
 *
 * A block with no protocol payload (a plain-prose teammate message that merely
 * arrived wrapped) is returned as a `plainText` block, so the caller can keep
 * TODAY's behaviour and route it through the existing teammate arm.
 */
import { sanitiseText } from './wire-entries'

/**
 * The harness prefix Claude Code injects when it delivers a teammate message
 * into this session. Anchored to the start and case-insensitive — the one line
 * that turns a bare `<teammate-message>` into the multi-block wrapper the report
 * is about. Its presence is sufficient (but not necessary — a protocol payload
 * is the other trigger) to treat the message as coordination.
 */
const CROSS_SESSION_PREFIX = /^another claude session sent a message:/i

/** One `<teammate-message …>…</teammate-message>` block. Global + non-greedy so
 *  a multi-block wrapper yields every block in order. Group 1 is the attribute
 *  chunk, group 2 the inner payload. */
const TEAMMATE_BLOCK_RE = /<teammate-message(\s[^>]*)?>([\s\S]*?)<\/teammate-message>/g

/** `attr="value"` / `attr='value'` inside a tag's attribute chunk — both quote
 *  styles, the same contract `wire-entries.ts::attrValue` keeps with the writer. */
function attrValue(attrs: string, attr: string): string | undefined {
  const m = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  if (!m) return undefined
  const v = m[1] ?? m[2]
  return v ? v : undefined
}

/** A trimmed non-empty string field, or undefined — the defensive read every
 *  payload field gets (the JSON is another process's output, not a contract). */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** `inner` as a JSON OBJECT, or undefined. A protocol block is `{type, …}`; a
 *  plain teammate message is prose (or a JSON array / scalar, which is not a
 *  protocol and stays prose). */
function parseJsonObject(inner: string): Record<string, unknown> | undefined {
  const t = inner.trim()
  if (!t.startsWith('{')) return undefined
  try {
    const v = JSON.parse(t)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export type CoordinationTone = 'teammate' | 'system' | 'quiet'

/** One extracted `<teammate-message>` block. A protocol block carries `type` +
 *  `payload`; a plain-prose block carries `plainText` instead (and the caller
 *  routes it through the existing teammate arm, unchanged). */
export interface CoordinationBlock {
  teammateId?: string
  color?: string
  /** The protocol discriminator, when the block's inner was a JSON object. */
  type?: string
  /** The parsed JSON payload, when present. */
  payload?: Record<string, unknown>
  /** A no-protocol teammate message's prose — set INSTEAD of type/payload. */
  plainText?: string
}

/** A protocol block, mapped to what the renderer draws. */
export interface CoordinationEvent {
  /** The calm human line. Never raw JSON. */
  text: string
  /** The subject teammate's slug — the face seed + its pigment. Absent means no
   *  face (the anonymous "system" sender that carries no identity). */
  seed?: string
  tone: CoordinationTone
}

/**
 * A user-role message → its coordination blocks, or `null` when it is not a
 * cross-session wrapper.
 *
 * Returns `null` (leave it to `classifyPrompt`) unless there is at least one
 * `<teammate-message>` block AND either the harness prefix or a real protocol
 * payload is present — so a lone plain-prose teammate message (`<teammate-message
 * teammate_id="patch">on it</teammate-message>`) stays on today's teammate arm
 * exactly as before.
 */
export function parseCoordination(raw: string): CoordinationBlock[] | null {
  const trimmed = raw.trim()
  const blocks: CoordinationBlock[] = []
  let anyProtocol = false
  TEAMMATE_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEAMMATE_BLOCK_RE.exec(trimmed)) !== null) {
    const attrs = m[1] ?? ''
    const inner = m[2] ?? ''
    const teammateId = attrValue(attrs, 'teammate_id')
    const color = attrValue(attrs, 'color')
    const payload = parseJsonObject(inner)
    const type = payload ? str(payload.type) : undefined
    if (type) {
      anyProtocol = true
      blocks.push({ teammateId, color, type, payload })
    } else if (payload) {
      // A JSON payload is protocol data, never human prose — so even one that
      // is missing a `type` (unexpected, but never a text message) rides the
      // safe chip as an 'update' rather than leaking raw JSON into a bubble.
      anyProtocol = true
      blocks.push({ teammateId, color, type: 'update', payload })
    } else {
      blocks.push({ teammateId, color, plainText: sanitiseText(inner) })
    }
  }
  if (blocks.length === 0) return null
  // Only a genuine cross-session wrapper is intercepted. The prefix is one
  // trigger; a protocol payload is the other (a single JSON block delivered
  // without the prefix is still coordination, not prose). A bare plain-prose
  // teammate block with neither is NOT ours — the existing teammate arm owns it.
  if (!CROSS_SESSION_PREFIX.test(trimmed) && !anyProtocol) return null
  return blocks
}

/**
 * `has shut down` / `X has shut down.` → the leading slug, so a
 * `teammate_terminated` whose envelope is anonymous (`teammate_id="system"`,
 * no `from`) can still name the session that went away and hang its face.
 */
function slugFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined
  const m = /^(\S+)\s+has shut down/i.exec(message.trim())
  return m ? m[1] : undefined
}

/**
 * A protocol block → the calm line the renderer draws, in the surface's own
 * event vocabulary. The mapping is the whole product decision:
 *
 *   idle_notification   → "<teammate> is available" / "<teammate> went idle",
 *                         teammate face + its pigment.
 *   teammate_terminated → "<teammate> shut down", system-toned. The subject is
 *                         `from`, or parsed out of the `message` (the envelope
 *                         is often the anonymous `system` sender).
 *   shutdown_approved   → "<teammate> approved shutdown", quiet.
 *   anything else       → a safe "<teammate> · <type>" chip. NEVER raw JSON — a
 *                         protocol type this build has never seen still reads as
 *                         a calm event rather than leaking a payload into chat.
 */
export function coordinationEvent(block: CoordinationBlock): CoordinationEvent {
  const p = block.payload ?? {}
  const from = str(p.from)
  // The named sender: `from` when the payload carries it, else the envelope's
  // `teammate_id` — but never the anonymous `system` sender, which has no face.
  const who =
    from ?? (block.teammateId && block.teammateId !== 'system' ? block.teammateId : undefined)
  switch (block.type) {
    case 'idle_notification': {
      const verb = str(p.idleReason) === 'available' ? 'is available' : 'went idle'
      return { text: `${who ?? 'A teammate'} ${verb}`, seed: who, tone: 'teammate' }
    }
    case 'teammate_terminated': {
      const subject = from ?? slugFromMessage(str(p.message))
      if (subject) return { text: `${subject} shut down`, seed: subject, tone: 'system' }
      // No name anywhere — the payload's own sentence is already calm ("… has
      // shut down."), so it stands in rather than a faceless "A teammate".
      return { text: str(p.message) ?? 'A teammate shut down', tone: 'system' }
    }
    case 'shutdown_approved':
      return { text: `${who ?? 'A teammate'} approved shutdown`, seed: who, tone: 'quiet' }
    default:
      // An unknown protocol type: name it, quietly, and never draw the JSON.
      return { text: `${who ?? 'A teammate'} · ${block.type ?? 'update'}`, seed: who, tone: 'quiet' }
  }
}
