import type { IssueToPrRun } from "../../lib/issueToPr";

type StageStatus = "complete" | "active" | "failed" | "pending";
interface Stage { name: string; status: StageStatus; evidence: string; }

export function issueToPrStages(run: IssueToPrRun): Stage[] {
  const phase = run.status;
  const testsPassed = run.checks.length > 0 && run.checks.every((check) => check.passed && check.code === 0);
  const testsFailed = run.checks.some((check) => !check.passed || check.code !== 0);
  const reviewed = Boolean(run.reviewEvidence && run.reviewEvidence.filesReviewed.length > 0);
  const ci = run.ciHistory.length ? run.ciHistory[run.ciHistory.length - 1] : undefined;
  const ciVerified = Boolean(ci && ci.verdict === "passed" && ci.headOid === run.ciHeadOid);
  const codingComplete = ["checking", "opening_pr", "awaiting_review", "monitoring_ci", "repairing", "ready", "done"].includes(phase)
    || (phase === "failed" && run.checks.length > 0);
  const ready = (phase === "ready" || phase === "done") && ciVerified && testsPassed && reviewed;
  return [
    { name: "Issue", status: "complete", evidence: run.repositorySlug + "#" + run.issueNumber },
    { name: "Planning", status: phase === "planning" ? "active" : phase === "failed" && run.checks.length === 0 ? "pending" : "complete", evidence: "Frozen base: " + run.baseRef },
    { name: "Coding", status: phase === "implementing" ? "active" : codingComplete ? "complete" : "pending", evidence: run.branch },
    { name: "Testing", status: testsPassed ? "complete" : testsFailed ? "failed" : phase === "checking" ? "active" : "pending", evidence: run.checks.length ? run.checks.filter((check) => check.passed && check.code === 0).length + "/" + run.checks.length + " checks passed" : "No authoritative local results" },
    { name: "Review", status: reviewed ? "complete" : phase === "checking" && testsPassed ? "active" : "pending", evidence: reviewed ? run.reviewEvidence!.filesReviewed.length + " files reviewed at revision " + run.reviewEvidence!.revision.slice(0, 12) : "Diff coverage and acceptance review required" },
    { name: "Draft PR", status: run.prNumber ? "complete" : phase === "opening_pr" ? "active" : "pending", evidence: run.prNumber ? "Draft PR #" + run.prNumber : "Requires typed delivery approval" },
    { name: "CI", status: ciVerified ? "complete" : ci?.verdict === "failed" ? "failed" : phase === "monitoring_ci" ? "active" : "pending", evidence: ci ? ci.verdict + " / " + ci.headOid.slice(0, 12) + " / " + ci.checks.length + " checks" : "No verified GitHub checks" },
    { name: "Repair", status: phase === "repairing" ? "active" : run.repairAttempts > 0 && ciVerified ? "complete" : "pending", evidence: run.repairAttempts + " / " + run.maxRepairAttempts + " attempts" },
    { name: "Ready", status: ready ? "complete" : "pending", evidence: ready ? "Human approval before final publication" : "Awaiting local tests, independent review and CI" },
  ];
}

export function IssueToPrTimeline({ run }: { run: IssueToPrRun }) {
  return (
    <section aria-label="Issue-to-PR workflow timeline">
      <h4 className="text-xs font-semibold text-foreground">Issue → Planning → Coding → Testing → Review → Draft PR → CI → Repair → Ready</h4>
      <ol className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {issueToPrStages(run).map((stage) => (
          <li key={stage.name} className="rounded-md border border-border bg-background p-2 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-foreground">{stage.name}</strong>
              <span className={stage.status === "complete" ? "text-success" : stage.status === "failed" ? "text-danger" : "text-muted"}>{stage.status}</span>
            </div>
            <p className="mt-1 break-words text-faint">{stage.evidence}</p>
          </li>
        ))}
      </ol>
      {(run.ciHistory?.length ?? 0) > 0 && (
        <details className="mt-2 text-xs text-muted">
          <summary>GitHub CI evidence ({run.ciHistory.length} observations)</summary>
          {run.ciHistory.slice(-12).map((observation, index) => (
            <div key={observation.headOid + "-" + observation.observedAtMs + "-" + index} className="mt-1 rounded-md border border-border p-2">
              <p>{observation.verdict} · {observation.headOid} · {new Date(observation.observedAtMs).toLocaleString()}</p>
              {observation.checks.map((check, checkIndex) => (
                <p key={check.name + "-" + checkIndex}>{check.name}: {check.state} / {check.conclusion}{check.url ? <> · <a href={check.url} target="_blank" rel="noopener noreferrer">Check details</a></> : null}</p>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
