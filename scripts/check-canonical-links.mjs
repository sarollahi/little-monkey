#!/usr/bin/env node
/**
 * Guard the repository-owner migration. Preserve separately owned projects
 * such as AA-Box/little-monkey-mobile (they are NOT the same repository).
 * A Git scan checks tracked files, not only hand-picked documentation paths.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oldOwner = /https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/AA-Box\/little-monkey(?=\/|#|\?|$)/;
if (!oldOwner.test("https://github.com/AA-Box/little-monkey/releases/latest") ||
    oldOwner.test("https://github.com/AA-Box/little-monkey-mobile")) {
  throw new Error("Canonical link guard does not distinguish the mobile repository");
}
const run = spawnSync("git", [
  "grep", "-n", "-I", "-E",
  "https?://(github[.]com|raw[.]githubusercontent[.]com)/AA-Box/little-monkey([/#?]|$)",
  "--", "README.md", "ROADMAP.md", "SECURITY.md", "CONTRIBUTING.md",
  "docs", "src", "src-tauri", "scripts", ".github",
], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
if (run.error) throw run.error;
if (run.status === 0) {
  console.error("FAIL: stale owner URLs still point at the old repository:\n" + run.stdout);
  process.exitCode = 1;
} else if (run.status === 1) {
  console.log("PASS: no stale AA-Box/little-monkey main-repository URLs in tracked source/docs");
} else {
  console.error("FAIL: could not complete tracked-file link audit:\n" + (run.stderr || String(run.status)));
  process.exitCode = 1;
}
