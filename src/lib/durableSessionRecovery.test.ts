import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './llamaClient';
import { toWireMessages } from './llamaClient';
import type { IngressTurn } from './ingressClient';
import { durableAssistantIndex, latestRecoverableTurns, newestTurnPerSession } from './durableSessionRecovery';

const turn = (overrides: Partial<IngressTurn>): IngressTurn => ({
  ingress_id: 'ingress-1', source: 'desktop', source_account_id: 'session-a',
  account_label: null, source_event_id: 'turn-1', session_key: 'desktop:session-a',
  state: 'queued', attempts: 0, last_error: null, execution_version: 1,
  execution_digest: 'hash', mutation_required: false, mutation_state: null,
  mutation_detail: null, parent_ingress_id: null, continuation_kind: null,
  continuation_attempt: 0, job_id: 'job-1', run_id: 'run-1', run_state: 'running',
  run_error: null, created_at_ms: 100, updated_at_ms: 100,
  ...overrides,
});

describe('authoritative session recovery selection', () => {
  it('reattaches exactly one newest nonterminal turn per known session', () => {
    const turns = [
      turn({ ingress_id: 'older', run_id: 'run-old', created_at_ms: 50 }),
      turn({ ingress_id: 'newer', run_id: 'run-new', created_at_ms: 150 }),
      turn({ ingress_id: 'other', source_account_id: 'session-b', created_at_ms: 180 }),
      turn({ ingress_id: 'editor', source_account_id: 'editor:session-a', created_at_ms: 200 }),
      turn({ ingress_id: 'mobile', source: 'mobile', created_at_ms: 250 }),
    ];
    expect(latestRecoverableTurns(turns, new Set(['session-a','session-b']))
      .map(v => v.ingress_id)).toEqual(['other','newer']);
  });

  it('reattaches recently completed runs if the UI died before seeing completion', () => {
    const ids = new Set(['session-a']);
    const succeeded = turn({
      ingress_id: 'completed-after-desktop-crash',
      created_at_ms: 300,
      state: 'queued',
      run_id: 'run-final',
      run_state: 'succeeded',
    });
    expect(latestRecoverableTurns([succeeded], ids)).toEqual([succeeded]);
  });

  it('does not attach a stale run while a newer turn awaits durable admission', () => {
    const ids = new Set(['session-a']);
    const turns = [
      turn({ ingress_id: 'older-running', created_at_ms: 100,
        run_id: 'old-run', run_state: 'running' }),
      turn({ ingress_id: 'newly-accepted', created_at_ms: 200,
        state: 'accepted', run_id: null, job_id: null, run_state: null }),
    ];
    expect(newestTurnPerSession(turns, ids)[0].ingress_id).toBe('newly-accepted');
    expect(latestRecoverableTurns(turns, ids)).toEqual([]);
  });

  it('refuses unknown schemas, terminal outcomes, unqueued work and unknown run states', () => {
    const candidates = [
      turn({ ingress_id: 'v99', execution_version: 99 }),
      turn({ ingress_id: 'done', run_state: 'succeeded' }),
      turn({ ingress_id: 'failed', run_state: 'failed' }),
      turn({ ingress_id: 'not-admitted', state: 'accepted', job_id: null, run_id: null }),
      turn({ ingress_id: 'future-state', run_state: 'restarted_on_other_node' }),
    ];
    expect(latestRecoverableTurns(candidates,new Set(['session-a']))).toEqual([]);
    expect(latestRecoverableTurns([
      turn({ ingress_id: 'ambiguous', run_state: 'needs_reconciliation' }),
    ],new Set(['session-a']))[0].ingress_id).toBe('ambiguous');
  });

  it('requires exact stored provenance; never deduplicates using displayed content', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'reconnect' },
      { role: 'assistant', content: 'Reconnecting to the resident runner…' },
      { role: 'assistant', content: 'generation in progress',
        durableTurn: { turnId: 'turn-1', runId: 'run-1' } },
      { role: 'assistant', content: 'same turn different job',
        durableTurn: { turnId: 'turn-1', runId: 'run-2' } },
    ];
    expect(durableAssistantIndex(history,'turn-1','run-1')).toBe(2);
    expect(durableAssistantIndex(history,'turn-1','run-2')).toBe(3);
    expect(durableAssistantIndex(history,'turn-2','run-1')).toBe(2);
    expect(durableAssistantIndex(history,'turn-1','run-3')).toBeNull();
  });

  it('never sends local durable run IDs as model message attributes', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: 'hello',
      durableTurn: { turnId: 'turn-1', runId: 'run-secret' } }];
    expect(toWireMessages(history)).toEqual([{ role: 'assistant', content: 'hello' }]);
  });
});
