// BotModeIntro — the "Run a company of bots" unboxing.
//
// One recommendation gate + four one-idea story screens, shown once (see
// `lib/botmode-onboarding.ts`) to a user who has not turned Bot Mode on. The
// design bar: Superhuman polish, Linear restraint — a near-black canvas, one
// accent primary action per screen pinned to the thumb zone, a persistent
// bot-avatar strip that rides the whole flow for continuity, real-looking
// product glimpses (a bot card, a streaming chat, a company, workflow + browser
// tiles) instead of marketing slides, and an always-visible Skip that never
// nags. Enabling Bot Mode is a reload-level skin change, so the flow ends by
// reloading into Bot Mode; "Not now" simply closes and never asks again.
//
// Motion is framer, transform/opacity only, and fully `prefers-reduced-motion`
// aware (streams become instant states, breathing loops stop).

import * as React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ArrowRight, Check, Sparkles, X } from 'lucide-react'

import { SessionMark } from '@/brand/marks'
import { useUI } from '@/stores/ui-store'
import { cn } from '@/lib/utils'
import { completeBotModeIntro } from '@/lib/botmode-onboarding'

// Three bots carry the whole story — the same seeds everywhere, so the faces the
// gate introduces are the faces the company screen assembles (continuity).
const TEAM = [
  { seed: 'ada-dev', name: 'Ada', role: 'Developer' },
  { seed: 'max-growth', name: 'Max', role: 'Marketing' },
  { seed: 'sam-sales', name: 'Sam', role: 'Sales' },
] as const

/* ── shared shells ─────────────────────────────────────────────────────────── */

/** The persistent team strip that rides screens 1–4 — the continuity tell. */
function TeamStrip({ active }: { active?: string }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {TEAM.map((m) => (
        <span
          key={m.seed}
          className={cn(
            'transition-opacity duration-500',
            active && active !== m.seed ? 'opacity-35' : 'opacity-100',
          )}
        >
          <SessionMark seed={m.seed} size={26} animate={false} label={null} />
        </span>
      ))}
    </div>
  )
}

/** A single story screen's chrome: headline + subline over a product glimpse,
 *  a progress rail, Skip, and the accent primary pinned to the thumb zone. */
function ScreenShell({
  index,
  total,
  headline,
  subline,
  glimpse,
  primaryLabel,
  onPrimary,
  onSkip,
  reduce,
}: {
  index: number
  total: number
  headline: string
  subline: string
  glimpse: React.ReactNode
  primaryLabel: string
  onPrimary: () => void
  onSkip: () => void
  reduce: boolean
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-1">
        <TeamStrip active={TEAM[Math.min(index, TEAM.length - 1)]?.seed} />
        <button
          type="button"
          onClick={onSkip}
          className="rounded-full px-3 py-1 text-[13px] font-medium text-white/45 transition-colors hover:text-white/80"
        >
          Skip
        </button>
      </div>

      {/* The glimpse — the product demoing itself — gets the room. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-4">
        <motion.div
          key={index}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0.15 : 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[380px]"
        >
          {glimpse}
        </motion.div>
      </div>

      <div className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <motion.h2
          key={`h${index}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: reduce ? 0 : 0.08 }}
          className="text-balance text-[26px] font-semibold leading-[1.12] tracking-[-0.02em] text-white"
        >
          {headline}
        </motion.h2>
        <p className="mt-2 text-[15px] leading-[1.45] text-white/60">{subline}</p>

        {/* progress rail */}
        <div className="mt-5 flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-1 rounded-full transition-all duration-300',
                i === index ? 'w-6 bg-white' : 'w-1.5 bg-white/25',
              )}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={onPrimary}
          className="mt-4 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-primary text-[16px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-transform active:scale-[0.98]"
        >
          {primaryLabel}
          <ArrowRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  )
}

/* ── product glimpses ──────────────────────────────────────────────────────── */

function Chip({ children, lit }: { children: React.ReactNode; lit: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-all duration-500',
        lit
          ? 'border-primary/40 bg-primary/10 text-white'
          : 'border-white/10 bg-white/[0.03] text-white/40',
      )}
    >
      {children}
    </span>
  )
}

/** Screen 1 — a bot is a teammate: the real card + provisioning chips. */
function BotCardGlimpse({ reduce }: { reduce: boolean }) {
  const [lit, setLit] = React.useState(reduce ? 3 : 0)
  React.useEffect(() => {
    if (reduce) return
    let n = 0
    const t = window.setInterval(() => {
      n += 1
      setLit(n)
      if (n >= 3) window.clearInterval(t)
    }, 520)
    return () => window.clearInterval(t)
  }, [reduce])
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
      <div className="flex items-center gap-3.5">
        <SessionMark seed={TEAM[0].seed} size={52} animate={false} label={null} />
        <div>
          <p className="text-[18px] font-semibold text-white">Ada</p>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[11.5px] font-medium text-white/80">
              Developer
            </span>
            <span className="flex items-center gap-1 text-[12px] text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-400" /> online
            </span>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Chip lit={lit >= 1}>Its own folder</Chip>
        <Chip lit={lit >= 2}>Connectors</Chip>
        <Chip lit={lit >= 3}>Workflows</Chip>
      </div>
    </div>
  )
}

/** Screen 2 — watch it work: a streaming reply + an inline tool chip + a check. */
function ChatGlimpse({ reduce }: { reduce: boolean }) {
  const full =
    'On it — updating the headline, three tiers, and the FAQ. Keeping the copy tight and benefit-led.'
  const [shown, setShown] = React.useState(reduce ? full.length : 0)
  const [done, setDone] = React.useState(reduce)
  React.useEffect(() => {
    if (reduce) return
    let i = 0
    const t = window.setInterval(() => {
      i += 2
      setShown(i)
      if (i >= full.length) {
        window.clearInterval(t)
        window.setTimeout(() => setDone(true), 400)
      }
    }, 45)
    return () => window.clearInterval(t)
  }, [reduce])
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <span className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[14.5px] text-primary-foreground">
          Ship the pricing page copy
        </span>
      </div>
      <div className="flex gap-2.5">
        <SessionMark seed={TEAM[0].seed} size={28} animate={false} label={null} />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] leading-[1.45] text-white/90">
            {full.slice(0, shown)}
            {!done && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-white/60" />}
          </p>
          {done && (
            <motion.span
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[12.5px] text-white/70"
            >
              <span className="font-mono text-white/80">pricing.tsx</span>
              <span className="flex items-center gap-1 text-emerald-400">
                <Check className="size-3" /> done
              </span>
            </motion.span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Screen 3 — a company: the three bots, shared connectors, bot-to-bot chat. */
function CompanyGlimpse() {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold text-white">Acme</span>
        <div className="flex gap-1.5">
          {['Slack', 'Gmail', 'GitHub'].map((c) => (
            <span key={c} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] text-white/55">
              {c}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {TEAM.map((m) => (
          <SessionMark key={m.seed} seed={m.seed} size={30} animate={false} label={null} />
        ))}
      </div>
      <div className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-[13px]">
        <p className="text-white/80">
          <span className="font-medium text-white">Ada</span>
          <span className="text-white/40"> → Max</span> · pricing page is live
        </p>
        <p className="text-white/80">
          <span className="font-medium text-white">Max</span>
          <span className="text-white/40"> → Ada</span> · pushing the launch email
        </p>
      </div>
    </div>
  )
}

/** Screen 4 — the reach: workflows + a shared browser. */
function ReachGlimpse() {
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <p className="text-[12.5px] font-medium text-white/55">Workflow</p>
        <p className="mt-1 text-[14px] text-white">Daily standup → digest → post</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-2/3 rounded-full bg-primary" />
        </div>
        <p className="mt-1.5 text-[11.5px] text-white/40">Bots set these up &amp; run them</p>
      </div>
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <p className="text-[12.5px] font-medium text-white/55">Shared browser</p>
        <div className="mt-2 flex gap-1.5">
          <span className="rounded-t-md bg-white/10 px-2 py-1 text-[11px] text-white/80">app.com</span>
          <span className="rounded-t-md bg-white/[0.04] px-2 py-1 text-[11px] text-white/40">docs</span>
        </div>
        <div className="h-8 rounded-b-md rounded-tr-md border border-white/10 bg-black/40" />
        <p className="mt-1.5 text-[11.5px] text-white/40">For anything without a connector</p>
      </div>
    </div>
  )
}

/* ── the flow ──────────────────────────────────────────────────────────────── */

const STORY = [
  {
    headline: 'Every bot is a teammate.',
    subline:
      'A name, a face, and a role — with its own folder, its own connectors, its own workflows.',
    primary: 'Next',
    glimpse: (reduce: boolean) => <BotCardGlimpse reduce={reduce} />,
  },
  {
    headline: 'Bots do the work.',
    subline: 'Anything a person can do on a computer — write code, run campaigns, handle sales.',
    primary: 'Next',
    glimpse: (reduce: boolean) => <ChatGlimpse reduce={reduce} />,
  },
  {
    headline: 'Bots run companies together.',
    subline:
      'Group them into a company with shared connectors and one central chat. They coordinate — like a real team.',
    primary: 'Next',
    glimpse: () => <CompanyGlimpse />,
  },
  {
    headline: 'Connect to anything.',
    subline:
      'Workflows run tasks on a schedule. And a shared browser lets the whole company use the web when there is no API.',
    primary: 'Enter Bot Mode',
    glimpse: () => <ReachGlimpse />,
  },
] as const

export function BotModeIntro({ onClose }: { onClose: () => void }) {
  const reduce = useReducedMotion() ?? false
  const setBotMode = useUI((s) => s.setBotMode)
  // -1 = the recommendation gate; 0..3 = the story screens.
  const [screen, setScreen] = React.useState(-1)

  // Enable Bot Mode + remember we're done, then reload so the skin actually
  // applies (a Bot Mode flip is a reload-level change, like the Settings toggle).
  const enterBotMode = React.useCallback(() => {
    setBotMode(true)
    completeBotModeIntro()
    window.location.reload()
  }, [setBotMode])

  // Dismiss without enabling — never ask again, no reload.
  const dismiss = React.useCallback(() => {
    completeBotModeIntro()
    onClose()
  }, [onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[90] bg-[#0A0A0B] pt-[env(safe-area-inset-top)] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Bot Mode introduction"
    >
      <AnimatePresence mode="wait">
        {screen === -1 ? (
          // ── the recommendation gate — the only screen that pitches ──────────
          <motion.div
            key="gate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
            className="flex h-full flex-col"
          >
            <div className="flex justify-end px-5 pt-1">
              <button
                type="button"
                onClick={dismiss}
                aria-label="Close"
                className="grid size-9 place-items-center rounded-full text-white/40 transition-colors hover:text-white/80"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
              {/* the hero: the three bots, breathing, a faint connective pulse */}
              <div className="relative mb-8 flex items-center gap-3">
                {TEAM.map((m, i) => (
                  <motion.span
                    key={m.seed}
                    animate={reduce ? undefined : { y: [0, -5, 0] }}
                    transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
                  >
                    <SessionMark seed={m.seed} size={54} animate={false} label={null} />
                  </motion.span>
                ))}
              </div>
              <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[12.5px] font-medium text-white">
                <Sparkles className="size-3.5 text-primary" /> Recommended
              </span>
              <h1 className="text-balance text-[32px] font-semibold leading-[1.08] tracking-[-0.02em] text-white">
                Run a company of bots.
              </h1>
              <p className="mt-3 max-w-[340px] text-[15.5px] leading-[1.5] text-white/60">
                Hire bots that do real work on a computer — dev, marketing, sales — organized into
                companies that talk to each other. From your desktop or your phone.
              </p>
            </div>
            <div className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={() => setScreen(0)}
                className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-primary text-[16px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition-transform active:scale-[0.98]"
              >
                Turn on Bot Mode
                <ArrowRight className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="mt-2 w-full py-2.5 text-[14.5px] font-medium text-white/45 transition-colors hover:text-white/70"
              >
                Not now
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key={`story-${screen}`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, x: -24 }}
            transition={{ duration: reduce ? 0.15 : 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="h-full"
          >
            <ScreenShell
              index={screen}
              total={STORY.length}
              headline={STORY[screen].headline}
              subline={STORY[screen].subline}
              glimpse={STORY[screen].glimpse(reduce)}
              primaryLabel={STORY[screen].primary}
              onPrimary={() => (screen >= STORY.length - 1 ? enterBotMode() : setScreen(screen + 1))}
              onSkip={enterBotMode}
              reduce={reduce}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default BotModeIntro
