import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "scripts/first-run-acceptance.mjs");
const source = join(root, "examples/first-run");

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "lm-first-run-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["normalize.mjs", "normalize.test.mjs"]) {
    copyFileSync(join(source, name), join(dir, name));
  }
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Acceptance Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "normalize.mjs", "normalize.test.mjs"],
    ["commit", "-qm", "intentionally broken baseline"],
  ]) {
    assert.equal(run("git", args, dir).status, 0);
  }
  return dir;
}
function invoke(dir, mode, name, extra = []) {
  // Keep evidence under Git private metadata: outputs must not become changes
  // inside the disposable fixture that the scope oracle mistakes for agent edits.
  const path = join(dir, ".git", name);
  const args = [runner, mode, "--workspace", dir, "--output", path,
    ...(mode === "verify" ? ["--model", "example-model", "--runtime", "local-runtime",
      "--app-version", "1.12.0", "--attempts", "1"] : []), ...extra];
  const result = run(process.execPath, args, root);
  assert.equal(existsSync(path), true, result.stderr);
  return { result, evidence: JSON.parse(readFileSync(path, "utf8")) };
}

test("baseline actually runs the broken fixture, records raw failing TAP output and no fictitious metrics", (t) => {
  const dir = fixture(t);
  const { result, evidence } = invoke(dir, "baseline", "baseline.json");
  assert.equal(result.status, 0);
  assert.equal(evidence.outcome, "EXPECTED_BASELINE_FAILURE");
  assert.equal(evidence.checks.fixtureTests, true);
  assert.notEqual(evidence.commands.fixtureTests.exitCode, 0);
  assert.match(evidence.commands.fixtureTests.stdout, /not ok/);
  assert.equal(evidence.measuredPerformance.firstTokenMs, null);
  assert.match(evidence.sourceCommit, /^[a-f0-9]{40}$/);
});

test("verification fails on unchanged broken code", (t) => {
  const dir = fixture(t);
  const { result, evidence } = invoke(dir, "verify", "fail.json");
  assert.equal(result.status, 1);
  assert.equal(evidence.outcome, "FAIL");
  assert.equal(evidence.checks.fixtureTests, false);
  assert.equal(evidence.checks.bothFilesChanged, false);
});

test("independently verifies a real code change, scope and additional tab regression", (t) => {
  const dir = fixture(t);
  const impl = join(dir, "normalize.mjs");
  const original = readFileSync(impl, "utf8");
  assert.match(original, /replaceAll/);
  writeFileSync(impl, original.replace("replaceAll(' ', '-')", "replace(/\\s+/g, '-')"));
  const suite = join(dir, "normalize.test.mjs");
  writeFileSync(suite, readFileSync(suite, "utf8") +
    "\ntest('tabs collapse', () => { assert.equal(normalizeUserId('Ada\\tLovelace'), 'ada-lovelace'); });\n");
  const { result, evidence } = invoke(dir, "verify", "pass.json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(evidence.outcome, "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED");
  for (const key of ["fixtureTests", "inScope", "bothFilesChanged",
    "diffWhitespace", "tabRegressionAdded", "independentProbe"]) {
    assert.equal(evidence.checks[key], true, key);
  }
  assert.match(evidence.commands.gitDiff.stdout, /replace/);
  assert.equal(evidence.agentTrace.provided, false);
  assert.equal(evidence.checks.manualPermissionReview, false);
  assert.equal(evidence.measuredPerformance.agentTaskMs, null);
});

test("recorded baseline SHA still verifies edits after an agent commits them", (t) => {
  const dir = fixture(t);
  const baseline = invoke(dir, "baseline", "before.json").evidence;
  assert.match(baseline.sourceCommit, /^[a-f0-9]{40}$/);
  const impl = join(dir, "normalize.mjs");
  writeFileSync(impl, readFileSync(impl, "utf8").replace("replaceAll(' ', '-')", "replace(/\\s+/g, '-')"));
  const suite = join(dir, "normalize.test.mjs");
  writeFileSync(suite, readFileSync(suite, "utf8") +
    "\\ntest('tabs collapse', () => { assert.equal(normalizeUserId('Ada\\\\tLovelace'), 'ada-lovelace'); });\\n");
  assert.equal(run("git", ["add", "normalize.mjs", "normalize.test.mjs"], dir).status, 0);
  assert.equal(run("git", ["commit", "-qm", "agent committed the fix"], dir).status, 0);
  const { result, evidence } = invoke(dir, "verify", "after.json", ["--base", baseline.sourceCommit]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(evidence.outcome, "FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED");
  assert.equal(evidence.sourceCommit, baseline.sourceCommit);
  assert.equal(evidence.checks.inScope, true);
});

test("out-of-scope edits are rejected even when all fixture tests pass", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "normalize.mjs"),
    readFileSync(join(dir, "normalize.mjs"), "utf8").replace("replaceAll(' ', '-')", "replace(/\\s+/g, '-')"));
  writeFileSync(join(dir, "normalize.test.mjs"), readFileSync(join(dir, "normalize.test.mjs"), "utf8") +
    "\ntest('tabs collapse', () => { assert.equal(normalizeUserId('Ada\\tLovelace'), 'ada-lovelace'); });\n");
  writeFileSync(join(dir, "unrelated.txt"), "should not be here\n");
  const { result, evidence } = invoke(dir, "verify", "scope.json");
  assert.equal(result.status, 1);
  assert.equal(evidence.checks.fixtureTests, true);
  assert.equal(evidence.checks.inScope, false);
});

test("evidence records cannot silently overwrite an earlier run", (t) => {
  const dir = fixture(t);
  const once = invoke(dir, "baseline", "baseline.json");
  assert.equal(once.result.status, 0);
  const again = run(process.execPath, [runner, "baseline", "--workspace", dir,
    "--output", join(dir, ".git", "baseline.json")], root);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /EEXIST/);
});
