// The Spaces landing's DATA — pure, so the landing's honesty rules are
// executable rather than eyeballed (files v1 spec §4.1).
//
// `/files` with no `?path=` is not a directory: it is the question "whose
// drive?". HQ plus one card per live company, each card carrying a bot count
// and — only when we have actually observed one — a live activity line.
//
// Everything here is a pure function over data the app already holds
// (`useCompanies`, `useSessions`, the files-activity store, the projects list).
// No fetch, no DOM.

import type { Company } from '@/lib/companies'
import {
  activityKey,
  type FilesActivity,
} from '@/stores/files-activity-store'

/** One card on the grid. `id === null` is HQ. */
export interface SpaceCard {
  /** Stable React key + activity-store key: `'hq'` or the company id. */
  key: string
  kind: 'hq' | 'company'
  /** Company id, or null for HQ — this is what `setActiveCompany` receives. */
  id: number | null
  /** Hue seed for `<CompanyMark>`. Empty for HQ (which uses `<HqMark>`). */
  slug: string
  name: string
  /** Bots living in this space. HQ's are the sessions with no company. */
  bots: number
  /** Where tapping the card navigates. HQ has no single root — the route
   *  renders its projects list instead — so it is null. */
  path: string | null
  /** The live line, or null. NEVER synthesised: see `spaceCards` below. */
  activity: FilesActivity | null
}

/** Anything with a nullable company id — `ApiSession` structurally, but kept
 *  generic so the tests can pass plain objects. */
export interface HasCompany {
  company_id?: number | null
}

/**
 * Build the grid.
 *
 * Bot counts are client-side over the live session list, HQ's being the
 * `company_id == null` sessions. Archived companies never appear because
 * `GET /api/companies` already excludes them — this function does not re-filter
 * (a second, divergent definition of "live" is how the two drift apart), but it
 * does skip a company with no `root_dir`, which would otherwise render a card
 * that navigates nowhere.
 *
 * THE HONESTY RULE, and the reason this is a function and not JSX: the activity
 * line renders ONLY for a space we have observed a `files` frame for in THIS
 * session. There is no `idle · 3d` fallback, because nothing on the server
 * persists a last-write timestamp per company and deriving one from the root's
 * `/api/ls` mtime would be a number that does not mean what it says (a root's
 * mtime moves when a direct child is created, not when a bot edits three levels
 * down). Absent activity the caller renders an em dash. A real recency signal
 * is a v2 item with a v2 cost.
 */
export function spaceCards(
  companies: readonly Company[],
  sessions: readonly HasCompany[],
  activity: Readonly<Record<string, FilesActivity>>,
  opts: { includeHq: boolean },
): SpaceCard[] {
  const count = (id: number | null) =>
    sessions.filter((s) => (s.company_id ?? null) === id).length

  const cards: SpaceCard[] = []
  if (opts.includeHq) {
    cards.push({
      key: activityKey(null),
      kind: 'hq',
      id: null,
      slug: '',
      name: 'HQ',
      bots: count(null),
      path: null,
      activity: activity[activityKey(null)] ?? null,
    })
  }
  for (const c of companies) {
    if (!c.root_dir) continue
    cards.push({
      key: activityKey(c.id),
      kind: 'company',
      id: c.id,
      slug: c.slug,
      name: c.display_name,
      bots: count(c.id),
      path: c.root_dir,
      activity: activity[activityKey(c.id)] ?? null,
    })
  }
  return cards
}

/**
 * The company root to route to INSTEAD of rendering the grid, or null to render
 * it. A one-card chooser is condescending.
 *
 * The condition is exactly what this client can OBSERVE, and the comment says
 * so rather than claiming to know the caller's scope: the browser has no
 * `whoami`, so "is this a scoped member?" is not a question it can ask. What it
 * can see is that the server showed it exactly one company AND an empty
 * `/api/projects/repos` — which is precisely what a scoped member gets
 * (`member_may_reach` excludes that route on purpose, and the handler returns an
 * empty list to a scoped human).
 *
 * The same condition is also correct for an OWNER who happens to match it: with
 * no `SUPERMUX_PROJECT_DIRS` configured, HQ's landing content is empty, so a
 * grid offering "HQ (nothing here)" and one company is a worse door than the
 * company itself. Either way HQ stays one tap away in the space crumb — this
 * chooses a landing, it does not remove a space.
 */
export function spacesSkipTarget(
  companies: readonly Company[],
  projectCount: number,
): string | null {
  if (projectCount > 0) return null
  const live = companies.filter((c) => !!c.root_dir)
  if (live.length !== 1) return null
  return live[0]!.root_dir
}

/** The one-line summary under a card's name: `"4 bots"` / `"1 bot"` / `"—"`.
 *  Zero renders as the em dash rather than "0 bots" — an empty space is a fact
 *  about the space, not a quantity worth spelling out at 12px. */
export function botLine(bots: number): string {
  if (bots <= 0) return '—'
  return `${bots} bot${bots === 1 ? '' : 's'}`
}

/** The basename an activity line shows. Server paths are already
 *  canonicalized, so a lexical split is exact. */
export function activityName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}
