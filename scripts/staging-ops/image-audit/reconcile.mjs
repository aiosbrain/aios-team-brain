/**
 * AIO-997 audit — PUB-05's operator inventory path, made CALLABLE (F6).
 *
 * WHY THIS FILE EXISTS. The spec documents an alternate route to the transition gate: when the
 * Actions token cannot enumerate the package's versions, a signed-in package administrator may
 * supply a complete read-only inventory instead. `reconcilePackageInventory` implemented the
 * validation for that route — and nothing anywhere called it. A documented alternate path with no
 * entry point is not an alternate path; it is a function with tests.
 *
 * WHAT THIS IS NOT, and the shape is deliberate about each one:
 *
 *   • **Not a force-ready flag.** There is no argument here that clears a blocker. Every content,
 *     identity, recipe and scanner blocker the original audit recorded is carried through verbatim,
 *     recomputed from the ORIGINAL record by the same function that produced it. The ONLY dimension
 *     this can move is the package-version inventory, and only to `verified`.
 *   • **Not a re-audit.** It makes no provider call, no registry read, no network request at all. It
 *     reads two local JSON files and writes a third.
 *   • **Not a way to change the subject.** The audited digest comes from the pinned `SUBJECT` in
 *     reviewed source, never from either input file. An operator record naming a different digest is
 *     refused rather than reinterpreted.
 *
 * THE OUTPUT IS A SEPARATE RECORD. The original evidence is never rewritten: a reader must be able to
 * see both what the workflow measured on its own and what an operator added afterwards, which is
 * exactly the distinction `apiStatus` versus `source` preserves inside it.
 *
 *   • **Not a signing or provenance-authentication framework.** This is a LOCAL inventory-evidence
 *     helper. It reads two files off a disk, verifies that the first is a complete, internally
 *     consistent audit record ABOUT THE PINNED SUBJECT, and recomputes one dimension of readiness
 *     from it. It verifies no signature and can prove nothing about where the record came from —
 *     the coordinator still confirms the original run and artifact independently.
 */
import { buildEvidence, transitionReadiness } from "./evidence.mjs";
import { ORIGINAL_SCHEMA, validateOriginalEvidence } from "./original-evidence.mjs";
import { reconcilePackageInventory } from "./registry.mjs";
import { SUBJECT, SUBJECT_REFERENCE } from "./subject.mjs";

export const RECONCILIATION_SCHEMA = "aios.staging-ops.image-audit.reconciliation.v1";

/**
 * The operator record must name THIS subject before anything else is read from it.
 *
 * A record that identifies the right package, revision and digest is the minimum for its version
 * list to be about the artifact under audit. These three are checked here rather than inside
 * `reconcilePackageInventory` because they are about the RECORD's provenance, not about the
 * inventory's completeness, and a coordinator reading a refusal needs to know which one failed.
 */
export function subjectBindingFailures(operator, subject = SUBJECT) {
  const failures = [];
  if (operator?.subject?.digest !== subject.digest) failures.push("the operator record does not name the pinned subject digest");
  if (operator?.subject?.package !== subject.package) failures.push("the operator record does not name the pinned subject package");
  if (operator?.subject?.sourceRevision !== subject.sourceRevision) failures.push("the operator record does not name the pinned subject source revision");
  return failures;
}

/**
 * A record that says WHY the original was refused, and nothing else.
 *
 * It is still a written artifact rather than a thrown error: an operator who ran this command needs
 * to see which check failed, and a `refused` verdict with `transitionReady: false` is the same shape
 * the audit itself writes when a stage does not complete. Nothing from either input reaches it — the
 * codes are a closed vocabulary in reviewed source.
 */
function refusal(codes, subject, now) {
  return buildEvidence({
    schema: RECONCILIATION_SCHEMA,
    verdict: "refused",
    transitionReady: false,
    blockers: Object.freeze(codes.map((code) => `the original audit record was refused: ${code}`)),
    subject: { ...subject, reference: SUBJECT_REFERENCE },
    provenance: Object.freeze({
      refusal: Object.freeze({ codes: Object.freeze([...codes]) }),
      note:
        "no reconciliation was performed. The record supplied as the original audit is not a complete, " +
        "internally consistent measurement of the pinned subject, so there was nothing to substitute a " +
        "package inventory INTO. Re-run the audit; an operator inventory cannot stand in for one.",
    }),
    completedAt: now().toISOString(),
  });
}

/**
 * The reconciliation record, built and leak-guarded exactly like the audit's own artifact.
 *
 * `record` is the sanitized evidence the audit wrote; `operator` is the administrator's read-only
 * inventory. NEITHER IS TRUSTED, and the order below is the fix for what the frozen version did:
 *
 *   1. The ORIGINAL is validated first (`validateOriginalEvidence`) — schema, exact subject binding,
 *      every required observation with the right types, and internal consistency. A failure is a
 *      refusal; there is no path from here to a record, let alone a ready one.
 *   2. Readiness is RECOMPUTED from those validated observations with `transitionReadiness` — the
 *      same function the audit itself used — rather than inferred by filtering the record's own
 *      `blockers` array. That array is now read for exactly one thing: whether it is consistent with
 *      the record's own `transitionReady`. An absent blocker list can no longer mean "nothing was
 *      wrong", which is how `{}` used to come back clean and ready.
 *   3. ONLY the package inventory is substituted, and only after `reconcilePackageInventory` has
 *      validated the operator's evidence against the pinned subject digest.
 */
export function reconcileEvidence({ record, operator, subject = SUBJECT, now = () => new Date() }) {
  const original = validateOriginalEvidence(record, subject);
  if (!original.ok) return refusal(original.codes, subject, now);
  const measured = original.observations;

  const bindingFailures = subjectBindingFailures(operator, subject);
  const packageInventory = bindingFailures.length
    ? Object.freeze({
      ...measured.packageInventory,
      operatorEvidence: Object.freeze({ accepted: false, failures: Object.freeze(bindingFailures) }),
    })
    : reconcilePackageInventory(measured.packageInventory, operator, { subjectDigest: subject.digest });

  /**
   * THE SHARED DECISION LOGIC, not a local re-derivation. Every non-inventory dimension comes from
   * the validated original; only `packageInventory` is the substituted one. A gap in coverage, a
   * failed identity chain, an unverified recipe assertion or a scanner finding therefore blocks here
   * by the same rule that blocked it in the audit — by construction, rather than by a string match
   * that could silently fail to recognise a blocker and drop it.
   */
  const readiness = transitionReadiness({
    coverage: measured.coverage,
    inventory: measured.inventory,
    findings: measured.findings,
    packageInventory,
    identityVerified: measured.identityVerified,
    recipe: measured.recipe,
  });

  return buildEvidence({
    schema: RECONCILIATION_SCHEMA,
    ...readiness,
    // FROM REVIEWED SOURCE. The validated record has already been shown to name this subject, so
    // this is a restatement rather than the silent overwrite it used to be.
    subject: { ...subject, reference: SUBJECT_REFERENCE },
    provenance: Object.freeze({
      reconciledFrom: Object.freeze({
        schema: ORIGINAL_SCHEMA,
        verdict: measured.verdict,
        transitionReady: measured.transitionReady,
        completedAt: measured.completedAt,
        auditRunId: measured.auditRunId,
      }),
      // Carried because readiness is recomputed FROM them: a reader must be able to see the identity
      // bit and the recipe rows the verdict above was derived from.
      identityVerified: measured.identityVerified,
      recipe: measured.recipe,
      note:
        "this record substitutes an operator-supplied package version inventory for the workflow's own " +
        "API read. It re-measures nothing else: every content, identity, build-recipe and scanner " +
        "blocker of the original audit is recomputed above from that audit's own measurements. It is a " +
        "local evidence helper and authenticates nothing: the coordinator verifies the original run.",
    }),
    // The VALIDATED, allowlisted copies — never the input's nested payloads.
    coverage: measured.coverage,
    inventory: measured.inventory,
    findings: measured.findings,
    packageInventory,
    scanner: measured.scanner,
    limits: measured.limits,
    startedAt: measured.startedAt,
    completedAt: now().toISOString(),
  });
}
