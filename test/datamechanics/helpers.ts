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
