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
import { spawnSync } from "node:child_process";
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
  "session_scoped_attachment_filters_before_limiting",
  "paired_session_attachment_respects_both_capability_and_run_scope",
  "recovery_never_replays_a_confirmed_mutation",
  "recovery_routes_an_uncertain_prepared_mutation_to_reconciliation",
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
  for (const pattern of rustCases) {
    suites.push({
      name: `Rust daemon acceptance: ${pattern}`,
      command: "cargo",
      argv: ["test", "--manifest-path", "src-tauri/Cargo.toml",
        "--bin", "monkey-cli", pattern, "--", "--nocapture", "--exact"],
      // Rust tests are module-qualified. --exact would not match a bare
      // method name; the invocation below drops it intentionally.
    });
  }
  suites.push({
    name: "published signed remote API contract",
    command: "cargo",
    argv: ["test", "--manifest-path", "src-tauri/Cargo.toml",
      "--test", "contract_abi"],
  });
}

let failed = false;
try {
  for (const suite of suites) {
    // Test filters match a qualified Rust test name by substring; never
    // apply --exact to a non-qualified name, which would silently run zero.
    const argv = suite.argv[0] === "test" && suite.argv.includes("--bin") ?
      suite.argv.filter(flag => flag !== "--exact") : suite.argv;
    const start = Date.now();
    console.log(`\n=== ${suite.name} ===\n${suite.command} ${argv.join(" ")}`);
    const res = spawnSync(suite.command, argv, {
      stdio: "inherit",
      env: { ...process.env, CI: process.env.CI ?? "1" },
    });
    report.checks.push({
      name: suite.name,
      argv: [suite.command, ...argv],
      status: res.status === 0 && !res.error ? "passed" : "failed",
      exit_code: res.status,
      elapsed_ms: Date.now() - start,
      error: res.error ? res.error.message : null,
    });
    if (res.status !== 0 || res.error) {
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
