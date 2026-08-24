// CompletionActionRow — "when the whole thing finishes, do X".
//
// This is the curated replacement for `done_action: command:<text>`, and the
// most important property of the file is what it CANNOT do. There are exactly
// five options, none of them is "run this string", and there is no free-text
// box anywhere in this subtree — `workflow-completion.test.ts` renders every
// expanded state and asserts that the only text inputs are the typed ones
// (`to`, `subject`), each marked `data-typed-field`. That test is the client
// half of keeping the dragon dead; `complete.rs`'s enum is the server half.
//
// THE HONESTY RULE. supermux has no MCP client: it cannot send an email. Only
// the BOT can, because only the bot holds the grant. So a connector completion
// is an INSTRUCTION delivered to the bot's pane, and every sentence here says
// "will ask scout to send" — never "will send", and never, afterwards, "sent".

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useSessionConnectors } from '@/stores/connectors-store'
import type { SessionConnector } from '@/lib/api/connectors'
import type { CompletionAction } from '@/lib/api/workflows'

/** The five, in the order they are offered. The array IS the vocabulary: a
 *  sixth entry would have to be a typed arm on the server enum first. */
export const COMPLETION_OPTIONS: { kind: CompletionAction['kind']; label: string }[] = [
  { kind: 'none', label: 'Do nothing' },
  { kind: 'notify', label: 'Notify me' },
  { kind: 'connector_send', label: 'Send with a connector…' },
  { kind: 'message_bot', label: 'Message another bot…' },
  { kind: 'disable', label: 'Pause this workflow' },
]

export interface CompletionActionRowProps {
  value: CompletionAction
  onChange: (next: CompletionAction) => void
  /** The owning bot — it is the one that would be asked to send. */
  session: string
  /** Same-company bots, for "Message another bot". */
  bots?: { name: string; display_name?: string }[]
  /** Offline bench: the grants that would come from the live query. */
  connectorsOverride?: SessionConnector[]
}

export function CompletionActionRow({
  value,
  onChange,
  session,
  bots = [],
  connectorsOverride,
}: CompletionActionRowProps) {
  const reduce = useReducedMotion()
  const live = useSessionConnectors(connectorsOverride ? null : session)
  const granted = connectorsOverride ?? live.data ?? []

  // Only connectors with a LIVE account can be offered. A disconnected or
  // expired account rendered as available is a workflow that fails at its last
  // step, days later, with nobody watching — the dead-connections-look-dead
  // rule the connector store already enforces.
  const sendable = React.useMemo(
    () =>
      granted
        .filter((g) => g.enabled)
        .flatMap((g) =>
          (g.card?.accounts ?? [])
            .filter((a) => a.status === 'active' && a.health !== 'expired' && a.health !== 'error')
            .map((a) => ({
              connector_id: g.connector_id,
              connector_name: g.card?.display_name || g.connector_id,
              account_ref: a.id,
              account_label: a.account_label,
            })),
        ),
    [granted],
  )

  const pick = (kind: CompletionAction['kind']) => {
    if (kind === value.kind) return
    if (kind === 'connector_send') {
      const first = sendable[0]
      onChange({
        kind: 'connector_send',
        connector_id: first?.connector_id ?? '',
        account_ref: first?.account_ref ?? '',
        to: '',
        subject: null,
      })
      return
    }
    if (kind === 'message_bot') {
      onChange({ kind: 'message_bot', session: bots.find((b) => b.name !== session)?.name ?? '' })
      return
    }
    onChange({ kind } as CompletionAction)
  }

  return (
    <section className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        When the whole workflow finishes
      </h2>

      <select
        aria-label="When the whole workflow finishes"
        value={value.kind}
        onChange={(e) => pick(e.target.value as CompletionAction['kind'])}
        className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
      >
        {COMPLETION_OPTIONS.map((o) => (
          <option key={o.kind} value={o.kind}>
            {o.label}
          </option>
        ))}
      </select>

      <AnimatePresence initial={false}>
        {value.kind === 'connector_send' && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={springs.cardExpand}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 pt-2.5">
              {sendable.length === 0 ? (
                <p className="text-[12.5px] leading-snug text-amber-600 dark:text-amber-500">
                  {session} has no connected account yet. Connect one in Connectors, then come
                  back — we will not pretend it can send without it.
                </p>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                    Using
                    <select
                      aria-label="Connector account"
                      value={`${value.connector_id}::${value.account_ref}`}
                      onChange={(e) => {
                        const [connector_id, account_ref] = e.target.value.split('::')
                        onChange({ ...value, connector_id, account_ref })
                      }}
                      className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                    >
                      {sendable.map((s) => (
                        <option
                          key={`${s.connector_id}::${s.account_ref}`}
                          value={`${s.connector_id}::${s.account_ref}`}
                        >
                          {s.connector_name} · {s.account_label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                    To
                    <input
                      type="text"
                      data-typed-field="to"
                      inputMode="email"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={value.to}
                      onChange={(e) => onChange({ ...value, to: e.target.value })}
                      placeholder="client@example.com"
                      aria-label="Recipient"
                      className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                    Subject (optional)
                    <input
                      type="text"
                      data-typed-field="subject"
                      value={value.subject ?? ''}
                      onChange={(e) => onChange({ ...value, subject: e.target.value || null })}
                      placeholder="Weekly report"
                      aria-label="Subject"
                      className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                    />
                  </label>
                </>
              )}
            </div>
          </motion.div>
        )}

        {value.kind === 'message_bot' && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={springs.cardExpand}
            className="overflow-hidden"
          >
            <div className="pt-2.5">
              <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                Which bot
                <select
                  aria-label="Which bot"
                  value={value.session}
                  onChange={(e) => onChange({ kind: 'message_bot', session: e.target.value })}
                  className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                >
                  <option value="">Pick a bot…</option>
                  {bots
                    .filter((b) => b.name !== session)
                    .map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.display_name || b.name}
                      </option>
                    ))}
                </select>
              </label>
              {/* No text field here, ever: the body is the server-generated run
                  summary. A message box would be `command:` wearing a hat. */}
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                It gets the run summary. There is no message to write — that is on purpose.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <p className={cn('mt-2 text-[12.5px] leading-snug text-muted-foreground')}>
        {completionSentence(value, session, sendable)}
      </p>
    </section>
  )
}

interface Sendable {
  connector_id: string
  connector_name: string
  account_ref: string
  account_label: string
}

/**
 * The sentence under the row — what will happen, in words, before it happens.
 *
 * Every connector phrasing is "will ASK <bot> to send", because that is the
 * whole of what the server does: it delivers an instruction to a pane. The
 * word "send" never appears with supermux as its subject.
 */
export function completionSentence(
  value: CompletionAction,
  session: string,
  sendable: Sendable[] = [],
): string {
  switch (value.kind) {
    case 'none':
      return 'Nothing happens when it finishes.'
    case 'notify':
      return 'You get a notification when it finishes.'
    case 'disable':
      return 'It pauses itself after this run — good for a one-off you might repeat later.'
    case 'message_bot':
      return value.session
        ? `When done, the run summary goes to ${value.session}.`
        : 'Pick which bot should get the run summary.'
    case 'connector_send': {
      const hit = sendable.find(
        (s) => s.connector_id === value.connector_id && s.account_ref === value.account_ref,
      )
      const via = hit ? `${hit.connector_name} (${hit.account_label})` : 'a connector'
      const to = value.to?.trim()
      if (!to) return `When done, ${session} will be asked to send the run summary via ${via}.`
      return `When done, ${session} will be asked to send the run summary to ${to} via ${via}.`
    }
  }
}

/** Is this action complete enough to save? Returns the reason it is not. */
export function completionProblem(value: CompletionAction): string | null {
  if (value.kind === 'connector_send') {
    if (!value.connector_id || !value.account_ref) return 'Pick the account to send from'
    if (!value.to.trim()) return 'Say who the summary goes to'
  }
  if (value.kind === 'message_bot' && !value.session) return 'Pick which bot gets the summary'
  return null
}
