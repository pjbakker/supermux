import { defineConfig } from '@playwright/test'
import { HARDENED_HOST_CHROMIUM_ARGS } from './tests/e2e/launch-args'

// Smoke e2e — the early-warning suite (79 tests across 49 spec files; 73 of them
// eligible on a hosted runner, see the @slow / @needs-claude note below). Every
// test runs against a REAL supermux-server binary booted per-test on an ephemeral
// port with an isolated temp data dir (see tests/e2e/smoke/harness.ts).
//
// No global webServer: each spec boots its own backend + Vite dev server through
// the harness so a backend-kill/restart test (ws-reconnect) can drive the
// process lifecycle directly. Vite proxies /api + /ws to the backend SAME-ORIGIN
// (vite.config.ts reads SUPERMUX_E2E_BACKEND), so the app runs exactly as it does
// behind the embedded static server — no CORS, no cross-origin WebSocket.
//
// TIMINGS. A boot-per-test suite is dominated by the boot: ~20s of binary + Vite
// + tmux settle per test, so the whole suite is ~25 min end to end and one spec
// file is ~30s. CI does NOT run it as one job — `ci.yml` shards it four ways
// (`--shard=i/4`), each shard a fresh runner with its own binary and its own
// `workers: 1`, which puts the e2e job's critical path at roughly a quarter of
// the suite plus a two-minute artifact download. Do not raise `workers` to claw
// that back: the harness's tmux/port pressure is why it is 1, and shards buy the
// same parallelism across machines that do not share it.
export default defineConfig({
  testDir: './tests/e2e/smoke',
  // Serial: each test owns a tmux-backed binary + dev server; running them in
  // parallel would multiply port/tmux pressure on one machine. Parallelism comes
  // from `--shard` across CI runners instead (see the TIMINGS note above).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Retries are NOT global — see the `chromium-flaky` project below. A blanket
  // `retries: 1` costs nothing on a green run but it lets a genuinely
  // nondeterministic spec pass on the second try forever, unnoticed, which is
  // how a suite rots into "just re-run it". A spec that flakes earns the tag.
  retries: 0,
  // 60 s, and the number is a MEASUREMENT of the ceiling a failure is allowed
  // to cost, not a guess at how long a test needs.
  //
  // Measured over all four shards of CI run 33318390754: the slowest passing
  // test that does NOT set its own budget finished in 32 s; every test above
  // that (126 s, 90 s, 66 s) already calls `test.setTimeout` because it waits
  // out a product clock. So 60 s is ~1.9x the real worst case and no passing
  // test is anywhere near it.
  //
  // What it buys is the failure path. That same run spent 1795 s — 76% of ALL
  // e2e test time — on tests that failed, each one sitting out the old 90 s
  // before Playwright would call it. In a ten-minute PR budget the cost of
  // being wrong has to be bounded too: a spec that has already hung for a
  // minute is not going to recover, it is going to be read by a human. A test
  // that genuinely needs longer says so in its own file, where the reason is
  // visible next to the code.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Opt into a no-sandbox, no-zygote, no-GPU launch via env for hardened
    // runners (the self-host box, a CI container) — see tests/e2e/launch-args.ts
    // for what each flag buys and why `--single-process` is NOT among them.
    // Default keeps the full sandbox ON for normal dev/CI where it works.
    launchOptions: process.env.SUPERMUX_E2E_NO_SANDBOX
      ? { args: HARDENED_HOST_CHROMIUM_ARGS }
      : {},
  },
  projects: [
    // Two chromium projects, split by tag, so RETRIES are scoped rather than
    // global. Everything untagged runs once and must be deterministic; a spec
    // whose nondeterminism is understood and accepted gets `@flaky` in its title
    // and lands in the second project, which retries it twice in CI. The tag is
    // the record: `grep -rn '@flaky' tests/e2e/smoke` is the list of specs the
    // suite does not fully trust, and it is empty today.
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      grepInvert: /@flaky/,
    },
    {
      name: 'chromium-flaky',
      use: { browserName: 'chromium' },
      grep: /@flaky/,
      retries: process.env.CI ? 2 : 0,
    },
    // Opt-in WebKit project — the closest proxy to iOS Safari / WKWebView, the
    // platform the mobile touch-scroll specs actually target. Off by default so
    // CI (and machines without the WebKit build) stay chromium-only and green;
    // enable with `SUPERMUX_E2E_WEBKIT=1 npx playwright test --project=webkit`
    // (needs `npx playwright install webkit`). The mobile specs build touch
    // events cross-engine via `touchDragY` in harness.ts, so they run on both.
    ...(process.env.SUPERMUX_E2E_WEBKIT
      ? [{ name: 'webkit', use: { browserName: 'webkit' as const } }]
      : []),
  ],
})
