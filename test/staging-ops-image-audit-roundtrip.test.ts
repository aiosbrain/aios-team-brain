import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SUBJECT } from "../scripts/staging-ops/image-audit/subject.mjs";
import { SCANNER } from "../scripts/staging-ops/image-audit/scanner.mjs";
import { SCAN_REPRESENTATION } from "../scripts/staging-ops/image-audit/scan-surface.mjs";
import { PACKAGE_VERSIONS_URL } from "../scripts/staging-ops/image-audit/registry.mjs";
import { validateOriginalEvidence } from "../scripts/staging-ops/image-audit/original-evidence.mjs";
import { reconcileEvidence } from "../scripts/staging-ops/image-audit/reconcile.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";
import { scanSurface, synthesizeImage } from "./helpers/synthetic-image";

/**
 * AC-AUDIT-08 — PRODUCER TO VALIDATOR, end to end, on a CLEAN run.
 *
 * The positive case the independent evidence review found missing: the scanner record the audit
 * ACTUALLY EMITS — through `runAudit` → `assembleAudit` → `scannerIdentity`, with verified v2 canaries
 * — validated by `validateOriginalEvidence` and reconciled to ready with an otherwise-valid operator
 * inventory. No scanner record here is shaped by hand.
 *
 * WHAT IS SUBSTITUTED, and only this. Three comparisons are against REAL published artifacts pinned in
 * reviewed source, which no synthetic fixture can hash to:
 *   - `verifyManifest`'s pinned-digest comparison — measured against the synthetic manifest's own hash;
 *   - `classifyTagReadback`'s pinned digest — measured against the same synthetic manifest digest, so
 *     a MATCHING tag readback is a real byte comparison of the bytes the tag returns;
 *   - `verifyScannerDownload`'s pinned checksum — measured against the synthetic asset's own hash.
 * Every other decision is production code, and the RECORDED scanner identity is the real, pinned
 * `SCANNER` — the download mock changes what the synthetic asset is compared against, never what the
 * record says was installed.
 *
 * The source tree, `ls-tree`, recipe files and `/app` layer are built from ONE file set, so the
 * inventory, recipe and label checks are satisfied by measurement rather than stubbed.
 */

const state = vi.hoisted(() => ({ manifestDigest: "", assetSha: "", extraScanArgs: [] as string[] }));

vi.mock("../scripts/staging-ops/image-audit/layers.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/staging-ops/image-audit/layers.mjs")>();
  return { ...actual, verifyManifest: (raw: Buffer) => actual.verifyManifest(raw, actual.sha256(raw)) };
});
vi.mock("../scripts/staging-ops/image-audit/registry.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/staging-ops/image-audit/registry.mjs")>();
  return { ...actual, classifyTagReadback: (raw: Buffer | undefined) => actual.classifyTagReadback(raw, state.manifestDigest) };
});
vi.mock("../scripts/staging-ops/image-audit/scanner.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/staging-ops/image-audit/scanner.mjs")>();
  return {
    ...actual,
    /**
     * F7's seam: arguments appended to the invocation the audit really runs, so a test can make the
     * settings READ BACK from that invocation differ from the reviewed policy. Empty by default.
     */
    scannerArgs: (options: Parameters<typeof actual.scannerArgs>[0]) => [...actual.scannerArgs(options), ...state.extraScanArgs],
    verifyScannerDownload: (bytes: Buffer) => {
      const measured = createHash("sha256").update(bytes).digest("hex");
      if (measured !== state.assetSha) throw new Error("synthetic scanner asset mismatch");
      return measured;
    },
  };
});

const { runAudit } = await import("../scripts/staging-ops/image-audit.mjs");

const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

const ASSET = Buffer.from("a synthetic scanner release tarball for the clean roundtrip");

/** ONE file set: the source tree at the pinned revision, and exactly what `/app` ships. */
const SOURCE_FILES: Record<string, string> = {
  ".github/workflows/staging-ops-image.yml":
    "on: workflow_dispatch\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n",
  "docker/staging-ops.Dockerfile": "FROM node:22-slim\nWORKDIR /app\nCOPY . /app\n",
  ".dockerignore": ".git\n.env\n.context\n",
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      "node_modules/left-pad": { resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-synthetic" },
    },
  }),
  "index.js": "export const ok = true;\n",
};

const gitBlob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

/** A PAX global record carrying only opaque metadata — valid, and not a member of the inventory. */
function globalMetadata(marker: string): Buffer {
  const tail = ` comment=${marker}\n`;
  let length = tail.length + 1;
  while (String(length).length + tail.length !== length) length = String(length).length + tail.length;
  const withEnd = buildTar([{ name: "PaxHeader/global", content: `${length}${tail}`, rawTypeflag: "g" }]);
  return withEnd.subarray(0, withEnd.length - 1024); // the record without its archive's end blocks
}

function cleanHarness({ canaryArchiveFindings = 1, packageApiStatus = 403, metadataMarker = "", detectFindingIn = "" } = {}) {
  const layer = buildTar(Object.entries(SOURCE_FILES).map(([path, content]) => ({ name: `app/${path}`, content })));
  const image = synthesizeImage([metadataMarker ? Buffer.concat([globalMetadata(metadataMarker), layer]) : layer]);
  state.manifestDigest = `sha256:${createHash("sha256").update(image.manifestBytes).digest("hex")}`;
  state.assetSha = createHash("sha256").update(ASSET).digest("hex");
  const labels: string[] = [];

  const run = (command: string, args: string[], options: { label: string; cwd?: string }) => {
    labels.push(options.label);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    const report = (body: string) => { writeFileSync(at("--report-path"), body); return Buffer.alloc(0); };
    const hit = () => report(JSON.stringify([{ RuleID: "github-pat", File: "000000.txt" }]));
    switch (options.label) {
      case "manifest-inspect": return image.manifestBytes;
      // The receipt tag resolves to the SAME manifest bytes: a matching readback, measured.
      case "tag-readback": return image.manifestBytes;
      case "image-save": writeFileSync(at("-o"), image.exportTar); return Buffer.alloc(0);
      case "scanner-download": writeFileSync(at("-o"), ASSET); return Buffer.alloc(0);
      case "scanner-version": return Buffer.from(`v${SCANNER.version}\n`);
      case "scanner-help": return Buffer.from(SCANNER.requiredFlags.join("\n"));
      case "scanner-canary-wrapped": return hit();
      case "scanner-canary-unwrapped": return report("[]");
      case "scanner-canary-archive-metadata": return canaryArchiveFindings ? hit() : report("[]");
      // Optionally ONE finding at a staged id under the scan root, reported as the pinned scanner does:
      // an absolute location.
      case "scanner-detect": return report(detectFindingIn
        ? JSON.stringify([{ RuleID: "generic-api-key", File: join(at("--source"), detectFindingIn) }])
        : "[]");
      case "source-checkout": {
        // The checkout lands the source tree on disk, where `readSourceTree` hashes it for real.
        const dir = args[args.indexOf("-C") + 1];
        for (const [path, content] of Object.entries(SOURCE_FILES)) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
        return Buffer.alloc(0);
      }
      case "source-head": return Buffer.from(`${SUBJECT.sourceRevision}\n`);
      case "source-ls-tree":
        return Buffer.from(Object.entries(SOURCE_FILES).map(([path, content]) => `100644 blob ${gitBlob(content)}\t${path}\0`).join(""));
      default: return Buffer.alloc(0);
    }
  };

  const fetchImpl = async (url: string) => {
    if (url.startsWith(PACKAGE_VERSIONS_URL)) {
      // The workflow's own versions read FAILS — the one condition the operator route exists for.
      return { status: packageApiStatus, headers: { get: () => null }, json: async () => ({}) };
    }
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ visibility: "private", repository: { full_name: SUBJECT.repository } }),
    };
  };

  const dir = mkdtempSync(join(tmpdir(), "aios-audit-roundtrip-"));
  scratches.push(dir);
  const env = {
    RUNNER_TEMP: dir,
    AUDIT_EVIDENCE_PATH: join(dir, "staging-ops-image-audit.json"),
    GITHUB_REPOSITORY: SUBJECT.repository,
    GITHUB_RUN_ID: "88",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_TOKEN: "synthetic-token",
  };
  return { env, run, fetchImpl, labels };
}

const operatorInventory = () => ({
  subject: { digest: SUBJECT.digest, package: SUBJECT.package, sourceRevision: SUBJECT.sourceRevision },
  capturedAt: "2026-09-21T12:00:00.000Z",
  coversAllPages: true,
  coversUntagged: true,
  auditedDigest: SUBJECT.digest,
  visibility: "private",
  repositoryLinkage: SUBJECT.repository,
  versions: [{ id: 41, digest: SUBJECT.digest, tags: [] }],
});

describe("the EMITTED record validates and reconciles to ready (AC-AUDIT-08)", () => {
  it("round-trips the record the assembled run actually wrote, with its production scanner identity", async () => {
    const { env, run, fetchImpl } = cleanHarness();
    await runAudit(env, { run, fetchImpl });
    // THE FILE ON DISK — what an operator would hand to `reconcile`, not an in-memory object.
    const record = JSON.parse(readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8"));

    // Every measurement except the package read is clean, by measurement.
    expect(record.provenance.identityVerified).toBe(true);
    expect(record.provenance.tagReadback.status).toBe("confirmed");
    expect(record.provenance.recipe.assertions.every((row: { status: string }) => row.status === "satisfied")).toBe(true);
    expect(record.inventory).toMatchObject({ complete: true, findings: 0 });
    expect(record.coverage).toMatchObject({ complete: true, limitations: [], representation: SCAN_REPRESENTATION.version });
    expect(record.coverage.archiveSurfaceBytes).toBeGreaterThan(0);
    expect(record.packageInventory).toMatchObject({ apiStatus: "unverified", status: "unverified" });
    expect(record.transitionReady).toBe(false);
    expect(record.blockers).toEqual([expect.stringMatching(/package version inventory is unverified/)]);

    // The scanner record is the REAL pinned identity plus every required measurement.
    expect(record.scanner).toMatchObject({
      name: SCANNER.name,
      version: SCANNER.version,
      sha256: SCANNER.sha256,
      configPath: SCANNER.configPath,
      configSha256: SCANNER.configSha256,
      representation: { ...SCAN_REPRESENTATION },
      capabilityCanary: { status: "verified", representation: SCAN_REPRESENTATION.version, archiveSurfaceDetected: true },
    });
    expect(Object.keys(record.scanner).sort()).toEqual(
      ["capabilityCanary", "configPath", "configSha256", "name", "representation", "settings", "sha256", "version"],
    );

    const validated = validateOriginalEvidence(record) as { ok: boolean; observations?: { scanner: unknown } };
    expect(validated.ok).toBe(true);
    expect(validated.observations!.scanner).toEqual(record.scanner);

    const reconciled = reconcileEvidence({ record, operator: operatorInventory() });
    expect(reconciled).toMatchObject({ verdict: "clean", transitionReady: true, blockers: [] });
    // The original API status is preserved, and the subject is the pinned one.
    expect(reconciled.packageInventory).toMatchObject({ source: "operator-evidence", apiStatus: "unverified", status: "verified" });
    expect(reconciled.subject.digest).toBe(SUBJECT.digest);
  });

  it("a MISSED archive-metadata canary stays representable, validates, and cannot become ready", async () => {
    const { env, run, fetchImpl } = cleanHarness({ canaryArchiveFindings: 0 });
    await runAudit(env, { run, fetchImpl });
    const record = JSON.parse(readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8"));
    expect(record.scanner.capabilityCanary).toMatchObject({ status: "unverified", archiveSurfaceDetected: false });
    expect(validateOriginalEvidence(record).ok).toBe(true);
    const reconciled = reconcileEvidence({ record, operator: operatorInventory() });
    expect(reconciled.transitionReady).toBe(false);
    expect(reconciled.blockers.join(" ")).toMatch(/binary-scan-capability-unverified/);
    // The non-package blocker survives the operator substitution verbatim.
    expect(reconciled.packageInventory).toMatchObject({ status: "verified", apiStatus: "unverified" });
  });

  it("a marker in layer METADATA reaches the scan surface, and neither it nor a scratch path reaches the record", async () => {
    const marker = syntheticSecret();
    const { env, run, fetchImpl } = cleanHarness({ metadataMarker: marker });
    const record = await runAudit(env, { run, fetchImpl });
    // Scanned: the run's own scan tree (scratch under RUNNER_TEMP) carries the marker.
    const scratch = readdirSync(env.RUNNER_TEMP).find((entry) => entry.startsWith("aios-image-audit-"))!;
    expect(scanSurface(join(env.RUNNER_TEMP, scratch, "scan"))).toContain(marker);
    // Opaque global metadata is not an inventory member, so the clean measurements are unchanged.
    expect(record.coverage.complete).toBe(true);
    // Not published.
    const written = readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8");
    expect(written).not.toContain(env.RUNNER_TEMP);
    expect(written).not.toContain(marker);
  });

  /**
   * F7 — the producer's settings refusal is a CALL SITE, pinned here. Removing it from `runAudit` used
   * to leave every test green: the settings were validated only by the reconciliation.
   */
  it("REFUSES a run whose invocation's settings are not the reviewed policy (AC-AUDIT-06)", async () => {
    state.extraScanArgs = ["--max-archive-depth", "3"];
    try {
      const { env, run, fetchImpl, labels } = cleanHarness();
      await expect(runAudit(env, { run, fetchImpl })).rejects.toMatchObject({ code: "AUDIT_SCANNER_SETTINGS_UNSUPPORTED" });
      // The scan did run — the refusal is of the record it would have produced, not of the scan.
      expect(labels).toContain("scanner-detect");
      const written = JSON.parse(readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8"));
      expect(written).toMatchObject({ verdict: "refused", transitionReady: false, failure: { errorCode: "AUDIT_SCANNER_SETTINGS_UNSUPPORTED" } });
    } finally {
      state.extraScanArgs = [];
    }
  });

  /**
   * F7 — a finding in an ARCHIVE-SURFACE file is attributed to the fixed `archive-metadata` category and
   * its layer, never to a path. Removing that branch of `publicPathResolver` used to survive every test.
   */
  it("attributes a finding in archive metadata to the fixed category and layer, with no path", async () => {
    const { env, run, fetchImpl } = cleanHarness({ detectFindingIn: "L0/M/000000.txt" });
    const record = await runAudit(env, { run, fetchImpl });
    expect(record.findings.total).toBe(1);
    const [occurrence] = record.findings.groups[0].occurrences;
    expect(occurrence.category).toBe("archive-metadata");
    expect(occurrence.layer).toBe(0);
    expect(occurrence.path).toBeUndefined();
    // …and the artifact on disk names no path for it either.
    const written = JSON.parse(readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8"));
    expect(written.findings.groups[0].occurrences[0]).not.toHaveProperty("path");
    expect(record.transitionReady).toBe(false);
  });

  it("the SAME emitted record is refused once any required scanner measurement is removed", async () => {
    const { env, run, fetchImpl } = cleanHarness();
    await runAudit(env, { run, fetchImpl });
    const record = JSON.parse(readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8"));
    for (const field of ["configSha256", "settings", "representation", "capabilityCanary"]) {
      const { [field]: _dropped, ...scanner } = record.scanner;
      const reconciled = reconcileEvidence({ record: { ...record, scanner }, operator: operatorInventory() });
      expect(reconciled.verdict, field).toBe("refused");
      expect(reconciled.transitionReady, field).toBe(false);
    }
  });
});
