import assert from "node:assert/strict";
import { test } from "node:test";
import { changeManifestVersions, nextUnpublishedVersion } from "./ci-candidate-version.mjs";

const fixture = (pkgVersion = "1.12.0", tauriVersion = "1.12.0") => ({
  package: JSON.stringify({ name: "little-monkey", version: pkgVersion, private: true }) + "\n",
  tauri: JSON.stringify({ identifier: "com.littlemonkey.app", version: tauriVersion, bundle: { createUpdaterArtifacts: true } }) + "\n",
  cargo: '[package]\nname = "little-monkey"\nversion = "' + pkgVersion + '"\ndescription = "x"\n\n[dependencies]\nserde = "1"\n',
  lock: 'version = 4\n\n[[package]]\nname = "little-monkey"\nversion = "' + pkgVersion + '"\ndependencies = ["serde"]\n',
});
test("candidate version strictly exceeds both published and development versions", () => {
  assert.equal(nextUnpublishedVersion("1.12.0", "1.12.0"), "1.12.1");
  assert.equal(nextUnpublishedVersion("1.11.9", "1.12.0"), "1.12.1");
  assert.equal(nextUnpublishedVersion("1.13.0", "1.12.1"), "1.13.1");
  assert.equal(nextUnpublishedVersion("1.12.0", "v1.12.0"), "1.12.1");
  assert.throws(() => nextUnpublishedVersion("1.12.0", "unknown"), /Expected stable/);
});
test("all embedded app and CLI versions remain coherent without altering signing policy", () => {
  const input = fixture();
  const modified = changeManifestVersions(input, "1.12.0");
  assert.equal(modified.version, "1.12.1");
  assert.equal(JSON.parse(modified.files.package).version, "1.12.1");
  assert.equal(JSON.parse(modified.files.tauri).version, "1.12.1");
  assert.equal(JSON.parse(modified.files.tauri).bundle.createUpdaterArtifacts, true);
  assert.match(modified.files.cargo, /^version = "1.12.1"$/m);
  assert.match(modified.files.lock, /^version = "1.12.1"$/m);
  assert.match(modified.files.cargo, /\[dependencies\]\nserde = "1"/);
});
test("rejects already inconsistent app manifests and unknown lock package", () => {
  assert.throws(() => changeManifestVersions(fixture("1.12.0", "1.11.0"), "1.12.0"), /Mismatched/);
  const broken = fixture();
  broken.lock = broken.lock.replace('name = "little-monkey"', 'name = "not-monkey"');
  assert.throws(() => changeManifestVersions(broken, "1.12.0"), /Cargo.lock/);
});
