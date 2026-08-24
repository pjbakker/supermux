// Files activity — the Spaces landing's live line, and the ONE honesty rule
// that keeps it from lying.
//
// Each card on the Spaces grid can show a third line: "✎ report.md · now". It
// is driven exclusively by `files` SSE frames OBSERVED IN THIS SESSION (files
// v1 spec §4.1) and it is deliberately NOT persisted.
//
// Why nothing is invented for the empty case: the server persists no
// last-write timestamp per company, and deriving one from a shallow `/api/ls`
// mtime of the company root would be a number that does not mean what it says
// (a root mtime moves when a direct child is created, not when a bot edits
// three levels down). So a space we have observed nothing for renders `—`, and
// there is no "idle · 3d". A real recency signal is a v2 item with a v2 cost.
//
// Keyed by company id, with the string `'hq'` for the unstamped (HQ) space —
// a Map key of `null` reads badly in a zustand record, and `'hq'` is what the
// grid asks for anyway.

import { create } from 'zustand'

/** The HQ bucket's key. HQ frames arrive unstamped (owner/admin only). */
export const HQ_ACTIVITY_KEY = 'hq'

export interface FilesActivity {
  /** Epoch ms the frame was OBSERVED (client clock — it is only ever rendered
   *  as a relative "now / 2m" against the same clock). */
  at: number
  /** Absolute path of the affected entry. The card renders its basename. */
  path: string
  /** The op from the frame (`write` / `mkdir` / `rename` / …). */
  op: string
  /** Attributed session name, or null for a human-initiated verb. */
  session: string | null
}

interface FilesActivityState {
  /** `companyId` (number key) or `'hq'` → the most recent observed activity. */
  bySpace: Record<string, FilesActivity>
  record: (key: string, activity: FilesActivity) => void
  clear: () => void
}

export const useFilesActivityStore = create<FilesActivityState>()((set) => ({
  bySpace: {},
  // LAST WRITE WINS on purpose: the line is "what happened most recently here",
  // not a feed. A same-key overwrite is one shallow record copy per frame.
  record: (key, activity) =>
    set((s) => ({ bySpace: { ...s.bySpace, [key]: activity } })),
  clear: () => set({ bySpace: {} }),
}))

/** The store key for a company id — `'hq'` for the unstamped space. Exported so
 *  the recorder and the grid cannot disagree about the key. */
export function activityKey(companyId: number | null): string {
  return companyId === null ? HQ_ACTIVITY_KEY : String(companyId)
}

/** "now" / "2m" / "3h" / "5d" — the compact relative stamp the card's live line
 *  uses. Under a minute reads `now`, because the line exists to say "a bot just
 *  touched this space" and "12s" is noise at that size. Pure + unit-tested. */
export function relativeStamp(at: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - at) / 1000))
  if (secs < 60) return 'now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
