/** Pure, read-only plan for reattaching existing daemon-owned sessions.
 * The ingress store and RunLedger are the authority; this never admits work. */
import type { ChatMessage } from './llamaClient';
import type { IngressTurn } from './ingressClient';

const WATCHABLE = new Set([
  'preparing', 'queued', 'running', 'waiting_approval',
  'paused', 'cancelling', 'needs_reconciliation',
]);

/** Unknown schema versions are not reinterpreted using today's tool policy. */
export function latestRecoverableTurns(
  turns: readonly IngressTurn[],
  sessionIds: ReadonlySet<string>,
): IngressTurn[] {
  const seen = new Set<string>();
  const result: IngressTurn[] = [];
  for (const turn of [...turns].sort((a, b) =>
    b.created_at_ms - a.created_at_ms || b.ingress_id.localeCompare(a.ingress_id))) {
    if (!sessionIds.has(turn.source_account_id) || seen.has(turn.source_account_id)) continue;
    if (turn.source !== 'desktop' && turn.source !== 'voice') continue;
    if (turn.execution_version !== null && turn.execution_version !== 1) continue;
    if (turn.state !== 'queued' || !turn.run_id || !WATCHABLE.has(turn.run_state ?? '')) continue;
    seen.add(turn.source_account_id);
    result.push(turn);
  }
  return result;
}

/** Stable transcript provenance prevents duplicated assistant placeholders.
 * A human-readable model response is never used as an idempotency key. */
export function durableAssistantIndex(
  messages: readonly ChatMessage[], turnId: string, runId: string,
): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && message.durableTurn?.turnId === turnId
        && message.durableTurn.runId === runId) return index;
  }
  return null;
}
