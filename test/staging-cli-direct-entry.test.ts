import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * L-A — THE THREE REMAINING CLIs CAN NO LONGER SKIP THEIR OWN BODIES.
 *
 * `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` fixes URL encoding but not
 * SYMLINKS: Node resolves a module's own path through links, so an invocation through a symlinked
 * path compares the real file against the link, never matches, runs no body, and exits **0 having
 * printed nothing**. A caller reading only `$?` cannot tell that from a completed run — which is
 * why this shape fails OPEN and why `direct-entry.mjs` exists. `assert-bootstrap-resume-order.mjs`
 * and `verify-main-policy.mjs` were already converted; the importer, the exporter and the startup
 * fence still carried the fragile spelling.
 *
 * The startup fence is the one with teeth: a body that never runs acquires no shared data-use lock
 * and supervises nothing, so the boot it fences proceeds unfenced while its exit code says otherwise.
 *
 * These are ACTUAL child processes, direct and through a symlink, from a directory whose name
 * CONTAINS A SPACE — the other half of the same family of entry bugs, and the one a `file://` string
 * comparison gets wrong. Each CLI is driven to its own SAFE refusal: an unknown action, a missing
 * runner role, a missing child command. None needs a database, a provider credential or an endpoint,
 * and none of them launches a supervised child. The refusal MESSAGE is asserted, not just the exit
 * code, because a nonzero exit alone is what the defect could still have produced by other means.
 */

const SCRIPTS = path.resolve("scripts/staging-ops");

const dirs: string[] = [];
/** A path with a SPACE in it, so the encoded-URL half of the defect is exercised too. */
const spacedDir = () => {
  const created = mkdtempSync(path.join(os.tmpdir(), "staging cli entry "));
  dirs.push(created);
  return created;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Deliberately almost empty: every refusal below must be reachable with NO staging configuration.
 * `PATH` only, so nothing can pick up an operator's real credentials from the ambient environment.
 */
const BARE_ENV = { PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;

const run = (entry: string, args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: BARE_ENV });

const CLIS = [
  {
    name: "importer",
    file: "importer.mjs",
    // Rejected by the first statement of `runImporter`, before any environment is read.
    args: ["not-an-action"],
    refusal: "importer action must be install-ops",
  },
  {
    name: "exporter",
    file: "exporter.mjs",
    // The exporter has no unknown-action validator; its actual first refusal is the runner role.
    args: [],
    refusal: "runner role must be exactly exporter",
  },
  {
    name: "startup-fence",
    file: "startup-fence.mjs",
    // No `--`, so no child command — refused before the fence connects to anything.
    args: [],
    refusal: "startup fence requires a child command",
  },
] as const;

describe.each(CLIS)("$name refuses identically however it is invoked", ({ file, args, refusal }) => {
  const target = () => path.join(SCRIPTS, file);

  // 20s per case: each is a cold Node start that loads `pg` and (for the importer) `neo4j-driver`,
  // which the 5s default can lose to on a cold filesystem — a timing failure, not a defect.
  it("refuses NONZERO with its own message when invoked directly", () => {
    const result = run(target(), [...args]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(refusal);
  }, 20_000);

  it("refuses NONZERO with the SAME message through a symlink in a directory with a space", () => {
    // Pre-fix this exited 0 with empty stderr: the body never ran. Both halves are asserted, because
    // the status alone is exactly the signal the defect forged.
    const link = path.join(spacedDir(), `linked ${file}`);
    symlinkSync(target(), link);
    const result = run(link, [...args]);
    expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(refusal);
  }, 20_000);

  it("runs NO CLI when the module is merely imported", () => {
    // A separate process whose entry is the WRAPPER, so `isDirectEntry` must answer false for the
    // module it loads. Anything the CLI would have done — a refusal on this empty environment, or a
    // connection attempt — shows up as extra output or a nonzero exit.
    const wrapper = path.join(spacedDir(), "import only.mjs");
    writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(target()).href)});\nprocess.stdout.write("imported");\n`);
    const result = run(wrapper, []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("imported");
    // Not `toBe("")`: Node may write its own warnings here, and a runtime warning is not a CLI run.
    // The refusal each CLI would reach on this empty environment is what must be absent.
    expect(result.stderr).not.toMatch(/refused/);
    expect(result.stderr).not.toContain(refusal);
  }, 20_000);
});
