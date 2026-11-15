import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Play,
  RefreshCw,
  Square,
  X,
  XCircle,
} from "lucide-react";

import {
  executeDeliveryMutation,
  prepareDeliveryMutation,
  inspectOwnedWorktree,
  type ConfirmationPreview,
  type DeliveryMutation,
} from "../../lib/gitDelivery";
import type { IssueToPrRun, IssueToPrStatus } from "../../lib/issueToPr";
import { issueToPrWorktreeRevision } from "../../lib/issueToPr";
import { isTerminalIssueToPrStatus } from "../../lib/issueToPr";
import { isSpecTooVague, SPEC_DIMENSIONS } from "../../lib/specScorer";
import { useT } from "../../lib/i18n";
import { useIssueToPrStore } from "../../store/issueToPrStore";
import { useSpecScorerStore } from "../../store/specScorerStore";
import { Button, IconButton, StatusPill, type PillTone } from "../ui";
import { errorMessage } from "../../lib/errors";
import { IssueToPrTimeline } from "./IssueToPrTimeline";
import { statusTone as sharedStatusTone } from "../../lib/statusTone";

interface IssueToPrPanelProps {
  onClose: () => void;
  onOpenRunCapsule?: (runId: string) => void;
}

function statusTone(status: IssueToPrStatus): PillTone {
  // Only three of this pipeline's states are terminal; every other step
  // (planning, implementing, checking, opening_pr, awaiting_review) is work
  // still in flight.
  if (status === "done" || status === "failed" || status === "cancelled") {
    return sharedStatusTone(status);
  }
  return "warning";
}

function errorText(error: unknown): string {
  return errorMessage(error);
}

/** Two real GitHub writes — pushing the owned branch, then opening the
 * draft PR — driven through the EXACT same `m5_delivery` confirm-and-type-
 * the-phrase flow `GitDeliveryPanel.tsx` uses for every other owned-branch
 * mutation. Nothing here bypasses that: both steps require the user to read
 * the preview and type the exact confirmation phrase before anything is
 * written to GitHub. */
function usePrConfirmFlow(run: IssueToPrRun | null, onOpened: (prNumber: number, prUrl: string) => void) {
  const [preview, setPreview] = useState<ConfirmationPreview | null>(null);
  // The EXACT mutation object `preview` was computed from — `execute`
  // recomputes the digest from whatever mutation it's given and rejects a
  // mismatch, so this must be the identical object passed to `prepare`, not
  // one reconstructed later (a `create_draft_pr` execute with a placeholder
  // title/body, for instance, would never match its own preview's digest).
  const [pendingMutation, setPendingMutation] = useState<DeliveryMutation | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);

  const reset = () => {
    setPreview(null);
    setPendingMutation(null);
    setConfirmation("");
    setError(null);
    setChangedFiles([]);
  };

  const previewNext = async (mutation: DeliveryMutation) => {
    const next = await prepareDeliveryMutation(mutation);
    setPreview(next);
    setPendingMutation(mutation);
    setConfirmation("");
  };

  const preparePush = async () => {
    if (!run) return;
    setError(null);
    try {
      if (!run.checks.length || run.checks.some((check) => !check.passed || check.code !== 0)) {
        throw new Error("Authoritative repository tests must pass before GitHub delivery.");
      }
      if (!run.reviewEvidence || run.reviewEvidence.revision !== await issueToPrWorktreeRevision(run.runId)) {
        throw new Error("The independent review is absent or stale for this owned diff. Reverify before delivery.");
      }
      const inspection = await inspectOwnedWorktree(run.worktreeId);
      if (inspection.worktree.marker.repositorySlug !== run.repositorySlug
          || inspection.worktree.marker.branch !== run.branch) {
        throw new Error("Owned branch identity no longer matches the issue.");
      }
      const files = [...new Set(inspection.files.filter((file) => !file.ignored).map((file) => file.path))];
      setChangedFiles(files);
      if (inspection.dirty && files.length === 0) throw new Error("Dirty owned worktree has no safe changed-file list.");
      await previewNext(inspection.dirty
        ? { kind: "commit", payload: { worktreeId: run.worktreeId, paths: files, message: ("Fix issue #" + run.issueNumber + ": " + run.issueTitle).slice(0, 120) } }
        : { kind: "push", payload: { worktreeId: run.worktreeId, remote: "origin" } });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const confirmPending = async () => {
    if (!run || !preview || !pendingMutation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeDeliveryMutation(pendingMutation, preview.digest, confirmation) as {
        number?: number; url?: string;
      };
      if (pendingMutation.kind === "commit") {
        await previewNext({ kind: "push", payload: { worktreeId: run.worktreeId, remote: "origin" } });
      } else if (pendingMutation.kind === "push") {
        if (run.baseRef === "HEAD") throw new Error("Legacy run has no concrete target branch; reconcile before opening a PR.");
        const title = ("Fixes #" + run.issueNumber + ": " + run.issueTitle).slice(0, 512);
        const checksSummary = run.checks.map((check) =>
          "- " + (check.passed ? "PASS" : "FAIL") + " " + check.label + ": " + check.command
          + " (exit " + (check.code ?? "unknown") + ")").join("\n");
        const body = [
          "Resolves #" + run.issueNumber + ".",
          "",
          "## Changes",
          changedFiles.length ? changedFiles.map((file) => "- " + file).join("\n") : "See the owned-branch PR diff.",
          "",
          "## Authoritative local verification",
          checksSummary,
          "",
          "## Independent review and limitations",
          run.reviewEvidence ? "Reviewed changed files: " + run.reviewEvidence.filesReviewed.join(", ") : "No review evidence",
          "Review evidence is retained in the autonomous task run ledger and tied to the exact tested diff. CI checks are observed against the PR head. Human approval is required before publication. No automatic merge or force-push.",
        ].join("\n");
        const mutation: DeliveryMutation = run.prNumber
          ? { kind: "update_draft_pr", payload: { worktreeId: run.worktreeId, prNumber: run.prNumber, title, body } }
          : { kind: "create_draft_pr", payload: { worktreeId: run.worktreeId, base: run.baseRef, title, body } };
        await previewNext(mutation);
      } else {
        const number = result.number ?? run.prNumber;
        const url = result.url ?? run.prUrl;
        reset();
        if (!number || !url) throw new Error("GitHub did not provide a verifiable draft PR identity.");
        onOpened(number, url);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return { preview, confirmation, setConfirmation, busy, error, preparePush, confirmPending, reset };
}

export function IssueToPrPanel({ onClose, onOpenRunCapsule }: IssueToPrPanelProps) {
  const { t } = useT();
  const store = useIssueToPrStore();
  const [issueUrl, setIssueUrl] = useState("");
  const [maxRepairAttempts, setMaxRepairAttempts] = useState(2);
  const [agentMinutes, setAgentMinutes] = useState(30);
  const [totalTokenBudget, setTotalTokenBudget] = useState(250_000);

  useEffect(() => {
    void store.init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(
    () => store.runs.find((run) => run.runId === store.selectedRunId) ?? null,
    [store.runs, store.selectedRunId],
  );

  const pr = usePrConfirmFlow(selected, (prNumber, prUrl) => {
    if (selected) void store.markPrOpened(selected.runId, prNumber, prUrl);
  });

  useEffect(() => {
    pr.reset();
  }, [selected?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Agent-Ready Spec Scorer (ROADMAP.md Phase 7, item 4) — advisory only:
  // scores the selected run's already-fetched issue title/body as soon as a
  // run is selected (a freshly-started run, or one picked back up from
  // history), purely so the panel can warn the reader here BEFORE they open
  // the resulting draft PR — it never gates `store.start()` or anything else
  // in `issueToPrStore.ts`'s `driveRun`. `scoreRun` itself is a no-op once a
  // run already has a cached status, so this is safe to call on every
  // selection change.
  const specScorer = useSpecScorerStore();
  useEffect(() => {
    if (!selected) return;
    void specScorer.scoreRun(selected.runId, selected.issueTitle, selected.issueBody);
  }, [selected?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const starting = store.busy.start;
  const activity = selected ? store.activityByRun[selected.runId] : undefined;
  const specStatus = selected ? specScorer.statusByRun[selected.runId] : undefined;
  const specScore = selected ? specScorer.scoresByRun[selected.runId] : undefined;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="issue-to-pr-title">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 id="issue-to-pr-title" className="text-sm font-semibold text-foreground">
            {t("IssueToPr.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">{t("IssueToPr.subtitle")}</p>
        </div>
        <IconButton size="sm" aria-label={t("IssueToPr.close")} title={t("IssueToPr.close")} onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <form
        className="flex shrink-0 flex-wrap items-end gap-2 border-b border-border px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!issueUrl.trim() || starting) return;
          void store.start(issueUrl.trim(), maxRepairAttempts, agentMinutes * 60_000, totalTokenBudget).then(() => setIssueUrl(""));
        }}
      >
        <label className="min-w-64 flex-1 text-xs text-muted">
          {t("IssueToPr.urlLabel")}
          <input
            className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            placeholder={t("IssueToPr.urlPlaceholder")}
            value={issueUrl}
            onChange={(event) => setIssueUrl(event.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Max repairs
          <select aria-label="Maximum CI repair attempts" className="mt-1 block rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground" value={maxRepairAttempts} onChange={(event) => setMaxRepairAttempts(Number(event.target.value))}>
            {[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted">
          Agent time
          <select aria-label="Agent time budget" className="mt-1 block rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground" value={agentMinutes} onChange={(event) => setAgentMinutes(Number(event.target.value))}>
            {[5, 15, 30, 60, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
          </select>
        </label>
        <label className="text-xs text-muted">
          Token budget
          <select aria-label="Total agent token budget" className="mt-1 block rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground" value={totalTokenBudget} onChange={(event) => setTotalTokenBudget(Number(event.target.value))}>
            {[50_000, 100_000, 250_000, 500_000, 1_000_000].map((tokens) => <option key={tokens} value={tokens}>{(tokens / 1_000).toFixed(0)}k</option>)}
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={starting || !issueUrl.trim()}>
          {starting ? <Loader2 className="animate-spin" size={14} /> : <Play size={14} />} {t("IssueToPr.startButton")}
        </Button>
      </form>

      {store.error && (
        <div role="alert" className="mx-5 mt-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {store.error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-5 xl:grid-cols-[minmax(16rem,.9fr)_minmax(0,1.3fr)]">
        <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">{t("IssueToPr.runsHeading")}</h3>
            <IconButton size="sm" aria-label="Refresh" onClick={() => void store.refresh()}>
              <RefreshCw size={13} />
            </IconButton>
          </div>
          <div className="mt-2 space-y-1.5">
            {store.runs.length === 0 && (
              <p className="rounded-md border border-dashed border-border p-5 text-center text-xs text-faint">
                {t("IssueToPr.emptyRuns")}
              </p>
            )}
            {store.runs.map((run) => (
              <button
                key={run.runId}
                type="button"
                onClick={() => store.selectRun(run.runId)}
                className={`w-full rounded-md border p-2.5 text-left transition-colors ${
                  run.runId === store.selectedRunId ? "border-accent bg-accent/10" : "border-border bg-background hover:border-border-strong"
                }`}
              >
                <p className="truncate text-xs font-medium text-foreground">
                  {run.repositorySlug}#{run.issueNumber}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-muted">{run.issueTitle}</p>
                <div className="mt-1.5">
                  <StatusPill tone={statusTone(run.status)}>{t(`IssueToPr.status${statusLabelSuffix(run.status)}`)}</StatusPill>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-surface p-4">
          {!selected ? (
            <p className="p-8 text-center text-xs text-faint">{t("IssueToPr.emptyRuns")}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{selected.issueTitle}</h3>
                  <p className="mt-1 font-mono text-[11px] text-faint">{selected.issueUrl}</p>
                </div>
                <StatusPill tone={statusTone(selected.status)}>{t(`IssueToPr.status${statusLabelSuffix(selected.status)}`)}</StatusPill>
              </div>

              <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-background p-3 text-[11px]">
                <dt className="text-faint">{t("IssueToPr.repositoryLabel")}</dt>
                <dd className="font-mono text-foreground">{selected.repositorySlug}</dd>
                <dt className="text-faint">{t("IssueToPr.branchLabel")}</dt>
                <dd className="break-all font-mono text-foreground">{selected.branch}</dd>
                <dt className="text-faint">{t("IssueToPr.worktreeLabel")}</dt>
                <dd className="break-all font-mono text-foreground">{selected.workspaceLabel}</dd>
              </dl>

              {specStatus === "loading" && (
                <p className="flex items-center gap-2 text-xs text-muted">
                  <Loader2 className="animate-spin shrink-0" size={13} />
                  {t("SpecScorer.scoringLabel")}
                </p>
              )}

              {specScore && isSpecTooVague(specScore) && (
                <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-foreground">
                    <AlertTriangle size={13} className="shrink-0 text-warning" /> {t("SpecScorer.bannerHeading")}
                  </p>
                  <p className="mt-1 text-muted">
                    {t("SpecScorer.bannerIntro", { score: specScore.overall, summary: specScore.summary })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-faint">
                    <span className="font-semibold text-foreground">{t("SpecScorer.dimensionsHeading")}:</span>
                    {SPEC_DIMENSIONS.map((dimension) => (
                      <span key={dimension}>
                        {t(`SpecScorer.dimension.${dimension}`)} {specScore.dimensions[dimension]}
                      </span>
                    ))}
                  </div>
                  {specScore.missingInfo.length > 0 && (
                    <div className="mt-2">
                      <p className="font-medium text-foreground">{t("SpecScorer.missingInfoHeading")}</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
                        {specScore.missingInfo.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-faint">{t("SpecScorer.advisoryNote")}</p>
                    <Button
                      size="sm"
                      onClick={() => void specScorer.rescoreRun(selected.runId, selected.issueTitle, selected.issueBody)}
                    >
                      <RefreshCw size={12} /> {t("SpecScorer.rescoreButton")}
                    </Button>
                  </div>
                </div>
              )}

              {specScore && !isSpecTooVague(specScore) && (
                <p className="flex items-center gap-1.5 text-[11px] text-faint">
                  <CheckCircle2 size={12} className="shrink-0 text-success" />
                  {t("SpecScorer.readyNote", { score: specScore.overall })}
                </p>
              )}

              {specStatus === "error" && (
                <p className="text-[11px] text-faint">{t("SpecScorer.errorNote")}</p>
              )}

              {activity && !isTerminalIssueToPrStatus(selected.status) && (
                <p className="flex items-center gap-2 text-xs text-muted">
                  <Loader2 className="animate-spin shrink-0" size={13} />
                  {t("IssueToPr.currentActivity", { activity })}
                </p>
              )}

              <IssueToPrTimeline run={selected} />
              <p className="text-xs text-muted">Frozen execution policy: {Math.round(selected.agentWallTimeMs / 60_000)} minutes per agent · {selected.tokensUsed.toLocaleString()} / {selected.totalTokenBudget.toLocaleString()} provider-reported tokens · {selected.repairAttempts} / {selected.maxRepairAttempts} repair attempts.</p>

              {selected.checks.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-foreground">{t("IssueToPr.checksHeading")}</h4>
                  <div className="mt-2 space-y-1.5">
                    {selected.checks.map((check) => (
                      <div key={check.label} className="flex items-start gap-2 rounded-md border border-border bg-background p-2 text-[11px]">
                        {check.passed ? (
                          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
                        ) : (
                          <XCircle size={13} className="mt-0.5 shrink-0 text-danger" />
                        )}
                        <div className="min-w-0">
                          <p className="font-mono text-foreground">
                            {check.label}
                            {check.command ? `: ${check.command}` : ""}
                            {" — "}
                            {check.passed ? t("IssueToPr.checksPassed") : t("IssueToPr.checksFailed")}
                          </p>
                          {check.outputExcerpt && (
                            <p className="mt-1 whitespace-pre-wrap break-words text-faint">{check.outputExcerpt}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.error && (
                <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
                  <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={13} /> {t("IssueToPr.errorHeading")}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{selected.error}</p>
                </div>
              )}

              <p className="rounded-md border border-dashed border-border p-2.5 text-[10px] leading-4 text-faint">
                {t("IssueToPr.nonGoalsNote")}
              </p>

              <div className="flex flex-wrap gap-2">
                {!isTerminalIssueToPrStatus(selected.status) && (
                  <Button size="sm" variant="danger" disabled={store.busy[`cancel:${selected.runId}`]} onClick={() => void store.cancel(selected.runId)}>
                    <Square size={13} /> {t("IssueToPr.cancelButton")}
                  </Button>
                )}
                {["awaiting_review", "monitoring_ci", "ready", "done"].includes(selected.status) && selected.prUrl && (
                  <>
                    <Button size="sm" onClick={() => window.open(selected.prUrl ?? undefined, "_blank", "noopener,noreferrer")}>
                      <ExternalLink size={13} /> {t("IssueToPr.openPrLinkButton")}
                    </Button>
                    {(selected.status === "ready" || selected.status === "awaiting_review") && (
                      <Button size="sm" variant="primary" disabled={store.busy[`done:${selected.runId}`]} onClick={() => void store.markDone(selected.runId)}>
                        <CheckCircle2 size={13} /> {t("IssueToPr.markDoneButton")}
                      </Button>
                    )}
                  </>
                )}
                {selected.durableRunId && onOpenRunCapsule && (
                  <Button size="sm" onClick={() => onOpenRunCapsule(selected.durableRunId!)}>
                    {t("IssueToPr.viewCapsuleButton")}
                  </Button>
                )}
              </div>

              {selected.status === "opening_pr" && (
                <div className="rounded-md border border-border bg-background p-3">
                  <h4 className="text-xs font-semibold text-foreground">{t("IssueToPr.openPrHeading")}</h4>
                  <p className="mt-1 text-[11px] leading-5 text-muted">{t("IssueToPr.openPrDescription")}</p>
                  {!pr.preview ? (
                    <Button size="sm" variant="primary" className="mt-2" onClick={() => void pr.preparePush()}>
                      <GitPullRequest size={13} /> {t("IssueToPr.pushAndOpenPrButton")}
                    </Button>
                  ) : (
                    <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-[11px]">
                      <p className="font-medium text-foreground">{pr.preview.summary}</p>
                      <p className="mt-1 text-muted">{pr.preview.impact}</p>
                      <label className="mt-2 block text-muted">
                        {t("IssueToPr.confirmTypePhrase", { phrase: pr.preview.confirmationPhrase })}
                        <input
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent"
                          value={pr.confirmation}
                          onChange={(event) => pr.setConfirmation(event.target.value)}
                        />
                      </label>
                      {pr.error && <p className="mt-2 text-danger">{pr.error}</p>}
                      <div className="mt-2 flex justify-end gap-2">
                        <Button size="sm" disabled={pr.busy} onClick={() => pr.reset()}>
                          {t("IssueToPr.confirmCancel")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={pr.busy || pr.confirmation !== pr.preview.confirmationPhrase}
                          onClick={() => void pr.confirmPending()}
                        >
                          {pr.busy && <Loader2 className="animate-spin" size={13} />} {t("IssueToPr.confirmExecute")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function statusLabelSuffix(status: IssueToPrStatus): string {
  switch (status) {
    case "planning": return "Planning";
    case "implementing": return "Implementing";
    case "checking": return "Checking";
    case "opening_pr": return "OpeningPr";
    case "awaiting_review": return "AwaitingReview";
    case "monitoring_ci": return "MonitoringCi";
    case "repairing": return "Repairing";
    case "ready": return "Ready";
    case "done": return "Done";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

export default IssueToPrPanel;
