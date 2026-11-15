#!/usr/bin/env node
/**
 * Simulated CLI used ONLY by the first-run live harness' offline contract test.
 * This is NOT a model, agent, resident daemon, or acceptance performance run.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("monkey 1.12.0");
} else if (args[0] === "task" && args[1] === "start") {
  const ws = args[args.indexOf("--workspace") + 1];
  const math = join(ws, "src/math.mjs");
  if (existsSync(math)) {
    writeFileSync(math, readFileSync(math, "utf8").replace("a - b", "a + b"));
  } else {
  const impl = join(ws, "normalize.mjs");
  writeFileSync(impl,
    readFileSync(impl, "utf8").replace("replaceAll(' ', '-')", "replace(/\\s+/g, '-')"));
  const suite = join(ws, "normalize.test.mjs");
  writeFileSync(suite, readFileSync(suite, "utf8") +
    "\ntest('tabs collapse', () => { assert.equal(normalizeUserId('Ada\\tLovelace'), 'ada-lovelace'); });\n");
  if (process.env.FAKE_UNRELATED === "1") writeFileSync(join(ws, "unrelated.txt"), "unrelated\n");
  console.log(JSON.stringify({run_id: "task-contract-stub", status: "queued"}));
} else if (args[0] === "task" && args[1] === "attach") {
  console.log(JSON.stringify({run_id: args[2], sequence: 1, event: "started"}));
} else if (args[0] === "task" && args[1] === "status") {
  console.log(JSON.stringify([{run_id: "task-contract-stub", status: process.env.FAKE_RUN_STATUS || "succeeded"}]));
} else if (args[0] === "task" && args[1] === "cancel") {
  console.log("cancelled");
} else {
  console.error("Unexpected contract stub command", args);
  process.exit(3);
}
