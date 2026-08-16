import { expect } from "vitest";
import { projectGroupId } from "@/lib/graph/group";
import { runSql } from "@/lib/db/pg/pool";
import { db, sha, type Seed } from "./helpers";

/** Shared PCCC test scaffolding: mint a pointered initiative, tag an item into it. */
export async function mkInitiative(seed: Seed, slug: string): Promise<{ projectId: string; group: string }> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  const projectId = (data as { id: string }).id;
  const group = projectGroupId(seed.teamId, projectId);
  await runSql("update projects set graph_group_id = $1 where id = $2", [group, projectId]);
  return { projectId, group };
}

export async function tagItem(seed: Seed, itemId: string, projectId: string): Promise<void> {
  // One unit per item (the substrate's grain) — get-or-create, memberships share it.
  const { data: existing } = await db()
    .from("project_context_units")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("unit_key", `item:${itemId}`)
    .maybeSingle();
  let unitId = (existing as { id: string } | null)?.id;
  if (!unitId) {
    const { data: unit, error: uErr } = await db()
      .from("project_context_units")
      .insert({
        team_id: seed.teamId,
        unit_kind: "item",
        source_item_id: itemId,
        unit_key: `item:${itemId}`,
        audience: "team",
        content_sha256: sha(itemId),
      })
      .select("id")
      .single();
    expect(uErr).toBeNull();
    unitId = (unit as { id: string }).id;
  }
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: unitId,
    decision: "include",
    mode: "auto",
    method: "manual",
  });
  expect(error).toBeNull();
}
