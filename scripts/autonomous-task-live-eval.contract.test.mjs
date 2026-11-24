import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Fake-CLI tests only. Passing here is NOT evidence of a real agent or daemon.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "scripts/autonomous-task-live-eval.mjs");
const stub = join(root, "scripts/test-fixtures/fake-monkey-first-run-e2e.mjs");

function execute(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lm-autonomous-harness-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "fake-monkey.mjs");
  copyFileSync(stub, fake);
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [
    runner, "--target", "ollama:fake-contract-only", "--monkey-bin", fake,
    "--timeout-seconds", "30",
  ], { cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, LITTLE_MONKEY_KEEP_EVAL_REPO: "1", ...env } });
  const match = (result.stderr + result.stdout).match(/little-monkey-live-autonomous-eval-[^\s"']+/);
  if (match) {
    const repo = join(tmpdir(), match[0].split("/").pop());
    t.after(() => rmSync(repo, { recursive: true, force: true }));
  }
  return result;
}
test("live evaluator requires actual terminal succeeded status (simulated CLI contract)", (t) => {
  const result = execute(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.authoritativeStatus, "succeeded");
  assert.equal(report.verified, true);
  assert.deepEqual(report.changedFiles, ["src/math.mjs"]);
});
test("live evaluator rejects daemon failed even if fake modified working source", (t) => {
  const result = execute(t, { FAKE_RUN_STATUS: "failed" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ended as failed, not succeeded/);
  assert.doesNotMatch(result.stdout, /"verified": true/);
});
test("live evaluator rejects unrelated file modifications", (t) => {
  const result = execute(t, { FAKE_UNRELATED: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrelated changes/);
});
test("held task status fails and cancellation is attempted only for its own ID", (t) => {
  const result = execute(t, { FAKE_RUN_STATUS: "waiting_for_permission" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ended as waiting_for_permission/);
  assert.match(result.stderr, /Bounded cancellation of task-contract-stub: requested/);
});
