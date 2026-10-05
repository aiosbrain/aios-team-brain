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
import { EVIDENCE_SCHEMA, VERDICTS } from "./evidence.mjs";
import { UNSUPPORTED_FORMATS } from "./export-walk.mjs";
import { CANARY_TEXT, CANARY_UNVERIFIED_REASONS, SCAN_REPRESENTATION } from "./scan-surface.mjs";
import { SCANNER, settingsMatchPolicy } from "./scanner.mjs";
import { AUDIT_LIMITS, SUBJECT } from "./subject.mjs";

/**
 * The schema the audit's own artifact carries — THE constant `buildEvidence` writes, not a copy of
 * its text. Two literals that must agree is a drift this module cannot detect: a record written by a
 * newer audit would simply be refused as another schema.
 */
export const ORIGINAL_SCHEMA = EVIDENCE_SCHEMA;

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
  "original-scanner-config-sha256-mismatch",
  "original-scanner-settings-unsupported",
  "original-scan-representation-unsupported",
  "original-scanner-canary-malformed",
  "original-scanner-canary-representation-mismatch",
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
/**
 * A path the audit already established as public source content. Never absolute, never traversing.
 *
 * THE CONSTRAINT IS THE SHAPE, NOT THE ALPHABET. This was a filename-character allowlist that had no
 * place for `[` or `]`, and this repository has 70+ real Next.js dynamic routes carrying them
 * (`app/t/[team]/projects/[project]/page.tsx`). `publicPathResolver` emits such a path verbatim once
 * the audit's own expected-tree lookup resolves it, so one finding there refused the ENTIRE record as
 * `original-findings-malformed` — the wrong failure mode, since findings block the transition on
 * their own merits and a malformed-record refusal hides the real reason.
 *
 * So: printable ASCII (which excludes NUL and every control byte), not absolute, no `..` segment,
 * and bounded at 300 characters — the same bound the free-text fields in this file carry.
 *
 * TWO FORMS THE SENTENCE ABOVE DID NOT ACTUALLY REFUSE. `/` is the only separator these lookaheads
 * understand, so `..\..\etc\shadow` and `C:\Windows\x` were read as ordinary relative names and
 * validated — "never absolute, never traversing" was a claim about POSIX spelling, not about the
 * strings this pattern accepted. And `"   "` is printable ASCII within the bound while naming
 * nothing. Neither is exploitable here (no code opens, shells out on, or decodes this value; it only
 * reaches a JSON artifact), but a pattern whose comment overstates it is the kind of claim a later
 * reader builds on. So: no backslash anywhere, and at least one character that is neither
 * whitespace nor a separator.
 */
const PUBLIC_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?=.*[^\s/])[\x20-\x7e]{1,300}$/;
/** Printable ASCII only: a reason or detail this module passes through must be readable text. */
const printable = (max) => new RegExp(`^[\\x20-\\x7e]{0,${max}}$`);

/**
 * Keep the listed keys, and REFUSE any key nobody listed.
 *
 * The refusal half is the point. Dropping an unknown field silently would make this an allowlist for
 * the output while leaving the input free to carry anything — and "the record validated" would then
 * say nothing about the object that was validated.
 *
 * LISTED MEANS OWNED, and that is not a detail. `fields[key]` alone is a PROTOTYPE-CHAIN lookup on a
 * plain object literal, so `fields.constructor` found the built-in `Object` rather than `undefined`:
 * the refusal branch never fired for a `constructor` key, the rule applied was `Object(value)`, and
 * `Object` returns an object argument UNCHANGED — so an attacker-shaped payload under `constructor`
 * validated and was serialized verbatim into the reconciled record, which is as public as the audit's
 * own artifact. `__proto__`, `hasOwnProperty`, `toString` and `valueOf` reached the same branch with a
 * non-callable rule or an `Object.prototype` method called with no receiver. `Object.hasOwn` is what
 * makes the allowlist mean what the paragraph above says it means.
 */
function pick(value, fields) {
  const out = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) return undefined; // inherited is not listed: see above
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
/**
 * A map whose KEYS are open (a settings name, a source path) but constrained by a pattern.
 *
 * `__proto__` is refused outright rather than pattern-matched: `sourceHashes`' key pattern admits
 * underscores, and `out["__proto__"] = "sha256:…"` is a no-op assignment on a plain object, so the
 * entry would VANISH from the validated output while the record still validated. Same class as the
 * `pick` defect above — a key whose meaning comes from the prototype rather than from the record —
 * and refused the same way, so the two cannot disagree.
 */
const objectOf = (keyPattern, rule) => (value) => {
  if (!isObject(value)) return undefined;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || !matches(keyPattern, key)) return undefined;
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

/**
 * `representation` and `archiveSurfaceBytes` are REQUIRED (AC-AUDIT-01/02): a complete-coverage claim
 * is only meaningful against a stated representation, and only v2 staged the archive surface.
 */
const coverage = shape({
  complete: required(bool),
  layers: required(count),
  members: required(count),
  stagedBytes: required(count),
  limitations: required(listOf(limitation)),
  stagedByteLimit: (value) => (isCount(value) || value === "unbounded" ? value : undefined),
  representation: required(text(DOTTED)),
  archiveSurfaceBytes: required(count),
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

/**
 * THE SCANNER MEASUREMENTS ARE REQUIRED (AC-AUDIT-06). `configSha256`, `settings`, `representation`
 * and `capabilityCanary` used to be optional, and an independent probe reconciled a record with all
 * four DROPPED to `clean` / ready — while the successful audit always emits them. A measurement the
 * producer always writes and the validator never requires is not a measurement anything checks.
 *
 * The shapes here decide the values are readable; `scannerBindingCodes` below decides they are the
 * REVIEWED values, with a fixed code per failure.
 */
const scanner = shape({
  name: required(text(/^[a-z0-9-]{1,32}$/)),
  version: required(text(/^[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}$/)),
  sha256: required(text(SHA256)),
  configPath: required(text(PUBLIC_PATH)),
  configSha256: required(text(SHA256)),
  settings: required(objectOf(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/, (value) => (
    matches(printable(600), value) ? value : listOf(text(printable(600)))(value)
  ))),
  representation: required(shape({
    version: required(text(DOTTED)),
    header: required(text(/^[\x20-\x7e\n]{0,200}$/)),
    suffix: required(text(/^\.[a-z0-9]{1,8}$/)),
    note: text(printable(600)),
  })),
  /**
   * `note` is NOT optional decoration — it is the field the VERIFIED path always writes
   * (`assessCanary` in `scan-surface.mjs`), and omitting it from this list refused every record whose
   * scanner had actually proved its capability, because `pick` refuses a key nobody listed. The only
   * canary that validated was the unverified one, which carries no `note` and blocks anyway: the
   * healthy case this route exists for was dead on arrival. Listed, not required, because the two
   * paths genuinely differ.
   */
  capabilityCanary: required(shape({
    status: required(oneOf(["verified", "unverified"])),
    representation: required(text(DOTTED)),
    reason: text(printable(300)),
    binaryMagicSkipReproduced: bool,
    archiveSurfaceDetected: bool,
    note: text(printable(500)),
  })),
});

/**
 * The measured scanner against REVIEWED CONSTANTS — never against anything the record supplies.
 *
 *   - `configSha256` must be the pinned `SCANNER.configSha256` (AC-AUDIT-07). A syntactically valid
 *     wrong digest is exactly the probe that used to reconcile to ready.
 *   - `settings` must equal the reviewed policy the producer enforces (AC-AUDIT-06).
 *   - `representation` must BE the supported v2 representation, field for field (AC-AUDIT-01).
 *   - the canary must name that representation, and a VERIFIED canary must carry both measured
 *     booleans with the archive surface detected (AC-AUDIT-07). An UNVERIFIED canary stays
 *     representable — it validates as a blocked audit — but its `archiveSurfaceDetected`, if any, is
 *     optional because the unreadable-counts path has no answer to report.
 */
function scannerBindingCodes(measured) {
  const codes = [];
  if (measured.configSha256 !== SCANNER.configSha256) codes.push("original-scanner-config-sha256-mismatch");
  if (!settingsMatchPolicy(measured.settings)) codes.push("original-scanner-settings-unsupported");
  const representation = measured.representation;
  if (representation.version !== SCAN_REPRESENTATION.version || representation.header !== SCAN_REPRESENTATION.header
    || representation.suffix !== SCAN_REPRESENTATION.suffix || representation.note !== SCAN_REPRESENTATION.note) {
    codes.push("original-scan-representation-unsupported");
  }
  const canary = measured.capabilityCanary;
  if (canary.representation !== SCAN_REPRESENTATION.version) codes.push("original-scanner-canary-representation-mismatch");
  // The canary's TEXT is bound to the constants the producer writes: its `note`/`reason` reach the
  // public reconciled record, so any other printable string is refused rather than carried.
  if (canary.status === "verified"
    && (!isBool(canary.binaryMagicSkipReproduced) || canary.archiveSurfaceDetected !== true || canary.reason !== undefined
      || canary.note !== CANARY_TEXT.verifiedNote)) {
    codes.push("original-scanner-canary-malformed");
  }
  if (canary.status === "unverified" && (!CANARY_UNVERIFIED_REASONS.includes(canary.reason) || canary.note !== undefined)) {
    codes.push("original-scanner-canary-malformed");
  }
  return codes;
}

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

  /**
   * A PRE-REMEDIATION (v1) ORIGINAL IS REFUSED BY NAME (AC-AUDIT-01), before and independently of the
   * shape checks, so a v1 record always carries this code rather than only a generic "malformed" one.
   * Its complete-coverage claim was made without the archive surface; no operator inventory can
   * grandfather that. It needs a fresh audit.
   */
  if (record.coverage?.representation !== SCAN_REPRESENTATION.version
    || record.scanner?.representation?.version !== SCAN_REPRESENTATION.version) {
    refuse("original-scan-representation-unsupported");
  }

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
    for (const code of scannerBindingCodes(measured.scanner)) refuse(code);
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
    measured.scanner.capabilityCanary.status !== "verified" && measured.coverage.complete,
    // The ARCHIVE SURFACE is part of the staged total, never more than it (AC-AUDIT-02)…
    measured.coverage.archiveSurfaceBytes > measured.coverage.stagedBytes,
    // …and complete coverage of N layers staged at least each layer's two end blocks: a valid layer
    // cannot be complete with less surface than that.
    measured.coverage.complete && measured.coverage.archiveSurfaceBytes < 2 * 512 * measured.coverage.layers,
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
