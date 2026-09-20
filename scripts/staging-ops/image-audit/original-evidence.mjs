/**
 * AIO-997 audit — VALIDATING THE ORIGINAL AUDIT RECORD before anything is reconciled from it.
 *
 * WHAT THIS EXISTS FOR, measured rather than supposed. An independent probe called the exported
 * reconciliation boundary with `{}` and got back `clean`, `transitionReady: true`, empty blockers —
 * a complete gate input assembled from an operator's version list and nothing else. The same probe
 * handed it a well-formed record for a DIFFERENT digest and got a record whose subject had been
 * overwritten with the pinned one, and a record with `coverage.complete: false`, one finding and a
 * missing `blockers` key, which also came back `clean` and ready.
 *
 * All three share ONE cause: readiness was inferred by filtering a `blockers` ARRAY that defaulted to
 * `[]` when absent. An absent measurement read as a satisfied one. So this module does not filter
 * strings; it validates the record's own MEASUREMENTS and hands them back, and `reconcile.mjs`
 * recomputes readiness from those with the same `transitionReadiness` the audit itself used.
 *
 * THREE RULES THAT SHAPE EVERY CHECK BELOW:
 *
 *   1. **Absence is never zero and never complete.** Every observation the gate reads is REQUIRED.
 *      A record missing one is refused, not defaulted.
 *   2. **The output is built from an ALLOWLIST of validated fields**, exactly like the audit's own
 *      artifact — never by copying a nested payload out of untrusted JSON. A sentinel hidden in
 *      `coverage.limitations[0].note` has no path into the reconciled record because no code here
 *      copies a field nobody listed.
 *   3. **A refusal carries fixed codes only.** Nothing from the input is echoed, because the
 *      reconciled record is as public as the audit's.
 *
 * WHAT THIS IS NOT. Not authentication. Nothing here can tell a genuine artifact from a
 * well-crafted forgery — a local JSON file carries no signature and this module verifies none. What
 * it establishes is that the record is INTERNALLY CONSISTENT, complete, and about the pinned
 * subject, so that "the operator supplied the version list the API could not read" cannot quietly
 * become "the operator supplied the entire audit".
 */
import { VERDICTS } from "./evidence.mjs";
import { UNSUPPORTED_FORMATS } from "./export-walk.mjs";
import { SCANNER } from "./scanner.mjs";
import { AUDIT_LIMITS, SUBJECT } from "./subject.mjs";

/** The schema the audit's own artifact carries (`buildEvidence`'s default). */
export const ORIGINAL_SCHEMA = "aios.staging-ops.image-audit.v1";

/**
 * Every reason this module can refuse, as FIXED codes. A refusal reaches the public reconciled
 * record; a code from this list can say what failed without quoting anything that failed.
 */
export const REFUSAL_CODES = Object.freeze([
  "original-evidence-absent",
  "original-schema-mismatch",
  "original-subject-mismatch",
  "original-verdict-malformed",
  "original-run-refused",
  "original-coverage-malformed",
  "original-inventory-malformed",
  "original-findings-malformed",
  "original-package-inventory-malformed",
  "original-scanner-malformed",
  "original-scanner-name-mismatch",
  "original-scanner-version-mismatch",
  "original-scanner-sha256-mismatch",
  "original-scanner-config-path-mismatch",
  "original-identity-not-measured",
  "original-recipe-malformed",
  "original-limits-malformed",
  "original-timestamps-malformed",
  "original-internally-inconsistent",
]);

// ---------------------------------------------------------------------------
// Narrow predicates. Everything below is built from these, so "what counts as measured" is stated
// once rather than re-decided per field.
// ---------------------------------------------------------------------------

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isBool = (value) => typeof value === "boolean";
const isCount = (value) => Number.isInteger(value) && value >= 0;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** This repository's own limitation/category vocabulary — the shape `describeLimitations` accepts. */
const SLUG = /^[a-z][a-z0-9-]{0,60}$/;
const DOTTED = /^[a-z][a-z0-9.-]{0,63}$/;
/** A path the audit already established as public source content. Never absolute, never traversing. */
const PUBLIC_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
/** Printable ASCII only: a reason or detail this module passes through must be readable text. */
const printable = (max) => new RegExp(`^[\\x20-\\x7e]{0,${max}}$`);

/**
 * Keep the listed keys, and REFUSE any key nobody listed.
 *
 * The refusal half is the point. Dropping an unknown field silently would make this an allowlist for
 * the output while leaving the input free to carry anything — and "the record validated" would then
 * say nothing about the object that was validated.
 */
function pick(value, fields) {
  const out = {};
  for (const key of Object.keys(value)) {
    const rule = fields[key];
    if (rule === undefined) return undefined; // an unlisted field: the record is not the shape we wrote
    if (value[key] === undefined) continue;
    const kept = rule(value[key]);
    if (kept === undefined) return undefined;
    out[key] = kept;
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (rule.required && out[key] === undefined) return undefined;
  }
  return out;
}

/** A rule that must be present for the record to be a measurement rather than a claim. */
const required = (rule) => Object.assign((value) => rule(value), { required: true });

const bool = (value) => (isBool(value) ? value : undefined);
const count = (value) => (isCount(value) ? value : undefined);
const text = (pattern) => (value) => (matches(pattern, value) ? value : undefined);
const oneOf = (values) => (value) => (values.includes(value) ? value : undefined);
const listOf = (rule) => (value) => {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const entry of value) {
    const kept = rule(entry);
    if (kept === undefined) return undefined;
    out.push(kept);
  }
  return Object.freeze(out);
};
const objectOf = (keyPattern, rule) => (value) => {
  if (!isObject(value)) return undefined;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!matches(keyPattern, key)) return undefined;
    const kept = rule(entry);
    if (kept === undefined) return undefined;
    out[key] = kept;
  }
  return Object.freeze(out);
};
const shape = (fields) => (value) => {
  if (!isObject(value)) return undefined;
  const picked = pick(value, fields);
  return picked === undefined ? undefined : Object.freeze(picked);
};

// ---------------------------------------------------------------------------
// The observations, each as the exact shape the audit writes
// ---------------------------------------------------------------------------

/**
 * A coverage limitation, field by field.
 *
 * `extension`, `format`, `typeflag` and `reason` all originate in ARCHIVE CONTENT in the original
 * run, and `export-walk` constrains each to a closed vocabulary before recording it. Re-deriving
 * those constraints here is what stops a hand-written record from smuggling text into a field the
 * real pipeline could never have put it in.
 */
const limitation = shape({
  kind: required(text(SLUG)),
  layer: count,
  depth: count,
  bytes: count,
  extension: text(/^\.[a-z0-9]{1,12}$/),
  format: oneOf(UNSUPPORTED_FORMATS),
  typeflag: text(/^(?:[A-Za-z0-9]|non-printable)$/),
  reason: text(/^[A-Za-z]{1,40}$/),
});

const coverage = shape({
  complete: required(bool),
  layers: required(count),
  members: required(count),
  stagedBytes: required(count),
  limitations: required(listOf(limitation)),
  stagedByteLimit: (value) => (isCount(value) || value === "unbounded" ? value : undefined),
  representation: text(DOTTED),
  configBytes: count,
  scanSurfaceBytes: count,
  representationOverheadBytes: count,
});

const inventory = shape({
  complete: required(bool),
  findings: required(count),
  counts: required(objectOf(SLUG, count)),
  shadowedPaths: count,
});

const occurrence = shape({
  category: required(text(SLUG)),
  occurrenceId: required(text(UUID)),
  layer: count,
  path: text(PUBLIC_PATH),
});

const findings = shape({
  total: required(count),
  rules: required(count),
  groups: required(listOf(shape({
    rule: required(text(/^[A-Za-z0-9._-]{1,64}$/)),
    count: required(count),
    occurrences: required(listOf(occurrence)),
  }))),
});

const packageInventory = shape({
  source: required(oneOf(["actions-api", "operator-evidence"])),
  apiStatus: required(oneOf(["verified", "unverified"])),
  status: required(oneOf(["verified", "unverified"])),
  identityStatus: oneOf(["verified", "unverified"]),
  reason: text(printable(300)),
  pages: count,
  total: count,
  otherVersions: count,
  untagged: count,
  additionalSubjects: listOf(text(DIGEST)),
  visibility: text(/^[a-z]{1,20}$/),
  linkage: text(/^[A-Za-z0-9._/-]{1,100}$/),
  operatorEvidence: shape({
    accepted: required(bool),
    capturedAt: text(ISO),
    versionIds: listOf(text(/^[0-9]{1,20}$/)),
    failures: listOf(text(printable(200))),
  }),
});

const scanner = shape({
  name: required(text(/^[a-z0-9-]{1,32}$/)),
  version: required(text(/^[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}$/)),
  sha256: required(text(SHA256)),
  configPath: required(text(PUBLIC_PATH)),
  configSha256: text(SHA256),
  settings: objectOf(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/, (value) => (
    matches(printable(300), value) ? value : listOf(text(printable(300)))(value)
  )),
  representation: shape({
    version: required(text(DOTTED)),
    header: required(text(/^[\x20-\x7e\n]{0,200}$/)),
    suffix: required(text(/^\.[a-z0-9]{1,8}$/)),
    note: text(printable(500)),
  }),
  capabilityCanary: shape({
    status: required(oneOf(["verified", "unverified"])),
    representation: text(DOTTED),
    reason: text(printable(300)),
    binaryMagicSkipReproduced: bool,
  }),
});

/**
 * The scanner the record CLAIMS, against the one reviewed source pins.
 *
 * The shape above establishes that `name`/`version`/`sha256`/`configPath` are the right TYPES, and
 * an independent probe showed what that leaves open: a complete, internally consistent record —
 * correct subject, clean coverage, verified identity — whose `scanner.sha256` was simply a different
 * 64-hex string still reconciled to `clean` / `transitionReady: true`. A well-typed identity is not
 * the pinned identity, so an older scanner build or a different config passed as though it were the
 * binary the workflow actually runs.
 *
 * Each field gets its OWN fixed code, because a coordinator reading a refusal needs to know which
 * one drifted — and the code names the FIELD, never the record's value, which is as public as the
 * audit's own artifact.
 */
const SCANNER_BINDING = Object.freeze([
  ["name", "original-scanner-name-mismatch"],
  ["version", "original-scanner-version-mismatch"],
  ["sha256", "original-scanner-sha256-mismatch"],
  ["configPath", "original-scanner-config-path-mismatch"],
]);

const recipe = shape({
  assertions: required(listOf(shape({
    id: required(text(/^[a-z][a-z0-9.-]{0,63}$/)),
    status: required(text(/^[a-z]{1,20}$/)),
    detail: text(printable(400)),
  }))),
  counts: objectOf(/^[a-z]{1,20}$/, count),
  sourceHashes: objectOf(/^[A-Za-z0-9._/-]{1,100}$/, text(/^(?:sha256:[0-9a-f]{64}|unreadable)$/)),
  limitation: text(printable(500)),
});

/**
 * The bounds the original run declared, against the ones THIS source defines.
 *
 * Keys only — the values are the original run's own numbers and may legitimately differ from a later
 * revision's. A key this revision does not know is refused, because the record would then be
 * describing a limit vocabulary this code cannot interpret.
 */
const LIMIT_KEYS = Object.freeze(Object.keys(AUDIT_LIMITS));
const limits = (value) => {
  if (!isObject(value)) return undefined;
  const out = {};
  for (const [key, number] of Object.entries(value)) {
    if (!LIMIT_KEYS.includes(key) || !Number.isFinite(number)) return undefined;
    out[key] = number;
  }
  return Object.freeze(out);
};

// ---------------------------------------------------------------------------
// The whole record
// ---------------------------------------------------------------------------

/** Every scalar of the pinned subject the record must AGREE with, not merely carry. */
function subjectMismatch(recordSubject, subject) {
  if (!isObject(recordSubject)) return true;
  return Object.entries(subject).some(([key, value]) => recordSubject[key] !== value);
}

/**
 * Validate the original audit record and return its MEASURED observations.
 *
 * `{ ok: true, observations }` — every observation the readiness computation needs, allowlisted and
 * type-checked, ready to be recomputed from. `{ ok: false, codes }` — fixed codes, no input echoed.
 */
export function validateOriginalEvidence(record, subject = SUBJECT) {
  const codes = [];
  const refuse = (code) => { if (!codes.includes(code)) codes.push(code); };

  if (!isObject(record)) return { ok: false, codes: Object.freeze(["original-evidence-absent"]) };
  if (record.schema !== ORIGINAL_SCHEMA) refuse("original-schema-mismatch");
  if (subjectMismatch(record.subject, subject)) refuse("original-subject-mismatch");
  if (!VERDICTS.includes(record.verdict) || !isBool(record.transitionReady)) refuse("original-verdict-malformed");
  /**
   * A REFUSED run has no measurements to reconcile — it has a stage that did not complete. Promoting
   * one would be the exact inversion this module exists to prevent, so it is refused here rather
   * than left to fail later on a missing observation.
   */
  if (record.verdict === "refused" || record.failure !== undefined) refuse("original-run-refused");

  const measured = {
    coverage: coverage(record.coverage),
    inventory: inventory(record.inventory),
    findings: findings(record.findings),
    packageInventory: packageInventory(record.packageInventory),
    scanner: scanner(record.scanner),
    recipe: recipe(record.provenance?.recipe),
    limits: limits(record.limits),
  };
  const codeFor = {
    coverage: "original-coverage-malformed",
    inventory: "original-inventory-malformed",
    findings: "original-findings-malformed",
    packageInventory: "original-package-inventory-malformed",
    scanner: "original-scanner-malformed",
    recipe: "original-recipe-malformed",
    limits: "original-limits-malformed",
  };
  for (const [name, value] of Object.entries(measured)) if (value === undefined) refuse(codeFor[name]);

  /**
   * …and the scanner identity must BE the pinned one, not merely look like one. This is a second
   * check on top of the shape validation above, never a replacement for it: the shape decides the
   * record is readable, this decides the record is about the scanner reviewed source pins.
   */
  if (measured.scanner !== undefined) {
    for (const [field, code] of SCANNER_BINDING) if (measured.scanner[field] !== SCANNER[field]) refuse(code);
  }

  /**
   * THE AFFIRMATIVE IDENTITY BIT (item 3). Readiness needs to know whether the manifest/config/layer
   * identity chain, the revision labels and the receipt-tag readback all held — and the artifact
   * recorded that ONLY as prose inside a blocker string, which is not a measurement anything can
   * recompute from. `assembleAudit` now persists the boolean it already had; a record without it is
   * refused rather than assumed verified, because assuming is the whole defect.
   */
  const identityVerified = bool(record.provenance?.identityVerified);
  if (identityVerified === undefined) refuse("original-identity-not-measured");

  if (!matches(ISO, record.startedAt) || !matches(ISO, record.completedAt)) refuse("original-timestamps-malformed");

  if (codes.length) return { ok: false, codes: Object.freeze(codes) };

  /**
   * INTERNAL CONSISTENCY — the half a shape check cannot see. Each of these is a property the real
   * pipeline cannot violate, so a record that violates one was not produced by it.
   */
  const inconsistent = [
    // `coverage.complete` IS `limitations.length === 0` in `inspectExport`, and `coverageWithCanary`
    // only ever adds a limitation and clears the flag together.
    measured.coverage.complete !== (measured.coverage.limitations.length === 0),
    // `inventorySummary` derives both from the same missing list.
    measured.inventory.complete !== ((measured.inventory.counts.missing ?? 0) === 0),
    measured.findings.rules !== measured.findings.groups.length,
    measured.findings.total !== measured.findings.groups.reduce((sum, group) => sum + group.count, 0),
    // A verdict is DERIVED from the measurements; `clean` cannot coexist with any of them failing.
    record.verdict === "clean" && (measured.findings.total > 0 || measured.inventory.findings > 0
      || !measured.coverage.complete || !identityVerified),
    // `transitionReady` is `blockers.length === 0`, and a ready record is a clean one.
    record.transitionReady && (record.verdict !== "clean" || (record.blockers ?? []).length > 0),
    // The canary's `unverified` is mirrored into coverage as a limitation by `coverageWithCanary`;
    // a record claiming complete coverage beside an unverified canary contradicts its own scanner.
    measured.scanner.capabilityCanary !== undefined
      && measured.scanner.capabilityCanary.status !== "verified" && measured.coverage.complete,
  ];
  if (inconsistent.some(Boolean)) return { ok: false, codes: Object.freeze(["original-internally-inconsistent"]) };

  return {
    ok: true,
    observations: Object.freeze({
      ...measured,
      identityVerified,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      /** For provenance only — never a source of truth about what was measured. */
      auditRunId: matches(/^[0-9]{1,20}$/, record.audit?.runId) ? record.audit.runId : undefined,
      verdict: record.verdict,
      transitionReady: record.transitionReady,
    }),
  };
}
