import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { POST as queryPOST } from "@/app/api/v1/query/route";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { mintAgentToken, revokeAgentToken, verifyAgentToken } from "@/lib/access/agent-tokens";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { effectiveVisibleProjects } from "@/lib/access/oracle";

// Phase A slice 2 (spec §10/§17-A) — real-Postgres + real-route proofs of the delegated-token
// contract: triple-intersection attenuation, NULL vs [] scope, live (non-snapshot) inheritance,
// verify-time principal re-checks, the items-route oracle filter, and query's 403 refusal.

async function seedMember(seed: Seed, over: Partial<{ kind: string; tier: string; status: string }> = {}): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: over.status ?? "active",
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

/** A project row + one granted group containing `memberId`, returning the project id. */
async function grantedProject(seed: Seed, memberId: string, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  const g = await createGroup(db(), seed.teamId, `${slug}-g-${randomUUID().slice(0, 6)}`, slug, seed.memberId);
  await addMemberToGroup(db(), seed.teamId, g.groupId!, memberId, seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, data.id as string, g.groupId!, seed.memberId);
  return data.id as string;
}

function itemsReq(token: string): NextRequest {
  return new Request("http://test/api/v1/items", {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as NextRequest;
}

describe("mint + verify lifecycle", () => {
  it("roundtrips; rejects bad secret, revoked, expired; refuses non-principal legs at mint AND verify", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });

    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);
    expect(minted.ok, minted.error).toBe(true);
    expect(minted.token).toMatch(/^aiosd_/);
    expect(await verifyAgentToken(db(), minted.token!)).not.toBeNull();
    expect(await verifyAgentToken(db(), `${minted.token!.slice(0, -4)}XXXX`)).toBeNull();

    // mint refusals: offroster launcher, offroster on_behalf_of
    const offroster = await seedMember(seed, { kind: "offroster" });
    expect((await mintAgentToken(db(), seed.teamId, { memberId: offroster }, seed.memberId)).ok).toBe(false);
    expect((await mintAgentToken(db(), seed.teamId, { memberId: agent, onBehalfOf: offroster }, seed.memberId)).ok).toBe(false);

    // verify-time re-check: deactivating the launcher kills the live token on the next request
    await db().from("members").update({ status: "disabled" }).eq("id", agent).eq("team_id", seed.teamId);
    expect(await verifyAgentToken(db(), minted.token!), "deactivated launcher must kill the token").toBeNull();
    await db().from("members").update({ status: "active" }).eq("id", agent).eq("team_id", seed.teamId);

    // revoke — and a no-op revoke (unknown id) must NOT report success or audit (Fable M3)
    const r = await revokeAgentToken(db(), seed.teamId, minted.tokenRowId!, seed.memberId);
    expect(r.ok).toBe(true);
    expect(await verifyAgentToken(db(), minted.token!)).toBeNull();
    expect((await revokeAgentToken(db(), seed.teamId, randomUUID(), seed.memberId)).ok).toBe(false);

    // expired
    const expired = await mintAgentToken(
      db(),
      seed.teamId,
      { memberId: agent, expiresAt: new Date(Date.now() - 1000).toISOString() },
      seed.memberId
    );
    expect(await verifyAgentToken(db(), expired.token!)).toBeNull();
  });

  it("schema: a cross-team on_behalf_of is unrepresentable; deleting the acting-as member cascades the token (never widens to self)", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const cross = await db()
      .from("agent_tokens")
      .insert({
        team_id: seedA.teamId,
        member_id: seedA.memberId,
        on_behalf_of: seedB.memberId,
        token_id: randomUUID().slice(0, 12),
        token_hash: "00",
      });
    expect(cross.error, "composite FK must reject a cross-team on_behalf_of").not.toBeNull();

    const rep = await seedMember(seedA);
    const minted = await mintAgentToken(db(), seedA.teamId, { memberId: seedA.memberId, onBehalfOf: rep }, seedA.memberId);
    expect(minted.ok).toBe(true);
    await db().from("members").delete().eq("id", rep).eq("team_id", seedA.teamId);
    const { data: row } = await db().from("agent_tokens").select("id").eq("id", minted.tokenRowId!).maybeSingle();
    expect(row, "on_behalf_of deletion must cascade the token, not null it into a self token").toBeNull();
  });
});

describe("triple intersection + scope semantics (spec §10)", () => {
  it("a mixed token (agent launcher + human on_behalf_of) reads only the intersection", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const shared = await grantedProject(seed, agent, "shared");
    const humanOnly = await grantedProject(seed, seed.memberId, "human-only");
    // the human can also see `shared`
    const g = await createGroup(db(), seed.teamId, `h-${randomUUID().slice(0, 6)}`, "h", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, seed.memberId, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, shared, g.groupId!, seed.memberId);

    const effective = await effectiveVisibleProjects(db(), {
      teamId: seed.teamId,
      memberId: agent,
      onBehalfOf: seed.memberId,
      projectScope: null,
    });
    expect(effective.has(shared)).toBe(true);
    expect(effective.has(humanOnly), "content visible to the human but not the agent must not reach the token").toBe(false);
  });

  it("scope: [] sees nothing (distinct from NULL); a scope naming an invisible project grants nothing", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const p = await grantedProject(seed, agent, "scoped");
    const base = { teamId: seed.teamId, memberId: agent, onBehalfOf: null };
    expect((await effectiveVisibleProjects(db(), { ...base, projectScope: null })).has(p)).toBe(true);
    expect((await effectiveVisibleProjects(db(), { ...base, projectScope: [] })).size).toBe(0);
    expect((await effectiveVisibleProjects(db(), { ...base, projectScope: [randomUUID()] })).size).toBe(0);
  });
});

describe("the items route honors delegated tokens with the oracle filter (the ONE Phase A route)", () => {
  it("agent token sees only items in its effective projects — and inheritance is live, gain direction included", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "a/visible.md", body: "agent visible", access: "team", project: "agentproj" });
    await ingest(seed, { path: "b/hidden.md", body: "agent hidden", access: "team", project: "otherproj" });
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));

    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, "agent-g", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);

    // No grants yet: the fresh agent sees NOTHING (empty effective set short-circuits).
    const empty = await itemsGET(itemsReq(minted.token!));
    expect(empty.status).toBe(200);
    expect((await empty.json()).items).toEqual([]);

    // GAIN direction — the assertion a visibility snapshot cannot pass: grant after mint,
    // and the SAME token gains the project on the next request.
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("agentproj")!, g.groupId!, seed.memberId);
    const res = await itemsGET(itemsReq(minted.token!));
    expect(res.status).toBe(200);
    const paths = ((await res.json()).items as { path: string }[]).map((i) => i.path);
    expect(paths).toContain("a/visible.md");
    expect(paths, "items outside the effective set must not be served").not.toContain("b/hidden.md");

    // LOSE direction: revoke the grant; same token loses it.
    const { error } = await db()
      .from("project_groups")
      .delete()
      .eq("team_id", seed.teamId)
      .eq("project_id", bySlug.get("agentproj")!);
    expect(error).toBeNull();
    const after = await itemsGET(itemsReq(minted.token!));
    expect(((await after.json()).items as unknown[]).length).toBe(0);
  });

  it("member keys behave exactly as before (no filter change for aios_ keys)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "m/anything.md", body: "member sees all team", access: "team" });
    const { issueApiKey } = await import("@/lib/admin/keys");
    const { key } = await issueApiKey(db(), seed.teamId, seed.memberId, "k");
    const res = await itemsGET(itemsReq(key));
    expect(res.status).toBe(200);
    const paths = ((await res.json()).items as { path: string }[]).map((i) => i.path);
    expect(paths).toContain("m/anything.md");
  });
});

describe("stored scope end to end (Fable H2: the []→NULL fail-open direction must have a red test)", () => {
  it("a token minted with projectScope [] sees ZERO items through the route — distinct from NULL = all granted", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "s/one.md", body: "scoped one", access: "team", project: "sproj" });
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const proj = ((projects ?? []) as { id: string; slug: string }[]).find((p) => p.slug === "sproj")!.id;

    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, "sg", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, proj, g.groupId!, seed.memberId);

    const nullScope = await mintAgentToken(db(), seed.teamId, { memberId: agent, projectScope: null }, seed.memberId);
    const emptyScope = await mintAgentToken(db(), seed.teamId, { memberId: agent, projectScope: [] }, seed.memberId);
    expect(nullScope.ok && emptyScope.ok).toBe(true);

    const all = await itemsGET(itemsReq(nullScope.token!));
    expect(((await all.json()).items as { path: string }[]).map((i) => i.path)).toContain("s/one.md");
    const none = await itemsGET(itemsReq(emptyScope.token!));
    expect((await none.json()).items, "stored [] must survive mint→pg→verify→route as SEES NOTHING").toEqual([]);
  });

  it("a token minted with projectScope [P] where the principal sees {P,Q} serves only P through the route", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "p/in.md", body: "in scope", access: "team", project: "pproj" });
    await ingest(seed, { path: "q/out.md", body: "out of scope", access: "team", project: "qproj" });
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));

    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, "pq", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("pproj")!, g.groupId!, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("qproj")!, g.groupId!, seed.memberId);

    const minted = await mintAgentToken(
      db(),
      seed.teamId,
      { memberId: agent, projectScope: [bySlug.get("pproj")!] },
      seed.memberId
    );
    const res = await itemsGET(itemsReq(minted.token!));
    const paths = ((await res.json()).items as { path: string }[]).map((i) => i.path);
    expect(paths).toContain("p/in.md");
    expect(paths, "attenuation must survive the storage round-trip").not.toContain("q/out.md");
  });

  it("a mixed token (agent + human on_behalf_of) through the route reads only the intersection (§14 row, route tier)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "x/shared.md", body: "both", access: "team", project: "xshared" });
    await ingest(seed, { path: "y/humanonly.md", body: "human", access: "team", project: "yhuman" });
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));

    const agent = await seedMember(seed, { kind: "agent" });
    const ag = await createGroup(db(), seed.teamId, "ag", "A", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, ag.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("xshared")!, ag.groupId!, seed.memberId);
    const hg = await createGroup(db(), seed.teamId, "hg", "H", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, hg.groupId!, seed.memberId, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("xshared")!, hg.groupId!, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("yhuman")!, hg.groupId!, seed.memberId);

    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent, onBehalfOf: seed.memberId }, seed.memberId);
    const res = await itemsGET(itemsReq(minted.token!));
    const paths = ((await res.json()).items as { path: string }[]).map((i) => i.path);
    expect(paths).toContain("x/shared.md");
    expect(paths, "content visible to the human but not the agent must never reach the token").not.toContain("y/humanonly.md");
  });
});

describe("Phase A: no external-tier delegation (Fable H1)", () => {
  it("mint refuses an external-tier launcher and an external-tier on_behalf_of", async () => {
    const seed = await seedTeam();
    const extAgent = await seedMember(seed, { kind: "agent", tier: "external" });
    const extHuman = await seedMember(seed, { tier: "external" });
    const agent = await seedMember(seed, { kind: "agent" });
    expect((await mintAgentToken(db(), seed.teamId, { memberId: extAgent }, seed.memberId)).ok).toBe(false);
    expect((await mintAgentToken(db(), seed.teamId, { memberId: agent, onBehalfOf: extHuman }, seed.memberId)).ok).toBe(false);
  });

  it("a tier downgrade AFTER mint kills the live token at verify", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);
    expect(await verifyAgentToken(db(), minted.token!)).not.toBeNull();
    await db().from("members").update({ tier: "external" }).eq("id", agent).eq("team_id", seed.teamId);
    expect(await verifyAgentToken(db(), minted.token!), "external downgrade must kill the token in Phase A").toBeNull();
  });
});

describe("query refuses every aiosd_* token in Phase A", () => {
  it("returns 403 delegation_not_supported — before any credential lookup", async () => {
    const res = await queryPOST(
      new Request("http://test/api/v1/query", {
        method: "POST",
        headers: { authorization: "Bearer aiosd_deadbeef_notevenreal", "content-type": "application/json" },
        body: JSON.stringify({ question: "anything" }),
      }) as unknown as NextRequest
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("delegation_not_supported");
  });
});
