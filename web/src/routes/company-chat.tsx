/**
 * `<CompanyChat>` — the full-bleed `/company/:companyId/chat` destination.
 * ─────────────────────────────────────────────────────────────────────────────
 * The company group chat, given the WHOLE screen. The overview only carries a
 * compact `<GroupChatEntry>` doorway now; tapping it lands here, where the
 * channel is finally a page and not a peek — a real channel that has room to
 * feel better than the embedded hero ever could.
 *
 * Both phone and desktop route here (the channel wants the screen; a bottom
 * pane cramps it). `<Layout>` treats `/company/*` as chromeless — no top bar, no
 * bottom nav, `<main>` `overflow-hidden` — so this route paints the whole window
 * and the channel's own flex chain fills and scrolls internally.
 *
 * Bot mode OFF, or a company with no channel (its Router never existed), or an
 * unknown id ⇒ redirect to `/`. The channel is not a surface the base app has.
 */
import * as React from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'

import { useUI } from '@/stores/ui-store'
import { botModeOn, BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { GROK_KILL_SWITCH_KEY } from '@/lib/grok-mode-flag'
import { useCompanies } from '@/hooks/use-companies'
import { useSessions } from '@/hooks/use-sessions'
import { useKeyboardRootResize } from '@/hooks/use-keyboard-viewport'
import { agentHueVars } from '@/lib/grok-agent-hue'
import { markStateForSession } from '@/lib/mark-status'
import { characterFromSeed } from '@/brand/marks'
import { useTheme } from '@/components/theme-provider'
import { BackIcon } from '@/components/chat/ui'
import { ChatChannel } from '@/components/chat/group-chat/channel'
import { useCompanyChannel } from '@/components/chat/group-chat/use-company-channel'
import { useMediaQuery } from '@/hooks/use-media-query'

function ls(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
}

export function CompanyChat() {
  const { companyId = '' } = useParams()
  const id = Number(companyId)
  const navigate = useNavigate()
  const isPhone = useMediaQuery('(max-width: 767px)')
  const { resolvedTheme } = useTheme()
  // Inherit the SAME iOS keyboard machinery the 1:1 chat fought hard for (the
  // "mode 9" root-resize, packaged as this hook and already reused by the browser
  // takeover panel). Without it the full-bleed channel's composer gets covered by
  // the keyboard and the whole app scrolls up, re-exposing the home-indicator
  // black band. Self-guards on `visualViewport`, so desktop is untouched.
  useKeyboardRootResize(isPhone)

  // Read the skin ONCE (a skin flip is a reload-level change).
  const [grok] = React.useState(() =>
    botModeOn(useUI.getState().botMode, ls(BOT_KILL_SWITCH_KEY), ls(GROK_KILL_SWITCH_KEY)),
  )

  const { companies, isLoading: companiesLoading } = useCompanies()
  const { sessions, isLoading: sessionsLoading } = useSessions()

  const company = React.useMemo(
    () => companies.find((c) => c.id === id) ?? null,
    [companies, id],
  )
  const companySessions = React.useMemo(
    () => sessions.filter((s) => s.company_id === id),
    [sessions, id],
  )

  const channel = useCompanyChannel(company, companySessions)

  const goHome = React.useCallback(() => navigate('/'), [navigate])

  // Base app (bot mode off) or a bad id ⇒ never render the channel.
  if (!grok || Number.isNaN(id)) return <Navigate to="/" replace />

  // Wait for the roster before deciding a company "has no channel" — otherwise a
  // hard reload onto this URL would bounce to `/` before the data has landed.
  const stillLoading = companiesLoading || sessionsLoading
  if (!stillLoading && (!company || !channel.enabled)) {
    return <Navigate to="/" replace />
  }

  // Company hue scope so the composer's focus ring is the company's colour.
  const hue = company
    ? (agentHueVars(characterFromSeed(company.slug).hue, resolvedTheme === 'dark') as React.CSSProperties)
    : undefined

  return (
    <div className="flex h-full w-full flex-col" style={hue}>
      {company && channel.enabled ? (
        <ChatChannel
          company={company}
          members={channel.members}
          rows={channel.feed.rows}
          loading={channel.feed.isLoading}
          error={channel.feed.isError}
          hasMore={channel.feed.hasMore}
          loadingMore={channel.feed.loadingMore}
          onLoadMore={channel.feed.loadMore}
          unread={channel.feed.unread}
          firstUnreadSeq={channel.feed.firstUnreadSeq}
          onSeenBottom={channel.feed.markRead}
          onSend={channel.send}
          routerLabel={channel.routerLabel}
          // The Router's REAL session status drives the "is routing…" row (the
          // same 'working' signal the roster and the 1:1 chat trust), so a human
          // who just posted sees the assistant thinking, not silence.
          routerWorking={channel.router ? markStateForSession(channel.router) === 'working' : false}
          routerSeed={channel.router?.name}
          surface={isPhone ? 'phone' : 'desktop'}
          // The page, not a hero: no feed cap — the scroller grows to fill the
          // whole window (the channel's own flex chain owns the height).
          feedMaxHeight="none"
          className="min-h-0 flex-1 pt-[env(safe-area-inset-top)]"
          headerLeading={
            <button
              type="button"
              aria-label="Back to bots"
              onClick={goHome}
              className="grid size-[34px] flex-none place-items-center rounded-full bg-fill-soft text-ink-2 active:bg-fill-soft-2"
            >
              <BackIcon />
            </button>
          }
        />
      ) : (
        // Loading the roster — a calm full-window ground, no flash of "empty".
        <div className="h-full w-full" style={{ background: 'var(--gr-surf)' }} />
      )}
    </div>
  )
}

export default CompanyChat
