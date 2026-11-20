# Local dependency-requirement patch

This directory is the published source of `matrix-sdk-sqlite` 0.19.1 from
crates.io (Apache-2.0, see the upstream `matrix-org/matrix-rust-sdk`
repository). `Cargo.toml.orig` is upstream's original workspace manifest and is
kept unchanged for reference.

Little Monkey changes exactly one line, in `Cargo.toml`:

- the `rusqlite` requirement is raised from `0.40.2` to `0.41.1`.

Why: `rusqlite` 0.40.x bundles SQLite through `libsqlite3-sys` 0.38.x, which is
affected by RUSTSEC-2026-0459 (a vulnerability in the bundled C SQLite).
`libsqlite3-sys` declares `links = "sqlite3"`, so a binary can contain only one
copy of it: the Matrix crypto store and Little Monkey's own `rusqlite` must
resolve to the same version. Upstream 0.19.1 is the newest release and still
requires `^0.40.2`, which pinned the whole application to the vulnerable
SQLite. `rusqlite` 0.41 is the first line built on the fixed
`libsqlite3-sys` 0.39, and the store compiles against it with no source
changes.

No Rust source, SQL migration or feature flag differs from the upstream 0.19.1
package. Remove this directory and its `[patch.crates-io]` entry in
`src-tauri/Cargo.toml` as soon as an upstream `matrix-sdk-sqlite` release
accepts a fixed `rusqlite`.
