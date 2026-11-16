#!/usr/bin/env node
/**
 * Reproducible regression acceptance for daemon-owned desktop sessions.
 * This orchestrates the EXISTING Vitest and Rust tests, never an agent
 * executor, a production daemon or any third-party mutation API.
 *
 * Usage:
 *   pnpm test:durable-sessions
 *   pnpm test:durable-sessions --frontend-only
 *   pnpm test:durable-sessions --rust-only --report=test-results/session.json
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const onlyFrontend = args.has("--frontend-only");
const onlyRust = args.has("--rust-only");
const other = [...args].filter(a => !a.startsWith("--report=") &&
  a !== "--frontend-only" && a !== "--rust-only");
if (other.length || (onlyFrontend && onlyRust)) {
  console.error("Usage: node scripts/durable-session-acceptance.mjs [--frontend-only|--rust-only] [--report=path]");
  process.exit(2);
}

const reportArg = [...args].find(a => a.startsWith("--report="));
const reportPath = resolve(reportArg ? reportArg.slice("--report=".length) :
  "test-results/durable-session-acceptance.json");

const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const report = {
  schema_version: 1,
  scenario: "crash-resumable daemon-owned sessions",
  started_at: new Date().toISOString(),
  repository_commit: git.status === 0 ? git.stdout.trim() : null,
  environment: {
    os: process.platform, architecture: process.arch, node: process.version,
    runtime: "fixture backend (no external model or credentials)",
  },
  checks: [],
};

const frontendCases = [
  "src/lib/durableSessionRecovery.test.ts",
  "src/lib/daemonDesktopTurn.test.ts",
  "src/lib/agentLoopDurableIngress.test.ts",
  "src/store/sessionStore.split.test.ts",
];
const rustCases = [
  "durable_session_lookup_upgrades_a_v20_queue_in_place",
  "recovery_read_model_includes_only_live_desktop_and_reconciliation",
  "recovery_ignores_terminal_jobs_but_preserves_reconciliation",
  "long_running_job_finished_recently_is_recovered_even_if_admission_is_old",
  "session_scoped_attachment_filters_before_limiting",
  "paired_session_attachment_respects_both_capability_and_run_scope",
  "recovery_never_replays_a_confirmed_mutation",
  "recovery_routes_an_uncertain_prepared_mutation_to_reconciliation",
  "every_dispatched_remote_route_is_in_the_published_contract",
  "peer_provenance_upgrades_a_database_that_is_already_at_v17",
  // Real daemon -> model HTTP fixture -> outbound provider fixture, not a
  // mocked executor. The CLI must be built as a standalone binary first.
  "a_telegram_message_becomes_an_agent_reply_end_to_end",
];
if (process.platform === "linux") {
  rustCases.push("real_os_worker_is_reattached_with_same_pid_and_live_lease_after_daemon_replacement");
}

const suites = [];
if (!onlyRust) {
  suites.push({
    name: "frontend recovery, observer permissions, and durable replay",
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    argv: ["exec", "vitest", "run", ...frontendCases],
  });
  suites.push({
    name: "frontend compiler and exact input types",
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    argv: ["typecheck"],
  });
}
if (!onlyFrontend) {
  // Tauri's build.rs expects its staged CLI placeholder and the managed
  // runtime fixture, just like the existing pnpm test:rust entrypoint.
  for (const setup of ["stage:cli:placeholder", "stage:sherpa-runtime"]) {
    suites.push({
      name: `Rust build prerequisites: ${setup}`,
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      argv: [setup],
    });
  }
  suites.push({
    name: "Build the CLI used by resident daemon child processes",
    command: "cargo",
    argv: ["build", "--manifest-path", "src-tauri/Cargo.toml",
      "--bin", "monkey-cli"],
  });
  for (const pattern of rustCases) {
    suites.push({
      name: `Rust daemon acceptance: ${pattern}`,
      command: "cargo",
      argv: ["test", "--manifest-path", "src-tauri/Cargo.toml",
        "--bin", "monkey-cli", pattern, "--", "--nocapture"],
      requireTests: true,
    });
  }
  suites.push({
    name: "published signed remote API contract",
    command: "cargo",
    argv: ["test", "--manifest-path", "src-tauri/Cargo.toml",
      "--test", "contract_abi"],
    requireTests: true,
  });
}

// Keep a bounded copy of test output for a proof that tests actually ran,
// while streaming the full logs live to the terminal. Cargo can exit 0 with
// "running 0 tests" if a filter was renamed. That must NEVER count as evidence.
async function execute(suite) {
  const child = spawn(suite.command, suite.argv, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32" && suite.command === "pnpm.cmd",
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });
  let tail = "";
  for (const [stream, destination] of [
    [child.stdout, process.stdout], [child.stderr, process.stderr],
  ]) {
    stream.on("data", chunk => {
      destination.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-256 * 1024);
    });
  }
  return new Promise(resolve => {
    let error = null;
    child.on("error", reason => { error = reason; });
    child.on("close", (code, signal) => resolve({
      status: code, signal, error, outputTail: tail,
    }));
  });
}

let failed = false;
try {
  for (const suite of suites) {
    const start = Date.now();
    console.log(`\n=== ${suite.name} ===\n${suite.command} ${suite.argv.join(" ")}`);
    const res = await execute(suite);
    const testCount = suite.requireTests
      ? [...res.outputTail.matchAll(/test result: ok\. (\d+) passed/g)]
          .reduce((count, match) => count + Number(match[1]), 0)
      : null;
    const emptySuite = suite.requireTests && testCount === 0;
    const passed = res.status === 0 && !res.error && !emptySuite;
    if (emptySuite) {
      console.error(`Acceptance failed: ${suite.name} ran zero passing tests`);
    }
    report.checks.push({
      name: suite.name,
      argv: [suite.command, ...suite.argv],
      status: passed ? "passed" : "failed",
      exit_code: res.status,
      signal: res.signal,
      passed_tests: testCount,
      elapsed_ms: Date.now() - start,
      error: res.error?.message ??
        (emptySuite ? "Test filter matched no passing tests" : null),
    });
    if (!passed) {
      failed = true;
      break; // Never hide the real compilation failure behind later runs.
    }
  }
} finally {
  report.finished_at = new Date().toISOString();
  report.outcome = failed ? "failed" : "passed";
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(`\nAcceptance evidence: ${reportPath}`);
}
process.exit(failed ? 1 : 0);
