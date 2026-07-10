import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as companyGraphGET } from "@/app/api/v1/company-graph/route";
import { issueApiKey } from "@/lib/admin/keys";
import { syncMemberActor, memberEntityId } from "@/lib/graph/company-actors";
import { db, seedTeam, type Seed } from "./helpers";

// HTTP edge for GET /api/v1/company-graph (brain-api v1.5, AIO-141). The graph tables
// have a team_id but no per-row tier column and no RLS backstop, so the route handler
// is the SOLE gate. Verified against the real handler + real Postgres:
//   - team key 200 { people, ownership }, external key 403 forbidden_tier, bad key 401
//   - people[] projects role/job_family/reports_to out of attrs (missing → null)
//   - ownership[] is the server-side join (OWNS/TOUCHES/PRODUCES only; dangling
//     to_id skipped; target_name/kind/job_family resolved from the target entity)
//   - unseeded team → 200 { people: [], ownership: [] } (never 500)
//   - another team's graph rows never leak

const URL = "http://test/api/v1/company-graph";

async function issueKeyFor(seed: Seed, tier: "team" | "external") {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  return key;
}

function get(key: string, teamSlug: string) {
  const req = new Request(URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": teamSlug },
  }) as unknown as NextRequest;
  return companyGraphGET(req);
}

/** Seed a Veridian-shaped mini graph: 2 actors, 1 workflow, OWNS/TOUCHES/REPORTS_TO edges. */
async function seedGraph(seed: Seed) {
  const { error: eErr } = await db()
    .from("graph_entities")
    .insert([
      {
        team_id: seed.teamId,
        entity_id: "actor-001",
        entity_type: "actor",
        name: "Nadia Kovalchuk",
        // The seed stores the whole fixture object in attrs.
        attrs: { id: "actor-001", name: "Nadia Kovalchuk", role: "Head of Finance", job_family: "Finance", reports_to: "actor-002" },
      },
      {
        team_id: seed.teamId,
        entity_id: "actor-002",
        entity_type: "actor",
        name: "Sarah Chen",
        // No role/job_family/reports_to attrs → projected as null.
        attrs: { id: "actor-002", name: "Sarah Chen" },
      },
      {
        team_id: seed.teamId,
        entity_id: "wf-001",
        entity_type: "workflow",
        name: "Month-End Financial Close",
        attrs: { id: "wf-001", name: "Month-End Financial Close", job_family: "Finance" },
      },
    ]);
  if (eErr) throw new Error(`graph entity seed failed: ${eErr.message}`);

  const { error: rErr } = await db()
    .from("graph_relationships")
    .insert([
      // Projected: an ownership edge, resolved against the workflow entity.
      { team_id: seed.teamId, from_id: "actor-001", to_id: "wf-001", relationship_type: "OWNS", attrs: {} },
      { team_id: seed.teamId, from_id: "actor-002", to_id: "wf-001", relationship_type: "TOUCHES", attrs: {} },
      // Skipped: org edge — not an ownership type (people carry reports_to via attrs).
      { team_id: seed.teamId, from_id: "actor-001", to_id: "actor-002", relationship_type: "REPORTS_TO", attrs: {} },
      // Skipped: ownership edge whose to_id doesn't resolve to an entity.
      { team_id: seed.teamId, from_id: "actor-001", to_id: "wf-gone", relationship_type: "OWNS", attrs: {} },
    ]);
  if (rErr) throw new Error(`graph relationship seed failed: ${rErr.message}`);
}

describe("company-graph endpoint (real handler, real Postgres)", () => {
  it("team key: 200 with attrs-projected people[] and the server-side ownership join", async () => {
    const seed = await seedTeam();
    await seedGraph(seed);
    const key = await issueKeyFor(seed, "team");

    const res = await get(key, seed.teamSlug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      people: { entity_id: string; name: string; role: string | null; job_family: string | null; reports_to: string | null }[];
      ownership: { person_id: string; relationship: string; target_id: string; target_kind: string; target_name: string; target_job_family: string | null }[];
    };

    // people[]: only actors, attrs projected, missing attrs emitted as null (not omitted).
    expect(body.people.map((p) => p.entity_id).sort()).toEqual(["actor-001", "actor-002"]);
    const nadia = body.people.find((p) => p.entity_id === "actor-001");
    expect(nadia).toEqual({
      entity_id: "actor-001",
      name: "Nadia Kovalchuk",
      role: "Head of Finance",
      job_family: "Finance",
      reports_to: "actor-002",
    });
    const sarah = body.people.find((p) => p.entity_id === "actor-002");
    expect(sarah).toEqual({
      entity_id: "actor-002",
      name: "Sarah Chen",
      role: null,
      job_family: null,
      reports_to: null,
    });

    // ownership[]: OWNS + TOUCHES resolved; REPORTS_TO and the dangling edge excluded.
    expect(body.ownership).toHaveLength(2);
    const owns = body.ownership.find((o) => o.relationship === "OWNS");
    expect(owns).toEqual({
      person_id: "actor-001",
      relationship: "OWNS",
      target_id: "wf-001",
      target_kind: "workflow",
      target_name: "Month-End Financial Close",
      target_job_family: "Finance",
    });
    expect(body.ownership.find((o) => o.relationship === "TOUCHES")?.person_id).toBe("actor-002");
  });

  it("tier gate: external key 403 forbidden_tier; bad key 401", async () => {
    const seed = await seedTeam();
    await seedGraph(seed);

    const ext = await issueKeyFor(seed, "external");
    const forbidden = await get(ext, seed.teamSlug);
    expect(forbidden.status).toBe(403);
    const err = (await forbidden.json()) as { error: { code: string } };
    expect(err.error.code).toBe("forbidden_tier");

    const unauthorized = await get("aios_nope_notakey", seed.teamSlug);
    expect(unauthorized.status).toBe(401);
  });

  it("unseeded team: 200 { people: [], ownership: [] }, never 500", async () => {
    const seed = await seedTeam();
    const key = await issueKeyFor(seed, "team");

    const res = await get(key, seed.teamSlug);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ people: [], ownership: [] });
  });

  it("team isolation: another team's graph rows never leak", async () => {
    const seeded = await seedTeam();
    await seedGraph(seeded);
    const other = await seedTeam();
    const key = await issueKeyFor(other, "team");

    const res = await get(key, other.teamSlug);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ people: [], ownership: [] });
  });

  it("a real, member-synced actor's reports_to is projected from attrs.reports_to (not just a relationship row)", async () => {
    const seed = await seedTeam();
    const { data: manager } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Manager",
        actor_handle: `mgr-${randomUUID().slice(0, 8)}`,
        role: "lead",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    const managerId = (manager as { id: string }).id;
    await db().from("members").update({ manager_member_id: managerId }).eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, managerId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    const key = await issueKeyFor(seed, "team");
    const res = await get(key, seed.teamSlug);
    const body = (await res.json()) as { people: { entity_id: string; reports_to: string | null }[] };
    const synced = body.people.find((p) => p.entity_id === memberEntityId(seed.memberId));
    expect(synced?.reports_to).toBe(memberEntityId(managerId));
  });

  it("a soft-disabled member's entity is absent from people[] but still present in graph_entities directly", async () => {
    const seed = await seedTeam();
    // A key must belong to a still-active member (authenticateApiKey rejects a disabled owner
    // outright) — issue from a second, active member; seed.memberId is the one being disabled.
    const { data: activeCaller } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Caller",
        actor_handle: `caller-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    const { key } = await issueApiKey(db(), seed.teamId, (activeCaller as { id: string }).id, "team key");

    await syncMemberActor(db(), seed.teamId, seed.memberId);
    await db().from("members").update({ status: "disabled" }).eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    const res = await get(key, seed.teamSlug);
    const body = (await res.json()) as { people: { entity_id: string }[] };
    expect(body.people.some((p) => p.entity_id === memberEntityId(seed.memberId))).toBe(false);

    const { data: rawEntity } = await db()
      .from("graph_entities")
      .select("entity_id")
      .eq("team_id", seed.teamId)
      .eq("entity_id", memberEntityId(seed.memberId))
      .maybeSingle();
    expect(rawEntity).not.toBeNull(); // kept for history, just not surfaced as current staff
  });

  it("a connector member never appears in people[] even after a backfill-style sync attempt", async () => {
    const seed = await seedTeam();
    const { data: connector } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Plane Sync",
        actor_handle: `plane-sync-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
        is_connector: true,
      })
      .select("id")
      .single();
    await syncMemberActor(db(), seed.teamId, (connector as { id: string }).id);

    const key = await issueKeyFor(seed, "team");
    const res = await get(key, seed.teamSlug);
    const body = (await res.json()) as { people: { entity_id: string }[] };
    expect(body.people.some((p) => p.entity_id === memberEntityId((connector as { id: string }).id))).toBe(false);
  });
});
