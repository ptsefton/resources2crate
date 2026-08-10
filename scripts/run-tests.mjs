// Runs every test-*.mjs found anywhere in the repo and exits non-zero if any
// failed.
//
// Not a test framework (see ARCHITECTURE §9.2) — just a loop. Each test is a
// plain script that throws on a failed assertion, so "did it pass" is exactly
// "did it exit 0". Every test runs even after one fails, so a change that
// breaks several shows all of them in one go rather than one per re-run.
//
// Tests are discovered rather than listed, so a new test-*.mjs is picked up
// without also having to be registered here — the old failure mode where the
// wired-up suite and the actual suite drifted apart. Discovery is recursive
// (not just tests/) because a plugin's own tests can live colocated with its
// code instead — see src/plugins/chordpro-input/ — so that folder stays
// self-contained if it's ever extracted into its own repo. Each test runs
// with its own containing directory as cwd, so a test that reads a fixture
// via a relative path next to itself behaves the same regardless of where in
// the tree it lives.
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build", "coverage"]);

function findTestFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || EXCLUDED_DIR_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) findTestFiles(full, found);
    else if (/^test-.*\.mjs$/.test(name)) found.push(full);
  }
  return found;
}

const tests = findTestFiles(root).sort();

if (!tests.length) {
  console.error("No test-*.mjs files found — that is itself a failure.");
  process.exit(1);
}

const failed = [];
for (const test of tests) {
  const label = path.relative(root, test);
  const started = Date.now();
  const { status } = spawnSync(process.execPath, [test], { cwd: path.dirname(test), stdio: "inherit" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (status !== 0) {
    failed.push(label);
    console.error(`✗ ${label} exited ${status} after ${secs}s\n`);
  }
}

console.log(
  failed.length
    ? `\n${failed.length} of ${tests.length} suites failed: ${failed.join(", ")}`
    : `\nAll ${tests.length} suites passed.`
);
process.exit(failed.length ? 1 : 0);
