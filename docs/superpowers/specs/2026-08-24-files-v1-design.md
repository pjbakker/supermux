# Files → Bot Company Drive · v1 DESIGN SPEC

### Implementation-ready · 2026-08-24 · grounded against `/opt/projects/supermux` @ `d6b73cb` (main)

> Input: `scratchpad/files-redesign-research.md` (its **RECOMMENDED v1 scope** is the scope — settled
> choices are not reopened here). Every code claim below was re-read from disk at `d6b73cb`; file:line
> anchors are literal. **No product code is written by this document**, and no migration is touched
> (`sqlx` migrations are checksummed — see the standing rule).

---

## 0 · Decisions already made by the owner (encoded, not up for debate)

| # | Decision | Where it lands in this spec |
|---|---|---|
| **D1** | **HQ's landing folder = option (b)**: the `SUPERMUX_PROJECT_DIRS` subdir list from the existing `GET /api/projects/repos` ("HQ's projects"). NOT `$HOME`, and HQ is **not** hidden. | §4.1, §4.2 |
| **D2** | **Concurrency = the 409 lost-update guard.** `PUT /api/file` gains `if_modified` → **409** on mtime mismatch; the UI reloads and re-applies. **Rename/move is NOT refused while a bot is active** — no over-protection. A file moved out from under a working bot is **accepted risk**, named in §7. | §2.5, §4.3, §7 R3 |
| **D3** | A Workflow step's `files[].path` may reference `<data_dir>/uploads/` **OR** a path under the workflow session's **company jail**. This is a **cross-spec dependency**: the Workflows author widens the save-time guard; this spec only supplies the property (`safe_path_scoped` under `company_jail`) it will lean on. | §2.10, §7 R5 |

D1 carries one **verified consequence** the research did not state: `GET /api/projects/repos` is
deliberately **NOT** member-reachable — `member_may_reach` excludes it on purpose
(`server/src/scope.rs:211-218` comment, pinned negative at `scope.rs:480`), and the handler itself
returns an empty list to a scoped human (`files/mod.rs:877-893`). That is fine and requires **no
server change**, because a scoped member never renders the HQ card at all (§4.1): HQ is an
owner/admin-only space.

---

## 1 · Summary, goals, non-goals

### Summary

Files stops being a `$HOME` browser with a session dropdown and becomes **the shared drive of the bot
company**: the top level is *who* (HQ + one card per company), a file a bot wrote seconds ago appears
without a reload, every row can be renamed/moved/copied/handed to a bot in two taps at 390px, and the
owner keeps every raw power he has today. The plumbing already exists — companies own real directories
(`companies/mod.rs:202`), the hook plane already reports every agent file write (`hooks.rs:533`), the
transport trait already has `rename` (`transport.rs:80,224,497`), the member jail already fences every
path (`files/mod.rs:275-298`), and `SseEvent::for_company` already does per-subscriber company routing
(`state.rs:193-203`). v1 connects them and adds three verbs.

### Goals (v1, all of them)

1. **Three namespace verbs** — `POST /api/fs/mkdir`, `POST /api/fs/rename` (= move), `POST /api/fs/copy`
   (single file) — behind the existing jail, with audit rows and SSE frames.
2. **One correctness fix** — `PUT /api/file` is a blind write today (`files/mod.rs:413-466`); add
   `if_modified` → 409.
3. **One liveness event** — a company-stamped `files` SSE frame, emitted by the mutating file handlers
   **and** by the `post_tool` hook arm, plus a visibility-gated 10 s refetch backstop.
4. **`TEXT_LIMIT` 200 KB → 1 MB** (`files/mod.rs:49`), unblocking real logs and configs.
5. **The Spaces landing** (HQ + company cards), the space crumb replacing `SessionPicker` as the
   primary control, and a member with exactly one company skipping the grid.
6. **Row menu** Rename · Move… · Copy… · Duplicate · Download · Share… · Delete, and a `+ New`
   (folder | file) toolbar action, both mobile-first.
7. **Multi-select** with a safe-area bottom bar, client fan-out at concurrency 4, one honest toast.
8. **`?select=` deep link** and a **Send to bot** row action (composer prefill via `attachmentSentence`).
9. **Editor**: a discoverable in-file Find (incl. a mobile affordance) and image preview via
   `/api/file/raw` instead of base64.

### Non-goals — v2 (deliberately later, listed so nobody "just adds" them)

Recursive directory copy · the `notify` FS watcher (which would retire the poll backstop) · `?tail=1`
for truncated logs · folder upload (`webkitdirectory`, needs per-part path re-validation) · tar/zip
folder download (local transport only) · drag-to-move (desktop accelerator on top of the Move sheet,
never the only way) · git status badges per row (opt-in per repo) · bounded in-dir grep ·
bots-in-this-space rows · attach-from-Files inside the Workflow step composer (that is the *Workflows*
spec's build; this spec only supplies the jail property — D3).

### Non-goals — permanently cut

Tree view · LSP/autocomplete in the editor · public share links for arbitrary paths · a connector
`outputs/` directory convention · a per-bot `scratch/` vs company `shared/` convention ·
**server-side bulk endpoints** (bulk is a client fan-out, §4.5) · folder size / `du` on a company root.

---

## 2 · Server API

### 2.0 The safety path every verb rides (unchanged, non-negotiable)

Every existing handler is exactly three calls deep, and every new one must be identical:

```
transport_for_session(&state, &ctx, session)   // files/mod.rs:183 — session ownership + remote refusal
    → jail_for(&state, &ctx)                   // files/mod.rs:275 — None (owner) | Some(root_dir) (member)
        → safe_path_scoped(&transport, input, jail)  // files/mod.rs:285 — uniform 404 under a jail
```

Facts this spec depends on and that were re-verified:

- `transport_for_session` refuses a **remote transport to a scoped member** with the uniform
  `session '{name}'` 404 (`files/mod.rs:207-218`) — the local jail cannot fence a remote FS.
- `safe_path_scoped` collapses *every* failure to `AppError::NotFound("path not found")` when a jail is
  set (`files/mod.rs:285-298`), so "exists but not yours" is indistinguishable from "does not exist".
  Owner/admin (`jail = None`) keep precise errors — **behaviour-neutral**.
- `resolve_safe` canonicalizes the *nearest existing ancestor*, which is why `put_file` can resolve a
  brand-new path without 500ing (`files/mod.rs:424-427`). `mkdir`/`copy`/`rename` destinations rely on
  the same property.
- `company_jail` fails closed: a scoped human whose company row is missing gets the
  `NO_COMPANY_JAIL` sentinel that admits nothing (`scope.rs:346-360`).

**Rule (new, applies to every two-path verb): both `from` and `to` go through the full three-call path
with the same jail and the same transport.** A destination that skips it is the entire vulnerability
class this feature could introduce.

### 2.1 New shared request/response conventions

All three verbs are `POST`, JSON in / JSON out, registered in `router_for()` (`files/mod.rs:77-101`)
so they inherit the bearer-auth layer with **no loopback bypass**.

```rust
#[derive(Debug, Deserialize)]
struct MkdirBody   { path: String, #[serde(default)] cwd: Option<String>,
                     #[serde(default)] session: Option<String> }

#[derive(Debug, Deserialize)]
struct MoveBody    { from: String, to: String, #[serde(default)] cwd: Option<String>,
                     #[serde(default)] session: Option<String>,
                     #[serde(default)] overwrite: bool }   // same shape reused by copy
```

`overwrite` is a **body field**, not a query param — these are JSON POSTs and a mixed convention is a
footgun. Default `false`.

Uniform success envelope (mirrors `put_file` / `fs_delete`, `files/mod.rs:465,650`):

```json
{ "ok": true, "path": "/abs/created/or/target" }            // mkdir
{ "ok": true, "from": "/abs/old", "to": "/abs/new" }        // rename, copy
```

Error mapping (all existing variants — `server/src/error.rs:13-46`, `Conflict` → 409 already exists):

| Condition | Status | Body `error` |
|---|---|---|
| destination exists, `overwrite: false` | **409** | `conflict: destination exists` |
| `to` is inside `from` (dir move into itself) | **400** | `bad request: cannot move a directory into itself` |
| `from` is a company `root_dir` | **403** | `forbidden: a company root cannot be renamed or moved` |
| copy where `from` is a directory | **400** | `bad request: copying a directory is not supported yet` |
| any path outside the jail (member) | **404** | `not found: path not found` (uniform) |
| remote transport for a scoped member | **404** | `not found: session '{name}'` (uniform) |
| transport/IO failure | via `map_transport` / `map_io` (`files/mod.rs:1215,1232`) | unchanged |

### 2.2 `POST /api/fs/mkdir`

**Body** `{ path, cwd?, session? }` → **200** `{ ok: true, path }`.

```
let transport = transport_for_session(&state, &ctx, body.session.as_deref()).await?;
let jail      = jail_for(&state, &ctx).await?;
let abs       = safe_path_scoped(&transport, &to_abs(&body.path, body.cwd.as_deref()), jail.as_deref()).await?;
if transport.exists(&abs).await.map_err(map_transport)? { return Err(Conflict("destination exists")) }
transport.mkdir(&abs).await.map_err(map_transport)?;      // new trait method, §2.6
audit("dir.create"); emit_files_event(op="mkdir");
```

- **Parents are created** (`create_dir_all` / `mkdir -p`), but the **target itself must not exist** —
  409 otherwise. Idempotent-mkdir is a silent no-op that hides typos on a shared drive.
- Existence is probed with `FileTransport::exists`, **never** `stat(..).is_ok()` — the trait
  doc-comment at `transport.rs:82-94` is explicit that conflating "absent" with "could not ask" is how
  the `claude_config` data-loss bug happened. `exists` returning `Err` (indeterminate) must **fail
  closed** → surface `map_transport` (400/500), not "assume absent".
- **`WRITABLE_EXTS` does not apply.** A directory has no extension and this is a namespace op.

### 2.3 `POST /api/fs/rename` (this is also **move**)

**Body** `{ from, to, cwd?, session?, overwrite? }` → **200** `{ ok: true, from, to }`.

`FileTransport::rename` already exists on both impls and is unit-tested — local
`tokio::fs::rename` (`transport.rs:224-230`, test `local_rename_moves_file` at `transport.rs:670`),
remote `mv -- "$f" "$t"` via `spawn_command` (`transport.rs:497-527`). **No transport work is needed
for this verb**; it is the cheapest large win in the feature.

Handler order (all checks before any mutation):

1. Resolve `from_abs` and `to_abs` — *both* through `transport_for_session → jail_for →
   safe_path_scoped`, one shared `jail` value, one shared `transport`.
2. **Refuse a company root as `from`** — `company_for_path(&state, &from_abs)` (§3.2) returning a
   company whose `root_dir` **equals** `from_abs` → 403. Renaming a company root silently invalidates
   `companies.root_dir` in the DB and, for a member, the jail itself. *(Verified gap: `fs_delete`
   (`files/mod.rs:633-661`) has the same hole today. It is **pre-existing**, not introduced here;
   §7 R4 proposes reusing the same helper there, out of v1's required scope.)*
3. **Refuse `to` inside `from`** when `from` is a directory: `/`-delimited prefix compare on the
   canonicalized paths — `to_abs == from_abs || to_abs.starts_with(from_abs + "/")` → 400. This is the
   same boundary discipline `confineToCompanyRoot` already applies on the FE
   (`web/src/lib/companies.ts:78-90`) — prefix compare must be `/`-delimited so `…/acme-corp` is never
   read as inside `…/acme`.
4. **Refuse an existing `to`** unless `overwrite: true` (409). Probe with `exists`, same fail-closed
   rule as §2.2. Silent clobber is unacceptable when three bots and a human share a drive.
5. `transport.rename(&from_abs, &to_abs)`.
6. `db::audit::log(pool, "user", "file.rename", &from_abs, json!({ "to": to_abs }))`.
7. `emit_files_event(op = "rename", path = to_abs, from = from_abs)`.

**Cross-device caveat (honest):** `rename(2)` fails with `EXDEV` across filesystems, and a company root
on a different mount than `$HOME` makes that reachable. v1 surfaces the transport error as-is
(`map_transport` → 400 with the message). A copy+delete fallback is **explicitly not** in v1 — it is
non-atomic and would need its own conflict story.

### 2.4 `POST /api/fs/copy` (single file, v1)

**Body** `{ from, to, cwd?, session?, overwrite? }` → **200** `{ ok: true, from, to }`.

Same 1–4 checks as rename (minus the company-root refusal, which does not apply to a copy: copying
*out of* a company root is a read the caller already has), plus:

- `stat(from_abs).is_dir` → **400** `copying a directory is not supported yet`. Recursive copy is v2
  and gated on a security review (§5).
- Local: `tokio::fs::copy(from, to)` — a kernel-side copy, no in-memory materialization, so **no size
  cap is imposed**. Remote: `spawn_command("cp", &["--", f, t])`, the same
  argv-not-interpolation shape `rename`'s `mv` uses (`transport.rs:497-505`). The remote arm must
  `stat` first to refuse a directory, exactly the way `SshFileTransport::delete` refuses a remote
  recursive delete (`transport.rs:467-480`).
- Audit `file.copy` with target `from_abs`, detail `{ "to": to_abs }`.
- SSE `op = "copy"`.

**Duplicate** (the row action) is copy with a server-agnostic client-side name: the FE proposes
`name (copy).ext`, and on 409 retries `name (copy 2).ext`, up to 5 attempts. No new endpoint, and the
existing server-side `dedupe_path_local` (`files/mod.rs:1098`) is deliberately **not** reused — it is
the upload path's silent-rename policy, and silently renaming an explicit user-named copy target is
exactly the clobber-adjacent surprise §2.1 refuses.

### 2.5 `PUT /api/file` gains `if_modified` → 409 (D2)

`put_file` is a **blind write** today (`files/mod.rs:413-466`): it resolves, `create_dir_all`s the
parent, `safe_open_write`s and truncates. With bots actively editing, human-clobbers-bot and
bot-clobbers-human are silent data loss with zero protection. This is the highest-severity item in the
spec.

```rust
struct PutBody {
    path: String, content: String,
    cwd: Option<String>, session: Option<String>,
    /// Unix epoch SECONDS the client believes the file was last modified,
    /// as handed to it by `GET /api/file`. Absent = today's blind write.
    #[serde(default)] if_modified: Option<i64>,
}
```

Semantics — evaluated after `safe_path_scoped`, before the write:

| `if_modified` | file state | result |
|---|---|---|
| absent | any | write (byte-identical to today — every existing caller keeps working) |
| `Some(0)` | absent | write (the "I am creating a new file" assertion) |
| `Some(0)` | present | **409** `conflict: file already exists` |
| `Some(t>0)` | absent | **409** `conflict: file no longer exists` |
| `Some(t>0)` | `stat.modified != t` | **409** `conflict: file changed on disk` |
| `Some(t>0)` | `stat.modified == t` | write |

**Required companion change (the research missed this and it blocks the feature):**
`get_file`'s **text** branch does not return `modified` — it returns
`{path, content, is_markdown, is_csv, is_html, truncated}` (`files/mod.rs:404-412`), so the client has
nothing to send back. Add `"modified": modified` (and `"size": size`, already in scope at
`files/mod.rs:346-347`) to that JSON envelope. Purely additive; the video/audio/binary branches already
carry `modified`/`size`.

**Two honest limitations, both documented in the handler:**
- `Stat.modified` is **whole seconds** (`local_mtime` → `d.as_secs()`, `transport.rs:231-238`), so two
  writes inside the same second are indistinguishable. The guard narrows the window; it does not close
  it. *(Tightening this to an `(mtime, size)` pair is a one-line follow-up if the seconds granularity
  proves to bite — deliberately not in v1, because a same-second same-size overwrite is a genuinely
  rare shape and the pair still is not atomic.)*
- The `stat` → `write` sequence is **not atomic**. A bot writing between the two still wins silently.
  Closing that needs an O_EXCL/rename dance the local hot path does not have today.

The audit row grows the check outcome: `json!({ "bytes": …, "if_modified": body.if_modified })`.

### 2.6 `FileTransport::mkdir` (the one new trait method)

```rust
/// Create a directory, creating parents. MUST NOT error when a parent already
/// exists; the CALLER refuses a pre-existing target (via `exists`) so the verb
/// stays honest about typos.
async fn mkdir(&self, path: &Path) -> Result<()>;
```

- **Local** (`LocalFileTransport`, `transport.rs:133-230`): `tokio::fs::create_dir_all(path)` with the
  same `.with_context(|| format!("creating dir {}", path.display()))` shape every sibling uses.
- **Remote** (`SshFileTransport`, `transport.rs:249-560`): the established safe-exec idiom, copied
  **exactly** from `write` (`transport.rs:284-306`) — the script body **never interpolates the path**;
  the path arrives as `$1` through the trailing positional args, with `_` filling `$0`:

```rust
const SCRIPT: &str = r#"
set -eu
mkdir -p -- "$1"
"#;
let mut cmd = transport.spawn_command("bash", &["-c", SCRIPT, "_", p]);
// stdin null; stdout/stderr piped; non-zero status → bail!("remote mkdir of {} failed: {}", …)
```

No **default** trait impl: a new transport must implement it deliberately (the same discipline
`is_local` documents at `transport.rs:104-109`). Unit tests mirror the existing local ones
(`transport.rs:599-686`): `local_mkdir_creates_nested`, `local_mkdir_is_idempotent_on_parents`.

### 2.7 `TEXT_LIMIT` 200 KB → 1 MB

`const TEXT_LIMIT: usize = 1024 * 1024;` (`files/mod.rs:49`). Precedent is already in the file:
`CSV_LIMIT` is 5 MB (`files/mod.rs:50`), so 1 MB of text is well inside what this server already
materializes in memory. `"log"` is in `WRITABLE_EXTS` (`files/mod.rs:69`) and logs are the real
200 KB victim.

**Editing stays blocked on truncation — do not "fix" that.** `editable = isText && isWritable(name)
&& !truncated` (`web/src/components/files/file-viewer.tsx:66`) is correct and honest: saving a
head-truncated buffer would destroy the tail.

**Companion FE change:** the truncation banner hardcodes the number —
`Showing the first 200 KB — saving is disabled for truncated files.`
(`file-viewer.tsx:353-357`). It must read 1 MB, or the UI lies. *(Follow-up, not v1: have `get_file`
return the applied `limit` so the banner can never drift again.)*

### 2.8 Audit rows

`db::audit::log(pool, actor, action, target, detail)` (`server/src/db/audit.rs:19-27`) — one call each,
best-effort (`.ok()`), exactly like `put_file` (`files/mod.rs:449-459`) and `fs_delete`
(`files/mod.rs:653-655`):

| verb | action | target | detail |
|---|---|---|---|
| mkdir | `dir.create` | created abs path | `{}` |
| rename/move | `file.rename` | `from` abs | `{ "to": <to abs> }` |
| copy | `file.copy` | `from` abs | `{ "to": <to abs> }` |
| put (changed) | `file.put` | abs | `{ "bytes": n, "if_modified": … }` |

### 2.9 Router registration

```rust
.route("/api/fs/mkdir",  post(fs_mkdir))
.route("/api/fs/rename", post(fs_rename))
.route("/api/fs/copy",   post(fs_copy))
```

added to `router_for()` (`files/mod.rs:77-101`), and the module's endpoint table doc-comment
(`files/mod.rs:5-17`) grows three rows — that table is the file's contract and it must not drift.

### 2.10 Cross-spec seam for Workflows (D3)

The Workflows spec's step-file guard widens from "canonicalizes under `<data_dir>/uploads/`" to
"`uploads/` **OR** a path that `safe_path_scoped` resolves under the workflow session's
`company_jail`". **This spec changes nothing to enable it** — `company_jail` (`scope.rs:351-360`) and
`safe_path_scoped` (`files/mod.rs:285-298`) are already the exact property that guard was
approximating, and both are already public within the crate. The Workflows author owns the change; the
only obligation here is that neither helper's signature nor its fail-closed behaviour is altered by
the v1 files work. **It is not.**

---

## 3 · Liveness — the `files` SSE event

Today `useDirListing` has `staleTime: 5_000` and **no** `refetchInterval` (`use-files.ts:25-35`), and
the module header states outright "Files is NOT a live-streaming surface". A bot writing into the
directory you are staring at is invisible indefinitely. That is the least grok-like thing about the
feature.

### 3.1 Frame shape

```jsonc
// event: files
{
  "op":      "write" | "mkdir" | "rename" | "copy" | "put" | "delete" | "upload",
  "path":    "/abs/path/of/the/affected/entry",   // the DESTINATION for rename/copy
  "dir":     "/abs/parent/dir",                   // server-computed — the FE must never dirname()
  "from":    "/abs/old/path" | null,              // rename only
  "session": "researcher" | null                  // attribution; null for a human-initiated verb
}
```

`dir` is computed server-side on purpose: the FE would otherwise re-implement `dirname` for two
transports and get remote paths wrong.

### 3.2 Company stamping — **one rule, path-derived, fail-closed**

> **Every `files` frame is stamped with the company that OWNS THE PATH, resolved by longest
> `/`-delimited `root_dir` prefix. Never with the emitting session's company, never `global`
> as a convenience.**

```rust
/// Longest `/`-delimited root_dir prefix match over `db::companies::list(pool, /*include_archived*/ true)`.
/// `None` when the path is under no company root (HQ) → the frame is emitted `global`, i.e. owner-only.
async fn company_for_path(state: &AppState, abs: &Path) -> Option<i64>;
```

Why path-derived and not session-derived: an owner-run HQ bot can write into *any* company's folder,
and a session's `company_id` therefore does not bound the path. Stamping by session would hand a
member of company A a filename from company B. Stamping by path cannot: the frame reaches exactly the
members whose jail already permits that path.

- `include_archived = true` — an archived company still has members and a live root on disk
  (`companies/mod.rs:22`: the folder is *not* removed).
- HQ paths → `None` → `SseEvent::global` → owner/admin only, because `Scope::sees(None)` is
  **fail-closed** for a scoped human (`scope.rs:89-99`, pinned by `company_sees_only_own_and_never_unstamped`
  at `scope.rs:~452`). A missing update is safe; a wrongly-stamped frame is not.
- `company_id` is `#[serde(skip)]` (`state.rs:176-178`) — it is a routing attribute and never reaches
  the wire, and the SSE handler drops disallowed frames **before serialization** (`sse.rs:85-92`).

**Note for reviewers:** `SseEvent::for_company` currently has **no production caller** (only
`sse.rs:169,183` tests; the `isolation::SandboxSpec::for_company` hits are an unrelated name). The
`files` frame will be the **first company-routed producer in the app** — which makes §5's test
mandatory rather than nice-to-have.

### 3.3 Emit sites — the handler arm

A single private helper, called by every mutating handler after its audit row:

```rust
async fn emit_files_event(state:&AppState, op:&str, path:&Path, from:Option<&Path>, session:Option<&str>)
```

Wired into: `fs_mkdir`, `fs_rename`, `fs_copy` (new), `put_file` (`files/mod.rs:413`), `fs_delete`
(`files/mod.rs:633`), `fs_upload` (`files/mod.rs:561` — one frame **per saved file**, the loop at
`files/mod.rs:604-624`). `fs_upload` gets an audit row too while we are there; it has none today —
**flagged, and in scope** since we are already touching that loop.

### 3.4 Emit sites — the hook arm (attribution, nearly free)

`hook_handler` (`hooks.rs:138-212`) already authenticates every hook with a per-session token and
already loads a DB row to do it (`verify_hook_token` → `db::sessions::runtime`, `hooks.rs:63-84`).
`apply_payload` (`hooks.rs:444`) is **synchronous** and therefore *not* the place for this; the emit
belongs in `hook_handler`, which is `async` and holds `state.pool`.

```
in hook_handler, after apply_payload(…):
  if body.event is one of { "post_tool", "post_tool_use", "PostToolUse" }
     and raw_payload.tool_name ∈ { Write, Edit, MultiEdit, NotebookEdit }
     and raw_payload.tool_input.file_path is a non-empty string
  then
     let sess = db::sessions::get(&state.pool, &body.session).await?;         // gives dir + company_id
     let abs  = absolutize(file_path, sess.dir);   // live payloads carry RELATIVE paths
     emit_files_event(state, "write", &abs, None, Some(&body.session)).await; // stamped by PATH (§3.2)
```

Verified details that shape this:

- The payload really is `{"tool_name":"Edit","tool_input":{"file_path":"src/tile.tsx"}}` — pinned live
  at `hooks.rs:1004` and `hooks.rs:1221`, and the `file_path` is **relative**. It must be joined onto
  the session's `dir` (`db::sessions::get` → `Session`, `db/sessions.rs:193-198`, `company_id` at
  `db/sessions.rs:61`) before any prefix match, or `company_for_path` silently returns `None` for every
  agent write and the whole feature is dead on arrival.
- Absolutization here is **lexical only** — no `canonicalize`, no FS access, no `safe_path`. We never
  open the file; we only publish a string, and §3.2's prefix match is the gate. This keeps the hook
  inside its `--max-time 1` budget.
- Cost: **one extra indexed SELECT** on the qualifying subset of `PostToolUse` events. Every hook
  already pays one for `verify_hook_token`. *(If profiling ever shows this hurting, a
  `DashMap<String, Option<i64>>` name→company cache in `AppState` invalidated on session create/move is
  the follow-up — deliberately not in v1: an unproven cache with an invalidation story is worse than a
  measured query.)*
- **Stated blind spot:** agents also write through `Bash` (`>`, `sed -i`, `git checkout`, build output).
  The hook arm cannot see those. §3.6's backstop is what makes that invisible to the user, and the
  `notify` watcher (v2) is what removes it properly.

### 3.5 Web subscription

`'files'` joins `SSE_NAMED_EVENTS` (`use-sse.ts:63-85`) — the array **is** the type
(`SseEventType = (typeof SSE_NAMED_EVENTS)[number]`), so naming it subscribes it.

**A verified trap that will fail CI if ignored:** `web/tests/unit/sse-events.test.ts` scrapes the Rust
sources for `/event:\s*"([a-z-]+)"/g` — i.e. only the **struct-literal** form `SseEvent { event: "…" }`
— and then asserts *"the client subscribes to nothing that does not exist"*
(`sse-events.test.ts:57,86-94`). Emitting exclusively via `SseEvent::for_company("files", …)` means the
scrape never sees `files`, and adding `'files'` to the client list **fails that test**. The fix is one
line in the test, and it belongs in this work:

```ts
for (const m of src.matchAll(/SseEvent::(?:for_company|global)\("([a-z-]+)"/g)) found.add(m[1]!)
```

New hook in `use-files.ts`, subscribing through the shared singleton exactly the way
`use-external-edit.ts:141-163` does (stable `onEvent` via `useCallback`, `useSse(useMemo(...))` so the
subscription never tears down on re-render):

```ts
export function useFilesLive(dirPath: string, openPath: string | null, dirty: boolean) {
  // type !== 'files' → return
  // payload.dir === dirPath  → qc.invalidateQueries({ queryKey: ['files','ls', dirPath] })
  //                            (prefix match covers BOTH hidden variants of lsKey)
  // payload.path === openPath && !dirty → qc.invalidateQueries({ queryKey: ['files','file', openPath] })
  // payload.path === openPath &&  dirty → surface a "changed on disk" banner; NEVER refetch over a draft
  // always: recordFilesActivity(payload)   // §4.1's landing line
}
```

The **dirty guard is not optional**: `FileViewer` holds the user's edit in local `draft` state
(`file-viewer.tsx:69-73`) and a refetch under a dirty buffer is the very data loss §2.5 exists to
prevent, arriving through the back door.

### 3.6 The backstop

`useDirListing` gains:

```ts
refetchInterval: () => (document.visibilityState === 'visible' ? 10_000 : false),
refetchIntervalInBackground: false,
```

This is a deliberate, bounded exception to the project's stated anti-vision ("WebSocket-only — no 3s
polling", `sse.rs:3-4`): 10 s, foreground-only, one directory, and it exists solely to cover the `Bash`
blind spot in §3.4. **It is removed when the `notify` watcher lands (v2)** — `notify = "7.0"` is
already a dependency and the `recommended_watcher` → `Arc<Notify>` idiom is already used twice
(`teams/watcher.rs`, `sessions/chat/tailer.rs`). Both mechanisms are additive; neither can regress the
other, because both end in the same `invalidateQueries`.

---

## 4 · Web UX — mobile-first, grok-quality, reuse-first

Standing project rule (memory: *UI mobile-first + DRY*): every slice is designed at 390 px **first**
and reuses existing components. Nothing below introduces a new primitive.

### 4.1 The Spaces landing

**`/files` with no `?path=` renders a Spaces grid, not a directory.**

```
┌───────────────────────────────────────────┐
│  Files                            [ + ]   │  ← safe-header, owns the top inset
├───────────────────────────────────────────┤
│  ▢ HQ              ▢ Acme                 │  ← <HqMark> / <CompanyMark size={40}>
│    4 bots            6 bots               │
│                      ✎ report.md · now    │  ← live line, ONLY when observed (§3.5)
│                                            │
│  ▢ Globex          ▢ Contoso              │
│    2 bots            —                    │
└───────────────────────────────────────────┘
```

- Marks are **`<CompanyMark slug name size={40}>`** and **`<HqMark>`**, reused verbatim from
  `web/src/components/roster/company-mark.tsx`. Hue is a pure function of the *immutable slug* (the
  documented "hue firewall", `company-mark.tsx:11-19`) — **do not invent a Files-specific avatar**, and
  there is **no avatar column** to add (`db/companies.rs:19-32` — none is needed).
- Line 2 = **bot count**, client-side: `sessions.filter(s => (s.company_id ?? null) === id).length`
  from `useSessions`. HQ's count is `company_id == null`.
- Line 3 = the **live activity line**, driven by §3.5's `recordFilesActivity` into a tiny zustand store
  (`stores/files-activity-store.ts`, `{ [companyId|'hq']: { at, path, session } }`).
  **Honesty rule:** it renders *only* for a company we have observed an event for **in this session**.
  There is **no** `idle · 3d`: nothing on the server persists a last-write timestamp per company, and
  inventing one from a shallow `/api/ls` mtime of the root would be a number that does not mean what it
  says. Absent activity, the slot renders `—`. *(A real recency signal is a v2 item with a v2 cost.)*
- **No folder size.** `du` on a company root is an unbounded recursive walk on a small VPS.
- Archived companies are hidden — `useCompanies` reads `GET /api/companies`, which already excludes
  them (`db/companies.rs:39-46`).
- Tapping a card calls `useUI().setActiveCompany(id)` (`stores/ui-store.ts:90,180`) so the **whole app**
  follows (roster, overview, switcher all key off the same store), then navigates to
  `?path=<root_dir>`.
- **HQ card (D1)**: sets `activeCompany = null` and navigates to a **projects list** rendered from
  `GET /api/projects/repos` (`files/mod.rs:877`) — each subdir a folder row that navigates into
  `?path=<abs>`. HQ is therefore a *space with contents*, not an exception, and **not** `$HOME`. `$HOME`
  remains reachable to the owner by walking the crumbs up from any project (HQ sets no `floor`).
- **Scoped member (`Scope::Company`)**: the grid is **skipped entirely** when
  `companies.length === 1` — route straight to `root_dir`. A one-card chooser is condescending, and the
  member has no HQ card to show anyway (D1's consequence: `/api/projects/repos` returns empty to them).
  The space crumb still names the company so context stays legible.

**At 390 px:** 2 columns, `<CompanyMark size={40}>`, activity line clamped to one line
(`truncate`), each card a ≥44 px tap target, grid padded with the shared safe-area utilities.

### 4.2 The space crumb replaces `SessionPicker`

Today the header's only visible scope control is a **`SessionPicker`** (`routes/files.tsx:229-239`)
that does *not* pick a company and does *not* switch transport — `filesApi.ls` never sends `session`
(`lib/api/files.ts:112-116`), so `transport_for_session(None)` always resolves **local**. The UI
teaches the wrong mental model.

- The breadcrumb's first crumb becomes the **space switcher** (`HQ ▾` / `Acme ▾`), opening a
  `ResponsiveSheet` listing HQ + companies (same marks as the grid) with **"Jump to a bot's working
  dir"** as a secondary group at the bottom — that is where `SessionPicker`'s function survives, demoted
  to what it actually does.
- `<Breadcrumb floor={companyRoot}>` is unchanged (`components/files/breadcrumb.tsx:10-38`): inside a
  company the crumbs are floored at `root_dir` and the floor renders as the House, so the owner cannot
  walk out of a company via the crumbs. HQ passes `floor={null}` (pass-through, byte-identical to today).
- Header budget at 390 px, after the swap: `[space crumb ▾] [path crumbs …] [hidden] [sort] [+] [upload]`
  — the picker's 8 rem slot is what pays for `+ New`. Net tap-target count is unchanged.

### 4.3 Row menu

The per-row `DropdownMenu` already exists (`components/files/file-list.tsx:168-206`) and today holds
Download · Share… (Web-Share-capable browsers only, `file-list.tsx:65,187-194`) · Delete. **Add to the
same menu — no new pattern, and no desktop-only right-click affordance:**

| Item | Action |
|---|---|
| **Rename…** | `ResponsiveSheet`, one text input pre-filled with the basename, selection over the stem. `POST /api/fs/rename` with `to = <same dir>/<new name>`. |
| **Move…** | The **destination sheet** (§4.4). `POST /api/fs/rename` with `to = <picked dir>/<name>`. |
| **Copy…** | The same destination sheet. `POST /api/fs/copy`. Dirs are disabled with the honest reason "copying a folder isn't supported yet". |
| **Duplicate** | `POST /api/fs/copy` to `name (copy).ext` in place, with the 409 retry ladder from §2.4. |
| **Send to bot** | §4.6. |
| Download / Share… / Delete | unchanged. |

`FileListProps` (`file-list.tsx:30-37`) grows `onRename`, `onMove`, `onCopy`, `onDuplicate`,
`onSendToBot`, and the select-mode props from §4.5. Rename/Move/Copy/Duplicate are offered for **both**
files and directories (except Copy on a dir, above) — `WRITABLE_EXTS` deliberately does **not** gate
them (§2.1); renaming a `.pdf` or a `.sqlite` is a namespace op and blocking it would make the feature
useless.

### 4.4 `+ New` and the destination sheet

**`+ New`** — one toolbar button (not two competing for the 44 px budget in an already-crowded header)
opening a `ResponsiveSheet` with a segmented **Folder | File** control and one text input:

- **Folder** → `POST /api/fs/mkdir { path: <dir>/<name> }`.
- **File** → `PUT /api/file { path: <dir>/<name>, content: "", if_modified: 0 }`. **No new endpoint** —
  `put_file` already `create_dir_all`s parents and `safe_open_write`s (`files/mod.rs:424-441`), and
  `if_modified: 0` turns "new file" into an assertion that 409s instead of silently truncating an
  existing one (§2.5).
- The name is validated **client-side before the call** with the existing
  `isWritable(name)` (`components/files/file-types.ts:50-60`) for the File case, so the user sees
  *"supermux can only create text files here — `.xlsx` isn't in the writable list"* instead of a raw
  403 from `is_writable_target` (`files/mod.rs:972-977`).

**The destination sheet** (shared by Move…, Copy… and the bulk bar) is a `ResponsiveSheet`
(`components/ui/responsive-sheet.tsx` — the project's mobile-first primitive, Vaul drag-detent bottom
sheet on coarse pointers, right-hand `Sheet` on desktop) containing a **dir-only browser**:

- Rows come from `/api/ls` filtered to `type === 'dir'`, with a crumb inside the sheet, floored at
  `companyRoot` exactly like the main breadcrumb.
- A typeahead field backed by the existing `GET /api/autocomplete/dir` (`files/mod.rs:776`) with
  `hidden=0`.
- **Never a horizontally scrolling column view**, and never a tree.
- Footer: `[ Cancel ]  [ Move here ]`, sticky, with `env(safe-area-inset-bottom)` padding — the
  iOS keyboard-band lesson (memory: *iOS keyboard band vvheight*, mode 9) applies to **every**
  bottom-anchored surface that contains a text input.

### 4.5 Multi-select and bulk

- A **"Select" toolbar toggle** (not long-press — it collides with iOS text selection, and this
  codebase has a documented history of selection bugs). Toggling reveals a checkbox per row inside the
  existing `<li>`, left of the icon; the row's primary tap becomes "toggle" while in select mode.
- A **bottom action bar**: `Move · Copy · Download · Delete`, plus `N selected` and `Cancel`,
  `fixed inset-x-0 bottom-0` with `pb-[env(safe-area-inset-bottom)]` and the shared `glass` material.
- **Client fan-out, no server batch endpoints** (§1 non-goals). A new pure helper
  `web/src/lib/concurrency.ts` → `mapWithLimit(items, 4, fn)`, unit-tested in isolation (no DOM), runs
  the N single-verb calls at **concurrency 4**.
- **One honest summary toast**: `"4 moved · 1 failed: destination exists"`. Partial failure is reported
  as partial — never rolled back (there is nothing to roll back to), never rounded up to success.
- After settle: invalidate `['files','ls']`. The SSE frames will also arrive; both paths converge on
  the same key, which is idempotent.

**At 390 px:** the bar is the only fixed-bottom surface, the list gets `pb-24` while select mode is
on so the last row is never trapped under it, and the destination sheet opens *over* the bar.

### 4.6 `?select=` deep link and **Send to bot**

**Deep link.** `selected` is plain React state (`routes/files.tsx:126`), so the viewer is not
linkable today. Add `?select=<basename>` alongside the existing `?path=`:

- basename only — never a full path — so a crafted link can only ever select something **inside the
  directory the listing already resolved**. It is resolved as `dirPath + '/' + name` against the
  current listing; a name not present in `entries` is ignored (no error).
- Two-way: `setSelected` writes the param, `onBack` removes it. Browser Back then works, and every
  other surface (chat activity lines, an SSE toast, a Workflow step) gains a URL it can point at.

**Send to bot** — the highest value-per-line integration in the whole feature, and **zero server work**:

```ts
insertIntoComposer(sessionName, attachmentSentence([absPath]))   // components/chat/composer-draft.ts:212
navigate(`/focus/${encodeURIComponent(sessionName)}`)            // App.tsx:252 — the chat surface
```

- `attachmentSentence` (`components/chat/composer-insert.ts:91-94`) is the **canonical wire format** —
  quoted absolute paths, one trailing space — and it is already pinned byte-identical to
  `buildAttachmentPrompt` (`lib/api/files.ts:224-228`) by `chat-composer-insert.test.ts`. The Workflows
  spec builds the same bytes server-side. Do not re-derive it a third time.
- `insertIntoComposer` handles the not-yet-mounted composer correctly: with no field in the DOM it
  writes the draft and returns (`composer-draft.ts:220-229`), and the draft store is module-level +
  `sessionStorage`-backed (`composer-draft.ts:11-49`), so it survives the navigation and the panel
  mounting afterwards.
- The bot picker is a `ResponsiveSheet` over **sessions in the current space** —
  `sessions.filter(s => inCompanyScope(s.company_id, activeCompany))` (`lib/companies.ts:44-48`) — so
  the action can never hand a company's file to a bot outside it.

### 4.7 Editor and previews

- **In-file search.** Correction to the research: `@codemirror/search` is **already installed**
  (`web/bun.lock:300`, `@codemirror/search@6.7.0`, pulled in by `@uiw/codemirror-extensions-basic-setup`)
  and `basicSetup` already registers `searchKeymap` + `highlightSelectionMatches` unless explicitly
  disabled (`@uiw/codemirror-extensions-basic-setup/esm/index.js:59-60,93`), and `code-editor.tsx:78-84`
  does not disable them. **`Mod-f` very likely already works on desktop.** What is actually missing is
  **discoverability and any mobile affordance at all**. So the v1 work is:
  1. add `search({ top: true })` explicitly to the `extensions` memo (`code-editor.tsx:61-66`) so the
     panel's position is ours and the behaviour is no longer an implicit transitive default;
  2. add a **Find** button to the viewer header that calls `openSearchPanel(view)` — the only way a
     phone can reach it;
  3. add `"@codemirror/search": "^6.7.0"` to `web/package.json` (it is a **phantom dependency** today —
     resolved in the lockfile, absent from the manifest; importing it directly without declaring it is
     exactly the thing that breaks on the next dedupe).
- **Image preview via `/api/file/raw`.** `filesApi.rawUrl` already exists and already carries the
  `?_token=` fallback (`lib/api/files.ts:150-158`); `get_raw` already streams with Range + ETag +
  `private, max-age=3600, immutable` (`files/mod.rs:471-560`). Render `<img src={filesApi.rawUrl(path)}>`
  instead of consuming `get_file`'s base64 `data_url`. This removes the 5 MB `IMAGE_MAX` ceiling
  (`files/mod.rs:51`, enforced at `files/mod.rs:357-359`), removes the 33 % base64 bloat, and makes
  previews browser-cacheable. **Strictly better than raising the cap.**
  *Server note:* `get_file`'s image branch stays as-is for v1 (other callers may rely on the envelope);
  the FE simply stops reading `data_url` for images. PDF at 10 MB stays base64 — untouched.

### 4.8 Every new surface at 390 px (explicit, per §7 of the research)

| Surface | 390 px behaviour |
|---|---|
| Spaces grid | 2 columns, 40 px marks, one-line clamped activity, ≥44 px targets |
| Space crumb ▾ | opens a Vaul bottom sheet (`ResponsiveSheet` coarse-pointer branch), not a dropdown |
| Row menu | the **existing** per-row dropdown, ≥44 px trigger (`file-list.tsx:170-177`) — items appended, nothing moved to a context menu |
| Rename sheet | bottom sheet, single input, `pb-safe` footer, autofocus + stem selection |
| Move/Copy destination | bottom sheet, dir-only list + typeahead, sticky `pb-safe` footer, **no column view, no tree** |
| `+ New` | one header button → bottom sheet with a segmented Folder/File + one input |
| Select mode | toolbar toggle → row checkboxes → fixed bottom bar with `env(safe-area-inset-bottom)`; list gets `pb-24` |
| Bulk toast | one line, truncating, above the bottom bar |
| Viewer | unchanged: full-screen on select, header hidden on mobile while open (`routes/files.tsx:226,326,378`); the Find button lives in the viewer's own header, which owns the inset |
| Split | unchanged: list full-width, viewer full-screen on select (`routes/files.tsx:322-330,368-373`) |

**No tree view. Ever.** Breadcrumb + list is correct at 390 px and is already built.

### 4.9 Web data layer

`web/src/lib/api/files.ts` — `filesApi` grows, mirroring the existing `fsRequest` shape
(`lib/api/files.ts:110-146`):

```ts
mkdir(path)                                   → POST /api/fs/mkdir
move(from, to, opts?: {overwrite?: boolean})  → POST /api/fs/rename
copy(from, to, opts?)                         → POST /api/fs/copy
writeFile(path, content, ifModified?: number) → PUT  /api/file      // param appended, existing callers unchanged
```

`web/src/hooks/use-files.ts` — `useMkdir`, `useMoveEntry`, `useCopyEntry` (each invalidating
`['files','ls']`, exactly like `useDeleteFile`/`useUploadFiles` at `use-files.ts:71-88`), plus
`useFilesLive` (§3.5) and the `refetchInterval` on `useDirListing` (§3.6). `useSaveFile` passes the
`modified` it read from the cached `['files','file', path]` payload (§2.5's new field) and surfaces a
409 as a `conflict` state rather than a generic error toast.

`web/src/lib/companies.ts` — one new **pure** helper beside the existing ones:

```ts
export function companyForPath(path: string, companies: readonly Company[]): Company | null
```

longest `/`-delimited `root_dir` prefix, same boundary discipline as `confineToCompanyRoot`
(`lib/companies.ts:78-90`) so `…/acme-corp` is never read as inside `…/acme`. It is what routes an
incoming `files` frame to a landing card (§4.1), and it is unit-tested with no DOM.

---

## 5 · Security

1. **Member reachability of `/api/fs/*` is a TEST, not an assumption.** `member_may_reach` admits the
   whole `/api/fs` prefix (`scope.rs:211-218`), so `/api/fs/mkdir`, `/api/fs/rename` and `/api/fs/copy`
   become member-reachable **the instant they are registered**. That is the intended design — the jail
   confines them — but it must be *pinned*, next to the existing
   `assert!(member_may_reach(&get, "/api/fs/delete"))` at `scope.rs:449`, and paired with a live
   cross-jail 404 test (§6). The outer allowlist is a fence, not the only one; the jail is the boundary.
2. **Both paths through the jail.** Restated because it is the one thing that would make this feature a
   vulnerability: a two-path verb that only validates `from` lets a member (or a confused owner-lens
   call) write outside the jail. `from` **and** `to`, same jail, same transport, uniform 404 on either.
3. **Every SSE emit is stamped `for_company` with a PATH-derived id** (§3.2). A `files` frame carries a
   path, and paths are company-identifying. `Scope::sees` is fail-closed for unstamped frames
   (`scope.rs:89-99`), so the failure mode of a *missing* stamp is a missing update (safe) — but a
   *wrongly* stamped frame leaks another company's filenames to a member, and nothing downstream would
   catch it. There is exactly one stamping helper, and every emit site calls it.
4. **The hook arm publishes a string it never opens** — no `safe_path`, no FS access, lexical
   absolutization only (§3.4). The prefix match is the gate.
5. **A member is still refused every remote transport** (`files/mod.rs:207-218`) — unchanged, and the
   new verbs inherit it by construction because they call `transport_for_session` first.
6. **Recursive copy and folder upload are v2 and are gated on a security review.** Both have genuine
   path-safety surface: recursive copy is an unbounded walk (depth + byte caps, symlink policy), and
   folder upload must **re-run path safety per part** because `File.webkitRelativePath` is
   attacker-controlled and a crafted `../` in it is the obvious attack. Neither ships as "v1 filler".
7. **Public share links for arbitrary paths remain a NO** (this box holds `.env`s and credentials, and
   `external_access` + share tokens already exist, which makes it deceptively easy to build). The Web
   Share item in the row menu (`file-list.tsx:187-194`) is the *browser's* share sheet on bytes already
   downloaded to the device — a different thing, and it stays.
8. **Company roots cannot be renamed or moved** (§2.3 step 2). A renamed root desynchronizes
   `companies.root_dir` from disk and, for a member, silently re-points the jail.

---

## 6 · Isolation, boundaries and the test plan

### 6.1 Four independently reviewable units

| Unit | Files | Depends on | Ships alone? |
|---|---|---|---|
| **U1 — server verbs** | `files/mod.rs`, `files/transport.rs` | nothing new | **Yes** — three endpoints + `if_modified` + `TEXT_LIMIT`, no UI |
| **U2 — liveness** | `state.rs` (none), `files/mod.rs`, `hooks.rs`, `use-sse.ts`, `sse-events.test.ts` | U1 for the verb emits (the put/delete/upload/hook emits stand alone) | **Yes** |
| **U3 — web data layer** | `lib/api/files.ts`, `hooks/use-files.ts`, `lib/companies.ts`, `lib/concurrency.ts` | U1, U2 | Yes (no visible change) |
| **U4 — web UI** | `routes/files.tsx`, `components/files/*`, one new `stores/files-activity-store.ts`, one new spaces-grid component | U3 | Yes |

The seam between U3 and U4 is deliberate: U3 is pure/hook-level and testable without a DOM (the
project's existing habit — `lib/companies.ts` and `composer-insert.ts` are both kept import-free for
exactly this reason), U4 is the only unit that touches layout.

**Not touched by any unit:** `scope.rs` (behaviour), `path_safe.rs`, `sse.rs`, any migration, any
`SseEvent` field. If a diff touches one of those, the design has drifted.

### 6.2 Server tests

Extend the existing harnesses — `server/tests/files.rs` (its `setup()`/`authed_json()` helpers at
`files.rs:27-101` are exactly what these need), `server/tests/files_transport.rs`, and
`server/tests/scope_p3b.rs`.

**`files.rs` (owner lens):**
- `mkdir_creates_nested_dir_and_audits` — nested path, `dir.create` row present.
- `mkdir_on_existing_path_is_409`.
- `rename_moves_file_across_dirs_and_audits` — plus the source is gone and the destination reads back.
- `rename_to_existing_dest_is_409_unless_overwrite` — both halves.
- `rename_dir_into_itself_is_400` — and the `…/acme-corp` vs `…/acme` prefix case is **not** refused.
- `rename_of_a_company_root_is_403`.
- `copy_file_leaves_source_intact`; `copy_of_a_directory_is_400`.
- `put_with_stale_if_modified_is_409_and_leaves_bytes_untouched` — the regression that matters.
- `put_with_matching_if_modified_writes`; `put_with_if_modified_zero_on_existing_file_is_409`.
- `get_file_text_envelope_carries_modified` — the field §2.5 depends on.
- `text_limit_is_one_megabyte` — a 900 KB file is **not** `truncated`.

**`files_transport.rs` / `transport.rs` unit tests:** `local_mkdir_creates_nested`,
`local_mkdir_is_idempotent_on_parents`, alongside the existing `local_rename_moves_file`
(`transport.rs:670`). The SSH arms follow whatever the existing remote-transport test harness does for
`write`/`rename` (`integration_remote.rs`, `pty_ssh.rs`); no new remote fixture is invented for v1.

**`scope_p3b.rs` (member lens) — the security-critical file:**
- `member_may_reach_new_fs_verbs` — three `assert!(member_may_reach(&post, …))` beside `scope.rs:449`.
- `scoped_human_mkdir_outside_jail_is_404` / `…_rename_to_outside_jail_is_404` /
  `…_copy_to_outside_jail_is_404` — **uniform 404**, byte-identical in shape to a nonexistent path,
  modelled on `files_jail_confines_scoped_human_to_company_root` (`scope_p3b.rs:447`).
- `scoped_human_rename_from_own_to_other_company_is_404` — the two-path check, the whole point.
- `scoped_human_fs_verbs_on_remote_session_are_404` — extends the existing
  `scoped_human_files_remote_and_foreign_session_are_404` (`scope_p3b.rs:479`) to the new verbs.
- `files_frame_is_company_stamped` — emit into a company root and assert a `Scope::Company(other)`
  subscriber does **not** receive it, mirroring the existing per-subscriber filter tests at
  `sse.rs:169,183`.

### 6.3 Web tests

**Stated honestly: `web/src/components/files/*` has NO tests today** (verified — no `*.test.ts*` under
`components/files`, and none matching `files` under `web/tests`). v1 does not retrofit coverage for the
existing components, but **everything it adds is testable and is tested**:

- `sse-events.test.ts` — the regex fix from §3.5 **plus** `expect(EMITTED).toContain('files')`, so the
  channel can never half-land the way `harness` did (`sse-events.test.ts:4-21`).
- `lib/companies.test.ts` — `companyForPath`: exact root, nested, sibling-prefix (`…/acme-corp`),
  no-match → null, longest-match-wins with nested roots.
- `lib/concurrency.test.ts` — `mapWithLimit`: never exceeds 4 in flight, preserves order, surfaces
  per-item rejections without failing the batch.
- `use-files` liveness test (bun + a stub query client): a `files` frame whose `dir` matches invalidates
  `['files','ls', dir]`; a non-matching `dir` does **not**; a frame for the open file with
  `dirty === true` does **not** invalidate `['files','file', …]` (the draft guard from §3.5).
- A component test for the **Spaces grid** (bot counts from a stub session list, archived companies
  absent, single-company member skips the grid) — the first test in `components/files`, and the one
  that makes the landing's honesty rules executable.

### 6.4 Manual verification

The offline mobile UI review rig (memory: *Offline mobile UI review rig*) at 390 px, against a `/dev`
route seeded with mock companies: Spaces grid → company → row menu → Move sheet → select mode →
bulk bar → `+ New` → viewer + Find. Every bottom-anchored surface is checked with the keyboard **open**
(the mode-9 lesson), and no surface may scroll the body horizontally.

---

## 7 · Residual open questions and risks (after D1–D3)

**R1 — `if_modified` is second-granular and non-atomic (accepted, documented).** `Stat.modified` is
whole seconds (`transport.rs:231-238`), and the `stat`→`write` pair is not atomic. Two writes inside
the same second, or a bot writing between the stat and the open, still lose silently. The guard removes
the *common* case (a human editing `.env` for a minute while a bot works); it does not make `PUT`
transactional. **Open:** whether to tighten to an `(mtime, size)` pair after v1 ships — measurable from
the audit log once `if_modified` is populated.

**R2 — the hook arm misses every `Bash` write (accepted, mitigated).** `>`, `sed -i`, `git checkout`,
`npm install` and build output produce no `PostToolUse` `file_path`, so hook-only liveness would be a
lie by omission. The 10 s visibility-gated backstop (§3.6) makes it invisible to the user at the cost
of one listing request per open tab per 10 s. The real fix is the `notify` watcher (v2), and only then
does the poll come out.

**R3 — a file moved out from under a working bot (accepted risk, per D2).** Rename/move is **not**
refused while a session's activity label points into that directory. The bot's next `Edit` fails; the
failure is visible in chat (`post_tool_failure` → the `✗ … failed` label, `hooks.rs:525-531`) and it is
recoverable. Over-protection would make the drive feel haunted, which is the worse failure.

**R4 — `fs_delete` can still delete a company root (pre-existing, out of v1 scope).** The
`refuse_company_root` helper this spec adds for rename is a one-line reuse away from also guarding
`fs_delete` (`files/mod.rs:633`) and, for a member, `company_jail`'s own root. Not introduced here, but
now that the helper exists it should be a follow-up, and it needs an owner call: an owner deleting an
*archived* company's folder from Files is arguably legitimate.

**R5 — D3 is a cross-spec dependency and can land out of order.** If Workflows widens its guard before
the files work merges, nothing breaks (the property it leans on already exists). If Files ships first,
the Workflow step composer simply cannot attach company-folder paths yet. Either order is safe; **the
one unsafe order is Workflows widening the guard to "any path" instead of "`uploads/` OR under the
session's company jail"** — that would be a real member-escape, and it is the Workflows author's to get
right.

**R6 — the `files` frame is this app's first company-routed producer.** `SseEvent::for_company` has no
production caller today (§3.2), so its per-subscriber routing has only ever been exercised by unit
tests (`sse.rs:169,183`). §6.2's `files_frame_is_company_stamped` is therefore load-bearing: it is the
first end-to-end proof that the routing works against a real subscriber.

**R7 — HQ's landing depends on a global env var.** With `SUPERMUX_PROJECT_DIRS` unset,
`projects_repos` returns `{ root: "", entries: [] }` (`files/mod.rs:899-905`) and the HQ card opens an
**empty** space. The UI must say so honestly ("No project folders configured — set
`SUPERMUX_PROJECT_DIRS`") with a crumb up to `/`, not render a blank list. Cheap; easy to forget.

**R8 — no per-company recency signal exists.** §4.1 cuts `idle · 3d` because nothing persists a
last-write timestamp per company, and the shallow root mtime does not mean what the label would claim.
The landing therefore shows a live line only for what this browser session has observed. **Open:** if
the owner wants durable recency, the cheapest honest source is the `audit_log` (`file.put` /
`file.rename` / `file.copy` / `dir.create` rows already carry absolute targets) — a `GET
/api/audit?prefix=` style read, which is a v2 endpoint with a v2 review, not a v1 filler.

---

## Appendix · Code touched (verified anchors @ `d6b73cb`)

| File | What changes |
|---|---|
| `server/src/files/mod.rs` | `TEXT_LIMIT` (:49) → 1 MB · three handlers + 3 routes in `router_for` (:77) · endpoint table (:5-17) · `PutBody.if_modified` (:125) · `put_file` guard (:413) · `get_file` text envelope + `modified` (:404) · `emit_files_event` calls in put/delete/upload (:413,:633,:561) · `company_for_path` helper |
| `server/src/files/transport.rs` | `FileTransport::mkdir` (trait :74-131) · local impl (:133) · SSH impl via the `bash -c SCRIPT "_" $1` idiom (:284-306) · 2 unit tests (:599) |
| `server/src/hooks.rs` | `hook_handler` (:138) gains the post-tool `files` emit; `apply_payload` (:444) untouched |
| `server/src/scope.rs` | **no behaviour change**; 3 new asserts beside (:449) |
| `server/src/state.rs`, `sse.rs` | **untouched** — `SseEvent::for_company` (:193) used as-is |
| `web/src/hooks/use-sse.ts` | `'files'` in `SSE_NAMED_EVENTS` (:63-85) |
| `web/tests/unit/sse-events.test.ts` | scrape regex extended for `SseEvent::for_company(` (:57) |
| `web/src/hooks/use-files.ts` | 3 mutations · `useFilesLive` · `refetchInterval` on `useDirListing` (:25-35) |
| `web/src/lib/api/files.ts` | `mkdir`/`move`/`copy` · `writeFile(…, ifModified?)` (:110-146) |
| `web/src/lib/companies.ts` | `companyForPath` (pure, beside :78-90) |
| `web/src/lib/concurrency.ts` | **new** — `mapWithLimit` |
| `web/src/routes/files.tsx` | Spaces landing · space crumb replaces `SessionPicker` (:229-239) · `+ New` · select mode · `?select=` (:126) |
| `web/src/components/files/file-list.tsx` | row-menu items + select mode (`FileListProps` :30-37, menu :168-206) |
| `web/src/components/files/file-viewer.tsx` | Find button · image via `rawUrl` · truncation banner text (:353-357) · 409 conflict banner |
| `web/src/components/files/code-editor.tsx` | explicit `search({top:true})` in the extensions memo (:61-66) |
| `web/src/stores/files-activity-store.ts` | **new** — observed-activity map for the landing |
| `web/package.json` | declare `@codemirror/search@^6.7.0` (phantom dep today) |
