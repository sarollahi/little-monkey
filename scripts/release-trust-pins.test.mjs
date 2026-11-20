import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pins = JSON.parse(readFileSync(new URL("./release-trust-pins.json", import.meta.url), "utf8"));
test("the production Linux signing key is pinned to the observed signed 1.12.0 lineage", () => {
  assert.match(pins.linux_gpg_fingerprint, /^[A-F0-9]{40}$/);
  assert.equal(pins.linux_gpg_fingerprint, "4E192C99F6C92873A3983537A89809F662D94B12");
  assert.match(pins.trust_scope, /continuity only/i);
  assert.match(pins.rotation_policy, /explicitly update this pin/i);
});
