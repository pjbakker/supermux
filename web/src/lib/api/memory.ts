// Bot-memory client — the ARCHIVAL (learned-notes) surface.
//
// The CORE notes (`sessions.memory`, the capped always-injected set) already
// round-trip via the session-config PATCH. This module reads the ARCHIVAL store:
// the plain-Markdown notes the bot writes itself with the `supermux-memory` CLI
// and recalls a handful of per turn. Server side is `sessions::memory`.
//
// READ-ONLY by design. The bot writes its own notes; the owner browses them.
// There is deliberately no create/edit/delete route to call.
//
// Two tiers are unioned server-side exactly as recall unions them — the bot's
// private `bot` tier and its role's shared `role` tier, private winning a slug
// collision — and `searchNotes` ranks with the very scorer the recall hook uses,
// so what this panel shows IS what the bot would recall.

import { settingsRequest, ApiError } from './client'

/** Note types (mirror the store's `NoteType`). */
export type NoteType = 'reference' | 'feedback' | 'decision' | 'bugfix' | string

/** Which tier a note lives in: private to this bot, or shared across its role. */
export type NoteTier = 'bot' | 'role'

/** One row of the browsable list — enough to render without fetching the body. */
export interface LearnedNote {
  /** Filename stem; the id `getNote` takes. */
  slug: string
  /** The one-line gist (frontmatter `description`) — the note's headline. */
  description: string
  tier: NoteTier
  note_type: NoteType
  /** RFC3339; empty on a hand-authored note that omitted the stamp. */
  modified: string
  /** Whitespace-collapsed first ~200 chars of the body. */
  snippet: string
  /** Recall score — search results only. */
  score?: number
}

/** One note in full, for the expanded read view. */
export interface LearnedNoteDetail {
  slug: string
  description: string
  tier: NoteTier
  note_type: NoteType
  modified: string
  /** Raw Markdown (Why / How-to-apply / `[[links]]`). */
  body: string
}

/** What the route sends. */
interface NotesPayload {
  notes: LearnedNote[]
  bot_count: number
  role_count: number
  /** The role key whose shared tier was unioned in; empty for a private-only bot. */
  role: string
  /** `false` ⇒ this bot cannot write or recall a note right now. SERVER-SENT:
   *  it reports whether the recall hook is actually in the session's launch
   *  overlay, not whether the route answered.
   *
   *  Reading a `200` as "wired" was the bug. The route's gate is ELIGIBILITY
   *  (`session_has_memory` — a company or a role sentence is enough), and the
   *  hook is wired at LAUNCH, so every bot that gained a role since its last
   *  start answers 200 while having no hook, no `Bash(supermux-memory *)` grant
   *  and no store. The panel told exactly those bots they simply hadn't written
   *  anything yet. */
  wired: boolean
}

/** What this module hands the panel: the payload plus whether the route answered
 *  at all.
 *
 *  Both unwired shapes need a restart before the bot can write, but only ONE of
 *  them can be restarted INTO memory. A `200` with `wired: false` is the common
 *  eligible-but-not-yet-restarted bot — restart it and the hook lands. A `404`
 *  is a session that is not a bot at all (no company, no role, no core notes):
 *  `session_has_memory` stays false, so restarting it changes nothing and the
 *  panel must ask for a role or a company FIRST. Only this module can tell the
 *  two apart, so it says which it saw instead of flattening both into `wired`. */
export interface NotesResponse extends NotesPayload {
  /** `false` ⇒ the route 404'd: this session is not a bot yet. */
  eligible: boolean
}

const EMPTY: NotesResponse = {
  notes: [],
  bot_count: 0,
  role_count: 0,
  role: '',
  wired: false,
  eligible: false,
}

/** A `404` here means "this session is not a bot" (no company, no role, no core
 *  notes, no store) — the tier is off, not broken, so it is not an error to
 *  surface. It comes back `wired: false` AND `eligible: false`; see
 *  [`NotesResponse`] for why the panel needs both bits. Anything else
 *  propagates. */
function emptyOn404(e: unknown): NotesResponse {
  if (e instanceof ApiError && e.status === 404) return EMPTY
  throw e
}

const base = (name: string) => `/api/sessions/${encodeURIComponent(name)}/memory`

/** `GET /api/sessions/{name}/memory/notes` — every note this bot can see
 *  (private ∪ role), freshest first. */
export async function listNotes(name: string): Promise<NotesResponse> {
  try {
    return { ...(await settingsRequest<NotesPayload>(`${base(name)}/notes`)), eligible: true }
  } catch (e) {
    return emptyOn404(e)
  }
}

/** `GET /api/sessions/{name}/memory/search?q=` — the recall scorer's ranking.
 *  An empty `q` returns the freshness baseline rather than nothing. */
export async function searchNotes(
  name: string,
  q: string,
  limit?: number,
): Promise<NotesResponse> {
  const params = new URLSearchParams({ q })
  if (limit) params.set('limit', String(limit))
  try {
    return {
      ...(await settingsRequest<NotesPayload>(`${base(name)}/search?${params}`)),
      eligible: true,
    }
  } catch (e) {
    return emptyOn404(e)
  }
}

/** `GET /api/sessions/{name}/memory/notes/{slug}` — one note's full Markdown.
 *  `tier` pins which copy to read; omitted, the private one wins. */
export async function getNote(
  name: string,
  slug: string,
  tier?: NoteTier,
): Promise<LearnedNoteDetail> {
  const qs = tier ? `?tier=${tier}` : ''
  return settingsRequest<LearnedNoteDetail>(
    `${base(name)}/notes/${encodeURIComponent(slug)}${qs}`,
  )
}
