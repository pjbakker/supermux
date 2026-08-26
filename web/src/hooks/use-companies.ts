// Companies (Bot Mode, migration 0030) — the TanStack Query surface the
// `<CompanySwitcher>` reads and mutates. Mirrors `use-sessions`: one query keyed
// `['companies']`, mutations that invalidate that key so every subscriber
// (switcher, new-agent default) re-reads one source of truth.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  companiesApi,
  type Company,
  type DeleteCompanyResult,
  type NewCompany,
} from '@/lib/api'
import { devMockActive, SESSIONS_KEY } from '@/hooks/use-sessions'

export const COMPANIES_KEY = ['companies'] as const

export interface UseCompaniesResult {
  companies: Company[]
  isLoading: boolean
  isError: boolean
}

/** `GET /api/companies` → the live (non-archived) company list. Ordered by
 *  `display_name` server-side; the switcher renders it as-is. */
export function useCompanies(): UseCompaniesResult {
  const query = useQuery({
    queryKey: COMPANIES_KEY,
    queryFn: companiesApi.list,
    staleTime: 30_000,
    // DEV `?mock`: the seed populates the cache; disable the live fetch so it
    // can't overwrite the seeded companies (mirrors useSessions).
    enabled: !devMockActive(),
  })
  return {
    companies: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  }
}

/** `POST /api/companies` — create a company; invalidates `['companies']` so the
 *  switcher shows it at once. Resolves to the created row (the caller selects
 *  it as the active company). */
export function useCreateCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: NewCompany): Promise<Company> => companiesApi.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: COMPANIES_KEY })
    },
  })
}

/** `DELETE /api/companies/{id}` — the DESTRUCTIVE cascade delete. Invalidates
 *  BOTH `['companies']` (the row is gone → drop it from the switcher) AND
 *  `['sessions']` (every bot the cascade tore down — the Main Assistant
 *  included — must leave the roster). Resolves to the server's
 *  {@link DeleteCompanyResult} so the caller can surface `warnings` honestly.
 *  The confirm sheet gates this behind type-to-confirm; the hook itself is a
 *  plain mutation with no client-side guard of its own. */
export function useDeleteCompany() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number): Promise<DeleteCompanyResult> => companiesApi.delete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: COMPANIES_KEY })
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
    },
  })
}
