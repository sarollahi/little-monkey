#!/usr/bin/env node
/**
 * Verify release artifact bytes against GitHub's published SHA-256 asset
 * digests. This checks transport/payload integrity; it is NOT signature
 * validation and does not establish trust in a compromised release account.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

const option = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1];
};
export async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyReleaseAssets({ metadata, directory }) {
  const checks = [];
  if (!metadata || !Array.isArray(metadata.assets) || metadata.assets.length === 0) {
    throw new Error("Release metadata has no assets; cannot verify artifacts");
  }
  if (!existsSync(directory)) throw new Error("Artifact directory does not exist");
  const declared = new Map(metadata.assets.map((asset) => [asset.name, asset]));
  const actual = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (actual.length === 0) throw new Error("No artifacts were downloaded; integrity was not tested");
  for (const item of actual) {
    const source = declared.get(item.name);
    if (!source) {
      checks.push({ name: item.name, pass: false, reason: "not in release manifest" });
      continue;
    }
    const expectedDigest = source.digest;
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest || "")) {
      checks.push({ name: item.name, pass: false, reason: "missing valid GitHub SHA-256 digest" });
      continue;
    }
    const path = join(directory, item.name);
    const size = statSync(path).size;
    if (size !== source.size) {
      checks.push({ name: item.name, pass: false, reason: "byte length mismatch", size, expectedSize: source.size });
      continue;
    }
    const digest = "sha256:" + await digestFile(path);
    checks.push({ name: item.name, pass: digest === expectedDigest,
      reason: digest === expectedDigest ? "byte-identical to manifest" : "SHA-256 mismatch",
      size, digest, expectedDigest });
  }
  return { tag: metadata.tag_name ?? null, checks,
    passed: checks.length > 0 && checks.every((check) => check.pass),
    unverifiedReleaseAssets: [...declared.keys()].filter((name) => !actual.some((item) => item.name === name)) };
}
async function main() {
  const metadataPath = option("--metadata");
  const artifactsDir = option("--artifacts");
  if (!metadataPath || !artifactsDir) throw new Error("Usage: node scripts/release-asset-integrity.mjs --metadata RELEASE_JSON --artifacts DIR");
  const report = await verifyReleaseAssets({
    metadata: JSON.parse(readFileSync(resolve(metadataPath), "utf8")),
    directory: resolve(artifactsDir),
  });
  for (const check of report.checks) console.log(`${check.pass ? "PASS" : "FAIL"} integrity ${check.name}: ${check.reason}`);
  if (report.unverifiedReleaseAssets.length) {
    console.log("NOT VERIFIED (not downloaded): " + report.unverifiedReleaseAssets.join(", "));
  }
  if (!report.passed) process.exitCode = 1;
}
if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
