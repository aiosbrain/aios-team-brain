/**
 * AIO-997 audit — THE ONE ARTIFACT THAT LEAVES THE RUNNER.
 *
 * THIS REPOSITORY IS PUBLIC. An Actions artifact and an Actions log are potentially public evidence,
 * so the rule here is not "redact carefully" but "build the record from an allowlist". Raw layer
 * bytes, extracted files, the full config/history and every scanner match stay in ephemeral runner
 * scratch and are never read into this record at all.
 *
 * WHAT AN OCCURRENCE ID IS FOR. An unmatched or sensitive finding is emitted as
 * `{ category, layer, occurrenceId }` — a RANDOM per-run token. Not a hash of the path: an unsalted
 * hash is the path to anyone holding a candidate list, which is every path in a public repository.
 * The coordinator maps the id back through the private scratch record in a bounded rerun; that is a
 * concrete access limitation to report, never a reason to clear the finding.
 *
 * THE VERDICT IS DERIVED, NOT ASSERTED. `transitionReadiness` cannot be handed `true`; it is computed
 * from measured coverage, inventory completeness, findings and the package inventory, and every gap
 * blocks. "No findings" and "nothing was measured" produce different answers here, which is the
 * whole point.
 */
import { createHash, randomUUID } from "node:crypto";
import { redactionFailures } from "../image-publication.mjs";

/** Every field the audit record may carry. Anything else is dropped rather than serialized. */
export const EVIDENCE_FIELDS = Object.freeze([
  "schema", "verdict", "transitionReady", "blockers",
  "subject", "provenance", "coverage", "inventory", "findings", "packageInventory",
  // `failure` is its OWN field, never folded into `findings`. A refused run has no findings — it has
  // a stage that did not complete — and writing one into the other would report "zero findings" for
  // a run that never looked, which is the exact confusion this whole record is built to prevent.
  "failure",
  "scanner", "audit", "limits", "startedAt", "completedAt",
]);

export const VERDICTS = Object.freeze(["clean", "findings", "unresolved", "incomplete", "refused"]);

/**
 * A finding is only ever this shape. `path` is present ONLY when the caller independently established
 * the location as public source/dependency content that is not itself sensitive; `occurrenceId`
 * always is.
 */
export function safeOccurrence({ path, category, layer, occurrenceId = randomUUID() }) {
  return Object.freeze({
    ...(path ? { path } : {}),
    category: category ?? "unresolved",
    ...(Number.isInteger(layer) ? { layer } : {}),
    occurrenceId,
  });
}

/**
 * Sensitive-shaped strings that must never appear anywhere in the record, whatever field they hide
 * in. Kept broad on purpose: the guard is cheap and the failure it prevents is permanent.
 */
const SENSITIVE_SHAPE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s"]*:[^\s"@]*@/i,
  /"auths"\s*:/,
];

/**
 * The leak guard, run on the record BEFORE it is written and asserted again by the tests with
 * per-run sentinels. `forbidden` is the caller's list of exact values that were fed to the scan —
 * the synthetic secrets a test planted — so "no sentinel appears in logs or artifacts" is a
 * measurement rather than a hope.
 */
export function evidenceLeakFailures(record, forbidden = []) {
  const serialized = JSON.stringify(record ?? {});
  const failures = redactionFailures(record, "evidence");
  for (const pattern of SENSITIVE_SHAPE) {
    if (pattern.test(serialized)) failures.push(`the evidence record carries a value matching ${pattern}`);
  }
  for (const value of forbidden) {
    const text = String(value ?? "");
    if (text.length >= 8 && serialized.includes(text)) failures.push("the evidence record carries a value that was supposed to stay in private scratch");
  }
  return failures;
}

/** Keep only allowlisted fields. A field nobody listed does not reach the artifact. */
export function allowlistRecord(record) {
  const out = {};
  for (const field of EVIDENCE_FIELDS) if (record?.[field] !== undefined) out[field] = record[field];
  return out;
}

/**
 * The verdict, derived from what was actually measured.
 *
 * `transitionReady` is the ONLY thing the operator gate should read, and it is false whenever
 * anything is unresolved OR unmeasured. A coverage gap and a finding block identically, because
 * "we did not look there" and "we looked and found something" are equally not a clean audit.
 */
/**
 * A coverage limitation → a READABLE blocker line.
 *
 * Limitations are objects, and interpolating one produced `content coverage is incomplete:
 * [object Object]` — a blocker that names a real gap and tells the coordinator nothing about it.
 *
 * ONLY the fixed fields are mapped: `kind` (this module's own closed vocabulary) and the layer
 * indices, aggregated into a count. Never a `reason`, an `extension` or any other value derived from
 * archive content, because a blocker string goes into the PUBLIC artifact.
 */
export function describeLimitations(limitations = []) {
  const byKind = new Map();
  for (const limitation of limitations) {
    const kind = /^[a-z][a-z0-9-]{0,60}$/.test(String(limitation?.kind ?? "")) ? limitation.kind : "unrecorded-limitation";
    const group = byKind.get(kind) ?? { count: 0, layers: new Set() };
    group.count += 1;
    if (Number.isInteger(limitation?.layer)) group.layers.add(limitation.layer);
    byKind.set(kind, group);
  }
  if (byKind.size === 0) return "unrecorded limitation";
  return [...byKind.entries()].map(([kind, { count, layers }]) => {
    const indices = [...layers].sort((a, b) => a - b);
    // Bounded on purpose: 64 layers must not turn one blocker into a wall of numbers.
    const shown = indices.slice(0, 4).join(",");
    const suffix = indices.length === 0 ? "" : ` in layer${indices.length > 1 ? "s" : ""} ${shown}${indices.length > 4 ? `,+${indices.length - 4} more` : ""}`;
    return `${count}× ${kind}${suffix}`;
  }).join("; ");
}

/**
 * The recipe rows, as a readiness input.
 *
 * `recipe.mjs` promises that unknown assertions BLOCK, and that promise was previously kept nowhere:
 * the recipe was recorded in provenance and never reached this computation, so a violated or
 * unverifiable build-recipe assertion could ride along with a `clean` verdict.
 *
 * FAIL-CLOSED BY DEFAULT, which is the part that matters structurally: a caller that forgets to pass
 * the recipe gets a blocker, not a pass. A wiring mistake can therefore only ever cost a false
 * BLOCK — never a false clean.
 *
 * A violation is NOT redefined as secret presence. It means the reviewed build recipe did not measure
 * as expected, which is a question for coordinator adjudication.
 */
function recipeBlockers(recipe) {
  if (recipe === undefined || recipe === null) return ["the build recipe assertions were not measured"];
  const assertions = Array.isArray(recipe.assertions) ? recipe.assertions : undefined;
  if (assertions === undefined || assertions.length === 0) return ["the build recipe measured no assertions at all"];
  const counts = { violated: 0, unverified: 0, unknown: 0 };
  for (const assertion of assertions) {
    if (assertion?.status === "satisfied") continue;
    if (assertion?.status === "violated") counts.violated += 1;
    else if (assertion?.status === "unverified") counts.unverified += 1;
    else counts.unknown += 1;
  }
  const blockers = [];
  if (counts.violated > 0) blockers.push(`${counts.violated} build-recipe assertion(s) are VIOLATED and require coordinator adjudication`);
  if (counts.unverified > 0) blockers.push(`${counts.unverified} build-recipe assertion(s) are unverified; an assertion nobody could evaluate is a gap, not a pass`);
  if (counts.unknown > 0) blockers.push(`${counts.unknown} build-recipe assertion(s) carry no recognised status`);
  return blockers;
}

export function transitionReadiness({ coverage, inventory, findings, packageInventory, identityVerified, recipe }) {
  const blockers = [];
  if (!identityVerified) blockers.push("the pinned subject's manifest/config/layer identity was not fully verified");
  if (!coverage?.complete) blockers.push(`content coverage is incomplete: ${describeLimitations(coverage?.limitations)}`);
  blockers.push(...recipeBlockers(recipe));
  if (!inventory?.complete) blockers.push(`the /app inventory comparison is incomplete: ${inventory?.counts?.missing ?? "unknown"} expected path(s) absent`);
  if ((inventory?.findings ?? 0) > 0) blockers.push(`${inventory.findings} inventory/provenance finding(s) require adjudication`);
  if ((findings?.total ?? 0) > 0) blockers.push(`${findings.total} scanner finding(s) across ${findings.rules} rule(s) require adjudication`);
  if (packageInventory?.status !== "verified") blockers.push(`the package version inventory is ${packageInventory?.status ?? "unmeasured"}, not verified`);
  else if ((packageInventory?.otherVersions ?? 0) > 0) blockers.push(`${packageInventory.otherVersions} other package version(s) exist and are unaudited`);

  const verdict = blockers.length === 0
    ? "clean"
    : (findings?.total ?? 0) > 0 || (inventory?.findings ?? 0) > 0
      ? "findings"
      : coverage?.complete === false || packageInventory?.status !== "verified" || !identityVerified
        ? "incomplete"
        : "unresolved";
  return { verdict, transitionReady: blockers.length === 0, blockers: Object.freeze(blockers) };
}

/**
 * A FIXED sanitized failure. The real error — which may quote a subprocess's stderr, a member path or
 * a scanner match — is written to private scratch by the caller and never enters this record.
 */
export function sanitizedFailure({ stage, error, counters = {} }) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
  const name = typeof error?.name === "string" && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
  // The stage is meant to come from the dispatcher's closed vocabulary of fixed slugs. Enforced
  // rather than trusted: a future caller interpolating a path or a message into it would put that
  // text straight into the public artifact.
  const named = typeof stage === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(stage) ? stage : "unknown";
  return Object.freeze({
    stage: named,
    errorName: name,
    ...(code ? { errorCode: code } : {}),
    counters: Object.freeze({ ...counters }),
    note: "the diagnostic for this failure is in ephemeral runner scratch and is deliberately not published; " +
      "reproduce it through a bounded rerun rather than by widening this artifact",
  });
}

/**
 * The scanner's identity as the record states it: version, checksum, the CONFIG's own hash, and the
 * coverage-relevant settings of the invocation (PUB-03 requires the archive-traversal and file-size
 * settings to be documented alongside what was skipped).
 */
export function scannerIdentity(scanner, configText, { settings } = {}) {
  return Object.freeze({
    name: scanner.name,
    version: scanner.version,
    sha256: scanner.sha256,
    configPath: scanner.configPath,
    configSha256: createHash("sha256").update(String(configText ?? "")).digest("hex"),
    ...(settings ? { settings } : {}),
  });
}

/**
 * Build the record. Throws if anything sensitive reached it — a record that cannot be proved safe is
 * not written at all, because the artifact is the thing that becomes public.
 */
export function buildEvidence(record, { forbidden = [] } = {}) {
  const allowlisted = allowlistRecord({ schema: "aios.staging-ops.image-audit.v1", ...record });
  if (!VERDICTS.includes(allowlisted.verdict)) throw new Error(`evidence verdict ${JSON.stringify(String(allowlisted.verdict))} is not one of ${VERDICTS.join(", ")}`);
  const leaks = evidenceLeakFailures(allowlisted, forbidden);
  if (leaks.length) throw new Error(`refusing to write an audit artifact that leaks:\n- ${leaks.join("\n- ")}`);
  return allowlisted;
}
