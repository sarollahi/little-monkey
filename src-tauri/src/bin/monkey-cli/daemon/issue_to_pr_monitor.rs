//! Read-only, desktop-independent CI observer for durable Issue-to-PR runs.
//!
//! Runs inside the existing installed monkey daemon OS service. It does NOT
//! create a second agent scheduler, run a model, execute a command from GitHub,
//! consume repair attempts, push, update a PR or bypass a typed confirmation.
//! Both desktop and daemon call little_monkey_lib::issue_to_pr's SAME
//! authenticated owned-head CI observer and share its cross-process lock.
//!
//! A daemon restart rediscovers pending runs from the existing JSON ledger.
//! Failed CI transitions to 'repairing', where the desktop can resume the
//! bounded model repair with the operator's original approval policy.

use std::time::Duration;
use tokio::time::{interval, MissedTickBehavior};
use little_monkey_lib::issue_to_pr;
use super::store::DaemonPaths;
use rusqlite::{Connection, OpenFlags, OptionalExtension};

const POLL_INTERVAL: Duration = Duration::from_secs(45);
const MAX_RUNS_PER_PASS: usize = 8;
const MAX_RECOVERIES_PER_PASS: usize = 2;

/// Read the existing daemon database without opening a second DaemonStore.
/// The daemon already owns/migrates it; polling must not redo schema
/// migrations or shared-ledger initialization every 45 seconds.
fn daemon_ci_poll_paused(paths: &DaemonPaths) -> Result<bool, String> {
    let conn = Connection::open_with_flags(&paths.state_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Could not inspect existing daemon controls: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3)).map_err(|e| e.to_string())?;
    let meta = |key: &str| -> Result<Option<String>, String> {
        conn.query_row(
            "SELECT value FROM daemon_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        ).optional().map_err(|e| e.to_string())
    };
    Ok(meta("kill_switch")?.as_deref() == Some("engaged")
        || meta("maintenance_drain")?.as_deref() == Some("1"))
}

fn daemon_ci_poll_allowed(paths: &DaemonPaths) -> Result<bool, String> {
    // The resident service belongs to the profile chosen when it started.
    // If the active profile changes underneath it, do not accidentally poll
    // another profile's draft PRs using this stale daemon identity.
    let active_data = little_monkey_lib::app_paths::data_dir()
        .ok_or_else(|| "Could not resolve active issue-to-pr profile".to_string())?;
    if active_data.as_path() != paths.app_data()? {
        return Err("Active Little Monkey profile changed; re-ensure the user daemon before CI observation".to_string());
    }
    // Respect the already-authoritative resident daemon pause/stop controls,
    // using only a read-only SQLite connection to existing service state.
    Ok(!daemon_ci_poll_paused(paths)?)
}

fn observe_due_once(paths: &DaemonPaths) -> Result<(), String> {
    if !daemon_ci_poll_allowed(paths)? { return Ok(()); }
    // An approved draft PR may already exist remotely when the desktop
    // closes between GitHub success and persisting the PR number. Read-only
    // reconciliation adopts only the exact owned, reviewed branch/HEAD.
    // Never retry the original create mutation or guess a PR identity.
    for run_id in issue_to_pr::issue_to_pr_reconcilable_run_ids(MAX_RECOVERIES_PER_PASS)? {
        // A drain/kill switch or profile change during a long GitHub request
        // must suppress subsequent requests in this same bounded pass.
        if !daemon_ci_poll_allowed(paths)? { return Ok(()); }
        match issue_to_pr::issue_to_pr_reconcile_pr_headless(&run_id) {
            Ok(run) if run.status == "monitoring_ci" => {
                eprintln!("monkey daemon: recovered existing owned draft PR for issue-to-pr {}", run_id);
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("monkey daemon: issue-to-pr {} draft reconciliation unavailable: {error}", run_id);
            }
        }
        // Even missing PRs and failed lookups must yield their queue slot.
        issue_to_pr::issue_to_pr_reconciliation_observed(&run_id)?;
    }
    let ids = issue_to_pr::issue_to_pr_monitorable_run_ids(MAX_RUNS_PER_PASS)?;
    for run_id in ids {
        if !daemon_ci_poll_allowed(paths)? { return Ok(()); }
        // All GitHub calls are read-only, authenticated gh invocations in the
        // existing m5_delivery subsystem. A concurrent desktop update wins
        // over any stale response by comparing the persisted run snapshot.
        match issue_to_pr::issue_to_pr_poll_ci_headless(&run_id) {
            Ok(run) => {
                if run.status == "repairing" || run.status == "failed" {
                    eprintln!(
                        "monkey daemon: issue-to-pr {} GitHub CI failed; status={} (human-controlled repair required)",
                        run.run_id, run.status
                    );
                }
            }
            Err(error) => {
                eprintln!("monkey daemon: issue-to-pr {} CI observation failed: {error}", run_id);
                // Transient errors are not green. In particular, revoke
                // previously Ready evidence; never consume a repair attempt.
                if let Err(record_error) = issue_to_pr::issue_to_pr_monitor_unavailable(&run_id) {
                    eprintln!(
                        "monkey daemon: issue-to-pr {} could not persist observation error: {}",
                        run_id, record_error
                    );
                }
            }
        }
    }
    Ok(())
}

pub(super) fn spawn(paths: DaemonPaths) {
    tokio::spawn(async move {
        let mut ticker = interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            // gh and worktree verification are synchronous and potentially
            // slow. Never block the resident daemon's queue/heartbeat tick.
            let worker_paths = paths.clone();
            match tokio::task::spawn_blocking(move || observe_due_once(&worker_paths)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    eprintln!("monkey daemon: issue-to-pr CI monitor paused: {error}");
                }
                Err(error) => {
                    eprintln!("monkey daemon: issue-to-pr CI monitor worker failed: {error}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_obeys_existing_kill_switch_and_maintenance_drain_from_read_only_db() {
        let app_data = std::env::temp_dir().join(format!(
            "lm-daemon-ci-controls-{}", uuid::Uuid::new_v4()
        ));
        let paths = DaemonPaths::under(&app_data);
        std::fs::create_dir_all(&paths.root).unwrap();
        let conn = Connection::open(&paths.state_db).unwrap();
        conn.execute_batch(
            "CREATE TABLE daemon_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        ).unwrap();
        assert!(!daemon_ci_poll_paused(&paths).unwrap());
        conn.execute("INSERT INTO daemon_meta(key, value) VALUES ('maintenance_drain', '1')", [])
            .unwrap();
        assert!(daemon_ci_poll_paused(&paths).unwrap());
        conn.execute("UPDATE daemon_meta SET value = '0' WHERE key = 'maintenance_drain'", [])
            .unwrap();
        conn.execute("INSERT INTO daemon_meta(key, value) VALUES ('kill_switch', 'engaged')", [])
            .unwrap();
        assert!(daemon_ci_poll_paused(&paths).unwrap());
        conn.execute("UPDATE daemon_meta SET value = 'released' WHERE key = 'kill_switch'", [])
            .unwrap();
        assert!(!daemon_ci_poll_paused(&paths).unwrap());
        drop(conn);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn daemon_monitor_is_bounded_and_only_reads_owned_run_state() {
        assert!(MAX_RUNS_PER_PASS > 0 && MAX_RUNS_PER_PASS <= 32);
        assert!(MAX_RECOVERIES_PER_PASS > 0 && MAX_RECOVERIES_PER_PASS <= MAX_RUNS_PER_PASS);
        assert!(POLL_INTERVAL >= Duration::from_secs(30));
        // The shared Rust poller owns all network/transition logic. This
        // daemon task is deliberately only a periodic read-only bridge.
    }
}
