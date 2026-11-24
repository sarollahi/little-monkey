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
5. Run the independent `verify` subcommand described in [First run](first-run.md), or run the complete opt-in installed-CLI live harness on a model-capable host.
   It must record a functional pass with a scope-limited Git diff, new tab
   regression, zero test failures and independent whitespace probes. Inspect
   the permission trace yourself; JSON labels do not verify the model identity.
6. Preserve the full, unedited console output, Git patch and evidence JSON.
   If the run failed, cancelled, or required a retry, label it accurately.

## Exact main commit CI requirement

The manually approved production Release workflow now queries GitHub Actions
using the **exact `GITHUB_SHA` of the `main` branch checkout**. It refuses
to build when no completed successful full `CI` workflow of event `push`
exists for that SHA. A passing pull-request head (or older main commit) does
not authorize publishing a new merge commit. If the latest matching CI is
queued, failed, or cancelled, preflight fails closed. Required security,
installer, hardware, signing, and human acceptance checks are additional
gates and are not waived by this check.

## Release signer continuity

The Linux signer fingerprint stored in
[`scripts/release-trust-pins.json`](../scripts/release-trust-pins.json) was
observed and cryptographically validated against the actual published
v1.12.0 Debian detached signature. The candidate upgrade runner now compares
the downloaded previous release's public key to this pinned fingerprint
*before* accepting its signature; the production Linux signing job refuses
to sign with any different private key. A deliberate rotation requires a
separately reviewed change to the pin.

This binds releases to an **existing signing-key lineage**. It does *not*
provide independently verified personal or organizational ownership of
that key, nor does it replace an OS code-signature or provenance check.

## macOS trust verification

The production release now fails early if Apple Developer ID certificate,
identity, account, team or notarization credentials are missing. After the
actual macOS Tauri build, both Intel and Apple Silicon jobs inspect the
bundled `.app`, verify its code signature, assert a Developer ID Application
authority and the configured team ID, and require a successful macOS
Gatekeeper `spctl --assess`. This is a real CI trust check for the built
artifact, not a substitute for installation on a clean user's Mac.

Windows Authenticode signing, SmartScreen reputation and actual installer
trust on clean Windows machines remain manual acceptance requirements.
Do not imply that Tauri's updater signature is a Windows OS code signature.

## Final draft publication gate

Before `release.yml` makes a draft public, it now fetches that exact draft's
GitHub asset metadata and runs `scripts/release-manifest-gate.mjs`. This checks
all six installer families, macOS signed updater archives, Windows and Linux
updater signatures, Linux detached signatures, `latest.json`, the GPG key,
SBOM and IDE plugins, with nonempty assets and SHA-256 digest fields. The
expected matrix is tested against the real v1.12.0 release's format. The
gate does **not** itself validate signing-key identity, Apple notarization,
OS code signatures, or the bytes of every artifact; those still require
independent integrity checks and the human acceptance report.

## Execution results recorded on 2026-11-16

At commit `06fd2c764461`, the real [Linux x64 candidate package job](https://github.com/sarollahi/little-monkey/actions/runs/43827611063)
passed an actual **1.12.0 → 1.12.1 → 1.12.0** apt lifecycle and system
CLI version checks. It also retained the synthetic file and source/manifest
evidence. It did not run user-database migrations, GUI onboarding or Tauri's
in-app updater. Subsequent commits introduce the previous release's detached
GPG verification and patched Rust dependencies, so the latest candidate
must pass again before publication.

Every RustSec vulnerability in the lockfile is now remediated by dependency
upgrades (see [Security register](security-release-blockers-2026-11-15.md));
`cargo audit` reports zero vulnerabilities. The upgraded dependencies must
still pass the latest Rust/native/installer matrices before publication.

## Available execution paths

An earlier real CI run for commit `440a1969` on November 15, 2026 found
failing source-level acceptance checks (canonical link scan, Rust daemon
CLI location), a candidate Debian bundle signing failure, and 13 current
RustSec vulnerabilities. Later commits address all four, but **the updated
workflows must complete successfully before accepting these fixes**. The
vulnerability register and the upgrades that resolved it are in
[Security register](security-release-blockers-2026-11-15.md).

The Linux candidate workflow now uses a **next-patch, unpublished test
version** across Tauri, Cargo, lockfile and the CLI, so its selected older
installer can be the actual latest published release. This version exists
only inside the disposable runner. It is neither a production tag nor an
app-signed updater artifact.


- [Linux candidate installer E2E](../.github/workflows/linux-candidate-package-e2e.yml)
  builds a real unsigned x64 `.deb` on a temporary Ubuntu runner, checks
  runtime manifests, runs installer payload and CLI smoke checks, downloads
  and SHA-256-checks the newest published *older* x64 Debian installer,
  installs that version through `apt`, upgrades through the same package
  manager to the candidate, and downgrades through `apt` as a rollback
  exercise. The actual packaged CLI is installed at `/usr/bin/monkey-cli`,
  as verified from the failed prior candidate's real `.deb` file manifest;
  the smoke tests now execute that binary instead of assuming a `monkey`
  filename. A canary validates basic file retention, **not** app-database
  migration. This does not exercise the signed in-app updater's rollback
  script or a graphical first run, and it does not publish to GitHub Releases.
- [Real-model first-run](../.github/workflows/first-run-live-e2e.yml) is
  **manual-only** on a provisioned self-hosted runner; it invokes the installed
  daemon and configured target, stores actual events and checks the terminal
  run state plus independent code changes. It is not exercised by ordinary CI.
- The existing `release.yml` no longer runs on every push to `main`.
  It now requires manual `workflow_dispatch`, an explicit publish approval,
  a reviewed evidence URL and selection of the `main` branch. The URL is
  an operator attestation, not automated proof of the checks it links to.

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
