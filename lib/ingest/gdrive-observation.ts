/**
 * AIO-1167 R95 — the ORDER of Google Drive provider observations.
 *
 * Two connections can hold valid execution leases over the same provider file and deliver their reads
 * in any order. Arrival order, the per-connection execution fence, `modifiedTime` and opaque revision
 * ids are not the provider's order. Google Drive v3 `File.version` is: an output-only int64, documented
 * as a monotonically increasing version number reflecting every server-side change to the file. The
 * sidecar certifies one observation — body and mutable metadata bracketed by the same version — and
 * sends that version as `frontmatter.gdrive_version`, an opaque DECIMAL STRING. It is compared here as
 * a string, never through a JS number, so values past 2^53 (and past int64) neither truncate nor tie.
 *
 * PURE: no I/O. The decision is enforced by the canonical writer (`lib/ingest` `ingestItem`) under the
 * provider/item locks it already holds.
 */

export const GDRIVE_VERSION_KEY = "gdrive_version";

/** A valid provider version: a string of ASCII digits only, canonicalized without leading zeros.
 *  Anything else — a number (already possibly truncated), a sign, whitespace, an empty string — is
 *  `null` (missing/malformed). */
export function canonicalGdriveVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const stripped = value.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/** Compare two CANONICAL versions: length first, then lexicographic — exact for any length. */
export function compareGdriveVersions(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The canonical payload one provider version determines: the stored body (its content hash; the body
 * leads with the title) and the version-determined metadata. Per-connection fields (connection id,
 * diagnostics, the credential's view of revision history) are deliberately NOT part of it, so two
 * connections replaying one version agree.
 */
export function gdriveCanonicalFingerprint(contentSha: string, frontmatter: Record<string, unknown>): string {
  const field = (key: string) => (typeof frontmatter[key] === "string" ? frontmatter[key] : null);
  return JSON.stringify([contentSha, field("title"), field("source_ts"), field("modified_time")]);
}

export interface GdriveObservation {
  /** Canonical version, or null when missing/malformed (a legacy observation). */
  version: string | null;
  fingerprint: string;
}

/**
 * Whether an incoming observation may replace the canonical item.
 *   apply    — create; a strictly newer valid version; an equal version with the identical canonical
 *              payload (an idempotent replay — the unchanged path); a valid version upgrading a legacy
 *              (tokenless) item; or, as before this contract, a legacy observation over a legacy item.
 *   stale    — a strictly older valid version, or a missing/malformed version over an item that holds a
 *              valid one: never overwrites the canonical item.
 *   conflict — the same version with a DIFFERENT canonical payload: never replaced by arrival order;
 *              the canonical item stands and the conflict is recorded for reconciliation.
 */
export type GdriveObservationVerdict = "apply" | "stale" | "conflict";

export function decideGdriveObservation(
  stored: GdriveObservation | null,
  incoming: GdriveObservation,
): GdriveObservationVerdict {
  if (!stored || stored.version === null) return "apply";
  if (incoming.version === null) return "stale";
  const order = compareGdriveVersions(incoming.version, stored.version);
  if (order < 0) return "stale";
  if (order > 0) return "apply";
  return incoming.fingerprint === stored.fingerprint ? "apply" : "conflict";
}
