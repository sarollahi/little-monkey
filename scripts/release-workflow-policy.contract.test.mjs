import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const preamble = workflow.split("\npermissions:")[0];
test("release is manual-only and does not respond to a main push", () => {
  assert.match(preamble, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(preamble, /^\s+(?:push|pull_request|schedule|release):/m);
  assert.match(preamble, /approve_publish:/);
  assert.match(preamble, /acceptance_report:/);
});
test("main branch and acceptance attestation are checked before any build", () => {
  const guard = workflow.indexOf("Require explicit manual authorization");
  const firstCheckout = workflow.indexOf("- uses: actions/checkout@v4");
  assert.ok(guard > 0 && guard < firstCheckout);
  assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /\$APPROVED.*true/);
  assert.match(workflow, /ACCEPTANCE_REPORT.*https:\/\//);
});
test("publication is downstream of installer smoke and guarded preflight", () => {
  assert.match(workflow, /publish:\s*\n[\s\S]*?needs: \[release, install-smoke, ide-extensions\]/);
  assert.match(workflow, /install-smoke:[\s\S]*?--require-clean/);
  assert.match(workflow, /Refuse overwriting an already published release/);
  assert.match(workflow, /Refuse incomplete or unsigned draft release asset inventory/);
  assert.match(workflow, /release-manifest-gate.mjs/);
  assert.match(workflow, /Require passing CI on exact main source commit/);
  assert.match(workflow, /release-ci-source-gate.mjs/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /cargo audit --file src-tauri\/Cargo.lock/);
  assert.match(workflow, /pnpm audit --prod --audit-level high/);
  assert.match(workflow, /Enforce production updater and Linux installer signing credentials/);
  assert.match(workflow, /Enforce macOS Developer ID signing and notarization credentials/);
  assert.match(workflow, /Verify actual macOS app Developer ID signature and Gatekeeper assessment/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /Missing Linux installer signing credentials/);
  assert.match(workflow, /linux_gpg_fingerprint/);
  assert.match(workflow, /Unexpected Linux release signer fingerprint/);
  assert.doesNotMatch(workflow, /skipping installer signatures/i);
});
