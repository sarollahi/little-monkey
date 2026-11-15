import { describe, expect, it } from "vitest";
import type { IssueToPrRun } from "../../lib/issueToPr";
import { issueToPrStages } from "./IssueToPrTimeline";

const fixture = (changes: Partial<IssueToPrRun> = {}): IssueToPrRun => ({
  runId: "i2p-fixture",
  issueUrl: "https://github.com/owner/repo/issues/42",
  repositorySlug: "owner/repo",
  issueNumber: 42,
  issueTitle: "Fix the check",
  issueBody: "Expected behavior",
  worktreeId: "owned-fixture",
  branch: "issue-to-pr/fixture",
  baseRef: "develop",
  workspaceLabel: "owned-fixture",
  status: "planning",
  prNumber: null,
  prUrl: null,
  checks: [],
  ciHistory: [],
  ciHeadOid: null,
  repairAttempts: 0,
  maxRepairAttempts: 2,
  repairInProgress: false,
  agentWallTimeMs: 30 * 60_000,
  totalTokenBudget: 250_000,
  tokensUsed: 0,
  usageEventIds: [],
  error: null,
  durableRunId: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...changes,
});

const successfulCheck = { label: "test", command: "pnpm test", passed: true, code: 0, outputExcerpt: "passed" };
const greenCI = { headOid: "a".repeat(40), verdict: "passed" as const, observedAtMs: 42, checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", url: null }] };

describe("issue-to-PR evidence timeline", () => {
  it("always renders nine ordered stages with actual issue identity", () => {
    const stages = issueToPrStages(fixture());
    expect(stages.map((stage) => stage.name)).toEqual(["Issue", "Planning", "Coding", "Testing", "Review", "Draft PR", "CI", "Repair", "Ready"]);
    expect(stages[0].evidence).toBe("owner/repo#42");
    expect(stages.at(-1)?.status).toBe("pending");
  });

  it("never shows Ready from a model claim or green CI without authoritative local tests", () => {
    const stages = issueToPrStages(fixture({ status: "ready", prNumber: 4, ciHeadOid: greenCI.headOid, ciHistory: [greenCI] }));
    expect(stages.at(-1)?.status).toBe("pending");
    expect(stages.find((stage) => stage.name === "Testing")?.status).toBe("pending");
  });

  it("rejects a green but stale SHA and pending checks", () => {
    const stale = issueToPrStages(fixture({ status: "ready", prNumber: 4, checks: [successfulCheck], ciHeadOid: "b".repeat(40), ciHistory: [greenCI] }));
    expect(stale.at(-1)?.status).toBe("pending");
    expect(stale.find((stage) => stage.name === "CI")?.status).toBe("pending");
  });

  it("shows a failed local check and an active bounded repair", () => {
    const stages = issueToPrStages(fixture({ status: "repairing", checks: [{ ...successfulCheck, passed: false, code: 1 }], repairAttempts: 1 }));
    expect(stages.find((stage) => stage.name === "Testing")?.status).toBe("failed");
    expect(stages.find((stage) => stage.name === "Repair")?.status).toBe("active");
    expect(stages.at(-1)?.status).toBe("pending");
  });

  it("reaches Ready only after reviewed delivery, clean local checks, and matching green CI", () => {
    const stages = issueToPrStages(fixture({ status: "ready", prNumber: 4, checks: [successfulCheck], ciHeadOid: greenCI.headOid, ciHistory: [greenCI], repairAttempts: 1 }));
    expect(stages.find((stage) => stage.name === "Testing")?.status).toBe("complete");
    expect(stages.find((stage) => stage.name === "Review")?.status).toBe("complete");
    expect(stages.find((stage) => stage.name === "CI")?.status).toBe("complete");
    expect(stages.at(-1)?.status).toBe("complete");
  });
});
