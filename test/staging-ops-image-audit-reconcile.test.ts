import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleAudit } from "../scripts/staging-ops/image-audit.mjs";
import { reconcileEvidence } from "../scripts/staging-ops/image-audit/reconcile.mjs";
import { validateOriginalEvidence } from "../scripts/staging-ops/image-audit/original-evidence.mjs";
import { assessPackageInventory } from "../scripts/staging-ops/image-audit/registry.mjs";
import { AUDIT_LIMITS, SUBJECT } from "../scripts/staging-ops/image-audit/subject.mjs";
import { SCANNER } from "../scripts/staging-ops/image-audit/scanner.mjs";
import { syntheticSecret } from "./helpers/tar-fixture";

/**
 * PUB-05's operator route, at the boundary an independent probe broke.
 *
 * THE MEASURED DEFECT. Calling the exported `reconcileEvidence` with an EMPTY original record and a
 * well-formed operator inventory returned `clean`, `transitionReady: true` and empty blockers — a
 * complete gate input for an audit that never ran. A well-formed record for a DIFFERENT digest came
 * back with the pinned subject written over it. A record explicitly reporting incomplete coverage
 * and one finding, but with no `blockers` key, came back clean and ready while still carrying those
 * measurements in its own body.
 *
 * ONE cause behind all three: readiness was inferred by filtering a `blockers` ARRAY that defaulted
 * to `[]` when absent, so an absent measurement read as a satisfied one. The fix validates the
 * original's own measurements and recomputes readiness from them with `transitionReadiness` — the
 * same function the audit used — substituting ONLY the package inventory.
 *
 * WHAT THESE TESTS DO NOT CLAIM. Nothing here authenticates anything. A reconciliation is a local
 * evidence helper over two JSON files; it verifies no signature, and a sufficiently careful forgery
 * of a complete, internally consistent record for the pinned subject would validate. The property
 * under test is that an INCOMPLETE, INCONSISTENT, ABSENT or FOREIGN record cannot.
 *
 * Every secret-shaped value is minted per run by `syntheticSecret`.
 */

const scratches: string[] = [];
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "aios-audit-reconcile-"));
  scratches.push(dir);
  return dir;
};
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

/** The API read that FAILED — the only condition the operator route exists to answer. */
const apiFailed = assessPackageInventory({ status: "unverified", reason: "the versions endpoint returned 403 on page 1" }, SUBJECT.digest, {
  status: "verified",
  visibility: "private",
  linkage: SUBJECT.repository,
});

/**
 * A REAL original audit record, assembled by the production `assembleAudit` from synthetic measured
 * outputs. Deliberately not a hand-built `{ blockers: [...] }` object: the positive control has to
 * prove that what the audit actually writes is what reconciliation accepts, and a hand-built stand-in
 * proves only that the fixture matches the validator.
 */
function originalAudit(overrides: Record<string, unknown> = {}) {
  const record = assembleAudit({
    manifest: { digest: `sha256:${"b".repeat(64)}` },
    inspected: {
      coverage: {
        complete: true,
        limitations: [],
        layers: 1,
        members: 3,
        stagedBytes: 512,
        stagedByteLimit: AUDIT_LIMITS.maxTotalStagedBytes,
        representation: "aios.image-audit.scan-surface.v1",
        configBytes: 240,
        scanSurfaceBytes: 844,
        representationOverheadBytes: 92,
      },
      config: { digest: `sha256:${"a".repeat(64)}` },
      layers: [{ index: 0, form: "compressed-blob" }],
      merged: { shadowed: [] },
      buildOutputs: {},
    },
    inventory: { complete: true, findings: 0, counts: { matched: 3, missing: 0 } },
    findings: { total: 0, rules: 0, groups: [] },
    packageInventory: apiFailed,
    identityVerified: true,
    recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied", detail: "no secret reference" }] },
    labelFailures: [],
    tagReadback: { status: "confirmed" },
    scanner: { name: SCANNER.name, version: SCANNER.version, sha256: SCANNER.sha256, configPath: SCANNER.configPath },
    audit: { repository: SUBJECT.repository, runId: "1" },
    startedAt: "2026-09-09T00:00:00.000Z",
    completedAt: "2026-09-09T00:10:00.000Z",
  });
  return { ...record, ...overrides };
}

/** A complete administrator inventory for the pinned subject. */
const operatorInventory = (overrides: Record<string, unknown> = {}) => ({
  subject: { digest: SUBJECT.digest, package: SUBJECT.package, sourceRevision: SUBJECT.sourceRevision },
  capturedAt: "2026-09-09T12:00:00.000Z",
  coversAllPages: true,
  coversUntagged: true,
  auditedDigest: SUBJECT.digest,
  visibility: "private",
  repositoryLinkage: SUBJECT.repository,
  versions: [{ id: 41, digest: SUBJECT.digest, tags: [] }],
  ...overrides,
});

interface Reconciled {
  schema: string;
  verdict: string;
  transitionReady: boolean;
  blockers: readonly string[];
  subject: { digest: string };
  provenance: { refusal?: { codes: readonly string[] }; identityVerified?: boolean };
  coverage?: unknown;
  findings?: unknown;
  packageInventory?: { status: string; source: string; apiStatus: string; operatorEvidence?: { accepted: boolean } };
}

const reconcile = (record: unknown, operator: unknown = operatorInventory()) =>
  reconcileEvidence({ record, operator }) as unknown as Reconciled;

const codes = (result: Reconciled) => [...(result.provenance.refusal?.codes ?? [])];

describe("the ORIGINAL record must exist, match the subject, and be complete (PUB-05)", () => {
  /** THE PROBE'S FIRST CASE, verbatim. */
  it("REFUSES an empty original record instead of assembling a clean, ready one from the operator", () => {
    const result = reconcile({});
    expect(result.verdict).toBe("refused");
    expect(result.transitionReady).toBe(false);
    // It is not a reconciliation record at all: nothing was measured, so there is no coverage,
    // findings or package inventory for a reader to mistake for one.
    expect(result.coverage).toBeUndefined();
    expect(result.findings).toBeUndefined();
    expect(result.packageInventory).toBeUndefined();
    // …and it says WHICH checks failed, in this module's own closed vocabulary.
    expect(codes(result)).toContain("original-schema-mismatch");
    expect(codes(result)).toContain("original-coverage-malformed");
    expect(codes(result)).toContain("original-identity-not-measured");
  });

  it("REFUSES an absent record, with a code of its own", () => {
    for (const absent of [undefined, null, "[]", 7, []]) {
      const result = reconcile(absent);
      expect(result.verdict, `${JSON.stringify(absent) ?? "undefined"} was read as a record`).toBe("refused");
      expect(codes(result)).toEqual(["original-evidence-absent"]);
    }
  });

  it("REFUSES a record carrying another schema", () => {
    const result = reconcile(originalAudit({ schema: "aios.staging-ops.image-audit.reconciliation.v1" }));
    expect(codes(result)).toEqual(["original-schema-mismatch"]);
    expect(result.transitionReady).toBe(false);
  });

  /** THE PROBE'S SECOND CASE: a well-formed record for a DIFFERENT image. */
  it("REFUSES a well-formed record for another digest, rather than rebinding it to the pinned one", () => {
    const foreign = originalAudit();
    const result = reconcile({ ...foreign, subject: { ...foreign.subject, digest: `sha256:${"c".repeat(64)}` } });
    expect(codes(result)).toEqual(["original-subject-mismatch"]);
    expect(result.transitionReady).toBe(false);
    // The output still names the PINNED subject — that was never the defect. The defect was doing
    // so while promoting the foreign record's measurements as if they were about this artifact.
    expect(result.subject.digest).toBe(SUBJECT.digest);
    expect(result.coverage).toBeUndefined();
  });

  it("REFUSES a record naming another package, another source revision or another original run", () => {
    const valid = originalAudit();
    const wrong = [
      { package: "ghcr.io/someone-else/ops" },
      { sourceRevision: "0".repeat(40) },
      { originalRunId: "99999999999" },
      { receiptTag: "sha-0-run-0.1" },
    ];
    for (const change of wrong) {
      const result = reconcile({ ...valid, subject: { ...valid.subject, ...change } });
      expect(codes(result), `${JSON.stringify(change)} was accepted`).toEqual(["original-subject-mismatch"]);
    }
  });

  it("REFUSES a record missing any affirmative measurement the gate reads", () => {
    const valid = originalAudit();
    const cases: [string, Record<string, unknown>, string][] = [
      ["coverage", { coverage: undefined }, "original-coverage-malformed"],
      ["the /app inventory", { inventory: undefined }, "original-inventory-malformed"],
      ["scanner findings", { findings: undefined }, "original-findings-malformed"],
      ["the package inventory", { packageInventory: undefined }, "original-package-inventory-malformed"],
      ["the scanner identity", { scanner: undefined }, "original-scanner-malformed"],
      ["the bounds it ran under", { limits: undefined }, "original-limits-malformed"],
      ["its timestamps", { startedAt: undefined }, "original-timestamps-malformed"],
      ["the identity chain", { provenance: { ...valid.provenance, identityVerified: undefined } }, "original-identity-not-measured"],
      ["the build recipe", { provenance: { ...valid.provenance, recipe: undefined } }, "original-recipe-malformed"],
    ];
    for (const [label, change, code] of cases) {
      const result = reconcile({ ...valid, ...change });
      expect(codes(result), `a record with no ${label} was accepted`).toContain(code);
      expect(result.transitionReady).toBe(false);
    }
  });

  /**
   * The identity bit is the field this fix had to ADD. Before it, the record stated the outcome of
   * the identity chain only inside a blocker sentence — nothing a later reader could recompute from,
   * so reconciliation had to assume it. Assuming an unmeasured prerequisite is the whole defect.
   */
  it("reads the identity chain as a MEASURED boolean that the audit itself persists", () => {
    // The audit writes it: this is the field the fix had to add, so the assertion is on the real
    // `assembleAudit` output rather than on a fixture that states it.
    expect(originalAudit().provenance.identityVerified).toBe(true);

    // …and when the chain did NOT hold, the record says so and the reconciliation blocks on it —
    // recomputed from the boolean, not read out of the original's blocker sentence.
    const base = originalAudit();
    const failed = { ...base, verdict: "incomplete", provenance: { ...base.provenance, identityVerified: false } };
    const result = reconcile(failed);
    expect(result.transitionReady).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/identity was not fully verified/);
  });
});

describe("readiness is RECOMPUTED from measurements, never filtered out of a blocker list", () => {
  /** THE PROBE'S THIRD CASE: incomplete coverage and a real finding, with the blockers key ABSENT. */
  it("does not promote a record whose blockers are missing but whose measurements are not clean", () => {
    const valid = originalAudit();
    const contradictory = {
      ...valid,
      verdict: "findings",
      transitionReady: false,
      blockers: undefined,
      coverage: { ...(valid.coverage as object), complete: false, limitations: [{ kind: "unexpanded-archive-format", layer: 0, format: "zip" }] },
      findings: { total: 1, rules: 1, groups: [{ rule: "generic-api-key", count: 1, occurrences: [{ category: "unresolved", occurrenceId: "00000000-0000-4000-8000-000000000001" }] }] },
    };
    const result = reconcile(contradictory);
    // The record VALIDATES — it is internally consistent, it is simply not clean. So it is
    // reconciled rather than refused, and the answer is: still blocked, on its own measurements.
    expect(result.verdict).not.toBe("refused");
    expect(result.transitionReady).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/coverage is incomplete/);
    expect(result.blockers.join(" ")).toMatch(/1 scanner finding/);
    // The operator inventory WAS substituted — the package dimension really did move, which is what
    // makes the block above about the other dimensions rather than about a refusal to do anything.
    expect(result.packageInventory?.status).toBe("verified");
    expect(result.packageInventory?.source).toBe("operator-evidence");
  });

  it("REFUSES a `clean` verdict that sits beside real findings", () => {
    const valid = originalAudit();
    const result = reconcile({
      ...valid,
      verdict: "clean",
      findings: { total: 2, rules: 1, groups: [{ rule: "generic-api-key", count: 2, occurrences: [] }] },
    });
    expect(codes(result)).toEqual(["original-internally-inconsistent"]);
  });

  it("REFUSES a record whose own flags contradict its measurements", () => {
    const valid = originalAudit();
    const contradictions: [string, Record<string, unknown>][] = [
      ["complete coverage beside a recorded limitation", {
        coverage: { ...(valid.coverage as object), complete: true, limitations: [{ kind: "oversized-member", layer: 0 }] },
      }],
      ["a complete /app comparison beside missing paths", {
        inventory: { complete: true, findings: 0, counts: { missing: 2 } },
      }],
      ["a findings total that does not match its groups", {
        findings: { total: 5, rules: 1, groups: [{ rule: "x", count: 1, occurrences: [] }] },
      }],
      ["transition-ready beside a non-clean verdict", { verdict: "incomplete", transitionReady: true, blockers: [] }],
      ["a clean verdict beside an unverified identity chain", {
        verdict: "clean", provenance: { ...valid.provenance, identityVerified: false },
      }],
    ];
    for (const [label, change] of contradictions) {
      const result = reconcile({ ...valid, ...change });
      expect(codes(result), `${label} was accepted`).toEqual(["original-internally-inconsistent"]);
    }
  });

  /**
   * The canary's `unverified` is mirrored into coverage as a limitation by `coverageWithCanary`, so
   * a record claiming complete coverage beside a scanner that could not read the representation is
   * contradicting itself — and that is precisely the combination that would make a false clean.
   */
  it("REFUSES complete coverage beside a capability canary that did not verify", () => {
    const valid = originalAudit();
    const result = reconcile({
      ...valid,
      scanner: { ...(valid.scanner as object), capabilityCanary: { status: "unverified", reason: "the pinned scanner did not detect the sentinel" } },
    });
    expect(codes(result)).toEqual(["original-internally-inconsistent"]);
  });

  it("REFUSES a record from a run that was itself refused", () => {
    const valid = originalAudit();
    expect(codes(reconcile({ ...valid, verdict: "refused" }))).toContain("original-run-refused");
    expect(codes(reconcile({ ...valid, failure: { stage: "secret-scan", errorName: "Error" } }))).toContain("original-run-refused");
  });
});

describe("the operator supplies ONE dimension, and cannot supply the subject", () => {
  it("cannot make the gate ready with an invalid inventory", () => {
    const incomplete: [string, unknown][] = [
      ["no versions", operatorInventory({ versions: [] })],
      ["no page attestation", operatorInventory({ coversAllPages: undefined })],
      ["no capture timestamp", operatorInventory({ capturedAt: undefined })],
      ["another repository's linkage", operatorInventory({ repositoryLinkage: "someone-else/repo" })],
    ];
    for (const [label, operator] of incomplete) {
      const result = reconcile(originalAudit(), operator);
      expect(result.transitionReady, `${label} satisfied the gate`).toBe(false);
      expect(result.packageInventory?.status, label).toBe("unverified");
    }
    // …and NO operator record at all. Called through the export directly rather than through the
    // helper above, whose default argument would otherwise substitute a valid inventory and make
    // this case silently assert the opposite of what it says.
    const absent = reconcileEvidence({ record: originalAudit(), operator: undefined }) as unknown as Reconciled;
    expect(absent.transitionReady).toBe(false);
    expect(absent.packageInventory?.status).toBe("unverified");
  });

  /**
   * The dimension the operator DOES supply still has an expected answer.
   *
   * A complete, internally consistent inventory that states the package is PUBLIC used to reconcile
   * to `clean` / `transitionReady: true` — while the API read it stands in for refuses a public
   * package outright. Negative and positive control in one case, so "ready" and "not ready" differ
   * by exactly this field.
   */
  it("cannot make the gate ready with a package the API read would have refused as not private", () => {
    const original = originalAudit();
    const exposed = reconcile(original, operatorInventory({ visibility: "public" }));
    expect(exposed.transitionReady).toBe(false);
    expect(exposed.packageInventory?.status).toBe("unverified");
    expect(exposed.packageInventory?.operatorEvidence?.accepted).toBe(false);

    // THE POSITIVE CONTROL, on the same original: only `visibility` differs, and it becomes ready.
    const private_ = reconcile(original, operatorInventory({ visibility: "private" }));
    expect(private_.transitionReady).toBe(true);
    expect(private_.packageInventory?.status).toBe("verified");
  });

  it("cannot retarget the audit by naming a different subject", () => {
    const result = reconcile(originalAudit(), operatorInventory({
      subject: { digest: `sha256:${"d".repeat(64)}`, package: SUBJECT.package, sourceRevision: SUBJECT.sourceRevision },
    }));
    expect(result.transitionReady).toBe(false);
    expect(result.packageInventory?.operatorEvidence?.accepted).toBe(false);
    expect(result.subject.digest).toBe(SUBJECT.digest);
  });

  it("cannot promote a CONTENT GAP: a coverage limitation survives the substitution", () => {
    const valid = originalAudit();
    const gapped = {
      ...valid,
      verdict: "incomplete",
      coverage: { ...(valid.coverage as object), complete: false, limitations: [{ kind: "nested-archive-depth-limit", layer: 0, depth: 2 }] },
    };
    const result = reconcile(gapped);
    expect(result.transitionReady).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/1× nested-archive-depth-limit in layer 0/);
    expect(result.verdict).toBe("incomplete");
  });
});

describe("the reconciled record is an ALLOWLIST of validated fields (PUB-04)", () => {
  it("REFUSES a record carrying a field the audit would never have written", () => {
    const secret = syntheticSecret();
    const valid = originalAudit();
    const smuggled = [
      { coverage: { ...(valid.coverage as object), limitations: [{ kind: "oversized-member", layer: 0, note: secret }] } },
      { scanner: { ...(valid.scanner as object), scratchPath: secret } },
      { inventory: { complete: true, findings: 0, counts: { missing: 0 }, paths: [secret] } },
    ];
    for (const change of smuggled) {
      const result = reconcile({ ...valid, ...change });
      expect(result.verdict).toBe("refused");
      expect(JSON.stringify(result), "a smuggled value reached the reconciled record").not.toContain(secret);
    }
  });

  it("REFUSES to write a record at all when a sensitive SHAPE hides in a field that IS allowlisted", () => {
    // `packageInventory.reason` is legitimate free text — the allowlist cannot exclude it, only
    // bound it to 300 printable characters. The same leak guard the audit's own artifact goes
    // through is the layer that stops a credential shape there. Stated honestly: that guard matches
    // SHAPES, so this is not a claim that arbitrary text in a free-text field is filtered.
    const valid = originalAudit();
    const marker = syntheticSecret("key_");
    expect(() => reconcile({
      ...valid,
      packageInventory: {
        ...(valid.packageInventory as object),
        reason: `the read failed: -----BEGIN RSA PRIVATE KEY----- ${marker}`,
      },
    })).toThrow(/leaks/);
  });

  it("carries the validated observations through, and the original record is not rewritten", () => {
    const valid = originalAudit();
    const before = JSON.stringify(valid);
    const result = reconcile(valid);
    expect(JSON.stringify(valid), "the original record was mutated").toBe(before);
    expect(result.schema).toBe("aios.staging-ops.image-audit.reconciliation.v1");
    expect(result.coverage).toEqual(valid.coverage);
    expect(result.provenance.identityVerified).toBe(true);
  });
});

/**
 * THE POSITIVE CONTROL. Without it, every assertion above is satisfied by a function that refuses
 * everything — and a reconciliation that can never succeed is not the documented alternate path.
 */
describe("a valid original whose ONLY blocker is the API inventory DOES become ready", () => {
  it("is clean and transition-ready with a complete operator inventory", () => {
    const original = originalAudit();
    // The premise, asserted rather than assumed: the original blocks on exactly one dimension.
    expect(original.transitionReady).toBe(false);
    expect(original.blockers).toHaveLength(1);
    expect(original.blockers[0]).toMatch(/package version inventory is unverified/);

    const result = reconcile(original);
    expect(result.verdict).toBe("clean");
    expect(result.transitionReady).toBe(true);
    expect(result.blockers).toEqual([]);
    // The workflow's own read is still reported as it went — the gate stood on operator evidence.
    expect(result.packageInventory).toMatchObject({ source: "operator-evidence", apiStatus: "unverified", status: "verified" });
  });

  it("validates that record through the real validator, field by field", () => {
    const validated = validateOriginalEvidence(originalAudit(), SUBJECT) as { ok: boolean; observations: Record<string, unknown> };
    expect(validated.ok).toBe(true);
    expect(validated.observations.identityVerified).toBe(true);
    expect(validated.observations.auditRunId).toBe("1");
  });
});

/**
 * The CLI dispatch itself. The exported function being correct says nothing about whether the
 * `reconcile` command reaches it — at the frozen checkpoint the function had no entry point at all,
 * which is the whole reason F6 exists.
 */
describe("the `reconcile` command is wired to the dispatcher (F6)", () => {
  const cli = (dir: string, record: unknown, operator: unknown) => {
    const evidence = join(dir, "evidence.json");
    const operatorPath = join(dir, "operator.json");
    const out = join(dir, "reconciled.json");
    writeFileSync(evidence, JSON.stringify(record));
    writeFileSync(operatorPath, JSON.stringify(operator));
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [
        join(process.cwd(), "scripts", "staging-ops", "image-audit.mjs"),
        "reconcile", "--evidence", evidence, "--operator", operatorPath, "--out", out,
      ], { encoding: "utf8" });
    } catch (error: unknown) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status ?? 1;
      stdout = failure.stdout ?? "";
    }
    return { status, stdout, record: JSON.parse(readFileSync(out, "utf8")) as Reconciled };
  };

  it("reads both files, writes the reconciled record, and exits 0 when it is ready", () => {
    const { status, stdout, record } = cli(workspace(), originalAudit(), operatorInventory());
    expect(record.transitionReady).toBe(true);
    expect(record.verdict).toBe("clean");
    expect(stdout).toContain("reconciled verdict: clean (transition ready: true)");
    expect(status).toBe(0);
  });

  it("REFUSES an empty original at the command boundary, and exits non-zero", () => {
    const { status, record } = cli(workspace(), {}, operatorInventory());
    expect(record.verdict).toBe("refused");
    expect(record.transitionReady).toBe(false);
    expect(status).toBe(1);
  });
});
