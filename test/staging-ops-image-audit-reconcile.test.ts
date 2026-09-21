import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assembleAudit } from "../scripts/staging-ops/image-audit.mjs";
import { reconcileEvidence } from "../scripts/staging-ops/image-audit/reconcile.mjs";
import { validateOriginalEvidence } from "../scripts/staging-ops/image-audit/original-evidence.mjs";
import { scannerIdentity } from "../scripts/staging-ops/image-audit/evidence.mjs";
import { assessPackageInventory } from "../scripts/staging-ops/image-audit/registry.mjs";
import { assessCanary, SCAN_REPRESENTATION } from "../scripts/staging-ops/image-audit/scan-surface.mjs";
import { AUDIT_LIMITS, SUBJECT } from "../scripts/staging-ops/image-audit/subject.mjs";
import { SCANNER, scannerArgs, scannerSettings } from "../scripts/staging-ops/image-audit/scanner.mjs";
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
 * THE SCANNER EXACTLY AS THE PRODUCER EMITS IT (AC-AUDIT-08) — built by the production
 * `scannerIdentity` from the tracked config's real bytes, the settings read back from a real argument
 * list, the v2 representation and a VERIFIED three-fixture canary. The four-field stand-in this
 * replaces (`{ name, version, sha256, configPath }`) was the incomplete positive fixture that let a
 * record with every scanner measurement dropped reconcile to ready.
 */
const verifiedCanary = assessCanary({ wrappedFindings: 1, unwrappedFindings: 0, archiveSurfaceFindings: 1 });
const productionScanner = (canary: unknown = verifiedCanary) => scannerIdentity(SCANNER, readFileSync(SCANNER.configPath), {
  settings: scannerSettings(scannerArgs({ sourceDir: "/scratch/scan", reportPath: "/scratch/report.json", ignorePath: "/scratch/cwd/.gitleaksignore" })),
  representation: SCAN_REPRESENTATION,
  canary,
});

/**
 * A REAL original audit record, assembled by the production `assembleAudit` from synthetic measured
 * outputs. Deliberately not a hand-built `{ blockers: [...] }` object: the positive control has to
 * prove that what the audit actually writes is what reconciliation accepts, and a hand-built stand-in
 * proves only that the fixture matches the validator.
 *
 * `assembly` overrides what the AUDIT was given (so a case can exercise a measurement the audit
 * derives, such as the capability canary); `overrides` rewrites the record it produced.
 */
function originalAudit(overrides: Record<string, unknown> = {}, assembly: Record<string, unknown> = {}) {
  const record = assembleAudit({
    manifest: { digest: `sha256:${"b".repeat(64)}` },
    inspected: {
      coverage: {
        complete: true,
        limitations: [],
        layers: 1,
        members: 3,
        stagedBytes: 2048,
        archiveSurfaceBytes: 1536,
        stagedByteLimit: AUDIT_LIMITS.maxTotalStagedBytes,
        representation: SCAN_REPRESENTATION.version,
        configBytes: 240,
        scanSurfaceBytes: 2380,
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
    canary: verifiedCanary,
    scanner: productionScanner(),
    audit: { repository: SUBJECT.repository, runId: "1" },
    startedAt: "2026-09-09T00:00:00.000Z",
    completedAt: "2026-09-09T00:10:00.000Z",
    ...assembly,
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
   * A FINDING PATH the audit itself resolved, including this repository's bracketed dynamic routes.
   *
   * `publicPathResolver` emits a member's path verbatim once the audit's own expected-tree lookup has
   * established it as public source content, and 70+ real paths under `app/` carry `[` and `]`. The
   * validator's path pattern was a narrow filename-character allowlist that matched none of them, so a
   * finding in `app/t/[team]/…` refused the WHOLE record as `original-findings-malformed` — the wrong
   * failure mode twice over: findings block the transition on their own merits, and a malformed-record
   * refusal hides the real reason while the operator route stops working entirely.
   *
   * What the pattern still refuses is what an audit-established path can never be: absolute,
   * traversing, or carrying a byte outside printable ASCII.
   */
  it("accepts a bracketed dynamic-route path in a finding, and still refuses absolute or traversing ones", () => {
    const valid = originalAudit();
    const withPath = (path: string) => ({
      ...valid,
      verdict: "findings",
      transitionReady: false,
      blockers: undefined,
      findings: {
        total: 1,
        rules: 1,
        groups: [{
          rule: "generic-api-key",
          count: 1,
          occurrences: [{ category: "public-source-path", occurrenceId: "00000000-0000-4000-8000-000000000002", path }],
        }],
      },
    });

    // Both taken from this repository's actual tree, where `publicPathResolver` would find them.
    for (const path of ["app/t/[team]/projects/[project]/page.tsx", "app/api/dashboard/conversations/[id]/route.ts"]) {
      const result = reconcile(withPath(path));
      expect(codes(result), `${path} was refused as malformed`).toEqual([]);
      expect(result.verdict, path).not.toBe("refused");
      // It reconciles on its MERITS: a real finding still blocks.
      expect(result.transitionReady).toBe(false);
      expect(result.blockers.join(" ")).toMatch(/1 scanner finding/);
      expect(JSON.stringify(result.findings), `${path} was dropped from the record`).toContain(path);
    }

    // The NUL case is BUILT, not typed: a literal NUL byte in a source file makes git treat the
    // whole file as binary, which is a worse problem than the one it would be testing.
    //
    // The backslash forms and the whitespace-only one each trip ONE clause and nothing else: a
    // backslash is not a separator to the traversal lookahead, so `..\..\etc\shadow` and
    // `C:\Windows\x` validated as ordinary relative paths while the comment above the pattern
    // claimed "never absolute, never traversing"; `"   "` is printable ASCII within the bound and
    // names nothing at all. No path in this repository's tracked tree carries a backslash.
    for (const hostile of ["/etc/shadow", "../../etc/shadow", "app/../../etc/shadow", `app/${String.fromCharCode(0)}hidden.ts`, "app/café.ts", "..\\..\\etc\\shadow", "C:\\Windows\\x", "   "]) {
      const result = reconcile(withPath(hostile));
      expect(codes(result), `${JSON.stringify(hostile)} validated`).toContain("original-findings-malformed");
      expect(result.transitionReady).toBe(false);
    }
  });

  /**
   * A WELL-TYPED scanner identity is not the PINNED scanner identity.
   *
   * The measured defect: a complete, internally consistent original — real `assembleAudit` output,
   * correct subject, clean coverage, verified identity chain — whose `scanner.sha256` was a
   * different 64-hex string still reconciled to `clean` / `transitionReady: true`. The shape check
   * only ever asked whether the four fields were the right TYPES, so a stale scanner build or a
   * different config passed as the binary the workflow pins. Each field is mutated to a value that
   * SURVIVES the shape check, so what reddens here is the binding and not the types.
   */
  it("REFUSES a record whose scanner is not the PINNED scanner, field by field", () => {
    const valid = originalAudit();
    const drifted: [string, string, string][] = [
      ["sha256", "f".repeat(64), "original-scanner-sha256-mismatch"],
      ["version", "8.18.4", "original-scanner-version-mismatch"],
      ["name", "trufflehog", "original-scanner-name-mismatch"],
      ["configPath", "config/staging-ops/someone-elses-gitleaks.toml", "original-scanner-config-path-mismatch"],
    ];
    for (const [field, value, code] of drifted) {
      const result = reconcile({ ...valid, scanner: { ...(valid.scanner as object), [field]: value } });
      expect(result.verdict, `a ${field} the pinned scanner never had was accepted`).toBe("refused");
      expect(result.transitionReady).toBe(false);
      expect(codes(result), `${field} drift produced the wrong codes`).toEqual([code]);
      // The refusal names the FIELD. The record's own value is attacker-supplied and the
      // reconciled record is as public as the audit's, so it is never echoed.
      expect(result.blockers.join(" ")).toContain(code);
      expect(JSON.stringify(result), `the ${field} value reached the reconciled record`).not.toContain(value);
    }

    // THE POSITIVE CONTROL, on the same original: with the pinned scanner it is still ready, so the
    // four cases above differ from readiness by exactly this binding.
    expect(reconcile(valid).transitionReady).toBe(true);
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

/**
 * AC-AUDIT-08 — THE READINESS BOUNDARY, table-driven over the full PRODUCTION scanner shape.
 *
 * Every row starts from the complete record `assembleAudit` writes with `productionScanner()` and makes
 * ONE deficiency: a required field omitted, a nested field omitted or altered, a syntactically valid
 * wrong digest, a v1 representation, unsupported settings, a representation mismatch, a missing or
 * failed canary, or a contradictory complete-coverage claim. Each is reconciled WITH an otherwise-valid
 * operator inventory — the substitution that used to launder these — and must refuse or stay blocked.
 *
 * Where a row plants a value, that value is a per-run marker, and the reconciled record must not
 * contain it: a refusal names what failed with a fixed code, never what was rejected.
 */
describe("every deficient scanner measurement refuses or stays blocked after operator substitution (AC-AUDIT-08)", () => {
  type Fields = Record<string, unknown>;
  /** The production scanner record's shape, as far as these rows reach into it. */
  interface ScannerRecord extends Fields {
    settings: Fields & { ruleLimitations: readonly string[] };
    representation: Fields;
    capabilityCanary: Fields;
  }
  interface AuditRecord extends Fields {
    scanner: ScannerRecord;
    coverage: Fields;
  }
  type Mutate = (record: AuditRecord, marker: string) => Fields;
  const withScanner = (change: (scanner: ScannerRecord, marker: string) => Fields): Mutate =>
    (record, marker) => ({ ...record, scanner: change(structuredClone(record.scanner), marker) });
  const without = (object: Fields, key: string): Fields => { const { [key]: _gone, ...rest } = object; return rest; };
  const baseRecord = () => originalAudit() as unknown as AuditRecord;
  const hex = (character: string) => character.repeat(64);

  const rows: [string, Mutate, string?][] = [
    // Each required top-level scanner field, omitted.
    ...(["name", "version", "sha256", "configPath", "configSha256", "settings", "representation", "capabilityCanary"] as const)
      .map((field): [string, Mutate, string] => [`scanner.${field} omitted`, withScanner((scanner) => without(scanner, field)), "original-scanner-malformed"]),
    // Syntactically valid, wrong digests.
    ["a wrong configSha256 (valid hex)", withScanner((scanner) => ({ ...scanner, configSha256: hex("f") })), "original-scanner-config-sha256-mismatch"],
    ["a wrong asset sha256 (valid hex)", withScanner((scanner) => ({ ...scanner, sha256: hex("e") })), "original-scanner-sha256-mismatch"],
    // Settings: each policy key omitted, an extra key, altered values.
    ...(["gitleaksIgnorePath", "ruleLimitations", "maxTargetMegabytes", "maxArchiveDepth", "archiveExpansion"] as const)
      .map((key): [string, Mutate, string] => [`settings.${key} omitted`, withScanner((scanner) => ({ ...scanner, settings: without(scanner.settings, key) })), "original-scanner-settings-unsupported"]),
    ["an extra settings key", withScanner((scanner, marker) => ({ ...scanner, settings: { ...scanner.settings, extra: marker } })), "original-scanner-settings-unsupported"],
    ["a scanner file-size skip", withScanner((scanner) => ({ ...scanner, settings: { ...scanner.settings, maxTargetMegabytes: "100" } })), "original-scanner-settings-unsupported"],
    ["archive traversal enabled", withScanner((scanner) => ({ ...scanner, settings: { ...scanner.settings, maxArchiveDepth: "8" } })), "original-scanner-settings-unsupported"],
    ["no audit-owned ignore file", withScanner((scanner) => ({ ...scanner, settings: { ...scanner.settings, gitleaksIgnorePath: "unset (the documented default is the working directory, which may carry a .gitleaksignore)" } })), "original-scanner-settings-unsupported"],
    ["a reworded rule limitation", withScanner((scanner, marker) => ({ ...scanner, settings: { ...scanner.settings, ruleLimitations: [marker, ...scanner.settings.ruleLimitations.slice(1)] } })), "original-scanner-settings-unsupported"],
    ["a dropped rule limitation", withScanner((scanner) => ({ ...scanner, settings: { ...scanner.settings, ruleLimitations: scanner.settings.ruleLimitations.slice(0, -1) } })), "original-scanner-settings-unsupported"],
    // Representation: nested fields omitted or altered.
    ...(["version", "header", "suffix"] as const)
      .map((key): [string, Mutate, string] => [`representation.${key} omitted`, withScanner((scanner) => ({ ...scanner, representation: without(scanner.representation, key) })), "original-scanner-malformed"]),
    ["representation.note omitted", withScanner((scanner) => ({ ...scanner, representation: without(scanner.representation, "note") })), "original-scan-representation-unsupported"],
    ["representation.header altered", withScanner((scanner) => ({ ...scanner, representation: { ...scanner.representation, header: "OTHER header\n" } })), "original-scan-representation-unsupported"],
    ["representation.suffix altered", withScanner((scanner) => ({ ...scanner, representation: { ...scanner.representation, suffix: ".bin" } })), "original-scan-representation-unsupported"],
    ["representation.note altered", withScanner((scanner, marker) => ({ ...scanner, representation: { ...scanner.representation, note: marker } })), "original-scan-representation-unsupported"],
    ["scanner representation v1, coverage v2 (mismatch)", withScanner((scanner) => ({ ...scanner, representation: { ...scanner.representation, version: "aios.image-audit.scan-surface.v1" } })), "original-scan-representation-unsupported"],
    ["coverage representation v1, scanner v2 (mismatch)", (record) => ({ ...record, coverage: { ...record.coverage, representation: "aios.image-audit.scan-surface.v1" } }), "original-scan-representation-unsupported"],
    ["coverage.representation omitted", (record) => ({ ...record, coverage: without(record.coverage, "representation") }), "original-scan-representation-unsupported"],
    ["coverage.archiveSurfaceBytes omitted", (record) => ({ ...record, coverage: without(record.coverage, "archiveSurfaceBytes") }), "original-coverage-malformed"],
    // Canary: nested fields omitted, altered, v1, failed.
    ["canary.status omitted", withScanner((scanner) => ({ ...scanner, capabilityCanary: without(scanner.capabilityCanary, "status") })), "original-scanner-malformed"],
    ["canary.representation omitted", withScanner((scanner) => ({ ...scanner, capabilityCanary: without(scanner.capabilityCanary, "representation") })), "original-scanner-malformed"],
    ["canary.representation v1", withScanner((scanner) => ({ ...scanner, capabilityCanary: { ...scanner.capabilityCanary, representation: "aios.image-audit.scan-surface.v1" } })), "original-scanner-canary-representation-mismatch"],
    ["verified canary without archiveSurfaceDetected", withScanner((scanner) => ({ ...scanner, capabilityCanary: without(scanner.capabilityCanary, "archiveSurfaceDetected") })), "original-scanner-canary-malformed"],
    ["verified canary with archiveSurfaceDetected false", withScanner((scanner) => ({ ...scanner, capabilityCanary: { ...scanner.capabilityCanary, archiveSurfaceDetected: false } })), "original-scanner-canary-malformed"],
    ["verified canary without binaryMagicSkipReproduced", withScanner((scanner) => ({ ...scanner, capabilityCanary: without(scanner.capabilityCanary, "binaryMagicSkipReproduced") })), "original-scanner-canary-malformed"],
    ["verified canary carrying a failure reason", withScanner((scanner, marker) => ({ ...scanner, capabilityCanary: { ...scanner.capabilityCanary, reason: marker } })), "original-scanner-canary-malformed"],
    ["a FAILED canary beside complete coverage", withScanner((scanner) => ({ ...scanner, capabilityCanary: assessCanary({ wrappedFindings: 1, unwrappedFindings: 0, archiveSurfaceFindings: 0 }) })), "original-internally-inconsistent"],
    // F5 — canary TEXT is bound to the producer's constants; anything else is refused, never carried.
    ["a verified canary with an altered note", withScanner((scanner, marker) => ({ ...scanner, capabilityCanary: { ...scanner.capabilityCanary, note: marker } })), "original-scanner-canary-malformed"],
    ["an unverified canary with an arbitrary reason", withScanner((scanner, marker) => ({ ...scanner, capabilityCanary: { ...assessCanary({ wrappedFindings: 0, unwrappedFindings: 0, archiveSurfaceFindings: 1 }), reason: marker } })), "original-scanner-canary-malformed"],
    ["an unverified canary carrying a note", withScanner((scanner, marker) => ({ ...scanner, capabilityCanary: { ...assessCanary({ wrappedFindings: 0, unwrappedFindings: 0, archiveSurfaceFindings: 1 }), note: marker } })), "original-scanner-canary-malformed"],
    // F6 — the archive-surface figure must be consistent with the rest of coverage.
    ["archiveSurfaceBytes greater than stagedBytes", (record) => ({ ...record, coverage: { ...record.coverage, archiveSurfaceBytes: Number(record.coverage.stagedBytes) + 1 } }), "original-internally-inconsistent"],
    ["archiveSurfaceBytes of 0 beside complete coverage of a layer", (record) => ({ ...record, coverage: { ...record.coverage, archiveSurfaceBytes: 0 } }), "original-internally-inconsistent"],
    // Contradictory complete coverage.
    ["complete coverage beside a recorded limitation", (record) => ({ ...record, coverage: { ...record.coverage, limitations: [{ kind: "oversized-member", layer: 0 }] } }), "original-internally-inconsistent"],
  ];

  for (const [label, mutate, code] of rows) {
    it(`${label} → ${code}`, () => {
      const marker = `ZZ-${syntheticSecret("m").slice(1)}`;
      const record = mutate(baseRecord(), marker);
      const result = reconcile(record);
      expect(result.transitionReady).toBe(false);
      expect(result.verdict).toBe("refused");
      expect(codes(result)).toContain(code);
      // Fixed codes only: the rejected value is not echoed anywhere in the public record.
      expect(JSON.stringify(result)).not.toContain(marker);
    });
  }

  it("a COMPLETE pre-remediation v1 original is refused by name, however otherwise valid", () => {
    const v1 = "aios.image-audit.scan-surface.v1";
    const valid = baseRecord();
    const record = {
      ...valid,
      coverage: { ...without(valid.coverage, "archiveSurfaceBytes"), representation: v1 },
      scanner: {
        ...without(valid.scanner, "capabilityCanary"),
        representation: { ...valid.scanner.representation, version: v1 },
        capabilityCanary: { ...without(valid.scanner.capabilityCanary, "archiveSurfaceDetected"), representation: v1 },
      },
    };
    const result = reconcile(record);
    expect(codes(result)).toContain("original-scan-representation-unsupported");
    expect(result.transitionReady).toBe(false);
  });

  it("a FAILED canary on an honestly incomplete record validates as BLOCKED, not refused, and stays blocked", () => {
    const failed = assessCanary({ wrappedFindings: 1, unwrappedFindings: 0, archiveSurfaceFindings: 0 });
    const record = originalAudit({}, { canary: failed, scanner: productionScanner(failed) });
    expect(validateOriginalEvidence(record, SUBJECT).ok).toBe(true);
    const result = reconcile(record);
    expect(result.verdict).not.toBe("refused");
    expect(result.transitionReady).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/binary-scan-capability-unverified/);
    // The substituted dimension is still the only one that moved.
    expect(result.packageInventory).toMatchObject({ source: "operator-evidence", apiStatus: "unverified", status: "verified" });
  });

  it("the table's base record is itself ready — so every refusal above is caused by its one change", () => {
    const result = reconcile(originalAudit());
    expect(result).toMatchObject({ verdict: "clean", transitionReady: true });
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
      // The production UNVERIFIED canary, not a hand-shaped one: it names the v2 representation, so the
      // only thing wrong with this record is the contradiction under test.
      scanner: productionScanner(assessCanary({ wrappedFindings: 0, unwrappedFindings: 0, archiveSurfaceFindings: 1 })),
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

  /**
   * The same allowlist, attacked with a key the rule table INHERITS rather than owns.
   *
   * `pick` resolved its rule with `fields[key]` on a plain object literal, so `fields.constructor`
   * found `Object` through the PROTOTYPE CHAIN — not `undefined` — and the "an unlisted field: refuse"
   * branch never fired. The rule then applied was `Object(value)`, which returns an object argument
   * UNCHANGED, so a nested attacker payload under `constructor` validated and was serialized verbatim
   * into the reconciled record, which is as public as the audit's own artifact. `__proto__`,
   * `hasOwnProperty`, `toString` and `valueOf` reached the same branch: a non-callable rule, or an
   * `Object.prototype` method invoked with no receiver.
   *
   * Refusal is the chosen behaviour for ALL of them, not silent exclusion from the output: this
   * module's stated invariant is that a record carrying a field the audit would never have written is
   * not the shape we wrote, and a key that is a prototype member is no more written than `scratchPath`.
   *
   * One `it` per key rather than a loop, so a key that stops being refused reddens on its own instead
   * of hiding behind whichever key fails first.
   */
  for (const key of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
    it(`REFUSES \`${key}\`, a key the rule table inherits rather than owns`, () => {
      const sentinel = syntheticSecret("proto_");
      const valid = originalAudit();
      // `__proto__` has to be an OWN property, which an object literal cannot express — `JSON.parse`
      // is how it arrives in practice, since the CLI reads the original record from a file. Spread
      // preserves it, because spread DEFINES properties rather than assigning them.
      const smuggled = JSON.parse(`{${JSON.stringify(key)}:{"leaked":${JSON.stringify(sentinel)}}}`) as object;
      const result = reconcile({ ...valid, scanner: { ...(valid.scanner as object), ...smuggled } });

      // The severe property first: whatever the verdict, the payload must not reach the artifact.
      expect(JSON.stringify(result), `\`${key}\` smuggled a value into the reconciled record`).not.toContain(sentinel);
      expect(result.verdict, `a \`${key}\` key was accepted`).toBe("refused");
      expect(codes(result)).toContain("original-scanner-malformed");
    });
  }

  /**
   * The same attack one layer down, where the KEYS are open rather than allowlisted.
   *
   * `provenance.recipe.sourceHashes` is an `objectOf` whose key pattern admits underscores, so
   * `__proto__` passes it — and it is the only pattern-keyed field in this module that does (the
   * others require a leading letter). Without the explicit refusal in `objectOf`, the validator's
   * `out["__proto__"] = "unreadable"` is a SILENT NO-OP on a plain object: the `__proto__` setter
   * ignores a string, so the entry VANISHES from the validated output while the record still
   * validates. Not the `pick` bypass — a different failure mode from the same root-cause family, a
   * plain-object dictionary keyed by a string the record controls — and refused the same way so the
   * two layers cannot disagree about what a prototype key means.
   *
   * The key has to be an OWN property, which object-literal syntax cannot express; `JSON.parse` is
   * both how it arrives in practice (the CLI reads the record from a file) and the only way to build
   * it here. The ordinary sibling is what proves the map would otherwise have been accepted.
   */
  it("REFUSES `__proto__` as a KEY of the open-keyed sourceHashes map", () => {
    const valid = originalAudit();
    const provenance = valid.provenance as { recipe: Record<string, unknown> };
    const sourceHashes = JSON.parse(`{"__proto__":"unreadable","lib/a.ts":"sha256:${"0".repeat(64)}"}`) as object;
    const result = reconcile({
      ...valid,
      provenance: { ...provenance, recipe: { ...provenance.recipe, sourceHashes } },
    });

    expect(result.verdict, "a `__proto__` source-hash key was accepted").toBe("refused");
    expect(codes(result)).toContain("original-recipe-malformed");
    expect(result.transitionReady).toBe(false);
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

  /**
   * THE HEALTHY CANARY — the case this route existed for and could not accept.
   *
   * `assessCanary`'s VERIFIED path always writes a `note`; the validator's `capabilityCanary` shape
   * listed four fields and not that one, and `pick` REFUSES any key nobody listed. So every record
   * whose scanner had actually PROVED it can read the staged representation was refused as
   * `original-scanner-malformed`, and the only canary that ever validated was the unverified one —
   * which carries no `note` and blocks on its own merits. The healthy case was dead on arrival.
   *
   * Built from the production `assessCanary` and `scannerIdentity` through the production
   * `assembleAudit`, because a hand-built canary block is exactly what hid this: it agrees with the
   * validator rather than with what the audit writes. The other positive controls in this file pass a
   * canary-less scanner, so this is the one case that exercises the field the defect was in.
   */
  it("validates an original whose scanner carries a REAL verified capability canary", () => {
    const canary = assessCanary({ wrappedFindings: 1, unwrappedFindings: 0, archiveSurfaceFindings: 1 }) as Record<string, unknown>;
    // The premise, asserted rather than assumed: `note` is present on the verified path only.
    expect(canary.status).toBe("verified");
    expect(typeof canary.note).toBe("string");
    expect(assessCanary({ wrappedFindings: 0, unwrappedFindings: 0, archiveSurfaceFindings: 0 })).not.toHaveProperty("note");

    const record = originalAudit({}, { canary, scanner: productionScanner(canary) });
    // The audit really does carry the canary into the record — otherwise this case proves nothing.
    expect(record.scanner.capabilityCanary).toEqual(canary);

    const result = reconcile(record);
    // The code first: an unlisted `note` refused the whole scanner block as malformed.
    expect(codes(result)).toEqual([]);
    expect(validateOriginalEvidence(record, SUBJECT).ok).toBe(true);
    expect(result.verdict).toBe("clean");
    expect(result.transitionReady).toBe(true);
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
