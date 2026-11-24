# HTTP adapter consolidation: compatibility-first migration

Status: proposed, **not** a release-blocking rewrite. Reviewed against
`src-tauri/src/server.rs`, `m3_http_server.rs`,
`unified_http_server.rs`, `http_route_registry.rs`, and `http_policy.rs`.

## Current shape

The release debt is **two route/request adapters**, not two independent
endpoint lifecycle controllers. `unified_http_server.rs` already defines
the shared endpoint plan, serialized reconciliation, generation owner and
one admission domain for primary loopback and optional TLS/LAN sockets.
`m3_http_server.rs` documents the transport-free `M3HttpRequestService`
compatibility adapter. The primary adapter still has legacy protocol
handling and its external clients must not be broken by an aggressive
collapse. Both use route classification and HTTP policy contracts.

A duplicate-looking check is **not** automatically safe to remove:
primary loopback and LAN/TLS have different authentication, pairing and
exposure semantics. Model lifecycle, streaming and the route family's
accepted error envelopes must remain compatible.

## Incremental plan

1. **Capture existing public behavior first.** Build a route table from
   `http_route_registry.rs` with primary vs policy socket visibility,
   method, path, auth scope, CORS, rate limit, body cap, streaming, cancellation
   and typed error status. Run the existing compatibility harness over both
   listeners, including denied and malformed requests. Do not infer API
   compatibility from a type-level contract only.
2. **Keep one authority per policy.** When two handlers duplicate an identical
   decision, move it into the existing `http_policy.rs` or route registry
   with call-site-specific `ListenerExposure` and principal context. Add
   paired positive, negative and unauthorized tests before changing either
   handler. Do not merge the different policy families.
3. **Migrate one protocol family per PR.** Delegate request classification to
   the shared registry; retain public route, socket, headers, SSE event shape,
   and streamed cancellation boundaries. Run the exact same conformance cases
   against old/new adapter via a feature-flagged test harness.
4. **Separate transport after parity.** Consolidate duplicate bind/listen/body
   plumbing only when both protocol adapters are verified on loopback and
   authenticated TLS/LAN. Preserve the unified generation lifecycle.
5. **Decommission with evidence.** Remove legacy paths only after backwards
   compatibility tests pass, consumers are migrated, and release notes name
   any intentionally retired behavior.

## Required before changing a handler

- OpenAI-compatible chat and streaming; Anthropic subset; native Ollama
  supported routes; 400/401/403/404/429/503 differences; health and cancellation.
- No additional workspace, shell, file, Git, MCP or agent routes exposed on
  the policy listener.
- Exact TLS/identity, scoped token, pairing, CORS and loopback defaults.
- Active request admission, cleanup on disconnect/cancellation, and restart.
- Linux, macOS and Windows transport tests, plus a real LAN/TLS peer.
- Negative regression checks: unknown route, bad token, oversized request,
  malformed streaming input, exhausted permits, interrupted stream.

The migration is **unverified** until these real listener tests pass. This
release-readiness branch intentionally does not rewrite the servers.
