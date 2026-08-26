/**
 * `useMoveSessionCompany` — the mutation behind "Move to company…" (bot-move,
 * migration 0032). Mirrors `useCreateCompany` / `useSetSessionConfig`: one
 * `useMutation` calling `sessionsApi.moveCompany`, invalidating BOTH the
 * `['sessions']` and `['companies']` query keys on success so every scoped
 * roster + the switcher re-read one source of truth.
 *
 * The move is FS-first + a single atomic DB tx server-side (no SSE fan-out we
 * can rely on for the caller's own tab), so the invalidate is what re-homes the
 * tile — the moved bot leaves the current scope and lands in the destination.
 *
 * NB: this lives in `hooks/` (not `lib/api/sessions.ts`) because the API client
 * there is deliberately React-free — every other react-query hook in the app
 * (`useCreateCompany`, `useSessionConfig`) sits under `hooks/` for the same
 * reason. The pure request stays in `sessionsApi.moveCompany`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { sessionsApi, type MoveCompanyResult } from '@/lib/api/sessions'
import { SESSIONS_KEY } from '@/hooks/use-sessions'
import { COMPANIES_KEY } from '@/hooks/use-companies'

export interface MoveSessionCompanyVars {
  name: string
  /** Destination — `null` = HQ / main, a number = that company. */
  companyId: number | null
}

/** `POST /api/sessions/{name}/company`. Resolves to the honest move receipt
 *  ([`MoveCompanyResult`]) so the caller can render `warnings[]` /
 *  `dropped_grants[]` and the restart hint. */
export function useMoveSessionCompany() {
  const qc = useQueryClient()
  return useMutation<MoveCompanyResult, Error, MoveSessionCompanyVars>({
    mutationFn: ({ name, companyId }) => sessionsApi.moveCompany(name, companyId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
      void qc.invalidateQueries({ queryKey: COMPANIES_KEY })
    },
  })
}
