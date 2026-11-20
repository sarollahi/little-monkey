/**
 * The invariant this whole architecture exists for, from the surface's side:
 * a Send becomes a durable ingress turn before any agent runs, and the app
 * process never runs one itself while a resident runner exists.
 *
 * The two cases here are the ones that used to be exceptions. A turn the loop
 * classifies as workspace-mutating stayed in this process because only this
 * process could tell whether a file changed; a resumed frozen turn stayed
 * because its image was written here. Both are now durable turns owned by the
 * backend, and the way to prove it is to watch what a Send touches: the bridge,
 * and never `streamChat`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  getCurrentWindow: () => ({ label: "main" }),
}));

/** Every in-process model round trip. This must stay empty. */
const streamed: unknown[] = [];
vi.mock("./llamaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llamaClient")>();
  return {
    ...actual,
    streamChat: async function* streamChat(...args: unknown[]) {
      streamed.push(args);
      yield { type: "delta", content: "answered in the webview" };
      yield { type: "done" };
    },
  };
});

const mocks = vi.hoisted(() => ({
  submitDaemonDesktopTurn: vi.fn(),
  watchDaemonDesktopTurn: vi.fn(),
  ingressTurnResume: vi.fn(),
  recoverableDesktopTurns: vi.fn(),
}));

vi.mock("./daemonDesktopTurn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemonDesktopTurn")>()),
  submitDaemonDesktopTurn: mocks.submitDaemonDesktopTurn,
  watchDaemonDesktopTurn: mocks.watchDaemonDesktopTurn,
}));

vi.mock("./ingressClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ingressClient")>()),
  ingressTurnResume: mocks.ingressTurnResume,
  recoverableDesktopTurns: mocks.recoverableDesktopTurns,
}));

import { runAgentTurn } from "./agentLoop";
import { recoverDaemonDesktopTurns } from "./daemonTurnRecovery";
import { useModelStore } from "../store/modelStore";
import { usePermissionStore } from "../store/permissionStore";
import { useSessionStore, type ChatSession } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";

const HEALTHY_DAEMON = {
  installed: true,
  serviceRunning: true,
  heartbeatFresh: true,
  killSwitch: false,
  queued: 0,
  active: 0,
};

const WORKSPACE = "/workspace/project";

function seedSession(sessionId: string): void {
  const session: ChatSession = {
    id: sessionId,
    title: "Durable ingress",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    unread: false,
    archived: false,
    groupId: null,
    modelTarget: null,
    comparisonBranch: null,
    workspacePath: WORKSPACE,
    personaId: null,
    attachedStackIds: [],
    docChatMode: false,
    subagentRuns: {},
  };
  useSessionStore.setState({
    sessions: [session],
    activeSessionId: sessionId,
    messages: [],
    runningTurns: {},
  });
}

/** One resident Ollama model, so a target can actually be frozen. Local rather
 * than a cloud provider on purpose: the Privacy Firewall gate on the cloud path
 * is a separate concern with its own tests, and nothing here is about egress. */
function seedTarget(): void {
  useModelStore.setState({
    installed: [],
    active: null,
    llamaStatus: "stopped",
    ollamaModels: [{
      name: "qwen2.5:7b",
      size_bytes: 1,
      is_cloud: false,
      tool_calling: true,
      vision: false,
      modified_at: "now",
    }],
    ollamaReachable: true,
    providers: [],
    providerModels: {},
    activeProvider: "ollama",
    activeOllamaModel: "qwen2.5:7b",
  });
}

interface SubmittedRecipe {
  desktop_turn: { workspace_mutation_required: boolean; turn_id: string; session_id: string };
}

beforeEach(() => {
  streamed.length = 0;
  mocks.submitDaemonDesktopTurn.mockReset();
  mocks.watchDaemonDesktopTurn.mockReset();
  mocks.ingressTurnResume.mockReset();
  mocks.recoverableDesktopTurns.mockReset();
  mocks.submitDaemonDesktopTurn.mockResolvedValue({ job_id: "job-1", run_id: "run-1", state: "queued" });
  mocks.watchDaemonDesktopTurn.mockResolvedValue({
    output: "the resident runner answered",
    status: "done",
    terminal: true,
    terminalStatus: "succeeded",
    error: null,
    summary: null,
    lastSequence: 3,
  });
  mocks.ingressTurnResume.mockResolvedValue({
    ingress_id: "ingr-2",
    parent_ingress_id: "ingr-1",
    job_id: "job-2",
    run_id: "run-2",
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "daemon_desktop_status") return HEALTHY_DAEMON;
    if (command === "process_admit") return { processId: "p-1" };
    if (command === "rules_list") return [];
    if (command === "workspace_list_roots") {
      return [{ id: "root-1", path: WORKSPACE, label: "project", is_primary: true }];
    }
    return undefined;
  });
  useWorkspaceStore.setState({
    roots: [{ id: "root-1", path: WORKSPACE, label: "project", is_primary: true }],
  });
  useSettingsStore.setState({ webToolsEnabled: false, memoryEnabled: false });
  usePermissionStore.setState({ mode: "acceptEdits" });
  seedTarget();
  seedSession("s-1");
});

/** The recipe the bridge was handed, whatever the surface built. */
function submittedRecipe(): SubmittedRecipe {
  expect(mocks.submitDaemonDesktopTurn).toHaveBeenCalledTimes(1);
  return mocks.submitDaemonDesktopTurn.mock.calls[0][1] as SubmittedRecipe;
}

describe("lost first-save session safety", () => {
  it("refuses a new model turn from a read-only recovered shell", async () => {
    seedSession("recovered-1");
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map(s =>
        s.id === "recovered-1" ? { ...s, recoveryOnly: true } : s
      ),
    }));
    await expect(runAgentTurn("recovered-1", "continue writing files"))
      .rejects.toThrow(/without its original transcript/i);
    expect(mocks.submitDaemonDesktopTurn).not.toHaveBeenCalled();
    expect(mocks.watchDaemonDesktopTurn).not.toHaveBeenCalled();
    expect(streamed).toEqual([]);
  });
});

describe("every desktop send is a durable ingress turn", () => {
  it("hands a workspace-mutating send to the resident runner with its contract frozen", async () => {
    await runAgentTurn("s-1", "fix the failing test in src/lib/a.ts");

    const recipe = submittedRecipe();
    expect(recipe.desktop_turn.workspace_mutation_required).toBe(true);
    expect(recipe.desktop_turn.session_id).toBe("s-1");
    // The one assertion the removed bypass is about: no model round trip
    // happened in this process, for a turn that asks for a file to change.
    expect(streamed).toEqual([]);
    expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(1);
  });

  it("hands a read-only send to the same path, promising nothing", async () => {
    await runAgentTurn("s-1", "explain what this project does");

    expect(submittedRecipe().desktop_turn.workspace_mutation_required).toBe(false);
    expect(streamed).toEqual([]);
  });

  it("keeps the submitted turn id as the durable identity a retry lands on", async () => {
    await runAgentTurn("s-1", "add a dark mode toggle to the settings panel");

    const [turnId, recipe] = mocks.submitDaemonDesktopTurn.mock.calls[0] as [string, SubmittedRecipe];
    expect(recipe.desktop_turn.turn_id).toBe(turnId);
    expect(turnId).toMatch(/[0-9a-f-]{36}/);
  });

  it("watches the continuation a resume was already accepted as, under the turn it belongs to", async () => {
    await runAgentTurn("s-1", "", [], undefined, undefined, [], [], false, {
      resumedFromCheckpointId: "ckpt-1",
      determinismCaveats: ["Tool output is not replayed."],
      parentTurnId: "turn-original",
      accepted: {
        ingressId: "ingr-2",
        parentIngressId: "ingr-1",
        jobId: "job-2",
        runId: "run-2",
      },
    });

    // A resume is not a new send, and it is not a webview execution either.
    expect(mocks.submitDaemonDesktopTurn).not.toHaveBeenCalled();
    expect(streamed).toEqual([]);
    expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(1);
    // The link reconnects by the *accepted turn*, not the continuation: that is
    // the identity a later restart can still ask about.
    const link = mocks.watchDaemonDesktopTurn.mock.calls[0][0] as {
      turnId: string;
      runId: string;
    };
    expect(link).toMatchObject({ turnId: "turn-original", runId: "run-2" });
    const caveat = useSessionStore
      .getState()
      .sessions[0].messages.find((message) => message.role === "system");
    expect(caveat?.content).toContain("Tool output is not replayed.");
  });

  /**
   * The ownership boundary, stated as an absence: this loop cannot submit a
   * Resume, so it cannot be the thing a frozen image has to be destroyed to
   * reach. `frozenTurn.ts` submits, and only hands a `ResumedTurn` here once the
   * backend already holds the continuation.
   */
  it("never submits a resume of its own — it is handed one already accepted", async () => {
    await runAgentTurn("s-1", "", [], undefined, undefined, [], [], false, {
      resumedFromCheckpointId: "ckpt-1",
      determinismCaveats: [],
      parentTurnId: "turn-original",
      accepted: {
        ingressId: "ingr-2",
        parentIngressId: "ingr-1",
        jobId: "job-2",
        runId: "run-2",
      },
    });

    expect(mocks.ingressTurnResume).not.toHaveBeenCalled();
    expect(streamed).toEqual([]);
  });

  /** Every way the resident runner can be unusable. None of them is permission
   * to execute the turn here instead: the app refuses, and says which state the
   * runner is in — repairable in place for the first three, deliberate for the
   * kill switch. */
  const unusable = [
    ["is not installed", { installed: false }, /isn't installed/i],
    ["is installed but stopped", { serviceRunning: false }, /not healthy/i],
    ["has a stale heartbeat", { heartbeatFresh: false }, /not healthy/i],
    ["is kill-switched", { killSwitch: true }, /kill switch/i],
  ] as const;

  for (const [description, patch, message] of unusable) {
    it(`refuses a send when the runner ${description}, rather than running it here`, async () => {
      invokeMock.mockImplementation(async (command: string) => {
        if (command === "daemon_desktop_status") return { ...HEALTHY_DAEMON, ...patch };
        if (command === "process_admit") return { processId: "p-1" };
        if (command === "rules_list") return [];
        if (command === "workspace_list_roots") {
          return [{ id: "root-1", path: WORKSPACE, label: "project", is_primary: true }];
        }
        return undefined;
      });

      await expect(runAgentTurn("s-1", "fix the failing test in src/lib/a.ts")).rejects.toThrow(message);

      // Nothing ran, and nothing was invented: no model round trip, no ingress
      // row, no run, and no assistant message pretending a turn happened.
      expect(streamed).toEqual([]);
      expect(mocks.submitDaemonDesktopTurn).not.toHaveBeenCalled();
      expect(mocks.watchDaemonDesktopTurn).not.toHaveBeenCalled();
      expect(useSessionStore.getState().sessions[0].messages).toEqual([]);
    });
  }

  it("still refuses a mutating send with no open workspace, before anything is submitted", async () => {
    useWorkspaceStore.setState({ roots: [] });
    await runAgentTurn("s-1", "fix the failing test in src/lib/a.ts");

    expect(mocks.submitDaemonDesktopTurn).not.toHaveBeenCalled();
    expect(streamed).toEqual([]);
    const messages = useSessionStore.getState().sessions[0].messages;
    expect(messages[messages.length - 1].content).toContain("No files changed");
  });
});

describe("long-lived cross-window daemon observation", () => {
  it("repairs a stale cached message index without overwriting a different message", async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
    seedSession("s-1");
    useSessionStore.getState().addMessage("s-1", {
      role: "user", content: "keep this message",
    }, true);
    const { saveActiveDaemonTurn } = await import("./daemonDesktopTurn");
    saveActiveDaemonTurn({
      sessionId: "s-1", turnId: "turn-cache", runId: "run-cache",
      assistantIndex: 0, lastSequence: 10, output: "incomplete prefix",
    });
    mocks.recoverableDesktopTurns.mockRejectedValue(new Error("daemon restarting"));
    let dispose: (() => void) | undefined;
    try {
      dispose = recoverDaemonDesktopTurns();
      await vi.advanceTimersByTimeAsync(1);
      const observed = mocks.watchDaemonDesktopTurn.mock.calls[0][0];
      expect(observed).toMatchObject({
        runId: "run-cache", assistantIndex: 1,
        lastSequence: 0, output: "",
      });
      const session = useSessionStore.getState().sessions.find(s => s.id === "s-1")!;
      expect(session.messages[0].content).toBe("keep this message");
      expect(session.messages[1].durableTurn?.runId).toBe("run-cache");
    } finally {
      dispose?.();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("unmount detaches its observers but never cancels daemon execution", async () => {
    vi.useFakeTimers();
    mocks.recoverableDesktopTurns.mockResolvedValue({
      turns: [{
        ingress_id: "ing-live", source: "desktop",
        source_account_id: "s-1", source_event_id: "turn-live",
        state: "queued", created_at_ms: 10, run_id: "run-live",
        job_id: "job-live", run_state: "running", execution_version: 1,
      }],
    });
    mocks.watchDaemonDesktopTurn.mockImplementation((_link: unknown, signal: AbortSignal) =>
      new Promise(resolve => {
        signal.addEventListener("abort", () => resolve({
          output: "", status: "detached", terminal: false,
          terminalStatus: null, lastSequence: 0,
        }), { once: true });
      }));
    let dispose: (() => void) | undefined;
    try {
      dispose = recoverDaemonDesktopTurns();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(1);
      const signal = mocks.watchDaemonDesktopTurn.mock.calls[0][1] as AbortSignal;
      expect(signal.aborted).toBe(false);
      expect(mocks.watchDaemonDesktopTurn.mock.calls[0][3]).toBe(false);
      dispose();
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(1);
    } finally {
      dispose?.();
      vi.useRealTimers();
    }
  });

  it("discovers a newer run after the previous run was already observed as terminal", async () => {
    vi.useFakeTimers();
    const sample = (run: string, created: number) => ({
      ingress_id: "ing-" + run,
      source: "desktop", source_account_id: "s-1",
      source_event_id: "turn-" + run, state: "queued",
      created_at_ms: created, run_id: run, job_id: "job-" + run,
      run_state: "succeeded", execution_version: 1,
    });
    const oldRun = sample("older", 100);
    const newRun = sample("newer", 200);
    mocks.recoverableDesktopTurns
      .mockResolvedValueOnce({ turns: [oldRun] })
      .mockResolvedValue({ turns: [newRun, oldRun] });
    let dispose: (() => void) | undefined;
    try {
      dispose = recoverDaemonDesktopTurns();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(1);
      expect(mocks.watchDaemonDesktopTurn.mock.calls[0][0].runId).toBe("older");
      await vi.advanceTimersByTimeAsync(5_100);
      expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(2);
      expect(mocks.watchDaemonDesktopTurn.mock.calls[1][0].runId).toBe("newer");
      // An already completed run is read back once, not on every 5s poll.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.watchDaemonDesktopTurn).toHaveBeenCalledTimes(2);
    } finally {
      dispose?.();
      vi.useRealTimers();
    }
  });
});
