#!/usr/bin/env node
/**
 * Candidate-only versioning for isolated, unpublished installer E2E.
 * Nothing in this file is used by the production release publishing workflow.
 * All three manifests plus the root Cargo.lock package entry must agree;
 * never reuse the already-published version for a candidate upgrade test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  package: resolve(root, "package.json"),
  tauri: resolve(root, "src-tauri/tauri.conf.json"),
  cargo: resolve(root, "src-tauri/Cargo.toml"),
  lock: resolve(root, "src-tauri/Cargo.lock"),
};
const parse = (text) => {
  const match = String(text).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("Expected stable published semver, got " + JSON.stringify(text));
  return match.slice(1).map(Number);
};
export function nextUnpublishedVersion(source, published) {
  const a = parse(source), b = parse(published);
  const biggest = [a, b].sort((x, y) =>
    x[0] - y[0] || x[1] - y[1] || x[2] - y[2]).at(-1);
  if (biggest[2] >= 2147483647) throw new Error("Cannot increment patch safely");
  return [biggest[0], biggest[1], biggest[2] + 1].join(".");
}
function updateCargoVersion(text, oldVersion, nextVersion) {
  const before = /^\[package\]\r?\nname = "little-monkey"\r?\nversion = "[^"]+"/m;
  if (!before.test(text)) throw new Error("Expected Little Monkey Cargo package metadata");
  if (!text.includes('[package]\nname = "little-monkey"\nversion = "' + oldVersion + '"')) {
    throw new Error("Cargo [package] version differs from the other manifests");
  }
  return text.replace(before, '[package]\nname = "little-monkey"\nversion = "' + nextVersion + '"');
}
function updateLockVersion(text, oldVersion, nextVersion) {
  const entry = '[[package]]\nname = "little-monkey"\nversion = "' + oldVersion + '"';
  if (text.split(entry).length !== 2) {
    throw new Error("Cargo.lock is missing exactly one matching root package");
  }
  return text.replace(entry, '[[package]]\nname = "little-monkey"\nversion = "' + nextVersion + '"');
}
export function changeManifestVersions(current, published) {
  const pkg = JSON.parse(current.package);
  const tauri = JSON.parse(current.tauri);
  const original = pkg.version;
  if (original !== tauri.version) {
    throw new Error("Mismatched package/tauri version before candidate preparation");
  }
  const next = nextUnpublishedVersion(original, published);
  pkg.version = tauri.version = next;
  // Don't enable signatures: this CI candidate is intentionally unpublished.
  const files = {
    package: JSON.stringify(pkg, null, 2) + "\n",
    tauri: JSON.stringify(tauri, null, 2) + "\n",
    cargo: updateCargoVersion(current.cargo, original, next),
    lock: updateLockVersion(current.lock, original, next),
  };
  return { version: next, sourceVersion: original, publishedVersion: published, files };
}
const i = process.argv.indexOf("--latest-published");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (i < 0 || !process.argv[i + 1]) throw new Error("Usage: ci-candidate-version.mjs --latest-published VERSION");
  const current = Object.fromEntries(Object.entries(files).map(([key,path]) =>
    [key,readFileSync(path, "utf8")]));
  const changed = changeManifestVersions(current, process.argv[i + 1]);
  for (const [key,path] of Object.entries(files)) {
    writeFileSync(path, changed.files[key]);
  }
  console.log(JSON.stringify({
    intendedUse: "unpublished-ci-installer-upgrade-only",
    sourceVersion: changed.sourceVersion,
    latestPublishedVersion: changed.publishedVersion,
    candidateVersion: changed.version,
    warning: "Never publish these locally modified build manifests as a release",
  }, null, 2));
}
