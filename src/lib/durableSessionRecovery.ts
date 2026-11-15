/** Pure, read-only plan for reattaching existing daemon-owned sessions.
 * The ingress store and RunLedger are the authority; this never admits work. */
import type { ChatMessage } from './llamaClient';
import type { IngressTurn } from './ingressClient';

const WATCHABLE = new Set([
  'preparing', 'queued', 'running', 'waiting_approval',
  'paused', 'cancelling', 'needs_reconciliation',
]);

/** The most recent admitted identity wins, even if it is still accepted and
 * has no daemon job. An older run must never masquerade as its replacement. */
export function newestTurnPerSession(
  turns: readonly IngressTurn[],
  sessionIds: ReadonlySet<string>,
): IngressTurn[] {
  const seen = new Set<string>();
  const result: IngressTurn[] = [];
  for (const turn of [...turns].sort((a, b) =>
    b.created_at_ms - a.created_at_ms || b.ingress_id.localeCompare(a.ingress_id))) {
    if (!sessionIds.has(turn.source_account_id) || seen.has(turn.source_account_id)) continue;
    if (turn.source !== 'desktop' && turn.source !== 'voice') continue;
    seen.add(turn.source_account_id);
    result.push(turn);
  }
  return result;
}

/** Unknown schema versions are not reinterpreted using today's tool policy. */
export function latestRecoverableTurns(
  turns: readonly IngressTurn[],
  sessionIds: ReadonlySet<string>,
): IngressTurn[] {
  return newestTurnPerSession(turns, sessionIds).filter((turn) =>
    (turn.execution_version === null || turn.execution_version === 1) &&
    turn.state === 'queued' &&
    turn.run_id !== null &&
    WATCHABLE.has(turn.run_state ?? ''),
  );
}

/** Stable transcript provenance prevents duplicated assistant placeholders.
 * A human-readable model response is never used as an idempotency key. */
export function durableAssistantIndex(
  messages: readonly ChatMessage[], turnId: string, runId: string,
): number | null {
  void turnId; // Kept in the public signature for original-turn provenance.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    // A durable mutation-correction continuation can share the original
    // transcript row but have its own source event ID. Run IDs are globally
    // unique and are the stable projection identity; match that first.
    if (message.role === 'assistant' && message.durableTurn?.runId === runId) return index;
  }
  return null;
}
