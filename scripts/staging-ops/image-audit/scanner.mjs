/**
 * AIO-997 audit — the PINNED secret scanner, and the only fields of its report that leave scratch.
 *
 * THREE THINGS THIS FILE REFUSES TO DO.
 *
 * 1. **Inherit the repository's scan exclusions.** `.gitleaks.toml` skips `node_modules`, `.next`,
 *    `dist`, `coverage` and `.env.example` — correct for repository CI, and exactly wrong here: those
 *    trees ARE the image. The audit uses its own narrow config with no path allowlist at all.
 * 2. **Assume the pinned binary has the interface this code calls.** The version is pinned AND its
 *    actual `--help` is measured on the runner; a flag this audit depends on that the pinned build
 *    does not offer is a refusal, not a silently dropped argument.
 * 3. **Trust a download.** No checksum, no scan. The sentinel below fails CLOSED rather than shipping
 *    a fabricated hash, because an invented checksum is worse than an absent one: it launders an
 *    unverified download into a verified-looking one.
 *
 * REDACTION (PUB-04, M2). Only `RuleID` and the scratch file id are ever read out of the report.
 * Never `Match`, `Secret`, `Line`, `Fingerprint`, `Commit`, `Author`, `Email` or `Date` — a
 * fingerprint is a path-plus-rule identifier, and an unsalted hash of a sensitive path is not
 * redaction, it is the path with extra steps.
 */
import { createHash, randomUUID } from "node:crypto";

/** The value that means "nobody has recorded the real checksum yet". Refused, loudly. */
export const CHECKSUM_UNRECORDED = "UNRECORDED";

export const SCANNER = Object.freeze({
  name: "gitleaks",
  version: "8.28.0",
  /** The exact asset. Pinned by version in the path, verified by the checksum below. */
  assetUrl: (version) => `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`,
  /**
   * SHA-256 of that asset.
   *
   * UNRECORDED on purpose. It cannot be obtained from the build session that wrote this file, and the
   * one thing worse than an unpinned download is a made-up hash. Record it with the official
   * checksums file and the asset itself agreeing:
   *
   *   curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_checksums.txt
   *   curl -sSfL <assetUrl> | sha256sum
   *
   * Until then `assertScannerPinned` refuses and the audit does not run. That refusal is the honest
   * state of this prerequisite, and it is recorded as such in the evidence.
   */
  sha256: CHECKSUM_UNRECORDED,
  configPath: "config/staging-ops/image-audit-gitleaks.toml",
  /**
   * Every flag this audit's invocation depends on. Measured against the pinned binary's own help
   * output at run time — the spec is explicit that capabilities must be checked at the ACTUAL pinned
   * version rather than inferred from 8.18.4 or from current master.
   */
  requiredFlags: Object.freeze([
    "--config",
    "--no-git",
    "--redact",
    "--report-format",
    "--report-path",
    "--exit-code",
    "--max-target-megabytes",
  ]),
});

/** Report fields this audit will read. Everything else in the report stays in private scratch. */
export const REPORT_ALLOWLIST = Object.freeze(["RuleID", "File"]);

export function assertScannerPinned(scanner = SCANNER) {
  if (scanner.sha256 === CHECKSUM_UNRECORDED || !/^[0-9a-f]{64}$/.test(String(scanner.sha256 ?? ""))) {
    throw new Error(
      `the ${scanner.name} ${scanner.version} download checksum is not recorded (${String(scanner.sha256)}). ` +
      `A secret scan whose binary was never verified is not evidence. Record the real sha256 in ` +
      `scripts/staging-ops/image-audit/scanner.mjs before dispatching this audit.`
    );
  }
  return scanner;
}

/** The downloaded asset, hashed. There is no "skip verification" path and no fallback mirror. */
export function verifyScannerDownload(bytes, scanner = SCANNER) {
  assertScannerPinned(scanner);
  const measured = createHash("sha256").update(bytes).digest("hex");
  if (measured !== scanner.sha256) {
    throw new Error(`the downloaded ${scanner.name} archive hashes to ${measured}, not the pinned ${scanner.sha256}`);
  }
  return measured;
}

/**
 * The pinned binary's ACTUAL interface, measured. A missing flag means this audit's invocation would
 * not do what its code says it does — which is a coverage question, so it refuses.
 */
export function scannerInterfaceFailures(helpText, scanner = SCANNER) {
  const help = String(helpText ?? "");
  return scanner.requiredFlags.filter((flag) => !help.includes(flag)).map((flag) => `${scanner.name} ${scanner.version} does not offer ${flag}`);
}

/** The pinned binary's reported version must BE the pinned version. */
export function scannerVersionFailures(versionOutput, scanner = SCANNER) {
  const text = String(versionOutput ?? "").trim();
  return text.includes(scanner.version) ? [] : [`${scanner.name} reports ${JSON.stringify(text)}, not the pinned ${scanner.version}`];
}

/**
 * A scanner report → findings that are safe to publish.
 *
 * `File` is the scratch id THIS AUDIT chose (`L3/000412.json`), never an archive-supplied name, so a
 * finding carries a layer index and an ordinal and nothing else. `resolvePath` is the caller's
 * decision about whether that ordinal maps to a path independently established as public and
 * non-sensitive; when it does not, the finding carries a random per-run occurrence id instead.
 *
 * Grouping is by rule, so a dependency that trips one rule 4 000 times is four thousand occurrences
 * of one row rather than four thousand rows — efficient review, no suppression.
 */
export function summarizeFindings(report, { resolvePath = () => undefined, newOccurrenceId = randomUUID } = {}) {
  const entries = Array.isArray(report) ? report : [];
  const byRule = new Map();
  for (const entry of entries) {
    const rule = typeof entry?.RuleID === "string" && entry.RuleID !== "" ? entry.RuleID : "unnamed-rule";
    const scratchId = typeof entry?.File === "string" ? entry.File : "";
    const layer = /^L(\d+)\//.exec(scratchId)?.[1];
    const group = byRule.get(rule) ?? { rule, occurrences: [], count: 0 };
    const resolved = resolvePath(scratchId);
    group.count += 1;
    group.occurrences.push(Object.freeze({
      // A clear path ONLY when the caller independently established it as public source/dependency
      // content AND not itself sensitive. Public origin does not clear a credential — it only makes
      // the PATH safe to name, which is a different claim from the finding being harmless.
      path: resolved?.publicPath,
      category: resolved?.category ?? "unresolved",
      layer: layer === undefined ? undefined : Number(layer),
      occurrenceId: newOccurrenceId(),
    }));
    byRule.set(rule, group);
  }
  const groups = [...byRule.values()].map((group) => Object.freeze({ ...group, occurrences: Object.freeze(group.occurrences) }));
  return Object.freeze({ total: entries.length, rules: groups.length, groups: Object.freeze(groups) });
}

/**
 * The invocation. Report to PRIVATE scratch as JSON; stdout/stderr captured by the caller to scratch
 * as well. `--redact` is not the redaction this audit relies on — nothing from the report is echoed —
 * but it keeps the secret out of the scanner's own file too, which is one fewer place it exists.
 */
export function scannerArgs({ sourceDir, reportPath, configPath = SCANNER.configPath }) {
  return [
    "detect",
    "--no-git",
    "--source", sourceDir,
    "--config", configPath,
    "--report-format", "json",
    "--report-path", reportPath,
    "--redact",
    "--no-banner",
    // 0 = no size cap. A silently skipped large file is exactly the "uninspected limitation" the
    // spec forbids leaving unreported, so the cap is removed here and size bounding is done by the
    // audit's own member limits, which DO report what they excluded.
    "--max-target-megabytes", "0",
    // A finding must not fail the process: the audit adjudicates findings, and a non-zero exit would
    // be indistinguishable from the scanner having crashed.
    "--exit-code", "0",
  ];
}
