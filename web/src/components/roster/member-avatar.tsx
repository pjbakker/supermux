/**
 * `<MemberAvatar>` — the roster header's account slot for an INVITED COLLEAGUE.
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER BUG #3, second half. The avatar was a hard-coded `SB` monogram whose only
 * job was to open Settings: right for the owner (it is their box), wrong for a
 * colleague, who saw somebody else's initials and a doorway into the owner's
 * admin plane.
 *
 * The OWNER's button stays inlined in `grok-roster.tsx`, byte-identical. This
 * file is the member's replacement and is LAZY — an owner never loads it: their
 * `<HumanMark>`, the account sheet and the sign-out round-trip have no business
 * on the cold hero path.
 *
 * The menu is the app's canonical `<ResponsiveSheet>` (bottom sheet on touch,
 * side panel on a mouse), not a hand-rolled anchored popover: the header it docks
 * in is a flex row inside a clipped shell — exactly the geometry that made the
 * desktop company switcher invisible before #144.
 */
import * as React from 'react'

import { HumanMark } from '@/components/roster/human-mark'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { authApi } from '@/lib/api/auth'
import { useViewer } from '@/stores/viewer-store'

export function MemberAvatar() {
  const viewer = useViewer((s) => s.viewer)
  const signOut = useViewer((s) => s.signOut)
  const [menuOpen, setMenuOpen] = React.useState(false)

  if (viewer.kind !== 'member') return null

  const name = viewer.displayName.trim()
  const label = name || viewer.email || 'You'

  const doSignOut = async () => {
    // Revoke the session server-side (CSRF double-submit), drop any local key,
    // then reload so every store, query and socket re-resolves from scratch.
    await authApi.logout()
    signOut()
    window.location.reload()
  }

  return (
    <>
      <button
        type="button"
        className="gr-me"
        aria-label={`${label} — account`}
        title={label}
        onClick={() => setMenuOpen(true)}
      >
        {/* `seed` is the IMMUTABLE user id, `name` only the monogram source —
            the hue firewall, so a rename never recolours them. */}
        <HumanMark seed={String(viewer.userId)} name={name} size={30} />
      </button>

      <ResponsiveSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={label}
        description={viewer.email || 'Signed in'}
      >
        <div className="flex flex-col p-2">
          <button
            type="button"
            onClick={() => void doSignOut()}
            className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-left text-[15px] transition-colors hover:bg-accent active:bg-accent"
          >
            Sign out
          </button>
        </div>
      </ResponsiveSheet>
    </>
  )
}
