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
 */
import { buildEvidence, packageInventoryBlockers } from "./evidence.mjs";
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
 * Recompute readiness with the operator's inventory substituted for the API's.
 *
 * THE RETENTION IS THE POINT. `retained` is the original blocker list with exactly the strings the
 * original package-inventory computation produced removed — recomputed from the original record's own
 * `packageInventory`, so the removal is provably the same set that was added, and anything the
 * function does not recognise stays. A blocker about coverage, identity, the recipe or a scanner
 * finding cannot be dropped here, because nothing here has a rule that would drop it.
 */
export function reconcileReadiness(record, packageInventory) {
  const original = Array.isArray(record?.blockers) ? record.blockers : [];
  const superseded = new Set(packageInventoryBlockers(record?.packageInventory));
  const retained = original.filter((blocker) => !superseded.has(blocker));
  const blockers = [...retained, ...packageInventoryBlockers(packageInventory)];
  return {
    blockers: Object.freeze(blockers),
    transitionReady: blockers.length === 0,
    /**
     * A verdict can only IMPROVE to `clean`, and only when nothing is left. Otherwise the original
     * verdict stands: it was derived from findings and coverage this function did not re-measure, and
     * recomputing it from a partial view would be the one way to make a record read better than what
     * was measured.
     */
    verdict: blockers.length === 0 ? "clean" : record?.verdict === "clean" ? "unresolved" : String(record?.verdict ?? "unresolved"),
  };
}

/**
 * The reconciliation record, built and leak-guarded exactly like the audit's own artifact.
 *
 * `record` is the sanitized evidence the audit wrote; `operator` is the administrator's read-only
 * inventory. Neither is trusted: the subject binding is checked against reviewed source, the
 * inventory is validated field by field, and the result goes through the same allowlist and the same
 * sensitive-shape guard before it can be written.
 */
export function reconcileEvidence({ record, operator, subject = SUBJECT, now = () => new Date() }) {
  const bindingFailures = subjectBindingFailures(operator, subject);
  const packageInventory = bindingFailures.length
    ? Object.freeze({
      ...(record?.packageInventory ?? { source: "actions-api", apiStatus: "unverified", status: "unverified" }),
      operatorEvidence: Object.freeze({ accepted: false, failures: Object.freeze(bindingFailures) }),
    })
    : reconcilePackageInventory(record?.packageInventory ?? { source: "actions-api", apiStatus: "unverified", status: "unverified" }, operator, {
      subjectDigest: subject.digest,
    });
  const readiness = reconcileReadiness(record, packageInventory);
  return buildEvidence({
    schema: RECONCILIATION_SCHEMA,
    ...readiness,
    subject: { ...subject, reference: SUBJECT_REFERENCE },
    // PRESERVED VERBATIM. The original measurement is what a later reader needs in order to see that
    // the workflow's own read failed and an operator supplied the inventory instead.
    provenance: Object.freeze({
      reconciledFrom: Object.freeze({
        schema: record?.schema,
        verdict: record?.verdict,
        transitionReady: record?.transitionReady === true,
        completedAt: record?.completedAt,
        auditRunId: record?.audit?.runId,
      }),
      note:
        "this record substitutes an operator-supplied package version inventory for the workflow's own " +
        "API read. It re-measures nothing else: every content, identity, build-recipe and scanner " +
        "blocker of the original audit is retained above exactly as that audit recorded it.",
    }),
    // Carried through unchanged, so the reconciliation is a complete gate input rather than a diff a
    // reader has to apply by hand against another file.
    coverage: record?.coverage,
    inventory: record?.inventory,
    findings: record?.findings,
    packageInventory,
    scanner: record?.scanner,
    limits: record?.limits,
    startedAt: record?.startedAt,
    completedAt: now().toISOString(),
  });
}
