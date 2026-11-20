import assert from "node:assert/strict";
import { test } from "node:test";
import { metricsFromEventJsonl } from "./firstRunEventMetrics.mjs";

const event = (seq, ts, type, text, run_id = "owned-run") =>
  JSON.stringify({
    run_id, sequence: seq, occurred_at_ms: ts,
    event: { type, payload: text === undefined ? {} : { text } },
  });

test("only actual nonempty model_delta after started yields first token latency", () => {
  const raw = [
    event(1, 1000, "queued"),
    event(2, 1200, "started"),
    event(3, 1250, "tool_proposed"),
    event(4, 1540, "model_delta", ""),
    event(5, 1800, "model_delta", "hello"),
  ].join("\n");
  const result = metricsFromEventJsonl(raw, "owned-run");
  assert.equal(result.eventCount, 5);
  assert.equal(result.firstTokenMs, 600);
  assert.match(result.firstTokenEvidence, /Persisted daemon/);
});

test("never fabricates first token for a real run with no model text events", () => {
  const result = metricsFromEventJsonl([event(1, 1000, "queued"), event(2, 1100, "started")].join("\n"), "owned-run");
  assert.equal(result.firstTokenMs, null);
  assert.match(result.firstTokenEvidence, /UNMEASURED/);
});

test("fail closed for inconsistent run IDs, out-of-order events and invalid timestamps", () => {
  assert.throws(() => metricsFromEventJsonl(event(1, 1000, "started", undefined, "foreign"), "owned-run"), /Invalid or cross-run/);
  assert.throws(() => metricsFromEventJsonl([event(2, 1000, "started"), event(1, 1200, "model_delta", "token")].join("\n"), "owned-run"), /Invalid or cross-run/);
  assert.throws(() => metricsFromEventJsonl(event(1, 1000, "model_delta", "token"), "owned-run"), /preceded/);
  assert.throws(() => metricsFromEventJsonl([event(1, 2000, "started"), event(2, 1500, "model_delta", "token")].join("\n"), "owned-run"), /preceded/);
  assert.throws(() => metricsFromEventJsonl("not json", "owned-run"), /Non-JSON/);
  assert.throws(() => metricsFromEventJsonl("", "owned-run"), /No durable/);
});
