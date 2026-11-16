#!/usr/bin/env node
/**
 * Independently execute the public first-run fixture and save raw evidence.
 *
 * Baseline expects the intentionally broken checkout to fail exactly one test.
 * Verify checks the agent's actual edits, runs all tests again, and executes
 * independent whitespace probes. No generated result is treated as a model
 * benchmark or as proof of the app's permission/approval behavior.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release, version as osVersion } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = resolve(scriptDir, "../examples/first-run");
const args = process.argv.slice(2);
const mode = args[0];
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const has = (flag) => args.includes(flag);
const workspace = resolve(value("--workspace") || defaultWorkspace);
const output = value("--output");
const observedAt = new Date().toISOString();

function execute(command, argv, cwd) {
  // node --test sets NODE_TEST_CONTEXT for its own subprocesses. Propagating
  // that internal marker to our independent, nested fixture runner makes Node
  // silently skip all fixture tests (exit code 0, empty TAP) instead of running
  // the expected three cases. A new Node test CLI is a separate test root.
  const env = { ...process.env };
  if (command === process.execPath) delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(command, argv, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return {
    command: [command, ...argv].join(" "),
    exitCode: run.status,
    signal: run.signal,
    error: run.error?.message ?? null,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
}
const git = (argv, cwd = workspace) => execute("git", argv, cwd);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const required = (flag) => {
  const result = value(flag);
  if (!result || result.startsWith("--")) throw new Error("Missing required " + flag);
  return result;
};
function testSummary(text) {
  const number = (name) => Number(text.match(new RegExp("^#\\s+" + name + "\\s+(\\d+)\\s*$", "m"))?.[1] ?? NaN);
  return { tests: number("tests"), passed: number("pass"), failed: number("fail") };
}
function save(evidence) {
  if (!output || output.startsWith("--")) throw new Error("Supply a unique --output FILE (existing evidence is never overwritten)");
  const target = isAbsolute(output) ? output : resolve(process.cwd(), output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ evidenceFile: target, outcome: evidence.outcome, checks: evidence.checks }, null, 2));
  if (evidence.outcome === "FAIL") process.exitCode = 1;
}
function main() {
  if (!["baseline", "verify"].includes(mode)) {
    throw new Error("Usage: node scripts/first-run-acceptance.mjs baseline|verify --output FILE [--workspace PATH] (verify also requires --model, --runtime, --app-version)");
  }
  const test = execute(process.execPath, ["--test", "--test-reporter=tap", "normalize.test.mjs"], workspace);
  const summary = testSummary(test.stdout + "\n" + test.stderr);
  const evidence = {
    schemaVersion: 1,
    phase: mode,
    observedAt,
    environment: { os: platform(), osVersion: osVersion(), kernel: release(), arch: arch(), node: process.version },
    workspace: workspace,
    sourceCommit: null,
    model: mode === "verify" ? { value: required("--model"), source: "operator-declared; not independently authenticated" } : null,
    runtime: mode === "verify" ? { value: required("--runtime"), source: "operator-declared; not independently authenticated" } : null,
    appVersion: mode === "verify" ? { value: required("--app-version"), source: "operator-declared; not independently authenticated" } : null,
    agentRunId: value("--run-id"),
    attempts: mode === "verify" ? Number(required("--attempts")) : null,
    measuredPerformance: {
      startupMs: null, idleMemoryBytes: null, firstTokenMs: null,
      agentTaskMs: null, cancellationCleanupMs: null,
      note: "Not measured by this fixture. Never infer agent performance from Node test duration.",
    },
    commands: { fixtureTests: test },
    fixtureTAPSummary: summary,
    checks: {},
    outcome: "FAIL",
  };
  if (mode === "verify" && (!Number.isInteger(evidence.attempts) || evidence.attempts < 1)) {
    throw new Error("--attempts must be a positive integer");
  }
  evidence.checks.fixtureTests = mode === "baseline"
    ? test.exitCode !== 0 && summary.tests === 3 && summary.passed === 2 && summary.failed === 1
    : test.exitCode === 0 && summary.tests >= 3 && summary.failed === 0;

  if (mode === "baseline") {
    // Capture the immutable baseline *before* the agent can commit anything.
    // Git HEAD after an autonomous task may differ, so "diff HEAD" alone can
    // silently lose every real change an agent already committed.
    const baselineHead = git(["rev-parse", "--verify", "HEAD"]);
    if (baselineHead.exitCode === 0 && /^[a-f0-9]{40}$/.test(baselineHead.stdout.trim())) {
      evidence.sourceCommit = baselineHead.stdout.trim();
    }
    evidence.outcome = evidence.checks.fixtureTests ? "EXPECTED_BASELINE_FAILURE" : "FAIL";
    save(evidence);
    return;
  }

  const rootResult = git(["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) throw new Error("Verification requires a Git checkout; initialize a disposable Git repository first");
  const root = rootResult.stdout.trim();
  const inside = relative(root, workspace).replaceAll("\\", "/");
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Workspace is outside the Git root");
  const base = value("--base") || "HEAD";
  if (!/^[a-zA-Z0-9._/~-]+$/.test(base)) throw new Error("Unsafe Git base ref");
  const baseRev = git(["rev-parse", "--verify", base + "^{commit}"], root);
  if (baseRev.exitCode !== 0) throw new Error("Cannot resolve baseline commit " + base);
  evidence.sourceCommit = baseRev.stdout.trim();

  const changes = git(["diff", "--name-only", evidence.sourceCommit, "--"], root);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], root);
  const checkWhitespace = git(["diff", "--check", evidence.sourceCommit, "--"], root);
  const diff = git(["diff", "--no-ext-diff", "--no-color", evidence.sourceCommit, "--"], root);
  evidence.commands.gitDiff = diff;
  evidence.commands.gitWhitespaceCheck = checkWhitespace;
  evidence.commands.gitUntracked = untracked;
  const changed = changes.stdout.split(/\r?\n/).filter(Boolean);
  const extras = untracked.stdout.split(/\r?\n/).filter(Boolean);
  const allowed = new Set(["normalize.mjs", "normalize.test.mjs"].map((name) => inside ? inside + "/" + name : name));
  evidence.checks.inScope = changes.exitCode === 0 && untracked.exitCode === 0 &&
    changed.length > 0 && changed.every((path) => allowed.has(path)) &&
    extras.every((path) => allowed.has(path));
  evidence.checks.bothFilesChanged = [...allowed].every((path) => changed.includes(path));
  evidence.checks.diffWhitespace = checkWhitespace.exitCode === 0;
  const testDiff = git(["diff", "--no-ext-diff", "--no-color", evidence.sourceCommit, "--",
    inside ? inside + "/normalize.test.mjs" : "normalize.test.mjs"], root);
  evidence.checks.tabRegressionAdded = testDiff.exitCode === 0 &&
    testDiff.stdout.split("\n").some((line) => /^\+(?!\+\+)/.test(line) && /tab|\\t|\\u0009|\t/i.test(line));
  evidence.commands.testDiff = testDiff;

  const probe = execute(process.execPath, ["--input-type=module", "-e",
    "import assert from 'node:assert/strict'; import { normalizeUserId } from './normalize.mjs'; " +
    "assert.equal(normalizeUserId(' Ada\\t\\tLovelace '), 'ada-lovelace'); " +
    "assert.equal(normalizeUserId('Ada\\nLovelace'), 'ada-lovelace'); " +
    "assert.throws(() => normalizeUserId(null), TypeError); console.log('Independent whitespace probes: PASS');",
  ], workspace);
  evidence.commands.independentProbe = probe;
  evidence.checks.independentProbe = probe.exitCode === 0;
  const traceFile = value("--agent-trace");
  if (traceFile) {
    const text = readFileSync(resolve(traceFile));
    evidence.agentTrace = { provided: true, sha256: sha256(text), bytes: text.length,
      verification: "Provided evidence only; review permission decisions and tool commands manually" };
  } else {
    evidence.agentTrace = { provided: false, verification: "NOT VERIFIED: no agent permission/tool trace supplied" };
  }
  evidence.checks.manualPermissionReview = false;
  evidence.checks.installerAndRuntimeVerified = false;
  evidence.outcome = Object.entries(evidence.checks)
    .filter(([key]) => !["manualPermissionReview", "installerAndRuntimeVerified"].includes(key))
    .every(([, ok]) => ok) ? "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED" : "FAIL";
  save(evidence);
}
try { main(); } catch (error) { console.error("First-run evidence error:", error.message); process.exitCode = 1; }
