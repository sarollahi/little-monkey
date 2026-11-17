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
persisted issue budget. The GitHub issue coder is deliberately NOT offered
`run_shell`, background shell tools, or direct GitHub tools; it may inspect
and edit files only inside the app-owned root. It also rejects writes
to Git metadata and GitHub Actions workflows/composite actions, including
paths containing parent-directory traversal. Its repository checks execute
through the existing bounded native verifier, and commit/push/PR creation use
the separately approved Git delivery layer. Repository test scripts are still
executable project code and must be trusted or run on an isolated host;
removing the model's shell tool does not sandbox the scripts themselves. Starting an issue
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
fail closed. The native revision digest also enumerates non-ignored **untracked
files recursively through Git** and hashes their bytes and permissions under
a bounded 128 MiB / 2,048-file limit; untracked symlinks and paths escaping
the owned worktree are refused. A newly created file cannot silently change
after verification simply because it was absent from `git diff`. Results, failed checks, review evidence, and the durable task link remain inspectable
from the issue panel/run ledger.

Git delivery is deliberately not autonomous: the issue coordinator
completes the local verified worktree and hands it to exactly one native
`m5_delivery` approval flow. A restart between an approved commit and the
push is recoverable: the backend confirms the clean HEAD is **exactly one**
commit on top of the reviewed HEAD, that the commit touched **only the
reviewed file list**, and that current file bytes/permissions still match
the recorded precommit content snapshot. Any extra commit, changed content,
unreviewed path, or stale preview is rejected without a push. Each owned-worktree commit, push, and draft
PR creation/update requires a separately previewed, typed confirmation. Edits on a previously pushed draft PR are
committed on the same owned branch and the existing PR is updated, never
replaced or force-pushed. An ambiguous Git state fails closed.

After the operator approves delivery, the panel polls GitHub's real
`statusCheckRollup` every 30 seconds. **Independently, the installed
`monkey daemon` user service now polls the same authoritative Rust
observer every 45 seconds**, including when the desktop process is closed.
The daemon discovers `monitoring_ci` and `ready` runs on each startup and
checks up to eight oldest-unobserved runs per pass. It can also **read-only
reconcile up to two `opening_pr` runs per pass** if the desktop disappeared
after an approved GitHub create but before local PR-number persistence. Only
an exact owned, clean, previously reviewed branch/base/HEAD and already-open
draft PR can be adopted; the daemon never reissues PR creation. It performs
no GitHub calls if no run needs observation or reconciliation. Both use the same persisted evidence, GitHub
authentication, owned branch checks, revision-bound review, and CI settling
rule. Unavailable GitHub/network/auth responses revoke `ready` without
consuming a model repair attempt; polling retries on the next pass. Observations are persisted by exact
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
metered token usage fail closed. Token-event idempotency survives app restarts. The persisted JSON run store
now rejects malformed data rather than loading an empty map and erasing
unfinished runs on its next write. Checkpoints use individually named
sync-to-disk temporary files before replacement. Desktop and daemon now
serialize whole-record read/modify/write operations using the same
cross-process OS file lock (`issue_to_pr_runs.json.lock`) as well as a
per-process mutex. The daemon never holds the store lock over a GitHub
network request: on completion it compares the complete persisted baseline
and discards stale observations if the desktop cancelled, repaired, or
updated the run while GitHub was responding.

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
cargo test --manifest-path src-tauri/Cargo.toml --bin monkey-cli daemon::issue_to_pr_monitor
pnpm test -- src/store/issueToPrStore.test.ts
pnpm test
```

The Rust fixture `real_git_and_simulated_github_failing_ci_repairs_to_final_approval_boundary`
creates a real Git repository, runs a failing subprocess check, makes an
in-scope repair, reruns the check, rejects stale/pending simulated GitHub
check observations, and reaches the `ready` boundary without publishing.
The fixture exercises production status classification and transition
checks, not a real provider, a GitHub API connection, or a real model.

### Desktop-closed daemon acceptance

This is a live integration check, not covered by the credential-free Git
fixture:

1. In the same OS user/profile that runs Little Monkey, authenticate `gh`
   and run `monkey daemon ensure`; `monkey daemon status --json` must
   confirm the current installed service is running.
2. Through the app's existing issue flow, approve commit, push and draft PR.
   Wait until the persisted run is `monitoring_ci`, then **close the desktop
   process** without stopping the OS user service.
3. In a separate crash-recovery case, interrupt after the GitHub create-draft-PR mutation
   succeeds but before the desktop records the PR number. On daemon
   restart, it must discover and adopt only that same owned draft PR,
   without issuing another create or push request.
4. Finish a GitHub Actions job. The daemon's shared Rust observer should
   persist a new `ci_history` observation within one 45-second poll cycle
   (subject to GitHub response time and the eight-run-per-pass cap).
   Restarting the installed service during that interval must not discard
   or duplicate observations.
5. A current-head failed check must move the run to `repairing` (or
   `failed` once its frozen limit is exhausted) **without** running an
   agent, consuming a retry attempt, committing, pushing or updating a PR.
   Reopening the desktop can resume the existing bounded repair.
6. A current-head stable-green result requires two matching observations
   at least 30 seconds apart; the daemon may mark `ready` but never
   publish or merge. Changing the draft PR head, base, ownership, or
   verified files must revoke readiness.
7. Disconnect GitHub or make `gh` authentication unavailable while the
   daemon is running: an existing `ready` status must be revoked to
   `monitoring_ci` with a persisted transient error. Restore connectivity;
   it should clear on a subsequent valid observation without consuming a
   repair attempt.
8. Engage the daemon kill switch or maintenance drain. No outbound CI
   poll should occur until the existing daemon control permits it again.

The daemon uses its current-user GitHub CLI authentication and is
**pinned to the active app-data profile it served at startup**. Switching
profiles requires re-ensuring the corresponding user service; an old
daemon refuses to poll a different profile's PR records. It does **not**
store GitHub credentials in issue records, create an independent polling
database, or execute any issue-supplied command. The desktop and daemon
coordinate the same JSON run record with a stable OS file lock; GitHub
requests occur outside the critical section and stale responses are dropped.

Live GitHub verification requires the operator's authenticated `gh` account
and write access to the repo for push/PR mutations; an actual GitHub Actions
run for the new draft PR is the authoritative remote acceptance test.
Monitoring starts from the primary desktop's boot lifecycle even if the
Issue-to-PR panel is never opened. Starting the same GitHub issue again while it already has a nonterminal
run reattaches the recorded run and its owned worktree instead of creating
a duplicate agent or resetting frozen budgets. Concurrent Start requests
are serialized before worktree creation.

Restarting a run stopped during implementation checks the authoritative
owned-worktree identity and actual changed files before doing anything.
A partially edited branch proceeds to fresh authoritative checks and
independent review instead of replaying code mutations; an untouched branch
can resume coding. Restarting a run stopped during local checking likewise
reattaches the existing owned diff, reruns authoritative tests and independent
review, and does not replay coding edits. If GitHub already
created an approved draft PR but local persistence stopped, startup can
read-only reconcile the exact repository, owned branch, base, draft state
and HEAD. Ambiguous or stale results never trigger a duplicate write. Verified `ready` runs keep being polled and
are demoted on an owned-worktree/head mismatch. The desktop can be closed **as long as the installed user daemon remains
running**. Release builds already call `monkey daemon ensure` on launch;
for an unattended/CLI installation, use `monkey daemon ensure` once to
install and start the service. The daemon never performs agent/model repair,
Git writes, PR publication, force-push, or automatic merge. Failed CI is
persisted as `repairing` (or `failed` after the frozen limit), and the
existing desktop workflow resumes that bounded repair when reopened.
Live model-backed CI repair, GitHub event webhook delivery, and a real
provider's token/cost budget are not covered by the credential-free
fixture. Do not claim these passed
without separate evidence.
