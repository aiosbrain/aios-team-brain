import { randomUUID, createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";

// In DB_BACKEND=postgres (set by the data-mechanics config) adminClient() is the
// pg adapter over the real test Postgres — so the real app code runs unchanged.
export function db(): DbClient {
  return adminClient();
}

export function sha(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export type Seed = { teamId: string; teamSlug: string; memberId: string };

export async function approvedAudienceProject(seed: Seed, tier: "team" | "external" = "team"): Promise<string> {
  const { ensureAccessBootstrap, GENERAL_SLUG, EXTERNAL_SHARED_SLUG } = await import("@/lib/access/bootstrap");
  const ready = await ensureAccessBootstrap(db(), seed.teamId);
  if (!ready.ok) throw new Error(`access bootstrap failed: ${ready.error}`);
  const slug = tier === "external" ? EXTERNAL_SHARED_SLUG : GENERAL_SLUG;
  const { data, error } = await db().from("projects").select("id")
    .eq("team_id", seed.teamId).eq("kind", "system").eq("slug", slug).single();
  if (error || !data) throw new Error(`audience project missing: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Seed a real team + active member (FK targets the ingest/read paths require). */
export async function seedTeam(): Promise<Seed> {
  const admin = db();
  const slug = `team-${randomUUID().slice(0, 8)}`;
  const { data: team, error: tErr } = await admin
    .from("teams")
    .insert({ slug, name: "Test Team" })
    .select("id")
    .single();
  if (tErr || !team) throw new Error(`seed team failed: ${tErr?.message}`);

  const { data: member, error: mErr } = await admin
    .from("members")
    .insert({
      team_id: team.id,
      email: `${randomUUID()}@test.local`,
      display_name: "Tester",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (mErr || !member) throw new Error(`seed member failed: ${mErr?.message}`);
  await placeMemberByTier(team.id, member.id, "team");

  return { teamId: team.id, teamSlug: slug, memberId: member.id };
}

/**
 * Test plumbing for the PRET-4 explicit-state model: write a member's builtin-posture row the
 * way `createMember`'s invite-default write does in production — every real member has one
 * from creation, so raw-inserted fixture members must too or the oracle/posture resolve them
 * to nothing (the recompute that used to heal this is retired). Direct edge-table writes are
 * legal from test files (the single-writer guard scans app/lib/scripts only).
 */
export async function placeMemberByTier(teamId: string, memberId: string, tier: string): Promise<void> {
  const admin = db();
  const { ensureBuiltins } = await import("@/lib/access/groups");
  const r = await ensureBuiltins(admin, teamId);
  if (!r.ok) throw new Error(`ensureBuiltins failed: ${r.error}`);
  const slug = tier === "team" ? "everyone" : "external";
  const { data: g } = await admin
    .from("groups")
    .select("id")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .eq("is_builtin", true)
    .single();
  if (!g) throw new Error(`builtin ${slug} missing after ensure`);
  const { error } = await admin
    .from("group_members")
    .upsert({ team_id: teamId, group_id: (g as { id: string }).id, member_id: memberId }, { onConflict: "group_id,member_id" });
  if (error) throw new Error(`place member failed: ${error.message}`);
}

/**
 * PRET-6 test plumbing: converge the team (backfill) and resolve a real viewer's enforcement —
 * the only way a timeline/retrieval read serves anything now that the null-enforcement arm
 * fails closed. `tier` picks the viewer CLASS: "team" reuses the seed admin; "external" mints
 * an active external-posture member (builtin row via the invite-default shape). Call it AFTER
 * the test's fixtures, so the backfill covers them.
 */
export async function viewFor(
  seed: Seed,
  tier: "team" | "external" = "team"
): Promise<{ visibleItemIds: ReadonlySet<string>; visibleProjectIds: ReadonlySet<string> }> {
  const viewerId = tier === "external" ? await externalMember(seed) : seed.memberId;
  const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
  const r = await backfillTeamContext(db(), seed.teamId);
  if (!r.ok) throw new Error(`viewFor backfill failed: ${r.error}`);
  const { memberEnforcement } = await import("@/lib/access/enforce");
  const e = await memberEnforcement(db(), { teamId: seed.teamId, memberId: viewerId });
  if (!e) throw new Error("viewFor: the viewer resolved no enforcement");
  return e;
}

/** A route-shaped MEMBER enforcement for retrieve(): vis-set + principal + graph scope — what
 *  both query routes construct (PRET-6: retrieve throws without one). Backfills first. */
export async function memberRetrieveEnforce(
  seed: Seed,
  tier: "team" | "external" = "team"
): Promise<{ visibleItemIds: ReadonlySet<string>; principal: "member"; graphProjectIds: string[] }> {
  const viewerId = tier === "external" ? await externalMember(seed) : seed.memberId;
  const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
  const r = await backfillTeamContext(db(), seed.teamId);
  if (!r.ok) throw new Error(`memberRetrieveEnforce backfill failed: ${r.error}`);
  const { visibleItemIds } = await import("@/lib/access/enforce");
  const { ids, projectIds } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: viewerId });
  return { visibleItemIds: ids, principal: "member", graphProjectIds: projectIds };
}

/** The member's cheap §5.8 visibility (projects + hash) — what keys their vis-variant cache row. */
export async function visOf(seed: Seed, memberId: string = seed.memberId) {
  const { memberVisibility } = await import("@/lib/access/enforce");
  return memberVisibility(db(), { teamId: seed.teamId, memberId });
}

/** Mint an ACTIVE external-posture member (invite-default shape: the external builtin row). */
export async function externalMember(seed: Seed): Promise<string> {
  const admin = db();
  const { data, error } = await admin
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "External Viewer",
      actor_handle: `ext-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "external",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`externalMember failed: ${error?.message}`);
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "external");
  await convergeIdentityAttribution(seed);
  return id;
}

/** Active roster mutations intentionally make attribution-dependent caches unavailable until the
 * durable repair converges. Fixtures that need an immediately usable viewer call the production
 * repair owner rather than bypassing the authority row. */
export async function convergeIdentityAttribution(seed: Seed): Promise<void> {
  const { data, error } = await db().from("team_identity_authority").select("repair_status")
    .eq("team_id",seed.teamId).maybeSingle();
  if(error) throw new Error(`identity authority fixture read failed: ${error.message}`);
  if((data as {repair_status?:string}|null)?.repair_status === "complete") return;
  const { repairAttributionNow } = await import("@/lib/ingest/reconcile-attribution");
  await repairAttributionNow(db(),seed.teamId,seed.teamSlug,{maxBatches:20,batchSize:100});
}

/** Ingest one item through the real lib/ingest path against the real DB. */
export async function ingest(
  seed: Seed,
  over: Partial<ItemPayload> & { body: string; path: string; access: "team" | "external" }
): Promise<{ status: string; id: string; projectId?: string; changedTaskRowKeys?: string[] }> {
  const payload: ItemPayload = {
    project: "acme",
    kind: "deliverable",
    actor: "tester",
    frontmatter: {},
    content_sha256: sha(over.body),
    ...over,
  } as ItemPayload;
  return ingestItem(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
    payload,
    over.access
  );
}
