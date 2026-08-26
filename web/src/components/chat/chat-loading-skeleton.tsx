/**
 * `<ChatLoadingSkeleton>` — the calm placeholder shown while a thread's messages
 * are still seeding over the WebSocket.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS: the transcript is merged from two sources — the message tail (a
 * slow WS seed) and the harness event ledger (a fast REST GET). On open the REST
 * feed lands first, so for ~500ms the node list held ONLY the harness rows (a
 * screen of repeated "Ran schedule · …" lines) until the seed arrived. The list
 * is now gated on the seed; this stands in its place meanwhile — one clean
 * loading state instead of a flash of the wrong content.
 *
 * NO ADDED DELAY, NO FLASH OF ITSELF: it fades in on a short DELAY
 * (`.sm-chat-skel`, ~140ms, `both`), so a seed that lands fast (the common case,
 * and every cached re-open) replaces it before it was ever visible — the reader
 * sees their conversation immediately, never a skeleton that blinks. When the
 * wait is real, it fades in gently and the confirmed rows fade in over it.
 *
 * It mirrors the transcript's OWN row grammar (a 28px gutter mark + content
 * lines, a right-aligned user bubble) at the SAME rhythm, so the swap from
 * skeleton to real rows lands on the same lines and doesn't jump. Reduce-motion
 * safe by construction (`<Skeleton>` freezes; the fade degrades to a delayed
 * step — see `.sm-chat-skel`).
 */
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** One placeholder speaker turn: an agent row (gutter mark + text lines) or a
 *  right-aligned user bubble. Widths vary so it reads as speech, not a form. */
function SkeletonTurn({
  side,
  lines,
}: {
  side: 'agent' | 'user'
  lines: readonly string[]
}) {
  if (side === 'user') {
    // The user's own message is a right-aligned bubble in grok — one soft pill.
    return (
      <div className="flex justify-end">
        <Skeleton variant="shimmer" className="h-8 rounded-2xl" style={{ width: lines[0] }} />
      </div>
    )
  }
  return (
    <div className="flex gap-2.5">
      <Skeleton variant="shimmer" className="size-7 flex-none rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
        {lines.map((w, i) => (
          <Skeleton key={i} variant="shimmer" className="h-3.5 rounded" style={{ width: w }} />
        ))}
      </div>
    </div>
  )
}

// A fixed, natural-looking cadence — mostly the assistant, one user turn — so the
// placeholder has the shape a real thread does. Static (no randomness) so it
// never reflows between renders while loading.
const TURNS: { side: 'agent' | 'user'; lines: string[] }[] = [
  { side: 'agent', lines: ['62%', '84%'] },
  { side: 'user', lines: ['46%'] },
  { side: 'agent', lines: ['78%', '90%', '55%'] },
  { side: 'agent', lines: ['70%'] },
]

export function ChatLoadingSkeleton({ className }: { className?: string }) {
  return (
    <SkeletonRegion
      label="Loading conversation…"
      className={cn('sm-chat-skel flex flex-col gap-3.5 px-1 py-4', className)}
    >
      {TURNS.map((t, i) => (
        <SkeletonTurn key={i} side={t.side} lines={t.lines} />
      ))}
    </SkeletonRegion>
  )
}

export default ChatLoadingSkeleton
