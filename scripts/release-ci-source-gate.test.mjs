import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectReleaseSourceCI } from "./release-ci-source-gate.mjs";

const sha = "a".repeat(40);
const success = {
  id: 20, name: "CI", head_sha: sha, head_branch: "main",
  event: "push", status: "completed", conclusion: "success",
  html_url: "https://github.com/example/repo/actions/runs/20",
};
const run = (obj = success) => ({ workflow_runs: [obj] });

test("accepts successful full CI for exactly the release main commit", () => {
  const result = inspectReleaseSourceCI(run(), sha);
  assert.equal(result.pass, true);
  assert.equal(result.latestCI.id, 20);
});
test("does not mistake a passing PR/other branch/earlier SHA for an accepted main push", () => {
  for (const changes of [
    { event: "pull_request" },
    { head_branch: "develop" },
    { head_sha: "b".repeat(40) },
    { name: "Release contract fast gate" },
  ]) {
    const verdict = inspectReleaseSourceCI(run({ ...success, ...changes }), sha);
    assert.equal(verdict.pass, false, JSON.stringify(changes));
  }
});
test("latest CI status dominates previous passing runs on the same commit", () => {
  const old = { ...success, id: 10 };
  for (const change of [
    { id: 21, status: "queued", conclusion: null },
    { id: 22, status: "completed", conclusion: "failure" },
    { id: 23, status: "completed", conclusion: "cancelled" },
  ]) {
    const verdict = inspectReleaseSourceCI({ workflow_runs: [old, { ...old, ...change }] }, sha);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.latestCI.id, change.id);
  }
});
test("rejects missing, malformed or unauthenticated evidence", () => {
  assert.equal(inspectReleaseSourceCI({}, sha).pass, false);
  assert.equal(inspectReleaseSourceCI(run(), "invalid").pass, false);
  assert.equal(inspectReleaseSourceCI({ workflow_runs: [] }, sha).pass, false);
});
