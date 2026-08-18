import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { POST as queryPOST } from "@/app/api/v1/query/route";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { mintAgentToken, revokeAgentToken, verifyAgentToken } from "@/lib/access/agent-tokens";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { effectiveVisibleProjects } from "@/lib/access/oracle";

// Phase A slice 2 (spec §10/§17-A) + Phase B slice 3 (§17-B) — real-Postgres + real-route proofs
// of the delegated-token contract: triple-intersection attenuation, NULL vs [] scope, live
// (non-snapshot) inheritance, verify-time principal re-checks, the items-route oracle filter, and
// delegated `query` (admitted in B; retrieval ALWAYS attenuated, graph legs omitted, stateless).

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

/** Curate an item's context membership into `projectId` (the §11 backfill parks everything in
 *  General; project scope operates over MEMBERSHIPS, so scoped-visibility fixtures must move
 *  the item the way the Phase D curation surface will — PRET-6 deleted the Phase-A project_id
 *  proxy, so EVERY project-granted fixture goes through this now). */
async function curateInto(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  // Expire only the CURRENT membership (Fable B3 Low: without the null filter this helper
  // rewrites valid_to on already-expired history rows — wrong when copied to real curation).
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: unit!.id, method: "manual" });
  if (error) throw new Error(`curate failed: ${error.message}`);
}
async function backfill(seed: Seed): Promise<void> {
  const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
  const r = await backfillTeamContext(db(), seed.teamId);
  if (!r.ok) throw new Error(`backfill failed: ${r.error}`);
}

describe("the items route honors delegated tokens with the oracle filter (the ONE Phase A route)", () => {
  it("agent token sees only items in its effective projects — and inheritance is live, gain direction included", async () => {
    const seed = await seedTeam();
    const vis = await ingest(seed, { path: "a/visible.md", body: "agent visible", access: "team", project: "agentproj" });
    await ingest(seed, { path: "b/hidden.md", body: "agent hidden", access: "team", project: "otherproj" });
    await backfill(seed);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
    // PRET-6: membership, not the ingest project_id, is what a grant serves.
    await curateInto(seed, vis.id, bySlug.get("agentproj")!);

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
    await backfill(seed);
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
    const one = await ingest(seed, { path: "s/one.md", body: "scoped one", access: "team", project: "sproj" });
    await backfill(seed);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const proj = ((projects ?? []) as { id: string; slug: string }[]).find((p) => p.slug === "sproj")!.id;
    await curateInto(seed, one.id, proj);

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
    const pin = await ingest(seed, { path: "p/in.md", body: "in scope", access: "team", project: "pproj" });
    const qout = await ingest(seed, { path: "q/out.md", body: "out of scope", access: "team", project: "qproj" });
    await backfill(seed);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
    await curateInto(seed, pin.id, bySlug.get("pproj")!);
    await curateInto(seed, qout.id, bySlug.get("qproj")!);

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
    const xs = await ingest(seed, { path: "x/shared.md", body: "both", access: "team", project: "xshared" });
    const yh = await ingest(seed, { path: "y/humanonly.md", body: "human", access: "team", project: "yhuman" });
    await backfill(seed);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
    await curateInto(seed, xs.id, bySlug.get("xshared")!);
    await curateInto(seed, yh.id, bySlug.get("yhuman")!);

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

function queryReq(token: string, body: Record<string, unknown>): NextRequest {
  return new Request("http://test/api/v1/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("query honors delegated tokens (Phase B slice 3, spec §10/§17-B)", () => {
  it("a valid spawn-default token gets the SSE stream — the Phase A 403 refusal is lifted", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);
    const res = await queryPOST(queryReq(minted.token!, { question: "anything at all" }));
    expect(res.status, "delegated query must be admitted, not refused").toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.cancel();
  });

  it("an invalid aiosd_ credential is a 401 (credential problem), not a 403 (operation problem)", async () => {
    const res = await queryPOST(queryReq("aiosd_deadbeef_notevenreal", { question: "anything" }));
    expect(res.status).toBe(401);
  });

  it("a query that never reaches `done` still consumes daily quota — the query_log row is written BEFORE streaming (Codex B3 High: read-deltas-and-disconnect was free and uncounted)", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);
    const res = await queryPOST(queryReq(minted.token!, { question: "count this attempt" }));
    expect(res.status).toBe(200);
    await res.text(); // drain: with no LLM configured this tier's stream ends in an error frame, never `done`
    const { count } = await db()
      .from("query_log")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("member_id", agent);
    expect(count, "the attempt must be counted without a done frame").toBe(1);
  });

  it("a delegated query is stateless: conversation_id is refused explicitly (422), never silently ignored", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);
    const res = await queryPOST(queryReq(minted.token!, { question: "q", conversation_id: randomUUID() }));
    expect(res.status).toBe(422);
  });
});

describe("delegated retrieval is ALWAYS oracle-attenuated — flag-independent (§5.8b: all aiosd_ tokens)", () => {
  const TERM = "zanzibarite"; // rare term shared across fixture bodies so FTS matches them all

  async function delegatedPaths(agentAuth: { teamId: string; memberId: string; onBehalfOf: string | null; projectScope: string[] | null }): Promise<string[]> {
    const { delegatedVisibleItemIds } = await import("@/lib/access/enforce");
    const { retrieve } = await import("@/lib/query/retrieve");
    const { ids } = await delegatedVisibleItemIds(db(), agentAuth);
    const ctx = await retrieve(db(), agentAuth.teamId, "team", `tell me about ${TERM}`, null, { visibleItemIds: ids });
    return ctx.sources.map((s) => s.path);
  }

  it("a scoped token retrieves ONLY its effective set — delegation is attenuated regardless of any member's own visibility", async () => {
    const seed = await seedTeam();
    const inScope = await ingest(seed, { path: "a/in-scope.md", body: `in ${TERM}`, access: "team", project: "agentproj" });
    const outScope = await ingest(seed, { path: "b/out-of-scope.md", body: `out ${TERM}`, access: "team", project: "otherproj" });
    await (await import("@/lib/projects/context/backfill")).backfillTeamContext(db(), seed.teamId);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
    await curateInto(seed, inScope.id, bySlug.get("agentproj")!);
    await curateInto(seed, outScope.id, bySlug.get("otherproj")!);

    // The agent's LAUNCHER can see BOTH projects; the token is scoped to one. What must gate the
    // answer is the token's scope — a launcher-only filter would pass this fixture's b/ item.
    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, "dq-g", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("agentproj")!, g.groupId!, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("otherproj")!, g.groupId!, seed.memberId);

    const scoped = { teamId: seed.teamId, memberId: agent, onBehalfOf: null, projectScope: [bySlug.get("agentproj")!] };
    const got = await delegatedPaths(scoped);
    expect(got, "in-scope content must be served").toContain("a/in-scope.md");
    expect(got, "a permissive team must NOT widen a scoped token to the full corpus").not.toContain("b/out-of-scope.md");
  });

  it("scope over an UNCURATED corpus retrieves nothing — §11 parks every item in General, so a project scope grants only what has been curated into that project (fail closed, no ingestion-project fallback)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "u/raw.md", body: `u ${TERM}`, access: "team", project: "uproj" });
    await (await import("@/lib/projects/context/backfill")).backfillTeamContext(db(), seed.teamId);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const uproj = ((projects ?? []) as { id: string; slug: string }[]).find((p) => p.slug === "uproj")!.id;
    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, "uq-g", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, uproj, g.groupId!, seed.memberId);
    // The item was INGESTED under uproj, but its membership is in General until curated — the
    // scoped token must NOT get it through the items.project_id backdoor the Phase A proxy used.
    const got = await delegatedPaths({ teamId: seed.teamId, memberId: agent, onBehalfOf: null, projectScope: [uproj] });
    expect(got).toEqual([]);
  });

  it("scope [] retrieves nothing (fail closed, distinct from NULL)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "n/any.md", body: `n ${TERM}`, access: "team", project: "nproj" });
    await (await import("@/lib/projects/context/backfill")).backfillTeamContext(db(), seed.teamId);
    const agent = await seedMember(seed, { kind: "agent" });
    const got = await delegatedPaths({ teamId: seed.teamId, memberId: agent, onBehalfOf: null, projectScope: [] });
    expect(got).toEqual([]);
  });

  it("org-structural graph legs are omitted for a delegated principal — while a member read serves them (§5.8b; PRET-6: one mode, and the commitment control retired with the QMIR allowlist)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "gq/x.md", body: `gq ${TERM}`, access: "team", project: "gqproj" });
    await backfill(seed);
    // The QMIR served allowlist is actors + REPORTS_TO — so the LIVE-leg control plants an actor
    // (the old commitment control died with the allowlist: commitments serve NOBODY now).
    await db().from("graph_entities").insert({ team_id: seed.teamId, entity_id: `member:delegated-ctl`, entity_type: "actor", name: "Delegated Control Actor", attrs: { role: "eng" } });
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const gqproj = ((projects ?? []) as { id: string; slug: string }[]).find((p) => p.slug === "gqproj")!.id;
    const agent = await seedMember(seed, { kind: "agent" });
    const g = await createGroup(db(), seed.teamId, "gq-g", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, gqproj, g.groupId!, seed.memberId);

    // A MEMBER retrieval sees the actor roster (control: the leg is live)…
    const { retrieve } = await import("@/lib/query/retrieve");
    const { visibleItemIds } = await import("@/lib/access/enforce");
    const memberIds = await visibleItemIds(db(), { teamId: seed.teamId, memberId: seed.memberId });
    const asMember = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, { visibleItemIds: memberIds.ids, principal: "member" });
    expect(asMember.structured, "control: the org-structural leg serves members").toContain("Delegated Control Actor");

    // …but the delegated principal must never get it.
    const { delegatedVisibleItemIds } = await import("@/lib/access/enforce");
    const { ids } = await delegatedVisibleItemIds(db(), { teamId: seed.teamId, memberId: agent, onBehalfOf: null, projectScope: null });
    const delegated = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, { visibleItemIds: ids, principal: "token" });
    expect(delegated.structured, "org-structural legs must be OMITTED for every aiosd_ principal").not.toContain("Delegated Control Actor");
  });

  it("a mixed token (agent launcher + human on_behalf_of) retrieves only the intersection", async () => {
    const seed = await seedTeam();
    const onlyAgent = await ingest(seed, { path: "p/only-agent.md", body: `p ${TERM}`, access: "team", project: "aproj" });
    const shared = await ingest(seed, { path: "q/shared.md", body: `q ${TERM}`, access: "team", project: "qproj" });
    await (await import("@/lib/projects/context/backfill")).backfillTeamContext(db(), seed.teamId);
    const { data: projects } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId);
    const bySlug = new Map(((projects ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
    await curateInto(seed, onlyAgent.id, bySlug.get("aproj")!);
    await curateInto(seed, shared.id, bySlug.get("qproj")!);

    const agent = await seedMember(seed, { kind: "agent" });
    const human = await seedMember(seed);
    // Agent sees {aproj, qproj}; the represented human sees only {qproj}.
    const ga = await createGroup(db(), seed.teamId, "mx-a", "A", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, ga.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("aproj")!, ga.groupId!, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("qproj")!, ga.groupId!, seed.memberId);
    const gh = await createGroup(db(), seed.teamId, "mx-h", "H", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, gh.groupId!, human, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, bySlug.get("qproj")!, gh.groupId!, seed.memberId);

    const got = await delegatedPaths({ teamId: seed.teamId, memberId: agent, onBehalfOf: human, projectScope: null });
    expect(got, "the shared project flows").toContain("q/shared.md");
    expect(got, "a mixed credential must not exceed the represented human").not.toContain("p/only-agent.md");
  });
});
