//! Reaper for leaked Claude agent-team tmux servers.
//!
//! Agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) start one private tmux
//! server per team on socket `claude-swarm-<leadpid>` under TMUX_TMPDIR.
//! Nothing upstream tears that server down when the lead agent exits, so every
//! finished team leaves a detached server full of idle teammate processes
//! (~4% of a core and ~280 MB RSS each; enough of them once OOM-thrashed the
//! host, see the 2026-08-06 incident).
//!
//! Two mechanisms, both in this module:
//!   * targeted teardown at session end (`lead_pid_of` + `spawn_teardown_for_lead`),
//!     wired into lifecycle stop/archive/delete and the SessionEnd hook;
//!   * a periodic sweep (`spawn_reaper` / `sweep_once`) as the safety net for
//!     leads that die without an event (OOM kill, crash), plus stale socket
//!     file cleanup. Kill requires ALL of: lead PID dead, no attached tmux
//!     clients, server older than a grace period. A live PID is never trusted
//!     as "active" (PID recycling); it only ever means "keep", the safe side.

use std::path::Path;
use std::time::Duration;

pub const SOCKET_PREFIX: &str = "claude-swarm-";

/// Socket names this module is allowed to garbage-collect stale FILES for.
/// `supermux-sync-test-*` are leftovers from this crate's own tmux tests.
#[allow(dead_code)]
fn is_reapable_socket_name(name: &str) -> bool {
    name.starts_with(SOCKET_PREFIX) || name.starts_with("supermux-sync-test-")
}

/// `claude-swarm-<pid>` -> `<pid>`. The pid is the lead agent's PID at spawn.
pub fn parse_lead_pid(socket_name: &str) -> Option<u32> {
    socket_name.strip_prefix(SOCKET_PREFIX)?.parse().ok()
}

pub fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat. comm
/// (field 2) may contain spaces and ')', so split after the LAST ')'.
fn starttime_ticks(stat: &str) -> Option<u64> {
    let rest = stat.rsplit_once(')')?.1;
    rest.split_ascii_whitespace().nth(19)?.parse().ok()
}

/// How long a process has been running, from /proc statistics.
pub fn process_age(pid: u32) -> Option<Duration> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks = starttime_ticks(&stat)?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let hz = if hz > 0 { hz as u64 } else { 100 };
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_ascii_whitespace()
        .next()?
        .parse()
        .ok()?;
    let started = ticks as f64 / hz as f64;
    (uptime > started).then(|| Duration::from_secs_f64(uptime - started))
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Kill,
    Keep(&'static str),
}

/// The kill decision. Pure so the matrix is unit-testable. Every "unknown"
/// resolves to Keep: the periodic sweep runs forever, so a false Keep costs
/// one interval while a false Kill costs a live team.
pub fn decide(lead_alive: bool, has_clients: bool, age: Option<Duration>, grace: Duration) -> Verdict {
    if lead_alive {
        return Verdict::Keep("lead-alive");
    }
    if has_clients {
        return Verdict::Keep("has-clients");
    }
    match age {
        Some(a) if a >= grace => Verdict::Kill,
        Some(_) => Verdict::Keep("younger-than-grace"),
        None => Verdict::Keep("age-unknown"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_lead_pid_from_socket_name() {
        assert_eq!(parse_lead_pid("claude-swarm-1199149"), Some(1199149));
        assert_eq!(parse_lead_pid("claude-swarm-"), None);
        assert_eq!(parse_lead_pid("claude-swarm-abc"), None);
        assert_eq!(parse_lead_pid("supermux-sync-test-123"), None);
        assert_eq!(parse_lead_pid("default"), None);
    }

    #[test]
    fn starttime_parses_stat_with_parens_in_comm() {
        // comm can contain spaces and ')' - field 22 (starttime) is index 19
        // counting from the first field after the LAST ')'.
        let stat = "12345 (tmux: server (x)) S 1 12345 12345 0 -1 4194304 5 0 0 0 1 2 0 0 20 0 1 0 987654 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        assert_eq!(starttime_ticks(stat), Some(987654));
        assert_eq!(starttime_ticks("garbage"), None);
    }

    #[test]
    fn decide_matrix() {
        let h = Duration::from_secs(3600);
        // live lead always keeps, regardless of everything else
        assert!(matches!(decide(true, false, Some(h * 10), Duration::ZERO), Verdict::Keep("lead-alive")));
        // attached client keeps
        assert!(matches!(decide(false, true, Some(h * 10), Duration::ZERO), Verdict::Keep("has-clients")));
        // young server keeps
        assert!(matches!(decide(false, false, Some(h), h * 2), Verdict::Keep("younger-than-grace")));
        // unknown age keeps (safe direction)
        assert!(matches!(decide(false, false, None, Duration::ZERO), Verdict::Keep("age-unknown")));
        // dead lead + no clients + old enough kills
        assert!(matches!(decide(false, false, Some(h * 3), h * 2), Verdict::Kill));
        // exactly at the grace boundary kills (>=)
        assert!(matches!(decide(false, false, Some(h), h), Verdict::Kill));
    }

    #[test]
    fn pid_alive_self_and_bogus() {
        assert!(pid_alive(std::process::id()));
        // PID 4194304+ is above the default pid_max; can never exist
        assert!(!pid_alive(4_294_967_290));
    }
}
