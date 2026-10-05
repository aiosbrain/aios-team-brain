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
import { isAbsolute, resolve, sep } from "node:path";

/** The value that means "nobody has recorded the real checksum yet". Refused, loudly. */
export const CHECKSUM_UNRECORDED = "UNRECORDED";

export const SCANNER = Object.freeze({
  name: "gitleaks",
  version: "8.28.0",
  /** The exact asset. Pinned by version in the path, verified by the checksum below. */
  assetUrl: (version) => `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`,
  /**
   * SHA-256 of that asset, MEASURED — not inferred from a version number and not carried over from
   * another platform's asset.
   *
   * Recorded by the coordinator from the release's own `gitleaks_8.28.0_checksums.txt` line
   *
   *   a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb  gitleaks_8.28.0_linux_x64.tar.gz
   *
   * with the downloaded asset hashing to the same value. `CHECKSUM_UNRECORDED` below is retained as a
   * live sentinel rather than deleted: `assertScannerPinned` still refuses it, and the negative tests
   * inject it, so the fail-closed behaviour that protected this file while the value was unknown
   * cannot quietly rot now that it is known.
   *
   * The runner downloads the LINUX asset; the interface probe the flags were checked against ran the
   * darwin asset of the same version. Executing this exact linux_x64 binary remains a separately
   * measured verification step — which is why `installScanner` re-verifies the checksum on the runner
   * and measures `version` and `detect --help` there before any scan.
   */
  sha256: "a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb",
  configPath: "config/staging-ops/image-audit-gitleaks.toml",
  /**
   * SHA-256 of the tracked config bytes at `configPath`, PINNED beside the asset checksum (AC-AUDIT-07).
   *
   * THE TRUST ANCHOR IS THIS CONSTANT, not the file. A reported `configSha256` used to be accepted as
   * any 64-hex string — an independent probe reconciled a record carrying 64 `f`s to ready — and "hash
   * whatever is at the config path" would anchor trust in a mutable file. So: a build-failing guard
   * hashes the tracked config against this value, the producer refuses when the bytes it is about to
   * use differ, and the original-evidence validator refuses a record reporting anything else. Editing
   * the config therefore REQUIRES editing this line in the same reviewed change.
   */
  configSha256: "1bd01cf22ede13355c811874836d46c76d30a30904f59677bfc19312745d73ec",
  /**
   * Every flag this audit's invocation passes. Measured against the pinned binary's own help output
   * at run time — the spec is explicit that capabilities must be checked at the ACTUAL pinned version
   * rather than inferred from 8.18.4 or from current master. Each of these appears in the pinned
   * 8.28.0 `detect --help` the coordinator captured; the run-time check is what proves it again on
   * the platform that actually scans.
   */
  requiredFlags: Object.freeze([
    "--config",
    "--no-git",
    "--source",
    "--redact",
    "--no-banner",
    "--report-format",
    "--report-path",
    "--exit-code",
    "--max-target-megabytes",
    // F13. The audit points this at its OWN empty file; the flag has to exist at the pinned version
    // for that to be true, and a silently dropped argument would restore the default `.` lookup.
    "--gitleaks-ignore-path",
  ]),
});

/**
 * WHAT THE PINNED SCANNER'S RULES DO NOT COVER, stated in the evidence rather than left implied.
 *
 * `extend.useDefault = true` inherits gitleaks' default configuration, and that configuration carries
 * a GLOBAL ALLOWLIST — measured, not assumed: with `--log-level debug` the pinned 8.28.0 binary
 * printed `skipping file: global allowlist` for byte-identical plaintext staged as `.bin` and `.svg`
 * while finding the same bytes as `.txt`. This audit removes the FILENAME half of that exposure by
 * staging every file under one neutral generated id, and it cannot remove the rest: the default
 * config also carries value/stopword allowlists and its own rule set, and a credential shaped in a
 * way those rules do not match is not detected by any configuration of this scanner.
 *
 * So the record says so. "No findings under the recorded rules and coverage" is the claim; "there
 * are no secrets" is not, and never was.
 */
export const SCANNER_RULE_LIMITATIONS = Object.freeze([
  "the pinned scanner extends its default configuration, whose global allowlist is inherited; this audit stages every file under one neutral generated id so no inherited PATH/extension rule can select it, but inherited value and stopword allowlists are not removed",
  "detection is limited to the pinned version's rule set: a credential in a shape those rules do not match, or in an encoding this audit's byte-preserving representation does not make textual, is not detected",
  "archive traversal stays at the pinned version's default of disabled; nested content is expanded by the audit itself, and every format or depth it cannot expand is a recorded coverage limitation",
  "coverage is of the decoded tar bytes available to the inspector: every layer member's content and every header, extended-metadata record, link target, padding, unsupported-member body, end block and trailing byte of each decoded layer and gzip-decoded nested tar reaches the scan surface or is a recorded limitation; original registry-layer gzip framing (FNAME, FCOMMENT, FEXTRA and bytes after the compressed stream), which a classic-store docker save export may not contain, is outside this claim, and identity verification does not extend it",
]);

/**
 * The audit's OWN ignore file, and the directory the scanner runs in (F13).
 *
 * THE DEFECT. `--gitleaks-ignore-path` defaults to `.`, i.e. the process's working directory — which
 * on the runner is the repository checkout. A `.gitleaksignore` committed there (or added by a
 * future PR for repository CI reasons that have nothing to do with this audit) would suppress
 * findings in the IMAGE, silently, with no limitation recorded anywhere. The audit therefore writes
 * an empty ignore file of its own inside scratch, points the flag at it explicitly, and runs the
 * scanner from a scratch directory rather than from the checkout.
 */
export const SCANNER_IGNORE_FILE = ".gitleaksignore";

/**
 * THE REVIEWED SCANNER SETTINGS POLICY (AC-AUDIT-06) — the exact coverage-relevant settings a
 * supported v2 audit records, as constants shared by the producer (`runAudit` refuses to assemble a
 * record whose measured settings differ) and the original-evidence validator (which refuses one that
 * reports anything else). Not prose to be matched loosely and not recomputed from a mutable file:
 * `scannerSettings` below builds its strings FROM these constants, so the two cannot drift apart.
 *
 * The policy is: no scanner file-size skip, archive traversal left at the pinned default, an
 * audit-owned empty ignore file, the audit's own archive expansion, and the recorded rule limitations.
 */
const IGNORE_PATH_PINNED = "pinned to an audit-owned empty file in scratch";
const ARCHIVE_DEPTH_DEFAULT = "0 (default: archive traversal disabled)";
const ARCHIVE_EXPANSION =
  "performed by the audit to its own recorded depth bound, reclassifying every expanded member at every depth; " +
  "the archive surface of every decoded layer and gzip-decoded nested tar is staged as its own scan input; " +
  "unexpandable formats, oversized members and the depth bound itself are recorded as coverage limitations";

export const SCANNER_SETTINGS_POLICY = Object.freeze({
  gitleaksIgnorePath: IGNORE_PATH_PINNED,
  ruleLimitations: SCANNER_RULE_LIMITATIONS,
  maxTargetMegabytes: "0",
  maxArchiveDepth: ARCHIVE_DEPTH_DEFAULT,
  archiveExpansion: ARCHIVE_EXPANSION,
});

/**
 * Do these recorded settings EQUAL the reviewed policy? Exact keys, exact strings, exact list — an
 * extra key, a missing key or a reworded limitation is not the reviewed configuration.
 */
export function settingsMatchPolicy(settings, policy = SCANNER_SETTINGS_POLICY) {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
  const keys = Object.keys(policy);
  if (Object.keys(settings).length !== keys.length) return false;
  return keys.every((key) => {
    const expected = policy[key];
    const actual = settings[key];
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => actual[index] === value);
    }
    return actual === expected;
  });
}

/** Report fields this audit will read. Everything else in the report stays in private scratch. */
export const REPORT_ALLOWLIST = Object.freeze(["RuleID", "File"]);

export function assertScannerPinned(scanner = SCANNER) {
  if (scanner.sha256 === CHECKSUM_UNRECORDED || !/^[0-9a-f]{64}$/.test(String(scanner.sha256 ?? ""))
    || !/^[0-9a-f]{64}$/.test(String(scanner.configSha256 ?? ""))) {
    // A FIXED code, because this refusal happens before scratch exists and the sanitized evidence
    // record carries the code and nothing else. "Unpinned scanner" and "the runner died" must not
    // read the same to a coordinator.
    throw Object.assign(
      new Error(
        `the ${scanner.name} ${scanner.version} download or config checksum is not recorded. ` +
        `A secret scan whose binary was never verified is not evidence. Record the real sha256 in ` +
        `scripts/staging-ops/image-audit/scanner.mjs before dispatching this audit.`
      ),
      { code: "AUDIT_SCANNER_UNPINNED" },
    );
  }
  return scanner;
}

/**
 * The config bytes the scan is ABOUT to use, against the pinned constant (AC-AUDIT-07). Refuses with
 * a fixed code before any scan runs; the message names neither digest.
 */
export function verifyScannerConfig(configBytes, scanner = SCANNER) {
  const measured = createHash("sha256").update(configBytes).digest("hex");
  if (measured !== scanner.configSha256) {
    throw Object.assign(
      new Error("the scanner config this run would use is not the reviewed, pinned config"),
      { code: "AUDIT_SCANNER_CONFIG_MISMATCH" },
    );
  }
  return measured;
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

export class ScannerReportError extends Error {
  constructor(reason) {
    super(`the scanner report is not a findings array this audit can read (${reason})`);
    this.name = "ScannerReportError";
    this.code = "AUDIT_SCANNER_REPORT_INVALID";
    this.reason = reason;
  }
}

/**
 * THE REPORT'S SHAPE, checked before anything reads a summary off it.
 *
 * THE DEFECT THIS EXISTS FOR. A successful subprocess that wrote `{}`, `null` or one bare object used
 * to be coerced to an empty findings list — i.e. to the CLEANEST possible result. A scanner that
 * exited 0 without producing a findings array has not told us what it found, and "we could not read
 * the report" must never be indistinguishable from "there was nothing to report".
 *
 * A valid EMPTY array is the genuine clean case and passes here untouched. Only a fixed reason and an
 * entry INDEX are carried in the error: an entry's own text is exactly what would leak.
 */
export function validateReport(report) {
  if (!Array.isArray(report)) {
    throw new ScannerReportError(report === null ? "the report is null" : `the report is a ${typeof report}, not an array`);
  }
  report.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ScannerReportError(`entry ${index} is not an object`);
    }
    if (typeof entry.RuleID !== "string" || entry.RuleID.trim() === "") {
      throw new ScannerReportError(`entry ${index} carries no RuleID`);
    }
    if (typeof entry.File !== "string" || entry.File === "") {
      throw new ScannerReportError(`entry ${index} carries no File location`);
    }
  });
  return report;
}

/**
 * A report `File` value → the scratch id this audit staged, or a fixed reason why it is not one.
 *
 * WHY THIS IS NOT A ONE-LINER. The pinned scanner reports an ABSOLUTE path (measured: gitleaks 8.28.0
 * writes `/…/scan/L0/000000.txt` for a scan rooted at `/…/scan`), while the ids this audit staged are
 * relative (`L0/000000.txt`). Looking the raw `File` up in the staged map therefore missed every real
 * finding and reported it as `unresolved` — a category that reads like "we could not attribute it"
 * when in fact nothing was ever looked up.
 *
 * CONTAINMENT IS ESTABLISHED, NOT ASSUMED. `path.relative` alone proves nothing: it happily returns
 * `../../etc/passwd`. An absolute location is resolved and must be the scan root or sit UNDER it by a
 * separator-terminated prefix; a relative one must contain no `..` segment. Anything else is retained
 * as a finding with a fixed `out-of-root`/`malformed` outcome and no raw path — a scanner reporting a
 * location outside the tree it was pointed at is a fact to record, never one to normalise away.
 *
 * `!` is gitleaks' own separator for a path INSIDE an archive it traversed. Archive traversal is off
 * at this version's default, but if a finding ever arrives with one the inner path is dropped and the
 * occurrence is marked as nested content rather than attributed to the wrapper file's provenance.
 */
export function normalizeScanLocation(file, { scanRoot } = {}) {
  const raw = typeof file === "string" ? file : "";
  if (raw === "" || raw.includes("\0")) return { outcome: "malformed" };
  const [head, ...inner] = raw.split("!");
  const nested = inner.length > 0;
  if (head === "") return { outcome: "malformed" };

  if (scanRoot === undefined) {
    // Nothing to resolve against, so only an id that is already relative AND never climbs can be
    // trusted. Checked segment by segment rather than by string prefix.
    if (isAbsolute(head)) return { outcome: "out-of-root" };
    const segments = head.split(/[\\/]/);
    if (segments.some((segment) => segment === "..")) return { outcome: "out-of-root" };
    const id = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
    return id === "" ? { outcome: "malformed" } : { id, nested };
  }

  const root = resolve(scanRoot);
  const absolute = isAbsolute(head) ? resolve(head) : resolve(root, head);
  // THE containment check: the resolved location is the root itself or lies under it. `resolve` has
  // already collapsed every `.`/`..`, so this compares real locations rather than spellings.
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return { outcome: "out-of-root" };
  if (absolute === root) return { outcome: "malformed" }; // the directory, not a file in it
  const id = absolute.slice(root.length + 1).split(sep).join("/");
  return { id, nested };
}

/**
 * A validated scanner report → findings that are safe to publish.
 *
 * The location is the scratch id THIS AUDIT chose (`L3/000412.json`), never an archive-supplied name,
 * so a finding carries a layer index and an ordinal and nothing else. `resolvePath` is the caller's
 * decision about whether that ordinal maps to a path independently established as public and
 * non-sensitive; when it does not, the finding carries a random per-run occurrence id instead.
 *
 * Grouping is by rule, so a dependency that trips one rule 4 000 times is four thousand occurrences
 * of one row rather than four thousand rows — efficient review, no suppression.
 */
export function summarizeFindings(report, { resolvePath = () => undefined, newOccurrenceId = randomUUID, scanRoot } = {}) {
  const entries = validateReport(report);
  const byRule = new Map();
  for (const entry of entries) {
    const rule = entry.RuleID;
    const location = normalizeScanLocation(entry.File, { scanRoot });
    const layer = location.id === undefined ? undefined : /^L(\d+)\//.exec(location.id)?.[1];
    const group = byRule.get(rule) ?? { rule, occurrences: [], count: 0 };
    const resolved = location.id === undefined
      // A location this audit cannot attribute to its own staged content. Reported by outcome, with
      // the raw value left in private scratch.
      ? { category: `location-${location.outcome}` }
      : location.nested
        ? { category: "nested-archive-content" }
        : resolvePath(location.id);
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
export function scannerArgs({ sourceDir, reportPath, configPath = SCANNER.configPath, ignorePath }) {
  return [
    "detect",
    "--no-git",
    "--source", sourceDir,
    "--config", configPath,
    "--report-format", "json",
    "--report-path", reportPath,
    "--redact",
    "--no-banner",
    // F13. Explicit, and pointing at an EMPTY file this audit owns. The documented default is `.` —
    // the working directory — so leaving it unset lets a `.gitleaksignore` in the checkout suppress
    // findings about the image with nothing recorded to say it happened.
    ...(ignorePath ? ["--gitleaks-ignore-path", ignorePath] : []),
    // 0 = no size cap. A silently skipped large file is exactly the "uninspected limitation" the
    // spec forbids leaving unreported, so the cap is removed here and size bounding is done by the
    // audit's own member limits, which DO report what they excluded.
    "--max-target-megabytes", "0",
    // A finding must not fail the process: the audit adjudicates findings, and a non-zero exit would
    // be indistinguishable from the scanner having crashed. Gitleaks' documented exit codes are
    // `0` no leaks / `1` leaks OR ERROR / `126` unknown flag, so an actual error still exits non-zero
    // and still fails this audit — what this flag moves is only the leaks case.
    "--exit-code", "0",
  ];
}

/**
 * The coverage-relevant settings of the invocation, read back FROM the argument list that ran.
 *
 * PUB-03 requires the chosen scanner's archive-traversal and file-size settings to be documented and
 * skipped content reported. Deriving them from `scannerArgs` rather than restating them means the
 * evidence cannot drift from the invocation: change the flag and this record changes with it.
 *
 * No path is read out — only the flag values, and only after they are checked to be plain integers.
 */
export function scannerSettings(args = scannerArgs({ sourceDir: ".", reportPath: "." })) {
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    const value = at === -1 ? undefined : String(args[at + 1] ?? "");
    return value !== undefined && /^\d{1,9}$/.test(value) ? value : undefined;
  };
  const maxTargetMegabytes = valueOf("--max-target-megabytes");
  const maxArchiveDepth = valueOf("--max-archive-depth");
  return Object.freeze({
    /**
     * PRESENCE, never the path. Whether the run pinned its own ignore file is the coverage-relevant
     * fact; where that file lived is a scratch path, and scratch paths do not go in this artifact.
     */
    gitleaksIgnorePath: args.includes("--gitleaks-ignore-path")
      ? IGNORE_PATH_PINNED
      : "unset (the documented default is the working directory, which may carry a .gitleaksignore)",
    ruleLimitations: SCANNER_RULE_LIMITATIONS,
    // `0` = no size cap in gitleaks' own terms ("files larger than this will be skipped" with no
    // positive threshold). The audit's own per-member limit is what bounds size, and it RECORDS what
    // it excluded, which a scanner-side skip would not.
    maxTargetMegabytes: maxTargetMegabytes ?? "unset",
    // The scanner's archive traversal stays at its documented 8.28.0 default of `0` (disabled): this
    // audit expands one nested level itself and records every format it could not expand as a
    // coverage limitation, so unexpanded content is reported rather than silently opaque.
    maxArchiveDepth: maxArchiveDepth ?? ARCHIVE_DEPTH_DEFAULT,
    archiveExpansion: ARCHIVE_EXPANSION,
  });
}
