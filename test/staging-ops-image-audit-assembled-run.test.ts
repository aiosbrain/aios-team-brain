import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SUBJECT, SUBJECT_REFERENCE } from "../scripts/staging-ops/image-audit/subject.mjs";
import { SCANNER } from "../scripts/staging-ops/image-audit/scanner.mjs";
import { PACKAGE_VERSIONS_URL } from "../scripts/staging-ops/image-audit/registry.mjs";
import { PACKAGE_METADATA_URL } from "../scripts/staging-ops/image-publication.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";
import { synthesizeImage } from "./helpers/synthetic-image";

/**
 * PUB-07's ASSEMBLED RUN: `runAudit` driven end to end with every external command and API answer
 * substituted, and every decision, inspection and assembly below them left as production code.
 *
 * WHY THIS FILE EXISTS. The audit's helpers were each well tested and NOTHING pinned their call
 * sites. `runCapabilityCanary`, the scanner isolation, the measured package identity and the
 * inspection's deadline could each have been deleted from the dispatcher with every helper test
 * still green — the exact failure this repository keeps hitting (a helper with a dozen green tests
 * whose wiring can be removed without reddening one of them).
 *
 * THE ONE SUBSTITUTION THAT IS NOT AN EXTERNAL ANSWER, stated plainly: `verifyManifest`'s
 * PINNED-DIGEST comparison. The audit's subject is a real published artifact's digest in reviewed
 * source, so no synthetic manifest can ever hash to it, and there is no injection point for the
 * subject — deliberately, because "the audited digest comes from reviewed source, never from an
 * input" is the property that makes the audit about one artifact. The mock below still runs the
 * REAL `verifyManifest` — media types, config descriptor, every layer's digest and media type — and
 * only measures it against the manifest's own hash instead of the pinned one. Everything the manifest
 * check does other than that comparison is therefore still under test here, and the comparison
 * itself is covered by `layers`' own suite.
 */
vi.mock("../scripts/staging-ops/image-audit/layers.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scripts/staging-ops/image-audit/layers.mjs")>();
  return {
    ...actual,
    verifyManifest: (raw: Buffer, _pinnedDigest: string) => actual.verifyManifest(raw, actual.sha256(raw)),
  };
});

const { runAudit } = await import("../scripts/staging-ops/image-audit.mjs");

const scratches: string[] = [];
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "aios-audit-run-"));
  scratches.push(dir);
  return dir;
};
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

interface Invocation { command: string; args: string[]; label: string; cwd?: string }

/** A pinned scanner whose checksum is the checksum of the bytes this run's `curl` "downloads". */
const ASSET = Buffer.from("a synthetic scanner release tarball");
const scanner = Object.freeze({ ...SCANNER, sha256: createHash("sha256").update(ASSET).digest("hex") });

/**
 * Every external command the audit shells out to, answered. The audit's own code decides what to do
 * with each answer; nothing here simulates a decision.
 */
function harness({ canaryWrappedFindings = 1, scanReport = "[]" } = {}) {
  const secret = syntheticSecret();
  const image = synthesizeImage([buildTar([
    { name: "app/index.js", content: "export const ok = true;\n" },
    // A gzip of plaintext, so the run exercises a real nested expansion rather than flat members.
    { name: "app/notes.gz", content: gzipSync(Buffer.from(`NOTE=${secret}`)) },
  ])]);
  const invocations: Invocation[] = [];
  const fetched: string[] = [];

  const run = (command: string, args: string[], options: { label: string; cwd?: string }) => {
    invocations.push({ command, args, label: options.label, cwd: options.cwd });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    const report = (body: string) => { writeFileSync(at("--report-path"), body); return Buffer.alloc(0); };
    switch (options.label) {
      case "manifest-inspect": return image.manifestBytes;
      // A tag that resolves to OTHER bytes: the readback is a real measurement and this run is not
      // about it. It makes the assembled verdict non-clean, which the assertions below account for.
      case "tag-readback": return Buffer.from('{"mediaType":"application/vnd.oci.image.manifest.v1+json"}');
      case "image-save": writeFileSync(at("-o"), image.exportTar); return Buffer.alloc(0);
      case "scanner-download": writeFileSync(at("-o"), ASSET); return Buffer.alloc(0);
      case "scanner-version": return Buffer.from(`v${scanner.version}\n`);
      case "scanner-help": return Buffer.from(scanner.requiredFlags.join("\n"));
      case "scanner-canary-wrapped": return report(JSON.stringify(
        Array.from({ length: canaryWrappedFindings }, () => ({ RuleID: "github-pat", File: "000000.txt" })),
      ));
      case "scanner-canary-unwrapped": return report("[]");
      case "scanner-detect": return report(scanReport);
      case "source-head": return Buffer.from(`${SUBJECT.sourceRevision}\n`);
      case "source-ls-tree": return Buffer.from("");
      default: return Buffer.alloc(0);
    }
  };

  const fetchImpl = async (url: string) => {
    fetched.push(url);
    if (url.startsWith(PACKAGE_VERSIONS_URL)) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => [{ id: 41, name: SUBJECT.digest, metadata: { container: { tags: [] } } }],
      };
    }
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ visibility: "private", repository: { full_name: SUBJECT.repository } }),
    };
  };

  const dir = workspace();
  const env = {
    RUNNER_TEMP: dir,
    AUDIT_EVIDENCE_PATH: join(dir, "staging-ops-image-audit.json"),
    GITHUB_REPOSITORY: SUBJECT.repository,
    GITHUB_RUN_ID: "77",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_TOKEN: "synthetic-token",
  };
  return { env, run, fetchImpl, invocations, fetched, secret, image };
}

const labels = (invocations: Invocation[]) => invocations.map((invocation) => invocation.label);

describe("the assembled run wires every measured stage into the record (PUB-07, F1, F4, F13)", () => {
  it("measures the capability canary BEFORE the real scan, and records its answer", async () => {
    const { env, run, fetchImpl, invocations } = harness({ canaryWrappedFindings: 1 });
    const record = await runAudit(env, { run, fetchImpl, scanner });

    // THE CALL SITE, not the helper: both canary fixtures were actually scanned by the binary this
    // run installed. Deleting `runCapabilityCanary(...)` from the dispatcher removes both labels.
    expect(labels(invocations)).toContain("scanner-canary-wrapped");
    expect(labels(invocations)).toContain("scanner-canary-unwrapped");
    // …and BEFORE the real scan, which is the ordering F1 asks for: a zero-finding report must not
    // already be assembled into something clean-looking before the capability is known.
    expect(labels(invocations).indexOf("scanner-canary-wrapped"))
      .toBeLessThan(labels(invocations).indexOf("scanner-detect"));

    expect(record.scanner.capabilityCanary).toMatchObject({ status: "verified", binaryMagicSkipReproduced: true });
    // The canary's own synthetic findings are counted and DISCARDED — they are not about the image.
    expect(record.findings.total).toBe(0);
    expect(record.coverage.limitations).not.toContainEqual({ kind: "binary-scan-capability-unverified" });
  });

  it("folds an UNVERIFIED canary into the record's coverage, where it blocks", async () => {
    // The same run, with the pinned binary failing to detect its own sentinel in this audit's
    // representation. Every binary-magic member's byte coverage is then unverified.
    const { env, run, fetchImpl } = harness({ canaryWrappedFindings: 0 });
    const record = await runAudit(env, { run, fetchImpl, scanner });

    expect(record.scanner.capabilityCanary.status).toBe("unverified");
    expect(record.coverage.limitations).toContainEqual({ kind: "binary-scan-capability-unverified" });
    expect(record.coverage.complete).toBe(false);
    expect(record.transitionReady).toBe(false);
    expect(record.blockers.join(" ")).toMatch(/binary-scan-capability-unverified/);
  });

  it("runs the real scan under the audit-owned isolation, outside the checkout (F13)", async () => {
    const { env, run, fetchImpl, invocations } = harness();
    await runAudit(env, { run, fetchImpl, scanner });

    const scan = invocations.find((invocation) => invocation.label === "scanner-detect");
    expect(scan).toBeDefined();
    // The ignore path is the audit's own empty file, not the checkout's `.gitleaksignore` — which
    // `--gitleaks-ignore-path` would otherwise default to through the working directory.
    const ignorePath = scan!.args[scan!.args.indexOf("--gitleaks-ignore-path") + 1];
    expect(readFileSync(ignorePath, "utf8")).toBe("");
    expect(realpathSync(ignorePath).startsWith(realpathSync(env.RUNNER_TEMP))).toBe(true);
    // …and the cwd, which is the belt to that braces: it protects the run if the flag is ever lost.
    expect(scan!.cwd).toBeDefined();
    expect(realpathSync(scan!.cwd!).startsWith(realpathSync(env.RUNNER_TEMP))).toBe(true);
    expect(realpathSync(scan!.cwd!).startsWith(realpathSync(process.cwd()))).toBe(false);
    // The scan really was pointed at the staged tree this run produced — the `scan/` directory of
    // the run's own scratch root, which `createScratch` made under RUNNER_TEMP.
    const sourceDir = scan!.args[scan!.args.indexOf("--source") + 1];
    expect(sourceDir.endsWith("/scan")).toBe(true);
    expect(realpathSync(sourceDir).startsWith(realpathSync(env.RUNNER_TEMP))).toBe(true);
    expect(realpathSync(join(sourceDir, "L0"))).toBeTruthy();
  });

  it("reads the package's own identity, and lets it decide the inventory (F4)", async () => {
    const { env, run, fetchImpl, fetched } = harness();
    const record = await runAudit(env, { run, fetchImpl, scanner });

    // The METADATA read is a separate request from the versions walk, and it is the one that says
    // WHICH package was enumerated. Deleting the argument deletes the request.
    expect(fetched.some((url) => url === PACKAGE_METADATA_URL)).toBe(true);
    expect(fetched.some((url) => url.startsWith(PACKAGE_VERSIONS_URL))).toBe(true);
    expect(record.packageInventory).toMatchObject({
      source: "actions-api",
      apiStatus: "verified",
      identityStatus: "verified",
      status: "verified",
      visibility: "private",
      linkage: SUBJECT.repository,
      otherVersions: 0,
    });
  });

  /**
   * F11's call site. The inspection takes `deadline` and consults it inside the walk, and that is
   * pinned against a synthetic export elsewhere — but the DISPATCHER passing its own budget in is a
   * separate fact, and dropping that one argument is invisible in a healthy run: a budget with time
   * left is silent, and an expired one refuses at the first subprocess long before the inspection.
   * A budget that RECORDS what it was asked about is the only way to see it.
   */
  it("hands the run's own internal budget to the inspection (F11)", async () => {
    const consulted: string[] = [];
    const { env, run, fetchImpl } = harness();
    await runAudit(env, {
      run,
      fetchImpl,
      scanner,
      makeBudget: () => ({
        remaining: () => 30_000,
        assert: (operation: string) => { consulted.push(operation); return undefined; },
      }),
    });
    // Pass 1 (hashing every member of the export) and the layer loop are different places in the
    // walk; both are reached through the one argument under test.
    expect(consulted).toContain("export index");
    expect(consulted).toContain("layer inspection");
  });

  it("inspects the pinned subject's export and writes ONE allowlisted artifact", async () => {
    const { env, run, fetchImpl, secret, invocations } = harness();
    const record = await runAudit(env, { run, fetchImpl, scanner });

    // The export really was pulled and saved for the pinned reference rather than for a name an
    // input chose.
    const pull = invocations.find((invocation) => invocation.label === "image-pull");
    expect(pull!.args).toContain(SUBJECT_REFERENCE);
    // Two layer members plus the gzip's inflated payload were inventoried…
    expect(record.coverage.members).toBe(2);
    expect(record.coverage.stagedBytes).toBeGreaterThan(0);
    expect(record.coverage.representation).toBe("aios.image-audit.scan-surface.v1");
    // …and the artifact on disk is the record, carrying no scratch path and no member content.
    const written = readFileSync(env.AUDIT_EVIDENCE_PATH, "utf8");
    expect(JSON.parse(written).subject.digest).toBe(SUBJECT.digest);
    expect(written).not.toContain(secret);
    expect(written).not.toContain(env.RUNNER_TEMP);
    // The identity chain is persisted as the MEASURED boolean the reconciliation validates. It is
    // false here because the tag readback resolved to other bytes — a real measurement of this
    // fixture, not a stub.
    expect(record.provenance.identityVerified).toBe(false);
    expect(record.provenance.tagReadback.status).toBe("mismatch");
  });
});
