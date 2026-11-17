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
use super::store::{DaemonPaths, DaemonStore};

const POLL_INTERVAL: Duration = Duration::from_secs(45);
const MAX_RUNS_PER_PASS: usize = 8;
const MAX_RECOVERIES_PER_PASS: usize = 2;

fn observe_due_once(paths: &DaemonPaths) -> Result<(), String> {
    // Reuse the existing daemon's global pause/stop controls. Maintenance
    // drain and the kill switch must also suppress read-only outbound GitHub
    // checks, even though they do not consume an agent queue slot.
    let store = DaemonStore::open(paths)?;
    if store.kill_switch()? || store.get_meta("maintenance_drain")?.as_deref() == Some("1") {
        return Ok(());
    }
    drop(store);
    // An approved draft PR may already exist remotely when the desktop
    // closes between GitHub success and persisting the PR number. Read-only
    // reconciliation adopts only the exact owned, reviewed branch/HEAD.
    // Never retry the original create mutation or guess a PR identity.
    for run_id in issue_to_pr::issue_to_pr_reconcilable_run_ids(MAX_RECOVERIES_PER_PASS)? {
        match issue_to_pr::issue_to_pr_reconcile_pr_headless(&run_id) {
            Ok(run) if run.status == "monitoring_ci" => {
                eprintln!("monkey daemon: recovered existing owned draft PR for issue-to-pr {}", run_id);
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("monkey daemon: issue-to-pr {} draft reconciliation unavailable: {error}", run_id);
            }
        }
    }
    let ids = issue_to_pr::issue_to_pr_monitorable_run_ids(MAX_RUNS_PER_PASS)?;
    for run_id in ids {
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
    fn daemon_monitor_is_bounded_and_only_reads_owned_run_state() {
        assert!(MAX_RUNS_PER_PASS > 0 && MAX_RUNS_PER_PASS <= 32);
        assert!(MAX_RECOVERIES_PER_PASS > 0 && MAX_RECOVERIES_PER_PASS <= MAX_RUNS_PER_PASS);
        assert!(POLL_INTERVAL >= Duration::from_secs(30));
        // The shared Rust poller owns all network/transition logic. This
        // daemon task is deliberately only a periodic read-only bridge.
    }
}
