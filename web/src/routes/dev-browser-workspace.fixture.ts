// Fixtures for /dev/browser-workspace — eleven tabs that between them cover every
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
//   · a tab lent via `*`, so the sheet's shared-grant honesty line renders;
//   · a tab with KEEP-ME-SIGNED-IN on and healthy, one in WATCH mode, and one
//     that is on but has NOT been able to check — the three states whose ⋯
//     detail line has to stay legible at 390px, and the only place the longest
//     string this feature ships gets drawn.
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
    grants: [],
    created_at: NOW - 50_000,
    last_used_at: NOW - 20_000,
  },
  {
    // KEEP ME SIGNED IN, on and healthy — the ⋯ row reads
    // "Every 45 min · checked 12 min ago." at 390px.
    id: 'tb_keepalive',
    title: 'Seller Central',
    url: 'https://seller.example/orders',
    pinned: false,
    company_id: null,
    origins: ['seller.example'],
    login_state: 'ok',
    last_probe_at: NOW - 720,
    live: true,
    keepalive_enabled: true,
    keepalive_every: 45,
    keepalive_action: 'soft',
    last_keepalive_at: NOW - 720,
    grants: [grant('tb_keepalive', 'Ada')],
    created_at: NOW - 300_000,
    last_used_at: NOW - 1_200,
  },
  {
    // ON BUT STUCK — the honest line. Every tick completes (the row is stamped
    // one minute ago) and every ping fails, so the age has to come from
    // `last_probe_at`; taking it from the stamp rendered "checked 1 min ago"
    // over a tab that has learned nothing for a day.
    id: 'tb_stuck',
    title: 'Warehouse portal',
    url: 'https://wms.example/dash',
    pinned: false,
    company_id: null,
    origins: ['wms.example'],
    login_state: 'ok',
    last_probe_at: NOW - 86_400,
    live: true,
    keepalive_enabled: true,
    keepalive_every: 15,
    last_keepalive_at: NOW - 60,
    keepalive_action: 'soft',
    grants: [grant('tb_stuck', 'Ada')],
    created_at: NOW - 500_000,
    last_used_at: NOW - 4_000,
  },
  {
    // WATCH MODE — the one state where supermux says no. Its copy is the
    // longest string this feature ships, so the bench is where the two-line
    // clamp is checked for real.
    id: 'tb_watch',
    title: 'Zakelijk — Bank (watch)',
    url: 'https://short-session.example/portal',
    pinned: false,
    company_id: null,
    origins: ['short-session.example'],
    login_state: 'ok',
    last_probe_at: NOW - 300,
    live: true,
    keepalive_enabled: true,
    keepalive_every: 10,
    keepalive_action: 'watch',
    last_keepalive_at: NOW - 300,
    grants: [],
    created_at: NOW - 400_000,
    last_used_at: NOW - 2_400,
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
    keepalive_enabled: false,
    keepalive_every: 15,
    keepalive_action: 'reload',
    last_keepalive_at: null,
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
