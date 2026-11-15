# Durable ordinary sessions: recovery and attachment

Ordinary packaged desktop turns use the existing resident daemon. **The daemon
owns execution.** Desktop, CLI and editors observe the same run ledger; an
observer does not create a separate engine, permission policy, or tool context.
The browser-only development fallback has no resident daemon and is not
crash-resumable.

## Storage and versioning

- Desktop transcript metadata is still stored by `sessions.rs` in its atomic
  session JSON. The new assistant `durableTurn` marker contains only stable
  `turnId` and `runId` identifiers and is stripped from provider requests.
- The daemon's existing SQLite `ingress_turns` table records the immutable
  accepted turn, frozen execution context, originating account/session and
  idempotency key. The existing `daemon_jobs` and `RunLedger` hold execution
  owner, validated transitions, approval and external mutation events, and
  monotonic event sequences. No separate session database is introduced.
- Daemon migration **v21** adds only
  `ingress_turns_session_attachment_idx`. It preserves existing ingress rows,
  permissions, run events and pending approvals. A downgraded daemon is
  intentionally refused by the existing forward-only schema compatibility gate.
- A newer frozen-execution version is not interpreted by the desktop recovery
  selector; it must be opened with a compatible client. The daemon's own frozen
  context and ledger validation remain authoritative.

## Reconnect

On startup, the desktop asks `ingress list --recoverable` for accepted and
in-flight desktop/voice turns. It matches the **exact source account/session**
against local transcript sessions, selects the newest eligible run, and either
reuses an assistant message with matching `durableTurn` metadata or creates one
new display placeholder. A lost `localStorage` watcher link cannot cause an
accepted run to execute again. The old watcher cache is fallback only when the
authoritative lookup does not produce an attachable run for that session.

Observers replay from run ledger sequence 0 when they have no saved cursor.
If the daemon has accepted an ingress turn but has not yet assigned its run
ID, the desktop retries discovery with a bounded backoff; it never re-submits
the accepted operation. Once a cursor is saved, replays request only events
beyond that cursor. The
run ledger owns event order, transactional append, write-once tool outcomes and
retention; observers never persist their own authoritative event log. A second
observer cannot expand the immutable permission policy, workspace roots,
network allowlist, or approval authority. UI disconnection detaches its watcher;
**only explicit Stop** requests cancellation from a recovered UI observer.

A CLI observer uses:

```sh
monkey daemon session <desktop-session-id> --follow --json
monkey daemon session 'editor:<acp-session-id>' --follow --json
monkey daemon session <desktop-session-id> --after 149 --follow --json
monkey daemon attach <run-id> --after 149 --follow --json
monkey ingress list --recoverable --json
monkey ingress list --source desktop --account <desktop-session-id> --json
```

`--after` is an **exclusive** durable event sequence cursor, not an offset.
Pressing Ctrl+C detaches a CLI observer; it does not send `daemon cancel`.
Approval decisions remain scoped to the existing digest-bound control command.
Paired devices are not automatically given a desktop session by learning its ID:
remote device/peer transport authentication and capability checks remain separate.

## After a crash

The daemon recovers accepted but not-yet-queued ingress with the same durable
idempotency key. Queued jobs remain in the resident queue. On supported,
explicitly enabled Linux live handoff, a restarted supervisor can adopt the
**attested surviving worker** under the existing fenced lease. For a dead or
unverifiable worker, the existing daemon reconciliation mechanism **does not
blindly rerun** tools that may already have had external effects. Such runs
require explicit inspection and, where appropriate, a new operator-authorized
continuation. The existing checkpoint/permission ledger retains available
pre-mutation images, pending approvals, diffs and verification events.

A daemon process crash, worker crash, and desktop renderer crash are different
cases. This implementation improves session discovery and observation; it does
**not** guarantee exact mid-token model continuation after a dead worker, nor
exactly-once external effects for integrations that provide no idempotency or
reconciliation proof. Terminated workers with ambiguous mutations are not
silently restarted. Existing run retention may eventually archive old events;
long-lost observers must inspect archived history rather than assume their old
cursor has a complete continuous stream.

## Verification matrix

- Rust: scoped ingress lookup before pagination; migration to v21; query for
  pending/in-flight and `needs_reconciliation` vs completed runs.
- TypeScript: exact session ownership, latest-run selection, unsupported schema
  refusal, transcript idempotency marker and removal from model wire payload.
- TypeScript: two observers replaying one run, observer detach without cancel,
  original-turn abort-to-cancel still preserved.
- Existing daemon ingress contract suite: crash between acceptance and queue,
  redelivery deduplication, frozen context, mutation contract correction.
- Existing run ledger/checkpoint suites: external mutation preparation and
  permission/approval integrity.

**Still requires live host acceptance**: kill desktop during provider generation
and file writes; abruptly terminate worker immediately before/after tool-result
fsync; restart during approval; reconnect ACP and a paired device; simulate
permission revocation, disk-full SQLite, event pruning, and multi-process
concurrent UI saves. Tests that pass with mocks do not prove those OS-level
failures. A paired mobile client can observe its own authenticated conversation;
shared desktop-session attachment through paired-device remote APIs is not yet
implemented. Multi-window write-conflict-free shared transcripts also remain a
separate limitation of `sessions.rs`'s primary-window writer model.

## Paired-device read-only attachment

An already-paired device with **ViewSessions**, **ViewRuns**, and **ViewEvents**
may discover a desktop or voice turn by issuing a signed GET to
`/v1/remote/mobile/sessions/{session_id}/agent-turns`. The response returns
stable `turn_id`, `run_id`, run state, and the existing read-only
`/v1/remote/runs/{run_id}/events?after=0` cursor endpoint. The host evaluates
each run against the device's **existing run/workspace scope**. Out-of-scope runs
are omitted, not identified; prompts, tool arguments, and frozen recipes are
not exposed. No client may grant itself ViewSessions or widen run scope.
Approval, cancel, pause and execution retain their separate existing grants.
Devices without the new combination of permissions receive a refusal, even
when they know a desktop session ID.

This API does not add mobile-side transcript editing or new turn submission
into arbitrary desktop sessions; it supplies authenticated observation only.

## Lost local transcript before the first save

If the daemon accepted an ordinary desktop/voice turn but the desktop crashed
before persisting its local session entry, the **primary window** reconstructs
a minimal read-only session shell from the already-accepted ingress identity.
The original prompt, model settings, workspace grant, persona and conversation
history are **not** guessed or pulled from current configuration. It attaches
to the authoritative run and displays output/events. The shell has
`recoveryOnly: true` and refuses *new* turns because doing otherwise would
silently continue under a different security/context snapshot. The operator
must start a new session for further instructions. This is a conservative
partial recovery, not complete reconstruction of lost unsaved UI state.
