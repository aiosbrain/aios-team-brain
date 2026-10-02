import "server-only";
import type { DbClient } from "@/lib/db/types";
import { isPrincipal } from "@/lib/access/eligibility";
import { visibleProjectsWithError } from "@/lib/access/oracle";
import { resolveViewerPosture, type ViewerPosture } from "@/lib/access/posture";
import { visibleItemIdsForProjects } from "@/lib/access/enforce";
import type { LegacyTag, MemberTag, ProvenanceIdsCtx } from "@/lib/access/provenance-sql";
import type { ViewerTier } from "@/lib/auth/visibility";
import type { RetrieveEnforce } from "@/lib/query/retrieve";

/**
 * TIERRET-1 (docs/design/tierret1-membership-only.md) — THE member-content admission resolver.
 *
 * ONE place decides whether a session member or an `aios_` key's member enters the MEMBER read arm,
 * whose whole rule is membership (the oracle): no label ceiling, sourced rows follow their source
 * item, hand-entered rows follow Everyone-or-grants. Every member read surface carries THIS result —
 * a discriminated value, never a boolean that a forgotten argument could default open.
 *
 * Positive member admission requires a CURRENT same-team `members` row that passes `isPrincipal`
 * (active human or standing agent). That is a different fact from "the API key is valid":
 * `authenticateApiKey` checks status but never selects kind/is_connector, so inferring memberhood from
 * a key would have opened unsourced content to connectors. An ACTIVE connector or offroster row is the
 * explicit LEGACY arm, which keeps the pre-TIERRET posture rule byte-for-byte (AC-03: no gain, no
 * revocation). An inactive row (invited/deactivated/any status other than active) is neither: API
 * auth and the session guard already refuse it, so there is no inactive legacy access to preserve, and
 * it throws. So does an unknown kind, a missing row, a foreign team, or ANY read error —
 * `ContentAdmissionError`, which the boundary's existing error handling turns into a closed request;
 * nothing here manufactures memberhood OR legacy.
 *
 * Source of truth: `members` (eligibility), the oracle (`visibleProjectsWithError` — grants and the
 * oracle-ACCEPTED Everyone bit), posture (`lib/access/posture`, used by the legacy arm and preserved
 * ceilings only). No stored derived flag; no second visibility engine.
 */

export class ContentAdmissionError extends Error {
  constructor(message: string) {
    super(`content admission unavailable: ${message}`);
    this.name = "ContentAdmissionError";
  }
}

export type ContentAdmission =
  | {
      kind: "member";
      teamId: string;
      memberId: string;
      /** Raw posture — carried for the preserved posture-gated surfaces and the cache key only. */
      posture: ViewerPosture;
      /** Oracle-ACCEPTED builtin Everyone (an active human). Never raw posture (N3). */
      everyone: boolean;
      /** The oracle's granted project set (unattenuated — members carry no scope). */
      grantedProjectIds: readonly string[];
    }
  | { kind: "legacy"; teamId: string; memberId: string; posture: ViewerPosture };

/**
 * The reader identity a shared reader needs (the timeline builder, the TS/SQL provenance owners):
 * WHO is asking and with what hand-entered authority. Built only by `contentReaderFor`.
 */
export type ContentReader =
  | { principal: MemberTag; everyone: boolean; memberProjectIds: readonly string[] }
  | { principal: LegacyTag; posture: ViewerPosture };

/** Named once (the provenance-principal guard inventories member literals): this module IS the
 *  positive admission boundary — the value is only ever emitted after `isPrincipal` passed. */
const MEMBER_ARM: MemberTag = "member";
const LEGACY_ARM: LegacyTag = "legacy";
/** `MemberKind` (lib/access/eligibility). Anything else is unknown and admits nothing. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(["human", "agent", "offroster"]);

export async function resolveContentAdmission(
  db: DbClient,
  teamId: string,
  memberId: string
): Promise<ContentAdmission> {
  const { data, error } = await db
    .from("members")
    .select("id, kind, is_connector, status")
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new ContentAdmissionError(`member read failed: ${error.message}`);
  if (!data) throw new ContentAdmissionError("no such member in this team");

  // Checked BEFORE either arm: an inactive row is not a legacy key, it is no reader at all.
  const member = data as { kind: unknown; is_connector: unknown; status: unknown };
  if (member.status !== "active") throw new ContentAdmissionError("member is not active");
  if (typeof member.is_connector !== "boolean" || !KNOWN_KINDS.has(member.kind as string)) {
    throw new ContentAdmissionError("unrecognised member kind");
  }
  const eligibility = member as { kind: string; is_connector: boolean; status: string };

  let posture: ViewerPosture;
  try {
    posture = await resolveViewerPosture(db, teamId, memberId);
  } catch (e) {
    throw new ContentAdmissionError(e instanceof Error ? e.message : "posture read failed");
  }

  // Active + known kind: a principal is a member; the remainder is exactly an active connector or
  // offroster row — the legacy arm.
  if (!isPrincipal(eligibility)) return { kind: "legacy", teamId, memberId, posture };

  const { set, error: oracleError, everyone } = await visibleProjectsWithError(db, { teamId, memberId });
  if (oracleError) throw new ContentAdmissionError("oracle read failed");
  return {
    kind: "member",
    teamId,
    memberId,
    posture,
    everyone: everyone === true,
    grantedProjectIds: [...set.projectIds],
  };
}

export function contentReaderFor(admission: ContentAdmission): ContentReader {
  switch (admission.kind) {
    case "member":
      return { principal: MEMBER_ARM, everyone: admission.everyone, memberProjectIds: admission.grantedProjectIds };
    case "legacy":
      return { principal: LEGACY_ARM, posture: admission.posture };
    default:
      return failClosed(admission);
  }
}

function failClosed(x: never): never {
  throw new ContentAdmissionError(`unknown admission ${JSON.stringify(x)}`);
}

/**
 * The LABEL tier a reader's queries filter with (`visibleItems`/`visibleDecisions`/`canSeeAccess`,
 * `externalAudienceOnly`). "team" = no label ceiling: an admitted member reads by membership alone.
 * The legacy arm keeps its posture ceiling. Anything unrecognised is "external" — fail closed.
 */
export function contentLabelTier(subject: ContentAdmission | ContentReader): ViewerTier {
  const arm = "kind" in subject ? subject.kind : subject.principal;
  if (arm === "member") return "team";
  if (arm === "legacy") return (subject as { posture: ViewerPosture }).posture === "team" ? "team" : "external";
  return "external";
}

/** A member's resolved read view: the admission, its reader, and the membership-visible item set. */
export interface ContentView {
  admission: ContentAdmission;
  reader: ContentReader;
  ids: Set<string>;
  empty: boolean;
  /** The item substrate read failed: `ids` is an ERROR-derived empty (callers serve nothing / 500). */
  error?: boolean;
  /** The oracle's granted project set — the graph partition input. Empty for legacy and on error. */
  projectIds: string[];
}

export async function resolveContentView(db: DbClient, teamId: string, memberId: string): Promise<ContentView> {
  const admission = await resolveContentAdmission(db, teamId, memberId);
  const reader = contentReaderFor(admission);
  // A non-principal resolves to no projects in the oracle too; returning ∅ directly is the same
  // answer without a second read, and the fail-closed one if the two ever disagreed.
  if (admission.kind === "legacy") return { admission, reader, ids: new Set(), empty: true, projectIds: [] };
  const items = await visibleItemIdsForProjects(db, teamId, new Set(admission.grantedProjectIds));
  return {
    admission,
    reader,
    ids: items.ids,
    empty: items.empty,
    ...(items.error ? { error: true } : {}),
    projectIds: items.error ? [] : [...admission.grantedProjectIds],
  };
}

/**
 * The id-array provenance ctx for a reader — the ONE value both the in-query SQL form and the TS
 * defense-in-depth filter take. A substrate ERROR closes the hand-entered arm too (the
 * `delegatedVisibleItemIds` error-path rule): sourced rows were already error-suppressed, and serving
 * hand-entered ones alone would be a wider answer than the failure deserves.
 */
export function provenanceCtxForReader(
  reader: ContentReader,
  visibleItemIds: ReadonlySet<string>,
  error = false
): ProvenanceIdsCtx {
  if (reader.principal === "member") {
    return {
      visibleItemIds: error ? new Set<string>() : visibleItemIds,
      teamPosture: error ? false : reader.everyone,
      principal: reader.principal,
      memberProjectIds: error ? [] : reader.memberProjectIds,
    };
  }
  if (reader.principal === "legacy") {
    return {
      visibleItemIds: error ? new Set<string>() : visibleItemIds,
      teamPosture: error ? false : reader.posture === "team",
      principal: reader.principal,
    };
  }
  return { visibleItemIds: new Set<string>(), teamPosture: false };
}

export function provenanceCtxFor(view: Pick<ContentView, "reader" | "ids" | "error">): ProvenanceIdsCtx {
  return provenanceCtxForReader(view.reader, view.ids, view.error === true);
}

/**
 * The retrieval enforcement for a resolved view. Member: the oracle item set, its hand-entered
 * authority and its graph partitions (the oracle set, never a fallback). Legacy: the baseline shape —
 * an empty item set, the posture rule for hand-entered rows (via the route's tier), the org-structural
 * legs it already had, and NO graph scope (never new graph authority). An error view throws: the
 * query routes turn that into their existing 500.
 */
export function retrieveEnforceFor(view: ContentView): RetrieveEnforce {
  if (view.error) throw new ContentAdmissionError("visibility resolution failed");
  const reader = view.reader;
  if (reader.principal === "member") {
    return {
      visibleItemIds: view.ids,
      principal: reader.principal,
      memberEveryone: reader.everyone,
      memberProjectIds: reader.memberProjectIds,
      graphProjectIds: view.projectIds,
    };
  }
  return { visibleItemIds: view.ids, principal: reader.principal };
}

/**
 * Direct (uncached) timeline enforcement — the >7d expansion and fixtures. The cached path splits
 * the same resolution across hit/miss (`lib/dashboard/timeline-cache`). Throws on any read error.
 */
export async function contentTimelineEnforcement(
  db: DbClient,
  teamId: string,
  memberId: string
): Promise<{ visibleItemIds: ReadonlySet<string>; visibleProjectIds: ReadonlySet<string>; reader: ContentReader }> {
  const view = await resolveContentView(db, teamId, memberId);
  if (view.error) throw new ContentAdmissionError("access substrate read failed while resolving timeline enforcement");
  return { visibleItemIds: view.ids, visibleProjectIds: new Set(view.projectIds), reader: view.reader };
}
