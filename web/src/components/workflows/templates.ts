// The three starter templates — client-side seeds, no server table.
//
// This is the single highest-leverage thing on the empty state: nobody's first
// workflow should start at a blank textarea. Each one is a COMPLETE workflow —
// a cadence, real prompts, and for two of them a finished ending — so tapping
// it and pressing Save produces something that actually runs.
//
// They live here rather than in the view because the composer reads them too
// (`/workflows/new?template=standup`), and because a seed with a prompt in it
// is content, not layout.

import type { CompletionAction } from '@/lib/api/workflows'

export interface WorkflowTemplate {
  key: string
  /** The card's title. Also the workflow's title when it is seeded. */
  title: string
  /** One line saying what it does — written for someone who has never made one. */
  blurb: string
  emoji: string
  schedule_expr: string
  steps: Array<{ title: string; prompt: string; connectors?: string[] }>
  on_complete: CompletionAction
  /** Pre-fill the connector hint with the bot's mail connector when it has one. */
  wantsMail?: boolean
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'standup',
    title: 'Daily standup digest',
    blurb: 'Every weekday morning, gather what moved and write it up.',
    emoji: '🌅',
    schedule_expr: 'every weekday at 9:00',
    steps: [
      {
        title: 'Gather',
        prompt:
          'Look over what changed since yesterday — commits, open PRs, and anything still blocked. List it plainly.',
      },
      {
        title: 'Write it up',
        prompt:
          'Turn that into a short standup note: what shipped, what is in flight, what is blocked. Three bullets each, no filler.',
      },
    ],
    on_complete: { kind: 'notify' },
  },
  {
    key: 'weekly-report',
    title: 'Weekly report, emailed',
    blurb: 'Monday morning: pull the week, draft the report, send it on.',
    emoji: '📬',
    schedule_expr: 'weekly on mon at 9:00',
    steps: [
      { title: 'Pull the numbers', prompt: 'Pull last week’s numbers and note anything unusual.' },
      {
        title: 'Draft the report',
        prompt:
          'Draft a one-page client report from those numbers: what happened, what it means, what is next.',
      },
      {
        title: 'Ready to send',
        prompt: 'Tidy the draft into an email body — greeting, the report, a short sign-off.',
      },
    ],
    // Left as `notify` until an account is picked: the composer opens the
    // completion row on "Send with a connector", and a half-filled send is a
    // workflow that would fail at the last step.
    on_complete: { kind: 'notify' },
    wantsMail: true,
  },
  {
    key: 'inbox-triage',
    title: 'Inbox triage',
    blurb: 'Twice a day, sort what came in and surface only what needs you.',
    emoji: '📥',
    schedule_expr: 'daily at 8:00',
    steps: [
      {
        title: 'Read the inbox',
        prompt:
          'Go through the unread mail. Group it into: needs a reply from me, needs a reply from someone else, and noise.',
      },
      {
        title: 'Surface the top of it',
        prompt:
          'Give me the three that actually need me today, each with one line on why and a suggested reply.',
      },
    ],
    on_complete: { kind: 'notify' },
    wantsMail: true,
  },
]

export function templateByKey(key: string | null | undefined): WorkflowTemplate | null {
  if (!key) return null
  return WORKFLOW_TEMPLATES.find((t) => t.key === key) ?? null
}
