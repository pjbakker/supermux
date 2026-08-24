// Fixtures for /dev/browser-workspace — eight tabs that between them cover every
// state the rail has to draw, offline.
//
// Chosen deliberately, not decoratively:
//   · a PINNED, signed-in tab (the happy path, and the sticky-left case on ≥md);
//   · a NEEDS_LOGIN tab (the honest-expiry state — §7.3's whole reason to exist);
//   · a DEHYDRATED tab (row without a page: the reap survived it);
//   · a live-but-never-probed tab (the "Not verified" state that must NOT read
//     as signed in);
//   · a tab with a 90-character title, which is the exact input that breaks a
//     rail that is not `min-w-0` + fixed-width all the way down;
//   · a tab lent via `*`, so the sheet's shared-grant honesty line renders.
//
// DEV-only and lazily imported by the bench route, so none of it reaches the
// production bundle.

import type { BrowserTab, GrantCandidate, TabGrant } from '@/lib/api/browser'

/** Deterministic-ish: everything is expressed as an offset from load, so the
 *  age lines ("verified 6 min ago") render the same on every capture. */
const NOW = Math.floor(Date.now() / 1000)

function grant(tab_id: string, grantee: string): TabGrant {
  return { tab_id, grantee, enabled: 1, granted_at: NOW - 86_400 }
}

export const BENCH_TABS: BrowserTab[] = [
  {
    id: 'tb_mail',
    title: 'Inbox — Acme Mail',
    url: 'https://mail.acme.example/inbox',
    pinned: true,
    company_id: null,
    origins: ['mail.acme.example'],
    login_state: 'ok',
    last_probe_at: NOW - 360,
    live: true,
    grants: [grant('tb_mail', 'Ada')],
    created_at: NOW - 604_800,
    last_used_at: NOW - 120,
  },
  {
    id: 'tb_bank',
    title: 'Zakelijk — Bank',
    url: 'https://bank.example/portal',
    pinned: true,
    company_id: null,
    origins: ['bank.example'],
    login_state: 'needs_login',
    last_probe_at: NOW - 900,
    live: true,
    grants: [grant('tb_bank', 'Grace')],
    created_at: NOW - 1_209_600,
    last_used_at: NOW - 3_600,
  },
  {
    id: 'tb_crm',
    title: 'Pipeline · CRM',
    url: 'https://crm.example/deals',
    pinned: false,
    company_id: null,
    origins: ['crm.example', '.example'],
    login_state: 'ok',
    last_probe_at: NOW - 5_400,
    live: false,
    grants: [grant('tb_crm', '*')],
    created_at: NOW - 259_200,
    last_used_at: NOW - 7_200,
  },
  {
    id: 'tb_analytics',
    title: 'Analytics',
    url: 'https://analytics.example/reports/weekly',
    pinned: false,
    company_id: null,
    origins: ['analytics.example'],
    login_state: 'unknown',
    last_probe_at: null,
    live: true,
    grants: [],
    created_at: NOW - 172_800,
    last_used_at: NOW - 9_000,
  },
  {
    id: 'tb_long',
    title:
      'Quarterly reseller back-office — invoices, credit notes, and the settlement export nobody has automated',
    url: 'https://reseller.example/back-office/invoices?period=q3&view=settlement',
    pinned: false,
    company_id: null,
    origins: ['reseller.example'],
    login_state: 'ok',
    last_probe_at: NOW - 60,
    live: true,
    grants: [],
    created_at: NOW - 86_400,
    last_used_at: NOW - 10_000,
  },
  {
    id: 'tb_ads',
    title: 'Ads Manager',
    url: 'https://ads.example/campaigns',
    pinned: false,
    company_id: null,
    origins: ['ads.example'],
    login_state: 'needs_login',
    last_probe_at: NOW - 43_200,
    live: false,
    grants: [],
    created_at: NOW - 432_000,
    last_used_at: NOW - 43_200,
  },
  {
    id: 'tb_docs',
    title: 'Handbook',
    url: 'http://docs.internal/handbook',
    pinned: false,
    company_id: null,
    origins: ['docs.internal'],
    login_state: 'ok',
    last_probe_at: NOW - 240,
    live: true,
    grants: [],
    created_at: NOW - 50_000,
    last_used_at: NOW - 20_000,
  },
  {
    id: 'tb_support',
    title: 'Support desk',
    url: 'https://support.example/queue',
    pinned: false,
    company_id: null,
    origins: ['support.example'],
    login_state: 'ok',
    last_probe_at: NOW - 1_800,
    live: false,
    grants: [],
    created_at: NOW - 90_000,
    last_used_at: NOW - 30_000,
  },
]

/** The bots the grant sheet offers as the "This bot" tier. All HQ, like the
 *  fixture tabs — a company-owned bot would (correctly) be filtered out of
 *  every one of them. */
export const BENCH_BOTS: GrantCandidate[] = [
  { name: 'Ada', company_id: null },
  { name: 'Grace', company_id: null },
  { name: 'Linus', company_id: null },
]
