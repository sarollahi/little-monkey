# Security release register

**Opened:** 2026-11-15, from real `cargo audit` / RustSec output on PR #660.
**Updated:** 2026-11-20.
**Status:** vulnerabilities **remediated** in the lockfile. `cargo audit
--file src-tauri/Cargo.lock` reports **0 vulnerabilities**. No advisory is
ignored, waived or suppressed. Release still requires the full CI matrices
to pass on the exact release commit and the acceptance steps below.

Original evidence (13 findings): [Dependency security audit](https://github.com/sarollahi/little-monkey/actions/runs/43709641668)
and [CI supply-chain](https://github.com/sarollahi/little-monkey/actions/runs/43709641618).
By 2026-11-19 the RustSec database reported **21** findings against the same
lockfile (eight further Wasmtime advisories fixed only in 48.0.9+).

## Findings and resolution

| Lockfile crate | Was | RustSec findings | Now | How |
| --- | --- | --- | --- | --- |
| `wasmtime` | 48.0.7 | RUSTSEC-2026-0422, -0423, -0424, -0566, -0567, -0568, -0569, -0570, -0571, -0572, -0573 | 48.0.10 | exact pin moved within the 48 line, with all Cranelift/Pulley crates |
| `wasmtime-wasi` | 48.0.7 | RUSTSEC-2026-0420 | 48.0.10 | same joint pin |
| `quinn-proto` | 0.11.18 | RUSTSEC-2026-0523, -0524 | 0.11.19 | semver-compatible lockfile update |
| `quinn-udp` | 0.5.15 | RUSTSEC-2026-0538 | 0.5.16 | semver-compatible lockfile update |
| `vodozemac` | 0.11.0 | RUSTSEC-2026-0445, -0451, -0510 | 0.11.2 | semver-compatible lockfile update |
| `rmcp` | 2.2.0 | RUSTSEC-2026-0457, -0462 | 3.11.0 | major MCP SDK migration (below) |
| `libsqlite3-sys` | 0.38.2 | RUSTSEC-2026-0459 | 0.39.1 | `rusqlite` 0.41.1 plus a vendored `matrix-sdk-sqlite` requirement patch (below) |

### rmcp 3.x migration

The only API change the tree hits is `AuthorizationManager::discover_metadata`,
now `resolve_metadata()` returning the metadata together with its discovery
source; the stdio test server uses `ServerConfig` instead of the deprecated
`ServerInfo` alias. The MCP and OAuth unit tests (keychain-backed, run
against a real Secret Service) and the `mcp_http` / `mcp_stdio` integration
tests pass on the upgraded SDK.

### SQLite

`libsqlite3-sys` declares `links = "sqlite3"`, so the Matrix crypto store and
the application must share one copy. The newest `matrix-sdk-sqlite` (0.19.1)
still requires `rusqlite ^0.40.2`, which holds the vulnerable bundled SQLite.
It is vendored at `vendor/matrix-sdk-sqlite` with exactly one change, the
`rusqlite` requirement raised to `0.41.1`; no source, migration or feature
differs from upstream. This keeps a **single** SQLite in the binary. Drop the
patch when upstream accepts a fixed `rusqlite`; see
`vendor/matrix-sdk-sqlite/LITTLE_MONKEY_PATCH.md`.

### Remaining audit output

`cargo audit` still prints informational warnings (unmaintained crates such
as `unic-*`, `derivative`, `proc-macro-error`; unsound notices for `glib`,
`rustix` and `tokio`; three yanked transitive versions). They are not
vulnerabilities and do not fail the audit, but they should be revisited when
their owning dependencies release replacements.

The temporary `security-fix-preview` and `security-mcp3-probe` workflows that
measured these upgrades in disposable checkouts were removed once the real
upgrades landed: the regular dependency audit, supply-chain and Rust test
jobs now cover the same ground on the actual lockfile.

## Release gate

1. `cargo audit --file src-tauri/Cargo.lock` and
   `pnpm audit --prod --audit-level high` must pass on the exact commit being
   released (the **Release** workflow runs both before building).
2. `cargo check --locked` and `cargo test --locked` must pass on Linux, macOS
   and Windows for that commit.
3. Re-run untrusted remote MCP server, OAuth, redirect/SSRF, bounded response,
   reconnect/cancellation and child-process protocol tests after any further
   `rmcp` upgrade.
4. Run real agent/daemon and installer upgrade acceptance against the
   remediated bytes. A clean `cargo audit` is necessary but not sufficient for
   release readiness.
