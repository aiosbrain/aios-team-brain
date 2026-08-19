import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { GET as itemByIdGET } from "@/app/api/v1/items/[id]/route";
import { GET as okfGET } from "@/app/api/v1/okf-bundle/route";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { issueApiKey } from "@/lib/admin/keys";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { canSeeItem, visibleItemIds } from "@/lib/access/enforce";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";

// ENFB-1 AC1 (docs/design/enfb1-body-surfaces-oracle-gate.md §1/§2.1): the by-id pair closes —
// a membership-denied item returns the SAME 404 as an absent one (§5.7), the entitled member
// reads the body, and canSeeItem AGREES with the list materialization on every arm (the
// shared-predicate discipline: the pair cannot disagree by drift).

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

function req(key: string, id: string): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://test/api/v1/items/${id}`, { headers: { authorization: `Bearer ${key}` } }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  ];
}

async function getById(seed: Seed, memberId: string, id: string): Promise<{ status: number; body: unknown }> {
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "k");
  const res = await itemByIdGET(...req(key, id));
  return { status: res.status, body: await res.json() };
}

/** Restrict an ingested item into a fresh initiative granted to `memberInGroup` (if given). */
async function restrictInto(seed: Seed, itemId: string, memberInGroup?: string): Promise<string> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  if (memberInGroup) await addMemberToGroup(db(), seed.teamId, g.groupId!, memberInGroup, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
  expect(error, "restrict fixture must insert").toBeNull();
  return proj!.id as string;
}

describe("ENFB-1 AC1 — GET /api/v1/items/[id] gates on membership; 404 is indistinguishable from absent", () => {
  it("a team-posture outsider gets 404 for a restricted item, byte-identical to a nonexistent id; the entitled member gets the body; General serves everyone", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const restricted = await ingest(seed, { path: "sec.md", body: "the restricted body", access: "team", project: "src" });
    const general = await ingest(seed, { path: "open.md", body: "the open body", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const projectId = await restrictInto(seed, restricted.id, insider);

    // Denied: same status AND same wire body as absent (§5.7).
    const denied = await getById(seed, outsider, restricted.id);
    const absent = await getById(seed, outsider, randomUUID());
    expect(denied.status).toBe(404);
    expect(absent.status).toBe(404);
    // Identical up to the per-request id (request_id is fresh per call by design).
    const norm = (b: unknown) => JSON.stringify(b, (k, v) => (k === "request_id" ? "<req>" : v));
    expect(norm(denied.body), "denied and absent must be indistinguishable on the wire").toBe(norm(absent.body));
    expect(JSON.stringify(denied.body), "the 404 must not name the restricted project").not.toContain(projectId);

    // Entitled: the body flows.
    const ok = await getById(seed, insider, restricted.id);
    expect(ok.status).toBe(200);
    expect((ok.body as { body: string }).body).toBe("the restricted body");

    // General: any everyone-member reads it (the gate is not over-restrictive).
    const open = await getById(seed, outsider, general.id);
    expect(open.status).toBe(200);
    expect((open.body as { body: string }).body).toBe("the open body");
  });

  it("AGREEMENT: canSeeItem(x) === visibleItemIds(...).ids.has(x) across granted/ungranted/General/retracted arms (the shared-predicate pin)", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const restricted = await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    const general = await ingest(seed, { path: "b.md", body: "b", access: "team", project: "src" });
    const retractedItem = await ingest(seed, { path: "c.md", body: "c", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, restricted.id, insider);
    await db().from("project_context_units").update({ state: "retracted" }).eq("source_item_id", retractedItem.id);

    for (const member of [insider, outsider]) {
      const { ids } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });
      for (const item of [restricted.id, general.id, retractedItem.id]) {
        const probe = await canSeeItem(db(), { teamId: seed.teamId, memberId: member }, item);
        expect(probe, `canSeeItem must agree with the list for member=${member === insider ? "insider" : "outsider"} item=${item}`).toBe(ids.has(item));
      }
    }
    // Non-vacuity: the arms actually discriminate (insider sees restricted, outsider does not).
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: insider }, restricted.id)).toBe(true);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: outsider }, restricted.id)).toBe(false);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: outsider }, retractedItem.id), "a retracted unit serves nobody").toBe(false);
  });

  it("fail closed: a member in no groups probes false for everything; a foreign-team item probes false", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const item = await ingest(seed, { path: "x.md", body: "x", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const lonely = await seedMember(seed);
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
    await db().from("group_members").delete().eq("group_id", everyone!.id).eq("member_id", lonely);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: lonely }, item.id)).toBe(false);
    // Cross-team: the probe is team-scoped — another team's principal resolves nothing for it.
    expect(await canSeeItem(db(), { teamId: other.teamId, memberId: other.memberId }, item.id)).toBe(false);
  });
});

describe("ENFB-1 AC2 — the okf-bundle pages only membership-visible rows; §2.4 links; §2.5 cursor", () => {
  type Node = { path: string; links: string[]; body: string | null; access: string };

  async function drain(seed: Seed, memberId: string, params = ""): Promise<Node[]> {
    const { key } = await issueApiKey(db(), seed.teamId, memberId, "okf");
    const all: Node[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 12; i++) {
      const url = `http://test/api/v1/okf-bundle?include_body=true${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await okfGET(new Request(url, { headers: { authorization: `Bearer ${key}` } }) as unknown as NextRequest);
      expect(res.status).toBe(200);
      const j = (await res.json()) as { bundle: { nodes: Node[] }; next_cursor: string | null };
      all.push(...j.bundle.nodes);
      cursor = j.next_cursor;
      if (!cursor) break;
    }
    return all;
  }

  it("a restricted item's node (path, title, body) never reaches an outsider's drain; the entitled member gets it; General flows to both", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const restricted = await ingest(seed, { path: "okf/secret.md", body: "# Secret Codename\nrestricted prose", access: "team", project: "src" });
    await ingest(seed, { path: "okf/open.md", body: "# Open\nopen prose", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, restricted.id, insider);

    const out = await drain(seed, outsider);
    expect(out.map((n) => n.path)).toContain("okf/open.md");
    expect(JSON.stringify(out), "the restricted node must be absent for the outsider").not.toContain("okf/secret.md");
    expect(JSON.stringify(out)).not.toContain("Secret Codename");

    const ins = await drain(seed, insider);
    expect(ins.map((n) => n.path)).toContain("okf/secret.md");
    const secretNode = ins.find((n) => n.path === "okf/secret.md")!;
    expect(secretNode.body, "include_body parity for the entitled member").toContain("restricted prose");
  });

  it("§2.4 three-state links in ONE fixture: dangling preserved, membership-invisible redacted, visible preserved", async () => {
    const seed = await seedTeam();
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const invisible = await ingest(seed, { path: "okf/hidden-target.md", body: "target", access: "team", project: "src" });
    await ingest(seed, { path: "okf/visible-target.md", body: "target", access: "team", project: "src" });
    await ingest(seed, {
      path: "okf/linker.md",
      body: "see [a](hidden-target.md) and [b](visible-target.md) and [c](dangling-target.md)",
      access: "team",
      project: "src",
    });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, invisible.id, insider);

    const out = await drain(seed, outsider);
    const linker = out.find((n) => n.path === "okf/linker.md");
    expect(linker, "the linker itself is General-visible").toBeDefined();
    expect(linker!.links, "a dangling target is preserved").toContain("dangling-target.md");
    expect(linker!.links, "a visible target is preserved").toContain("visible-target.md");
    expect(linker!.links, "a membership-invisible target is redacted").not.toContain("hidden-target.md");

    const ins = await drain(seed, insider);
    expect(ins.find((n) => n.path === "okf/linker.md")!.links, "the entitled member keeps all resolvable links").toContain("hidden-target.md");
  });

  it("§2.5 cursor: >PAGE-worth of rows sharing ONE updated_at drain losslessly (small page via many single-row pages is impractical here, so the pin is the composite bound itself), and a LEGACY bare-timestamp cursor still resumes", async () => {
    const seed = await seedTeam();
    const member = await seedMember(seed);
    // Three rows, one shared timestamp — with the OLD bare-ts cursor, resuming after row 1
    // skipped rows 2-3 (strictly-greater timestamp). The composite cursor must not.
    const a = await ingest(seed, { path: "okf/t1.md", body: "t1", access: "team", project: "src" });
    const b = await ingest(seed, { path: "okf/t2.md", body: "t2", access: "team", project: "src" });
    const c = await ingest(seed, { path: "okf/t3.md", body: "t3", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const shared = new Date().toISOString();
    await db().from("items").update({ updated_at: shared }).in("id", [a.id, b.id, c.id]);

    const { pageVisibleOkfItems, parseOkfCursor, formatOkfCursor } = await import("@/lib/okf/page");
    const { ids } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });
    const page1 = await pageVisibleOkfItems({ teamId: seed.teamId, visibleIds: [...ids], after: { ts: "1970-01-01T00:00:00Z", id: null }, projectId: null, externalOnly: false, limit: 2 });
    expect(page1.length).toBe(2);
    const cur = parseOkfCursor(formatOkfCursor(page1[1].updated_at, page1[1].id))!;
    const page2 = await pageVisibleOkfItems({ teamId: seed.teamId, visibleIds: [...ids], after: cur, projectId: null, externalOnly: false, limit: 2 });
    const got = [...page1, ...page2].map((r) => r.path).filter((p) => p.startsWith("okf/t"));
    expect(new Set(got).size, "the composite keyset must drain all three same-timestamp rows").toBe(3);

    // Legacy bare-timestamp cursor: strictly-after semantics still hold (rows BEFORE the shared
    // timestamp are excluded, the shared-timestamp rows are excluded — the legacy contract).
    const legacy = parseOkfCursor(shared)!;
    expect(legacy.id).toBeNull();
    const after = await pageVisibleOkfItems({ teamId: seed.teamId, visibleIds: [...ids], after: legacy, projectId: null, externalOnly: false, limit: 10 });
    expect(after.map((r) => r.path).filter((p) => p.startsWith("okf/t")), "legacy cursor = strictly after the timestamp").toEqual([]);
  });
});
