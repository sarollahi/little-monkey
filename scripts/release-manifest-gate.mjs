#!/usr/bin/env node
/**
 * Release-draft asset completeness check. Runs immediately BEFORE making a
 * GitHub Release public, in addition to installer SHA-256 checks elsewhere.
 * This is a structural / digest-presence gate; it does not authenticate a
 * signing-key fingerprint, notarization, or installed OS behavior.
 */
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const option = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1];
};
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function inspectReleaseDraft(metadata, version) {
  const failures = [];
  if (!metadata || !Array.isArray(metadata.assets)) {
    return { pass: false, failures: ["GitHub release metadata has no assets"], checkedAssets: 0 };
  }
  if (metadata.draft !== true) failures.push("the release must remain a draft until validation finishes");
  if (metadata.tag_name !== version) failures.push("draft tag does not match candidate version");
  const names = new Map(metadata.assets.map((asset) => [asset.name, asset]));
  const check = (name, predicate) => {
    const matches = [...names.keys()].filter((candidate) => predicate(candidate));
    if (matches.length !== 1) {
      failures.push(name + ": expected exactly one asset, found " + matches.length);
      return null;
    }
    const asset = names.get(matches[0]);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) {
      failures.push(name + ": zero-length asset or missing GitHub SHA-256 digest");
    }
    return matches[0];
  };
  const exact = (name) => check(name, (s) => s === name);
  const versioned = escaped(version);
  const linux = ["amd64", "arm64"];
  const updater = [];
  exact("latest.json");
  exact("little-monkey-release-key.asc");
  exact("little-monkey-sbom.cyclonedx.json");
  check("VS Code package", (s) => /^little-monkey-vscode-.+\.vsix$/.test(s));
  check("JetBrains package", (s) => /^little-monkey-jetbrains-.+\.zip$/.test(s));
  for (const arch of ["aarch64", "x64"]) {
    check("macOS " + arch + " DMG", (s) => new RegExp("^Little[.]Monkey_" + versioned + "_" + arch + "[.]dmg$").test(s));
    const tar = check("macOS " + arch + " app updater", (s) =>
      new RegExp("^Little[.]Monkey_" + arch + "[.]app[.]tar[.]gz$").test(s));
    if (tar) updater.push(tar);
  }
  for (const arch of ["arm64", "x64"]) {
    const exe = check("Windows " + arch + " NSIS", (s) =>
      new RegExp("^Little[.]Monkey_" + versioned + "_" + arch + "-setup[.]exe$").test(s));
    if (exe) updater.push(exe);
  }
  for (const arch of linux) {
    const deb = check("Linux " + arch + " Debian", (s) =>
      new RegExp("^Little[.]Monkey_" + versioned + "_" + arch + "[.]deb$").test(s));
    if (deb) exact(deb + ".asc");
    const appArch = arch === "amd64" ? "amd64" : "aarch64";
    const app = check("Linux " + arch + " AppImage", (s) =>
      new RegExp("^Little[.]Monkey_" + versioned + "_" + appArch + "[.]AppImage$").test(s));
    if (app) { exact(app + ".asc"); updater.push(app); }
  }
  for (const asset of updater) exact(asset + ".sig");
  const rpm = [...names.keys()].filter((name) => name.endsWith(".rpm"));
  for (const asset of rpm) exact(asset + ".asc");
  return {
    pass: failures.length === 0,
    failures,
    checkedAssets: metadata.assets.length,
    requiredUpdaterSignaturePairs: updater.length,
    requiredLinuxDetachedSignatures: linux.length * 2 + rpm.length,
    limitation: "Structural manifest + GitHub SHA-256 fields only; not a GPG/OS signing-key verification",
  };
}
async function main() {
  const file = option("--metadata");
  const version = option("--version");
  if (!file || !version) {
    throw new Error("Usage: node scripts/release-manifest-gate.mjs --metadata release.json --version 1.2.3");
  }
  const report = inspectReleaseDraft(JSON.parse(readFileSync(resolve(file), "utf8")), version);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
