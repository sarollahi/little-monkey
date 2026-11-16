# Security blockers for the next Little Monkey release

**Observed:** 2026-11-15, from real `cargo audit` / RustSec output on PR #660.
**Status:** FAIL. Do not publish; do not ignore advisories to make CI green.

Evidence: [Dependency security audit](https://github.com/sarollahi/little-monkey/actions/runs/43709641668) and [CI supply-chain](https://github.com/sarollahi/little-monkey/actions/runs/43709641618).

These are the **13 reported vulnerability findings**, grouped by crate. They are
not 13 independently affected direct dependencies. The lockfile's transitive
graph and production reachability must be verified after every proposed upgrade.

| Lockfile crate | Original version (2026-11-15) | RustSec findings | Reported fixed version |
| --- | --- | --- | --- |
| `libsqlite3-sys` | 0.38.2 | RUSTSEC-2026-0459 | 0.39.0+ |
| `quinn-proto` | 0.11.18 | RUSTSEC-2026-0524, -0523 | 0.11.19+ |
| `quinn-udp` | 0.5.15 | RUSTSEC-2026-0538 | 0.5.16+ (<0.6), or 0.6.3+ |
| `rmcp` | 2.2.0 | RUSTSEC-2026-0457, -0462 | 3.9.0+ (breaking major upgrade) |
| `vodozemac` | 0.11.0 | RUSTSEC-2026-0445, -0510, -0451 | 0.11.2+ |
| `wasmtime` | 48.0.7 | RUSTSEC-2026-0424, -0422, -0423 | 48.0.8+ |
| `wasmtime-wasi` | 48.0.7 | RUSTSEC-2026-0420 | 48.0.8+ |

## Compatible dependency fixes now committed (2026-11-16)

[The actual isolated RustSec preview](https://github.com/sarollahi/little-monkey/actions/runs/43827611219)
successfully ran `cargo update`, generated a Cargo.lock/Cargo.toml
patch with valid locked metadata, and reduced the measured audit
from **13 findings to 3** in its disposable checkout.

That exact compatible version/checksum/dependency change has been applied
to this draft PR: Quinn protocol/UDP, vodozemac and jointly pinned
Wasmtime/WASI 48.0.8, including all transitive Cranelift/Pulley crates.

**This patch's cross-platform compilation and security audit are still
pending on the exact new commit.** Passing in the preview is not equivalent
to a completed CI run after the patch is applied.

The **three remaining preview findings** are:
- `libsqlite3-sys 0.38.2` — `RUSTSEC-2026-0459`. Patched upstream at
  0.39.0+, but this project shares one SQLite `links` crate with
  `matrix-sdk-sqlite 0.19.1` / `rusqlite 0.40.2`; upgrading only our
  direct rusqlite does not resolve the shared native library.
- `rmcp 2.2.0` — `RUSTSEC-2026-0457` and `RUSTSEC-2026-0462`.
  The fixed MCP 3.9+ SDK changes protocol and OAuth APIs; the project has
  extensive MCP transports, authorization, and test-server integration,
  so migrating requires compiler and security-regression evidence.

Neither remaining finding is ignored or suppressed. **Release: BLOCKED.**

The [rmcp 3.10.0 migration probe](../.github/workflows/security-mcp3-probe.yml)
now runs a **disposable** dependency-resolution attempt followed by real
Rust library/CLI/test-server compilation and, only if compilation succeeds,
MCP HTTP and stdio integration tests. Compiler errors and the exact unmerged
manifest/lockfile patch are retained as CI artifacts. Its workflow conclusion
does not certify migration success; only an actual zero compiler exit code,
successful integration tests and a fresh audit could do that.

The SQLite fix needs `libsqlite3-sys >=0.39` (bundled SQLite >=3.54) but
the latest released Matrix Rust SDK 0.19.1 pins the shared `rusqlite` line;
forcibly adding a second `links=sqlite3` crate is not an acceptable fix.
The existing private data-directory and backup file validation policies
do not justify ignoring that upstream vulnerability. Avoid opening imported
or untrusted database/WAL pairs until a compatible SDK fix is available.

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

The [security-fix preview](../.github/workflows/security-fix-preview.yml)
remains a **non-publishing verification tool** and is now idempotent for
the applied compatible patches. It never waives audit failures. The major
rmcp migration and SQLite/Matrix SDK dependency coordination remain open.

The **Release** workflow now invokes `cargo audit --file
src-tauri/Cargo.lock` and `pnpm audit --prod --audit-level high` before
building, on top of its explicit manual approval and acceptance evidence URL.
The compatible upgrades eliminate ten reported findings **in the preview's
measured lockfile**. The gate stays blocked on the three remaining
vulnerabilities, and all patches require fresh cross-platform validation.
