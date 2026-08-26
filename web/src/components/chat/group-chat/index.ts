/**
 * The company group chat (spec §7) — a CHANNEL built out of the chat surface's
 * shipped primitives. `channel.tsx` is presentational; `hero.tsx` is the one
 * app-aware wrapper the overview mounts; `types.ts` is the display shape the
 * groupchat WS adapter will map onto.
 */
export { ChatChannel, type ChatChannelProps } from './channel'
export { GroupChatHero, type GroupChatHeroProps } from './hero'
export {
  GROUP_WINDOW_SECONDS,
  isGrouped,
  type ChannelMember,
  type GroupChatAuthorKind,
  type GroupChatKind,
  type GroupChatRow,
} from './types'
