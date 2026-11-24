/**
 * Derive only values that actually exist in durable daemon event records.
 * An attach transcript is NOT wall-clock model timing unless it carries the
 * authoritative persisted started / model_delta timestamps from that run.
 */
export function metricsFromEventJsonl(raw, runId) {
  if (typeof runId !== "string" || !runId) throw new Error("A real run ID is required");
  if (typeof raw !== "string") throw new Error("The actual event stream is required");
  let startedMs = null;
  let firstDeltaMs = null;
  let lastSequence = 0;
  let eventCount = 0;
  for (const row of raw.split(/\r?\n/)) {
    if (!row.trim()) continue;
    let event;
    try { event = JSON.parse(row); }
    catch { throw new Error("Non-JSON output in durable event stream; cannot authenticate metrics"); }
    if (!event || typeof event !== "object" || event.run_id !== runId ||
        !Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence ||
        !Number.isSafeInteger(event.occurred_at_ms) || event.occurred_at_ms <= 0 ||
        !event.event || typeof event.event !== "object") {
      throw new Error("Invalid or cross-run durable event; metrics refused");
    }
    lastSequence = event.sequence;
    eventCount++;
    if (event.event.type === "started" && startedMs === null) startedMs = event.occurred_at_ms;
    if (event.event.type === "model_delta" &&
        typeof event.event.payload?.text === "string" &&
        event.event.payload.text.length > 0 && firstDeltaMs === null) {
      firstDeltaMs = event.occurred_at_ms;
    }
  }
  if (eventCount === 0) throw new Error("No durable events; metrics refused");
  if (firstDeltaMs !== null && (startedMs === null || firstDeltaMs < startedMs)) {
    throw new Error("Model token preceded authoritative run start; timing refused");
  }
  return {
    eventCount,
    firstTokenMs: firstDeltaMs === null ? null : firstDeltaMs - startedMs,
    firstTokenEvidence: firstDeltaMs === null
      ? "UNMEASURED: no non-empty model_delta event"
      : "Persisted daemon event timestamps: first non-empty model_delta minus started",
  };
}
