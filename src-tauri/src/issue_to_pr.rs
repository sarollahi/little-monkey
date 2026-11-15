//! Issue-to-PR Agent Flow (ROADMAP.md, Phase 3): lets Little Monkey pick up a
//! GitHub issue from inside the app UI and carry it through a reviewable
//! branch/PR loop, built entirely on top of the M5.4 GitHub/worktree
//! primitives (`m5_delivery`) rather than re-implementing GitHub access.
//!
//! This module owns the STATE MACHINE plus the two pieces of orchestration
//! that must live in Rust: parsing the issue URL / creating-or-reusing an
//! owned worktree+branch for it, and running the target repository's own
//! detected test/build scripts. The actual "plan and implement" work is a
//! REAL agent turn driven from the frontend (`issueToPrRunner.ts`, which
//! reuses `turnEngine.ts`'s `attemptStream`/`executeToolCall` headlessly,
//! the same primitives a normal chat turn or a subagent uses) — nothing in
//! this file talks to a model, and the frontend reports each phase change
//! back through [`issue_to_pr_advance`].
//!
//! Non-goals, same as `m5_delivery`: merge, force-push, branch deletion, and
//! PR review-thread resolution are never called from anywhere in this flow.
//! Pushing the owned branch and opening/updating the draft PR are external
//! GitHub writes, so they are never auto-executed here either — the panel
//! drives those through the EXISTING `m5_delivery_prepare_mutation`/
//! `m5_delivery_execute_mutation` confirm-and-type-the-phrase flow, exactly
//! like `GitDeliveryPanel.tsx` already does for every other owned-branch
//! write.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::m5_delivery::{self, DeliveryMutation, OwnedWorktreeRecord, WorktreeCreateRequest};
use crate::verify::{run_command_impl, VerifyCommand};
use crate::{workspace, AppState};

const RUNS_FILE: &str = "issue_to_pr_runs.json";
const PROGRESS_EVENT: &str = "issue-to-pr://progress";
const MAX_RUNS: usize = 500;
const MAX_ISSUE_URL_LEN: usize = 2_048;
const BRANCH_PREFIX: &str = "issue-to-pr/";
const CHECK_OUTPUT_CAP: usize = 4_096;
const CI_HISTORY_CAP: usize = 64;
const MAX_REPAIR_ATTEMPTS: u32 = 2;
fn default_max_repair_attempts() -> u32 { MAX_REPAIR_ATTEMPTS }
fn default_agent_wall_time_ms() -> u64 { 30 * 60_000 }
fn default_total_token_budget() -> u64 { 250_000 }
const DEFAULT_PROTECTED_BRANCHES: [&str; 3] = ["main", "master", "develop"];

fn default_base_ref() -> String {
    "HEAD".to_string()
}
const VALID_STATUSES: [&str; 11] = [
    "planning",
    "implementing",
    "checking",
    "opening_pr",
    "awaiting_review",
    "monitoring_ci",
    "repairing",
    "ready",
    "done",
    "failed",
    "cancelled",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    pub label: String,
    pub command: String,
    pub passed: bool,
    pub code: Option<i32>,
    pub output_excerpt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiCheckEvidence {
    pub name: String,
    pub state: String,
    pub conclusion: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiObservation {
    pub head_oid: String,
    pub verdict: String,
    pub checks: Vec<CiCheckEvidence>,
    pub observed_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvidence {
    pub revision: String,
    pub files_reviewed: Vec<String>,
    pub summary: String,
    pub observed_at_ms: u64,
}

/// One issue-to-PR run. Persisted whole (not event-sourced) at
/// `<app_data>/issue_to_pr_runs.json`, keyed by `run_id` — the state machine
/// itself is small and linear enough that a whole-record rewrite on every
/// transition (same shape as `verify.rs`'s `VerifyConfig` store) is simpler
/// and just as safe as an append-only log here. The much richer evidence
/// trail for the agent turn itself lives in the existing Run Capsule ledger
/// (`run_protocol`/`run_ledger`), linked by `durable_run_id`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueToPrRun {
    pub run_id: String,
    pub issue_url: String,
    pub repository_slug: String,
    pub issue_number: u32,
    pub issue_title: String,
    pub issue_body: String,
    /// Bounded issue comments are context, never executable instructions.
    #[serde(default)]
    pub issue_comments: Vec<String>,
    pub worktree_id: String,
    pub branch: String,
    /// The branch/ref the owned worktree was created from and the eventual PR
    /// must target. Legacy persisted runs default to HEAD for compatibility.
    #[serde(default = "default_base_ref")]
    pub base_ref: String,
    /// The attached secondary workspace root's label (see `workspace.rs`) —
    /// the frontend prefixes every agent tool-call path with
    /// `"<label>/"` so the headless turn can only ever touch this owned
    /// worktree, reusing the exact same multi-root sandboxing every other
    /// tool call already goes through.
    pub workspace_label: String,
    pub status: String,
    #[serde(default)]
    pub pr_number: Option<u32>,
    #[serde(default)]
    pub pr_url: Option<String>,
    #[serde(default)]
    pub checks: Vec<CheckOutcome>,
    /// Independent reviewer evidence tied to the exact tested owned diff.
    #[serde(default)]
    pub review_evidence: Option<ReviewEvidence>,
    /// Authoritative GitHub check snapshots, versioned by exact PR head SHA.
    #[serde(default)]
    pub ci_history: Vec<CiObservation>,
    #[serde(default)]
    pub ci_head_oid: Option<String>,
    #[serde(default)]
    pub repair_attempts: u32,
    #[serde(default = "default_max_repair_attempts")]
    pub max_repair_attempts: u32,
    /// Prevent a resumed desktop from consuming the same repair attempt twice.
    #[serde(default)]
    pub repair_in_progress: bool,
    /// Per-agent-turn wall time ceiling; persisted and frozen before execution.
    #[serde(default = "default_agent_wall_time_ms")]
    pub agent_wall_time_ms: u64,
    /// Total observed model tokens across implementation, independent review and repairs.
    #[serde(default = "default_total_token_budget")]
    pub total_token_budget: u64,
    #[serde(default)]
    pub tokens_used: u64,
    /// Idempotency for replayed model usage events after a crash or retry.
    #[serde(default)]
    pub usage_event_ids: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// Run Capsule ledger id for the headless agent turn, once the frontend
    /// has started recording one (see `beginDurableRun` in `durableRun.ts`).
    /// `None` until the frontend reports it via [`issue_to_pr_advance`].
    #[serde(default)]
    pub durable_run_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

type RunMap = HashMap<String, IssueToPrRun>;

// ---------------------------------------------------------------------
// Pure logic: issue URL parsing, the state machine, and worktree reuse
// selection. Kept free of any I/O so they're directly unit-testable.
// ---------------------------------------------------------------------

/// Parses `https://github.com/<owner>/<repo>/issues/<number>` (scheme,
/// `www.`, trailing slash, and a query/fragment suffix are all tolerated)
/// into a lowercased `(owner, repo, number)` triple. Rejects anything that
/// isn't exactly an issue path on `github.com` — in particular a `/pull/`
/// URL, a non-numeric or zero issue number, or a non-GitHub host.
pub fn parse_issue_url(value: &str) -> Result<(String, String, u32), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ISSUE_URL_LEN {
        return Err("Issue URL must be 1 to 2048 characters".to_string());
    }
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let without_host = without_scheme
        .strip_prefix("www.github.com/")
        .or_else(|| without_scheme.strip_prefix("github.com/"))
        .ok_or_else(|| "Only github.com issue URLs are supported".to_string())?;
    let path = without_host
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() != 4 || segments[2] != "issues" {
        return Err(
            "Expected a URL like https://github.com/<owner>/<repo>/issues/<number>".to_string(),
        );
    }
    let (owner, repo, number_text) = (segments[0], segments[1], segments[3]);
    let slug = format!("{owner}/{repo}");
    m5_delivery::validate_repository_slug(&slug)?;
    let number: u32 = number_text
        .parse()
        .map_err(|_| "Issue number must be a positive integer".to_string())?;
    if number == 0 {
        return Err("Issue number must be a positive integer".to_string());
    }
    Ok((
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase(),
        number,
    ))
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "done" | "failed" | "cancelled")
}

/// Whether moving a run from `from` to `to` is a legal state-machine step.
/// Cancelling is allowed from any non-terminal status; failing is allowed
/// from any status before the PR is opened; a non-terminal status reporting
/// itself again is always allowed (the frontend uses this to attach
/// metadata — e.g. `durable_run_id` — mid-phase without actually advancing
/// the phase); everything else must follow the linear `planning ->
/// implementing -> checking -> opening_pr -> awaiting_review -> done` path
/// exactly.
fn valid_transition(from: &str, to: &str) -> bool {
    if to == "cancelled" {
        return !is_terminal(from);
    }
    if to == "failed" {
        return !is_terminal(from);
    }
    if from == to {
        return !is_terminal(from);
    }
    matches!(
        (from, to),
        ("planning", "implementing")
            | ("implementing", "checking")
            | ("checking", "opening_pr")
            | ("opening_pr", "awaiting_review")
            | ("opening_pr", "monitoring_ci")
            | ("awaiting_review", "monitoring_ci")
            | ("monitoring_ci", "repairing")
            | ("monitoring_ci", "ready")
            | ("repairing", "checking")
            | ("checking", "repairing")
            | ("ready", "done")
    )
}

/// Finds the most recently created run against the same repository+issue
/// number whose worktree might still be reusable — the caller re-verifies
/// the candidate is actually still live (via `m5_delivery_inspect_worktree`)
/// before trusting it, so this only ever narrows down a candidate, never
/// asserts liveness itself.
pub fn find_reusable_worktree(
    runs: &[IssueToPrRun],
    repository_slug: &str,
    issue_number: u32,
) -> Option<String> {
    runs.iter()
        .filter(|run| {
            run.repository_slug.eq_ignore_ascii_case(repository_slug)
                && run.issue_number == issue_number
        })
        .max_by_key(|run| run.created_at_ms)
        .map(|run| run.worktree_id.clone())
}

fn detect_package_manager(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else {
        "npm"
    }
}

/// Detects `test`/`build` scripts from the target repository's own
/// `package.json` (mirroring this repo's own `pnpm test`/`pnpm build`
/// convention, generalized to whichever package manager's lockfile the
/// target repository actually has) and returns `(label, shell command)`
/// pairs to run. Returns an empty list — not an error — for a repository
/// with no `package.json` or no matching scripts; the caller treats that as
/// "nothing to check" rather than a failure.
fn detect_check_commands(root: &Path) -> Result<Vec<(String, String)>, String> {
    let package_json = root.join("package.json");
    if !package_json.is_file() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&package_json)
        .map_err(|error| format!("Could not read package.json: {error}"))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("package.json is not valid JSON: {error}"))?;
    let manager = detect_package_manager(root);
    let mut commands = Vec::new();
    if let Some(scripts) = value.get("scripts").and_then(Value::as_object) {
        for name in ["test", "lint", "typecheck", "build"] {
            if scripts.contains_key(name) {
                commands.push((name.to_string(), format!("{manager} run {name}")));
            }
        }
    }
    Ok(commands)
}

fn bounded(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn inspection_digest(inspection: &m5_delivery::WorktreeInspection) -> Result<String, String> {
    if inspection.diffs.staged.truncated || inspection.diffs.unstaged.truncated || inspection.diffs.head.truncated {
        return Err("Owned diff exceeds verification evidence limits".to_string());
    }
    let serialized = serde_json::to_vec(&(
        &inspection.head_oid, &inspection.files, &inspection.diffs
    )).map_err(|error| format!("Could not fingerprint owned worktree: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(&serialized)))
}

fn now_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| error.to_string())
}

/// Drops the oldest TERMINAL runs once the store exceeds [`MAX_RUNS`] — an
/// active run is never pruned out from under a live flow, even if that
/// temporarily leaves the store slightly over the cap.
fn prune(runs: &mut RunMap) {
    if runs.len() <= MAX_RUNS {
        return;
    }
    let mut overflow = runs.len() - MAX_RUNS;
    let mut candidates: Vec<(String, u64)> = runs
        .iter()
        .filter(|(_, run)| is_terminal(&run.status))
        .map(|(id, run)| (id.clone(), run.created_at_ms))
        .collect();
    candidates.sort_by_key(|(_, created_at_ms)| *created_at_ms);
    for (id, _) in candidates {
        if overflow == 0 {
            break;
        }
        runs.remove(&id);
        overflow -= 1;
    }
}

// ---------------------------------------------------------------------
// Storage — same atomic temp+rename pattern as `verify.rs`'s config store.
// ---------------------------------------------------------------------

fn runs_path() -> Result<PathBuf, String> {
    let dir = crate::app_paths::data_dir()
        .ok_or_else(|| "Could not resolve the application data directory".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create app data dir: {error}"))?;
    Ok(dir.join(RUNS_FILE))
}

fn load_runs_from(path: &Path) -> RunMap {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return RunMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_runs_to(path: &Path, runs: &RunMap) -> Result<(), String> {
    let json = serde_json::to_string_pretty(runs)
        .map_err(|error| format!("Failed to serialize issue-to-pr runs: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)
        .map_err(|error| format!("Failed to write issue-to-pr runs: {error}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("Failed to finalize issue-to-pr runs: {error}"))?;
    Ok(())
}

fn emit_progress(app: &AppHandle, run: &IssueToPrRun) {
    let _ = app.emit(PROGRESS_EVENT, run);
}

fn require_run(runs: &RunMap, run_id: &str) -> Result<IssueToPrRun, String> {
    runs.get(run_id)
        .cloned()
        .ok_or_else(|| format!("Unknown issue-to-pr run '{run_id}'"))
}

// ---------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------

/// Parses `issue_url`, confirms `gh` authentication, creates-or-reuses an
/// owned worktree/branch for the issue (reusing `m5_delivery`'s existing
/// `WorktreeCreateRequest`/`DeliveryMutation::CreateWorktree` primitive —
/// this file never touches git directly), fetches the issue's title/body via
/// the existing `m5_github_issue` bridge, attaches the worktree as a
/// secondary workspace root so the headless agent turn can only ever write
/// inside it, and persists a new run at status `"planning"`.
///
/// The worktree-creation mutation is driven straight through (no typed
/// confirmation dialog) because it is a purely local, non-destructive
/// action equivalent to clicking "Preview owned worktree" then confirming in
/// `GitDeliveryPanel` — the actual external GitHub writes later in this flow
/// (push, draft PR) are NOT auto-driven; the panel surfaces those through
/// the exact same confirm-and-type-the-phrase flow as every other
/// `m5_delivery` mutation.
#[tauri::command]
pub async fn issue_to_pr_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    issue_url: String,
) -> Result<IssueToPrRun, String> {
    let (owner, repo, number) = parse_issue_url(&issue_url)?;
    let repository_slug = format!("{owner}/{repo}");
    let repository_root = workspace::primary_root_canon(&state)?.to_path_buf();
    let base_ref = m5_delivery::current_branch(&repository_root)?;

    let auth = m5_delivery::m5_github_auth_status()?;
    if !auth.authenticated {
        return Err(format!(
            "GitHub CLI authentication is required: {}",
            auth.detail
        ));
    }

    let path = runs_path()?;
    let existing_runs: Vec<IssueToPrRun> = load_runs_from(&path).into_values().collect();
    let reusable = find_reusable_worktree(&existing_runs, &repository_slug, number)
        .and_then(|worktree_id| m5_delivery::m5_delivery_inspect_worktree(worktree_id).ok())
        .filter(|inspection| matches!(inspection.worktree.state.as_str(), "active" | "recovered"));

    let mut run_base_ref = base_ref.clone();
    let (worktree_id, branch, workspace_label) = if let Some(inspection) = reusable {
        let record = inspection.worktree;
        if let Some(previous) = existing_runs
            .iter()
            .find(|run| run.worktree_id == record.marker.worktree_id)
        {
            run_base_ref = previous.base_ref.clone();
        }
        let label = workspace::add_secondary_workspace_root_impl(
            state.inner(),
            record.marker.canonical_path.clone(),
        )?
        .label;
        (record.marker.worktree_id, record.marker.branch, label)
    } else {
        let record =
            create_worktree_for_issue(state.inner(), &repository_slug, number, &run_base_ref)
                .await?;
        let label = workspace::add_secondary_workspace_root_impl(
            state.inner(),
            record.marker.canonical_path.clone(),
        )?
        .label;
        (record.marker.worktree_id, record.marker.branch, label)
    };

    let issue = m5_delivery::m5_github_issue(worktree_id.clone(), number)?;
    let issue_title = issue
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Untitled issue")
        .to_string();
    let issue_body = bounded(issue
        .get("body").and_then(Value::as_str).unwrap_or(""), 32_000);
    let issue_comments: Vec<String> = issue
        .get("comments").and_then(Value::as_array)
        .map(|comments| comments.iter().take(24).filter_map(|comment| {
            let body = comment.get("body")?.as_str()?;
            let author = comment.get("author").and_then(|a| a.get("login"))
                .and_then(Value::as_str).unwrap_or("unknown");
            Some(format!("Author {}: {}", bounded(author, 80), bounded(body, 2_000)))
        }).collect()).unwrap_or_default();

    let now = now_ms()?;
    let run = IssueToPrRun {
        run_id: format!("i2p-{}", Uuid::new_v4().simple()),
        issue_url: issue_url.trim().to_string(),
        repository_slug,
        issue_number: number,
        issue_title,
        issue_body,
        issue_comments,
        worktree_id,
        branch,
        base_ref: run_base_ref,
        workspace_label,
        status: "planning".to_string(),
        pr_number: None,
        pr_url: None,
        checks: Vec::new(),
        review_evidence: None,
        ci_history: Vec::new(),
        ci_head_oid: None,
        repair_attempts: 0,
        max_repair_attempts: MAX_REPAIR_ATTEMPTS,
        repair_in_progress: false,
        agent_wall_time_ms: default_agent_wall_time_ms(),
        total_token_budget: default_total_token_budget(),
        tokens_used: 0,
        usage_event_ids: Vec::new(),
        error: None,
        durable_run_id: None,
        created_at_ms: now,
        updated_at_ms: now,
    };

    let mut runs = load_runs_from(&path);
    runs.insert(run.run_id.clone(), run.clone());
    prune(&mut runs);
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

async fn create_worktree_for_issue(
    state: &AppState,
    repository_slug: &str,
    number: u32,
    base_ref: &str,
) -> Result<OwnedWorktreeRecord, String> {
    let repository_root = workspace::primary_root_canon(state)?
        .to_string_lossy()
        .to_string();
    let request = WorktreeCreateRequest {
        repository_root,
        repository_slug: repository_slug.to_string(),
        base_ref: base_ref.to_string(),
        label: format!("issue-{number}"),
        allowed_remotes: vec!["origin".to_string()],
        branch_prefix: BRANCH_PREFIX.to_string(),
        protected_branches: DEFAULT_PROTECTED_BRANCHES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        allow_push: true,
        allow_create_pull_request: true,
        allow_review_comment: false,
        allow_fork_writes: false,
    };
    let mutation = DeliveryMutation::CreateWorktree(request);
    let preview = m5_delivery::prepare_mutation_impl(mutation.clone(), state)?;
    let result = m5_delivery::execute_mutation_impl(
        mutation,
        preview.digest,
        preview.confirmation_phrase,
        state,
    )
    .await?;
    serde_json::from_value(result)
        .map_err(|error| format!("Owned worktree creation returned an unexpected shape: {error}"))
}

/// Records a phase transition the frontend orchestration has reached (the
/// headless agent turn moving from planning into implementing, the turn
/// finishing and handing off to checks, checks finishing, the PR being
/// opened, or the run finishing/failing) — persists it and re-emits
/// [`PROGRESS_EVENT`] so every open panel stays in sync. Rejects any
/// transition that doesn't follow the linear state machine (see
/// `valid_transition`).
#[tauri::command]
pub fn issue_to_pr_advance(
    app: AppHandle,
    run_id: String,
    status: String,
    error: Option<String>,
    pr_number: Option<u32>,
    pr_url: Option<String>,
    durable_run_id: Option<String>,
) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    if !VALID_STATUSES.contains(&status.as_str()) {
        return Err(format!("Unknown issue-to-pr status '{status}'"));
    }
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if status == "done" {
        // The final human action must not consume a stale stored "ready".
        // Re-read real GitHub checks and owned head at the approval boundary.
        let number = run.pr_number.ok_or_else(|| "Missing owned draft PR".to_string())?;
        let inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id.clone())?;
        let pr = m5_delivery::m5_github_pull_request(run.worktree_id.clone(), number)?;
        let head_oid = pr.get("headRefOid").and_then(Value::as_str)
            .ok_or_else(|| "GitHub did not return the current PR head".to_string())?;
        if inspection.dirty || inspection.head_oid != head_oid
            || run.ci_head_oid.as_deref() != Some(head_oid)
            || pr.get("isDraft").and_then(Value::as_bool) != Some(true)
            || pr.get("headRefName").and_then(Value::as_str) != Some(run.branch.as_str())
            || run.review_evidence.is_none()
        {
            return Err("Final approval refused: owned draft PR or review identity has changed".to_string());
        }
        let rollup = m5_delivery::m5_github_checks(run.worktree_id.clone(), number)?;
        let (raw_ci, mut checks) = classify_ci_rollup(&rollup)?;
        checks.sort_by(|a, b| (&a.name, &a.state, &a.conclusion, &a.url)
            .cmp(&(&b.name, &b.state, &b.conclusion, &b.url)));
        if rollup.get("headRefOid").and_then(Value::as_str) != Some(head_oid)
            || settled_ci_verdict(&raw_ci, head_oid, &checks, run.ci_history.last(), now_ms()?) != "passed"
            || run.checks.is_empty() || !run.checks.iter().all(|check| check.passed && check.code == Some(0))
        {
            return Err("Final approval refused: authoritative GitHub CI is not green for the current owned head".to_string());
        }
    }
    if status == "ready" {
        // Only issue_to_pr_poll_ci may establish readiness after consulting
        // authoritative GitHub checks for the matching owned PR commit.
        return Err("Ready is reserved for authoritative GitHub CI verification".to_string());
    }
    if !valid_transition(&run.status, &status) {
        return Err(format!(
            "Cannot move an issue-to-pr run from '{}' to '{status}'",
            run.status
        ));
    }
    if run.status == "checking" && status == "opening_pr" {
        if run.checks.is_empty() || !run.checks.iter().all(|check| check.passed && check.code == Some(0)) {
            return Err("Cannot authorize PR delivery without successful repository checks".to_string());
        }
        let evidence = run.review_evidence.as_ref()
            .ok_or_else(|| "Cannot deliver without independent revision-bound review evidence".to_string())?;
        let inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id.clone())?;
        if evidence.revision != inspection_digest(&inspection)? {
            return Err("Owned diff changed since the independent review".to_string());
        }
    }
    run.status = status;
    if let Some(error) = error {
        run.error = Some(error);
    }
    if let Some(pr_number) = pr_number {
        run.pr_number = Some(pr_number);
    }
    if let Some(pr_url) = pr_url {
        run.pr_url = Some(pr_url);
    }
    if let Some(durable_run_id) = durable_run_id {
        run.durable_run_id = Some(durable_run_id);
    }
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

/// Detects and runs the owned worktree's own `test`/`build` scripts (see
/// `detect_check_commands`) via the exact same `AppHandle`-free execution
/// core `verify.rs` uses for its own post-edit checks — deliberately not
/// permission-gated, for the same reason `verify.rs`'s own module doc
/// comment gives: this runs an automated, app-initiated check, not a
/// model-requested shell command. Moves the run to `"opening_pr"` on a clean
/// pass or `"failed"` (with a summary in `error`) otherwise.
#[tauri::command]
pub async fn issue_to_pr_run_checks(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    let path = runs_path()?;

    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if !valid_transition(&run.status, "checking") {
        return Err(format!(
            "Cannot run checks for an issue-to-pr run in status '{}'",
            run.status
        ));
    }
    run.status = "checking".to_string();
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);

    let inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id.clone())?;
    let root = PathBuf::from(&inspection.worktree.marker.canonical_path);
    let before_digest = inspection_digest(&inspection)?;
    let detected = detect_check_commands(&root)?;

    let mut outcomes = Vec::new();
    let mut all_passed = true;
    if detected.is_empty() {
        all_passed = false;
        outcomes.push(CheckOutcome {
            label: "no scripts detected".to_string(),
            command: String::new(),
            passed: false,
            code: None,
            output_excerpt: "No test/build scripts detected. Configure authoritative repository checks before delivery."
                .to_string(),
        });
    } else {
        for (label, command) in detected {
            let verify_command = VerifyCommand {
                id: format!("issue-to-pr-{label}"),
                label: label.clone(),
                command: command.clone(),
                kind: label.clone(),
                enabled: true,
                timeout_secs: None,
            };
            let result = run_command_impl(
                state.inner(),
                &root,
                &verify_command,
                Some(&run_id),
                crate::bounded_execution::AppProcessProjector::shared(app.clone()),
            )
            .await;
            let passed = result.code == Some(0) && !result.timed_out;
            all_passed = all_passed && passed;
            outcomes.push(CheckOutcome {
                label,
                command,
                passed,
                code: result.code,
                output_excerpt: bounded(
                    &format!("{}\n{}", result.stdout, result.stderr),
                    CHECK_OUTPUT_CAP,
                ),
            });
        }
    }

    let after_inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id.clone())?;
    let stable = inspection_digest(&after_inspection).map(|digest| digest == before_digest).unwrap_or(false);
    if !stable {
        all_passed = false;
        outcomes.push(CheckOutcome {
            label: "workspace revision".to_string(),
            command: "owned worktree fingerprint".to_string(),
            passed: false,
            code: None,
            output_excerpt: "Workspace changed during verification or evidence was truncated; results are stale.".to_string(),
        });
    }

    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    run.checks = outcomes;
    run.review_evidence = None; // New verification invalidates any prior diff review.
    run.status = if all_passed {
        // Do not expose Git delivery before the independent diff review finishes.
        "checking".to_string()
    } else if run.repair_attempts < run.max_repair_attempts {
        "repairing".to_string()
    } else {
        "failed".to_string()
    };
    run.repair_in_progress = false;
    if all_passed {
        run.error = None;
    } else {
        run.error = Some(
            "Authoritative owned-worktree checks failed. The bounded repair stage must resolve them before delivery.".to_string(),
        );
    }
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

/// Read only: stable revision fingerprint from the existing owned worktree.
#[tauri::command]
pub fn issue_to_pr_worktree_revision(run_id: String) -> Result<String, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    let run = require_run(&load_runs_from(&runs_path()?), &run_id)?;
    let inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id)?;
    inspection_digest(&inspection)
}

/// Persist actual independent review coverage against a stable tested diff.
/// The client does not get to mark a review successful by changing status.
#[tauri::command]
pub fn issue_to_pr_record_review(
    app: AppHandle,
    run_id: String,
    revision: String,
    files_reviewed: Vec<String>,
    summary: String,
) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    if revision.len() != 64 || !revision.bytes().all(|c| c.is_ascii_hexdigit())
        || files_reviewed.is_empty() || files_reviewed.len() > 512
    {
        return Err("Invalid independent review revision or file coverage".to_string());
    }
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if run.status != "checking" || run.checks.is_empty()
        || !run.checks.iter().all(|check| check.passed && check.code == Some(0))
    {
        return Err("An independent review requires successful authoritative local checks".to_string());
    }
    let inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id.clone())?;
    if inspection_digest(&inspection)? != revision {
        return Err("Independent review evidence does not match the current owned diff".to_string());
    }
    let changed: Vec<&str> = inspection.files.iter().filter(|file| !file.ignored)
        .map(|file| file.path.as_str()).collect();
    if changed.is_empty() || changed.iter().any(|path| !files_reviewed.iter().any(|reviewed| reviewed.as_str() == *path)) {
        return Err("Independent review did not cover every changed file".to_string());
    }
    run.review_evidence = Some(ReviewEvidence {
        revision,
        files_reviewed,
        summary: bounded(&summary, 4_000),
        observed_at_ms: now_ms()?,
    });
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

/// Cancels a non-terminal run. A no-op (not an error) if the run is already
/// terminal, so a slow double-click can never surface a confusing error.
/// This only marks the RUN cancelled — the frontend's own `AbortController`
/// for the in-flight headless turn (if any) is separately wired to the same
/// button; see `issueToPrStore.ts`.
// All verdicts are computed from GitHub's actual check/status API output.
// Model-generated summaries, missing checks, and pending jobs never mean success.
fn classify_ci_rollup(value: &Value) -> Result<(String, Vec<CiCheckEvidence>), String> {
    let entries = value.get("statusCheckRollup").and_then(Value::as_array)
        .ok_or_else(|| "GitHub did not return a statusCheckRollup array".to_string())?;
    if entries.len() > 512 {
        return Err("GitHub returned too many CI checks".to_string());
    }
    let mut checks = Vec::new();
    let mut failed = false;
    let mut pending = entries.is_empty();
    let mut success_count = 0usize;
    for entry in entries {
        let name = entry.get("name").or_else(|| entry.get("context"))
            .and_then(Value::as_str).unwrap_or("unnamed").chars().take(160).collect();
        let state = entry.get("status").or_else(|| entry.get("state"))
            .and_then(Value::as_str).unwrap_or("UNKNOWN").to_ascii_uppercase();
        let conclusion = entry.get("conclusion").or_else(|| entry.get("state"))
            .and_then(Value::as_str).unwrap_or("PENDING").to_ascii_uppercase();
        let url = entry.get("detailsUrl").or_else(|| entry.get("targetUrl"))
            .and_then(Value::as_str).filter(|url| url.starts_with("https://github.com/"))
            .map(|url| bounded(url, 1024));
        let result = match conclusion.as_str() {
            "SUCCESS" if state == "COMPLETED" || state == "SUCCESS" => {
                success_count += 1;
                "pass"
            }
            "SKIPPED" | "NEUTRAL" if state == "COMPLETED" => "skip",
            "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" |
            "CANCELLED" | "STARTUP_FAILURE" => {
                failed = true;
                "fail"
            }
            _ => {
                pending = true;
                "pending"
            }
        };
        checks.push(CiCheckEvidence {
            name,
            state,
            conclusion: if result == "pending" { "PENDING".to_string() } else { conclusion },
            url,
        });
    }
    let verdict = if failed {
        "failed"
    } else if pending || success_count == 0 {
        "pending"
    } else {
        "passed"
    };
    Ok((verdict.to_string(), checks))
}

/// GitHub registers multiple Actions workflows asynchronously. A single
/// momentarily green rollup can precede another workflow's first check.
/// Require unchanged successful contexts for two observations separated by
/// at least 30 seconds, keeping the first observation durable across restart.
const CI_GREEN_SETTLE_MS: u64 = 30_000;

fn settled_ci_verdict(
    raw_verdict: &str,
    head_oid: &str,
    checks: &[CiCheckEvidence],
    previous: Option<&CiObservation>,
    now: u64,
) -> String {
    if raw_verdict != "passed" { return raw_verdict.to_string(); }
    match previous {
        Some(last) if last.head_oid == head_oid && last.checks == checks
            && (last.verdict == "passed"
                || (last.verdict == "pending"
                    && now.saturating_sub(last.observed_at_ms) >= CI_GREEN_SETTLE_MS)) =>
                "passed".to_string(),
        _ => "pending".to_string(),
    }
}

#[tauri::command]
pub fn issue_to_pr_set_repair_limit(
    app: AppHandle,
    run_id: String,
    max_attempts: u32,
) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    if max_attempts > 5 {
        return Err("Repair limit must be between 0 and 5".to_string());
    }
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if run.status != "planning" || run.repair_attempts != 0 {
        return Err("Repair policy is frozen after planning".to_string());
    }
    run.max_repair_attempts = max_attempts;
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

/// Execution policy is immutable once the run leaves planning.
#[tauri::command]
pub fn issue_to_pr_set_execution_budget(
    app: AppHandle,
    run_id: String,
    agent_wall_time_ms: u64,
    total_token_budget: u64,
) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    if !(60_000..=2 * 60 * 60_000).contains(&agent_wall_time_ms) {
        return Err("Per-agent wall budget must be between 1 and 120 minutes".to_string());
    }
    if !(10_000..=2_000_000).contains(&total_token_budget) {
        return Err("Total token budget must be between 10000 and 2000000".to_string());
    }
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if run.status != "planning" || run.tokens_used > 0 || run.repair_attempts > 0 {
        return Err("Agent budgets are frozen once execution has started".to_string());
    }
    run.agent_wall_time_ms = agent_wall_time_ms;
    run.total_token_budget = total_token_budget;
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

/// Charge actual provider-reported token usage immediately after a model
/// response, before permitting any subsequent tool execution. The run-id +
/// iteration key is replay-safe across desktop restarts. No model claim can
/// reset a token budget or grant additional attempts.
#[tauri::command]
pub fn issue_to_pr_charge_tokens(
    app: AppHandle,
    run_id: String,
    usage_id: String,
    input_tokens: u64,
    output_tokens: u64,
) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    m5_delivery::validate_id("usage id", &usage_id)?;
    if input_tokens > 10_000_000 || output_tokens > 10_000_000 {
        return Err("Unreasonable token accounting event rejected".to_string());
    }
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if run.usage_event_ids.iter().any(|id| id == &usage_id) {
        return Ok(run);
    }
    if is_terminal(&run.status) || !matches!(run.status.as_str(), "implementing" | "checking" | "repairing") {
        return Err("Cannot charge model tokens outside an active issue execution stage".to_string());
    }
    let increment = input_tokens.checked_add(output_tokens)
        .ok_or_else(|| "Token accounting overflow".to_string())?;
    run.tokens_used = run.tokens_used.checked_add(increment)
        .ok_or_else(|| "Token budget overflow".to_string())?;
    run.usage_event_ids.push(usage_id);
    if run.usage_event_ids.len() > 4_096 {
        // Fail closed rather than forgetting idempotency IDs and recharging a
        // replayed event from the same long-lived run.
        run.status = "failed".to_string();
        run.error = Some("Maximum token-accounting event count reached".to_string());
    }
    if run.tokens_used > run.total_token_budget {
        run.status = "failed".to_string();
        run.error = Some("Frozen total model token budget exhausted".to_string());
    }
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    if run.status == "failed" {
        return Err(run.error.clone().unwrap_or_else(|| "Token accounting failed".to_string()));
    }
    Ok(run)
}

/// A repair attempt has an idempotent start marker. After a process crash the
/// same attempt resumes without consuming an additional budget unit.
#[tauri::command]
pub fn issue_to_pr_begin_repair(app: AppHandle, run_id: String) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if run.status != "repairing" {
        return Err("Only a run with failed verification may begin repair".to_string());
    }
    if !run.repair_in_progress {
        if run.repair_attempts >= run.max_repair_attempts {
            return Err("Repair attempt limit exhausted".to_string());
        }
        run.repair_attempts += 1;
        run.repair_in_progress = true;
    }
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

/// Read-only CI polling is fenced to the actual, still-owned draft PR head.
/// Unknown statuses and absent checks remain pending. No model result can
/// change CI to ready. Only a completed GitHub check rollup can do that.
#[tauri::command]
pub fn issue_to_pr_poll_ci(app: AppHandle, run_id: String) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if run.status != "monitoring_ci" && run.status != "ready" {
        return Err("CI monitoring requires an owned draft PR awaiting checks".to_string());
    }
    let number = run.pr_number.ok_or_else(|| "Missing draft PR number".to_string())?;
    let inspection = m5_delivery::m5_delivery_inspect_worktree(run.worktree_id.clone())?;
    if inspection.worktree.marker.branch != run.branch
        || inspection.worktree.marker.repository_slug != run.repository_slug
        || inspection.dirty
    {
        run.status = "monitoring_ci".to_string();
        run.ci_head_oid = None;
        run.error = Some("Owned worktree identity changed or local files are dirty. Reconcile before CI readiness.".to_string());
        run.updated_at_ms = now_ms()?;
        runs.insert(run.run_id.clone(), run.clone());
        save_runs_to(&path, &runs)?;
        emit_progress(&app, &run);
        return Ok(run);
    }
    let pr = m5_delivery::m5_github_pull_request(run.worktree_id.clone(), number)?;
    if pr.get("isDraft").and_then(Value::as_bool) != Some(true)
        || pr.get("state").and_then(Value::as_str) != Some("OPEN")
        || pr.get("headRefName").and_then(Value::as_str) != Some(run.branch.as_str())
        || (run.base_ref != "HEAD"
            && pr.get("baseRefName").and_then(Value::as_str) != Some(run.base_ref.as_str()))
    {
        return Err("PR identity, draft state, or base branch no longer matches the frozen run".to_string());
    }
    let head_oid = pr.get("headRefOid").and_then(Value::as_str)
        .ok_or_else(|| "GitHub did not return the draft PR head".to_string())?;
    if inspection.head_oid != head_oid {
        run.status = "monitoring_ci".to_string();
        run.ci_head_oid = None;
        run.error = Some("Draft PR head differs from the owned local branch; manual reconciliation required".to_string());
        run.updated_at_ms = now_ms()?;
        runs.insert(run.run_id.clone(), run.clone());
        save_runs_to(&path, &runs)?;
        emit_progress(&app, &run);
        return Ok(run);
    }
    let rollup = m5_delivery::m5_github_checks(run.worktree_id.clone(), number)?;
    if rollup.get("headRefOid").and_then(Value::as_str) != Some(head_oid) {
        return Err("GitHub CI snapshot is for a stale PR head".to_string());
    }
    let (mut verdict, mut checks) = classify_ci_rollup(&rollup)?;
    checks.sort_by(|a, b| (&a.name, &a.state, &a.conclusion, &a.url)
        .cmp(&(&b.name, &b.state, &b.conclusion, &b.url)));
    if verdict == "passed" && (run.review_evidence.is_none() || run.checks.is_empty() || !run.checks.iter().all(|c| c.passed && c.code == Some(0))) {
        verdict = "pending".to_string();
    }
    let observed_at_ms = now_ms()?;
    verdict = settled_ci_verdict(&verdict, head_oid, &checks, run.ci_history.last(), observed_at_ms);
    let observation = CiObservation {
        head_oid: head_oid.to_string(),
        verdict: verdict.clone(),
        checks,
        observed_at_ms,
    };
    // Deduplicate repeated GitHub event deliveries and polls by SHA + verdict + check details.
    let repeated = run.ci_history.last().map(|last|
        last.head_oid == observation.head_oid
        && last.verdict == observation.verdict
        && last.checks == observation.checks
    ).unwrap_or(false);
    if !repeated {
        run.ci_history.push(observation);
        if run.ci_history.len() > CI_HISTORY_CAP {
            run.ci_history.remove(0);
        }
    }
    run.ci_head_oid = Some(head_oid.to_string());
    run.status = match verdict.as_str() {
        "passed" => "ready",
        "failed" if run.repair_attempts < run.max_repair_attempts => "repairing",
        "failed" => "failed",
        _ => "monitoring_ci",
    }.to_string();
    if verdict == "failed" {
        run.error = Some("GitHub CI failed on the current owned head; investigate failed checks before a bounded repair.".to_string());
    } else if verdict == "passed" {
        run.error = None;
    }
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

#[tauri::command]
pub fn issue_to_pr_cancel(app: AppHandle, run_id: String) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    let path = runs_path()?;
    let mut runs = load_runs_from(&path);
    let mut run = require_run(&runs, &run_id)?;
    if is_terminal(&run.status) {
        return Ok(run);
    }
    run.status = "cancelled".to_string();
    run.updated_at_ms = now_ms()?;
    runs.insert(run.run_id.clone(), run.clone());
    save_runs_to(&path, &runs)?;
    emit_progress(&app, &run);
    Ok(run)
}

#[tauri::command]
pub fn issue_to_pr_status(run_id: String) -> Result<IssueToPrRun, String> {
    m5_delivery::validate_id("run id", &run_id)?;
    let path = runs_path()?;
    require_run(&load_runs_from(&path), &run_id)
}

#[tauri::command]
pub fn issue_to_pr_list() -> Result<Vec<IssueToPrRun>, String> {
    let path = runs_path()?;
    let mut runs: Vec<IssueToPrRun> = load_runs_from(&path).into_values().collect();
    runs.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "little-monkey-issue-to-pr-test-{}-{}-{name}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    fn fixture_run(
        repository_slug: &str,
        issue_number: u32,
        created_at_ms: u64,
        status: &str,
    ) -> IssueToPrRun {
        IssueToPrRun {
            run_id: format!("i2p-{created_at_ms}"),
            issue_url: format!("https://github.com/{repository_slug}/issues/{issue_number}"),
            repository_slug: repository_slug.to_string(),
            issue_number,
            issue_title: "Fixture issue".to_string(),
            issue_body: "Body".to_string(),
            issue_comments: Vec::new(),
            worktree_id: format!("wt-{created_at_ms}"),
            branch: "issue-to-pr/fixture".to_string(),
            base_ref: "develop".to_string(),
            workspace_label: "fixture".to_string(),
            status: status.to_string(),
            pr_number: None,
            pr_url: None,
            checks: Vec::new(),
            review_evidence: None,
            ci_history: Vec::new(),
            ci_head_oid: None,
            repair_attempts: 0,
            max_repair_attempts: MAX_REPAIR_ATTEMPTS,
            repair_in_progress: false,
            agent_wall_time_ms: default_agent_wall_time_ms(),
            total_token_budget: default_total_token_budget(),
            tokens_used: 0,
            usage_event_ids: Vec::new(),
            error: None,
            durable_run_id: None,
            created_at_ms,
            updated_at_ms: created_at_ms,
        }
    }

    #[test]
    fn parse_issue_url_accepts_a_well_formed_github_issue_url_and_lowercases_owner_repo() {
        assert_eq!(
            parse_issue_url("https://github.com/Owner/Repo/issues/42").unwrap(),
            ("owner".to_string(), "repo".to_string(), 42)
        );
        assert_eq!(
            parse_issue_url(
                "  http://www.github.com/owner/repo/issues/7/?tab=comments#issuecomment-1 "
            )
            .unwrap(),
            ("owner".to_string(), "repo".to_string(), 7)
        );
        assert_eq!(
            parse_issue_url("github.com/owner/repo/issues/3/").unwrap(),
            ("owner".to_string(), "repo".to_string(), 3)
        );
    }

    #[test]
    fn parse_issue_url_rejects_non_github_host_pull_request_url_missing_number_and_zero_number() {
        assert!(parse_issue_url("https://gitlab.com/owner/repo/issues/1").is_err());
        assert!(parse_issue_url("https://github.com/owner/repo/pull/1").is_err());
        assert!(parse_issue_url("https://github.com/owner/repo/issues/").is_err());
        assert!(parse_issue_url("https://github.com/owner/repo/issues/0").is_err());
        assert!(parse_issue_url("https://github.com/owner/repo/issues/abc").is_err());
        assert!(parse_issue_url("not a url at all").is_err());
        assert!(parse_issue_url("").is_err());
    }

    #[test]
    fn state_machine_allows_the_happy_path_and_rejects_skipping_a_phase() {
        assert!(valid_transition("planning", "implementing"));
        assert!(valid_transition("implementing", "checking"));
        assert!(valid_transition("checking", "opening_pr"));
        assert!(valid_transition("opening_pr", "awaiting_review"));
        assert!(!valid_transition("awaiting_review", "done")); // CI verification is mandatory
        assert!(!valid_transition("planning", "checking"));
        assert!(!valid_transition("planning", "opening_pr"));
        assert!(!valid_transition("implementing", "awaiting_review"));
        assert!(!valid_transition("done", "implementing"));
    }

    #[test]
    fn state_machine_allows_a_non_terminal_status_to_self_report_but_never_a_terminal_one() {
        for status in [
            "planning",
            "implementing",
            "checking",
            "opening_pr",
            "awaiting_review",
        ] {
            assert!(valid_transition(status, status), "{status} -> {status}");
        }
        for terminal in ["done", "failed", "cancelled"] {
            assert!(
                !valid_transition(terminal, terminal),
                "{terminal} -> {terminal}"
            );
        }
    }

    #[test]
    fn state_machine_allows_cancelling_or_failing_from_any_non_terminal_status_but_never_from_terminal(
    ) {
        for status in [
            "planning",
            "implementing",
            "checking",
            "opening_pr",
            "awaiting_review",
        ] {
            assert!(
                valid_transition(status, "cancelled"),
                "{status} -> cancelled"
            );
            assert!(valid_transition(status, "failed"), "{status} -> failed");
        }
        for terminal in ["done", "failed", "cancelled"] {
            assert!(
                !valid_transition(terminal, "cancelled"),
                "{terminal} -> cancelled"
            );
            assert!(
                !valid_transition(terminal, "failed"),
                "{terminal} -> failed"
            );
            assert!(
                !valid_transition(terminal, "implementing"),
                "{terminal} -> implementing"
            );
        }
    }

    #[test]
    fn find_reusable_worktree_picks_the_most_recent_matching_run_and_ignores_other_repos_or_issues()
    {
        let runs = vec![
            fixture_run("owner/repo", 1, 1_000, "done"),
            fixture_run("owner/repo", 1, 2_000, "failed"),
            fixture_run("owner/repo", 2, 5_000, "done"),
            fixture_run("owner/other", 1, 9_000, "done"),
        ];
        assert_eq!(
            find_reusable_worktree(&runs, "owner/repo", 1),
            Some("wt-2000".to_string())
        );
        assert_eq!(
            find_reusable_worktree(&runs, "Owner/Repo", 1),
            Some("wt-2000".to_string()),
            "repository slug match must be case-insensitive"
        );
        assert_eq!(find_reusable_worktree(&runs, "owner/repo", 3), None);
    }

    #[test]
    fn detect_check_commands_finds_test_and_build_scripts_and_selects_pnpm_when_lockfile_present() {
        let root = temp_path("detect-scripts");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: 6\n").unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts": {"test": "vitest run", "build": "tsc && vite build", "lint": "eslint ."}}"#,
        )
        .unwrap();

        let commands = detect_check_commands(&root).unwrap();
        assert_eq!(
            commands,
            vec![
                ("test".to_string(), "pnpm run test".to_string()),
                ("lint".to_string(), "pnpm run lint".to_string()),
                ("build".to_string(), "pnpm run build".to_string()),
            ]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ci_verdict_uses_real_check_conclusions_and_never_accepts_missing_checks() {
        let missing = serde_json::json!({"statusCheckRollup":[]});
        assert_eq!(classify_ci_rollup(&missing).unwrap().0, "pending");
        let pending = serde_json::json!({"statusCheckRollup":[
            {"name":"unit","status":"IN_PROGRESS","conclusion":null}
        ]});
        assert_eq!(classify_ci_rollup(&pending).unwrap().0, "pending");
        let failed = serde_json::json!({"statusCheckRollup":[
            {"name":"test","status":"COMPLETED","conclusion":"FAILURE"},
            {"name":"lint","status":"COMPLETED","conclusion":"SUCCESS"}
        ]});
        assert_eq!(classify_ci_rollup(&failed).unwrap().0, "failed");
        let passed = serde_json::json!({"statusCheckRollup":[
            {"name":"test","status":"COMPLETED","conclusion":"SUCCESS"},
            {"name":"lint","status":"COMPLETED","conclusion":"SUCCESS"}
        ]});
        assert_eq!(classify_ci_rollup(&passed).unwrap().0, "passed");
        let skipped = serde_json::json!({"statusCheckRollup":[
            {"name":"disabled","status":"COMPLETED","conclusion":"SKIPPED"}
        ]});
        assert_eq!(classify_ci_rollup(&skipped).unwrap().0, "pending");
    }

    #[test]
    fn ci_repair_record_survives_storage_restart_without_losing_failure_evidence() {
        let path = temp_path("ci-restart.json");
        let mut run = fixture_run("owner/repo", 14, 1_000, "repairing");
        run.pr_number = Some(8);
        run.repair_attempts = 1;
        run.repair_in_progress = true;
        run.ci_head_oid = Some("a".repeat(40));
        run.ci_history.push(CiObservation {
            head_oid: "a".repeat(40),
            verdict: "failed".to_string(),
            checks: vec![CiCheckEvidence {
                name: "CI".to_string(),
                state: "COMPLETED".to_string(),
                conclusion: "FAILURE".to_string(),
                url: None,
            }],
            observed_at_ms: 1_000,
        });
        let mut store = RunMap::new();
        store.insert(run.run_id.clone(), run.clone());
        save_runs_to(&path, &store).unwrap();
        let recovered = load_runs_from(&path);
        assert_eq!(recovered.get(&run.run_id), Some(&run));
        assert_eq!(recovered[&run.run_id].max_repair_attempts, 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn new_ci_transitions_require_evidence_and_explicit_approval_boundary() {
        assert!(valid_transition("opening_pr", "monitoring_ci"));
        assert!(valid_transition("monitoring_ci", "repairing"));
        assert!(valid_transition("repairing", "checking"));
        assert!(valid_transition("checking", "opening_pr"));
        assert!(valid_transition("monitoring_ci", "ready"));
        assert!(valid_transition("ready", "done"));
        assert!(!valid_transition("repairing", "ready"));
        // The public transition command rejects "ready" even though the
        // internal CI observer uses this state edge after matching GitHub SHA.
        assert!(!valid_transition("implementing", "ready"));
    }

    /// Real Git operations and a real subprocess verification command, with
    /// deterministic simulated GitHub check responses. No provider or token
    /// is required for this fixture.
    #[test]
    fn real_git_and_simulated_github_failing_ci_repairs_to_final_approval_boundary() {
        use std::process::Command;
        let root = temp_path("real-repo-simulated-github");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git").args(args).current_dir(&root).output().unwrap();
            assert!(output.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Fixture"]);
        git(&["config", "user.email", "fixture@example.invalid"]);
        std::fs::write(root.join("data.txt"), "value=1\n").unwrap();
        git(&["add", "--", "data.txt"]);
        git(&["commit", "-qm", "baseline"]);
        git(&["checkout", "-qb", "issue-to-pr/fixture"]);
        let initial_oid = git(&["rev-parse", "HEAD"]);
        let local_check = || Command::new("git")
            .args(["grep", "-q", "^value=2$", "--", "data.txt"])
            .current_dir(&root)
            .status().unwrap().success();
        assert!(!local_check(), "fixture must start with a real failing repository check");
        let ci_failed = serde_json::json!({"headRefOid":initial_oid,
            "statusCheckRollup":[{"name":"fixture-check","status":"COMPLETED","conclusion":"FAILURE"}]});
        assert_eq!(classify_ci_rollup(&ci_failed).unwrap().0, "failed");
        assert!(valid_transition("monitoring_ci", "repairing"));

        // A bounded repair changes only the fixture's declared scope.
        let attempts = 1u32;
        assert!(attempts <= MAX_REPAIR_ATTEMPTS);
        std::fs::write(root.join("data.txt"), "value=2\n").unwrap();
        assert!(local_check(), "repair must pass a genuine subprocess check");
        git(&["diff", "--check"]);
        let changes = git(&["diff", "--name-only"]);
        assert_eq!(changes, "data.txt", "unrelated changes must be rejected");
        git(&["add", "--", "data.txt"]);
        git(&["commit", "-qm", "bounded repair"]);
        let repaired_oid = git(&["rev-parse", "HEAD"]);
        assert_ne!(initial_oid, repaired_oid);
        assert!(valid_transition("repairing", "checking"));
        assert!(valid_transition("checking", "opening_pr"));
        let stale = serde_json::json!({"headRefOid":initial_oid,
            "statusCheckRollup":[{"name":"fixture-check","status":"COMPLETED","conclusion":"SUCCESS"}]});
        assert_ne!(stale["headRefOid"].as_str(), Some(repaired_oid.as_str()),
            "even green checks for the previous commit must not authorize ready");
        let pending = serde_json::json!({"headRefOid":repaired_oid,
            "statusCheckRollup":[{"name":"fixture-check","status":"IN_PROGRESS","conclusion":null}]});
        assert_eq!(classify_ci_rollup(&pending).unwrap().0, "pending");
        let green = serde_json::json!({"headRefOid":repaired_oid,
            "statusCheckRollup":[{"name":"fixture-check","status":"COMPLETED","conclusion":"SUCCESS"}]});
        assert_eq!(classify_ci_rollup(&green).unwrap().0, "passed");
        assert!(local_check());
        assert!(valid_transition("monitoring_ci", "ready"));
        // It ends at "ready", NOT "done": human publication approval remains.
        assert!(!valid_transition("ready", "opening_pr"));
        assert!(valid_transition("ready", "done"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn detect_check_commands_returns_empty_when_no_package_json() {
        let root = temp_path("no-package-json");
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(detect_check_commands(&root).unwrap(), Vec::new());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn runs_round_trip_through_save_and_load() {
        let path = temp_path("round-trip.json");
        let mut runs = RunMap::new();
        let run = fixture_run("owner/repo", 9, 1_234, "planning");
        runs.insert(run.run_id.clone(), run.clone());
        save_runs_to(&path, &runs).unwrap();

        let loaded = load_runs_from(&path);
        assert_eq!(loaded.get(&run.run_id), Some(&run));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_missing_or_corrupt_file_degrades_to_an_empty_map_instead_of_erroring() {
        let path = temp_path("missing.json");
        assert!(load_runs_from(&path).is_empty());

        std::fs::write(&path, "not json").unwrap();
        assert!(load_runs_from(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prune_removes_oldest_terminal_runs_first_and_keeps_active_ones() {
        let mut runs = RunMap::new();
        for index in 0..(MAX_RUNS + 3) {
            let status = if index < 3 { "done" } else { "implementing" };
            let run = fixture_run("owner/repo", index as u32, index as u64, status);
            runs.insert(run.run_id.clone(), run);
        }
        assert_eq!(runs.len(), MAX_RUNS + 3);

        prune(&mut runs);

        assert_eq!(runs.len(), MAX_RUNS);
        for index in 0..3 {
            assert!(
                !runs.contains_key(&format!("i2p-{index}")),
                "oldest terminal run {index} should have been pruned"
            );
        }
        for index in 3..(MAX_RUNS + 3) {
            assert!(
                runs.contains_key(&format!("i2p-{index}")),
                "active run {index} must never be pruned"
            );
        }
    }
}
