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

`scripts/autonomous-task-live-eval.mjs` creates a fresh broken Git repository, proves the baseline test fails, invokes the real `monkey task start` command with the selected model target, follows the durable run with `monkey task attach --follow`, then queries `monkey task status --run-id ... --json` for an **authoritative terminal `succeeded`** status. JSONL events from `attach` are **not** a terminal verdict; a failed, cancelled or held run cannot pass merely because source tests happen to be green. The harness independently reruns `npm test`, rejects all unrelated changes, bounds client wait time (`--timeout-seconds`, default 900) and requests cancellation of its owned run when necessary. This requires a real configured target and installed daemon/runtime. Credential-free CI tests these safety rules against an explicitly fake CLI, **not** a model.

For a stronger end-to-end first-run acceptance with recorded baseline commit, raw CLI output, exact diff and independent regression probes, use [the real-model first-run harness](first-run.md#5-run-the-full-installed-cli--daemon--real-model--git-oracle) on a provisioned host. It is opt-in and is never treated as passing solely because the offline contract test runs.

Cross-process daemon and execution-target behavior is additionally covered by the Rust autonomous handoff and real Docker/runner E2E gates. Those tests remain separate because process ownership, runner recovery, and container transport cannot be proven by a TypeScript in-process fixture.
