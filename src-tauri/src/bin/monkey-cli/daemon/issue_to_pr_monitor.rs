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

const POLL_INTERVAL: Duration = Duration::from_secs(45);
const MAX_RUNS_PER_PASS: usize = 8;

fn observe_due_once() -> Result<(), String> {
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

pub(super) fn spawn() {
    tokio::spawn(async move {
        let mut ticker = interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            // gh and worktree verification are synchronous and potentially
            // slow. Never block the resident daemon's queue/heartbeat tick.
            match tokio::task::spawn_blocking(observe_due_once).await {
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
        assert!(POLL_INTERVAL >= Duration::from_secs(30));
        // The shared Rust poller owns all network/transition logic. This
        // daemon task is deliberately only a periodic read-only bridge.
    }
}
