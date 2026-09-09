#!/usr/bin/env node
/**
 * AIO-997 — the ops runner image AUDIT, read-only, against ONE pinned existing artifact.
 *
 * WHAT THIS COMMAND DOES. Pulls the pinned digest, exports it WITHOUT executing it, verifies the
 * whole identity chain against the registry manifest, inventories and scans every regular file of
 * every layer (including files a later layer deletes), compares `/app` against the original public
 * source revision, records measured assertions about the build recipe, inventories the package's
 * versions, and writes ONE allowlisted evidence artifact.
 *
 * WHAT IT CANNOT DO, ever, by construction:
 *   • change a package's visibility — there is no write request in this program;
 *   • publish, delete, tag or re-push anything — there is no push path;
 *   • run the image — the export is read as bytes, no `docker run`, no entrypoint, no npm script;
 *   • prove the image contains no secret — it proves what its recorded rules and coverage measured.
 *
 * THE EVIDENCE IS AN ALLOWLIST. Raw archives, extracted files, full config/history and every scanner
 * match stay in ephemeral runner scratch. This repository is PUBLIC, so an Actions artifact is
 * potentially public evidence; the artifact is assembled from named fields and refuses to be written
 * if a leak guard finds anything sensitive in it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutFailures, dispatchContextFailures, REPOSITORY } from "./image-publication.mjs";
import { isDirectEntry } from "./direct-entry.mjs";
import { createOperationBudget } from "./operation-deadline.mjs";
import {
  AUDIT_LIMITS,
  AUDIT_WORKFLOW_PATH,
  SUBJECT,
  SUBJECT_REFERENCE,
  SUBJECT_TAG_REFERENCE,
  assertSubjectShape,
} from "./image-audit/subject.mjs";
import { revisionLabelFailures, verifyManifest } from "./image-audit/layers.mjs";
import { inspectExport, latestAppMembers } from "./image-audit/inspect.mjs";
import { compareInventory, expectedInventory, inventorySummary } from "./image-audit/expected-tree.mjs";
import { RECIPE_FILES, recipeEvidence } from "./image-audit/recipe.mjs";
import {
  SCANNER,
  assertScannerPinned,
  scannerArgs,
  scannerInterfaceFailures,
  scannerSettings,
  scannerVersionFailures,
  summarizeFindings,
  validateReport,
  verifyScannerDownload,
} from "./image-audit/scanner.mjs";
import {
  assessPackageInventory,
  classifyTagReadback,
  listPackageVersions,
} from "./image-audit/registry.mjs";
import { buildEvidence, sanitizedFailure, scannerIdentity, transitionReadiness } from "./image-audit/evidence.mjs";

const SOURCE_URL = `https://github.com/${REPOSITORY}.git`;

// ---------------------------------------------------------------------------
// Scratch — ephemeral, isolated, and provably outside the checkout
// ---------------------------------------------------------------------------

/**
 * PUB-04's isolation, asserted rather than assumed. Scratch holds raw layer bytes and extracted
 * files; inside `GITHUB_WORKSPACE` it would be inside the Docker build context and inside anything
 * that later uploads the workspace. The assertion is what makes "outside" a property instead of a
 * convention about where the temp directory usually is.
 */
export function createScratch(env = process.env, { mkTemp = mkdtempSync } = {}) {
  const base = env.RUNNER_TEMP || tmpdir();
  const workspace = env.GITHUB_WORKSPACE ? resolve(env.GITHUB_WORKSPACE) : undefined;
  const root = resolve(mkTemp(join(base, "aios-image-audit-")));
  if (workspace && (root === workspace || root.startsWith(`${workspace}/`))) {
    // The path is in the MESSAGE, which stays in the process's own error. It never reaches the
    // evidence record: `sanitizedFailure` reads a fixed code and nothing else.
    throw Object.assign(
      new Error(`refusing to use scratch inside the checkout (${root}); raw image content must not enter the workspace`),
      { code: "AUDIT_SCRATCH_IN_WORKSPACE" },
    );
  }
  for (const child of ["scan", "layers", "source", "tools", "logs"]) mkdirSync(join(root, child), { recursive: true });
  return root;
}

/**
 * Run a subprocess with its stdout AND stderr captured to PRIVATE scratch.
 *
 * Nothing from a subprocess reaches the job log. `docker`, `git` and the scanner all quote paths,
 * manifests and occasionally file content in their diagnostics, and this repository's logs are
 * potentially public. On failure the caller emits a FIXED sanitized message; the real text stays in
 * `logs/`, where a bounded rerun can reach it and a public artifact cannot.
 *
 * THE FAILURE CODES ARE DISTINCT, because the remedies are. "The scan ran out of time", "the scan
 * produced more diagnostic output than the buffer allowed" and "the binary would not start at all"
 * were one `AUDIT_SUBPROCESS_START` code, and that code is the ONLY thing about the failure the
 * public record carries — so collapsing them threw away the entire diagnosis for a coordinator who
 * cannot read the scratch log.
 */
const SUBPROCESS_FAILURE_CODES = Object.freeze({
  // spawnSync kills the child at `timeout` and reports ETIMEDOUT: the deadline, not a broken binary.
  ETIMEDOUT: "AUDIT_SUBPROCESS_TIMEOUT",
  // `maxBuffer` exceeded. The child ran; its captured diagnostic is truncated.
  ENOBUFS: "AUDIT_SUBPROCESS_LOG_OVERFLOW",
});

export function runPrivate(command, args, {
  scratch,
  label,
  timeoutMs,
  env = process.env,
  maxBufferBytes = AUDIT_LIMITS.maxSubprocessLogBytes,
}) {
  const logPath = join(scratch, "logs", `${label}.log`);
  const result = spawnSync(command, args, {
    timeout: timeoutMs,
    // `pipe`, then written to scratch by us — never `inherit`, which would put it in the job log.
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: maxBufferBytes,
    env,
  });
  const captured = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  // Whatever WAS captured is retained even on a truncated or timed-out run: a partial diagnostic in
  // private scratch is the only material a bounded rerun has to start from.
  appendFileSync(logPath, captured);
  if (result.error) {
    const code = SUBPROCESS_FAILURE_CODES[result.error.code] ?? "AUDIT_SUBPROCESS_START";
    throw Object.assign(new Error(`${label} did not complete (${code})`), { code, label });
  }
  if (result.status !== 0) throw Object.assign(new Error(`${label} exited ${result.status}`), { code: "AUDIT_SUBPROCESS_EXIT", label });
  return result.stdout ?? Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// The pinned scanner
// ---------------------------------------------------------------------------

/**
 * Download, VERIFY, extract, then measure the binary's own interface.
 *
 * Order matters and is the point: no checksum, no extraction; no measured version and flags, no scan.
 * A scanner whose interface differs from what this code passes would silently drop arguments, and a
 * scan run with different arguments than the evidence records is not the scan the evidence describes.
 */
export function installScanner({ scratch, budget, scanner = SCANNER, run = runPrivate }) {
  assertScannerPinned(scanner);
  const toolDir = join(scratch, "tools");
  const archive = join(toolDir, "scanner.tar.gz");
  run("curl", ["-sSfL", "--retry", "2", "-o", archive, scanner.assetUrl(scanner.version)], {
    scratch, label: "scanner-download", timeoutMs: budget.remaining(120_000, "scanner download"),
  });
  verifyScannerDownload(readFileSync(archive), scanner);
  run("tar", ["-xzf", archive, "-C", toolDir, scanner.name], {
    scratch, label: "scanner-extract", timeoutMs: budget.remaining(60_000, "scanner extract"),
  });
  const binary = join(toolDir, scanner.name);
  const version = run(binary, ["version"], { scratch, label: "scanner-version", timeoutMs: budget.remaining(30_000, "scanner version") }).toString("utf8");
  const help = run(binary, ["detect", "--help"], { scratch, label: "scanner-help", timeoutMs: budget.remaining(30_000, "scanner help") }).toString("utf8");
  const failures = [...scannerVersionFailures(version, scanner), ...scannerInterfaceFailures(help, scanner)];
  if (failures.length) throw new Error(`the pinned scanner is not the interface this audit calls:\n- ${failures.join("\n- ")}`);
  return binary;
}

/**
 * Run the scan over staged content and read ONLY the allowlisted report fields back.
 *
 * THREE WAYS A SCAN CAN FAIL TO BE EVIDENCE, all of which the subprocess can survive with exit 0:
 * it wrote no report, it wrote something that is not JSON, or it wrote JSON that is not a findings
 * array. Each is a REFUSAL here. None of them may become "zero findings", which is the best verdict
 * the audit can produce and therefore the most dangerous thing to hand a broken run.
 *
 * A parse failure's own message is discarded: V8 quotes a slice of the input in `SyntaxError`, and
 * the input is the scanner's report.
 */
export function runScan({ binary, scanDir, scratch, budget, configPath, run = runPrivate }) {
  const reportPath = join(scratch, "logs", "scanner-report.json");
  run(binary, scannerArgs({ sourceDir: scanDir, reportPath, configPath }), {
    scratch, label: "scanner-detect", timeoutMs: budget.remaining(20 * 60_000, "secret scan"),
  });
  if (!existsSync(reportPath)) {
    throw Object.assign(
      new Error("the scanner produced no report; its coverage is unknown and cannot be reported as clean"),
      { code: "AUDIT_SCANNER_REPORT_MISSING" },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    throw Object.assign(
      new Error("the scanner report is not parseable JSON; the scan's own output is in private scratch"),
      { code: "AUDIT_SCANNER_REPORT_UNPARSEABLE" },
    );
  }
  // Shape-checked HERE, at the boundary, so nothing downstream can be handed a report that only
  // looks like one. `validateReport` accepts a valid empty array — the genuine clean case.
  return validateReport(parsed);
}

// ---------------------------------------------------------------------------
// The original public source revision — a SEPARATE checkout, no credentials
// ---------------------------------------------------------------------------

/**
 * Fetch the pinned image's source revision into its own directory.
 *
 * NEVER the audit's own checkout. That tree is different code at a different commit — comparing the
 * image against it would answer "does the image match what we are building today", which is not the
 * question and would go green for the wrong reason on every future audit.
 */
export function fetchOriginalSource({ scratch, budget, revision = SUBJECT.sourceRevision, run = runPrivate }) {
  const dir = join(scratch, "source");
  const git = (args, label, ms) => run("git", ["-C", dir, ...args], { scratch, label, timeoutMs: budget.remaining(ms, label) });
  run("git", ["init", "--quiet", dir], { scratch, label: "source-init", timeoutMs: budget.remaining(30_000, "source init") });
  git(["remote", "add", "origin", SOURCE_URL], "source-remote", 30_000);
  // Anonymous over HTTPS: the repository is public and this fetch must carry no credential that
  // could end up in the comparison tree.
  git(["-c", "credential.helper=", "fetch", "--depth", "1", "--quiet", "origin", revision], "source-fetch", 5 * 60_000);
  git(["checkout", "--quiet", "FETCH_HEAD"], "source-checkout", 60_000);
  const head = git(["rev-parse", "HEAD"], "source-head", 30_000).toString("utf8").trim();
  if (head !== revision) throw new Error(`the source checkout is at ${head}, not the pinned image source ${revision}`);
  return dir;
}

/** The pinned revision's tracked inventory, with each entry's real content hashed from that tree. */
export function readSourceTree(dir, { scratch, budget, run = runPrivate }) {
  const listing = run("git", ["-C", dir, "ls-tree", "-r", "-z", "HEAD"], {
    scratch, label: "source-ls-tree", timeoutMs: budget.remaining(60_000, "source inventory"),
  }).toString("utf8");
  const entries = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const [meta, path] = record.split("\t");
    const [mode, type] = meta.split(" ");
    if (type !== "blob") continue; // submodules/trees contribute no file to the context
    const full = join(dir, path);
    if (mode === "120000") {
      entries.push({ path, type: "symlink", linkTarget: readlinkSync(full) });
      continue;
    }
    entries.push({ path, type: "file", sha256: createHash("sha256").update(readFileSync(full)).digest("hex") });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Only a path the ORIGINAL source tracks may be named in public evidence, and only if it is not
 * itself sensitive.
 *
 * The id handed in here is already normalized against the scan root by `normalizeScanLocation`, so
 * an absolute location the scanner reported has become the staged id this audit chose — or has been
 * refused before reaching this function.
 */
export function publicPathResolver(staged, expected) {
  const SENSITIVE = /(^|\/)(\.env(\.|$)|\.git\/|\.npmrc$|\.netrc$|id_[a-z0-9]+$|.*\.(pem|key|pfx|p12)$)/i;
  return (scratchId) => {
    // The image CONFIG, staged under a fixed name of this audit's choosing rather than as a layer
    // member. A finding here is a finding in `Env`/`Labels`/`Cmd`/history — worth a category of its
    // own for review, and the category alone exposes none of those values.
    if (scratchId === "image-config.json") return { category: "image-config" };
    const detail = staged.get(scratchId);
    if (!detail) return { category: "unresolved" };
    if (detail.depth > 0) return { category: "nested-archive-content" };
    if (SENSITIVE.test(detail.name)) return { category: "sensitive-path" };
    if (expected.has(detail.name)) return { publicPath: detail.name, category: "public-source-path" };
    if (/(^|\/)node_modules\//.test(detail.name)) return { category: "npm-dependency" };
    return { category: "unresolved" };
  };
}

/**
 * The final record, assembled from MEASURED pieces — including the build recipe.
 *
 * WHY THIS IS ITS OWN FUNCTION. `recipe.mjs` states that unknown or violated assertions block, and
 * for a while nothing kept that promise: the recipe was written into `provenance` and never reached
 * the readiness computation, so a violated build-recipe assertion could sit inside a `clean` verdict.
 * Assembling both from the SAME argument makes the readiness input and the recorded evidence one
 * thing rather than two that can disagree — and `transitionReadiness` fails closed on a missing
 * recipe, so a caller that forgets it can only ever produce a false BLOCK.
 */
export function assembleAudit({
  manifest, inspected, inventory, findings, packageInventory, identityVerified, recipe,
  labelFailures, tagReadback, scanner, audit, startedAt, completedAt,
}) {
  const readiness = transitionReadiness({
    coverage: inspected.coverage,
    inventory,
    findings,
    packageInventory,
    identityVerified,
    recipe,
  });
  return buildEvidence({
    ...readiness,
    subject: {
      ...SUBJECT,
      reference: SUBJECT_REFERENCE,
      manifestDigest: manifest.digest,
      configDigest: inspected.config.digest,
      layers: inspected.layers,
    },
    provenance: {
      labelFailures: Object.freeze(labelFailures),
      tagReadback,
      originalRun: `${SUBJECT.originalRunId}.${SUBJECT.originalRunAttempt}`,
      recipe,
    },
    coverage: inspected.coverage,
    inventory: { ...inventory, shadowedPaths: inspected.merged.shadowed.length },
    findings,
    packageInventory,
    scanner,
    audit,
    limits: AUDIT_LIMITS,
    startedAt,
    completedAt,
  });
}

export async function runAudit(env = process.env, {
  now = () => new Date(),
  scanner = SCANNER,
  run = runPrivate,
  makeScratch = createScratch,
} = {}) {
  const startedAt = now().toISOString();
  const auditIdentity = Object.freeze({
    repository: env.GITHUB_REPOSITORY,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    note: "this run identifies AUDIT CODE only; the audited image's source is subject.sourceRevision",
  });
  const counters = {};
  /**
   * WHERE the run got to, in this module's own closed vocabulary. It is the one piece of failure
   * context the sanitized record can carry safely, and it is what tells a coordinator whether a
   * refusal happened before any network work or half-way through the scan.
   */
  let stage = "prerequisites";
  let scratch;
  let budget;

  try {
    /**
     * THE PREREQUISITES, INSIDE the evidence path (PUB-01, PUB-04).
     *
     * Still first, and still before any pull, export or network call — an audit that refuses on an
     * unrecorded checksum must refuse at second zero rather than burn a ~20-minute export first. What
     * changed is that these three no longer throw from OUTSIDE the try: a prerequisite refusal used
     * to produce no artifact at all, which is indistinguishable to a coordinator from a runner that
     * died. Now it produces a sanitized `refused` record with a fixed code.
     */
    assertSubjectShape();
    assertScannerPinned(scanner);
    budget = createOperationBudget("staging ops image audit", AUDIT_LIMITS.internalDeadlineMs);
    scratch = makeScratch(env);

    // 1. The registry's answer for the pinned digest, recomputed from its own bytes.
    stage = "registry-manifest";
    const rawManifest = run("docker", ["buildx", "imagetools", "inspect", "--raw", SUBJECT_REFERENCE], {
      scratch, label: "manifest-inspect", timeoutMs: budget.remaining(120_000, "manifest read"),
    });
    const manifest = verifyManifest(rawManifest, SUBJECT.digest);
    counters.layers = manifest.layers.length;

    // 2. L1 — the ORIGINAL receipt tag must still resolve to that digest.
    stage = "tag-readback";
    let tagReadback;
    try {
      const rawTag = run("docker", ["buildx", "imagetools", "inspect", "--raw", SUBJECT_TAG_REFERENCE], {
        scratch, label: "tag-readback", timeoutMs: budget.remaining(120_000, "tag readback"),
      });
      tagReadback = classifyTagReadback(rawTag, SUBJECT.digest);
    } catch {
      tagReadback = classifyTagReadback(undefined, SUBJECT.digest);
    }

    // 3. Pull and export the EXISTING artifact. No `docker run`, ever.
    stage = "image-export";
    const exportPath = join(scratch, "image.tar");
    run("docker", ["pull", "--quiet", SUBJECT_REFERENCE], { scratch, label: "image-pull", timeoutMs: budget.remaining(15 * 60_000, "image pull") });
    run("docker", ["save", "-o", exportPath, SUBJECT_REFERENCE], { scratch, label: "image-save", timeoutMs: budget.remaining(10 * 60_000, "image export") });
    const exportBytes = statSync(exportPath).size;
    if (exportBytes > AUDIT_LIMITS.maxExportBytes) throw new Error(`the export is ${exportBytes} bytes, past the audit's bound`);

    // 4. Identity chain + per-layer inventory + staged content.
    stage = "layer-inspection";
    const inspected = await inspectExport({ exportPath, manifest, scratchDir: scratch, limits: AUDIT_LIMITS, platform: SUBJECT.platform });
    counters.members = inspected.coverage.members;
    counters.stagedBytes = inspected.coverage.stagedBytes;
    // The export is the largest thing on the disk and every byte of it has now been read.
    rmSync(exportPath, { force: true });

    // 5. Provenance: labels, plus the original source revision itself.
    stage = "original-source";
    const labelFailures = revisionLabelFailures(inspected.config.config, SUBJECT);
    const sourceDir = fetchOriginalSource({ scratch, budget, run });
    const sourceEntries = readSourceTree(sourceDir, { scratch, budget, run });
    const sourceFiles = Object.fromEntries(RECIPE_FILES.map((path) => {
      const full = join(sourceDir, path);
      return [path, existsSync(full) ? readFileSync(full, "utf8") : undefined];
    }));
    const recipe = recipeEvidence(sourceFiles);

    // 6. `/app` inventory. Dockerignore filters the EXPECTED set only (M1).
    stage = "app-inventory";
    const expected = expectedInventory(sourceEntries, sourceFiles[".dockerignore"] ?? "");
    const comparison = compareInventory(latestAppMembers(inspected.appMembers, inspected.merged), expected);
    const inventory = inventorySummary(comparison);

    // 7. The scan, over every staged file of every layer.
    stage = "secret-scan";
    const binary = installScanner({ scratch, budget, scanner, run });
    const configPath = join(process.cwd(), scanner.configPath);
    const scannerArgList = scannerArgs({ sourceDir: inspected.scanDir, reportPath: "", configPath });
    const report = runScan({ binary, scanDir: inspected.scanDir, scratch, budget, configPath, run });
    const findings = summarizeFindings(report, {
      // The pinned scanner reports ABSOLUTE locations, and the ids this audit staged are relative to
      // the scan root. Without the root there is nothing to normalise against, and every real finding
      // resolves to `unresolved` — a category that reads like an attribution attempt that failed
      // rather than one that never happened.
      scanRoot: inspected.scanDir,
      resolvePath: publicPathResolver(inspected.staged, expected.expected),
    });

    // 8. The package-wide inventory (PUB-05).
    stage = "package-inventory";
    const packageInventory = assessPackageInventory(
      await listPackageVersions({ token: env.GITHUB_TOKEN }),
      SUBJECT.digest,
    );

    stage = "evidence";
    return writeEvidence(env, assembleAudit({
      manifest,
      inspected,
      inventory,
      findings,
      packageInventory,
      identityVerified: inspected.identityVerified && labelFailures.length === 0 && tagReadback.status === "confirmed",
      // MEASURED at this revision, and the single source for both the readiness computation and the
      // recorded provenance.
      recipe,
      labelFailures,
      tagReadback,
      scanner: scannerIdentity(scanner, readFileSync(configPath, "utf8"), { settings: scannerSettings(scannerArgList) }),
      audit: auditIdentity,
      startedAt,
      completedAt: now().toISOString(),
    }));
  } catch (error) {
    // A refused/failed audit still writes evidence — sanitized, and honestly labelled `refused`. The
    // upload is `always()`, but a hard runner termination can still prevent it, so nothing here
    // claims the artifact was delivered.
    //
    // IT REPORTS, IT DOES NOT REPLACE. If assembling or writing that record fails in turn, the
    // ORIGINAL failure is still what propagates: a run must never end up red for "the leak guard
    // rejected the failure record" while the reason it actually failed goes unmentioned.
    try {
      writeEvidence(env, buildEvidence({
        verdict: "refused",
        transitionReady: false,
        blockers: ["the audit did not complete; the package stays private"],
        subject: { ...SUBJECT, reference: SUBJECT_REFERENCE },
        audit: auditIdentity,
        // The STAGE the run reached, from this module's closed vocabulary — so a prerequisite refusal
        // (no network work done at all) is distinguishable from a failure part-way through the scan.
        failure: sanitizedFailure({ stage, error, counters }),
        scanner: { name: scanner.name, version: scanner.version, sha256: scanner.sha256, configPath: scanner.configPath },
        limits: AUDIT_LIMITS,
        startedAt,
        completedAt: now().toISOString(),
      }));
    } catch {
      // Deliberately swallowed, and deliberately silent: the message could quote the record that
      // failed the leak guard. The absent artifact is itself the signal, and the throw below is the
      // account that survives.
    }
    throw error;
  }
}

/**
 * ONE artifact, at a fixed path in the workspace — and it is the ALLOWLISTED record, which
 * `buildEvidence` has already refused to produce if anything sensitive reached it. The scratch tree
 * it was derived from is never written here and never uploaded.
 *
 * The job summary gets the same allowlisted fields and nothing more. A summary is as public as an
 * artifact, so "just for the operator" is not a category that exists in this repository.
 */
function writeEvidence(env, record) {
  const path = env.AUDIT_EVIDENCE_PATH || "staging-ops-image-audit.json";
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = [
      `- verdict: **${record.verdict}**`,
      `- transition ready: **${record.transitionReady}**`,
      ...(record.blockers ?? []).map((blocker) => `- blocker: ${blocker}`),
      "- raw layer content, extracted files and scanner matches stayed in ephemeral runner scratch and were NOT uploaded",
    ].join("\n");
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## Staging ops image audit\n\n${rows}\n`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function envContext(env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  };
}

async function main(argv, env) {
  const command = argv[2];
  if (command === "verify-context") {
    // The AUDIT's own expected workflow path — not the publisher's. Accepting the publisher's path
    // here would let a run of the wrong workflow satisfy this guard.
    const failures = [
      ...dispatchContextFailures(envContext(env), { workflowPath: AUDIT_WORKFLOW_PATH }),
      ...checkoutFailures(env.GITHUB_SHA, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()),
    ];
    if (failures.length) throw new Error(`refusing an untrusted audit context:\n- ${failures.join("\n- ")}`);
    process.stdout.write(`audit context verified: ${REPOSITORY}@${env.GITHUB_SHA}\n`);
    return;
  }
  if (command === "run") {
    const record = await runAudit(env);
    process.stdout.write(`audit verdict: ${record.verdict} (transition ready: ${record.transitionReady})\n`);
    if (!record.transitionReady) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command ${JSON.stringify(String(command))}; expected verify-context | run`);
}

/* c8 ignore start — the CLI edge; every decision it reaches is unit-tested. */
if (isDirectEntry(import.meta.url)) {
  main(process.argv, process.env).catch((error) => {
    // A FIXED sanitized line. The real diagnostic is in ephemeral scratch, because this repository's
    // Actions logs are potentially public and a failure message can quote member paths or content.
    process.stderr.write(`staging ops image audit refused (${error?.code ?? error?.name ?? "Error"}); diagnostics stayed in runner scratch\n`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
