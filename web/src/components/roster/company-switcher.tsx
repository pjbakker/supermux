/**
 * `<CompanySwitcher>` — the HQ/company scope selector, grok-native (Companies,
 * Bot Mode). It is the leftmost identity in `.gr-head` and IS the overview title
 * (the old `.gr-brand` "supermux" wordmark was dropped — the active scope name
 * leads instead): the TRIGGER is the always-visible identity chip (Slack/Notion
 * pattern — the active tenant is never hidden behind a click), showing the mark
 * (HQ = the real blue-S `<HqMark>`, a company = its `<CompanyMark>`) next to the
 * active scope's name.
 *
 * Selecting a row writes `activeCompany` in the UI store, which scopes the whole
 * roster (see `grok-roster.tsx`). `null` = HQ, the main/PA space that shows only
 * `company_id`-null bots; a number scopes to that company. There is NO mixed
 * "All" view.
 *
 * RESPONSIVE, one option list, two shells (mobile-first, DRY):
 *   • coarse pointer (touch / narrow) → the options render in the app's canonical
 *     `<ResponsiveSheet>` — the SAME Vaul drag-detent BOTTOM SHEET the create flow
 *     uses (`responsive-sheet.tsx`, forked on `(pointer: coarse)` via
 *     `use-media-query.ts`). Full-width minus inset, pinned to the bottom with
 *     safe-area padding and a grabber, scrollable, ≥44px rows — nothing can clip
 *     off the right edge the way a fixed-width anchored menu did on a phone.
 *   • fine pointer (mouse) → the compact anchored menu the roster already uses for
 *     its overflow menu (`role=menu absolute z-30 rounded-xl border bg-popover
 *     shadow-lg`), now VIEWPORT-SAFE: width capped to `min(300px, 100vw−24px)` so
 *     it can never overflow the right edge. Keyboard nav lives here.
 *
 * The row markup is authored ONCE (`renderOptions`) and skinned per shell, so the
 * HQ cell, each company row, the "New company…" action and the footer hint are
 * byte-identical between the sheet and the menu.
 *
 * Keyboard (desktop): ⌘/Ctrl+⇧+O opens (footer hint); ⌘/Ctrl+1..9 jump to the Nth
 * company; ↑/↓ move a roving highlight, Enter activates, Escape closes and returns
 * focus to the trigger (the combobox pattern).
 */
import * as React from 'react'
import { ChevronsUpDown, Plus, SlidersHorizontal, Trash2, UserPlus } from 'lucide-react'

import { useCompanies } from '@/hooks/use-companies'
import { useUI } from '@/stores/ui-store'
import { companyForDigit, companyLogoUrl } from '@/lib/companies'
import { apiToken } from '@/lib/api/client'
import { useMediaQuery } from '@/hooks/use-media-query'
import { CompanyMark, HqMark } from '@/components/roster/company-mark'
import { CompanyPicker } from '@/components/roster/company-picker'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'

const CreateCompanySheet = React.lazy(() =>
  import('@/components/roster/create-company-sheet').then((m) => ({
    default: m.CreateCompanySheet,
  })),
)

// The onboarding wizard is lazy so none of its weight — or its DEV mock — lands
// on the cold-load hero path; the switcher trigger is the only entry graph edge.
const InviteWizardSheet = React.lazy(() =>
  import('@/components/companies/invite-wizard-sheet').then((m) => ({
    default: m.InviteWizardSheet,
  })),
)

// The destructive delete flow is lazy for the same reason — its type-to-confirm
// sheet and the `useSessions` bot-count it reads never touch the cold-load path;
// the danger row is the only entry edge, opened at most once per delete.
const DeleteCompanySheet = React.lazy(() =>
  import('@/components/roster/delete-company-sheet').then((m) => ({
    default: m.DeleteCompanySheet,
  })),
)
const CompanySettingsSheet = React.lazy(() =>
  import('@/components/roster/company-settings-sheet').then((m) => ({
    default: m.CompanySettingsSheet,
  })),
)

/** Whether a keyboard event is the ⌘/Ctrl modifier (mac vs the rest). */
function isCmdOrCtrl(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

/** A stable empty attention set so the default prop is referentially constant. */
const EMPTY_ATTENTION: ReadonlySet<number | null> = new Set()

/** The ⌘⇧O open-shortcut hint, shared verbatim between the menu footer and the
 *  sheet footer slot so the two shells read identically. */
function OpenHint() {
  return (
    <div className="flex items-center justify-end text-[11.5px] text-muted-foreground">
      <kbd className="tabular-nums">⌘⇧O</kbd>
      <span className="ml-1.5">to open</span>
    </div>
  )
}

export function CompanySwitcher({
  /** The set of company ids (with `null` = HQ) that currently have at least one
   *  bot needing attention, from the roster's own needs-you rollup. A dot shows
   *  on each row in the set. Defaults to empty so a bench can render it bare. */
  attention = EMPTY_ATTENTION,
  /** Trigger shape. `'chip'` (default) is the labelled `.gr-company` pill.
   *  `'circle'` is the compact ringed scope MARK that docks in the nav (mobile
   *  bottom-bar right, desktop rail bottom — the WHOOP "profile in the corner"
   *  slot), so the scope leaves every page header. Both open the SAME picker. */
  variant = 'chip',
  /** Register the global ⌘⇧O / ⌘1-9 shortcuts. TRUE on exactly one mounted
   *  instance — otherwise every mounted switcher toggles its own picker open on
   *  ⌘⇧O (the mobile dock's bottom sheet is body-portaled, so a `display:none`
   *  wrapper would NOT hide it). The desktop rail owns the keyboard; the mobile
   *  dock passes `false`. */
  shortcuts = true,
}: {
  attention?: ReadonlySet<number | null>
  variant?: 'chip' | 'circle'
  shortcuts?: boolean
} = {}) {
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)

  // Fork on input modality — the SAME `(pointer: coarse)` signal
  // `<ResponsiveSheet>` / the tile hover-fork use. Coarse → bottom sheet; fine →
  // the anchored menu (keyboard nav + roving highlight live here).
  const isMobile = useMediaQuery('(pointer: coarse)')

  const [open, setOpen] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  // The roving highlight index into the flat option list (0 = HQ, then each
  // company, then the New-company action last). −1 = nothing highlighted yet.
  // Only used by the desktop menu; the touch sheet ignores it.
  const [cursor, setCursor] = React.useState(-1)

  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  // Stable id so the combobox trigger can `aria-controls` its popup (required for
  // role="combobox"); the menu it names is rendered only while open, which is a
  // valid controls target.
  const menuId = React.useId()

  const active = companies.find((c) => c.id === activeCompany) ?? null

  // The flat option order the arrow keys walk: HQ, companies…, New company.
  const optionCount = 1 + companies.length + 1
  const newCompanyIndex = optionCount - 1

  const select = React.useCallback(
    (id: number | null) => {
      setActiveCompany(id)
      setOpen(false)
    },
    [setActiveCompany],
  )

  const activateIndex = React.useCallback(
    (i: number) => {
      if (i <= 0) {
        select(null) // HQ
      } else if (i === newCompanyIndex) {
        setOpen(false)
        setCreateOpen(true)
      } else {
        const c = companies[i - 1]
        if (c) select(c.id)
      }
    },
    [companies, newCompanyIndex, select],
  )

  // ── Global shortcuts: ⌘/Ctrl+⇧+O opens; ⌘/Ctrl+1..9 jumps to the Nth ─────────
  React.useEffect(() => {
    if (!shortcuts) return
    const onKey = (e: KeyboardEvent) => {
      if (!isCmdOrCtrl(e)) return
      // Open — ⌘/Ctrl+Shift+O (KeyO is layout-stable).
      if (e.shiftKey && (e.code === 'KeyO' || e.key.toLowerCase() === 'o')) {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      // Jump-to-Nth — ⌘/Ctrl+1..9, only without Shift (Shift+digit is a symbol).
      // ⌘1 is ALWAYS HQ (so HQ has a shortcut of its own); companies start at ⌘2,
      // so ⌘2 → the first company, ⌘3 → the second, and so on.
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const digit = Number(e.key)
        if (digit === 1) {
          e.preventDefault()
          setActiveCompany(null)
          setOpen(false)
          return
        }
        const c = companyForDigit(companies, digit - 1)
        if (c) {
          e.preventDefault()
          setActiveCompany(c.id)
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [companies, setActiveCompany, shortcuts])

  // Seat the highlight on the active row whenever the list opens (both shells).
  // Done on the open TRANSITION during render (the "adjust state when a prop
  // changes" pattern) rather than in an effect — so it never re-seats mid-nav
  // when the company list changes under an open menu, and never trips
  // react-hooks/set-state-in-effect.
  const [seatedOpen, setSeatedOpen] = React.useState(open)
  if (open !== seatedOpen) {
    setSeatedOpen(open)
    if (open) {
      setCursor(active ? companies.findIndex((c) => c.id === active.id) + 1 : 0)
    }
  }

  // ── Desktop only: dismiss on outside-click, focus the menu on open ───────────
  // The touch sheet is a Vaul modal — it owns its own backdrop-tap / drag-away
  // dismiss, and a document mousedown listener here would fight it (the sheet is
  // body-portaled, so a tap inside it is "outside" the trigger and would close
  // it instantly). So this only runs for the anchored menu.
  React.useEffect(() => {
    if (!open || isMobile) return
    const onDoc = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, isMobile])

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(optionCount - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(optionCount - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activateIndex(cursor < 0 ? 0 : cursor)
    }
  }

  // Focus the menu when it opens so arrow keys land without a click (desktop).
  React.useEffect(() => {
    if (open && !isMobile) menuRef.current?.focus()
  }, [open, isMobile])

  const label = active ? active.display_name : 'HQ'

  // ── One option list, skinned per shell ──────────────────────────────────────
  // `menu` = the compact desktop rows (13px, hover highlight, ⌘N hints, roving
  // cursor). `sheet` = the touch rows (≥44px tap target, 15px, tap-feedback, no
  // keyboard affordances). Authored once so the two shells never drift.
  const renderOptions = (variant: 'menu' | 'sheet') => {
    const sheet = variant === 'sheet'
    const rowBase =
      'flex w-full items-center rounded-lg text-left transition-colors focus-visible:outline-none'
    const rowSkin = sheet
      ? 'min-h-[44px] gap-3 px-3.5 py-2.5 text-[15px] active:bg-accent/60'
      : 'gap-2.5 px-3 py-2 text-[13px] hover:bg-accent/50'
    const hl = (on: boolean) => (!sheet && on ? 'bg-accent/50' : '')
    const markSize = sheet ? 28 : 24

    return (
      <>
        {/* HQ row + company rows + marks — the shared `<CompanyPicker>` list.
            The switcher keeps its roving cursor, ⌘1..9 hints, attention dots and
            the active check by feeding them in; the move sheet reuses the SAME
            list without any of that. */}
        <CompanyPicker
          variant={variant}
          companies={companies}
          onPick={select}
          activeId={activeCompany}
          attention={attention}
          cursor={cursor}
          onCursor={setCursor}
          showShortcutHints
        />

        {companies.length > 0 && (
          <div className="my-1 h-px bg-border" role="separator" />
        )}

        {/* Invite to the ACTIVE company — the onboarding-wizard entry point
            (owner dashboard only; the endpoints are owner/admin-only). Shown only
            when a company is in scope, since it invites into THAT company. */}
        {active && (
          <button
            type="button"
            role="menuitem"
            className={`${rowBase} ${rowSkin} text-foreground`}
            onMouseEnter={() => !sheet && setCursor(-1)}
            onClick={() => {
              setOpen(false)
              setInviteOpen(true)
            }}
          >
            <span
              className="grid place-items-center"
              aria-hidden
              style={{ width: markSize, height: markSize, flex: 'none' }}
            >
              <UserPlus size={sheet ? 18 : 15} />
            </span>
            Invite a teammate
          </button>
        )}

        {/* New company — always-pinned bottom action, lower emphasis */}
        <button
          type="button"
          role="menuitem"
          data-hl={cursor === newCompanyIndex || undefined}
          className={`${rowBase} ${rowSkin} text-muted-foreground ${hl(
            cursor === newCompanyIndex,
          )}`}
          onMouseEnter={() => !sheet && setCursor(newCompanyIndex)}
          onClick={() => {
            setOpen(false)
            setCreateOpen(true)
          }}
        >
          <span
            className="grid place-items-center"
            aria-hidden
            style={{ width: markSize, height: markSize, flex: 'none' }}
          >
            <Plus size={sheet ? 18 : 15} />
          </span>
          Start a company…
        </button>

        {/* Delete the ACTIVE company — a LOW-emphasis danger action (destructive
            ink on a plain row, never a filled button), separated from the safe
            actions and pinned last. Owner/admin-only server-side; a scoped
            member gets the hide-existence 404, so this row never fires for them.
            Shown only when a company is in scope, since it deletes THAT company.
            Tapping only OPENS the type-to-confirm sheet — the destroy itself is
            gated behind typing the company name. */}
        {active && (
          <>
            <div className="my-1 h-px bg-border" role="separator" />
            {/* Company settings — logo, name, accent, and (later) the shared
                brief. A safe action, so it sits above the delete danger zone. */}
            <button
              type="button"
              role="menuitem"
              className={`${rowBase} ${rowSkin}`}
              onMouseEnter={() => !sheet && setCursor(-1)}
              onClick={() => {
                setOpen(false)
                setSettingsOpen(true)
              }}
            >
              <span
                className="grid place-items-center"
                aria-hidden
                style={{ width: markSize, height: markSize, flex: 'none' }}
              >
                <SlidersHorizontal size={sheet ? 18 : 15} />
              </span>
              Company settings…
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${rowBase} ${rowSkin} text-destructive hover:bg-destructive/10 active:bg-destructive/10`}
              onMouseEnter={() => !sheet && setCursor(-1)}
              onClick={() => {
                setOpen(false)
                setDeleteOpen(true)
              }}
            >
              <span
                className="grid place-items-center"
                aria-hidden
                style={{ width: markSize, height: markSize, flex: 'none' }}
              >
                <Trash2 size={sheet ? 18 : 15} />
              </span>
              Delete this company…
            </button>
          </>
        )}
      </>
    )
  }

  return (
    <>
      <div className="relative">
        {variant === 'circle' ? (
          <button
            ref={triggerRef}
            type="button"
            className="gr-scope-circle"
            role="combobox"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={`Company scope: ${label}`}
            title={`Scope — ${label}`}
            onClick={() => setOpen((v) => !v)}
          >
            {active ? (
              <CompanyMark
                slug={active.slug}
                name={active.display_name}
                size={26}
                className="grok-identity"
                logoUrl={companyLogoUrl(active, apiToken())}
              />
            ) : (
              <HqMark size={26} />
            )}
          </button>
        ) : (
          <button
            ref={triggerRef}
            type="button"
            className="gr-company"
            role="combobox"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label="Company scope"
            onClick={() => setOpen((v) => !v)}
          >
            {active ? (
              <CompanyMark
                slug={active.slug}
                name={active.display_name}
                size={22}
                className="grok-identity"
                logoUrl={companyLogoUrl(active, apiToken())}
              />
            ) : (
              <HqMark size={22} />
            )}
            <span className="gr-company-lbl">{label}</span>
            <ChevronsUpDown size={15} className="gr-company-cv" aria-hidden />
          </button>
        )}

        {/* DESKTOP (fine pointer): the compact anchored menu, viewport-safe. The
            `circle` trigger docks at the rail's BOTTOM-LEFT, so its menu opens
            UP-and-RIGHT (bottom-aligned, to the side) instead of downward off the
            screen edge; the chip keeps the under-the-trigger drop. */}
        {open && !isMobile && (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            tabIndex={-1}
            aria-label="Companies"
            onKeyDown={onMenuKey}
            // `left-0` anchors it under the (leftmost) trigger; the inline width
            // cap `min(300px, 100vw−24px)` guarantees it can never spill past the
            // right viewport edge on any width — the collision-safe replacement
            // for the old fixed `w-[300px]`.
            style={{ width: 'min(300px, calc(100vw - 24px))' }}
            className={
              variant === 'circle'
                ? 'gr-cmenu absolute bottom-0 left-full z-30 ml-2 flex flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg outline-none'
                : 'gr-cmenu absolute left-0 top-full z-30 mt-1.5 flex flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-lg outline-none'
            }
          >
            {renderOptions('menu')}

            {/* footer — the open shortcut hint */}
            <div className="mt-0.5 px-3 pb-0.5 pt-1">
              <OpenHint />
            </div>
          </div>
        )}
      </div>

      {/* MOBILE (coarse pointer): the SAME `<ResponsiveSheet>` bottom sheet the
          create flow uses — full width, grabber, safe-area padding, scrollable,
          every row fully visible. No hand-rolled drawer. */}
      {isMobile && (
        <ResponsiveSheet
          open={open}
          onOpenChange={setOpen}
          title="Companies"
          description="Switch which org the roster is scoped to"
          footer={<OpenHint />}
        >
          <div
            role="menu"
            aria-label="Companies"
            className="flex flex-col gap-0.5 px-2 py-2"
          >
            {renderOptions('sheet')}
          </div>
        </ResponsiveSheet>
      )}

      {createOpen && (
        <React.Suspense fallback={null}>
          <CreateCompanySheet
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreated={(id) => {
              setActiveCompany(id)
              setCreateOpen(false)
            }}
          />
        </React.Suspense>
      )}

      {inviteOpen && active && (
        <React.Suspense fallback={null}>
          <InviteWizardSheet
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            company={{ id: active.id, slug: active.slug, display_name: active.display_name }}
          />
        </React.Suspense>
      )}

      {deleteOpen && active && (
        <React.Suspense fallback={null}>
          <DeleteCompanySheet
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            company={{ id: active.id, slug: active.slug, display_name: active.display_name }}
            onDeleted={() => {
              // The row is gone — leave its now-dead scope for HQ immediately
              // (a lingering id would fail open to HQ on the next refetch anyway;
              // this makes the switch instant). The sheet decides whether to
              // then close itself or hold open on its honest warnings view.
              setActiveCompany(null)
            }}
          />
        </React.Suspense>
      )}

      {settingsOpen && active && (
        <React.Suspense fallback={null}>
          <CompanySettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} company={active} />
        </React.Suspense>
      )}
    </>
  )
}

/**
 * `<ScopeTitle>` — the READ-ONLY scope identity for a page header (the overview
 * leads with it). It shows the active scope's mark + name exactly as the switcher
 * chip did, but it is NOT a control: switching now lives in the nav scope circle
 * (`<CompanySwitcher variant="circle">`), so the page just REFLECTS the active
 * scope while the nav OWNS the switch. Presentational — no picker, no state.
 */
export function ScopeTitle() {
  const { companies } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const active = companies.find((c) => c.id === activeCompany) ?? null
  return (
    <span className="gr-scope-title">
      {active ? (
        <CompanyMark
          slug={active.slug}
          name={active.display_name}
          size={24}
          className="grok-identity"
          logoUrl={companyLogoUrl(active, apiToken())}
        />
      ) : (
        <HqMark size={24} />
      )}
      <span className="gr-scope-title-lbl">{active ? active.display_name : 'HQ'}</span>
    </span>
  )
}
