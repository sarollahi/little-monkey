/**
 * Read-only reattachment of desktop chat sessions to daemon-owned turns after
 * a WebView/app restart or from a second window.
 *
 * Kept out of `agentLoop.ts` so the startup entry chunk does not carry the
 * discovery poller: `App.tsx` loads this module with a dynamic `import()`
 * once the window has mounted. Every execution decision stays in the daemon;
 * this module only discovers accepted runs and asks `agentLoop` to observe
 * them through `observeRecoveredDesktopTurn`.
 */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSessionStore } from '../store/sessionStore';
import {
  detachStaleRecoveredObserver,
  hasDesktopTurnController,
  observeRecoveredDesktopTurn,
} from './agentLoop';
import {
  loadActiveDaemonTurns,
  removeActiveDaemonTurn,
  saveActiveDaemonTurn,
  type ActiveDaemonDesktopTurn,
} from './daemonDesktopTurn';
import { durableAssistantIndex, latestRecoverableTurns, newestTurnPerSession } from './durableSessionRecovery';
import { recoverableDesktopTurns } from './ingressClient';

/** Reattach from the daemon's authoritative ingress+run records, not only from
 * the old window's localStorage. This also works when a second desktop client
 * has never seen the first client's local cursor. Discovery does not execute. */
export function recoverDaemonDesktopTurns(): () => void {
  // Per-recovery-lifetime terminal dedupe. Completed runs are discoverable
  // after an app crash, but an open window must not rewatch one every poll.
  const observedTerminals = new Set<string>();
  const ownedObservers = new Set<AbortController>();
  const observe = (link: ActiveDaemonDesktopTurn, onTerminal?: () => void) => {
    let controller: AbortController | null = null;
    controller = observeRecoveredDesktopTurn(link, onTerminal, () => {
      if (controller) ownedObservers.delete(controller);
    });
    if (controller) ownedObservers.add(controller);
  };
  let disposed = false;
  let inFlight = false;
  const attachCached = (
    awaitingAdmission: ReadonlySet<string> = new Set(),
    authoritativeSessions: ReadonlySet<string> = new Set(),
  ) => {
    // Always read the LIVE cache: it changes as observers finish, and a
    // cached snapshot captured at mount would resurrect a removed old run.
    for (const link of loadActiveDaemonTurns()) {
      if (observedTerminals.has(link.runId)) continue;
      const store = useSessionStore.getState();
      const session = store.sessions.find((session) => session.id === link.sessionId);
      if (!session) {
        removeActiveDaemonTurn(link.runId);
        continue;
      }
      if (authoritativeSessions.has(link.sessionId) || awaitingAdmission.has(link.sessionId)) continue;
      // The transcript can be edited/reordered after this cursor was saved.
      // Never trust an old numeric position to identify an assistant row.
      // A cached link may be a fallback when daemon discovery is temporarily
      // unavailable, but run ID still owns its display row.
      const foundIndex = durableAssistantIndex(session.messages, link.turnId, link.runId);
      let safeLink = link;
      if (foundIndex === null) {
        const assistantIndex = session.messages.length;
        store.addMessage(session.id, {
          role: 'assistant',
          content: 'Reconnecting to the resident runner…',
          durableTurn: { turnId: link.turnId, runId: link.runId },
        }, true);
        // The old cached output may be only a suffix of the transcript. A
        // freshly recreated row needs a complete ledger replay from zero.
        safeLink = { ...link, assistantIndex, lastSequence: 0, output: '' };
        saveActiveDaemonTurn(safeLink);
      } else if (foundIndex !== link.assistantIndex) {
        safeLink = { ...link, assistantIndex: foundIndex };
        saveActiveDaemonTurn(safeLink);
      }
      // An older cached link must not obscure a newer accepted run from
      // the authoritative store. The cache is only a safe fallback.
      observe(safeLink);
    }
  };
  if (!isTauri()) {
    attachCached();
    return () => { disposed = true; };
  }

  let retryDelayMs = 2_000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const retry = () => {
    if (disposed || retryTimer !== null) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(30_000, retryDelayMs * 2);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      discover();
    }, delay);
  };
  const discover = () => {
    if (disposed || inFlight) return;
    inFlight = true;
    void recoverableDesktopTurns().then(({ turns }) => {
      if (disposed) return;
      // Never preserve a last-discovery marker across poll cycles. Another
      // client may have accepted a newer run in the same session.
      const authoritativeSessions = new Set<string>();
      // A desktop may crash after accepting ingress but before flushing its
      // first transcript save. Recreate only a read-only display shell and
      // only in the primary window; never infer lost user instructions.
      if (getCurrentWindow().label === 'main') {
        for (const turn of turns) {
          if ((turn.source === 'desktop' || turn.source === 'voice') &&
              !useSessionStore.getState().sessions.some((s) => s.id === turn.source_account_id)) {
            useSessionStore.getState().recoverMissingDaemonSession(turn.source_account_id);
          }
        }
      }
      const sessions = useSessionStore.getState().sessions;
      const sessionIds = new Set(sessions.map((session) => session.id));
      // An accepted turn without a job ID is already durable. The daemon may
      // be recovering it right now; do not attach an older cached run instead
      // and do not submit a duplicate turn in an attempt to "resume" it.
      const awaitingAdmission = new Set(
        newestTurnPerSession(turns, sessionIds)
          .filter((turn) => turn.state === 'accepted'
            || (turn.state === 'queued' && turn.run_id === null))
          .map((turn) => turn.source_account_id),
      );

      // Newest eligible run per session; filtering by source_account_id makes
      // editor and paired-device sessions distinct unless explicitly enrolled.
      for (const turn of latestRecoverableTurns(turns, sessionIds)) {
        const session = useSessionStore.getState().sessions.find((s) => s.id === turn.source_account_id);
        if (!session || !turn.run_id ||
            authoritativeSessions.has(session.id) || observedTerminals.has(turn.run_id)) continue;
        if (hasDesktopTurnController(session.id)) {
          // A cached observer may be watching an older run. Detach it, never
          // cancel it, then retry discovery to attach the new authoritative run.
          if (detachStaleRecoveredObserver(session.id, turn.run_id)) retry();
          continue;
        }
        let assistantIndex = durableAssistantIndex(session.messages, turn.source_event_id, turn.run_id);
        if (assistantIndex === null) {
          // The daemon accepted the turn, but the UI died before persisting its
          // placeholder; create only a display row, never another model turn.
          assistantIndex = session.messages.length;
          useSessionStore.getState().addMessage(session.id, {
            role: 'assistant', content: 'Reconnecting to the resident runner…',
            durableTurn: { turnId: turn.source_event_id, runId: turn.run_id },
          }, true);
        }
        const link: ActiveDaemonDesktopTurn = {
          sessionId: session.id,
          turnId: turn.source_event_id,
          runId: turn.run_id,
          jobId: turn.job_id ?? undefined,
          assistantIndex,
          lastSequence: 0,
          output: '',
          source: turn.source === 'voice' ? 'voice' : 'desktop',
        };
        authoritativeSessions.add(session.id);
        saveActiveDaemonTurn(link);
        observe(link, () => { observedTerminals.add(turn.run_id!); });
      }
      attachCached(awaitingAdmission, authoritativeSessions);
      // An accepted-but-not-queued turn is recovered by the daemon's existing
      // ingress replay. Poll only its state; never submit a second operation.
      if (awaitingAdmission.size > 0) retry();
      else retryDelayMs = 2_000;
    }).catch((error) => {
      if (disposed) return;
      console.warn('Authoritative daemon session recovery unavailable:', error);
      attachCached();
      // A temporarily stopped daemon or unavailable sidecar must not make an
      // old cached cursor the only recovery opportunity until the next restart.
      retry();
    }).finally(() => { inFlight = false; });
  };
  // A second desktop window can admit another turn long after we started.
  // Periodic discovery is read-only, bounded by the daemon page limit, and
  // does not acquire an execution lease or resubmit any model operation.
  const interval = setInterval(discover, 5_000);
  discover();
  return () => {
    disposed = true;
    clearInterval(interval);
    if (retryTimer !== null) clearTimeout(retryTimer);
    // App/window unmount detaches these local observers; the daemon worker
    // is still running and may be watched after a fresh mount.
    for (const observer of ownedObservers) observer.abort();
    ownedObservers.clear();
  };
}
