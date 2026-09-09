/**
 * AIO-997 audit — THE PINNED SUBJECT, and the bounds every stage of the audit runs inside.
 *
 * WHAT THIS IS. The audit has no registry/repository/ref/digest input, deliberately (PUB-01). The one
 * artifact it will ever look at is the tuple below, in reviewed source. Auditing a different digest is
 * a reviewed edit to this file, not a dispatch parameter — so "which image was audited" is answered by
 * the commit, not by whoever pressed the button.
 *
 * WHAT IT IS NOT. Not a registry client, not a policy engine, not a place to put a default that a
 * caller can widen. Every export here is frozen.
 */
import { publicationTag, IMAGE, REPOSITORY, PLATFORM } from "../image-publication.mjs";

/**
 * The reviewed subject. Read from
 * `publisher-live-34398108263/staging-ops-image-receipt-34398108263.1/staging-ops-image-receipt.json`
 * and cross-checked against the registry and the run during execution — the values here are the
 * CLAIM, and the audit's job is to measure whether the registry still agrees with it.
 *
 * `sourceRevision` is the commit the IMAGE was built from. It is NOT the commit this audit code runs
 * at: the audit's own dispatch SHA identifies audit code and nothing else, and conflating the two
 * would let a later audit revision silently re-describe an older artifact's provenance.
 */
export const SUBJECT = Object.freeze({
  package: IMAGE,
  repository: REPOSITORY,
  platform: PLATFORM,
  digest: "sha256:00058245a63cfe0da5ed69c2dc3c0225dc9c17cde82e6b5ff157caf527f88d0f",
  sourceRevision: "11eb039bd07ed82d0b2dc052e3fc2611879bf063",
  originalRunId: "34398108263",
  originalRunAttempt: "1",
  /**
   * Derived, never typed twice. `publicationTag` is the publisher's own tag builder, so a tag this
   * audit tries to resolve cannot drift from the tag the publisher would have pushed — the agreement
   * is structural instead of a copied string two files apart.
   */
  receiptTag: publicationTag({
    sha: "11eb039bd07ed82d0b2dc052e3fc2611879bf063",
    runId: "34398108263",
    runAttempt: "1",
  }),
});

export const SUBJECT_REFERENCE = `${SUBJECT.package}@${SUBJECT.digest}`;
export const SUBJECT_TAG_REFERENCE = `${SUBJECT.package}:${SUBJECT.receiptTag}`;

/**
 * The audit's OWN trusted dispatch context (PUB-01). The publisher's guard is reused for everything
 * except this path — the audit workflow's `workflow_ref` names the AUDIT file, and asserting the
 * publisher's path here would accept a run of the wrong workflow.
 */
export const AUDIT_WORKFLOW_PATH = ".github/workflows/staging-ops-image-audit.yml";

/**
 * Layer media types this implementation will DECODE, and how.
 *
 * Deliberately a closed map rather than a suffix test. "Never guess gzip for every media type"
 * (PUB-02): an unknown or `+zstd` layer is refused as unsupported coverage, which fails the audit,
 * instead of being fed to a decompressor that would produce plausible-looking garbage.
 */
export const LAYER_MEDIA_TYPES = Object.freeze({
  "application/vnd.docker.image.rootfs.diff.tar.gzip": "gzip",
  "application/vnd.oci.image.layer.v1.tar+gzip": "gzip",
  "application/vnd.oci.image.layer.v1.tar": "tar",
});

/** Config descriptors this implementation understands. Anything else is an unexpected image shape. */
export const CONFIG_MEDIA_TYPES = Object.freeze([
  "application/vnd.docker.container.image.v1+json",
  "application/vnd.oci.image.config.v1+json",
]);

/**
 * BOUNDED EVERYTHING (PUB-01). The internal deadline expires BEFORE the job timeout, with the
 * remainder reserved for writing a sanitized incomplete record and letting the always-conditioned
 * upload run. A hard runner termination can still prevent that upload — which is why the evidence
 * record never claims durability it did not measure.
 *
 * Hitting any limit below reports INCOMPLETE COVERAGE. None of them silently narrows the audit.
 */
export const AUDIT_LIMITS = Object.freeze({
  /** Job `timeout-minutes` in the workflow. The guard pins the two together. */
  jobTimeoutMinutes: 60,
  /** Internal deadline: 45 min of work, 15 min reserved for sanitized failure evidence + upload. */
  internalDeadlineMs: 45 * 60_000,
  /** One `docker save` export. Larger than the ~1.5 GB runner image, small enough to bound the disk. */
  maxExportBytes: 8 * 1024 * 1024 * 1024,
  /** Ordered layers. The reviewed Dockerfile produces well under this. */
  maxLayerCount: 64,
  /** Members inspected per layer, and bytes expanded per layer. */
  maxMembersPerLayer: 500_000,
  maxExpandedBytesPerLayer: 6 * 1024 * 1024 * 1024,
  /** One member's decoded size. Larger members are recorded as an oversized-member limitation. */
  maxMemberBytes: 256 * 1024 * 1024,
  /** Nested archives inside a layer are expanded ONE level; deeper nesting is a recorded limitation. */
  maxNestedArchiveDepth: 1,
  /** Bytes of any subprocess diagnostic retained in PRIVATE scratch (never emitted). */
  maxSubprocessLogBytes: 4 * 1024 * 1024,
});

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

export function isDigest(value) {
  return DIGEST.test(String(value ?? ""));
}

export function assertSubjectShape(subject = SUBJECT) {
  const failures = [];
  if (!DIGEST.test(String(subject.digest ?? ""))) failures.push("subject digest is not a sha256:<64-hex> registry digest");
  if (!SHA40.test(String(subject.sourceRevision ?? ""))) failures.push("subject source revision is not a full 40-hex commit");
  if (!/^\d+$/.test(String(subject.originalRunId ?? ""))) failures.push("subject original run id is not numeric");
  if (!/^\d+$/.test(String(subject.originalRunAttempt ?? ""))) failures.push("subject original run attempt is not numeric");
  const expectedTag = publicationTag({
    sha: subject.sourceRevision,
    runId: subject.originalRunId,
    runAttempt: subject.originalRunAttempt,
  });
  if (subject.receiptTag !== expectedTag) failures.push(`subject receipt tag ${String(subject.receiptTag)} is not the publisher's tag ${expectedTag}`);
  if (failures.length) throw new Error(`the pinned audit subject is malformed:\n- ${failures.join("\n- ")}`);
  return subject;
}
