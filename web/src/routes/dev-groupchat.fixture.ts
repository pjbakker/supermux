// /dev/groupchat — the offline cast.
//
// Realistic SUPERMUX content, not lorem: company "Canary", two working bots
// (`render-bug`, `chat-dataplane`), the auto-created Main Assistant
// (`canary-assistant`), and the owner (`Sander`) as a human colleague. Every
// message kind the spec names is present exactly once, in the order they
// actually occur — milestone, workflow completion, human request, the
// Assistant's routing line @tagging two bots, a tagged bot's reply — so a
// screenshot of this page is a screenshot of the whole grammar.
//
// Timestamps are FIXED epoch seconds. A bench you screenshot must be
// deterministic: `Date.now()` would make every VR diff fail on the clock.
import type { ChannelMember, GroupChatRow } from '@/components/chat/group-chat'

export const CANARY = { slug: 'canary', display_name: 'Canary' }

/** 2026-08-26 09:00:00Z, the bench's zero. */
const T0 = 1_787_734_800

export const CANARY_MEMBERS: ChannelMember[] = [
  { seed: 'canary-assistant', name: 'Main Assistant', state: 'idle' },
  { seed: 'render-bug', name: 'render-bug', state: 'working' },
  { seed: 'chat-dataplane', name: 'chat-dataplane', state: 'waiting', attention: 'needs' },
  { seed: 'ios-shell', name: 'ios-shell', state: 'idle' },
  { seed: 'connector-store', name: 'connector-store', state: 'done' },
]

export const CANARY_ROWS: GroupChatRow[] = [
  {
    seq: 1,
    ts: T0,
    kind: 'milestone',
    authorKind: 'bot',
    authorSeed: 'render-bug',
    authorName: 'render-bug',
    body: 'Root-caused the /browser black band: an orphaned display:block wrapper made BrowserWorkspace’s flex-1 inert. Fix is a one-line unwrap.',
  },
  {
    seq: 2,
    ts: T0 + 240,
    kind: 'workflow',
    authorKind: 'workflow',
    authorSeed: 'render-bug',
    authorName: 'render-bug',
    runLabel: 'mobile-rig · 390px sweep',
    body: '6 steps · 6 succeeded · 0 failed. No horizontal overflow at 390 or 402px; safe-area insets clear on both artboards.',
  },
  {
    seq: 3,
    ts: T0 + 900,
    kind: 'request',
    authorKind: 'human',
    authorSeed: 'user-sander',
    authorName: 'Sander',
    body: 'Chat comes up empty after a restart when the last transcript line is huge. Can someone take that, and check the composer still sends while we’re in there?',
  },
  {
    seq: 4,
    ts: T0 + 930,
    kind: 'routed',
    authorKind: 'router',
    authorSeed: 'canary-assistant',
    authorName: 'Main Assistant',
    tags: ['chat-dataplane', 'render-bug'],
    body: '@chat-dataplane owns the ring + disk fallback; @render-bug has the composer under test on the mobile rig.',
  },
  {
    seq: 5,
    ts: T0 + 1_140,
    kind: 'reply',
    authorKind: 'bot',
    authorSeed: 'chat-dataplane',
    authorName: 'chat-dataplane',
    body: 'Reproduced. The ring is empty and there is no disk fallback when the final JSONL line is ≥512KiB, so the seed returns nothing and the pane sticks on “No conversation yet.” Seeding from disk fixes it — @Sander do you want the fallback capped at the same 500-row ring, or the full tail?',
  },
  {
    seq: 6,
    ts: T0 + 1_200,
    kind: 'reply',
    authorKind: 'bot',
    authorSeed: 'chat-dataplane',
    authorName: 'chat-dataplane',
    body: 'Patch is up either way; the cap is a one-line change.',
  },
]
