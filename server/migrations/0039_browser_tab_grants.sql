-- Shared Browser v1: persistent workspace tabs + PER-TAB grants (additive).
--
-- Spec: docs/superpowers/specs/2026-08-24-shared-browser-v1-design.md §3.
--
-- WHY NOT session_connectors. Its primary key is (session_name, connector_id) —
-- exactly ONE row per grantee per connector — so it cannot express "bot X may
-- use tabs 2 and 5, but not tab 7". `account_ref` is the tempting hook and the
-- wrong shape: an account is a CREDENTIAL, a tab is a live AUTHENTICATED
-- SURFACE. Hence a table of its own, keyed (tab_id, grantee).
--
-- The `grantee` keyspace is REUSED verbatim from session_connectors, so a tab
-- grant resolves through the same three tiers with the same precedence
-- (own slug > '@company:<id>' > '*'), and the same company containment applies.
--
-- 0038 is deliberately skipped: it is claimed by a concurrent bot-mode
-- workstream. The sequence has never been contiguous (0025 is absent too).
-- SHIPPED-IMMUTABLE: sqlx checksums migrations; never edit after deploy.

-- One row per persistent workspace tab. The tab is DURABLE: the row outlives
-- the CDP target (dehydration, an idle reap, a Chrome crash, a service
-- restart), which is what makes "the login is simply still there" true.
CREATE TABLE browser_tabs (
    id            TEXT PRIMARY KEY,                 -- 'tb_<uuid-simple>'; NOT the CDP targetId
    title         TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT 'about:blank',
    pinned        INTEGER NOT NULL DEFAULT 0,
    company_id    INTEGER,                          -- NULL = HQ/global (see §8.3)
    origins       TEXT NOT NULL DEFAULT '[]',       -- JSON array of host rules (§8.4)
    login_state   TEXT NOT NULL DEFAULT 'unknown',  -- 'ok' | 'needs_login' | 'unknown'
    last_probe_at INTEGER,                          -- unix seconds; NULL = never probed
    -- Keep-alive policy (§7.2). Reserved by this migration so the policy can
    -- ship without a second schema change; the sweep that reads them is a later
    -- slice, and every default here means "off".
    keepalive_enabled INTEGER NOT NULL DEFAULT 0,
    keepalive_every   INTEGER NOT NULL DEFAULT 20,  -- minutes; server-side floor of 5
    keepalive_url     TEXT,
    keepalive_action  TEXT NOT NULL DEFAULT 'reload',
    keepalive_script  TEXT,
    last_keepalive_at INTEGER,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
);
CREATE INDEX browser_tabs_company_idx ON browser_tabs(company_id);

-- One row per (tab, grantee). CASCADE mirrors connectors→session_connectors
-- (0031): deleting a tab must not leave grants pointing at nothing.
--
-- This table is NECESSARY-AND-SUFFICIENT only together with the connector-level
-- 'shared-browser' grant: has_tab_grant() requires BOTH. Reading a logged-in tab
-- IS exfiltration, so the check gates reads and screenshots, not just writes.
CREATE TABLE browser_tab_grants (
    tab_id     TEXT NOT NULL REFERENCES browser_tabs(id) ON DELETE CASCADE,
    grantee    TEXT NOT NULL,   -- bot slug | '@company:<id>' | '*' (the EXISTING keyspace)
    enabled    INTEGER NOT NULL DEFAULT 1,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (tab_id, grantee)
);
CREATE INDEX browser_tab_grants_grantee_idx ON browser_tab_grants(grantee);
