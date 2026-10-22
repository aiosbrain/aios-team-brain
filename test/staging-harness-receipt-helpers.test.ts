import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The measured failure (`receipt-path-adjudication.md`): `expect_failure` takes a LABEL and writes
 * `$harness_root/$label.log`, while `receipt`/`require_receipt`/`refuse_receipt` open
 * `$harness_root/$log` verbatim. Every caller passed the label, so stage 8 read a nonexistent
 * extensionless file and failed — while the retained `pre-drain-control.log` showed the intended
 * fault had fired exactly as designed:
 *
 *     staging-ops-receipt fault-injected {"point":"before-drain","runId":"run-4",…}
 *     staging importer refused: injected harness fault before drain
 *
 * A source-string guard would not have caught it and does not prove the fix, so these tests EXECUTE
 * THE ACTUAL HELPER DEFINITIONS, lifted out of the harness by name, against real files in a real
 * temporary harness root. The subtle half is `refuse_receipt`: a missing file made `receipt` fail,
 * which reads identically to "the receipt is absent" — so an unreadable log would have been reported
 * as a verified absence.
 */

/** The helper definitions AS SHIPPED, extracted from the harness so the two cannot drift. */
function helperSource(): string {
  const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");
  const start = harness.indexOf("receipt() {");
  const end = harness.indexOf("journal_field() {");
  const block = harness.slice(start, end);
  if (start < 0 || end < 0 || !block.includes("refuse_receipt() {")) {
    throw new Error("could not lift the receipt helpers out of the harness; this test would prove nothing");
  }
  return block;
}

/** `expect_failure` too — the other half of the contract, and the source of the `.log` suffix. */
function expectFailureSource(): string {
  const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");
  const start = harness.indexOf("expect_failure() {");
  const end = harness.indexOf("# ── Receipts");
  const block = harness.slice(start, end);
  if (start < 0 || end < 0 || !block.includes("$harness_root/$label.log")) {
    throw new Error("could not lift expect_failure out of the harness");
  }
  return block;
}

let root: string | null = null;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

/** Run a snippet with the REAL helpers in scope. Returns the exit status and both streams. */
function runHelpers(snippet: string): { status: number; stdout: string; stderr: string } {
  root = mkdtempSync(join(tmpdir(), "receipt-helpers-"));
  const script = `set -uo pipefail\nharness_root="${root}"\n${expectFailureSource()}\n${helperSource()}\n${snippet}\n`;
  try {
    const stdout = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** The exact receipt line the retained runtime-10 artifact contains. */
const FAULT = `staging-ops-receipt fault-injected {"point":"before-drain","runId":"run-4","postgresRestored":false,"graphRestored":false}`;
const emit = (line: string) => `printf '%s\\n' '${line}'; echo 'staging importer refused: injected harness fault before drain'; exit 1`;

describe("the receipt helpers, executed", () => {
  it("captures a failing command's output and matches the receipt it emitted", () => {
    // The whole stage-8 contract in one go: a command that emits the receipt and exits non-zero,
    // captured by label, then read back by FILENAME.
    const run = runHelpers([
      `expect_failure pre-drain-control bash -c "${emit(FAULT).replace(/"/g, '\\"')}"`,
      `require_receipt pre-drain-control.log fault-injected '"point":"before-drain".*"runId":"run-4"' "the control failed at the point it claims"`,
      `refuse_receipt pre-drain-control.log postgres-restored '"runId":"run-4"' "a pre-drain failure wrote no candidate Postgres"`,
    ].join("\n"));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("verified denial: pre-drain-control");
    expect(run.stdout).toContain("verified receipt: the control failed at the point it claims");
    expect(run.stdout).toContain("verified absence: a pre-drain failure wrote no candidate Postgres");
  });

  it("REFUSES the extensionless label that actually broke stage 8", () => {
    const run = runHelpers([
      `expect_failure pre-drain-control bash -c "${emit(FAULT).replace(/"/g, '\\"')}"`,
      `require_receipt pre-drain-control fault-injected '"point":"before-drain"' "the label, not the filename"`,
    ].join("\n"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("needs an explicit .log FILENAME");
  });

  it("never reports a MISSING FILE as a verified absence", () => {
    // The dangerous half. `receipt` failed for both "not there" and "could not look", and
    // `refuse_receipt` read the second as the first.
    const run = runHelpers(
      `refuse_receipt never-written.log prior-pair-restored '"failedRunId":"run-4"' "an absence in a file that does not exist"`,
    );
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain("verified absence");
    expect(run.stderr).toMatch(/cannot refuse a receipt in an unreadable log|does not exist in the harness root/);
  });

  it("cannot be satisfied by the WRONG POINT", () => {
    const wrongPoint = FAULT.replace("before-drain", "after-postgres");
    const run = runHelpers([
      `expect_failure pre-drain-control bash -c "${emit(wrongPoint).replace(/"/g, '\\"')}"`,
      `require_receipt pre-drain-control.log fault-injected '"point":"before-drain".*"runId":"run-4"' "the control failed at the point it claims"`,
    ].join("\n"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("missing receipt");
  });

  it("cannot be satisfied by the WRONG RUN", () => {
    const wrongRun = FAULT.replace('"runId":"run-4"', '"runId":"run-9"');
    const run = runHelpers([
      `expect_failure pre-drain-control bash -c "${emit(wrongRun).replace(/"/g, '\\"')}"`,
      `require_receipt pre-drain-control.log fault-injected '"point":"before-drain".*"runId":"run-4"' "the control failed at the point it claims"`,
    ].join("\n"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("missing receipt");
  });

  it("cannot be satisfied by an UNRELATED non-zero exit", () => {
    // A preflight refusal, a container that never started, a discovery error — all exit non-zero and
    // emit no receipt. This is the reason receipts exist at all.
    const run = runHelpers([
      `expect_failure pre-drain-control bash -c "echo 'staging importer refused: some other reason'; exit 1"`,
      `require_receipt pre-drain-control.log fault-injected '"point":"before-drain".*"runId":"run-4"' "the control failed at the point it claims"`,
    ].join("\n"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("missing receipt");
  });

  it("FAILS when a forbidden receipt is present", () => {
    const forbidden = `staging-ops-receipt prior-pair-restored {"failedRunId":"run-4","postgres":true,"graph":true,"ready":true}`;
    const run = runHelpers([
      `expect_failure pre-drain-control bash -c "${emit(forbidden).replace(/"/g, '\\"')}"`,
      `refuse_receipt pre-drain-control.log prior-pair-restored '"failedRunId":"run-4"' "a pre-drain failure triggers no recovery"`,
    ].join("\n"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unexpected receipt");
  });

  it("reads a DIRECTLY written .log, the way the interruption barrier does", () => {
    // `receipt interrupted.log …` is polled against a file the harness redirects into itself, with
    // no `expect_failure` involved — a different caller shape that must keep working.
    root = mkdtempSync(join(tmpdir(), "receipt-helpers-"));
    const direct = join(root, "interrupted.log");
    writeFileSync(direct, `${`staging-ops-receipt postgres-restored {"runId":"run-3","kind":"source","mode":"copy-ready"}`}\n`);
    const script = `set -uo pipefail\nharness_root="${root}"\n${helperSource()}\nif receipt interrupted.log postgres-restored '"runId":"run-3"'; then echo BARRIER-REACHED; fi\n`;
    const stdout = execFileSync("bash", ["-c", script], { encoding: "utf8" });
    expect(stdout).toContain("BARRIER-REACHED");
  });

  it("keeps every shipped caller passing an explicit .log filename", () => {
    // The runtime proof above is about the helpers; this is about the 18 call sites.
    const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");
    const callers = [...harness.matchAll(/^(require_receipt|refuse_receipt)\s+(\S+)/gm)];
    expect(callers.length, "the extractor matched no callers, so this asserts nothing").toBeGreaterThanOrEqual(18);
    for (const [, verb, first] of callers) expect(first, `${verb} ${first}`).toMatch(/\.log$/);
    // …and `expect_failure` labels stay extensionless, because it appends the suffix itself.
    for (const [, label] of harness.matchAll(/^expect_failure\s+(\S+)/gm)) expect(label).not.toMatch(/\.log$/);
  });
});
