import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FIELDS,
  allowlistRecord,
  buildEvidence,
  describeLimitations,
  evidenceLeakFailures,
  safeOccurrence,
  sanitizedFailure,
  scannerIdentity,
  transitionReadiness,
} from "../scripts/staging-ops/image-audit/evidence.mjs";
import {
  CHECKSUM_UNRECORDED,
  SCANNER,
  ScannerReportError,
  assertScannerPinned,
  normalizeScanLocation,
  scannerArgs,
  scannerInterfaceFailures,
  scannerSettings,
  scannerVersionFailures,
  summarizeFindings,
  validateReport,
  verifyScannerDownload,
} from "../scripts/staging-ops/image-audit/scanner.mjs";
import { syntheticSecret } from "./helpers/tar-fixture";

/** The shapes read off the summariser. Narrow local types, so no fixture needs `any`. */
interface Occurrence {
  path?: string;
  category: string;
  layer?: number;
  occurrenceId: string;
}
interface FindingGroup {
  rule: string;
  count: number;
  occurrences: Occurrence[];
}

/**
 * PUB-04's redaction rows, and PUB-03's scanner-pinning rows.
 *
 * The sentinel tests are the load-bearing ones. Each plants a per-run synthetic secret in the place a
 * leak would come from — a scanner match, an error message, a subprocess diagnostic — and asserts it
 * does not survive into the artifact. A repository this public turns one leak into a permanent one.
 */

const clean = {
  coverage: { complete: true, limitations: [] },
  inventory: { complete: true, findings: 0, counts: { missing: 0 } },
  findings: { total: 0, rules: 0, groups: [] },
  packageInventory: { status: "verified", otherVersions: 0 },
  identityVerified: true,
  recipe: { assertions: [{ id: "workflow.no-secret-refs", status: "satisfied" }] },
};

describe("the verdict is DERIVED from what was measured (PUB-03, PUB-05)", () => {
  it("is clean and transition-ready only when every measurement is complete and empty", () => {
    const readiness = transitionReadiness(clean);
    expect(readiness).toMatchObject({ verdict: "clean", transitionReady: true });
    expect(readiness.blockers).toEqual([]);
  });

  /** THE DEFECT THIS EXISTS FOR: "no findings" and "nothing was measured" reading the same. */
  it("blocks on a COVERAGE GAP even with zero findings", () => {
    const readiness = transitionReadiness({
      ...clean,
      coverage: { complete: false, limitations: [{ kind: "unexpanded-archive-format" }] },
    });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.verdict).toBe("incomplete");
    expect(readiness.blockers.join(" ")).toMatch(/coverage is incomplete/);
  });

  /**
   * …and the blocker has to be READABLE. Interpolating the limitation objects produced
   * `content coverage is incomplete: [object Object]` — a blocker that names a real gap and tells a
   * coordinator nothing about which gap it was.
   */
  it("describes a coverage gap by KIND, layer and count — never as [object Object]", () => {
    const readiness = transitionReadiness({
      ...clean,
      coverage: {
        complete: false,
        limitations: [
          { kind: "unexpanded-archive-format", layer: 0, extension: ".zip" },
          { kind: "unexpanded-archive-format", layer: 2, extension: ".whl" },
          { kind: "oversized-member", layer: 1, bytes: 4096 },
        ],
      },
    });
    const blocker = readiness.blockers.join(" ");
    expect(blocker).not.toContain("[object Object]");
    expect(blocker).toContain("2× unexpanded-archive-format in layers 0,2");
    expect(blocker).toContain("1× oversized-member in layer 1");
  });

  it("maps ONLY the fixed limitation fields into a blocker, never archive-derived text", () => {
    // `extension`, `bytes`, `typeflag` and `reason` all originate in archive content, and a blocker
    // string goes into the PUBLIC artifact. An unrecognised kind is reported as a category too.
    const described = describeLimitations([
      { kind: "nested-archive-undecodable", layer: 3, reason: "Error", extension: ".tgz", bytes: 99 },
      { kind: "app/secret path.pem", layer: 4 },
    ]);
    for (const leaked of [".tgz", "99", "secret", "Error"]) expect(described).not.toContain(leaked);
    expect(described).toContain("1× nested-archive-undecodable in layer 3");
    expect(described).toContain("unrecorded-limitation");
    // An empty list must not read as a described gap.
    expect(describeLimitations([])).toBe("unrecorded limitation");
  });

  it("blocks on an UNVERIFIED package inventory rather than inferring an empty package", () => {
    const readiness = transitionReadiness({ ...clean, packageInventory: { status: "unverified" } });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/inventory is unverified/);
  });

  it("blocks when other package versions exist, however clean this digest is", () => {
    const readiness = transitionReadiness({ ...clean, packageInventory: { status: "verified", otherVersions: 3 } });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/3 other package version/);
  });

  it("blocks on scanner findings, on inventory findings, and on unverified identity", () => {
    expect(transitionReadiness({ ...clean, findings: { total: 2, rules: 1 } }).verdict).toBe("findings");
    expect(transitionReadiness({ ...clean, inventory: { complete: true, findings: 1, counts: {} } }).verdict).toBe("findings");
    expect(transitionReadiness({ ...clean, identityVerified: false }).transitionReady).toBe(false);
  });

  /**
   * M3's recipe rows, wired to the gate. `recipe.mjs` promised that unknown assertions block; the
   * readiness computation had no recipe parameter at all, so the promise was kept nowhere and a
   * violated build-recipe assertion could ride inside a `clean` verdict.
   */
  it("blocks on a VIOLATED build-recipe assertion, as a question for adjudication", () => {
    const readiness = transitionReadiness({
      ...clean,
      recipe: { assertions: [{ id: "dockerfile.no-build-args", status: "violated" }, { id: "x", status: "satisfied" }] },
    });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/1 build-recipe assertion\(s\) are VIOLATED/);
    // NOT re-labelled as a secret finding: the recipe did not measure as expected, which is a
    // coordinator question, and calling it a finding would misreport what was observed.
    expect(readiness.verdict).toBe("unresolved");
  });

  it("blocks on an UNVERIFIED recipe assertion — an assertion nobody could evaluate is a gap", () => {
    const readiness = transitionReadiness({
      ...clean,
      recipe: { assertions: [{ id: "lockfile.readable", status: "unverified" }] },
    });
    expect(readiness.transitionReady).toBe(false);
    expect(readiness.blockers.join(" ")).toMatch(/unverified/);
  });

  /** FAIL-CLOSED: a caller that forgets to pass the recipe can only ever cause a false BLOCK. */
  it("blocks when the recipe is missing entirely, or measured nothing", () => {
    const { recipe: _recipe, ...withoutRecipe } = clean;
    expect(transitionReadiness(withoutRecipe).transitionReady).toBe(false);
    expect(transitionReadiness(withoutRecipe).blockers.join(" ")).toMatch(/were not measured/);
    expect(transitionReadiness({ ...clean, recipe: { assertions: [] } }).transitionReady).toBe(false);
    expect(transitionReadiness({ ...clean, recipe: {} }).blockers.join(" ")).toMatch(/no assertions at all/);
    // A status this module does not recognise is not a pass either.
    expect(transitionReadiness({ ...clean, recipe: { assertions: [{ id: "x", status: "probably" }] } }).transitionReady).toBe(false);
  });

  it("cannot be handed a ready verdict — readiness has no input that sets it", () => {
    // `transitionReady: true` is not a parameter. Passing one changes nothing, which is the property:
    // the gate reads a computation, not a claim.
    const readiness = transitionReadiness({ ...clean, transitionReady: true, verdict: "clean", packageInventory: { status: "unverified" } } as never);
    expect(readiness.transitionReady).toBe(false);
  });
});

describe("the artifact is an ALLOWLIST, and it refuses to leak (PUB-04)", () => {
  it("drops any field nobody listed", () => {
    const record = allowlistRecord({ verdict: "clean", rawScannerOutput: "everything", scratchPath: "/tmp/x" });
    expect(Object.keys(record)).toEqual(["verdict"]);
    expect(EVIDENCE_FIELDS).not.toContain("rawScannerOutput");
  });

  it("REFUSES to build a record containing a planted sentinel", () => {
    const secret = syntheticSecret();
    expect(() => buildEvidence(
      { verdict: "findings", blockers: [`a match was found: ${secret}`], ...clean },
      { forbidden: [secret] },
    )).toThrow(/leaks/);
  });

  it("refuses credential-shaped values and private-key blocks wherever they hide", () => {
    expect(evidenceLeakFailures({ subject: { note: `ghp_${"A".repeat(30)}` } })).not.toEqual([]);
    expect(evidenceLeakFailures({ provenance: { detail: "-----BEGIN RSA PRIVATE KEY-----" } })).not.toEqual([]);
    expect(evidenceLeakFailures({ coverage: { url: "postgres://user:hunter2@db:5432/app" } })).not.toEqual([]);
    expect(evidenceLeakFailures({ audit: { dockerconfig: "x" } })).not.toEqual([]);
    expect(evidenceLeakFailures({ verdict: "clean", coverage: { complete: true } })).toEqual([]);
  });

  it("emits an occurrence WITHOUT a path unless the caller established one as public", () => {
    const unresolved = safeOccurrence({ category: "unresolved", layer: 3 });
    expect(unresolved.path).toBeUndefined();
    expect(unresolved).toMatchObject({ category: "unresolved", layer: 3 });
    expect(unresolved.occurrenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(safeOccurrence({ path: "app/package.json", category: "public-source-path" }).path).toBe("app/package.json");
  });

  it("gives every occurrence a DISTINCT random id, so ids cannot be correlated as a hash would be", () => {
    const ids = new Set(Array.from({ length: 50 }, () => safeOccurrence({ category: "unresolved" }).occurrenceId));
    expect(ids.size).toBe(50);
  });

  it("keeps a failure diagnostic OUT of the record entirely", () => {
    const secret = syntheticSecret();
    const error = Object.assign(new Error(`scanner said: ${secret} in /tmp/scan/L2/000031.pem`), { code: "AUDIT_SUBPROCESS_EXIT" });
    const failure = sanitizedFailure({ stage: "scan", error, counters: { layers: 7 } });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain("000031");
    // What survives is the SHAPE of the failure, which is what a coordinator needs to decide whether
    // to rerun — not the text, which is what would leak.
    expect(failure).toMatchObject({ stage: "scan", errorCode: "AUDIT_SUBPROCESS_EXIT", counters: { layers: 7 } });
  });

  it("refuses an error whose `code` or `name` is itself attacker-shaped text", () => {
    const secret = syntheticSecret();
    const failure = sanitizedFailure({ stage: "scan", error: { name: `Error ${secret}`, code: secret } });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failure.errorName).toBe("Error");
    expect(failure.errorCode).toBeUndefined();
  });

  it("rejects a verdict outside the closed set", () => {
    expect(() => buildEvidence({ verdict: "probably-fine" })).toThrow(/not one of/);
  });
});

describe("findings are grouped, and only allowlisted report fields are read (PUB-03, PUB-04)", () => {
  const report = [
    { RuleID: "generic-api-key", File: "L2/000031.json", Match: "TOKEN=SUPER", Secret: "SUPER", Fingerprint: "app/x.json:generic:4", Commit: "abc", Author: "someone" },
    { RuleID: "generic-api-key", File: "L2/000032.json", Match: "TOKEN=OTHER", Secret: "OTHER" },
    { RuleID: "private-key", File: "L0/000001.pem", Secret: "-----BEGIN" },
  ];

  it("groups by rule and counts occurrences", () => {
    const summary = summarizeFindings(report);
    expect(summary.total).toBe(3);
    expect(summary.rules).toBe(2);
    expect(summary.groups.find((g: FindingGroup) => g.rule === "generic-api-key").count).toBe(2);
  });

  it("carries NO match, secret, fingerprint, commit or author into the summary", () => {
    const serialized = JSON.stringify(summarizeFindings(report));
    for (const leaked of ["SUPER", "OTHER", "-----BEGIN", "abc", "someone", "app/x.json"]) {
      expect(serialized, `the summary carries ${leaked}`).not.toContain(leaked);
    }
  });

  it("records the layer index from the scratch id, and no filename", () => {
    const summary = summarizeFindings(report);
    const layers = summary.groups.flatMap((g: FindingGroup) => g.occurrences.map((o: Occurrence) => o.layer));
    expect(layers.sort()).toEqual([0, 2, 2]);
    expect(JSON.stringify(summary)).not.toContain("000031");
  });

  it("names a path ONLY when the resolver says it is public and non-sensitive", () => {
    const summary = summarizeFindings(report, {
      resolvePath: (id: string) => (id === "L2/000031.json"
        ? { publicPath: "app/test/fixtures/sample.json", category: "public-source-path" }
        : { category: "unresolved" }),
    });
    const occurrences = summary.groups.flatMap((g: FindingGroup) => g.occurrences);
    expect(occurrences.filter((o: Occurrence) => o.path)).toHaveLength(1);
    expect(occurrences.filter((o: Occurrence) => o.category === "unresolved")).toHaveLength(2);
  });

  /**
   * THE DEFECT THIS REPLACES. `summarizeFindings` used to turn ANY non-array JSON into `[]`, so a
   * scanner that exited 0 having written `{}`, `null` or one bare object produced `total: 0` — the
   * cleanest possible result, from a run that never reported what it found. The old case here
   * asserted exactly that coercion ("survives a malformed report") and had to go.
   */
  it("REFUSES a report that is not a findings array, rather than reading it as clean", () => {
    for (const malformed of [undefined, null, {}, { findings: [] }, "[]", 0, [[]]]) {
      expect(() => summarizeFindings(malformed), `${JSON.stringify(malformed) ?? "undefined"} was coerced`)
        .toThrow(ScannerReportError);
    }
  });

  it("REFUSES an entry that carries no rule or no location", () => {
    expect(() => summarizeFindings([{ File: "L1/000001.json" }])).toThrow(/carries no RuleID/);
    expect(() => summarizeFindings([{ RuleID: "", File: "L1/000001.json" }])).toThrow(/carries no RuleID/);
    expect(() => summarizeFindings([{ RuleID: "generic-api-key" }])).toThrow(/carries no File location/);
    expect(() => summarizeFindings([{ RuleID: "generic-api-key", File: "" }])).toThrow(/carries no File location/);
    expect(() => summarizeFindings([null])).toThrow(/is not an object/);
  });

  it("carries NO entry content in the refusal, only a fixed reason and an index", () => {
    const secret = syntheticSecret();
    let message = "";
    try {
      validateReport([{ RuleID: "generic-api-key", File: `/scratch/scan/L0/${secret}.pem`, Secret: secret }, { Secret: secret }]);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/entry 1 carries no RuleID/);
    expect(message).not.toContain(secret);
  });

  /** A VALID empty array is the genuine clean case, and must still pass. */
  it("accepts a valid EMPTY report as a measured zero", () => {
    const summary = summarizeFindings([]);
    expect(summary).toMatchObject({ total: 0, rules: 0 });
    expect(summary.groups).toEqual([]);
    expect(validateReport([])).toEqual([]);
  });
});

/**
 * PUB-03/PUB-04's location handling, against the shape the PINNED scanner actually emits.
 *
 * MEASURED, NOT ASSUMED: gitleaks 8.28.0 writes an ABSOLUTE `File` (the coordinator's interface probe
 * records `/…/source/L0/sample.txt` for a scan rooted at `/…/source`). The ids this audit staged are
 * relative to the scan root, so looking the raw value up in the staged map found nothing and reported
 * every real finding as `unresolved` — an attribution that never happened, reading like one that did.
 */
describe("a finding's location is normalized against the scan root (PUB-03)", () => {
  const root = join("/scratch", "aios-image-audit-abc", "scan");

  it("resolves an ABSOLUTE in-root location to the staged id", () => {
    expect(normalizeScanLocation(join(root, "L3", "000412.json"), { scanRoot: root }))
      .toEqual({ id: "L3/000412.json", nested: false });
  });

  it("accepts a legitimate source-relative id", () => {
    expect(normalizeScanLocation("L0/000000.pem", { scanRoot: root })).toEqual({ id: "L0/000000.pem", nested: false });
    expect(normalizeScanLocation("./image-config.json", { scanRoot: root })).toEqual({ id: "image-config.json", nested: false });
    // …and with no root to resolve against, only an already-relative id is trusted.
    expect(normalizeScanLocation("L0/000000.pem")).toEqual({ id: "L0/000000.pem", nested: false });
  });

  it("REFUSES a location outside the scan root, however it is spelled", () => {
    // `path.relative` alone would happily return `../../etc/passwd` and call it a relative id.
    for (const outside of [
      "/etc/passwd",
      join(root, "..", "..", "etc", "passwd"),
      "../../etc/passwd",
      `${root}-sibling/L0/000000.txt`,
      root,
    ]) {
      expect(normalizeScanLocation(outside, { scanRoot: root }).id, `${outside} was accepted`).toBeUndefined();
    }
    expect(normalizeScanLocation("/etc/passwd").outcome).toBe("out-of-root");
    expect(normalizeScanLocation("../x").outcome).toBe("out-of-root");
  });

  it("REFUSES an empty or NUL-bearing location", () => {
    expect(normalizeScanLocation("", { scanRoot: root }).outcome).toBe("malformed");
    expect(normalizeScanLocation(undefined, { scanRoot: root }).outcome).toBe("malformed");
    // The NUL is written as an ESCAPE. A literal control byte is invisible in review, and one in a
    // source file makes git treat it as binary.
    const nulBearing = `L0/000000${String.fromCharCode(0)}.json`;
    expect(normalizeScanLocation(nulBearing, { scanRoot: root }).outcome).toBe("malformed");
  });

  it("assigns the layer index and the resolver's category from the NORMALIZED id", () => {
    const staged = new Map([["L2/000031.json", { name: "app/node_modules/pkg/fixture.json", layer: 2, depth: 0 }]]);
    const summary = summarizeFindings(
      [
        { RuleID: "generic-api-key", File: join(root, "L2", "000031.json") },
        { RuleID: "generic-api-key", File: join(root, "image-config.json") },
      ],
      {
        scanRoot: root,
        resolvePath: (id: string) => (id === "image-config.json"
          ? { category: "image-config" }
          : staged.has(id) ? { category: "npm-dependency" } : { category: "unresolved" }),
      },
    );
    const occurrences: Occurrence[] = summary.groups[0].occurrences;
    expect(occurrences.map((o) => o.category)).toEqual(["npm-dependency", "image-config"]);
    // The layer comes from the id this audit chose, which is the whole reason locations are staged
    // under generated names.
    expect(occurrences.map((o) => o.layer)).toEqual([2, undefined]);
    // The CONFIG's finding keeps its own category rather than being attributed to a layer member —
    // `Env`, `Labels` and history live there, and none of those values are emitted.
    expect(JSON.stringify(summary)).not.toContain("000031");
    expect(JSON.stringify(summary)).not.toContain("scratch");
  });

  it("keeps an unattributable location as a finding, with a fixed outcome and no raw path", () => {
    const summary = summarizeFindings([{ RuleID: "private-key", File: "/etc/ssl/private/host.pem" }], { scanRoot: root });
    expect(summary.total).toBe(1);
    const [occurrence] = summary.groups[0].occurrences;
    expect(occurrence).toMatchObject({ category: "location-out-of-root" });
    expect(occurrence.path).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain("host.pem");
  });

  it("marks a finding INSIDE a traversed archive as nested content, not as the wrapper's provenance", () => {
    // Archive traversal is off at this version's default, but if a `!` location ever arrives the
    // inner path is dropped and the occurrence must not inherit the wrapper file's public path.
    const summary = summarizeFindings(
      [{ RuleID: "generic-api-key", File: `${join(root, "L1", "000002.gz")}!inner/.env.prod` }],
      { scanRoot: root, resolvePath: () => ({ publicPath: "app/vendor/bundle.gz", category: "public-source-path" }) },
    );
    const [occurrence] = summary.groups[0].occurrences;
    expect(occurrence.category).toBe("nested-archive-content");
    expect(occurrence.path).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(".env.prod");
  });
});

describe("the scanner is pinned, verified and MEASURED (PUB-03)", () => {
  const pinned = { ...SCANNER, sha256: "a".repeat(64) };

  /**
   * THE MEASURED PIN. `gitleaks_8.28.0_linux_x64.tar.gz`, from the release's own checksums file with
   * the downloaded asset agreeing. This assertion is the reason a later edit cannot quietly change
   * which bytes the audit will accept: the value lives in one place and is stated here too.
   */
  it("carries the measured checksum for the pinned linux asset", () => {
    expect(SCANNER.version).toBe("8.28.0");
    expect(SCANNER.assetUrl(SCANNER.version)).toBe(
      "https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz",
    );
    expect(SCANNER.sha256).toBe("a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb");
    expect(() => assertScannerPinned()).not.toThrow();
  });

  /**
   * The fail-closed behaviour is RETAINED, and injected rather than shipped. It protected this file
   * while the checksum was genuinely unknown; now that the value is recorded, the sentinel and the
   * shape check are what stop a future edit from re-introducing an unverified download.
   */
  it("refuses an unrecorded or malformed checksum, with a fixed code", () => {
    for (const bad of [CHECKSUM_UNRECORDED, "", undefined, "a".repeat(63), `${"a".repeat(63)}Z`, "0x" + "a".repeat(62)]) {
      expect(() => assertScannerPinned({ ...SCANNER, sha256: bad }), `${String(bad)} was accepted as a pin`)
        .toThrow(/checksum is not recorded/);
    }
    // The code, not the message, is what the sanitized evidence record can carry.
    try {
      assertScannerPinned({ ...SCANNER, sha256: CHECKSUM_UNRECORDED });
      expect.unreachable("an unrecorded checksum was accepted");
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe("AUDIT_SCANNER_UNPINNED");
    }
  });

  it("refuses a download whose bytes do not hash to the pin", () => {
    expect(() => verifyScannerDownload(Buffer.from("not the release"), pinned)).toThrow(/hashes to/);
    // …and the real pin is not satisfied by arbitrary bytes either: the check is the hash, not the
    // presence of a hash-shaped string.
    expect(() => verifyScannerDownload(Buffer.from("not the release"), SCANNER)).toThrow(/hashes to/);
  });

  it("refuses a binary whose reported version is not the pinned one", () => {
    expect(scannerVersionFailures(`v${SCANNER.version}`, pinned)).toEqual([]);
    expect(scannerVersionFailures("v8.18.4", pinned)).toHaveLength(1);
  });

  /** The spec's own warning: capabilities must be checked at the ACTUAL pinned version. */
  it("refuses a binary that does not offer a flag this audit passes", () => {
    const full = SCANNER.requiredFlags.join(" ");
    expect(scannerInterfaceFailures(full, pinned)).toEqual([]);
    expect(scannerInterfaceFailures(full.replace("--max-target-megabytes", ""), pinned))
      .toEqual([`gitleaks ${SCANNER.version} does not offer --max-target-megabytes`]);
  });

  it("invokes the scanner with the AUDIT's config, redaction, a scratch report and no size cap", () => {
    const args = scannerArgs({ sourceDir: "/scratch/scan", reportPath: "/scratch/logs/r.json", configPath: "cfg.toml" });
    expect(args).toContain("--redact");
    expect(args).toContain("--no-git");
    expect(args[args.indexOf("--config") + 1]).toBe("cfg.toml");
    expect(args[args.indexOf("--report-path") + 1]).toBe("/scratch/logs/r.json");
    // 0 = no cap: a silently skipped large file is the uninspected limitation the spec forbids
    // leaving unreported.
    expect(args[args.indexOf("--max-target-megabytes") + 1]).toBe("0");
    // A finding must not be an error exit — the audit adjudicates findings, and a non-zero exit is
    // indistinguishable from the scanner having crashed.
    expect(args[args.indexOf("--exit-code") + 1]).toBe("0");
  });

  it("records the scanner's identity INCLUDING the hash of the config it ran with", () => {
    const identity = scannerIdentity(SCANNER, "[extend]\nuseDefault = true\n");
    expect(identity).toMatchObject({ name: "gitleaks", version: SCANNER.version, sha256: SCANNER.sha256 });
    // Rules decide what a PASS means, so a pass is only interpretable next to the config that
    // produced it. A path alone would not distinguish two different files at the same path.
    expect(identity.configSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * PUB-03 requires the scanner's archive-traversal and file-size settings to be documented next to
   * what was skipped. Derived FROM the argument list, so the record cannot drift from the invocation.
   */
  it("records the coverage-relevant settings read back from the arguments that ran", () => {
    const settings = scannerSettings(scannerArgs({ sourceDir: "/scratch/scan", reportPath: "/scratch/logs/r.json" }));
    expect(settings.maxTargetMegabytes).toBe("0");
    expect(settings.maxArchiveDepth).toMatch(/archive traversal disabled/);
    expect(scannerIdentity(SCANNER, "x", { settings }).settings).toBe(settings);
    // No scratch path leaks into the settings the artifact carries.
    expect(JSON.stringify(settings)).not.toContain("/scratch");
    // A changed invocation changes the record: this is the drift the derivation prevents.
    expect(scannerSettings(["detect", "--max-target-megabytes", "50"]).maxTargetMegabytes).toBe("50");
  });
});
