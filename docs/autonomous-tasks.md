# Universal Autonomous Tasks

The Autonomous Task panel and `monkey task` commands run one objective through a bounded coordinator. A task freezes its model target, workspace roots, permission policy, and budgets at creation. The coordinator creates a validated DAG, selects a direct, planned, delegated, or parallel-delegated strategy, schedules independent worktree workers, integrates patches serially, runs configured verification, performs a diff review, and records acceptance evidence before delivery.

Every coordinator transition is a `task_event` in the hash-chained run ledger. Events carry a replayable task snapshot, so restart and CLI attachment do not depend on React state. The Rust protocol validates task identifiers, event names, and payload size; the ledger projects the event without interpreting task-specific business state.

Execution placement is an executor concern layered around this coordinator.
Select Automatic or a configured target in the task panel; the selected target
identity and workspace transfer are frozen into each placed `RunSpec`. The
workspace is provisioned on the executor and remote results are represented as
reviewable artifacts. See [Execution targets](execution-targets.md) for Docker,
SSH, transfer, conflict, and trust details.

## CLI

```text
monkey task start "objective" --target ollama:model [--workspace path] --json
monkey task status [--run-id id] --json
monkey task attach id [--follow] --json
monkey task guide id "new constraint"
monkey task pause id
monkey task resume id
monkey task cancel id
```

CLI control operations append to the same durable run stream. `start` is queued with a read/write workspace grant and network/external mutations disabled by default; delivery still requires the relevant repository policy and explicit confirmation.

## Safety and recovery

External issue text is marked untrusted in worker prompts. Workers receive immutable snapshots and cannot expand roots, permissions, target, or budgets. Parallel mutation nodes require disjoint scopes and managed worktrees; integration is sequential and leaves conflicts visible. Cancellation preserves artifacts, verification evidence is staleable, and incomplete or non-authoritatively verified work is never reported as success.

The desktop coordinator reattaches to non-terminal snapshots after restart; in-flight nodes are recovered as pending and completed worktree metadata is reused for integration. CLI `task start` submits an immutable recipe to the resident daemon, which supervises the headless task process; `task attach` reads the shared ledger and control commands append to it.

Issue-to-PR uses the same bounded plan and authoritative repository-check contract through `runIssueToPrAutonomousTask`. Its owned worktree is deliberately not applied to the shared checkout, and GitHub delivery/merge remain outside the worker behind the existing confirmation workflow. A task with no configured verification command remains `WAITING_USER`; a worker report or ordinary review prose cannot satisfy acceptance evidence.

## Autonomous coding evaluation

The routing corpus in `src/lib/autonomousTaskEval.ts` remains a fast deterministic unit gate for `DIRECT`, `PLAN`, `DELEGATE`, and `PARALLEL_DELEGATE` selection. It is deliberately labelled as routing-only and is not evidence of repository mutation or model quality.

The acceptance evaluator is `src/lib/autonomousTaskEval.e2e.test.ts`. It executes the production `runAutonomousTask` coordinator against a new Git repository for each of the fifteen autonomous-coding acceptance classes:

1. one-file bug
2. multi-module bug
3. feature plus tests
4. frontend/backend parallel change
5. independent exploration
6. conflicting worker edits
7. verification failure requiring repair
8. misleading issue description
9. issue prompt injection
10. GitHub issue to the external-delivery approval boundary
11. interruption and resume
12. daemon handoff snapshot and continuation
13. generic remote worker placement
14. worker crash and bounded repair
15. budget exhaustion

The fixtures make actual working-tree changes and run deterministic repository verification. The scorer records acceptance-criteria pass rate, verification success, unnecessary or unrelated mutations, human interventions, worker count, redundant worker work, model-call accounting, cost accounting, wall time, permission violations, and false completion claims. A fixture cannot pass when a successful outcome lacks authoritative, non-stale acceptance evidence. The normal `pnpm test` CI run includes this suite; `pnpm test:autonomous-eval` is the focused gate.

That deterministic suite proves coordinator behavior without spending provider tokens. It does **not** pretend its deterministic runtime is a language model. For the actual model/tool/repository path, run:

```text
pnpm test:autonomous-eval:live -- --target ollama:<model>
# or: --target provider:<provider>/<model>
```

`scripts/autonomous-task-live-eval.mjs` creates a fresh broken Git repository, proves the baseline test fails, invokes the real `monkey task start` command with the selected model target, follows the durable run with `monkey task attach --follow`, then independently reruns the repository test and rejects changes to the protected test/instructions files. This is the model-facing acceptance probe; it requires a configured target and the normal resident-daemon/runtime prerequisites. Credential-free CI does not claim to have run it.

Cross-process daemon and execution-target behavior is additionally covered by the Rust autonomous handoff and real Docker/runner E2E gates. Those tests remain separate because process ownership, runner recovery, and container transport cannot be proven by a TypeScript in-process fixture.

## Issue-to-draft-PR CI verification and bounded repair

The existing Issue-to-PR panel and Universal Autonomous Task coordinator share
the owned Git worktree and `m5_delivery` approval boundary. The issue-specific
coordinator uses the validated deterministic DAG and the actual owned-worktree
headless coding agent; it disables the independent unmetered default planner
that would otherwise run in the primary workspace. The model's code
investigation, mutations and reviewer calls are all charged against the same
persisted issue budget. Starting an issue
requires an authenticated `gh` and a primary Git workspace whose GitHub
remote matches the requested repository. The issue title, body, comments,
review threads, and CI failure descriptions are **untrusted data**; none can
expand the frozen workspace, permission scope, or mutation policy.

The run targets the **actual named base branch** from the workspace, not a
hard-coded `main`. Implementation stays inside the app-owned worktree.
Configured repository `test`, `lint`, `typecheck`, and `build` scripts
run through the existing verification command runner, with an inspected
worktree fingerprint before and after verification. **No test scripts is
not a pass**. The coordinator requires independent, non-mutating diff review
with complete file coverage before the app enables Git delivery. For
surviving changed files, coverage requires an actual successful `read_file`
result from the read-only reviewer, not just the model's own
`filesReviewed` claim. Deleted files remain reviewable from the diff.
Missing tool evidence, truncated or oversized diffs, and changed revisions
fail closed. Results, failed checks, review evidence, and the durable task link remain inspectable
from the issue panel/run ledger.

Git delivery is deliberately not autonomous: the issue coordinator
completes the local verified worktree and hands it to exactly one native
`m5_delivery` approval flow. Each owned-worktree commit, push, and draft
PR creation/update requires a separately previewed, typed confirmation. Edits on a previously pushed draft PR are
committed on the same owned branch and the existing PR is updated, never
replaced or force-pushed. An ambiguous Git state fails closed.

After the operator approves delivery, the panel polls GitHub's real
`statusCheckRollup` every 30 seconds. Observations are persisted by exact
PR head commit, deduplicated against repeated polls, and exposed in the
nine-stage timeline. A green CI rollup must remain unchanged across two
observations at least 30 seconds apart before it can become Ready; another
workflow's late-arriving check invalidates the settling window. Missing checks, pending checks, unsuccessful checks,
stale SHA responses, and changed PR ownership cannot be reported as ready.
Failed checks feed a bounded repair through the existing autonomous task
coordinator; after an independent review and new authoritative local checks,
the operator must separately approve the new commit/push/update before CI
is observed again. The default is **two repair attempts**; the operator can
freeze a 0–5 limit before starting. For this workflow the single persisted
issue counter owns all retries: internal autonomous-task repair retries are
disabled to prevent violating the configured limit. The operator also freezes
a **per-agent wall-clock ceiling** (default 30 minutes) and a **total provider-
reported token ceiling** (default 250,000) across implementation, review, and
repair. Each model response is charged before tools execute; providers without
metered token usage fail closed. Token-event idempotency survives app restarts.

Issue titles, descriptions, GitHub issue comments, review threads, and Actions
logs are marked untrusted. The implementation agent's tools are bound to the
owned-worktree root; the reviewer uses a read-only tool profile. Local test
success does not authorize delivery by itself. The reviewer must inspect every
changed file without changing the workspace, and the backend stores a
reviewed-diff fingerprint plus covered files. The preview refuses a stale
review fingerprint. A client cannot self-report `ready`; only GitHub
observations of the matching owned draft PR head can establish readiness. Persisted attempts and CI evidence survive
desktop restarts; a repair started before a crash is not counted twice.
Verification processes are fenced by a persisted generation counter so
cancelled or superseded checks cannot overwrite a newer state. PR identity
is checked against live GitHub draft status, origin ownership, canonical
URL, frozen base and exact owned branch SHA before CI monitoring begins.

The timeline ends at **Ready**, which is a human publication boundary.
There is no automatic merge, force-push, PR ready-for-review mutation, or
review-thread resolution.

### Deterministic acceptance and external prerequisites

```sh
node --test scripts/issue-to-pr-ci-acceptance.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml issue_to_pr --lib
pnpm test -- src/store/issueToPrStore.test.ts
pnpm test
```

The Rust fixture `real_git_and_simulated_github_failing_ci_repairs_to_final_approval_boundary`
creates a real Git repository, runs a failing subprocess check, makes an
in-scope repair, reruns the check, rejects stale/pending simulated GitHub
check observations, and reaches the `ready` boundary without publishing.
The fixture exercises production status classification and transition
checks, not a real provider, a GitHub API connection, or a real model.

Live GitHub verification requires the operator's authenticated `gh` account
and write access to the repo for push/PR mutations; an actual GitHub Actions
run for the new draft PR is the authoritative remote acceptance test.
Monitoring starts from the primary desktop's boot lifecycle even if the
Issue-to-PR panel is never opened. Restarting a run stopped during local
checking reattaches the existing owned diff, reruns authoritative tests and
independent review, and does not replay coding edits. If GitHub already
created an approved draft PR but local persistence stopped, startup can
read-only reconcile the exact repository, owned branch, base, draft state
and HEAD. Ambiguous or stale results never trigger a duplicate write. Verified `ready` runs keep being polled and
are demoted on an owned-worktree/head mismatch. The desktop must be running
to poll: the Rust run record survives a daemon restart, but **unattended
CI polling across a completely stopped desktop is not yet a daemon service**. Live model-backed CI repair,
GitHub event webhook delivery, and a real provider's token/cost budget are
not covered by the credential-free fixture. Do not claim these passed
without separate evidence.
