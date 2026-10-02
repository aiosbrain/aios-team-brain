import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { ingest } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam, db, keyHeaders, seedTeam, type Seed } from "./http-helpers";

/**
 * TIERRET-1 (AC-01/AC-03/AC-08) over a REAL socket (`next start` + the shared test Postgres): the
 * wire contract of the membership-only member read rule. A granted external-posture human's ordinary
 * key receives the granted project's team-labelled item by id, its sourced + hand-entered tasks, and
 * its OKF node; a legacy connector key (with a planted Everyone row) and an offroster key gain NO
 * sourced content and no OKF nodes. The organization-structure leg is exercised in the dm tier
 * (`tierret1-admission`) because the query route streams a model answer, which this tier never calls.
 */

interface Fx {
  seed: Seed;
  itemId: string;
  externalKey: string;
  connectorKey: string;
  offrosterKey: string;
}

async function rawMember(seed: Seed, over: Partial<{ kind: string; tier: string; is_connector: boolean }>): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Legacy",
      actor_handle: `l-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`member seed failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function fixture(): Promise<Fx> {
  const seed = await seedTeam();
  await convergeTeam(seed);
  const item = await ingest(seed, { path: "granted.md", body: "granted wire body", access: "team", project: "src" });
  await convergeTeam(seed);
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `x-${randomUUID().slice(0, 6)}`, name: "X", kind: "initiative" }).select("id").single();
  const X = (proj as { id: string }).id;
  // Fixture-only custom placement of the team item into X (the spec's AC-01 shape).
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: X, context_unit_id: (unit as { id: string }).id, method: "manual" });
  await db().from("tasks").insert({ team_id: seed.teamId, project_id: item.projectId!, row_key: "WX-1", title: "wire sourced task", assignee: "T", status: "in_progress", audience: "team", origin: "sync", source_item_id: item.id });
  await db().from("tasks").insert({ team_id: seed.teamId, project_id: X, row_key: "WH-1", title: "wire hand task", assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: seed.memberId });

  const ext = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Ext", actorHandle: `e-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
  await db().from("members").update({ status: "active" }).eq("id", ext.id);
  const g = await createGroup(db(), seed.teamId, `wx-${randomUUID().slice(0, 6)}`, "WX", seed.memberId);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, ext.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);

  const connector = await rawMember(seed, { is_connector: true });
  const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").eq("is_builtin", true).single();
  await db().from("group_members").insert({ team_id: seed.teamId, group_id: (everyone as { id: string }).id, member_id: connector });
  const offroster = await rawMember(seed, { kind: "offroster", tier: "external" });

  return {
    seed,
    itemId: item.id,
    externalKey: (await issueApiKey(db(), seed.teamId, ext.id, "ext")).key,
    connectorKey: (await issueApiKey(db(), seed.teamId, connector, "connector")).key,
    offrosterKey: (await issueApiKey(db(), seed.teamId, offroster, "offroster")).key,
  };
}

async function taskKeys(F: Fx, key: string): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/v1/tasks?mode=table`, { headers: keyHeaders(key, F.seed.teamSlug) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tasks: { rows: { row_key: string }[] }[] };
  return body.tasks.flatMap((p) => p.rows.map((r) => r.row_key)).sort();
}

describe("TIERRET-1 over HTTP — the membership-only member read rule", () => {
  it("a granted external-posture key reads the granted team item by id, its sourced + granted hand-entered tasks, and its OKF node", async () => {
    const F = await fixture();
    const byId = await fetch(`${BASE_URL}/api/v1/items/${F.itemId}`, { headers: keyHeaders(F.externalKey, F.seed.teamSlug) });
    expect(byId.status).toBe(200);
    expect(await taskKeys(F, F.externalKey)).toEqual(["WH-1", "WX-1"]);
    const okf = await fetch(`${BASE_URL}/api/v1/okf-bundle`, { headers: keyHeaders(F.externalKey, F.seed.teamSlug) });
    const nodes = ((await okf.json()) as { bundle: { nodes: { path: string }[] } }).bundle.nodes.map((n) => n.path);
    expect(nodes).toContain("granted.md");
    const narrowed = await fetch(`${BASE_URL}/api/v1/okf-bundle?tier=external`, { headers: keyHeaders(F.externalKey, F.seed.teamSlug) });
    expect(((await narrowed.json()) as { bundle: { nodes: { path: string }[] } }).bundle.nodes.map((n) => n.path), "explicit external export still narrows").not.toContain("granted.md");
  });

  it("legacy connector (with an Everyone row) and offroster keys gain no sourced content and no OKF nodes", async () => {
    const F = await fixture();
    for (const key of [F.connectorKey, F.offrosterKey]) {
      const byId = await fetch(`${BASE_URL}/api/v1/items/${F.itemId}`, { headers: keyHeaders(key, F.seed.teamSlug) });
      expect(byId.status).toBe(404);
      expect(await taskKeys(F, key), "no sourced task").not.toContain("WX-1");
      const okf = await fetch(`${BASE_URL}/api/v1/okf-bundle`, { headers: keyHeaders(key, F.seed.teamSlug) });
      expect(((await okf.json()) as { bundle: { nodes: unknown[] } }).bundle.nodes).toEqual([]);
    }
    // Baseline PRESERVED, not revoked (AC-03 forbids gain, not existing access): the connector's
    // Everyone row still opens the legacy hand-entered arm it had before this change.
    expect(await taskKeys(F, F.connectorKey)).toContain("WH-1");
    expect(await taskKeys(F, F.offrosterKey), "an external-posture legacy key had and keeps nothing").toEqual([]);
  });
});
