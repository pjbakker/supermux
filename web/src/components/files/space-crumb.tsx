// The SPACE CRUMB — the Files header's primary scope control.
//
// It replaces the `<SessionPicker>` that used to sit here, which taught the
// wrong mental model: it did not pick a company and it did not switch
// transport (`filesApi.ls` never sends `session`, so the listing always
// resolved local). What it actually did — "jump to a bot's working dir" —
// survives as the SECONDARY group at the bottom of this sheet, demoted to what
// it is.
//
// One `<ResponsiveSheet>` (Vaul bottom sheet on coarse pointers, right-hand
// Sheet on desktop) for both halves, so there is no dropdown-vs-sheet fork to
// maintain and the mobile branch is the proven one.

import * as React from 'react'
import { ChevronDown, CornerDownRight, LayoutGrid } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import type { Company } from '@/lib/companies'

export interface SpaceCrumbSession {
  name: string
  company_id?: number | null
}

export interface SpaceCrumbProps {
  /** The active space: null = HQ. */
  activeCompany: number | null
  companies: readonly Company[]
  /** Bots offered under "Jump to a bot's working dir", already scoped by the
   *  caller to the active space — this sheet never widens a scope. */
  sessions: readonly SpaceCrumbSession[]
  /** Pick a space. `null` = HQ. */
  onPickSpace: (id: number | null) => void
  /** Show the Spaces grid (the landing). */
  onShowSpaces: () => void
  /** Jump to a bot's working dir. */
  onPickSession: (name: string) => void
}

export function SpaceCrumb({
  activeCompany,
  companies,
  sessions,
  onPickSpace,
  onShowSpaces,
  onPickSession,
}: SpaceCrumbProps) {
  const [open, setOpen] = React.useState(false)
  const current = companies.find((c) => c.id === activeCompany) ?? null
  const label = current ? current.display_name : 'HQ'

  const close = () => setOpen(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Space: ${label}. Switch space`}
        // ≥44px tall and shrink-0: the crumb is the one control that must never
        // be squeezed out by a long path on a 390px header.
        className="ml-1 flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-sm transition-colors hover:bg-accent active:bg-accent"
      >
        {current ? (
          <CompanyMark slug={current.slug} name={current.display_name} size={22} />
        ) : (
          <HqMark size={22} />
        )}
        <span className="max-w-[5.5rem] truncate font-medium sm:max-w-[9rem]">
          {label}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title="Switch space"
        description="Whose drive you are browsing"
      >
        <div className="flex flex-col p-2">
          <SheetRow
            onClick={() => {
              close()
              onShowSpaces()
            }}
            icon={
              <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <LayoutGrid className="size-4" />
              </span>
            }
            label="All spaces"
            hint="The Files landing"
          />

          <div className="my-1 h-px bg-border" />

          <SheetRow
            active={activeCompany === null}
            onClick={() => {
              close()
              onPickSpace(null)
            }}
            icon={<HqMark size={28} />}
            label="HQ"
          />
          {companies.map((c) => (
            <SheetRow
              key={c.id}
              active={c.id === activeCompany}
              onClick={() => {
                close()
                onPickSpace(c.id)
              }}
              icon={<CompanyMark slug={c.slug} name={c.display_name} size={28} />}
              label={c.display_name}
            />
          ))}

          {sessions.length > 0 && (
            <>
              <div className="mt-3 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Jump to a bot’s working dir
              </div>
              {sessions.map((s) => (
                <SheetRow
                  key={s.name}
                  onClick={() => {
                    close()
                    onPickSession(s.name)
                  }}
                  icon={
                    <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <CornerDownRight className="size-4" />
                    </span>
                  }
                  label={s.name}
                />
              ))}
            </>
          )}
        </div>
      </ResponsiveSheet>
    </>
  )
}

function SheetRow({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent active:bg-accent',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {hint && (
          <span className="block truncate text-xs text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </button>
  )
}
