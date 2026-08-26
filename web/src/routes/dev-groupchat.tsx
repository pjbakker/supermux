// /dev/groupchat — the offline bench for the Company Group Chat channel.
//
// DEV-only + lazy (`App.tsx`), mounted outside <Layout> like every other
// /dev/* bench, so neither the route nor its cast can reach the production
// bundle and the page is pure surface: no nav, no shell, nothing but the
// channel on paper.
//
// WHAT IT IS FOR. The channel's whole risk is horizontal: a 390–402px column
// holding a face, a bold name, a kind chip, a timestamp, `@mention` chips and
// prose that may contain a path. This page renders it at exactly the widths a
// phone has, with every message kind present, so a headless rig can prove there
// is no x-overflow before any of it is wired to a socket.
//
//   ?w=390|402|full   the artboard width (default 402 — the iPhone 16 Pro one)
//   ?empty=1          the honest empty state (what a fresh company really shows)
//   ?feed=hero        clamp the feed to the hero's real 300px ceiling (default
//                     is `all`, which lets every row show in one screenshot)
//   ?send=off         read-only composer (a company with no Main Assistant)
//   ?loading=1        the pre-seed state — no rows AND no "nothing here" claim
//
// The composer here is REAL: typing `@` opens the member picker, and Send runs
// a fake 400ms delivery that appends the row the server would have written. The
// only thing the bench stubs is the socket.
//
// Deliberate rules, inherited from /dev/roster:
//   · the cast is DATA (`dev-groupchat.fixture.ts`) and its timestamps are
//     fixed, so a screenshot is deterministic.
//   · nothing here fetches. The channel is presentational; the groupchat WS
//     lands in the follow-up (spec §8 steps 1–2, 8).
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'

import { ChatChannel } from '@/components/chat/group-chat'
import type { GroupChatRow } from '@/components/chat/group-chat'

import { CANARY, CANARY_MEMBERS, CANARY_OLDER, CANARY_ROWS } from './dev-groupchat.fixture'

const WIDTHS: Record<string, number | null> = { '390': 390, '402': 402, full: null }

export default function DevGroupChat() {
  const [params] = useSearchParams()
  const widthKey = params.get('w') ?? '402'
  const width = widthKey in WIDTHS ? WIDTHS[widthKey] : 402
  const empty = params.get('empty') === '1'
  // A review needs to SEE all five message kinds; the hero's real ceiling is the
  // other thing worth looking at. Both, on one URL.
  const hero = params.get('feed') === 'hero'
  const canSend = params.get('send') !== 'off'
  const loading = params.get('loading') === '1'

  // The offline data plane: the fixture, plus whatever the composer "sent" and
  // whatever "Earlier messages" paged in. Enough to drive every affordance the
  // live hero has, with no server behind it.
  const [sent, setSent] = React.useState<GroupChatRow[]>([])
  const [older, setOlder] = React.useState<GroupChatRow[]>([])
  const [loadingMore, setLoadingMore] = React.useState(false)

  const rows = React.useMemo(
    () => (empty || loading ? [] : [...older, ...CANARY_ROWS, ...sent]),
    [empty, loading, older, sent],
  )

  const onSend = React.useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          setSent((prev) => [
            ...prev,
            {
              seq: 1000 + prev.length,
              // Fixed, not `Date.now()`: a bench you screenshot is deterministic.
              ts: CANARY_ROWS[CANARY_ROWS.length - 1]!.ts + 60 * (prev.length + 1),
              kind: 'request',
              authorKind: 'human',
              authorSeed: 'user-sander',
              authorName: 'Sander',
              body: text,
            },
          ])
          resolve()
        }, 400)
      }),
    [],
  )

  const onLoadMore = React.useCallback(() => {
    setLoadingMore(true)
    setTimeout(() => {
      setOlder(CANARY_OLDER)
      setLoadingMore(false)
    }, 400)
  }, [])

  return (
    // `relative z-10`: with `?grok=1` the bench sits inside `[data-grok-root]`,
    // whose `::before` paints the glass substrate at z-index 0 over any in-flow
    // child. The shell lifts its own columns with `[data-shell-main]`; a bench
    // has no shell, so it lifts itself. Inert without the skin.
    <div className="relative z-10 min-h-dvh bg-paper">
      <header className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-2">
        /dev/groupchat · {width ? `${width}px` : 'full'} · {empty ? 'empty' : 'populated'} ·{' '}
        {hero ? 'hero-height' : 'full feed'}
      </header>
      <div
        // The artboard. `mx-auto` + an explicit width is the phone; `full` lets
        // the channel take the window so the desktop composition is reviewable
        // on the same page.
        style={width ? { width, maxWidth: '100%' } : undefined}
        className="mx-auto overflow-hidden"
      >
        <ChatChannel
          company={CANARY}
          members={CANARY_MEMBERS}
          rows={rows}
          loading={loading}
          hasMore={!empty && !loading && older.length === 0}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
          unread={empty || loading ? 0 : 2}
          onSend={canSend ? onSend : undefined}
          routerLabel={canSend ? 'Main Assistant' : undefined}
          composerNote={
            canSend ? undefined : 'Group chat isn’t enabled for this company.'
          }
          surface={width ? 'phone' : 'desktop'}
          feedMaxHeight={hero ? 300 : 'none'}
        />
      </div>
    </div>
  )
}
