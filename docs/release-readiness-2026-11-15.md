# Release readiness — 2026-11-15

**Decision: NOT RELEASE READY. Do not publish.**

**Signing policy:** Production publishing is blocked if Tauri updater or
Linux GPG keys/passphrase are absent. CI's unsigned candidate installer is
intentionally separate, ephemeral and not a substitute for verifying signed
published assets.

**Actual execution evidence (2026-11-16):** At commit
`06fd2c764461`, [Linux x64 candidate E2E](https://github.com/sarollahi/little-monkey/actions/runs/43827611063)
**PASSED**. The runner performed real Debian package-manager installation
(`1.12.0`), upgrade (`1.12.1`), and downgrade (`1.12.0`), and executed
the system-installed `monkey-cli` at each stage. Package versions, a
synthetic user-file canary, digest checks and exact candidate-build evidence
were captured. This is *not* a GUI or in-app updater rollback result.
The same commit's [three-OS Rust test matrix](https://github.com/sarollahi/little-monkey/actions/runs/43827611298)
**PASSED** on Linux, macOS and Windows; the overall CI remained red because
the real-browser policy test hung during cleanup, first-run fixture contracts
were failing, and RustSec advisories remained.

The failures were traced to inherited `NODE_TEST_CONTEXT` suppressing
nested TAP tests, the browser's unbounded CDP/cleanup behavior, and macOS
Bash 3.2 lacking `mapfile` in Whisper CPU-baseline verification. Fixes
are committed, but outcomes on the latest head are **pending**.

A completed [RustSec preview](https://github.com/sarollahi/little-monkey/actions/runs/43827611219)
reduced the actual audit from 13 findings to three after compatible
Quinn/vodozemac/Wasmtime updates in a disposable checkout. The exact
compatible patches were committed to this PR; see
[security blockers](security-release-blockers-2026-11-15.md).
The remaining SQLite and MCP advisories are release blockers until
resolved and tested, regardless of whether the package lifecycle passes.
The latest PR also adds detached-GPG verification for the downloaded
previous release; **that added check has not passed CI yet.**

This report reflects source inspection and unexecuted candidate checks. See
[the full acceptance matrix](release-acceptance.md). It is not updated
automatically when workflow definitions are added.

Target branch: `develop`. Audited base commit:
`5eec6de8402d7cf7be4da528c5026717bf41712b`.
Latest published release independently identified in GitHub release metadata:
`1.12.0` (2026-10-26). This work is proposed in a separate draft PR and is
not part of v1.12.0. The report is an audit and acceptance *plan*, not
manufactured execution results.

## Scope reviewed and fixes proposed

| Area | Repository evidence and conclusion | Implemented on draft branch |
| --- | --- | --- |
| Feature accuracy | README, ROADMAP, `docs/features.md`, `docs/limitations.md` describe develop, which may outrun released installers. Autonomous Tasks were discoverable indirectly; status claims require model and verification context. | Clarified develop vs tag, feature boundaries and task discovery |
| Repository links | Installation, demo/feedback and updater signing docs referenced moved `AA-Box/little-monkey`. | Updated to `sarollahi/little-monkey`. Did **not** rewrite `AA-Box/little-monkey-mobile`, which still resolves as an independent canonical repo. |
| Competitive parity | September 3 matrix across 15 products and 10 categories is stale; its Codex desktop surface and star counts lacked current validation. | Corrected current official Codex desktop scope and flagged old comparisons as September-only; **full parity matrix NOT REVALIDATED** |
| Model onboarding | Real Runtime Hub hardware probe existed; first-run model selection showed model providers but no hardware-compatibility explanation. | Surfaced actual OS/arch/supported runtimes, MLX/Metal limitation, low-memory and hardware-probe errors |
| Coding acceptance | The three-test fixture intentionally fails one whitespace test. No model success must be inferred from it. | New real-test baseline/verification tool, raw command logs, test failures, scope-limited diff, independent tab/line-break probe and schema with explicit unknowns; no fabricated metrics |
| Package selection | Release page contains six OS/arch combinations. Smoke selection used suffix without architecture filtering. | Architecture-matched selection + regression tests |
| Install smoke | A missing installer was `SKIPPED` and release job could still pass. | Required clean-install leg now fails closed; optional unsupported legs still report their reason |
| Binary integrity | Release metadata exposes SHA-256 digests; prior installation smoke exercised extraction but not GitHub asset bytes against digests. | Checks downloaded assets' exact byte length and streamed SHA-256 against draft release metadata; **not** a cryptographic signature validation |
| Upgrade and rollback | Existing install smoke uses a canary **inside a scratch installation prefix**. It does not prove OS-level upgrade/rollback preserves application-data databases, keychain, services or GUI state. | Documented as an unverified required physical gate; avoided false success claim |
| HTTP debt | `server.rs` and `m3_http_server.rs` remain adapters, while `unified_http_server.rs`, `http_policy.rs`, `http_route_registry.rs` already share lifecycle/policy components. | Compatibility-first incremental migration proposal; no risky rewrite |
| Performance | Runtime Hub and existing OS/resource benchmarks expose *real* measurement paths, but they are host-, model- and workload-specific. | Exact measurement protocol and `null` fields for anything not executed |

## Tests: evidence status

| Gate | Current report | Notes |
| --- | --- | --- |
| Source inspection of key documentation and workflow paths | REVIEWED | Static repository source inspection, not executable test |
| First-run acceptance contract (actual temporary Git fixtures) | **NOT YET VERIFIED** | CI runs `node --test scripts/first-run-acceptance.contract.test.mjs` |
| Intentionally broken first-run baseline | **NOT YET VERIFIED** | CI runs real Node fixture and uploads raw JSON; an expected failure is not model success |
| Architecture selection regressions | **NOT YET VERIFIED** | CI runs existing `pnpm test:install-smoke` |
| Asset SHA-256 regression tests | **NOT YET VERIFIED** | CI runs `node --test scripts/release-asset-integrity.test.mjs` |
| Native Rust cross-OS test matrix | **PASSED AT COMMIT 06fd2c7** | Linux, macOS, Windows job conclusions all success; later dependency patches need retest |
| Full frontend and browser CI | **FAILED AT COMMIT 06fd2c7** | Browser policy test hung; CDP cleanup is now bounded, but updated head remains unverified |
| Linux candidate package build and real Ubuntu `apt` install / upgrade / downgrade | **PASSED AT COMMIT 06fd2c7** | Actual 1.12.0 → 1.12.1 → 1.12.0 versions and installed CLI verified. New GPG check needs retest at latest SHA; not the in-app updater |
| Clean physical install on advertised OS/architectures | **UNVERIFIED** | CI Ubuntu package installation alone cannot verify the six real end-user targets |
| Real installed CLI/daemon/model coding task | **UNVERIFIED** | Opt-in self-hosted harness now records terminal run state and raw evidence; no real run submitted |
| Genuine model coding task with permissions and independent diff review | **UNVERIFIED** | Need exact model/run/driver + raw logs and human permission check |
| Real cross-version upgrade and rollback on a physical OS | **UNVERIFIED** | Release gate refuses a skipped supported upgrade; existing scratch canary alone is insufficient |
| Release signature and trust-chain verification | **UNVERIFIED** | SHA-256 against GitHub metadata does not independently authenticate publisher |
| Startup/idle RSS or PSS/first-token/task duration/cancellation cleanup | **UNVERIFIED** | No measurements fabricated |
| Physical LAN/TLS and HTTP compatibility across adapters | **UNVERIFIED** | Required for a later server migration, not rewired here |

Results are scoped to their **exact commit**. A prior passing package or
Rust test cannot certify subsequent dependency, security or signing changes.
No release-readiness claim follows merely from queued tests.

## Remaining external dependencies and physical hardware

- **macOS Intel and Apple Silicon:** physical Gatekeeper/signature,
  notarization, launch and rollback; MLX only on Apple Silicon/Metal.
- **Windows x64 and arm64:** genuine NSIS/MSI install, SmartScreen/code signing
  if configured, daemon service, keychain, in-place upgrade and rollback.
- **Linux x86_64/aarch64:** real AppImage/deb/rpm install, native WebKit/GTK,
  distro-specific libraries, headless vs Wayland/X11 portal permissions,
  user service startup and rollback.
- **Runtime/model:** actual `llama.cpp` binary, GGUF checksum and fit, Ollama
  process/model and optional provider account/network; MLX package on Metal;
  optional `sd-server`, Studio models, microphone, GPU/driver and remote
  peers are outside any current tested matrix.
- **Supply chain:** release signing credentials, GPG detached signature
  verification, SBOM quality, dependency runtime manifest from installed
  package, external catalog/mirror availability and TLS identity.
- **Benchmarks:** cold/warm app starts, idle OS memory, first-token timing,
  full verified agent task and process/resource cleanup after cancellation
  on identified physical hosts.
- **Usability:** first launch without developer tooling, permissions,
  accessibility, network failures, retry instructions and rollback UI.

## Next acceptance sequence

1. Obtain a complete passing CI run from the draft PR's **exact head commit**.
   Any failed or skipped required check blocks approval.
2. Stage candidate packages without publishing. Verify asset SHA-256,
   detached signatures, runtime manifest, SBOM and installation payload.
3. Run [release acceptance](release-acceptance.md) on clean physical hosts
   and archive exact logs. Verify installed binary version before testing.
4. Run independently recorded first-run agent tasks with both successful and
   deliberately denied permissions. Repeat cancellation and restart checks.
5. Run real upgrades and rollback and check actual user-data, DB/credentials
   and running daemon state.
6. Measure performance only on recorded real model/hardware builds, preserving
   raw samples. Review engineering-debt compatibility in a separate PR.
7. Sign off each gate; leave unmeasured or unexercised scope `UNVERIFIED`.
   Only then decide whether a release is justified.

**No release has been created or published by this work.** Publishing
is now a manually confirmed GitHub Actions workflow, restricted to the
release branch `main` and requiring a human-reviewed acceptance evidence URL.
That explicit approval is not an automatic validator of physical hardware.
