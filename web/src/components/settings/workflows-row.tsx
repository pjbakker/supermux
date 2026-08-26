// Settings → Workflows — ONE row, pointing at the surface that owns them.
//
// This replaces `schedules-section.tsx`, which folded the whole /scheduler
// table into Settings back when a schedule had no home of its own. Workflows
// has a home: `/workflows` is a real route with the list, the composer, the
// step rail and the run history. Re-folding all of that into a 42rem settings
// column would be a second, worse implementation of a surface that already
// exists — so Settings keeps the ONE thing a settings page is for: a way in.
//
// The `id` is `schedules`, deliberately unchanged: `#schedules` deep links are
// in the wild (the old /scheduler redirect landed on this fragment), and a
// fragment that scrolls nowhere is a broken link.

import { ArrowRight } from 'lucide-react'
import { WorkflowsGlyph } from '@/components/nav-glyphs'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'

import { Row, sectionItem } from '@/components/settings/primitives'
import { WORKFLOWS_ROUTE } from '@/components/workflows/workflow-href'

/** The stable fragment `#schedules` deep links still land on. */
export const WORKFLOWS_ANCHOR = 'schedules'

export function WorkflowsRow() {
  return (
    <motion.section variants={sectionItem} className="flex flex-col" id={WORKFLOWS_ANCHOR}>
      <h2 className="px-4 pb-2 text-[13px] font-medium leading-none text-muted-foreground">
        Workflows
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        <Row
          label={
            <Link
              to={WORKFLOWS_ROUTE}
              className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <WorkflowsGlyph className="size-4 shrink-0 text-muted-foreground" />
              Workflows
            </Link>
          }
          hint="What your bots do on their own — the list, the steps and every run."
          control={
            <Link
              to={WORKFLOWS_ROUTE}
              aria-label="Open workflows"
              className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          }
        />
      </div>
    </motion.section>
  )
}
