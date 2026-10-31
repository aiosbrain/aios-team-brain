import "server-only";

import { canAccessAdmin } from "@/lib/auth/admin-access";
import { resolveViewerPosture } from "@/lib/access/posture";
import { runSql } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";

/**
 * AIO-1167 R45 (AC-08) — the Admin diagnostic for GOOGLE DRIVE automatic identity links that were
 * refused. Scoped to Drive by adjudication: only `identity.discovery_conflict` events whose normalized
 * provider is `gdrive` are projected; no other provider's events are read into it.
 *
 * When a Drive push observes a stable collaborator id whose confirmed email names member A, but that
 * id is already held by another member B through a legacy mapping that was never reviewed, the shared
 * owner (`discoverMemberIdentity`) refuses the automatic link, keeps B's mapping, and audits
 * `identity.discovery_conflict`. Nothing else ever read that event, so the conflict was invisible.
 *
 * This is a READ-ONLY projection of those existing audit events for Admin → Members — no new mapping
 * authority, no automatic remap, no queue or acknowledgment. Every row pairs the HISTORICAL observation
 * (when, which identity, which candidate, who held it then) with the CURRENT mapping re-read now
 * (holder, mapping state and revision), so an Admin who has since remapped or unlinked the identity
 * sees that the event is history, not a standing conflict. The fix itself stays with the existing
 * identity controls.
 *
 * Boundaries:
 *   · explicit team authorization: the viewer must be an ACTIVE admin of THIS team at team posture
 *     (`canAccessAdmin` over the resolved posture) — re-checked here, not assumed from the layout;
 *   · team-scoped: only this team's audit rows and members are read;
 *   · ALLOWLISTED output: identity provider + id, member ids + display names, times, revision, state.
 *     No raw audit metadata, actor, API key, content, connection or credential leaves this module;
 *   · fail closed: any read failure is `unavailable`, never an empty (clean-looking) list;
 *   · no API surface: imported only by the Admin → Members page (guarded).
 */

export const CONFLICTS_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface ConflictMember {
  id: string;
  displayName: string;
}

/** What the identity's mapping is NOW, re-read at request time. */
export type CurrentMappingState =
  | "linked" // a reviewed mapping (mapping-state row) holds it
  | "unreviewed" // a legacy mapping with no mapping-state row holds it
  | "unlinked" // deliberately unlinked: a tombstone
  | "absent"; // no mapping and no decision

/** How the historical event stands against the current mapping. */
export type ConflictStanding =
  | "still_conflicting" // the identity is still held by someone other than the candidate
  | "now_candidate" // the identity has since been mapped to the candidate
  | "unlinked"; // the identity has since been unlinked (or no longer exists)

export interface IdentityConflictRow {
  /** Latest observation of this identity/candidate conflict. */
  observedAt: string;
  /** How many refused automatic links this row folds together (repeated pushes). */
  occurrences: number;
  provider: string;
  externalId: string;
  /** The member the observed email named (the refused automatic link). Null if since removed. */
  candidate: ConflictMember | null;
  /** Who held the identity when the link was refused. Null if since removed. */
  heldThen: ConflictMember | null;
  current: {
    state: CurrentMappingState;
    holder: ConflictMember | null;
    revision: number;
  };
  standing: ConflictStanding;
}

export type IdentityConflictPage =
  | { status: "ok"; rows: IdentityConflictRow[]; nextCursor: string | null }
  | { status: "forbidden" }
  | { status: "unavailable" };

export interface ConflictViewer {
  teamId: string;
  memberId: string;
}

interface ConflictSqlRow {
  id: string | number;
  observed_at: string;
  occurrences: string | number;
  provider: string;
  external_id: string;
  candidate_id: string | null;
  candidate_name: string | null;
  held_then_id: string | null;
  held_then_name: string | null;
  holder_id: string | null;
  holder_name: string | null;
  state: string | null;
  revision: string | number | null;
}

/** ONE statement: the latest refused automatic link per (identity, candidate), with the current
 * mapping read in the same snapshot. Keyset-paginated on (observed_at, id), newest first. */
const CONFLICTS_SQL = `
with events as (
  select a.id, a.created_at,
         a.target_id as candidate,
         lower(a.meta->>'provider') as provider,
         a.meta->>'external_id' as external_id,
         a.meta->>'mapped_member_id' as held_then
    from audit_log a
   where a.team_id = $1
     and a.action = 'identity.discovery_conflict'
     and a.target_type = 'member'
     and lower(a.meta->>'provider') = 'gdrive'
     and coalesce(a.meta->>'external_id', '') <> ''
), latest as (
  select distinct on (provider, external_id, candidate)
         id, created_at, candidate, provider, external_id, held_then,
         count(*) over (partition by provider, external_id, candidate) as occurrences
    from events
   order by provider, external_id, candidate, created_at desc, id desc
)
select l.id, l.created_at::text as observed_at, l.occurrences, l.provider, l.external_id,
       c.id::text as candidate_id, c.display_name as candidate_name,
       t.id::text as held_then_id, t.display_name as held_then_name,
       h.id::text as holder_id, h.display_name as holder_name,
       s.state, s.revision
  from latest l
  left join members c on c.team_id = $1 and c.id::text = l.candidate
  left join members t on t.team_id = $1 and t.id::text = l.held_then
  left join member_identities i
    on i.team_id = $1 and lower(i.provider) = l.provider and i.external_id = l.external_id
  left join members h on h.team_id = $1 and h.id = i.member_id
  left join member_identity_mapping_state s
    on s.team_id = $1 and lower(s.provider) = l.provider and s.external_id = l.external_id
 where ($2::timestamptz is null or (l.created_at, l.id) < ($2::timestamptz, $3::bigint))
 order by l.created_at desc, l.id desc
 limit $4`;

function encodeCursor(row: ConflictSqlRow): string {
  return Buffer.from(JSON.stringify([row.observed_at, String(row.id)]), "utf8").toString("base64url");
}

/** A cursor is opaque to callers; anything that does not decode to (time, id) starts at the top. */
function decodeCursor(cursor: string | null | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string"
        && typeof value[1] === "string" && /^\d+$/.test(value[1]) && !Number.isNaN(Date.parse(value[0]))) {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  return null;
}

const member = (id: string | null, name: string | null): ConflictMember | null =>
  id ? { id, displayName: name ?? "" } : null;

function toRow(row: ConflictSqlRow): IdentityConflictRow {
  const holder = member(row.holder_id, row.holder_name);
  const state: CurrentMappingState = row.state === "unlinked"
    ? "unlinked"
    : holder
      ? (row.state === "linked" ? "linked" : "unreviewed")
      : "absent";
  const standing: ConflictStanding = !holder
    ? "unlinked"
    : holder.id === row.candidate_id
      ? "now_candidate"
      : "still_conflicting";
  return {
    observedAt: row.observed_at,
    occurrences: Number(row.occurrences),
    provider: row.provider,
    externalId: row.external_id,
    candidate: member(row.candidate_id, row.candidate_name),
    heldThen: member(row.held_then_id, row.held_then_name),
    current: { state, holder, revision: row.revision === null ? 0 : Number(row.revision) },
    standing,
  };
}

/** Is `viewer` an ACTIVE admin of exactly this team, at team posture? Throws on a read failure. */
async function isTeamAdmin(db: DbClient, viewer: ConflictViewer): Promise<boolean> {
  const { data, error } = await db
    .from("members")
    .select("role, status")
    .eq("team_id", viewer.teamId)
    .eq("id", viewer.memberId)
    .maybeSingle();
  if (error) throw new Error(`conflict diagnostic viewer read failed: ${error.message}`);
  const row = data as { role: string; status: string } | null;
  if (!row || row.status !== "active") return false;
  const posture = await resolveViewerPosture(db, viewer.teamId, viewer.memberId);
  return canAccessAdmin({ role: row.role, tier: posture });
}

export async function listIdentityDiscoveryConflicts(
  db: DbClient,
  viewer: ConflictViewer,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<IdentityConflictPage> {
  try {
    if (!await isTeamAdmin(db, viewer)) return { status: "forbidden" };
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(opts.limit ?? CONFLICTS_PAGE_SIZE)));
    const after = decodeCursor(opts.cursor);
    const { rows } = await runSql<ConflictSqlRow>(CONFLICTS_SQL, [
      viewer.teamId, after?.[0] ?? null, after?.[1] ?? null, limit + 1,
    ]);
    const page = rows.slice(0, limit);
    return {
      status: "ok",
      rows: page.map(toRow),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  } catch {
    // Fail closed: a diagnostic that could not be read is UNAVAILABLE, never "no conflicts".
    return { status: "unavailable" };
  }
}
