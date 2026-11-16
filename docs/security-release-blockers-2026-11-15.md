# Security blockers for the next Little Monkey release

**Observed:** 2026-11-15, from real `cargo audit` / RustSec output on PR #660.
**Status:** FAIL. Do not publish; do not ignore advisories to make CI green.

Evidence: [Dependency security audit](https://github.com/sarollahi/little-monkey/actions/runs/43709641668) and [CI supply-chain](https://github.com/sarollahi/little-monkey/actions/runs/43709641618).

These are the **13 reported vulnerability findings**, grouped by crate. They are
not 13 independently affected direct dependencies. The lockfile's transitive
graph and production reachability must be verified after every proposed upgrade.

| Lockfile crate | Installed | RustSec findings | Reported fixed version |
| --- | --- | --- | --- |
| `libsqlite3-sys` | 0.38.2 | RUSTSEC-2026-0459 | 0.39.0+ |
| `quinn-proto` | 0.11.18 | RUSTSEC-2026-0524, -0523 | 0.11.19+ |
| `quinn-udp` | 0.5.15 | RUSTSEC-2026-0538 | 0.5.16+ (<0.6), or 0.6.3+ |
| `rmcp` | 2.2.0 | RUSTSEC-2026-0457, -0462 | 3.9.0+ (breaking major upgrade) |
| `vodozemac` | 0.11.0 | RUSTSEC-2026-0445, -0510, -0451 | 0.11.2+ |
| `wasmtime` | 48.0.7 | RUSTSEC-2026-0424, -0422, -0423 | 48.0.8+ |
| `wasmtime-wasi` | 48.0.7 | RUSTSEC-2026-0420 | 48.0.8+ |

## Remediation sequence

1. For every crate, run `cargo tree --manifest-path src-tauri/Cargo.toml -i CRATE`
   and identify the owner/feature chain. This is especially important for
   `quinn` (optional HTTP/3), `libsqlite3-sys` (SQLite links conflicts), and
   `rmcp` (breaking API/transport major version).
2. Upgrade lockfile-compatible patch versions together, pin a reviewed
   `Cargo.lock` and validate it using `cargo check --locked`,
   `cargo test --locked` on Linux, macOS and Windows, then rerun `cargo audit`.
   Do not manually edit checksums or skip lockfile integrity.
3. Coordinate the SQLite `rusqlite`/Matrix SDK dependency chain rather than
   resolving the `links = "sqlite3"` conflict with multiple copies.
4. Migrate the `rmcp` transport/OAuth client to the fixed major version and
   rerun untrusted remote MCP server, OAuth, redirect/SSRF, bounded response,
   reconnect/cancellation, and child-process protocol tests.
5. Run real agent/daemon and installer upgrade acceptance against the
   remediated bytes. A clean `cargo audit` is necessary but not sufficient for
   release readiness.

A separate [unprivileged security-fix preview](../.github/workflows/security-fix-preview.yml)
tries compatible updates to Quinn, vodozemac and a jointly pinned Wasmtime/WASI
patch pair, then uploads its exact `Cargo.lock`/`Cargo.toml` diff and
remaining audit findings. It **does not push changes** or establish successful
compilation; any resulting patch still needs cross-platform checks before it
can be merged. The breaking rmcp 2.x→3.9 migration and SQLite bindings
coordination remain explicitly unattempted in that preview.

The **Release** workflow now invokes `cargo audit --file
src-tauri/Cargo.lock` and `pnpm audit --prod --audit-level high` before
building, on top of its explicit manual approval and acceptance evidence URL.
This change **does not fix any advisory**: the gate stays blocked until the
dependencies themselves are fixed and verified.
