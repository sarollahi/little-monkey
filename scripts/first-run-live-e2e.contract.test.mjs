import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Simulated CLI in these tests checks the harness, NOT model or daemon quality.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harness = join(root, "scripts/first-run-live-e2e.mjs");
const stub = join(root, "scripts/test-fixtures/fake-monkey-first-run-e2e.mjs");
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "lm-live-e2e-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const monkey = join(dir, "fake-monkey.mjs");
  copyFileSync(stub, monkey);
  chmodSync(monkey, 0o755);
  return { dir, monkey };
}
function invoke(dir, monkey, label, overrides = {}) {
  const evidence = join(dir, label);
  const result = spawnSync(process.execPath, [
    harness, "--target", "ollama:contract-fake", "--runtime", "simulated-contract-only",
    "--app-version", "1.12.0", "--evidence-dir", evidence,
    "--monkey-bin", monkey, "--timeout-seconds", "30",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, ...overrides }, timeout: 25_000 });
  assert.ok(existsSync(join(evidence, "summary.json")), result.stderr + result.stdout);
  return { result, evidence: JSON.parse(readFileSync(join(evidence, "summary.json"), "utf8")), path: evidence };
}
test("harness requires terminal succeeded plus independently verified source diff", (t) => {
  const { dir, monkey } = setup(t);
  const r = invoke(dir, monkey, "pass");
  assert.equal(r.result.status, 0, r.result.stderr + r.result.stdout);
  assert.equal(r.evidence.daemonTerminalStatus, "succeeded");
  assert.equal(r.evidence.status, "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED");
  assert.equal(r.evidence.runtimeIdentityVerified, false);
  assert.equal(r.evidence.proof.verify, "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED");
  assert.ok(existsSync(join(r.path, "verification.json")));
  assert.ok(existsSync(join(r.path, "agent-events.jsonl")));
  assert.ok(existsSync(join(r.path, "task-status.json")));
  assert.equal(r.evidence.measurable.firstTokenMs, null);
});
test("daemon failed status vetoes apparently correct changes and tests", (t) => {
  const { dir, monkey } = setup(t);
  const r = invoke(dir, monkey, "failure", { FAKE_RUN_STATUS: "failed" });
  assert.equal(r.result.status, 1);
  assert.equal(r.evidence.daemonTerminalStatus, "failed");
  assert.equal(r.evidence.status, "FAIL");
  assert.match(r.evidence.error, /Daemon recorded failed/);
});
test("unrelated file edits cannot be counted as a functional pass", (t) => {
  const { dir, monkey } = setup(t);
  const r = invoke(dir, monkey, "out-of-scope", { FAKE_UNRELATED: "1" });
  assert.equal(r.result.status, 1);
  assert.equal(r.evidence.daemonTerminalStatus, "succeeded");
  assert.equal(r.evidence.status, "FAIL");
  const verified = JSON.parse(readFileSync(join(r.path, "verification.json"), "utf8"));
  assert.equal(verified.checks.inScope, false);
});
test("cannot overwrite evidence from an earlier execution", (t) => {
  const { dir, monkey } = setup(t);
  const r = invoke(dir, monkey, "single-use");
  assert.equal(r.result.status, 0, r.result.stderr + r.result.stdout);
  const next = spawnSync(process.execPath, [
    harness, "--target", "ollama:contract-fake", "--runtime", "stub", "--app-version", "1.12.0",
    "--monkey-bin", monkey, "--evidence-dir", join(dir, "single-use"), "--timeout-seconds", "30",
  ], { cwd: root, encoding: "utf8", timeout: 25_000 });
  assert.equal(next.status, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "single-use", "summary.json"), "utf8")).status,
    "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED");
});
