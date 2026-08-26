// The company group chat's REST surface (spec §2.0 / §5).
//
// Exactly two routes, and only one of them is the web's business:
//
//   GET  /api/companies/{id}/groupchat/history?before_seq=&limit=
//        one page of the sidecar log, NEWEST-LAST, wrapped in the same
//        `{ok,data}` envelope every other route uses. `sessReq` unwraps it.
//   POST /api/companies/{id}/groupchat/post
//        a BOT's milestone. Not called from here — it is the `group-chat`
//        connector's path, and a browser posting as a session would be exactly
//        the impersonation the server's in-company check exists to refuse.
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
}
