import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * The ONLY write path for member-derived rows in the company graph (`graph_entities`/
 * `graph_relationships`, single-writer guarded — `scripts/seed-demo.ts`'s fictional fixture
 * data is the sole exemption). Keeps the structured stakeholder map (`GET /api/v1/company-graph`,
 * brain-api v1.5) and the chat/query context (`lib/query/retrieve.ts`, which already reads these
 * tables) in sync with the real `members` roster, so a member joining Team Brain is loaded as a
 * real actor instead of the graph staying fixture-only.
 *
 * `entity_id` scheme: `member:<uuid>` — self-evident provenance, distinguishes member-derived
 * entities from any future manually-entered non-member actor sharing the same table.
 *
 * Two representations of "who reports to whom" are kept in lock-step because the two consumers
 * read different ones: `retrieve.ts`'s prompt reads `graph_relationships` REPORTS_TO edges;
 * `GET /api/v1/company-graph`'s `people[].reports_to` reads `attrs.reports_to` on the entity
 * (confirmed against the route's own code + data-mechanics test — REPORTS_TO edges are explicitly
 * skipped by that route's projection). `syncMemberActor` always calls `syncReportsTo` so the two
 * never drift apart.
 */

export const memberEntityId = (memberId: string): string =>
  `member:${memberId}`;

interface MemberRow {
  id: string;
  display_name: string;
  role: "admin" | "lead" | "member";
  tier: "team" | "external";
  email: string;
  status: "invited" | "active" | "disabled";
  created_at: string;
  manager_member_id: string | null;
  is_connector: boolean;
}

/**
 * Upsert (or refresh) the actor entity for one member. No-ops for a connector service-account —
 * those never appear in the company graph. Safe to call on every member create/update (idempotent
 * keyed upsert, mirroring lib/codebases/ingest.ts's style) — a soft-disabled member's entity is
 * kept (attrs.status flips to "disabled") for history, not deleted; only a hard delete removes it
 * (see removeMemberActor).
 */
export async function syncMemberActor(
  db: DbClient,
  teamId: string,
  memberId: string,
): Promise<void> {
  const { data: member } = await db
    .from("members")
    .select(
      "id, display_name, role, tier, email, status, created_at, manager_member_id, is_connector",
    )
    .eq("team_id", teamId)
    .eq("id", memberId)
    .maybeSingle();
  const m = member as MemberRow | null;
  if (!m || m.is_connector) return;

  const { error } = await db.from("graph_entities").upsert(
    {
      team_id: teamId,
      entity_id: memberEntityId(m.id),
      entity_type: "actor",
      name: m.display_name,
      attrs: {
        // Distinct key from `role` — brain-api v1.5 defines `people[].role` as a job title
        // ("Head of Finance"), not a permission level. There's no job-title source in this
        // codebase yet, so `role`/`job_family` stay omitted (projected as null by the API)
        // rather than being populated with the wrong kind of "role".
        member_role: m.role,
        tier: m.tier,
        email: m.email,
        status: m.status,
        joined_at: m.created_at,
        reports_to: m.manager_member_id
          ? memberEntityId(m.manager_member_id)
          : null,
      },
    },
    { onConflict: "team_id,entity_id" },
  );
  if (error)
    throw new Error(`company-graph actor sync failed: ${error.message}`);

  await syncReportsTo(db, teamId, memberId, m.manager_member_id);
}

/**
 * Replace the REPORTS_TO edge for one member. Delete-then-insert (not upsert-on-conflict)
 * because the *target* changes when the manager changes and the unique key includes `to_id` — a
 * plain upsert would leave the stale edge pointing at the old manager behind. Exported separately
 * so callers that already know the new manager id (e.g. setMemberManager) can skip a re-read.
 */
export async function syncReportsTo(
  db: DbClient,
  teamId: string,
  memberId: string,
  managerMemberId: string | null,
): Promise<void> {
  const fromId = memberEntityId(memberId);
  const { error: delErr } = await db
    .from("graph_relationships")
    .delete()
    .eq("team_id", teamId)
    .eq("from_id", fromId)
    .eq("relationship_type", "REPORTS_TO");
  if (delErr)
    throw new Error(`company-graph reports-to clear failed: ${delErr.message}`);

  if (!managerMemberId) return;
  const { error: insErr } = await db.from("graph_relationships").insert({
    team_id: teamId,
    from_id: fromId,
    to_id: memberEntityId(managerMemberId),
    relationship_type: "REPORTS_TO",
    attrs: {},
  });
  if (insErr)
    throw new Error(`company-graph reports-to edge failed: ${insErr.message}`);
}

/**
 * Permanently remove a member's actor entity + every relationship touching it (either
 * direction). Called ONLY from a hard delete (`deleteMember({hard: true})`) — a soft-disable
 * keeps the entity for history via `syncMemberActor`'s `attrs.status` flip instead.
 *
 * `directReportIds` must be captured by the CALLER *before* invoking `deleteMember`, i.e.
 * `select id from members where manager_member_id = <memberId>` — the FK's `on delete set null`
 * clears that column as part of the delete itself, so reading it back afterward would find
 * nothing. Each is re-synced here (after the delete has happened) so their `attrs.reports_to`/edge
 * catch up to "no manager" rather than pointing at a now-gone entity.
 */
export async function removeMemberActor(
  db: DbClient,
  teamId: string,
  memberId: string,
  directReportIds: string[] = [],
): Promise<void> {
  const entityId = memberEntityId(memberId);

  const { error: relErr1 } = await db
    .from("graph_relationships")
    .delete()
    .eq("team_id", teamId)
    .eq("from_id", entityId);
  if (relErr1)
    throw new Error(
      `company-graph relationship cleanup (from) failed: ${relErr1.message}`,
    );
  const { error: relErr2 } = await db
    .from("graph_relationships")
    .delete()
    .eq("team_id", teamId)
    .eq("to_id", entityId);
  if (relErr2)
    throw new Error(
      `company-graph relationship cleanup (to) failed: ${relErr2.message}`,
    );

  const { error: entErr } = await db
    .from("graph_entities")
    .delete()
    .eq("team_id", teamId)
    .eq("entity_id", entityId);
  if (entErr)
    throw new Error(`company-graph entity removal failed: ${entErr.message}`);

  for (const reportId of directReportIds) {
    await syncMemberActor(db, teamId, reportId);
  }
}
