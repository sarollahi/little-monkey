#!/usr/bin/env node
/**
 * GitHub Actions release-source evidence gate.
 *
 * Prevents a manually approved workflow_dispatch from publishing a new main
 * SHA just because a prior PR SHA passed. Trust GitHub's workflow_run records
 * from the authenticated repository API; never treat a URL or a claimed
 * acceptance report as CI status.
 */
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function inspectReleaseSourceCI(payload, commit) {
  const errors = [];
  if (!/^[a-f0-9]{40}$/.test(commit || "")) {
    errors.push("expected the exact 40-hex release commit SHA");
  }
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    return { pass: false, errors: ["GitHub Actions response has no workflow_runs array"], latestCI: null };
  }
  const matches = payload.workflow_runs.filter((run) =>
    run?.name === "CI" &&
    run.head_sha === commit &&
    run.head_branch === "main" &&
    run.event === "push",
  );
  // Run IDs monotonically increase on GitHub. A completed older success must
  // not hide a newly failed/queued rerun of the same source revision.
  const latest = matches.sort((a, b) => (b.id || 0) - (a.id || 0))[0] || null;
  if (!latest) errors.push("no full CI push run found for the exact main commit");
  else if (latest.status !== "completed" || latest.conclusion !== "success") {
    errors.push("latest exact-source CI is not successful (status=" +
      String(latest.status) + ", conclusion=" + String(latest.conclusion) + ")");
  }
  return {
    pass: errors.length === 0,
    errors,
    latestCI: latest && {
      id: latest.id,
      status: latest.status,
      conclusion: latest.conclusion,
      sha: latest.head_sha,
      url: latest.html_url || null,
    },
    limitation: "A completed CI workflow is required but does not replace physical OS, model, security, signing, or manual acceptance checks",
  };
}

function get(name) {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1];
}
function main() {
  const file = get("--metadata");
  const sha = get("--commit");
  if (!file || !sha) throw new Error("Usage: release-ci-source-gate.mjs --metadata github-actions.json --commit EXACT_SHA");
  const report = inspectReleaseSourceCI(JSON.parse(readFileSync(resolve(file), "utf8")), sha);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!report.pass) process.exitCode = 1;
}
if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
