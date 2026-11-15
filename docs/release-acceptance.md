# Release acceptance protocol

Applies to the next release candidate built from `develop`. A green source CI
run is **necessary but not sufficient**. Do not publish until the required
installed-app, model, package, upgrade, security, and regression checks below
have been performed on real target hosts and have attached evidence. Work
only with disposable test workspaces and identities.

## Reproduce the functional coding task

1. Record the release candidate commit SHA and build artifact filename/SHA-256.
   Identify OS, kernel, CPU architecture, installed GPU/driver and free memory.
2. Install the specific artifact on a clean host. Record whether OS-level
   signing/notarization, launch, CLI sidecar version, Runtime Hub driver probe
   and first-run wizard work. The presence of an artifact alone is not a pass.
3. Clone the intended commit to a **disposable** working tree. Use
   `node scripts/first-run-acceptance.mjs baseline --output OUTSIDE_REPO.json`.
   Expect `EXPECTED_BASELINE_FAILURE` and preserve its raw TAP output.
4. Choose and record the exact model ID, weights digest when known, local or
   cloud provider, quantization, runtime/build and permission mode. Capture a
   **real app/daemon run**, approvals granted/denied, trace and attempt count.
5. Run the independent `verify` subcommand described in [First run](first-run.md).
   It must record a functional pass with a scope-limited Git diff, new tab
   regression, zero test failures and independent whitespace probes. Inspect
   the permission trace yourself; JSON labels do not verify the model identity.
6. Preserve the full, unedited console output, Git patch and evidence JSON.
   If the run failed, cancelled, or required a retry, label it accurately.

## Candidate gates and what counts as evidence

| Check | Required real evidence | Reject |
| --- | --- | --- |
| Frontend and Rust | Successful branch-specific build/typecheck, UI and native tests on three target OSes | Failed, skipped or stale build |
| Package integrity | Actual SHA-256 and size matching release metadata; valid runtime manifests/SBOM; cryptographic signatures independently verified where published | Missing bytes, invalid manifests/signature, unsigned when policy requires |
| Clean installation | Fresh host launch, working app and bundled CLI, Tauri and OS-specific dependency checks on every advertised architecture | Only a decompressed payload or smoke-test unit test |
| Upgrade and rollback | Real install prior version → candidate, app-data preservation, update and rollback launch, process and keychain state checked | Canary in test install prefix alone |
| Onboarding | Actual hardware/driver availability or actionable unsupported warning; model configured, permissions visible | Assumption based on browser user agent alone |
| Coding task | Model/daemon completed fixture, exact raw transcript, real commands, correct limited diff, independent rerun | Agent self-report, mocked model, or missing trace |
| Cancellation | Cancel a running model/tool task, inspect process tree and resource ledger, verify no runaway children or lingering port | Only unit-test cancellation state |
| Security | Unauthorized API exposure, TLS/pairing scope, shell/workspace grants and release signing verified on host | Green CI without negative tests |
| Platform/accessibility | Installer launch, updater, clipboard and accessibility/screen-grant behavior by host OS | Only jsdom lint / headless policy |
| Performance | Actual app startup, idle memory, first-token latency, agent task runtime and cancellation cleanup, with samples and provenance | Estimated, fabricated, or reused numbers |

**Scope:** Linux x86_64/aarch64, macOS Intel/Apple Silicon, Windows x64/arm64
are advertised bundle targets. An Ubuntu x64 hosted CI runner cannot certify
the other five installation paths. Model/driver-specific hardware paths also
require real supported GPU/OS combinations; external services need actual
credentials/availability but must never be recorded publicly.

## Performance recording (no estimated values)

Capture each trial on the same identified candidate build and host:

- Startup: monotonic timer from launching the installed app to usable composer
  and responsive daemon. Report cold/warm state, count, median and raw samples.
- Idle memory: collect OS RSS/PSS where available for the app, daemon,
  managed runtime and child processes after a documented idle stabilization.
  Specify what the sample includes and shared-memory counting limits.
- First-token: monotonic duration from a **sent actual model request** to
  the first streamed token. Record local/cloud, model digest/version, prompt,
  warmup/cache state and network when relevant. Never use whole response time
  as first-token latency.
- Agent task: record objective submission to final verified completion,
  including permissions, queue wait and retries. Preserve the raw trace.
- Cancellation cleanup: record cancellation timestamp, observed termination
  of owned PID tree and disappearance of bound resources, plus final ledger
  state; mark escaped/unknown descendants as failures, not zeros.

At least three actual trials per scenario are useful to expose variance;
do not make a universal quality claim from a single fixture. Use the existing
[headless resource harness](headless-resource-benchmark.md), Runtime Hub's
hardware-backed Benchmark, and real OS process sampling where applicable.
They are **different experiments**, so don't combine their numbers unless
definitions/hardware match. A field that wasn't measured is `null`/`UNVERIFIED`.

## Real-demo recording checklist

- Show exact installed app and asset version, OS/hardware and model/runtime ID
  on screen, obscuring credentials and identifiable paths.
- Film the actual **failing baseline test** with its command and full result.
- Film model selection, permission prompts, user decisions and tool commands.
- Show actual edits, Git diff, new regression and passing independent test run.
- Show the raw evidence JSON and disclose retries/failures. Keep recording
  continuous; if edited for privacy, identify cuts.
- Save the original capture and checksums privately, publish only redacted
  footage with the release tag, model ID, environment, number of attempts and
  limitations clearly stated.
- No generated UI, composited mock terminal, synthetic timing or claimed
  success ratio qualifies as acceptance evidence.

## Release decision

Write a signed-off gate matrix containing status `PASS`, `FAIL` or
`UNVERIFIED`, relevant OS/model/runtime, exact artifact, run links and
recorded output. An `UNVERIFIED` result is not a `PASS`; report it as a
blocker if that platform/requirement is in release scope. Record exceptions
only with explicit scope reduction and rationale.

The [readiness report](release-readiness-2026-11-15.md) starts with unverified
live checks. Source CI and contract tests cannot auto-promote them to passes.
