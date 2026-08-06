//! Integration tests for the agent-team swarm reaper. Spawn REAL private tmux
//! servers in a throwaway TMUX_TMPDIR and reap them. Self-skips without tmux.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use supermux_server::sessions::swarm::{self, SweepOutcome};

fn tmux_available() -> bool {
    which::which("tmux").is_ok()
}

fn temp_tmpdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("supermux-swarm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Spawn a detached private tmux server on `socket` whose one pane runs `cat`
/// forever, exactly the shape Claude Code's agent teams leave behind.
fn spawn_swarm_server(tmpdir: &Path, socket: &str) {
    let status = std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", tmpdir)
        .args(["-L", socket, "new-session", "-d", "-s", "claude-swarm", "cat"])
        .status()
        .expect("spawn tmux");
    assert!(status.success(), "tmux new-session failed");
}

fn server_running(tmpdir: &Path, socket: &str) -> bool {
    std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", tmpdir)
        .args(["-L", socket, "list-sessions"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn kill_leftover(tmpdir: &Path, socket: &str) {
    let _ = std::process::Command::new("tmux")
        .env("TMUX_TMPDIR", tmpdir)
        .args(["-L", socket, "kill-server"])
        .status();
}

/// A PID that is guaranteed dead: spawn a no-op child, reap it, reuse its pid.
/// (Immediate recycling of a just-reaped pid is astronomically unlikely.)
fn dead_pid() -> u32 {
    let child = std::process::Command::new("true").spawn().expect("spawn true");
    let pid = child.id();
    let mut child = child;
    child.wait().unwrap();
    pid
}

#[tokio::test]
async fn reaps_server_with_dead_lead() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);
    assert!(server_running(&dir, &socket));

    let out: SweepOutcome = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.killed.contains(&socket), "killed: {:?} errors: {:?}", out.killed, out.errors);
    // kill-server is synchronous once it lands, but give the process a moment
    let mut gone = false;
    for _ in 0..20 {
        if !server_running(&dir, &socket) {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(gone, "server survived the sweep");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn dry_run_reports_but_kills_nothing() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::ZERO, true).await.unwrap();

    assert!(out.killed.contains(&socket));
    assert!(server_running(&dir, &socket), "dry-run must not kill");
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn keeps_server_with_live_lead() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    // our own test process is the "lead": alive for the duration of the test
    let socket = format!("claude-swarm-{}", std::process::id());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.kept.iter().any(|(n, why)| n == &socket && *why == "lead-alive"));
    assert!(server_running(&dir, &socket));
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn keeps_server_younger_than_grace() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&dir, &socket);

    let out = swarm::sweep_once(&dir, Duration::from_secs(3600), false).await.unwrap();

    assert!(out.kept.iter().any(|(n, why)| n == &socket && *why == "younger-than-grace"));
    assert!(server_running(&dir, &socket));
    kill_leftover(&dir, &socket);
    let _ = std::fs::remove_dir_all(&dir);
}

/// tmux refuses to use a socket dir that grants ANY permission to group/other
/// ("directory ... has unsafe permissions"), so a dir left at the 0755 that
/// create_dir_all produces makes EVERY probe fail for a reason that has nothing
/// to do with server liveness. Tests that hand-build the socket dir must set
/// 0700 or they assert nothing.
fn make_socket_dir(dir: &Path) -> PathBuf {
    let sockdir = swarm::socket_dir(dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o700)).unwrap();
    sockdir
}

#[tokio::test]
async fn removes_stale_socket_files() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = make_socket_dir(&dir);

    // A live server whose lead is alive (our own pid): discovered, kept, and its
    // socket file must survive the GC.
    let live = format!("claude-swarm-{}", std::process::id());
    spawn_swarm_server(&dir, &live);
    // A live server on a reapable name that discovery does NOT match (no
    // claude-swarm- prefix, so no lead pid). Only the liveness probe protects
    // this file, so it is the regression guard for the probe itself: delete the
    // guard and this socket gets unlinked out from under a running server.
    let live_untracked = format!("supermux-sync-test-{}", std::process::id());
    spawn_swarm_server(&dir, &live_untracked);

    // dead leftovers: no server behind them
    std::fs::write(sockdir.join("claude-swarm-99999991"), b"").unwrap();
    std::fs::write(sockdir.join("supermux-sync-test-99999992"), b"").unwrap();
    // NOT ours to touch
    std::fs::write(sockdir.join("default"), b"").unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert_eq!(out.sockets_removed.len(), 2, "{:?}", out.sockets_removed);
    assert!(!sockdir.join("claude-swarm-99999991").exists());
    assert!(!sockdir.join("supermux-sync-test-99999992").exists());
    assert!(sockdir.join("default").exists(), "must never touch non-swarm sockets");
    // live servers: file intact AND still answering
    assert!(sockdir.join(&live).exists(), "unlinked a live tracked server's socket");
    assert!(server_running(&dir, &live));
    assert!(sockdir.join(&live_untracked).exists(), "unlinked a live server's socket");
    assert!(server_running(&dir, &live_untracked));

    kill_leftover(&dir, &live);
    kill_leftover(&dir, &live_untracked);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A probe that fails for a reason other than "nothing is listening" must never
/// be read as "dead". Here the socket dir has unsafe permissions, so tmux
/// refuses every connection attempt; the sweep must keep its hands off the
/// files and report the trouble instead.
#[tokio::test]
async fn keeps_socket_files_when_probe_fails() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let dir = temp_tmpdir();
    let sockdir = swarm::socket_dir(&dir);
    std::fs::create_dir_all(&sockdir).unwrap();
    std::fs::set_permissions(&sockdir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(sockdir.join("claude-swarm-99999993"), b"").unwrap();

    let out = swarm::sweep_once(&dir, Duration::ZERO, false).await.unwrap();

    assert!(out.sockets_removed.is_empty(), "unlinked on an inconclusive probe: {:?}", out.sockets_removed);
    assert!(sockdir.join("claude-swarm-99999993").exists());
    assert!(!out.errors.is_empty(), "an inconclusive probe must be reported");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Sweeping one TMUX_TMPDIR must be blind to servers living in another. Without
/// this the reaper would reach outside its own socket namespace and kill
/// production servers from a test run.
#[tokio::test]
async fn scopes_sweep_to_its_own_tmpdir() {
    if !tmux_available() {
        eprintln!("skipping: tmux not on PATH");
        return;
    }
    let elsewhere = temp_tmpdir();
    let swept = temp_tmpdir();
    // dead lead + zero grace: this server is maximally killable, and the ONLY
    // thing standing between it and the reaper is the tmpdir scoping.
    let socket = format!("claude-swarm-{}", dead_pid());
    spawn_swarm_server(&elsewhere, &socket);
    assert!(server_running(&elsewhere, &socket));

    let out = swarm::sweep_once(&swept, Duration::ZERO, false).await.unwrap();

    assert!(!out.killed.contains(&socket), "killed a server outside the swept tmpdir");
    assert!(
        !out.kept.iter().any(|(n, _)| n == &socket),
        "server outside the swept tmpdir was even considered: {:?}",
        out.kept
    );
    assert!(server_running(&elsewhere, &socket), "server outside the swept tmpdir died");

    kill_leftover(&elsewhere, &socket);
    let _ = std::fs::remove_dir_all(&elsewhere);
    let _ = std::fs::remove_dir_all(&swept);
}
