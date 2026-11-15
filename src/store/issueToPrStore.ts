import { create } from "zustand";

import * as api from "../lib/issueToPr";
import type { IssueToPrRun } from "../lib/issueToPr";
import { isTerminalIssueToPrStatus } from "../lib/issueToPr";
import * as issueToPrRunner from "../lib/issueToPrRunner";
import { errorMessage } from "../lib/errors";
import { githubReviewThreads } from "../lib/gitDelivery";

function errorText(error: unknown): string {
  return errorMessage(error);
}

/** In-flight cancellation handles, keyed by run id — deliberately NOT part of
 * the zustand state (an `AbortController` isn't a value React/zustand needs
 * to react to, and storing it in state would make the store non-serializable
 * for no benefit). */
const controllers = new Map<string, AbortController>();
const monitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CI_POLL_MS = 30_000;
let unlisten: (() => void) | null = null;
const runIssueToPrAgent = issueToPrRunner.runIssueToPrAgent;
const autonomousIssueRunner = "runIssueToPrAutonomousTask" in issueToPrRunner
  ? issueToPrRunner.runIssueToPrAutonomousTask
  : null;

/** Test-only: clears in-flight run controllers. This module's `controllers`
 * map is process-lifetime by design (see the comment above it), which means
 * it otherwise leaks across every test in the same file. */
export function __resetIssueToPrControllersForTests(): void {
  controllers.clear();
  for (const timer of monitorTimers.values()) clearTimeout(timer);
  monitorTimers.clear();
}

interface IssueToPrState {
  runs: IssueToPrRun[];
  selectedRunId: string | null;
  activityByRun: Record<string, string>;
  busy: Record<string, boolean>;
  error: string | null;
  notice: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  selectRun: (runId: string | null) => void;
  start: (issueUrl: string, maxRepairAttempts?: number) => Promise<IssueToPrRun>;
  cancel: (runId: string) => Promise<void>;
  markPrOpened: (runId: string, prNumber: number, prUrl: string) => Promise<void>;
  markDone: (runId: string) => Promise<void>;
  clearMessages: () => void;
}

function upsertRun(runs: IssueToPrRun[], run: IssueToPrRun): IssueToPrRun[] {
  const index = runs.findIndex((candidate) => candidate.runId === run.runId);
  if (index === -1) return [run, ...runs];
  const next = [...runs];
  next[index] = run;
  return next;
}

export const useIssueToPrStore = create<IssueToPrState>((set, get) => {
  const perform = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    set((state) => ({ busy: { ...state.busy, [key]: true }, error: null }));
    try {
      return await task();
    } catch (error) {
      set({ error: errorText(error) });
      throw error;
    } finally {
      set((state) => ({ busy: { ...state.busy, [key]: false } }));
    }
  };

  function scheduleCiPoll(runId: string, delay = CI_POLL_MS): void {
    if (monitorTimers.has(runId)) return;
    const timer = setTimeout(() => {
      monitorTimers.delete(runId);
      void (async () => {
        try {
          const latest = await api.getIssueToPrStatus(runId);
          if (latest.status !== "monitoring_ci") return;
          onProgress(await api.pollIssueToPrCi(runId));
        } catch (error) {
          // A transient GitHub error must not produce a false success.
          set((state) => ({ activityByRun: { ...state.activityByRun, [runId]: "CI observation unavailable: " + errorText(error) } }));
          scheduleCiPoll(runId, Math.min(delay * 2, 120_000));
        }
      })();
    }, delay);
    monitorTimers.set(runId, timer);
  }

  async function driveRepair(run: IssueToPrRun): Promise<void> {
    if (controllers.has(run.runId)) return;
    const controller = new AbortController();
    controllers.set(run.runId, controller);
    try {
      let current = await api.getIssueToPrStatus(run.runId);
      while (current.status === "repairing" && !controller.signal.aborted) {
        current = await api.beginIssueToPrRepair(run.runId);
        onProgress(current);
        const failingLocalChecks = current.checks.filter((check) => !check.passed)
          .map((check) => ({ label: check.label, command: check.command, code: check.code, output: check.outputExcerpt }));
        const lastCi = current.ciHistory.at(-1);
        const reviewThreads = current.prNumber
          ? await githubReviewThreads(current.worktreeId, current.prNumber).catch(() => null)
          : null;
        const repairEvidence = JSON.stringify({
          failingLocalChecks,
          ciHead: lastCi?.headOid ?? null,
          ciVerdict: lastCi?.verdict ?? null,
          ciChecks: lastCi?.checks.filter((check) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion)) ?? [],
          reviewThreads,
        }).slice(0, 12_000);
        const result = await (autonomousIssueRunner ?? runIssueToPrAgent)({
          runId: current.runId,
          agentRunId: current.runId + "-repair-" + current.repairAttempts,
          repositorySlug: current.repositorySlug,
          issueNumber: current.issueNumber,
          issueTitle: current.issueTitle,
          issueBody: current.issueBody,
          branch: current.branch,
          baseRef: current.baseRef,
          worktreeId: current.worktreeId,
          workspaceLabel: current.workspaceLabel,
          signal: controller.signal,
          repairEvidence,
          onToolActivity: (activity) =>
            set((state) => ({ activityByRun: { ...state.activityByRun, [current.runId]: activity } })),
        });
        if (controller.signal.aborted) return;
        current = await api.getIssueToPrStatus(current.runId);
        if (current.status === "opening_pr") return;
        if (current.status === "repairing" && result.outcome === "completed") {
          // Fallback for older model runtimes with no coordinator verification node.
          current = await api.runIssueToPrChecks(current.runId);
        }
        if (current.status !== "repairing") return;
        if (current.repairInProgress) {
          await api.advanceIssueToPr(run.runId, "failed", { error: "Repair did not reach authoritative verification." });
          return;
        }
      }
    } catch (error) {
      const latest = await api.getIssueToPrStatus(run.runId).catch(() => null);
      if (latest?.status === "repairing") {
        await api.advanceIssueToPr(run.runId, "failed", { error: "Repair stopped: " + errorText(error) }).catch(() => {});
      }
    } finally {
      controllers.delete(run.runId);
    }
  }

  const onProgress = (run: IssueToPrRun) => {
    set((state) => ({ runs: upsertRun(state.runs, run) }));
    if (run.status === "monitoring_ci") scheduleCiPoll(run.runId);
    if (run.status === "repairing" && !controllers.has(run.runId)) void driveRepair(run);
    if (isTerminalIssueToPrStatus(run.status) || run.status === "ready") {
      const timer = monitorTimers.get(run.runId);
      if (timer) clearTimeout(timer);
      monitorTimers.delete(run.runId);
    }
    if (isTerminalIssueToPrStatus(run.status)) {
      controllers.delete(run.runId);
      set((state) => {
        const activityByRun = { ...state.activityByRun };
        delete activityByRun[run.runId];
        return { activityByRun };
      });
    }
  };

  /** Drives a started run from "planning" through the headless agent turn,
   * the target repository's own checks, and up to "opening_pr" (or
   * "failed") — everything after that (pushing the branch and opening the
   * draft PR) is a real external GitHub write and stays a human-confirmed
   * step in the panel, reusing `gitDelivery.ts`'s existing confirm-and-type-
   * the-phrase flow rather than anything in this function. Never throws —
   * every failure path reports itself onto the run record via
   * `advanceIssueToPr` instead. */
  const driveRun = async (run: IssueToPrRun): Promise<void> => {
    const controller = new AbortController();
    controllers.set(run.runId, controller);
    try {
      await api.advanceIssueToPr(run.runId, "implementing");
      const result = await (autonomousIssueRunner ?? runIssueToPrAgent)({
        runId: run.runId,
        repositorySlug: run.repositorySlug,
        issueNumber: run.issueNumber,
        issueTitle: run.issueTitle,
        issueBody: run.issueBody,
        branch: run.branch,
        baseRef: run.baseRef || "HEAD",
        worktreeId: run.worktreeId,
        workspaceLabel: run.workspaceLabel,
        signal: controller.signal,
        onToolActivity: (label) => {
          set((state) => ({ activityByRun: { ...state.activityByRun, [run.runId]: label } }));
        },
      });

      if (result.outcome === "cancelled") {
        // The Cancel action already calls `issue_to_pr_cancel` itself
        // (see `cancel` below) — nothing left to record here.
        return;
      }
      const coordinatorOutcome = "task" in result ? (result as { task?: { outcome?: string } }).task?.outcome : undefined;
      if (result.durableRunId) await api.advanceIssueToPr(run.runId, "implementing", { durableRunId: result.durableRunId }).catch(() => {});
      const latest = await api.getIssueToPrStatus(run.runId);
      if (latest.status === "repairing") {
        void driveRepair(latest);
        return;
      }
      if (latest.status === "opening_pr" || latest.status === "failed" || latest.status === "cancelled") return;
      if (coordinatorOutcome === "WAITING_USER" || coordinatorOutcome === "WAITING_APPROVAL") {
        await api.advanceIssueToPr(run.runId, "failed", { error: "Missing authoritative local check and independent review evidence." });
        return;
      }
      if (result.outcome === "error") {
        await api.advanceIssueToPr(run.runId, "failed", {
          error: result.summary,
          durableRunId: result.durableRunId,
        });
        return;
      }
      const checked = await api.runIssueToPrChecks(run.runId);
      if (checked.status === "repairing") void driveRepair(checked);
    } catch (error) {
      await api.advanceIssueToPr(run.runId, "failed", { error: errorText(error) }).catch(() => {});
    } finally {
      controllers.delete(run.runId);
      const latest = await api.getIssueToPrStatus(run.runId).catch(() => null);
      if (latest?.status === "repairing") void driveRepair(latest);
    }
  };

  /** Picks a non-terminal run back up after an app restart (or a fresh
   * `init()` in a process that never drove it) — without this, a run left
   * in "planning"/"implementing"/"checking"/"opening_pr" when the app closed
   * has no driver in the new process's `controllers` map and sits stuck
   * forever with Cancel as the only (also inert) action. Takes the
   * `controllers` slot synchronously before any `await` so a second `init()`
   * call racing this one can never double-drive the same run. */
  const resumeOrphanedRun = (run: IssueToPrRun): void => {
    if (controllers.has(run.runId) || isTerminalIssueToPrStatus(run.status)) return;
    if (run.status === "monitoring_ci") {
      scheduleCiPoll(run.runId, 1_000);
      return;
    }
    if (run.status === "repairing") {
      void driveRepair(run);
      return;
    }
    if (run.status === "opening_pr" || run.status === "awaiting_review" || run.status === "ready") {
      // Waiting on a human action (push+open-PR, or mark-done) in the panel
      // — nothing to re-drive.
      return;
    }
    if (run.status === "checking") {
      const controller = new AbortController();
      controllers.set(run.runId, controller);
      void (async () => {
        try {
          // Reconfirm the authoritative status before re-triggering a real
          // mutation — the list snapshot this loop iterated over can be
          // stale by the time this async resume actually runs.
          const latest = await api.getIssueToPrStatus(run.runId).catch(() => run);
          if (latest.status === "checking") {
            const checked = await api.runIssueToPrChecks(run.runId);
            if (checked.status === "repairing") void driveRepair(checked);
          }
        } catch (error) {
          await api.advanceIssueToPr(run.runId, "failed", { error: errorText(error) }).catch(() => {});
        } finally {
          controllers.delete(run.runId);
        }
      })();
      return;
    }
    // "planning" or "implementing": re-run the headless agent turn against
    // the same owned worktree. Any files it already wrote are still on disk,
    // so the agent picks up from there instead of losing progress; the self-
    // transition `implementing` -> `implementing` this triggers is a legal
    // no-op on the Rust side (see `issue_to_pr.rs`'s `valid_transition`).
    void driveRun(run);
  };

  return {
    runs: [],
    selectedRunId: null,
    activityByRun: {},
    busy: {},
    error: null,
    notice: null,

    clearMessages: () => set({ error: null, notice: null }),

    init: async () => {
      if (!unlisten) {
        unlisten = await api.listenIssueToPrProgress(onProgress);
      }
      await get().refresh();
      for (const run of get().runs) {
        resumeOrphanedRun(run);
      }
    },

    refresh: () =>
      perform("refresh", async () => {
        const runs = await api.listIssueToPrRuns();
        set((state) => ({
          runs,
          selectedRunId: state.selectedRunId && runs.some((run) => run.runId === state.selectedRunId)
            ? state.selectedRunId
            : runs[0]?.runId ?? null,
        }));
      }),

    selectRun: (runId) => set({ selectedRunId: runId }),

    start: (issueUrl, maxRepairAttempts = 2) =>
      perform("start", async () => {
        const initial = await api.startIssueToPr(issueUrl);
        const run = await api.setIssueToPrRepairLimit(initial.runId, maxRepairAttempts);
        set((state) => ({ runs: upsertRun(state.runs, run), selectedRunId: run.runId }));
        void driveRun(run);
        return run;
      }),

    cancel: (runId) =>
      perform(`cancel:${runId}`, async () => {
        controllers.get(runId)?.abort();
        const run = await api.cancelIssueToPr(runId);
        set((state) => ({ runs: upsertRun(state.runs, run) }));
      }),

    markPrOpened: (runId, prNumber, prUrl) =>
      perform(`pr:${runId}`, async () => {
        const run = await api.advanceIssueToPr(runId, "monitoring_ci", { prNumber, prUrl });
        set((state) => ({ runs: upsertRun(state.runs, run) }));
        scheduleCiPoll(run.runId, 1_000);
      }),

    markDone: (runId) =>
      perform(`done:${runId}`, async () => {
        const run = await api.advanceIssueToPr(runId, "done");
        set((state) => ({ runs: upsertRun(state.runs, run) }));
      }),
  };
});
