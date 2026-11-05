import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import type { IdentityMap } from "@/lib/identity/resolve";
import { normalizeGdriveContributions, supersededEvidenceKeys } from "@/lib/ingest/gdrive-contribution-store";
import {
  coalesceGdriveObservations, coalesceStoredGdriveEvidence, latestStoredGdriveObservations, mergeGdriveContributions,
} from "@/lib/ingest/gdrive-ledger";

/**
 * AIO-1167 R44 S4 — one observation, reported first by email and later by permission id, is ONE
 * activity.
 *
 * Spec. An email-only observation and a stable-id observation that names the same email at the same
 * role and instant are the same observation — the stable-id row is the explicit evidence — and they
 * coalesce in the frontmatter ledger, the evidence store and the Timeline read, in either order, with
 * the stable row's provenance kept. Only an UNAMBIGUOUS match coalesces: two different stable ids
 * carrying that email there leave the email-only row as it is. A different role, instant or email is
 * a different observation. Sharing an AIOS member is never evidence.
 */

const AT = "2026-10-20T10:00:00Z";
const EMAIL_ONLY = { email: "Person@Example.com", role: "editor", at: AT };
const STABLE = { external_id: "permission:P", email: "person@example.com", role: "editor", at: "2026-10-20T10:00:00.000Z" };

describe("coalesceGdriveObservations", () => {
  it.each([[[EMAIL_ONLY, STABLE]], [[STABLE, EMAIL_ONLY]]])("folds the email-only form into the stable one, in either order", (rows) => {
    expect(coalesceGdriveObservations(rows)).toEqual([STABLE]);
  });

  it("is not evidence when two stable ids carry the email at that instant", () => {
    const other = { ...STABLE, external_id: "permission:Q" };
    expect(coalesceGdriveObservations([EMAIL_ONLY, STABLE, other])).toEqual([EMAIL_ONLY, STABLE, other]);
  });

  it.each([
    ["another role", { ...EMAIL_ONLY, role: "commenter" }],
    ["another instant", { ...EMAIL_ONLY, at: "2026-10-20T10:00:01Z" }],
    ["another email", { ...EMAIL_ONLY, email: "else@example.com" }],
  ])("%s is a different observation", (_case, row) => {
    expect(coalesceGdriveObservations([row, STABLE])).toEqual([row, STABLE]);
  });

  it("a stable row without an email proves nothing about an email-only row", () => {
    const noEmail = { external_id: "permission:P", role: "editor", at: AT };
    expect(coalesceGdriveObservations([EMAIL_ONLY, noEmail])).toEqual([EMAIL_ONLY, noEmail]);
  });
});

describe("the ledger, the evidence store and the Timeline read agree", () => {
  it("the frontmatter ledger keeps one row, in both replay orders", () => {
    expect(mergeGdriveContributions([EMAIL_ONLY], [STABLE])).toEqual([STABLE]);
    expect(mergeGdriveContributions([STABLE], [EMAIL_ONLY])).toEqual([STABLE]);
  });

  it("the evidence store normalizes one observation and retires the stored email-only row", () => {
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [EMAIL_ONLY, STABLE] });
    expect(current.map((row) => row.externalId)).toEqual(["permission:P"]);
    const [legacy] = normalizeGdriveContributions({ source: "gdrive", contributions: [EMAIL_ONLY] });
    const stored = [{
      evidence_key: legacy.evidenceKey, external_id: null, email: "person@example.com", role: "editor",
      source_at: "2026-10-20 10:00:00+00", source_at_raw: AT,
    }];
    expect(supersededEvidenceKeys(stored, current)).toEqual([legacy.evidenceKey]);
    // Ambiguous: two stable ids carry the email — the email-only row is not retired.
    const ambiguous = normalizeGdriveContributions({
      source: "gdrive", contributions: [STABLE, { ...STABLE, external_id: "permission:Q" }],
    });
    expect(supersededEvidenceKeys(stored, ambiguous)).toEqual([]);
  });

  it("a ledger stored before coalescing renders one Timeline activity, with the stable provenance", () => {
    const identities: IdentityMap = {
      byEmail: new Map([["person@example.com", "member-a"]]), byHandle: new Map(), emailDomains: new Set(),
      byProviderId: new Map([["gdrive:permission:P", "member-a"]]),
      providerIdentityStates: new Map([["gdrive:permission:P", "linked"]]),
    } as unknown as IdentityMap;
    const rows = googleDriveContributionEvidence(
      { source: "gdrive", title: "Plan", contributions: [EMAIL_ONLY, STABLE] }, "item-1", identities,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: "member-a", role: "editor" });
    expect(rows[0].id).toContain("permission:P");
  });
});

describe("the Timeline's stored-evidence read (coalesceStoredGdriveEvidence)", () => {
  const row = (item: string, key: string, fields: { external_id?: string | null; email: string | null; role?: string; source_at?: string }) => ({
    item_id: item, evidence_key: key, external_id: fields.external_id ?? null, email: fields.email,
    role: fields.role ?? "editor", source_at: fields.source_at ?? "2026-10-20 10:00:00+00",
  });
  const emailOnly = row("item-1", "email-key", { email: "person@example.com" });
  const stable = row("item-1", "stable-key", { external_id: "permission:P", email: "Person@Example.com" });

  it.each([[[emailOnly, stable]], [[stable, emailOnly]]])("an evidence pair stored before coalescing is one row, the stable one", (rows) => {
    expect(coalesceStoredGdriveEvidence(rows)).toEqual([stable]);
  });

  it("only within one item: the same person, role and instant on ANOTHER item is another observation", () => {
    const elsewhere = { ...emailOnly, item_id: "item-2" };
    expect(coalesceStoredGdriveEvidence([elsewhere, stable])).toEqual([elsewhere, stable]);
  });

  it("two stable ids carrying the email leave the email-only row", () => {
    const other = row("item-1", "other-key", { external_id: "permission:Q", email: "person@example.com" });
    expect(coalesceStoredGdriveEvidence([emailOnly, stable, other])).toEqual([emailOnly, stable, other]);
  });
});

/**
 * AIO-1167 R51 — the Drive producer (`ingestion/aios_ingest/sources/gdrive.py` `_identity`) writes
 * `external_id: "author-email:<address>"` when Drive withholds a permission id. That key names the
 * address only: it is email-only evidence, not a stable id, so a later `permission:P` observation of the
 * same email, role and instant is the SAME observation — one row in the ledger, the evidence store and
 * the Timeline, in either replay order — while an author-email row keeps its own evidence key.
 */
describe("an author-email: observation is email-only evidence (R51)", () => {
  // The producer's real shapes: lowercased email, `_iso_utc` millisecond instants, display name kept.
  const AUTHOR_EMAIL = {
    provider: "gdrive", role: "editor", external_id: "author-email:person@example.com",
    email: "person@example.com", display_name: "Person", at: "2026-10-20T10:00:00.000Z",
  };
  const PERMISSION = {
    provider: "gdrive", role: "editor", external_id: "permission:P",
    email: "person@example.com", display_name: "Person", at: "2026-10-20T10:00:00.000Z",
  };
  const md5 = (value: string) => createHash("md5").update(value).digest("hex");

  it.each([
    ["author-email first", [AUTHOR_EMAIL], [PERMISSION]],
    ["permission first", [PERMISSION], [AUTHOR_EMAIL]],
  ])("the frontmatter ledger keeps the one permission row (%s)", (_order, stored, incoming) => {
    expect(mergeGdriveContributions(stored, incoming)).toEqual([PERMISSION]);
  });

  it.each([[[AUTHOR_EMAIL, PERMISSION]], [[PERMISSION, AUTHOR_EMAIL]]])("the evidence store normalizes one observation, in either order", (contributions) => {
    const rows = normalizeGdriveContributions({ source: "gdrive", contributions });
    expect(rows.map((row) => row.externalId)).toEqual(["permission:P"]);
  });

  it("is not a stable id beside two permission ids carrying the email: nothing coalesces", () => {
    const other = { ...PERMISSION, external_id: "permission:Q" };
    expect(mergeGdriveContributions([AUTHOR_EMAIL], [PERMISSION, other])).toEqual([AUTHOR_EMAIL, PERMISSION, other]);
  });

  it.each([
    ["another role", { ...PERMISSION, role: "commenter" }],
    ["another instant", { ...PERMISSION, at: "2026-10-20T10:00:01.000Z" }],
    ["another email", { ...PERMISSION, email: "else@example.com" }],
  ])("%s is a different observation", (_case, permission) => {
    expect(mergeGdriveContributions([AUTHOR_EMAIL], [permission])).toEqual([AUTHOR_EMAIL, permission]);
  });

  it("keeps the author-email row's own evidence key, byte-for-byte", () => {
    const [row] = normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR_EMAIL] });
    expect(row.evidenceKey).toBe(md5("id:author-email:person@example.com\u001feditor\u001f2026-10-20T10:00:00.000Z"));
  });

  it("author-email stored first: the permission write retires the stored author-email evidence row", () => {
    const [authorRow] = normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR_EMAIL] });
    const stored = [{
      evidence_key: authorRow.evidenceKey, external_id: AUTHOR_EMAIL.external_id, email: AUTHOR_EMAIL.email,
      role: "editor", source_at: "2026-10-20 10:00:00+00", source_at_raw: AUTHOR_EMAIL.at,
    }];
    // The write after the replay: the merged ledger, normalized.
    const current = normalizeGdriveContributions({
      source: "gdrive", contributions: mergeGdriveContributions([AUTHOR_EMAIL], [PERMISSION]),
    });
    expect(current.map((row) => row.externalId)).toEqual(["permission:P"]);
    expect(supersededEvidenceKeys(stored, current)).toEqual([authorRow.evidenceKey]);
    // Without the address on the stored row, its author-email key still names it.
    expect(supersededEvidenceKeys([{ ...stored[0], email: null }], current)).toEqual([authorRow.evidenceKey]);
    // Ambiguous: two permission ids carry the email — the author-email row is not retired.
    const ambiguous = normalizeGdriveContributions({
      source: "gdrive", contributions: [PERMISSION, { ...PERMISSION, external_id: "permission:Q" }],
    });
    expect(supersededEvidenceKeys(stored, ambiguous)).toEqual([]);
  });

  it("permission stored first: the author-email replay adds no evidence row and retires nothing", () => {
    const [permissionRow] = normalizeGdriveContributions({ source: "gdrive", contributions: [PERMISSION] });
    const stored = [{
      evidence_key: permissionRow.evidenceKey, external_id: PERMISSION.external_id, email: PERMISSION.email,
      role: "editor", source_at: "2026-10-20 10:00:00+00", source_at_raw: PERMISSION.at,
    }];
    const current = normalizeGdriveContributions({
      source: "gdrive", contributions: mergeGdriveContributions([PERMISSION], [AUTHOR_EMAIL]),
    });
    expect(current.map((row) => row.evidenceKey)).toEqual([permissionRow.evidenceKey]);
    expect(supersededEvidenceKeys(stored, current)).toEqual([]);
  });

  it("a backfilled (legacy-keyed) author-email row is still retired by its own observation's write", () => {
    const legacyKey = md5(`author-email:person@example.com\u001fperson@example.com\u001feditor\u001f${AUTHOR_EMAIL.at}`);
    const stored = [{
      evidence_key: legacyKey, external_id: AUTHOR_EMAIL.external_id, email: AUTHOR_EMAIL.email,
      role: "editor", source_at: "2026-10-20 10:00:00+00", source_at_raw: AUTHOR_EMAIL.at,
    }];
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR_EMAIL] });
    expect(supersededEvidenceKeys(stored, current)).toEqual([legacyKey]);
  });

  it.each([["author-email first"], ["permission first"]])("the Timeline's stored-evidence read keeps the permission row (%s)", (order) => {
    const authorRow = {
      item_id: "item-1", evidence_key: "author-key", external_id: AUTHOR_EMAIL.external_id,
      email: AUTHOR_EMAIL.email, role: "editor", source_at: "2026-10-20 10:00:00+00",
    };
    const permissionRow = { ...authorRow, evidence_key: "permission-key", external_id: PERMISSION.external_id };
    const rows = order === "author-email first" ? [authorRow, permissionRow] : [permissionRow, authorRow];
    expect(coalesceStoredGdriveEvidence(rows)).toEqual([permissionRow]);
  });
});

/**
 * AIO-1167 R52 — a retained legacy bare-email observation `{email: E, role: R, at: T}` and the actual
 * Drive producer shape with no permission id, `{external_id: "author-email:E", email: E, ...}`, are
 * ONE Google observation when the email, normalized role and instant match. `author-email:` stays
 * non-stable: the pair never folds into a permission id unless that id is the ONE stable id naming
 * the email there (R44 S4), and every evidence key stays exactly addressable.
 */
describe("a legacy bare-email row and the producer's author-email row are one observation (R52)", () => {
  // The legacy row spells the instant without milliseconds; the producer (`_iso_utc`) with them.
  const LEGACY = { email: "Person@Example.com", role: "Editor", at: "2026-10-20T10:00:00Z" };
  const AUTHOR = {
    provider: "gdrive", role: "editor", external_id: "author-email:person@example.com",
    email: "person@example.com", display_name: "Person", at: "2026-10-20T10:00:00.000Z",
  };
  const P = { ...AUTHOR, external_id: "permission:P" };
  const Q = { ...AUTHOR, external_id: "permission:Q" };
  const md5 = (value: string) => createHash("md5").update(value).digest("hex");
  const AUTHOR_KEY = md5("id:author-email:person@example.com\u001feditor\u001f2026-10-20T10:00:00.000Z");
  const LEGACY_KEY = md5(`\u001fperson@example.com\u001feditor\u001f${LEGACY.at}`);
  const orders = [
    ["legacy first", [LEGACY], [AUTHOR]],
    ["author-email first", [AUTHOR], [LEGACY]],
  ] as const;

  it.each(orders)("the frontmatter ledger keeps one row, the producer's (%s)", (_order, stored, incoming) => {
    expect(mergeGdriveContributions(stored, incoming)).toEqual([AUTHOR]);
  });

  it.each(orders)("the evidence store normalizes one observation under the author-email key (%s)", (_order, stored, incoming) => {
    const rows = normalizeGdriveContributions({ source: "gdrive", contributions: [...stored, ...incoming] });
    expect(rows.map((row) => [row.externalId, row.evidenceKey])).toEqual([[AUTHOR.external_id, AUTHOR_KEY]]);
  });

  it("evidence keys stay exactly addressable: the legacy row's own key and the author-email key are unchanged", () => {
    expect(normalizeGdriveContributions({ source: "gdrive", contributions: [LEGACY] })[0].evidenceKey).toBe(LEGACY_KEY);
    expect(normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR] })[0].evidenceKey).toBe(AUTHOR_KEY);
  });

  const storedRow = (key: string, row: { external_id?: string; email: string; at: string }) => ({
    evidence_key: key, external_id: row.external_id ?? null, email: row.email.toLowerCase(), role: "editor",
    source_at: "2026-10-20 10:00:00+00", source_at_raw: row.at,
  });

  it("writing the producer's row retires the stored legacy evidence row (legacy stored first)", () => {
    const current = normalizeGdriveContributions({
      source: "gdrive", contributions: mergeGdriveContributions([LEGACY], [AUTHOR]),
    });
    expect(supersededEvidenceKeys([storedRow(LEGACY_KEY, LEGACY)], current)).toEqual([LEGACY_KEY]);
  });

  it("a legacy replay after the producer's row retires nothing and adds no row (author-email stored first)", () => {
    const current = normalizeGdriveContributions({
      source: "gdrive", contributions: mergeGdriveContributions([AUTHOR], [LEGACY]),
    });
    expect(current.map((row) => row.evidenceKey)).toEqual([AUTHOR_KEY]);
    expect(supersededEvidenceKeys([storedRow(AUTHOR_KEY, AUTHOR)], current)).toEqual([]);
    // Evidence stored before R52 that still holds the legacy row too: that row is retired.
    expect(supersededEvidenceKeys([storedRow(AUTHOR_KEY, AUTHOR), storedRow(LEGACY_KEY, LEGACY)], current))
      .toEqual([LEGACY_KEY]);
  });

  const timelineRow = (key: string, row: { external_id?: string; email: string }, updated: string) => ({
    item_id: "item-1", evidence_key: key, external_id: row.external_id ?? null, email: row.email.toLowerCase(),
    role: "editor", source_at: "2026-10-20 10:00:00+00", updated_at: updated,
  });

  // Write times for the legacy and the author-email row: older, newer, and tied.
  const writeTimes = [
    ["legacy written first", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z"],
    ["legacy written last", "2026-10-22T00:00:00Z", "2026-10-21T00:00:00Z"],
    ["written at the same instant", "2026-10-21T00:00:00Z", "2026-10-21T00:00:00Z"],
  ] as const;

  it.each(writeTimes)("stored Timeline evidence is one activity, the author-email row's (%s, both input orders)", (_case, legacyAt, authorAt) => {
    const legacy = timelineRow(LEGACY_KEY, LEGACY, legacyAt);
    const author = timelineRow(AUTHOR_KEY, AUTHOR, authorAt);
    for (const rows of [[legacy, author], [author, legacy]]) {
      // As in the frontmatter ledger, the provider-keyed row wins over the bare one whatever the order
      // or write times: it carries the exact `author-email:` mapping authority.
      expect(latestStoredGdriveObservations(rows)).toEqual([author]);
    }
  });

  it("recency still decides between rows of the same provenance", () => {
    const older = "2026-10-21T00:00:00Z";
    const newer = "2026-10-22T00:00:00Z";
    // Two author-email rows of one observation (e.g. one adopted under the backfill's legacy key).
    const backfilled = timelineRow("author-legacy-key", AUTHOR, newer);
    const author = timelineRow(AUTHOR_KEY, AUTHOR, older);
    expect(latestStoredGdriveObservations([author, backfilled])).toEqual([backfilled]);
    expect(latestStoredGdriveObservations([backfilled, author])).toEqual([backfilled]);
    // Two bare-email rows of one observation.
    const bareOlder = timelineRow(LEGACY_KEY, LEGACY, older);
    const bareNewer = timelineRow("legacy-respelled", LEGACY, newer);
    expect(latestStoredGdriveObservations([bareNewer, bareOlder])).toEqual([bareNewer]);
    expect(latestStoredGdriveObservations([bareOlder, bareNewer])).toEqual([bareNewer]);
  });

  it.each(writeTimes)("the one Timeline activity keeps the exact author-email authority (A), never the roster email's owner (B) (%s)", (_case, legacyAt, authorAt) => {
    // The exact `gdrive:author-email:E` mapping is member A; the roster email E now belongs to B.
    const identities: IdentityMap = {
      byEmail: new Map([["person@example.com", "member-b"]]), byHandle: new Map(), emailDomains: new Set(),
      byProviderId: new Map([["gdrive:author-email:person@example.com", "member-a"]]),
      providerIdentityStates: new Map([["gdrive:author-email:person@example.com", "linked"]]),
    } as unknown as IdentityMap;
    // How the Timeline renders one stored evidence row (`lib/dashboard/work-timeline.ts`).
    const render = (row: ReturnType<typeof timelineRow>) => googleDriveContributionEvidence({
      source: "gdrive", title: "Plan",
      contributions: [{ external_id: row.external_id, email: row.email, display_name: null, role: row.role, at: row.source_at }],
    }, row.item_id, identities);
    const legacy = timelineRow(LEGACY_KEY, LEGACY, legacyAt);
    const author = timelineRow(AUTHOR_KEY, AUTHOR, authorAt);
    // The fixture discriminates: the bare row alone is never A's. Its email bridges to nobody — the
    // linked `author-email:` owner (A) and the roster owner (B) disagree (R53 email-bridge conflict).
    expect(render(legacy).map((row) => row.memberId)).toEqual([]);
    expect(render(author).map((row) => row.memberId)).toEqual(["member-a"]);
    for (const rows of [[legacy, author], [author, legacy]]) {
      const activities = latestStoredGdriveObservations(rows).flatMap(render);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ memberId: "member-a", role: "editor", at: "2026-10-20T10:00:00.000Z" });
    }
  });

  it("equivalent instant spellings are the same instant", () => {
    const offset = { ...LEGACY, at: "2026-10-20T15:30:00+05:30" };
    expect(mergeGdriveContributions([offset], [AUTHOR])).toEqual([AUTHOR]);
    expect(normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR, offset] })
      .map((row) => row.evidenceKey)).toEqual([AUTHOR_KEY]);
    const offsetKey = normalizeGdriveContributions({ source: "gdrive", contributions: [offset] })[0].evidenceKey;
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR] });
    expect(supersededEvidenceKeys([{ ...storedRow(offsetKey, offset), source_at_raw: offset.at }], current))
      .toEqual([offsetKey]);
  });

  it.each([
    ["another email", { ...LEGACY, email: "else@example.com" }],
    ["another role", { ...LEGACY, role: "commenter" }],
    ["another instant", { ...LEGACY, at: "2026-10-20T10:00:01Z" }],
  ])("%s is a different observation in the ledger, the evidence store and the Timeline", (_case, legacy) => {
    expect(mergeGdriveContributions([legacy], [AUTHOR])).toEqual([legacy, AUTHOR]);
    expect(normalizeGdriveContributions({ source: "gdrive", contributions: [legacy, AUTHOR] })).toHaveLength(2);
    const legacyKey = normalizeGdriveContributions({ source: "gdrive", contributions: [legacy] })[0].evidenceKey;
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [AUTHOR] });
    const stored = {
      evidence_key: legacyKey, external_id: null, email: legacy.email.toLowerCase(), role: legacy.role.toLowerCase(),
      source_at: new Date(legacy.at).toISOString(), source_at_raw: legacy.at,
    };
    expect(supersededEvidenceKeys([stored], current)).toEqual([]);
    expect(latestStoredGdriveObservations([
      { ...stored, item_id: "item-1", updated_at: "2026-10-21T00:00:00Z" },
      timelineRow(AUTHOR_KEY, AUTHOR, "2026-10-22T00:00:00Z"),
    ])).toHaveLength(2);
  });

  it("two stable ids naming the email keep it ambiguous: the email-only observation is one row, never folded", () => {
    expect(mergeGdriveContributions([LEGACY], [AUTHOR, P, Q])).toEqual([AUTHOR, P, Q]);
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [LEGACY, AUTHOR, P, Q] });
    expect(current.map((row) => row.externalId)).toEqual([AUTHOR.external_id, "permission:P", "permission:Q"]);
    // The stored legacy row is replaced by its email-only equivalent, not by either stable id.
    expect(supersededEvidenceKeys([storedRow(LEGACY_KEY, LEGACY)], current)).toEqual([LEGACY_KEY]);
    expect(supersededEvidenceKeys([storedRow(LEGACY_KEY, LEGACY)],
      normalizeGdriveContributions({ source: "gdrive", contributions: [P, Q] }))).toEqual([]);
    const timeline = latestStoredGdriveObservations([
      timelineRow(LEGACY_KEY, LEGACY, "2026-10-21T00:00:00Z"),
      timelineRow(AUTHOR_KEY, AUTHOR, "2026-10-22T00:00:00Z"),
      timelineRow("p-key", P, "2026-10-21T00:00:00Z"),
      timelineRow("q-key", Q, "2026-10-21T00:00:00Z"),
    ]);
    expect(timeline.map((row) => row.evidence_key).sort()).toEqual([AUTHOR_KEY, "p-key", "q-key"].sort());
  });

  it("the one permission id still absorbs both email-only forms (R44 S4 / R51 intact)", () => {
    expect(mergeGdriveContributions([LEGACY, AUTHOR], [P])).toEqual([P]);
    expect(mergeGdriveContributions([P], [LEGACY, AUTHOR])).toEqual([P]);
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [LEGACY, AUTHOR, P] });
    expect(current.map((row) => row.externalId)).toEqual(["permission:P"]);
    expect(supersededEvidenceKeys([storedRow(LEGACY_KEY, LEGACY), storedRow(AUTHOR_KEY, AUTHOR)], current).sort())
      .toEqual([AUTHOR_KEY, LEGACY_KEY].sort());
    expect(latestStoredGdriveObservations([
      timelineRow(LEGACY_KEY, LEGACY, "2026-10-21T00:00:00Z"),
      timelineRow(AUTHOR_KEY, AUTHOR, "2026-10-21T00:00:00Z"),
      timelineRow("p-key", P, "2026-10-20T00:00:00Z"),
    ]).map((row) => row.evidence_key)).toEqual(["p-key"]);
  });
});
