import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectReleaseDraft } from "./release-manifest-gate.mjs";

const version = "1.12.0";
const base = [
  "latest.json",
  "little-monkey-release-key.asc",
  "little-monkey-sbom.cyclonedx.json",
  "little-monkey-vscode-1.0.0.vsix",
  "little-monkey-jetbrains-1.0.0.zip",
  "Little.Monkey_1.12.0_aarch64.dmg",
  "Little.Monkey_1.12.0_x64.dmg",
  "Little.Monkey_aarch64.app.tar.gz",
  "Little.Monkey_x64.app.tar.gz",
  "Little.Monkey_1.12.0_arm64-setup.exe",
  "Little.Monkey_1.12.0_x64-setup.exe",
  "Little.Monkey_1.12.0_amd64.deb",
  "Little.Monkey_1.12.0_arm64.deb",
  "Little.Monkey_1.12.0_aarch64.AppImage",
  "Little.Monkey_1.12.0_amd64.AppImage",
  "Little.Monkey-1.12.0-1.aarch64.rpm",
  "Little.Monkey-1.12.0-1.x86_64.rpm",
];
const requireLinux = (name) => /\.(deb|AppImage|rpm)$/.test(name);
const requireUpdater = (name) => /\.app\.tar\.gz$|\.AppImage$|-setup\.exe$/.test(name);
function fixture() {
  const all = [...base];
  for (const name of base) {
    if (requireLinux(name)) all.push(name + ".asc");
    if (requireUpdater(name)) all.push(name + ".sig");
  }
  return { draft: true, tag_name: version, assets: all.map((name) =>
    ({ name, digest: "sha256:" + "a".repeat(64), size: 64 })) };
}
test("complete real-format draft package inventory passes structural gate", () => {
  const m = fixture();
  const result = inspectReleaseDraft(m, version);
  assert.equal(result.pass, true, result.failures.join("\n"));
  assert.equal(result.requiredUpdaterSignaturePairs, 6);
  assert.equal(result.requiredLinuxDetachedSignatures, 6);
});
test("missing signed updater blocks publication", () => {
  const m = fixture();
  m.assets = m.assets.filter((a) => a.name !== "Little.Monkey_1.12.0_x64-setup.exe.sig");
  const r = inspectReleaseDraft(m, version);
  assert.equal(r.pass, false);
  assert.match(r.failures.join(" "), /setup.exe.sig/);
});
test("missing Linux detached signature blocks publication", () => {
  const m = fixture();
  m.assets = m.assets.filter((a) => a.name !== "Little.Monkey_1.12.0_amd64.deb.asc");
  assert.match(inspectReleaseDraft(m, version).failures.join(" "), /deb.asc/);
});
test("missing SBOM, updater index and code-signing public key are all blockers", () => {
  for (const name of ["little-monkey-sbom.cyclonedx.json", "latest.json", "little-monkey-release-key.asc"]) {
    const m = fixture();
    m.assets = m.assets.filter((a) => a.name !== name);
    assert.equal(inspectReleaseDraft(m, version).pass, false, name);
  }
});
test("not a draft, version mismatches and invalid SHA-256 are blockers", () => {
  const m = fixture();
  m.draft = false;
  assert.equal(inspectReleaseDraft(m, version).pass, false);
  m.draft = true;
  assert.equal(inspectReleaseDraft(m, "1.12.1").pass, false);
  m.assets[0].digest = "none";
  assert.equal(inspectReleaseDraft(m, version).pass, false);
});
