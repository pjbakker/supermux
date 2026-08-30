/**
 * The company group chat (spec §7) — a CHANNEL built out of the chat surface's
 * shipped primitives. `channel.tsx` is presentational; `use-company-channel.ts`
 * is the one app-aware resolution; `entry.tsx` is the compact PHONE doorway that
 * OPENS the full-bleed `/company/:id/chat` page; `channel-row.tsx` is the DESKTOP
 * doorway — a pinned roster row that opens the channel in the right pane;
 * `surface.ts` decides which of the two a viewport gets; `types.ts` is the
 * display shape the groupchat WS adapter maps onto.
 */
export { ChatChannel, type ChatChannelProps } from './channel'
export { ChannelComposer, type ChannelComposerProps } from './channel-composer'
export { GroupChatEntry, type GroupChatEntryProps } from './entry'
export { CompanyChannelRow, type CompanyChannelRowProps } from './channel-row'
export {
  channelPreview,
  channelPreviewLine,
  channelRowMatches,
  groupChatSurface,
  CHANNEL_ROW_LABEL,
  type GroupChatSurface,
} from './surface'
export {
  useCompanyChannel,
  routerName,
  useChannelMembers,
  type CompanyChannel,
} from './use-company-channel'
export { useGroupChat, type GroupChatFeed } from './use-group-chat'
export { mergeRows, toGroupChatRow, toGroupChatRows } from './wire'
export {
  GROUP_WINDOW_SECONDS,
  isGrouped,
  type ChannelMember,
  type GroupChatAuthorKind,
  type GroupChatKind,
  type GroupChatRow,
} from './types'
