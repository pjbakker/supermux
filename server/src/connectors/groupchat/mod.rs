//! **Group Chat — the connector.** The store card and the embedded MCP server
//! that gives a company bot its five group-chat tools.
//!
//! Mirrors [`super::browser::mcp`] exactly: one embedded stdlib-only Python
//! stdio server materialized at launch, wired into the bot's inline
//! `--mcp-config`, forwarding every tool to ONE local supermux endpoint
//! ([`tools`]) authenticated with the pane's own `$SUPERMUX_HOOK_TOKEN`.
//!
//! **Why the server owns every tool.** The token-economy rules (spec §4) are
//! only real if they sit on the single path that reaches the channel: the
//! `@`-strip, the in-company check, the per-turn tag cap and the history budget
//! are all enforced in [`tools`], not here. This script is a forwarder — it must
//! never be the thing that decides what a bot may do.
//!
//! **Credential-free, session-scoped.** Nothing to vault. Bot A's hook token
//! authenticates only bot A, and the company is resolved SERVER-side from that
//! session's row — `SUPERMUX_COMPANY_ID` is baked into the launch env for the
//! bot's own convenience (`whoami` without a round trip), never trusted as
//! authorization.

use serde_json::{json, Value};

use crate::db::connectors;
use crate::state::AppState;

use super::manifest::{AuthDescriptor, AuthKind, Manifest, ToolDecl, KIND_BUILTIN_GROUPCHAT};

pub mod tools;

/// The connector id / store slug.
pub const GROUPCHAT_ID: &str = "group-chat";

/// The MCP server key a granted bot's `--mcp-config` uses. Claude names the
/// tools `mcp__<key>__<tool>`, so this is what the allow rule keys on.
pub const SERVER_KEY: &str = "group_chat";

/// The `permissions.allow` glob that auto-approves this connector's tools.
pub const ALLOW_RULE: &str = "mcp__group_chat__*";

/// The embedded MCP server script (materialized to disk at launch/boot).
pub const SERVER_PY: &str = include_str!("mcp_server.py");

/// A speech-bubble-pair glass icon (data-URI SVG), same posture as the browser
/// card's window.
const ICON: &str = "data:image/svg+xml;utf8,\
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' \
stroke='%230284c7' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>\
<path d='M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v4A2.5 2.5 0 0 1 14.5 13H8l-4 3.5V13\
a2.5 2.5 0 0 1-1-2z'/><path d='M17 9h1.5A2.5 2.5 0 0 1 21 11.5v4a2.5 2.5 0 0 1-2 2.45V21l-3.2-2.5H11'/>\
</svg>";

/// The five tools the server exposes (the card's tool list + count).
///
/// This list must stay in lockstep with `mcp_server.py`'s `TOOLS` and with
/// [`tools::run`]'s dispatch table.
pub fn tool_decls() -> Vec<ToolDecl> {
    vec![
        ToolDecl {
            name: "read_history".into(),
            description: "Read recent company group-chat messages — server-budgeted, \
                20 rows max. Only when you actually need the context."
                .into(),
        },
        ToolDecl {
            name: "who_tagged_me".into(),
            description: "Why you were pulled in: the router line that tagged you and the \
                request behind it. Cheap — call this first."
                .into(),
        },
        ToolDecl {
            name: "post_message".into(),
            description: "Post a short milestone to the company channel. Humans read it; \
                no bot is woken by it."
                .into(),
        },
        ToolDecl {
            name: "tag_bot".into(),
            description: "Router only: hand ONE distilled request to ONE bot in this \
                company. At most two per routing turn."
                .into(),
        },
        ToolDecl {
            name: "whoami".into(),
            description: "Who you are in this channel: your session, your company, and \
                whether you are the router."
                .into(),
        },
    ]
}

/// `<data_dir>/connectors/group-chat/server.py` — where the embedded server is
/// materialized.
pub fn server_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("connectors").join(GROUPCHAT_ID).join("server.py")
}

/// Idempotently write the embedded server to disk and return its absolute path.
/// Best-effort: on a write failure it returns `None` and the caller omits the
/// connector rather than failing the whole launch (the browser's posture).
pub async fn ensure(data_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let path = server_path(data_dir);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            tracing::warn!(error = %e, "group-chat: could not create server dir; omitting the connector");
            return None;
        }
    }
    if let Err(e) = tokio::fs::write(&path, SERVER_PY).await {
        tracing::warn!(error = %e, "group-chat: could not write server.py; omitting the connector");
        return None;
    }
    Some(path)
}

/// The `mcpServers` entry that launches the group-chat server via `python3`.
///
/// `SUPERMUX_SESSION` / `SUPERMUX_HOOK_TOKEN` / `SUPERMUX_URL` are `${VAR}`
/// references the host expands from the pane environment. `SUPERMUX_COMPANY_ID`
/// is **baked at assemble time** (the `MAIL_TO_FILTER` precedent): it is a
/// per-session fact that lives in the DB, not in the pane env. It is display
/// context only — [`tools`] re-resolves the company from the session row and
/// never trusts this value.
pub fn emit(server_path: &std::path::Path, company_id: Option<i64>) -> Value {
    let mut env = json!({
        "SUPERMUX_URL": "${SUPERMUX_URL}",
        "SUPERMUX_SESSION": "${SUPERMUX_SESSION}",
        "SUPERMUX_HOOK_TOKEN": "${SUPERMUX_HOOK_TOKEN}",
    });
    if let (Some(cid), Some(obj)) = (company_id, env.as_object_mut()) {
        obj.insert("SUPERMUX_COMPANY_ID".to_string(), Value::String(cid.to_string()));
    }
    json!({
        "command": "python3",
        "args": [server_path.to_string_lossy()],
        "env": env,
    })
}

/// The store manifest for the Group Chat card.
pub fn manifest(server_path: &str) -> Manifest {
    Manifest {
        id: GROUPCHAT_ID.into(),
        kind: KIND_BUILTIN_GROUPCHAT.into(),
        display_name: "Company Group Chat".into(),
        icon: ICON.into(),
        description: "The company's shared channel. Post a milestone your colleagues should \
            see, read what the others have been doing under a strict token budget, and — if \
            you are the company's assistant — hand one distilled request to one bot. Bots \
            never wake other bots here: a post is something humans read, and only an explicit \
            tag from the assistant costs another agent a turn. Granted to every bot in a \
            company automatically; nothing to sign in to."
            .into(),
        tools: tool_decls(),
        credentials: Vec::new(),
        auth: AuthDescriptor { kind: AuthKind::None, ..Default::default() },
        emit: emit(std::path::Path::new(server_path), None),
        categories: vec!["team".into()],
    }
}

/// Boot-time seed (idempotent): write the embedded MCP server to disk and upsert
/// the connector row so the store lists a **Company Group Chat** card. Called
/// once from `main` after the pool is up. Best-effort — logged, never fatal.
pub async fn seed(state: &AppState) {
    let Some(path) = ensure(&state.config.data_dir).await else {
        return;
    };
    let manifest = manifest(&path.to_string_lossy());
    let cols = manifest.to_columns();
    if let Err(e) = connectors::upsert(
        &state.pool,
        &manifest.id,
        &manifest.kind,
        &manifest.display_name,
        &manifest.icon,
        &manifest.description,
        &cols.tools_json,
        &cols.credentials_json,
        &cols.emit_json,
        &serde_json::to_string(&json!({ "builtin": true, "categories": manifest.categories }))
            .unwrap_or_else(|_| "{}".into()),
    )
    .await
    {
        tracing::warn!(error = %e, "group-chat: manifest upsert failed");
        return;
    }
    tracing::info!(connector = GROUPCHAT_ID, "seeded the built-in Company Group Chat connector");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_a_credential_free_builtin_groupchat_card() {
        let m = manifest("/data/connectors/group-chat/server.py");
        assert_eq!(m.id, GROUPCHAT_ID);
        assert_eq!(m.kind, KIND_BUILTIN_GROUPCHAT);
        assert!(m.credentials.is_empty(), "nothing to vault");
        assert_eq!(m.tools.len(), 5, "five tools on the card");
        let names: Vec<&str> = m.tools.iter().map(|t| t.name.as_str()).collect();
        for want in ["read_history", "who_tagged_me", "post_message", "tag_bot", "whoami"] {
            assert!(names.contains(&want), "missing {want} in {names:?}");
        }
    }

    /// The card's tool list and the embedded server's own list are ONE contract:
    /// a tool on the card the server does not implement is a lie in the store.
    #[test]
    fn the_card_and_the_embedded_server_declare_the_same_tools() {
        for t in tool_decls() {
            assert!(
                SERVER_PY.contains(&format!("\"{}\"", t.name)),
                "mcp_server.py does not declare {}",
                t.name
            );
        }
    }

    /// The company id is BAKED (it is not in the pane env), while the session +
    /// token stay `${VAR}` references the host expands.
    #[test]
    fn emit_bakes_the_company_and_references_the_session_env() {
        let e = emit(std::path::Path::new("/tmp/server.py"), Some(7));
        assert_eq!(e["env"]["SUPERMUX_COMPANY_ID"], "7");
        assert_eq!(e["env"]["SUPERMUX_SESSION"], "${SUPERMUX_SESSION}");
        assert_eq!(e["env"]["SUPERMUX_HOOK_TOKEN"], "${SUPERMUX_HOOK_TOKEN}");
        let none = emit(std::path::Path::new("/tmp/server.py"), None);
        assert!(
            none["env"].get("SUPERMUX_COMPANY_ID").is_none(),
            "a company-less session bakes no id rather than a wrong one"
        );
    }
}
