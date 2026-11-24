import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyReleaseAssets } from "./release-asset-integrity.mjs";

const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
test("checks actual bytes and size against manifest, not asset names alone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lm-integrity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = "app_1.12.0_amd64.deb";
  writeFileSync(join(dir, name), "ACTUAL BYTES");
  const metadata = { tag_name: "1.12.0", assets: [
    { name, size: 12, digest: sha("ACTUAL BYTES") },
    { name: "not-downloaded.dmg", size: 7, digest: sha("sample") },
  ] };
  const result = await verifyReleaseAssets({ metadata, directory: dir });
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].pass, true);
  assert.deepEqual(result.unverifiedReleaseAssets, ["not-downloaded.dmg"]);
  writeFileSync(join(dir, name), "CORRUPTED!!!");
  const changed = await verifyReleaseAssets({ metadata, directory: dir });
  assert.equal(changed.passed, false);
  assert.match(changed.checks[0].reason, /SHA-256 mismatch/);
});
test("does not silently accept missing, unknown or unhashed assets", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lm-integrity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(verifyReleaseAssets({ metadata: { assets: [] }, directory: dir }), /no assets/);
  writeFileSync(join(dir, "unknown.exe"), "data");
  const report = await verifyReleaseAssets({ metadata: { assets: [{ name: "another.exe", size: 4, digest: sha("data") }] }, directory: dir });
  assert.equal(report.passed, false);
  assert.match(report.checks[0].reason, /not in release manifest/);
  const missing = await verifyReleaseAssets({ metadata: { assets: [{ name: "unknown.exe", size: 4, digest: null }] }, directory: dir });
  assert.equal(missing.passed, false);
  assert.match(missing.checks[0].reason, /missing valid GitHub SHA-256/);
});
