import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapResumeOrderVerdict } from "../scripts/staging-ops/assert-bootstrap-resume-order.mjs";

/**
 * M2 — THE RESUME CHECKER CAN NO LONGER SKIP ITS OWN CHECK.
 *
 * Its entry test was `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`. Node
 * resolves a module's own path through symlinks, so an invocation through a symlinked path compared
 * the real file against the link, never matched, ran no body and exited **0 having printed
 * nothing**. The harness reads only `$?`, which makes that outcome indistinguishable from a verified
 * ordering — a checker that certifies the resume ordering by not looking at it.
 *
 * These are ACTUAL CLI executions, direct and through a symlink, against valid, missing-checkpoint
 * and reordered receipts. The success case asserts the printed verdict as well as the status,
 * because status alone is exactly the signal the defect forged.
 */

const CLI = path.resolve("scripts/staging-ops/assert-bootstrap-resume-order.mjs");

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(path.join(os.tmpdir(), "resume-order-")); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const receipt = (phase: string, extra: Record<string, unknown> = {}) =>
  `staging-ops-receipt bootstrap-phase ${JSON.stringify({ runId: "bootstrap-1", phase, ...extra })}`;

const ORDERED = [
  receipt("read-journal"),
  receipt("resume-interrupted-bootstrap", { resumedPhase: "captured" }),
  receipt("transition-draining", { resumed: true }),
  receipt("stop-and-verify-all", { resumed: true }),
  receipt("acquire-exclusive-data-lock"),
  receipt("adopted-published-checkpoint", { objectId: "bootstrap-1--" + "a".repeat(64) }),
].join("\n");

// The regression the ordering exists to catch: the lock taken BEFORE the re-stop.
const REORDERED = [
  receipt("transition-draining", { resumed: true }),
  receipt("acquire-exclusive-data-lock"),
  receipt("stop-and-verify-all", { resumed: true }),
  receipt("adopted-published-checkpoint"),
].join("\n");

// Everything but the adoption: a resume that captured a SECOND checkpoint instead of adopting the
// published one, which is a different defect and must not read as an ordering pass.
const MISSING = [
  receipt("transition-draining", { resumed: true }),
  receipt("stop-and-verify-all", { resumed: true }),
  receipt("acquire-exclusive-data-lock"),
].join("\n");

const logFile = (contents: string) => {
  const file = path.join(dir(), "importer.log");
  writeFileSync(file, `${contents}\n`);
  return file;
};

/** @param entry the path the CLI is invoked BY — the real script, or a symlink to it. */
const run = (entry: string, ...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });

const symlinked = () => {
  const link = path.join(dir(), "resume-order-link.mjs");
  symlinkSync(CLI, link);
  return link;
};

describe.each([
  ["invoked directly", () => CLI],
  ["invoked through a SYMLINK", symlinked],
])("the resume-order CLI, %s", (_label, entry) => {
  it("exits 0 AND prints its success verdict on correctly ordered receipts", () => {
    const result = run(entry(), logFile(ORDERED));
    expect(result.status, result.stderr).toBe(0);
    // The load-bearing half. Pre-fix, a symlinked invocation also exited 0 — with empty stdout,
    // because the CLI body never ran.
    expect(result.stdout).toContain("verified resume ordering");
  });

  it("exits NONZERO on receipts that took the exclusive lock out of order", () => {
    const result = run(entry(), logFile(REORDERED));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("out of order");
  });

  it("exits NONZERO when a required checkpoint was never emitted", () => {
    const result = run(entry(), logFile(MISSING));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never emitted adopted");
  });

  it("exits NONZERO when handed no log at all", () => {
    const result = run(entry());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("captured importer log path is required");
  });
});

describe("importing the checker", () => {
  it("runs no CLI and evaluates the pure verdict", () => {
    // The import at the top of this file is itself the side-effect check: a module that ran its CLI
    // on import would have called `process.exit(2)` (no `argv[2]`) and taken the runner with it.
    expect(bootstrapResumeOrderVerdict(ORDERED)).toMatchObject({ ok: true, reason: null });
    expect(bootstrapResumeOrderVerdict(REORDERED).ok).toBe(false);
    expect(bootstrapResumeOrderVerdict("")).toMatchObject({ ok: false });
  });
});
