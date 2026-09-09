/**
 * AIO-997 audit — the registry and package-metadata reads, and what each answer is ALLOWED to mean.
 *
 * PUB-05's central failure mode: **an empty list and an unreadable list look identical**. A `403`
 * from the versions endpoint returns no versions, and code that counts what it received concludes
 * "one version, the audited one, safe to expose". So nothing here converts an error into a count.
 * `unverified` is a first-class outcome that BLOCKS, and it cannot be reached from a successful path.
 *
 * The second failure mode: **truncated pagination**. Ninety-nine versions on page one with a `next`
 * link nobody followed is also a complete-looking list. Completeness here means the walk ended
 * because the API said there was no next page, not because a loop bound was hit.
 *
 * Everything in this module is READ-ONLY. There is no method override anywhere, so the only request
 * these functions can issue is a GET — the audit workflow never changes a package's visibility, and
 * the code that would be needed to do so does not exist here.
 */
import { OWNER, PACKAGE } from "../image-publication.mjs";
import { sha256 } from "./layers.mjs";

export const PACKAGE_VERSIONS_URL = `https://api.github.com/orgs/${OWNER}/packages/container/${PACKAGE}/versions`;

const PAGE_SIZE = 100;
/** A hard walk bound, so a pathological `next` chain cannot run forever. Hitting it is UNVERIFIED. */
const MAX_PAGES = 50;

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "aios-staging-ops-image-audit",
  };
}

/** Does this `Link` header advertise another page? Absence is the ONLY thing that ends the walk. */
export function hasNextPage(linkHeader) {
  return /(^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(String(linkHeader ?? ""));
}

/**
 * One version row, reduced to what the transition gate needs: its immutable digest, its tags
 * (including none), and its id. For a container package GitHub returns the digest as `name`.
 */
export function normalizeVersion(version) {
  const digest = typeof version?.name === "string" ? version.name : "";
  const tags = version?.metadata?.container?.tags;
  return Object.freeze({
    id: version?.id,
    digest,
    tags: Object.freeze(Array.isArray(tags) ? [...tags] : []),
    untagged: Array.isArray(tags) ? tags.length === 0 : true,
  });
}

/**
 * Walk EVERY page of the package's versions.
 *
 * Returns `{ status: "verified", versions }` only when every page was read and the API said there
 * was no next page. Any non-200, any transport error, any page that does not parse, and the page
 * bound itself all return `{ status: "unverified", reason }` with NO version list — because a
 * partial list presented as an inventory is the exact mistake this exists to prevent.
 */
export async function listPackageVersions({ token, fetchImpl = globalThis.fetch } = {}) {
  if (!token) return { status: "unverified", reason: "no token was available for the package versions read" };
  const versions = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res;
    try {
      res = await fetchImpl(`${PACKAGE_VERSIONS_URL}?per_page=${PAGE_SIZE}&page=${page}`, { headers: headers(token) });
    } catch (error) {
      return { status: "unverified", reason: `the package versions read failed on page ${page}: ${error?.message ?? "transport error"}` };
    }
    if (res.status !== 200) {
      // 403 = this token cannot read package metadata. 404 = absent OR invisible to this token.
      // Neither is "the package has no other versions", and neither may be counted as one.
      return { status: "unverified", reason: `the package versions endpoint returned ${res.status} on page ${page}; this is not evidence of an empty package` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { status: "unverified", reason: `page ${page} of the package versions response did not parse` };
    }
    if (!Array.isArray(body)) return { status: "unverified", reason: `page ${page} of the package versions response is not an array` };
    versions.push(...body.map(normalizeVersion));
    if (!hasNextPage(res.headers?.get?.("link"))) {
      return { status: "verified", versions: Object.freeze(versions), pages: page };
    }
  }
  return { status: "unverified", reason: `the package versions walk hit its ${MAX_PAGES}-page bound with more pages advertised` };
}

/**
 * What the inventory means for the transition, against the ONE audited digest.
 *
 * "A clean audit of the stated digest does not authorize exposing unaudited other digests in the same
 * package" — so any additional version, tagged or not, stops the transition and is returned as an
 * exact subject list for a bounded audit. It is not deleted, not ignored, and not assumed to be a
 * stale copy of the same content.
 */
export function assessPackageInventory(inventory, auditedDigest) {
  if (inventory?.status !== "verified") {
    return Object.freeze({
      source: "actions-api",
      apiStatus: "unverified",
      status: "unverified",
      reason: inventory?.reason ?? "the package version inventory was not measured",
      otherVersions: undefined,
    });
  }
  const versions = inventory.versions ?? [];
  const audited = versions.filter((version) => version.digest === auditedDigest);
  const others = versions.filter((version) => version.digest !== auditedDigest);
  if (audited.length === 0) {
    return Object.freeze({
      source: "actions-api",
      apiStatus: "verified",
      status: "unverified",
      reason: `the audited digest ${auditedDigest} does not appear in the package's ${versions.length} version(s); the inventory and the subject disagree`,
      otherVersions: others.length,
    });
  }
  return Object.freeze({
    source: "actions-api",
    apiStatus: "verified",
    status: "verified",
    pages: inventory.pages,
    total: versions.length,
    otherVersions: others.length,
    untagged: versions.filter((version) => version.untagged).length,
    // The exact additional subjects a bounded audit would have to cover. Digests only — a digest is
    // not sensitive, and naming them is the whole value of the inventory.
    additionalSubjects: Object.freeze(others.map((version) => version.digest)),
  });
}

/**
 * PUB-05's alternate path: a signed-in package administrator's complete read-only UI inventory.
 *
 * TWO PROPERTIES, and the second is the one a shortcut would lose. (1) Operator evidence CAN satisfy
 * the transition gate. (2) It must NEVER be written back as though the API inventory succeeded —
 * `apiStatus` is preserved exactly as measured, and `source` says which one the gate is standing on.
 * Anyone reading the record later can see that the workflow's own read failed.
 */
export function reconcilePackageInventory(assessment, operatorEvidence) {
  if (!operatorEvidence) return assessment;
  const failures = [];
  if (!operatorEvidence.capturedAt) failures.push("operator evidence carries no capture timestamp");
  if (operatorEvidence.coversAllPages !== true) failures.push("operator evidence does not attest that every page was covered");
  if (operatorEvidence.coversUntagged !== true) failures.push("operator evidence does not attest that untagged versions were included");
  const digests = Array.isArray(operatorEvidence.digests) ? operatorEvidence.digests : [];
  if (digests.length === 0) failures.push("operator evidence lists no version digests");
  // A truncated digest is the thing a screenshot of the packages page actually shows, and it cannot
  // identify a version. Asserted rather than trusted.
  const malformed = digests.filter((digest) => !/^sha256:[0-9a-f]{64}$/.test(String(digest ?? "")));
  if (malformed.length) failures.push(`${malformed.length} operator-supplied digest(s) are not full sha256 digests`);
  if (failures.length) {
    return Object.freeze({ ...assessment, operatorEvidence: Object.freeze({ accepted: false, failures: Object.freeze(failures) }) });
  }
  const others = digests.filter((digest) => digest !== operatorEvidence.auditedDigest);
  return Object.freeze({
    ...assessment,
    // PRESERVED. The workflow's own read is still reported exactly as it went.
    apiStatus: assessment.apiStatus,
    source: "operator-evidence",
    status: "verified",
    total: digests.length,
    otherVersions: others.length,
    additionalSubjects: Object.freeze(others),
    operatorEvidence: Object.freeze({ accepted: true, capturedAt: String(operatorEvidence.capturedAt) }),
  });
}

/**
 * L1's receipt-tag readback. The original publication's immutable run tag must STILL resolve to the
 * pinned digest.
 *
 * A mismatch does not select a new subject — it refuses provenance success while the audit target
 * stays exactly what reviewed source pinned. That distinction is the whole point: a tag is mutable
 * and a digest is not, so a tag that moved is evidence about the tag, never about which artifact to
 * inspect.
 */
export function classifyTagReadback(rawManifest, pinnedDigest) {
  if (rawManifest === undefined || rawManifest === null || rawManifest.length === 0) {
    return Object.freeze({ status: "unverified", reason: "the original receipt tag could not be read back from the registry" });
  }
  const measured = sha256(Buffer.isBuffer(rawManifest) ? rawManifest : Buffer.from(String(rawManifest), "utf8"));
  if (measured !== pinnedDigest) {
    return Object.freeze({
      status: "mismatch",
      reason: `the original receipt tag now resolves to ${measured}, not the pinned ${pinnedDigest}; the audit subject is unchanged`,
    });
  }
  return Object.freeze({ status: "confirmed", digest: measured });
}
