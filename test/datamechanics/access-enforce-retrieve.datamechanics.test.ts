import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { retrieve } from "@/lib/query/retrieve";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds } from "@/lib/access/enforce";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";

// Phase B slice 2 (spec §5.2/§5.8b) — enforcement extended to the retrieval path. The proofs:
// permissive retrieve is byte-identical; enforcing filters the item legs so a restricted item's
// content NEVER reaches an outsider's answer; graph legs are omitted under enforcing (fail closed
// until Phase C). Item-grounded content is what the answer cites, so a leak here is a live leak.

const TERM = "waffleberry"; // a rare term present in both bodies so FTS matches both

async function retrievedPaths(seed: Seed, memberId: string | null): Promise<string[]> {
  const enforce = memberId ? { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId })).ids } : null;
  const ctx = await retrieve(db(), seed.teamId, "team", `tell me about ${TERM}`, null, enforce);
  return ctx.sources.map((s) => s.path);
}

async function seedMember(seed: Seed): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return data!.id as string;
}

describe("enforced retrieval (Phase B slice 2)", () => {
  it("permissive: retrieve returns both items (byte-identical — enforce arg is null)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "open.md", body: `open ${TERM} note`, access: "team", project: "src" });
    await ingest(seed, { path: "other.md", body: `other ${TERM} note`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const got = await retrievedPaths(seed, null); // permissive (no enforce)
    expect(got).toContain("open.md");
    expect(got).toContain("other.md");
  });

  it("enforcing: an outsider's answer cites the General item but NOT a restricted-project item (the leak this closes)", async () => {
    const seed = await seedTeam();
    const outsider = await seedMember(seed);
    const openItem = await ingest(seed, { path: "shared.md", body: `shared ${TERM} note`, access: "team", project: "src" });
    const secret = await ingest(seed, { path: "restricted.md", body: `restricted ${TERM} secret`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);

    // Move the secret into a restricted project the outsider can't see.
    const restricted = await db().from("projects").insert({ team_id: seed.teamId, slug: "vault", name: "Vault", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "vaultgroup", "Vault", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, restricted.data!.id, g.groupId!, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", secret.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: restricted.data!.id, context_unit_id: unit!.id, method: "manual" });

    const got = await retrievedPaths(seed, outsider); // enforcing (visibleItemIds computed)
    expect(got, "General content still reaches the answer").toContain("shared.md");
    expect(got, "restricted content must NEVER reach an outsider's retrieval").not.toContain("restricted.md");
    void openItem;
  });

  it("enforcing: the Postgres graph legs (commitments/actors) are OMITTED — can't be membership-filtered until Phase C", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    // Plant a commitment graph entity (a team-tier member sees these under permissive).
    await db().from("graph_entities").insert({ team_id: seed.teamId, entity_id: `c-${Date.now()}`, entity_type: "commitment", name: "ship the widget", attrs: { status: "open" } });
    const member = await seedMember(seed);

    const permissive = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, null);
    expect(permissive.structured, "permissive shows the commitment").toContain("ship the widget");

    const enforce = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: member })).ids };
    const enforcing = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, enforce);
    expect(enforcing.structured, "enforcing OMITS the graph leg (fail closed until Phase C)").not.toContain("ship the widget");
  });

  it("enforcing: a member in NO groups retrieves nothing (fail closed)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: `x ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const lonely = await seedMember(seed);
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
    await db().from("group_members").delete().eq("group_id", everyone!.id).eq("member_id", lonely);
    const got = await retrievedPaths(seed, lonely);
    expect(got).toEqual([]);
  });
});
