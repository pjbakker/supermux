/**
 * `teamTier` — the folded roster's truth table (OD-2), and the two header count
 * formulas, all pure (no DOM). If a crew that needs you does not land in `needs`,
 * or the header can count a row nobody renders, it is caught HERE, not in a
 * screenshot.
 */
import { describe, expect, test } from 'bun:test'

import {
  groupOf,
  groupSessions,
  groupTeamsByTier,
  rosteredTeams,
  stateWordFor,
  teamTier,
  totalBotCount,
  type LeadSignal,
} from '../../src/lib/team-attention'
import type { ApiSession } from '../../src/lib/api'
import type { MemberStatus, Team, TeamMember } from '../../src/lib/api/teams'

let seq = 0
function member(status: MemberStatus): TeamMember {
  const name = `m${seq++}`
  return {
    name,
    agent_id: `${name}@t`,
    model: 'claude-sonnet-4',
    color: '',
    tmux_pane_id: '%1',
    is_active: true,
    status,
  }
}

function task(status: string): Team['tasks'][number] {
  return { id: `${seq++}`, subject: 's', description: '', status, assigned_to: '', blocks: [], blocked_by: [] }
}

function team(over: Partial<Team> = {}): Team {
  return {
    team_name: over.team_name ?? `team-${seq++}`,
    lead_session: 'lead',
    lead_supermux_session: over.lead_supermux_session ?? 'supermux-lead',
    members: over.members ?? [member('idle')],
    tasks: over.tasks ?? [],
    ...over,
  }
}

describe('teamTier — the derived attention tier', () => {
  test('a member that needs you ⇒ needs, whatever else is true', () => {
    const t = team({ members: [member('needs_you'), member('working')], tasks: [task('completed')] })
    expect(teamTier(t, null)).toBe('needs')
    // even with an active/needs lead it stays needs — needs is the top tier.
    expect(teamTier(t, { needs: false, active: true })).toBe('needs')
  })

  test('the LEAD needing you ⇒ needs, even with a calm crew', () => {
    const t = team({ members: [member('idle'), member('offline')] })
    expect(teamTier(t, { needs: true, active: false })).toBe('needs')
  })

  test('a working member (no needs) ⇒ active', () => {
    const t = team({ members: [member('working'), member('idle')] })
    expect(teamTier(t, null)).toBe('active')
  })

  test('an active LEAD (no needs, no working member) ⇒ active', () => {
    const t = team({ members: [member('idle'), member('offline')] })
    expect(teamTier(t, { needs: false, active: true })).toBe('active')
  })

  test('every task completed and nobody working ⇒ done', () => {
    const t = team({
      members: [member('idle'), member('offline')],
      tasks: [task('completed'), task('completed')],
    })
    expect(teamTier(t, null)).toBe('done')
    expect(teamTier(t, { needs: false, active: false })).toBe('done')
  })

  test('a working member outranks all-tasks-done (active wins)', () => {
    const t = team({
      members: [member('working')],
      tasks: [task('completed'), task('completed')],
    })
    expect(teamTier(t, null)).toBe('active')
  })

  test('calm, no tasks ⇒ idle', () => {
    const t = team({ members: [member('idle'), member('offline')], tasks: [] })
    expect(teamTier(t, null)).toBe('idle')
  })

  test('tasks pending but nobody working and nothing needs you ⇒ idle (not done)', () => {
    const t = team({ members: [member('idle')], tasks: [task('completed'), task('pending')] })
    expect(teamTier(t, null)).toBe('idle')
  })
})

describe('the count formulas', () => {
  test('rosteredTeams drops a crewless team', () => {
    const rostered = team()
    const solo = team({ team_name: 'solo', members: [] })
    expect(rosteredTeams([rostered, solo]).map((t) => t.team_name)).toEqual([rostered.team_name])
  })

  test('totalBotCount = sessions + each rostered team’s members + its mapped lead', () => {
    const a = team({ members: [member('idle'), member('working')] }) // 2 + lead
    const b = team({ members: [member('idle')], lead_supermux_session: null }) // 1 + no lead
    const solo = team({ team_name: 'solo', members: [] }) // ignored
    // 3 sessions + (2+1) + (1+0) = 7
    expect(totalBotCount(3, [a, b, solo])).toBe(7)
  })

  test('no crews ⇒ totalBotCount is just the session count', () => {
    expect(totalBotCount(4, [])).toBe(4)
  })

  test('groupTeamsByTier buckets rostered teams only, by tier', () => {
    const needs = team({ team_name: 'n', members: [member('needs_you')] })
    const active = team({ team_name: 'a', members: [member('working')] })
    const solo = team({ team_name: 'solo', members: [] })
    const g = groupTeamsByTier([needs, active, solo], (): LeadSignal | null => null)
    expect(g.needs.map((t) => t.team_name)).toEqual(['n'])
    expect(g.active.map((t) => t.team_name)).toEqual(['a'])
    // the crewless team is in no bucket at all.
    expect([...g.needs, ...g.active, ...g.done, ...g.idle].map((t) => t.team_name)).not.toContain(
      'solo',
    )
  })
})

/**
 * ONE state, ONE word.
 * ─────────────────────────────────────────────────────────────────────────────
 * The roster row printed the product's vocabulary (`done` / `working` / `needs
 * you`) while the bot panel it opens printed `session.status` capitalised
 * (`Idle` / `Active`) — the two side by side on the same desktop screen, saying
 * the same fact in two words. `stateWordFor` is now the single renderer of it,
 * and `groupOf` is the per-session bucketing the panel needs because it holds
 * one bot and has no roster to group.
 */
describe('the state word', () => {
  const NOW = 1_800_000_000_000
  const bot = (over: Partial<ApiSession> = {}): ApiSession =>
    ({
      name: 'mena',
      status: 'idle',
      dir: '',
      provider: 'claude',
      preview_lines: [],
      updated_at: new Date(NOW).toISOString(),
      ...over,
    }) as ApiSession

  test('groupOf agrees with groupSessions, row for row', () => {
    const rows = [
      bot({ name: 'a', status: 'waiting' }),
      bot({ name: 'b', status: 'active' }),
      bot({ name: 'c', status: 'idle' }),
      bot({ name: 'd', status: 'stopped' }),
      bot({ name: 'e', status: 'idle', subagents_live: true }),
    ]
    const needNames = new Set(['a'])
    const grouped = groupSessions(rows, needNames, NOW)
    for (const key of ['needs', 'active', 'done', 'idle'] as const) {
      for (const s of grouped[key]) {
        expect(groupOf(s, needNames.has(s.name), NOW)).toBe(key)
      }
    }
  })

  test('an idle bot touched today is "done", not "idle" — the panel’s old lie', () => {
    const s = bot({ status: 'idle' })
    expect(stateWordFor(s, groupOf(s, false, NOW)).word).toBe('done')
  })

  test('an active bot is "working", and its agents clause is a SEPARATE field', () => {
    // Separate because the bot panel renders the word beside an `<ActivityLine>`
    // that already draws the same clause from the same `agents_live`.
    const s = bot({ status: 'active', agents_live: 3 })
    const sw = stateWordFor(s, groupOf(s, false, NOW))
    expect(sw.word).toBe('working')
    expect(sw.agents).toBe(' · 3 agents')
  })

  test('the needs bucket says "needs you", and a blocked one says "blocked"', () => {
    const waiting = bot({ status: 'waiting' })
    expect(stateWordFor(waiting, groupOf(waiting, true, NOW)).word).toBe('needs you')
    const blocked = bot({ status: 'idle', blocked: { reason: 'limit' } } as Partial<ApiSession>)
    expect(stateWordFor(blocked, groupOf(blocked, true, NOW)).word).toBe('blocked')
  })

  test('no word is ever a raw status enum', () => {
    for (const status of ['idle', 'active', 'starting', 'stopped', 'waiting'] as const) {
      const s = bot({ status })
      const sw = stateWordFor(s, groupOf(s, status === 'waiting', NOW))
      expect(['done', 'working', 'needs you', 'blocked', 'stopped', 'idle']).toContain(sw.word)
    }
  })
})
