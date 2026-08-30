// The company group chat's REST surface (spec §2.0 / §5).
//
// Exactly two routes, and only one of them is the web's business:
//
//   GET  /api/companies/{id}/groupchat/history?before_seq=&limit=
//        one page of the sidecar log, NEWEST-LAST, wrapped in the same
//        `{ok,data}` envelope every other route uses. `sessReq` unwraps it.
//   POST /api/companies/{id}/groupchat/post
//        the composer's send, AND the `group-chat` connector's bot-milestone
//        path. The browser sends `{body}` and NOTHING ELSE: it never names a
//        poster, because the server resolves the author from the request's own
//        identity (`posting_human`) and a browser-declared session would be
//        exactly the impersonation the in-company check exists to refuse.
//
// The live half is the WebSocket (`/ws/companies/{id}/groupchat`), which the
// shared `ChatSocket` speaks — see `components/chat/chat-socket.ts`'s `path`
// seam. This module is the BACKLOG half: the socket seeds the newest ring page,
// and scrolling past its top pages older rows through here.

import type { WireEntry } from '@/components/chat/wire'

import { sessionRequest } from './sessions'

/** One page of the channel. `more_seq` is the cursor for the NEXT (older) page;
 *  `null` means the page reached the start of the log. */
export interface GroupChatHistoryPage {
  entries: WireEntry[]
  has_more: boolean
  more_seq: number | null
}

/** One appended row, as the server sealed it. The `{ok,data}` envelope is
 *  unwrapped by `sessReq`, so this is the row itself. */
export interface GroupChatPostedRow {
  seq: number
  ts: number
  author_session: string
  author_kind: string
  body: string
}

export const groupChatApi = {
  /**
   * Rows strictly BELOW `beforeSeq`, newest-last.
   *
   * The cursor domain is the LOG's `seq`, which rides on each wire entry's
   * `offset` — so the caller pages by handing back the oldest row it already
   * has, and never has to reconcile two id spaces.
   */
  history: async (
    companyId: number,
    opts: { beforeSeq?: number; limit?: number } = {},
  ): Promise<GroupChatHistoryPage> => {
    const q = new URLSearchParams()
    if (opts.beforeSeq !== undefined) q.set('before_seq', String(opts.beforeSeq))
    if (opts.limit !== undefined) q.set('limit', String(opts.limit))
    const qs = q.size > 0 ? `?${q}` : ''
    const body = await sessionRequest<unknown>(
      `/api/companies/${companyId}/groupchat/history${qs}`,
    )
    const v = (body ?? {}) as Partial<GroupChatHistoryPage>
    return {
      entries: Array.isArray(v.entries) ? v.entries : [],
      has_more: v.has_more === true,
      more_seq: typeof v.more_seq === 'number' ? v.more_seq : null,
    }
  },

  /**
   * `POST /api/companies/{id}/groupchat/post` — the human's request, as ONE
   * call that does both halves.
   *
   * The composer used to type straight into the Router's pty
   * (`/api/sessions/{router}/send`), which woke it but wrote NO feed row: the
   * request never appeared in the channel anyone else was reading, and it never
   * opened a routing turn (`current_turn`, which the max-2-tag cap keys on). So
   * the message the Router was answering was invisible, and the cap counted
   * against the wrong turn.
   *
   * This route is the one the server made authoritative: it appends the
   * `AUTHOR_HUMAN` row (which is what the feed shows and what opens the turn)
   * and THEN wakes the Router through the same `<supermux-human>` funnel the
   * chat composer uses. The body carries `{body}` only — the author is the
   * request's own resolved identity, never anything this client could name.
   */
  post: async (companyId: number, body: string): Promise<GroupChatPostedRow> =>
    sessionRequest<GroupChatPostedRow>(
      `/api/companies/${companyId}/groupchat/post`,
      { method: 'POST', body: JSON.stringify({ body }) },
    ),
}
