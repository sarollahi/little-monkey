# First run: prove a coding agent can fix a bug

This is a **real, reproducible experiment**, not a pre-recorded success claim. The example has one deliberately failing test and needs no npm packages.

## Prerequisites

1. Install a signed asset for your platform from the [latest stable release](https://github.com/sarollahi/little-monkey/releases/latest). Read its release notes; this document belongs to `develop` and may include newer behavior.
2. In the first-run wizard, open **Model**. The hardware probe reads the actual Runtime Hub snapshot. Check the reported OS, architecture, runtime support, available RAM, and warnings *before* downloading weights. MLX requires Apple Silicon with working Metal; unsupported hosts should use managed llama.cpp or Ollama where supported, or a configured cloud model. A supported host does not establish that any specific model will fit memory or follow tool instructions. You can also configure a model through **Settings → Local Models**, **Settings → Ollama**, or **Settings → AI Providers**. A small general chat model may not be a reliable coding agent.
3. Install Node.js 20+ **only to run the example's tests**, and Git if you want to clone the source.

## 1. Take a disposable workspace

```sh
git clone --depth 1 --branch develop https://github.com/sarollahi/little-monkey.git
cd little-monkey/examples/first-run
node --test normalize.test.mjs
```

The initial run is expected to **fail one of three tests**. If it doesn't, verify you haven't already edited the example. Save machine-readable raw baseline evidence in a path **outside the repository**, for example:

```sh
node ../../scripts/first-run-acceptance.mjs baseline --output "$HOME/little-monkey-baseline.json"
```

This runs the actual broken test; an `EXPECTED_BASELINE_FAILURE` report is a successful baseline check, not an agent success.

## 2. Have the app work on it

Open Little Monkey and attach the `examples/first-run` folder as the workspace. Select your configured tool-capable model. Paste this objective:

> Fix normalizeUserId so repeated spaces, tabs and other whitespace between words become one hyphen. Preserve non-string rejection. Add test coverage for tabs, run `node --test normalize.test.mjs`, and report the diff and exact test outcome.

Authorize only the file edits and commands you understand and intend. The app's tool execution depends on your permission policy and configured model. Deny unexpected network or outside-workspace access.

Alternatively, if the installed release supports daemon-backed autonomous tasks, use the [CLI example](../examples/first-run/README.md#give-the-agent-the-task). Don't confuse submitting a background task with proof of completion.

## 3. Check the result without trusting the model's summary

- Run `node --test normalize.test.mjs` **outside the agent** after the run. All tests must pass.
- Inspect `git diff -- examples/first-run/normalize.mjs examples/first-run/normalize.test.mjs` from the repository root. Ensure the change is limited to the behavior requested.
- Check the app's recorded tool steps, permission decisions and test evidence. If the agent could not run tests, that is an incomplete result, not a pass.
- Record the model, runtime, OS, app release, agent attempt count, actual outcome and any setup obstacle in the [first-run feedback form](https://github.com/sarollahi/little-monkey/issues/new/choose). Avoid pasting API keys, tokens, private paths or personal code.

## 4. Capture independently verified acceptance evidence

After an agent has changed the two example files, run this from the repository root; replace the example labels with the **exact observed** model, runtime, app version, and attempt count. `BASELINE_COMMIT_SHA` is the `sourceCommit` from the baseline JSON, not necessarily your current HEAD (agents may commit their work):

```sh
node scripts/first-run-acceptance.mjs verify \
  --workspace examples/first-run \
  --base BASELINE_COMMIT_SHA \
  --model "YOUR_EXACT_MODEL_ID" \
  --runtime "YOUR_ACTUAL_RUNTIME_AND_VERSION" \
  --app-version "YOUR_INSTALLED_APP_VERSION" \
  --attempts 1 \
  --output "$HOME/little-monkey-verified.json"
```

The tool captures the real Node test output, independent whitespace probes, exact Git diff, whitespace check, changed-file scope, OS/kernel/architecture and a digest of an optionally supplied `--agent-trace` file. It **never** marks approval decisions, installation integrity, or model identity as independently verified from user-entered metadata. Manual inspection remains required. `FUNCTIONAL_PASS_MANUAL_REVIEW_REQUIRED` means the code fixture passed, **not** that the full product acceptance passed. An unchanged fixture, missing tab regression, unrelated changes or failed tests produce `FAIL` and a nonzero exit.

If model or daemon commands fail, record the full error and do not claim a successful attempt. Preserve the original recording and raw evidence outside the disposable checkout. If you retry, use a fresh clone and a fresh evidence filename; the script refuses to overwrite reports. Check `Settings → Runtime Hub → Overview` for an unsupported/absent driver, incompatible architecture, missing Metal, or insufficient RAM; check `Settings → Background Agents` if a daemon task never starts. A provider requiring a network connection or API credentials is not an offline setup.

## 5. Run the full installed CLI → daemon → real model → Git oracle

On an operator-controlled **Linux acceptance machine**, with the actual
Little Monkey release/candidate installed, CLI and resident daemon working,
and a model configured (with any required credentials), run:

```sh
pnpm test:first-run:live -- \
  --target "ollama:YOUR_EXACT_INSTALLED_MODEL" \
  --runtime "ollama VERSION / model DIGEST" \
  --app-version "EXACT_INSTALLED_APP_VERSION" \
  --timeout-seconds 900 \
  --evidence-dir "$HOME/lm-acceptance-$(date +%Y%m%d-%H%M%S)"
```

This copies the deliberately broken fixture into a new Git repository, records
the actual failing baseline and its commit SHA, obtains the **installed CLI's**
version, submits `monkey task start`, follows its actual JSONL event stream,
checks `monkey task status` for the **authoritative terminal `succeeded`**
state, and calls the independent verification oracle against the original
commit. It preserves the real stdout/stderr from every CLI command, the
post-run Git patch, result JSON, attempts and the measured task wall time.
If the run errors or times out, it requests cancellation of only its own
run and records the failure. A real `model_delta` event with nonempty text also allows
**first-token latency** to be measured from its persisted event timestamp
minus the persisted `started` timestamp. This is an *event-based daemon
metric*, not a claimed UI-render or network TTFT. When no such event exists,
first-token latency remains `null`; no timing is inferred from simulated
fixtures. Startup, idle memory and cancellation-cleanup metrics remain null
until separately measured.

This is a **real-model** workflow, never used in default hosted CI. It can
also be launched with the manually triggered
[First-run real-model acceptance](../.github/workflows/first-run-live-e2e.yml)
workflow, but only after a compatible, authenticated self-hosted runner is
provisioned. The workflow stores raw traces on that runner; only the summary
is uploaded by default. Check the trace for sensitive values before sharing.
Neither result alone proves GUI permission prompts, package signatures or
other hardware configurations.

Offline CI also runs a **simulated CLI contract** to test that this harness
rejects a failed daemon status and unrelated edits; that contract is never
reported as real-model evidence.

## 6. What this proves — and what it does not

A passing attempt demonstrates one bounded coding task on one configured machine and model. It does not prove autonomous recovery, universal security, superior benchmark quality, or any success rate across other tasks. The [limitations](limitations.md) and [live acceptance instructions](autonomous-tasks.md) distinguish these claims.

For a genuine screenshot or recording, see the [demo publishing protocol](adoption.md#publish-a-real-demo-not-a-mockup).
