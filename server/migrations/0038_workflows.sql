-- 0038_workflows.sql
-- Workflows replace schedules. A workflow is a bot + an ORDERED list of prompt
-- steps + a trigger + a typed completion action. The three dragon surfaces of
-- 0003 (kind='shell', kind='boot', done_action LIKE 'command:%') do not exist
-- here and cannot be expressed: the CHECKs below are exhaustive enumerations.
-- There is no LIKE in any CHECK in this file -- 0003's
-- `OR done_action LIKE 'command:%'` is exactly how the dragon got in.
--
-- This migration creates the new tables, ARCHIVES every pre-drop `schedules`
-- row as JSON, ports the ones that can be ported honestly, and DROPS the old
-- three tables -- all inside the single implicit transaction sqlx runs a
-- migration in. There is therefore never a window in which both systems are
-- live and both could fire.
--
-- IMMUTABLE ONCE SHIPPED (sqlx checksums migrations). A correction is 0039.

-- ── 1. schema ────────────────────────────────────────────────────────────────

CREATE TABLE workflows (
    id            TEXT PRIMARY KEY,                 -- 'WF-xxxxxxxx'; ported rows KEEP their 'SCHED-…' id (see §7)
    title         TEXT    NOT NULL,
    session       TEXT    NOT NULL,                 -- the owning bot (slug). Unkeyed by CHOICE — see §2.4
    company_id    INTEGER,                          -- DERIVED cache of sessions.company_id; NULL = main bot
    enabled       INTEGER NOT NULL DEFAULT 1,
    -- trigger
    trigger_kind  TEXT    NOT NULL DEFAULT 'manual',-- 'manual'|'once'|'recurring'
    schedule_expr TEXT,                             -- NULL iff trigger_kind='manual'
    next_run      TEXT,                             -- RFC3339, as today
    last_run      TEXT,
    run_count     INTEGER NOT NULL DEFAULT 0,
    -- completion
    on_complete   TEXT    NOT NULL DEFAULT '{"kind":"none"}',  -- typed JSON, §5.3
    -- bookkeeping
    created       INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    deleted       INTEGER,
    CHECK (trigger_kind IN ('manual','once','recurring')),
    CHECK (trigger_kind = 'manual' OR schedule_expr IS NOT NULL)
);
CREATE INDEX idx_workflows_due     ON workflows(deleted, enabled, next_run);
CREATE INDEX idx_workflows_session ON workflows(session) WHERE deleted IS NULL;
CREATE INDEX idx_workflows_company ON workflows(company_id) WHERE company_id IS NOT NULL;

CREATE TABLE workflow_steps (
    id           TEXT    PRIMARY KEY,               -- 'WS-xxxxxxxx' — stable across edits (see §2.3)
    workflow_id  TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,                  -- 0-based, contiguous; rewritten atomically on save
    title        TEXT    NOT NULL DEFAULT '',       -- optional human label; falls back to prompt head
    command      TEXT    NOT NULL DEFAULT '',       -- the bare slash line, delivered as its OWN submission
    prompt       TEXT    NOT NULL DEFAULT '',       -- the free-text prompt (wrapped)
    files        TEXT    NOT NULL DEFAULT '[]',     -- JSON [{path,name,size,mime}] — absolute paths under <data_dir>/uploads
    connectors   TEXT    NOT NULL DEFAULT '[]',     -- JSON ["gmail","github"] — connector ids the bot MUST prefer
    timeout_secs INTEGER NOT NULL DEFAULT 1800,     -- per-step done deadline (DEFAULT_WATCH_TIMEOUT today)
    on_complete  TEXT    NOT NULL DEFAULT '{"kind":"none"}',   -- optional per-step action, same vocabulary
    created      INTEGER NOT NULL,
    updated      INTEGER NOT NULL,
    CHECK (length(trim(command)) > 0 OR length(trim(prompt)) > 0)
);
CREATE UNIQUE INDEX idx_workflow_steps_pos ON workflow_steps(workflow_id, position);

CREATE TABLE workflow_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id  TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    trigger      TEXT    NOT NULL,                  -- 'tick'|'manual'|'agent'
    status       TEXT    NOT NULL DEFAULT 'running',
    current_step INTEGER NOT NULL DEFAULT 0,        -- position of the in-flight step
    note         TEXT    NOT NULL DEFAULT '',
    heartbeat    INTEGER NOT NULL,                  -- bumped on every advance; the reaper reads it (§3.6)
    CHECK (status IN ('running','ok','error','skipped','timeout','interrupted','cancelled')),
    CHECK (trigger IN ('tick','manual','agent'))
);
CREATE INDEX idx_workflow_runs_wid ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX idx_workflow_runs_live ON workflow_runs(status, heartbeat) WHERE status = 'running';

CREATE TABLE workflow_step_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_id     TEXT    NOT NULL,                   -- NOT an FK: a step may be deleted after it ran; history must survive
    position    INTEGER NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT    NOT NULL DEFAULT 'running',
    signal      TEXT    NOT NULL DEFAULT '',        -- 'status-idle'|'agent-confirmed'|'timeout'|'send-error'|'skipped'
    preview     TEXT    NOT NULL DEFAULT '',        -- the DELIVERED prompt as the user sees it (never wrapper/footer)
    note        TEXT    NOT NULL DEFAULT '',
    CHECK (status IN ('running','ok','error','skipped','timeout','interrupted'))
);
CREATE INDEX idx_workflow_step_runs_rid ON workflow_step_runs(run_id, position);

CREATE TABLE workflow_run_keys (
    workflow_id      TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    scheduled_for_ts INTEGER NOT NULL,
    fired_at         INTEGER NOT NULL,
    PRIMARY KEY (workflow_id, scheduled_for_ts)
);

-- Nothing is destroyed. Every schedules row is archived as JSON before the drop.
CREATE TABLE workflows_import_log (
    old_id   TEXT PRIMARY KEY,
    ported   INTEGER NOT NULL,      -- 1 = became a workflow, 0 = refused
    reason   TEXT    NOT NULL,      -- '' when ported cleanly; else why
    row_json TEXT    NOT NULL,      -- the complete pre-drop row
    at       INTEGER NOT NULL
);

-- Sibling of 0032's trg_company_delete_sessions: the derived company_id cache
-- must not outlive the company it points at.
CREATE TRIGGER trg_company_delete_workflows
AFTER DELETE ON companies BEGIN
    UPDATE workflows SET company_id = NULL WHERE company_id = OLD.id;
END;

-- ── 2. archive EVERY pre-drop row, ported or not ─────────────────────────────
--
-- This runs FIRST so that a failure anywhere below rolls back a database in
-- which nothing was ever lost. `row_json` is the whole row, including the four
-- columns v1 deletes (watch, confirm_finish, bypass_permissions, done_pattern):
-- they are what an operator needs to rebuild a job the port could not carry.

INSERT INTO workflows_import_log (old_id, ported, reason, row_json, at)
SELECT
    s.id,
    CASE WHEN s.kind = 'tmux'
          AND s.deleted IS NULL
          AND (trim(s.command) <> '' OR trim(s.prompt) <> '')
         THEN 1 ELSE 0 END,
    CASE
        WHEN s.kind = 'shell' THEN 'shell jobs were removed in Workflows v1'
        WHEN s.kind = 'boot'  THEN 'boot jobs were removed in Workflows v1'
        WHEN s.deleted IS NOT NULL
            THEN 'the job was already deleted before the upgrade; nothing to carry over'
        WHEN trim(s.command) = '' AND trim(s.prompt) = ''
            THEN 'the job had neither a command nor a prompt; there was nothing to deliver'
        WHEN s.done_action LIKE 'command:%'
            THEN 'done_action command:… was removed; the follow-up text is preserved here'
        ELSE ''
    END,
    json_object(
        'id',                 s.id,
        'title',              s.title,
        'session',            s.session,
        'command',            s.command,
        'prompt',             s.prompt,
        'kind',               s.kind,
        'boot_dir',           s.boot_dir,
        'boot_provider',      s.boot_provider,
        'boot_worktree',      s.boot_worktree,
        'sched_type',         s.sched_type,
        'recurrence',         s.recurrence,
        'run_at',             s.run_at,
        'next_run',           s.next_run,
        'last_run',           s.last_run,
        'enabled',            s.enabled,
        'run_count',          s.run_count,
        'schedule_expr',      s.schedule_expr,
        'watch',              s.watch,
        'watch_timeout',      s.watch_timeout,
        'done_pattern',       s.done_pattern,
        'done_action',        s.done_action,
        'confirm_finish',     s.confirm_finish,
        'bypass_permissions', s.bypass_permissions,
        'created',            s.created,
        'updated',            s.updated,
        'deleted',            s.deleted
    ),
    CAST(strftime('%s','now') AS INTEGER)
FROM schedules s;

-- ── 3. port the workflows ────────────────────────────────────────────────────
--
-- Only a live `tmux` job with something to deliver. Ids cross over VERBATIM:
-- transcripts on disk, confirm footers sitting in live panes and the legacy
-- hook aliases all reference that exact string, so reusing it means no mapping
-- table exists to go stale (§7.2).
--
-- `schedule_expr` when NULL is synthesised here from `recurrence` + `run_at`
-- using the four shapes of `scheduler/mod.rs::synth_expr`, transcribed:
--   hourly  → "<minute-of-run_at> * * * *"   (the 2nd ':' field, or the whole
--                                             string when there is only one)
--   daily   → run_at "HH:MM"        → "<MM> <HH> * * *"
--   weekly  → run_at "<wd>:<HH>:<MM>", wd 0=Mon..6=Sun → "<MM> <HH> * * <(wd+1)%7>"
--   monthly → run_at "<DD>:<HH>:<MM>"                  → "<MM> <HH> <DD> * *"
-- CAST(x AS INTEGER) reads the longest numeric prefix, which is both how it
-- strips '09' to 9 and how it reads the first field of a ':'-joined string —
-- the same thing Rust's `parts[i].parse()` does. A run_at that does not have
-- the shape its recurrence implies yields NULL, and the row ports as a
-- 'manual' workflow rather than aborting the whole upgrade on the CHECK.
--
-- `company_id` is DERIVED, never carried: a missing session yields NULL, which
-- is correct (§2.5). `workflows/port.rs::reconcile` re-derives it at boot for a
-- restored database whose sessions rows arrived after this migration ran.

INSERT INTO workflows
    (id, title, session, company_id, enabled, trigger_kind, schedule_expr,
     next_run, last_run, run_count, on_complete, created, updated, deleted)
SELECT
    p.id,
    p.title,
    p.session,
    (SELECT company_id FROM sessions WHERE name = p.session),
    p.enabled,
    CASE WHEN p.expr IS NULL          THEN 'manual'
         WHEN p.sched_type = 'once'   THEN 'once'
         ELSE                              'recurring' END,
    p.expr,
    p.next_run,
    p.last_run,
    p.run_count,
    -- A `command:` follow-up is NEVER auto-converted into a connector send:
    -- that would be guessing what the operator meant. It becomes a disable,
    -- and the text itself survives in the import log.
    CASE WHEN p.done_action = 'notify' THEN '{"kind":"notify"}'
         ELSE                               '{"kind":"disable"}' END,
    p.created,
    p.updated,
    NULL
FROM (
    SELECT
        s.id, s.title, s.session, s.enabled, s.sched_type, s.next_run, s.last_run,
        s.run_count, s.done_action, s.created, s.updated,
        CASE
            WHEN s.schedule_expr IS NOT NULL AND trim(s.schedule_expr) <> ''
                THEN s.schedule_expr
            WHEN s.recurrence = 'hourly' AND q.ra GLOB '[0-9]*'
                THEN CAST(CASE WHEN instr(q.ra, ':') > 0
                               THEN CAST(q.rest AS INTEGER)
                               ELSE CAST(q.ra   AS INTEGER) END AS TEXT)
                     || ' * * * *'
            WHEN s.recurrence = 'daily' AND instr(q.ra, ':') > 0
                 AND q.ra GLOB '[0-9]*' AND q.rest GLOB '[0-9]*'
                THEN CAST(CAST(q.rest AS INTEGER) AS TEXT) || ' '
                     || CAST(CAST(q.ra AS INTEGER) AS TEXT) || ' * * *'
            WHEN s.recurrence = 'weekly' AND instr(q.rest, ':') > 0
                 AND q.ra GLOB '[0-9]*' AND q.rest GLOB '[0-9]*'
                THEN CAST(CAST(substr(q.rest, instr(q.rest, ':') + 1) AS INTEGER) AS TEXT) || ' '
                     || CAST(CAST(q.rest AS INTEGER) AS TEXT) || ' * * '
                     || CAST((CAST(q.ra AS INTEGER) + 1) % 7 AS TEXT)
            WHEN s.recurrence = 'monthly' AND instr(q.rest, ':') > 0
                 AND q.ra GLOB '[0-9]*' AND q.rest GLOB '[0-9]*'
                THEN CAST(CAST(substr(q.rest, instr(q.rest, ':') + 1) AS INTEGER) AS TEXT) || ' '
                     || CAST(CAST(q.rest AS INTEGER) AS TEXT) || ' '
                     || CAST(CAST(q.ra AS INTEGER) AS TEXT) || ' * *'
            ELSE NULL
        END AS expr
    FROM schedules s
    JOIN (
        SELECT
            s2.id AS sid,
            COALESCE(s2.run_at, '') AS ra,
            CASE WHEN instr(COALESCE(s2.run_at, ''), ':') > 0
                 THEN substr(COALESCE(s2.run_at, ''), instr(COALESCE(s2.run_at, ''), ':') + 1)
                 ELSE '' END AS rest
        FROM schedules s2
    ) q ON q.sid = s.id
    WHERE s.kind = 'tmux'
      AND s.deleted IS NULL
      AND (trim(s.command) <> '' OR trim(s.prompt) <> '')
) p;

-- ── 4. one step per ported workflow ──────────────────────────────────────────
--
-- `command` and `prompt` cross over SEPARATELY and are never concatenated: the
-- bare slash line has to stay its own submission or Claude stops executing it
-- as a slash command. `watch_timeout = 0` meant "unset", not "no time at all".

INSERT INTO workflow_steps
    (id, workflow_id, position, title, command, prompt, files, connectors,
     timeout_secs, on_complete, created, updated)
SELECT
    'WS-' || lower(hex(randomblob(4))),
    s.id,
    0,
    '',
    s.command,
    s.prompt,
    '[]',
    '[]',
    CASE WHEN s.watch_timeout > 0 THEN s.watch_timeout ELSE 1800 END,
    '{"kind":"none"}',
    s.created,
    s.updated
FROM schedules s
JOIN workflows w ON w.id = s.id;

-- ── 5. run history ───────────────────────────────────────────────────────────
--
-- The old ledger id becomes the new run id, so the step run below can be
-- correlated without a lookup table. `status='done'` (what the agent-confirmed
-- watcher wrote) is not a workflow_runs status — the CHECK is an exhaustive
-- enumeration — and it always meant an OK finish; the fact that the AGENT
-- declared it is preserved on the step run's `signal` rather than invented.

INSERT INTO workflow_runs
    (id, workflow_id, started_at, finished_at, trigger, status, current_step, note, heartbeat)
SELECT
    r.id,
    r.schedule_id,
    r.ran_at,
    r.ran_at,
    'tick',
    CASE r.status
        WHEN 'error'   THEN 'error'
        WHEN 'skipped' THEN 'skipped'
        WHEN 'timeout' THEN 'timeout'
        ELSE                'ok'
    END,
    0,
    r.note,
    r.ran_at
FROM schedule_runs r
JOIN workflows w ON w.id = r.schedule_id;

INSERT INTO workflow_step_runs
    (run_id, step_id, position, started_at, finished_at, status, signal, preview, note)
SELECT
    r.id,
    st.id,
    0,
    r.ran_at,
    r.ran_at,
    CASE r.status
        WHEN 'error'   THEN 'error'
        WHEN 'skipped' THEN 'skipped'
        WHEN 'timeout' THEN 'timeout'
        ELSE                'ok'
    END,
    CASE r.status
        WHEN 'done'    THEN 'agent-confirmed'
        WHEN 'error'   THEN 'send-error'
        WHEN 'skipped' THEN 'skipped'
        WHEN 'timeout' THEN 'timeout'
        ELSE                'status-idle'
    END,
    '',
    r.note
FROM schedule_runs r
JOIN workflows w      ON w.id  = r.schedule_id
JOIN workflow_steps st ON st.workflow_id = w.id AND st.position = 0;

-- ── 6. fire-keys ─────────────────────────────────────────────────────────────
--
-- CRITICAL. Without these, a fire window that straddles the upgrade is
-- unclaimed on the other side and the job fires a second time.

INSERT INTO workflow_run_keys (workflow_id, scheduled_for_ts, fired_at)
SELECT k.schedule_id, k.scheduled_for_ts, k.fired_at
FROM schedule_run_keys k
JOIN workflows w ON w.id = k.schedule_id;

-- ── 7. the drop ──────────────────────────────────────────────────────────────
--
-- Children first (they carry FKs into `schedules`). After this point the old
-- rows exist only as JSON in workflows_import_log — this is the one
-- irreversible step of Workflows v1, taken deliberately (spec §10, locked
-- decision #1).

DROP TABLE schedule_runs;
DROP TABLE schedule_run_keys;
DROP TABLE schedules;
