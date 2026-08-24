/**
 * The Files v1 data layer — the four pure pieces the whole feature rides on.
 * ─────────────────────────────────────────────────────────────────────────────
 * `web/src/components/files/*` had NO tests before this work. v1 does not
 * retrofit coverage for what was already there, but everything it ADDS is
 * pinned here, because each of these four is a rule that fails SILENTLY when it
 * is wrong:
 *
 *   • `companyForPath` — the client mirror of the server's ONE stamping rule.
 *     A sibling-prefix bug (`…/acme-corp` read as inside `…/acme`) files a
 *     bot's activity under the wrong company on the landing grid.
 *   • `mapWithLimit`   — the bulk fan-out. Exceeding the window hammers a small
 *     VPS; losing order mislabels which item failed; letting one rejection
 *     escape turns "3 moved · 1 failed" into "the move failed".
 *   • `summarizeBulk`  — the honesty rule. A partial failure rounded up to
 *     success is the single worst thing this feature could do.
 *   • `filesLiveActions` — the SSE invalidation, including the DIRTY GUARD: a
 *     refetch over an unsaved editor draft is exactly the data loss the PUT
 *     409 guard exists to prevent, arriving through the back door.
 */
import { describe, expect, test } from 'bun:test'

import { companyForPath, type Company } from '@/lib/companies'
import { mapWithLimit, type Settled } from '@/lib/concurrency'
import { duplicateName, summarizeBulk } from '@/lib/files-bulk'
import {
  applyFilesFrame,
  filesLiveActions,
  parseFilesFrame,
} from '@/hooks/use-files'

function company(over: Partial<Company> & { id: number }): Company {
  return {
    slug: `c${over.id}`,
    display_name: `C${over.id}`,
    root_dir: `/srv/c${over.id}`,
    archived: 0,
    ...over,
  }
}

// ── companyForPath ────────────────────────────────────────────────────────────

describe('companyForPath — longest /-delimited root_dir prefix', () => {
  const acme = company({ id: 1, slug: 'acme', root_dir: '/srv/acme' })
  const acmeCorp = company({ id: 2, slug: 'acme-corp', root_dir: '/srv/acme-corp' })
  const nested = company({ id: 3, slug: 'inner', root_dir: '/srv/acme/inner' })
  const all = [acme, acmeCorp, nested]

  test('the company root itself matches', () => {
    expect(companyForPath('/srv/acme', all)?.id).toBe(1)
  })

  test('a nested path matches its owner', () => {
    expect(companyForPath('/srv/acme/docs/report.md', all)?.id).toBe(1)
  })

  test('a SIBLING PREFIX is not containment (…/acme-corp is not inside …/acme)', () => {
    expect(companyForPath('/srv/acme-corp/x.txt', all)?.id).toBe(2)
  })

  test('the LONGEST match wins when one root nests inside another', () => {
    expect(companyForPath('/srv/acme/inner/x.txt', all)?.id).toBe(3)
  })

  test('a path under no company root is HQ (null), never a convenient guess', () => {
    expect(companyForPath('/home/supermux/notes.md', all)).toBe(null)
  })

  test('a trailing slash on either side does not change the answer', () => {
    expect(companyForPath('/srv/acme/', all)?.id).toBe(1)
    expect(
      companyForPath('/srv/acme/x', [company({ id: 9, root_dir: '/srv/acme/' })])
        ?.id,
    ).toBe(9)
  })

  test('an empty root_dir never matches (it would swallow every path)', () => {
    expect(companyForPath('/anything', [company({ id: 4, root_dir: '' })])).toBe(
      null,
    )
  })
})

// ── mapWithLimit ──────────────────────────────────────────────────────────────

describe('mapWithLimit — the bulk fan-out', () => {
  test('never exceeds the window, and finishes everything', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapWithLimit(
      Array.from({ length: 17 }, (_, i) => i),
      4,
      async (n) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        await Promise.resolve()
        inFlight -= 1
        return n * 2
      },
    )
    expect(peak).toBeLessThanOrEqual(4)
    expect(out).toHaveLength(17)
    expect(out.every((r) => r.status === 'fulfilled')).toBe(true)
  })

  test('preserves INPUT order regardless of settle order', async () => {
    const out = await mapWithLimit([3, 1, 2], 4, async (n) => {
      // Reverse the settle order: 3 resolves last.
      for (let i = 0; i < n * 3; i += 1) await Promise.resolve()
      return n
    })
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      3, 1, 2,
    ])
  })

  test('a rejection lands in ITS OWN slot and the batch keeps going', async () => {
    const out = await mapWithLimit(['a', 'boom', 'c'], 2, async (s) => {
      if (s === 'boom') throw new Error('destination exists')
      return s.toUpperCase()
    })
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'A' })
    expect(out[1]!.status).toBe('rejected')
    expect((out[1] as { reason: Error }).reason.message).toBe(
      'destination exists',
    )
    expect(out[2]).toEqual({ status: 'fulfilled', value: 'C' })
  })

  test('an empty input is an empty result, not a hang', async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([])
  })

  test('limit 0 degrades to sequential instead of deadlocking', async () => {
    const out = await mapWithLimit([1, 2], 0, async (n) => n)
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      1, 2,
    ])
  })
})

// ── summarizeBulk ─────────────────────────────────────────────────────────────

function ok<R>(value: R): Settled<R> {
  return { status: 'fulfilled', value }
}
function bad(message: string): Settled<never> {
  return { status: 'rejected', reason: new Error(message) }
}

describe('summarizeBulk — one honest line', () => {
  test('all succeeded reads as a plain count', () => {
    const s = summarizeBulk('move', [ok(1), ok(2), ok(3), ok(4)])
    expect(s.message).toBe('4 moved')
    expect(s.tone).toBe('default')
  })

  test('PARTIAL failure is reported as partial, with the SERVER’s reason', () => {
    const s = summarizeBulk('move', [
      ok(1),
      ok(2),
      ok(3),
      ok(4),
      bad('destination exists'),
    ])
    expect(s.message).toBe('4 moved · 1 failed: destination exists')
    // Not "4 of 5 moved" dressed as a success — anything failing is an error.
    expect(s.tone).toBe('error')
    expect(s.ok).toBe(4)
    expect(s.failed).toBe(1)
  })

  test('disagreeing reasons name the first and count the OTHER KINDS', () => {
    const s = summarizeBulk('copy', [
      ok(1),
      bad('destination exists'),
      bad('permission denied'),
      bad('destination exists'),
    ])
    // 3 failures, 2 distinct reasons → "+1 other reason". NOT "+2 more",
    // which would read as two further failures beyond the three counted.
    expect(s.message).toBe(
      '1 copied · 3 failed: destination exists (+1 other reason)',
    )
  })

  test('three distinct reasons pluralise honestly', () => {
    const s = summarizeBulk('move', [bad('a'), bad('b'), bad('c')])
    expect(s.message).toBe('0 moved · 3 failed: a (+2 other reasons)')
  })

  test('everything failing still states the zero honestly', () => {
    const s = summarizeBulk('delete', [bad('permission denied'), bad('permission denied')])
    expect(s.message).toBe('0 deleted · 2 failed: permission denied')
    expect(s.tone).toBe('error')
  })

  test('a non-Error rejection degrades to a truthful placeholder', () => {
    const s = summarizeBulk('download', [{ status: 'rejected', reason: { x: 1 } }])
    expect(s.message).toBe('0 downloaded · 1 failed: unknown error')
  })
})

describe('duplicateName — the Duplicate row action’s 409 ladder', () => {
  test('first attempt tags the stem, keeping the extension', () => {
    expect(duplicateName('report.md', 1)).toBe('report (copy).md')
  })

  test('later attempts number the tag', () => {
    expect(duplicateName('report.md', 2)).toBe('report (copy 2).md')
    expect(duplicateName('report.md', 3)).toBe('report (copy 3).md')
  })

  test('an extensionless name keeps its whole name as the stem', () => {
    expect(duplicateName('Makefile', 1)).toBe('Makefile (copy)')
  })

  test('a DOTFILE is a stem, not an extension (.env, not (copy).env)', () => {
    expect(duplicateName('.env', 1)).toBe('.env (copy)')
  })
})

// ── the SSE frame + its invalidation ──────────────────────────────────────────

const DIR = '/srv/acme/docs'
const OPEN = '/srv/acme/docs/report.md'

function frame(over: Partial<ReturnType<typeof mkFrame>> = {}) {
  return { ...mkFrame(), ...over }
}
function mkFrame() {
  return {
    op: 'write',
    path: OPEN,
    dir: DIR as string | null,
    from: null as string | null,
    session: 'researcher' as string | null,
  }
}

describe('parseFilesFrame — a frame we cannot place is dropped', () => {
  test('a full frame parses', () => {
    expect(
      parseFilesFrame({ op: 'rename', path: '/a/b', dir: '/a', from: '/a/c', session: null }),
    ).toEqual({ op: 'rename', path: '/a/b', dir: '/a', from: '/a/c', session: null })
  })

  test('no path ⇒ null (guessing is how an invalidation storm starts)', () => {
    expect(parseFilesFrame({ op: 'write', dir: '/a' })).toBe(null)
    expect(parseFilesFrame({ path: '' })).toBe(null)
    expect(parseFilesFrame(null)).toBe(null)
    expect(parseFilesFrame('files')).toBe(null)
  })

  test('a missing dir is null, never derived — the FE must not dirname()', () => {
    expect(parseFilesFrame({ path: '/a/b' })?.dir).toBe(null)
  })
})

describe('filesLiveActions — what one frame invalidates', () => {
  test('a frame for the OPEN directory refreshes its listing', () => {
    const a = filesLiveActions(frame({ path: `${DIR}/new.txt` }), {
      dirPath: DIR,
      openPath: null,
      dirty: false,
    })
    expect(a.invalidate).toEqual([['files', 'ls', DIR]])
  })

  test('the listing key is a PREFIX — it covers both hidden variants', () => {
    const a = filesLiveActions(frame({ path: `${DIR}/new.txt` }), {
      dirPath: DIR,
      openPath: null,
      dirty: false,
    })
    // `['files','ls', dir]` and NOT `[…, dir, hidden]`: TanStack matches by
    // prefix, so one key hits both `hidden:true` and `hidden:false`.
    expect(a.invalidate[0]).toHaveLength(3)
  })

  test('a frame for ANOTHER directory refreshes nothing', () => {
    const a = filesLiveActions(
      frame({ path: '/srv/globex/x.txt', dir: '/srv/globex' }),
      { dirPath: DIR, openPath: null, dirty: false },
    )
    expect(a.invalidate).toEqual([])
  })

  test('a rename OUT of the open dir still refreshes it (via `from`)', () => {
    const a = filesLiveActions(
      frame({ op: 'rename', path: '/srv/acme/archive/report.md', dir: '/srv/acme/archive', from: OPEN }),
      { dirPath: DIR, openPath: null, dirty: false },
    )
    expect(a.invalidate).toEqual([['files', 'ls', DIR]])
  })

  test('the OPEN file refetches when the buffer is CLEAN', () => {
    const a = filesLiveActions(frame(), {
      dirPath: DIR,
      openPath: OPEN,
      dirty: false,
    })
    expect(a.invalidate).toEqual([
      ['files', 'ls', DIR],
      ['files', 'file', OPEN],
    ])
    expect(a.staleOpenFile).toBe(false)
  })

  test('THE DIRTY GUARD: a dirty buffer is NEVER refetched over', () => {
    const a = filesLiveActions(frame(), {
      dirPath: DIR,
      openPath: OPEN,
      dirty: true,
    })
    // The directory still refreshes (the row's size/mtime moved); the FILE
    // does not, and the caller is told to surface a conflict instead.
    expect(a.invalidate).toEqual([['files', 'ls', DIR]])
    expect(a.staleOpenFile).toBe(true)
  })

  test('on the Spaces landing (no dirPath) nothing is invalidated', () => {
    const a = filesLiveActions(frame(), {
      dirPath: null,
      openPath: null,
      dirty: false,
    })
    expect(a.invalidate).toEqual([])
  })
})

// ── the whole SSE hop, against a stub query client ────────────────────────────

describe('applyFilesFrame — one frame, end to end', () => {
  const ACME: Company = company({ id: 1, slug: 'acme', root_dir: '/srv/acme' })
  const GLOBEX: Company = company({ id: 2, slug: 'globex', root_dir: '/srv/globex' })

  function stub() {
    const invalidated: (readonly unknown[])[] = []
    const recorded: { key: string; path: string }[] = []
    const stale: string[] = []
    return {
      invalidated,
      recorded,
      stale,
      sinks: {
        invalidate: (k: readonly unknown[]) => void invalidated.push(k),
        record: (key: string, a: { path: string }) =>
          void recorded.push({ key, path: a.path }),
        markStale: (p: string) => void stale.push(p),
      },
    }
  }

  test('the frame is filed under the company that OWNS THE PATH', () => {
    const s = stub()
    applyFilesFrame(
      { op: 'write', path: '/srv/globex/x.md', dir: '/srv/globex', from: null, session: 'bo' },
      { dirPath: DIR, openPath: null, dirty: false },
      [ACME, GLOBEX],
      s.sinks,
      123,
    )
    // Stamped by PATH, never by the emitting session's company — an owner-run
    // HQ bot can write into any company's folder.
    expect(s.recorded).toEqual([{ key: '2', path: '/srv/globex/x.md' }])
    // …and a frame for a directory we are not looking at invalidates nothing.
    expect(s.invalidated).toEqual([])
  })

  test('an HQ path (under no company root) is filed under "hq"', () => {
    const s = stub()
    applyFilesFrame(
      { op: 'write', path: '/home/me/notes.md', dir: '/home/me', from: null, session: null },
      { dirPath: null, openPath: null, dirty: false },
      [ACME, GLOBEX],
      s.sinks,
      1,
    )
    expect(s.recorded[0]!.key).toBe('hq')
  })

  test('the OPEN directory is invalidated, and a clean open file refetched', () => {
    const s = stub()
    applyFilesFrame(
      { op: 'write', path: OPEN, dir: DIR, from: null, session: 'bo' },
      { dirPath: DIR, openPath: OPEN, dirty: false },
      [ACME],
      s.sinks,
      1,
    )
    expect(s.invalidated).toEqual([
      ['files', 'ls', DIR],
      ['files', 'file', OPEN],
    ])
    expect(s.stale).toEqual([])
  })

  test('A DIRTY DRAFT IS NEVER REFETCHED OVER — it is reported instead', () => {
    const s = stub()
    applyFilesFrame(
      { op: 'write', path: OPEN, dir: DIR, from: null, session: 'bo' },
      { dirPath: DIR, openPath: OPEN, dirty: true },
      [ACME],
      s.sinks,
      1,
    )
    expect(s.invalidated).toEqual([['files', 'ls', DIR]])
    expect(s.stale).toEqual([OPEN])
    // The activity line still updates: the bot's write is real either way.
    expect(s.recorded[0]!.key).toBe('1')
  })
})
