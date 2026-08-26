/**
 * The company group chat (spec §7) — a CHANNEL built out of the chat surface's
 * shipped primitives. `channel.tsx` is presentational; `use-company-channel.ts`
 * is the one app-aware resolution; `entry.tsx` is the compact overview row that
 * OPENS the full-bleed `/company/:id/chat` page; `types.ts` is the display shape
 * the groupchat WS adapter maps onto.
 */
export { ChatChannel, type ChatChannelProps } from './channel'
export { ChannelComposer, type ChannelComposerProps } from './channel-composer'
export { GroupChatEntry, type GroupChatEntryProps } from './entry'
export {
  useCompanyChannel,
  routerName,
  useChannelMembers,
  type CompanyChannel,
} from './use-company-channel'
export { useGroupChat, type GroupChatFeed } from './use-group-chat'
export { mergeRows, parseRouting, toGroupChatRow, toGroupChatRows } from './wire'
export {
  GROUP_WINDOW_SECONDS,
  isGrouped,
  type ChannelMember,
  type GroupChatAuthorKind,
  type GroupChatKind,
  type GroupChatRow,
} from './types'
