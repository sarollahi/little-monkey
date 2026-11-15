#!/usr/bin/env node
/**
 * Live, opt-in first-run acceptance against the installed monkey CLI/daemon.
 * Never substitutes a fake model or deterministic coordinator for live evidence.
 * It keeps raw command output, its Git patch, an independent test oracle and
 * the daemon's authoritative terminal status. Run on a disposable profile.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = process.argv.slice(2);
const flag = (name) => {
  const index = flags.indexOf(name);
  return index === -1 ? null : flags[index + 1];
};
const requireFlag = (name) => {
  const value = flag(name);
  if (!value || value.startsWith("--")) throw new Error("Missing " + name);
  return value;
};
const timeoutSeconds = Number(flag("--timeout-seconds") || 900);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
  console.error("--timeout-seconds must be an integer from 30 to 3600");
  process.exit(2);
}
const timeoutMs = timeoutSeconds * 1000;
const target = requireFlag("--target");
const runtime = requireFlag("--runtime");
const expectedVersion = requireFlag("--app-version");
const monkey = flag("--monkey-bin") || process.env.LITTLE_MONKEY_CLI || "monkey";
const evidenceDir = resolve(requireFlag("--evidence-dir"));
const workspace = mkdtempSync(join(tmpdir(), "little-monkey-first-run-live-"));
const summary = {
  schemaVersion: 1,
  experiment: "first-run-real-model",
  status: "FAIL",
  startedAt: new Date().toISOString(),
  environment: { os: platform(), osRelease: release(), arch: arch(), node: process.version },
  candidate: { appVersionOperatorDeclared: expectedVersion, runtimeOperatorDeclared: runtime, targetOperatorDeclared: target },
  runtimeIdentityVerified: false,
  daemonTerminalStatus: null,
  runId: null,
  measurable: {
    agentTaskWallMs: null,
    startupMs: null,
    idleMemoryBytes: null,
    firstTokenMs: null,
    cancellationCleanupMs: null,
  },
  proof: { baseline: null, verify: null, daemon: null },
  caveat: "A functional pass is not GUI/installer/signature/approval/physical hardware acceptance.",
  error: null,
};
let taskStartTime = null;
let workspaceRemoved = false;

function writeEvidence(name, content) {
  writeFileSync(join(evidenceDir, name), content, { flag: "wx", mode: 0o600 });
}
function capture(name, command, argv, cwd = workspace, limit = timeoutMs) {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    timeout: limit,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const record = {
    command, arguments: argv, exitCode: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdout: result.stdout || "", stderr: result.stderr || "",
    recordedAt: new Date().toISOString(),
  };
  writeEvidence(name + ".json", JSON.stringify(record, null, 2) + "\n");
  if (result.error || result.status !== 0) {
    throw new Error(name + " failed (" + (result.error?.code || result.status) + "); see " + name + ".json");
  }
  return record.stdout;
}
function parseLastJson(output) {
  const values = [output.trim(), ...output.trim().split(/\r?\n/).reverse()];
  for (const value of values) {
    try { return JSON.parse(value); } catch { /* try next line */ }
  }
  throw new Error("No JSON object in actual CLI output");
}
function findId(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  for (const key of ["run_id", "runId", "task_id", "taskId"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findId(child, depth + 1);
    if (found) return found;
  }
  return null;
}
function observedRunStatus(output, id) {
  const parsed = parseLastJson(output);
  const runs = Array.isArray(parsed) ? parsed : [parsed];
  const row = runs.find((item) => item && item.run_id === id);
  if (!row || typeof row.status !== "string") {
    throw new Error("Task status did not identify the submitted run with a typed status");
  }
  return row.status;
}
function versionOf(banner) {
  return banner.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0] || null;
}

try {
  // Evidence path must be new. A resumed run cannot overwrite earlier proof.
  mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });
  for (const name of ["normalize.mjs", "normalize.test.mjs"]) {
    copyFileSync(join(sourceRoot, "examples/first-run", name), join(workspace, name));
  }
  capture("git-init", "git", ["init", "-q"]);
  capture("git-identity", "git", ["-c", "user.name=Little Monkey Acceptance",
    "-c", "user.email=first-run@example.invalid", "add", "normalize.mjs", "normalize.test.mjs"]);
  capture("git-commit", "git", ["-c", "user.name=Little Monkey Acceptance",
    "-c", "user.email=first-run@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qm", "deliberately failing first-run baseline"]);
  capture("baseline", process.execPath, [join(sourceRoot, "scripts/first-run-acceptance.mjs"),
    "baseline", "--workspace", workspace, "--output", join(evidenceDir, "baseline.json")]);
  const baseline = JSON.parse(readFileSync(join(evidenceDir, "baseline.json"), "utf8"));
  summary.proof.baseline = baseline.outcome;
  if (baseline.outcome !== "EXPECTED_BASELINE_FAILURE") throw new Error("The first-run baseline did not fail as expected");
  if (!/^[a-f0-9]{40}$/.test(baseline.sourceCommit || "")) {
    throw new Error("First-run baseline did not capture a Git commit");
  }
  const version = capture("cli-version", monkey, ["--version"]);
  summary.candidate.observedCliVersion = version.trim();
  if (versionOf(version) !== versionOf(expectedVersion) || !versionOf(expectedVersion)) {
    throw new Error("Installed CLI version does not match the declared candidate version");
  }
  const objective = [
    "Fix normalizeUserId so repeated spaces, tabs and other whitespace between",
    "words become one hyphen. Preserve non-string rejection. Add a regression",
    "test for tabs. Run node --test normalize.test.mjs, inspect the exact diff,",
    "and report the real command outcome. Do not edit outside this workspace.",
  ].join(" ");
  taskStartTime = performance.now();
  const started = parseLastJson(capture("task-start", monkey, ["task", "start",
    objective, "--target", target, "--workspace", workspace, "--json"]));
  summary.runId = findId(started);
  if (!summary.runId) throw new Error("Live task start did not return a durable run ID");
  const rawAttach = capture("task-attach", monkey,
    ["task", "attach", summary.runId, "--follow", "--json"]);
  writeEvidence("agent-events.jsonl", rawAttach);
  const rawStatus = capture("task-status", monkey, ["task", "status",
    "--run-id", summary.runId, "--json"]);
  summary.daemonTerminalStatus = observedRunStatus(rawStatus, summary.runId);
  summary.proof.daemon = summary.daemonTerminalStatus;
  summary.measurable.agentTaskWallMs = Math.round(performance.now() - taskStartTime);
  if (summary.daemonTerminalStatus !== "succeeded") {
    throw new Error("Daemon recorded " + summary.daemonTerminalStatus + ", not succeeded");
  }
  capture("verify-command", process.execPath, [join(sourceRoot, "scripts/first-run-acceptance.mjs"),
    "verify", "--workspace", workspace, "--base", baseline.sourceCommit, "--model", target,
    "--runtime", runtime, "--app-version", expectedVersion, "--attempts", "1",
    "--agent-trace", join(evidenceDir, "agent-events.jsonl"),
    "--run-id", summary.runId, "--output", join(evidenceDir, "verification.json")]);
  const verified = JSON.parse(readFileSync(join(evidenceDir, "verification.json"), "utf8"));
  summary.proof.verify = verified.outcome;
  if (verified.outcome !== "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED") {
    throw new Error("Independent code acceptance did not pass");
  }
  summary.status = "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED";
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  if (summary.runId && !["succeeded", "failed", "cancelled", "needs_reconciliation"].includes(summary.daemonTerminalStatus || "")) {
    try { capture("cancel-request", monkey, ["task", "cancel", summary.runId], workspace, 30_000); }
    catch (cancelError) { summary.cancelError = String(cancelError); }
  }
  process.exitCode = 1;
} finally {
  // Even a failed model run must preserve the actual checkout state and
  // patch before the disposable workspace is removed. These commands are
  // observations, never evidence of successful verification on their own.
  try {
    capture("final-git-status", "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
    const before = JSON.parse(readFileSync(join(evidenceDir, "baseline.json"), "utf8"));
    if (/^[a-f0-9]{40}$/.test(before.sourceCommit || "")) {
      capture("final-git-patch", "git", ["diff", "--no-ext-diff", "--no-color",
        before.sourceCommit, "--"]);
    }
  } catch (error) {
    summary.finalSourceEvidenceError = String(error);
  }
  if (taskStartTime !== null && summary.measurable.agentTaskWallMs === null) {
    summary.measurable.agentTaskWallMs = Math.round(performance.now() - taskStartTime);
  }
  summary.finishedAt = new Date().toISOString();
  if (!flags.includes("--keep-workspace")) {
    try { rmSync(workspace, { recursive: true, force: true }); workspaceRemoved = true; }
    catch (error) { summary.cleanupError = String(error); process.exitCode = 1; }
  }
  summary.workspaceRemoved = workspaceRemoved;
  if (!workspaceRemoved) summary.workspace = workspace;
  try {
    writeEvidence("summary.json", JSON.stringify(summary, null, 2) + "\n");
  } catch (error) {
    console.error("Could not write evidence summary: " + String(error));
    process.exitCode = 1;
  }
  console.log(JSON.stringify({
    evidenceDirectory: evidenceDir, status: summary.status,
    runId: summary.runId, daemonStatus: summary.daemonTerminalStatus,
    error: summary.error,
  }, null, 2));
}
