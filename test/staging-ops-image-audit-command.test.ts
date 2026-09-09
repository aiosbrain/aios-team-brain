import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleAudit, createScratch, runAudit, runPrivate, runScan } from "../scripts/staging-ops/image-audit.mjs";
import { CHECKSUM_UNRECORDED, SCANNER } from "../scripts/staging-ops/image-audit/scanner.mjs";
import { SUBJECT } from "../scripts/staging-ops/image-audit/subject.mjs";
import { createOperationBudget } from "../scripts/staging-ops/operation-deadline.mjs";
import { syntheticSecret } from "./helpers/tar-fixture";

/**
 * PUB-07's COMMAND-boundary rows: the audit's subprocess seam, exercised by spawning real processes.
 *
 * WHY REAL PROCESSES. Everything interesting here is a property of the boundary itself — a report the
 * scanner did not write, a report it wrote that is not a findings array, a run killed by its deadline,
 * output that must reach private scratch and nothing else. A helper-level fake asserts what the fake
 * was told to do; only an actual `spawnSync` shows what the code does with a process that misbehaves.
 *
 * The "scanner" below is a generated Node script that accepts the audit's REAL argument list and
 * writes whatever the case is about. It is a stand-in for one command, not a simulation of CI.
 *
 * Every secret-shaped value is minted per run by `syntheticSecret`.
 */

const scratches: string[] = [];
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "aios-audit-cmd-"));
  scratches.push(dir);
  return dir;
};
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

const budget = () => createOperationBudget("audit command test", 60_000);

/**
 * A fake scanner BINARY: a real executable that receives the real flags.
 *
 * `report` is the literal text written to whatever `--report-path` names — `undefined` writes no file
 * at all, which is the "exited 0 and produced nothing" case. `noise` is written to stdout AND stderr,
 * so every failure assertion below can prove the audit never echoed it.
 */
function fakeScanner(dir: string, { report, noise = "", exitCode = 0 }: { report?: string; noise?: string; exitCode?: number }): string {
  const path = join(dir, "fake-scanner.mjs");
  writeFileSync(path, [
    `#!${process.execPath}`,
    'import { writeFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const reportPath = args[args.indexOf("--report-path") + 1];',
    `const noise = ${JSON.stringify(noise)};`,
    "if (noise) { process.stdout.write(noise); process.stderr.write(noise); }",
    `const report = ${report === undefined ? "undefined" : JSON.stringify(report)};`,
    "if (report !== undefined) writeFileSync(reportPath, report);",
    `process.exit(${exitCode});`,
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

const scanFor = (dir: string, options: Parameters<typeof fakeScanner>[1]) => () => runScan({
  binary: fakeScanner(dir, options),
  scanDir: join(dir, "scan"),
  scratch: dir,
  budget: budget(),
  configPath: join(dir, "config.toml"),
});

describe("the scanner's report is read at the COMMAND boundary (PUB-03)", () => {
  it("REFUSES a run that exited 0 and wrote no report at all", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    expect(scanFor(dir, { report: undefined })).toThrow(/produced no report/);
  });

  it("REFUSES a report that is not parseable JSON, without quoting it", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    const secret = syntheticSecret();
    let message = "";
    try {
      scanFor(dir, { report: `{"File": "${secret}"` })();
      expect.unreachable("an unparseable report was accepted");
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
      expect((error as { code?: string }).code).toBe("AUDIT_SCANNER_REPORT_UNPARSEABLE");
    }
    // V8 quotes a slice of the input in a `SyntaxError`, and the input here is the scanner's report.
    expect(message).not.toContain(secret);
  });

  /**
   * THE CASE THE OLD CODE TURNED INTO A CLEAN RESULT. A subprocess that exits 0 having written `{}`
   * or `null` was coerced to "zero findings" — the best verdict the audit can produce, from a run
   * that never said what it found.
   */
  it("REFUSES a report that is well-formed JSON but not a findings array", () => {
    for (const body of ["{}", "null", '{"findings":[]}', '"[]"', '{"RuleID":"x","File":"L0/1"}']) {
      const dir = createScratch({ RUNNER_TEMP: workspace() });
      expect(scanFor(dir, { report: body }), `${body} was read as a report`).toThrow(/not a findings array/);
    }
  });

  it("REFUSES a findings array whose entries are the wrong shape", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    expect(scanFor(dir, { report: '[{"File":"L0/000000.json"}]' })).toThrow(/carries no RuleID/);
  });

  it("accepts a VALID EMPTY report as the genuine clean case", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    expect(scanFor(dir, { report: "[]" })()).toEqual([]);
  });

  it("returns a report WITH a finding, so a clean pass is distinguishable from a scan that found something", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    const report = scanFor(dir, { report: '[{"RuleID":"generic-api-key","File":"L0/000000.json"}]' })();
    expect(report).toHaveLength(1);
    expect(report[0].RuleID).toBe("generic-api-key");
  });

  it("fails a scanner that exits non-zero, and keeps its output in PRIVATE scratch", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    const secret = syntheticSecret();
    try {
      scanFor(dir, { report: "[]", noise: `scanning ${secret}`, exitCode: 3 })();
      expect.unreachable("a non-zero scanner exit was accepted");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("AUDIT_SUBPROCESS_EXIT");
      expect(error instanceof Error ? error.message : "").not.toContain(secret);
    }
    // …and the diagnostic really was captured, rather than discarded: a bounded rerun needs it, and
    // the evidence artifact must never carry it.
    expect(readFileSync(join(dir, "logs", "scanner-detect.log"), "utf8")).toContain(secret);
  });

  it("passes the audit's own config and report path through to the process", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    // The fake echoes nothing back, so the proof is indirect but real: the report landed at the path
    // the audit chose, which only happens if `--report-path` reached the process.
    expect(scanFor(dir, { report: "[]" })()).toEqual([]);
    expect(readFileSync(join(dir, "logs", "scanner-report.json"), "utf8")).toBe("[]");
  });
});

describe("subprocess failures are classified, and never echoed (PUB-04, M6)", () => {
  it("distinguishes a DEADLINE from a process that would not start", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    try {
      runPrivate(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { scratch: dir, label: "slow", timeoutMs: 150 });
      expect.unreachable("a timed-out subprocess was accepted");
    } catch (error: unknown) {
      // Previously ETIMEDOUT and ENOENT were the same `AUDIT_SUBPROCESS_START`, and that code is the
      // ONLY thing about the failure the public record carries.
      expect((error as { code?: string }).code).toBe("AUDIT_SUBPROCESS_TIMEOUT");
    }
    expect(() => runPrivate(join(dir, "no-such-binary"), [], { scratch: dir, label: "missing", timeoutMs: 5_000 }))
      .toThrow(/AUDIT_SUBPROCESS_START/);
  });

  it("distinguishes an exhausted log buffer from both of them", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    const shout = `process.stdout.write("x".repeat(64 * 1024))`;
    try {
      // A tiny cap, so the case is the BUFFER rather than a genuinely enormous diagnostic.
      runPrivate(process.execPath, ["-e", shout], { scratch: dir, label: "loud", timeoutMs: 10_000, maxBufferBytes: 256 });
      expect.unreachable("an overflowing subprocess was accepted");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("AUDIT_SUBPROCESS_LOG_OVERFLOW");
    }
  });

  it("writes a failing process's stdout and stderr to scratch and not to this process's own output", () => {
    const dir = createScratch({ RUNNER_TEMP: workspace() });
    const secret = syntheticSecret();
    const script = `process.stdout.write(${JSON.stringify(secret)}); process.stderr.write(${JSON.stringify(secret)}); process.exit(2);`;
    expect(() => runPrivate(process.execPath, ["-e", script], { scratch: dir, label: "leaky", timeoutMs: 10_000 }))
      .toThrow(/leaky exited 2/);
    const captured = readFileSync(join(dir, "logs", "leaky.log"), "utf8");
    expect(captured).toContain(secret);
    // Both streams, so a scanner that reports on stderr is captured as fully as one that reports on
    // stdout — `stdio: inherit` would have put either straight into a public job log.
    expect(captured.split(secret)).toHaveLength(3);
  });
});

/**
 * M3's wiring, at the dispatcher's own assembly step rather than at a helper.
 *
 * `recipe.mjs` states that unknown assertions block. `transitionReadiness` had no recipe parameter,
 * so the recipe was recorded in `provenance` and never reached the gate — the promise was kept
 * nowhere. `assembleAudit` is the one place both are derived, from the SAME argument.
 */
describe("the measured build recipe reaches the verdict, not just the record (M3)", () => {
  const measured = {
    manifest: { digest: SUBJECT.digest },
    inspected: {
      coverage: { complete: true, limitations: [], layers: 1, members: 3, stagedBytes: 512 },
      config: { digest: `sha256:${"a".repeat(64)}` },
      layers: [{ index: 0, form: "compressed-blob" }],
      merged: { shadowed: [] },
    },
    inventory: { complete: true, findings: 0, counts: { missing: 0 } },
    findings: { total: 0, rules: 0, groups: [] },
    packageInventory: { status: "verified", otherVersions: 0 },
    identityVerified: true,
    labelFailures: [],
    tagReadback: { status: "confirmed" },
    scanner: { name: SCANNER.name, version: SCANNER.version, sha256: SCANNER.sha256, configPath: SCANNER.configPath },
    audit: { repository: "aiosbrain/aios-team-brain", runId: "1" },
    startedAt: "2026-09-09T00:00:00.000Z",
    completedAt: "2026-09-09T00:10:00.000Z",
  };

  it("is clean and transition-ready when every recipe assertion is satisfied", () => {
    const record = assembleAudit({ ...measured, recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied" }] } });
    expect(record).toMatchObject({ verdict: "clean", transitionReady: true });
    expect(record.blockers).toEqual([]);
  });

  it("BLOCKS on a violated assertion, and records the very recipe it judged", () => {
    const recipe = {
      assertions: [
        { id: "dockerfile.no-build-args", status: "violated", detail: "1 ARG declaration(s) could have carried a build-time value" },
        { id: "lockfile.registry-origin", status: "satisfied", detail: "all 2 package entries resolved from https://registry.npmjs.org" },
      ],
      limitation: "these are configured-input assertions … NOT a hermeticity claim",
    };
    const record = assembleAudit({ ...measured, recipe });
    expect(record.transitionReady).toBe(false);
    expect(record.blockers.join(" ")).toMatch(/build-recipe assertion\(s\) are VIOLATED/);
    // ONE source: the object the gate judged is the object the artifact carries. Two variables here
    // is exactly how a record could describe a recipe the verdict never saw.
    expect(record.provenance.recipe).toBe(recipe);
    expect(record.verdict).toBe("unresolved");
  });

  it("BLOCKS when no recipe was measured at all", () => {
    const record = assembleAudit(measured);
    expect(record.transitionReady).toBe(false);
    expect(record.blockers.join(" ")).toMatch(/were not measured/);
  });
});

describe("a PREREQUISITE refusal still produces sanitized evidence (PUB-01, PUB-04)", () => {
  const auditEnv = (dir: string) => ({
    RUNNER_TEMP: dir,
    AUDIT_EVIDENCE_PATH: join(dir, "staging-ops-image-audit.json"),
    GITHUB_REPOSITORY: "aiosbrain/aios-team-brain",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
  });

  it("refuses an UNPINNED scanner before any subprocess, network call or scratch directory", async () => {
    const dir = workspace();
    const env = auditEnv(dir);
    let commands = 0;
    await expect(runAudit(env, {
      scanner: { ...SCANNER, sha256: CHECKSUM_UNRECORDED },
      run: () => { commands += 1; return Buffer.alloc(0); },
      // Ordering, asserted: the pin is checked before anything is created on disk.
      makeScratch: () => { throw new Error("scratch must not be created for an unpinned scanner"); },
    })).rejects.toThrow(/checksum is not recorded/);

    expect(commands, "the audit ran a subprocess before checking its prerequisites").toBe(0);
    const record = JSON.parse(readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8"));
    expect(record).toMatchObject({ verdict: "refused", transitionReady: false });
    // The record exists AND says which prerequisite refused. Without it, a refusal is
    // indistinguishable to a coordinator from a runner that died before writing anything.
    expect(record.failure).toMatchObject({ stage: "prerequisites", errorCode: "AUDIT_SCANNER_UNPINNED" });
    // It still names WHICH artifact was not audited, and it carries no findings section at all — a
    // refused run has a stage that did not complete, not zero findings.
    expect(record.subject.digest).toBe(SUBJECT.digest);
    expect(record.findings).toBeUndefined();
  });

  it("refuses a scratch directory it cannot create, without publishing the path or the error", async () => {
    const dir = workspace();
    const env = auditEnv(dir);
    const secretPath = `/private/var/${syntheticSecret("tmp_")}/aios-image-audit`;
    let commands = 0;
    await expect(runAudit(env, {
      run: () => { commands += 1; return Buffer.alloc(0); },
      makeScratch: () => {
        throw Object.assign(new Error(`EACCES: permission denied, mkdtemp '${secretPath}'`), { code: "AUDIT_SCRATCH_UNAVAILABLE" });
      },
    })).rejects.toThrow(/EACCES/);

    expect(commands).toBe(0);
    const written = readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8");
    // A sanitized record even though scratch — where diagnostics normally live — never existed.
    expect(JSON.parse(written).failure).toMatchObject({ stage: "prerequisites", errorCode: "AUDIT_SCRATCH_UNAVAILABLE" });
    expect(written).not.toContain(secretPath);
    expect(written).not.toContain("EACCES");
  });
});
