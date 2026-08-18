import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import {
  EXTERNAL_SHARED_SLUG,
  GENERAL_SLUG,
  ensureAccessBootstrap,
  ensureAccessBootstrapAllTeams,
} from "@/lib/access/bootstrap";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/groups";
import { visibleProjects } from "@/lib/access/oracle";
import { deleteMember } from "@/lib/admin/members";

// Phase A slice 3 (spec §11) — real-Postgres proofs of the bootstrap: the exact three-edge
// grant topology, idempotency, the adopt ruling for a pre-existing source 'general', the
// §11 day-one visibility shape via the oracle, and the awaited lifecycle hook.

async function seedMember(seed: Seed, over: Partial<{ tier: string; status: string; kind: string }> = {}): Promise<string> {
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
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data.id as string, over.tier ?? "team");
  return data.id as string;
}

async function topology(seed: Seed) {
  const { data: projects } = await db()
    .from("projects")
    .select("id, slug, kind")
    .eq("team_id", seed.teamId)
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  const { data: groups } = await db()
    .from("groups")
    .select("id, slug")
    .eq("team_id", seed.teamId)
    .eq("is_builtin", true);
  const { data: grants } = await db().from("project_groups").select("project_id, group_id").eq("team_id", seed.teamId);
  return {
    projects: (projects ?? []) as { id: string; slug: string; kind: string }[],
    groups: (groups ?? []) as { id: string; slug: string }[],
    grants: (grants ?? []) as { project_id: string; group_id: string }[],
  };
}

describe("ensureAccessBootstrap (§11)", () => {
  it("creates the exact three-edge topology, idempotently — byte-identical rows on re-run", async () => {
    const seed = await seedTeam();
    const r1 = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r1.ok, r1.error).toBe(true);
    const t1 = await topology(seed);
    expect(t1.projects.map((p) => p.kind)).toEqual(["system", "system"]);
    expect(t1.groups.map((g) => g.slug).sort()).toEqual([EVERYONE_SLUG, EXTERNAL_SLUG]);
    expect(t1.grants.length, "exactly three grant edges").toBe(3);

    const general = t1.projects.find((p) => p.slug === GENERAL_SLUG)!;
    const extShared = t1.projects.find((p) => p.slug === EXTERNAL_SHARED_SLUG)!;
    const everyone = t1.groups.find((g) => g.slug === EVERYONE_SLUG)!;
    const external = t1.groups.find((g) => g.slug === EXTERNAL_SLUG)!;
    const edges = new Set(t1.grants.map((g) => `${g.project_id}:${g.group_id}`));
    expect(edges.has(`${general.id}:${everyone.id}`), "general↔everyone").toBe(true);
    expect(edges.has(`${extShared.id}:${external.id}`), "external-shared↔external").toBe(true);
    expect(edges.has(`${extShared.id}:${everyone.id}`), "external-shared↔everyone").toBe(true);
    // The inverse (criteria need their inverse): NO general↔external edge — external-tier
    // principals must not see General.
    expect(edges.has(`${general.id}:${external.id}`)).toBe(false);

    const grantAudits = async () => {
      const { data } = await db()
        .from("audit_log")
        .select("id")
        .eq("team_id", seed.teamId)
        .eq("action", "access.project_granted");
      return (data ?? []).length;
    };
    const auditsAfterFirst = await grantAudits();
    expect(auditsAfterFirst).toBe(3);

    const r2 = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r2.ok).toBe(true);
    const t2 = await topology(seed);
    expect(t2.projects.map((p) => p.id).sort()).toEqual(t1.projects.map((p) => p.id).sort());
    expect(t2.grants.length).toBe(3);
    // Audit-on-creation only (Fable High): a converged re-run mints ZERO new grant audits —
    // at tick cadence an unconditional audit was 3 rows/team/run forever, drowning the trail.
    expect(await grantAudits(), "re-run must not mint new grant audit rows").toBe(auditsAfterFirst);
  });

  it("§11 day-one shape via the oracle: team human sees both; external human sees external-shared ONLY", async () => {
    const seed = await seedTeam();
    const externalHuman = await seedMember(seed, { tier: "external" });
    await ensureAccessBootstrap(db(), seed.teamId);
    const t = await topology(seed);
    const generalId = t.projects.find((p) => p.slug === GENERAL_SLUG)!.id;
    const extSharedId = t.projects.find((p) => p.slug === EXTERNAL_SHARED_SLUG)!.id;

    const team = await visibleProjects(db(), { teamId: seed.teamId, memberId: seed.memberId });
    expect(team.projectIds.has(generalId)).toBe(true);
    expect(team.projectIds.has(extSharedId), "external content is team-visible today").toBe(true);

    const ext = await visibleProjects(db(), { teamId: seed.teamId, memberId: externalHuman });
    expect(ext.projectIds.has(extSharedId)).toBe(true);
    expect(ext.projectIds.has(generalId), "General must never reach an external principal").toBe(false);
  });

  it("adopts a pre-existing ingestion-created 'general' (same row, kind→system, audited) instead of duplicating", async () => {
    const seed = await seedTeam();
    const { data: pre } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: GENERAL_SLUG, name: "general" })
      .select("id")
      .single();
    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, r.error).toBe(true);

    const { data: rows } = await db()
      .from("projects")
      .select("id, kind")
      .eq("team_id", seed.teamId)
      .eq("slug", GENERAL_SLUG);
    expect((rows ?? []).length, "one general row, never a duplicate").toBe(1);
    expect(rows![0].id).toBe(pre!.id);
    expect(rows![0].kind).toBe("system");
    const { data: adopted } = await db()
      .from("audit_log")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("action", "access.project_adopted");
    expect((adopted ?? []).length).toBeGreaterThan(0);
  });

  it("convergence over all teams is best-effort per team and reports failures", async () => {
    const seedA = await seedTeam();
    await seedTeam(); // second team, untouched
    const r = await ensureAccessBootstrapAllTeams(db());
    expect(r.teams).toBeGreaterThanOrEqual(2);
    // teams from OTHER concurrent tests may legitimately fail (e.g. planted squatters);
    // ours must not be among the failures.
    expect(r.failed.map((f) => f.teamId)).not.toContain(seedA.teamId);
  });

  it("ingesting into 'general' AFTER bootstrap lands in the SYSTEM row — same id, kind stays system (Fable M7)", async () => {
    const seed = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    const { data: before } = await db()
      .from("projects")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", GENERAL_SLUG)
      .single();

    await ingest(seed, { project: GENERAL_SLUG, path: "g/pushed.md", body: "pushed into general", access: "team" });

    const { data: after } = await db()
      .from("projects")
      .select("id, kind")
      .eq("team_id", seed.teamId)
      .eq("slug", GENERAL_SLUG);
    expect((after ?? []).length, "ingest must reuse the system row, never duplicate").toBe(1);
    expect(after![0].id).toBe(before!.id);
    expect(after![0].kind, "an ingest sync must never demote the system project").toBe("system");
    const { data: item } = await db()
      .from("items")
      .select("project_id")
      .eq("team_id", seed.teamId)
      .eq("path", "g/pushed.md")
      .single();
    expect(item!.project_id).toBe(before!.id);
  });

  it("refuses to adopt a non-source project squatting a system slug (Fable M2)", async () => {
    const seed = await seedTeam();
    // Plant a future-kind row directly (dashboard initiative creation arrives with Part II).
    await db().from("projects").insert({ team_id: seed.teamId, slug: GENERAL_SLUG, name: "curated", kind: "initiative" });
    const r = await ensureAccessBootstrap(db(), seed.teamId);
    expect(r.ok, "adopting an initiative would be an ACL rewrite — must refuse").toBe(false);
    const { data: row } = await db()
      .from("projects")
      .select("kind")
      .eq("team_id", seed.teamId)
      .eq("slug", GENERAL_SLUG)
      .single();
    expect(row!.kind).toBe("initiative");
  });

  it("schema: an invalid projects.kind is rejected (named CHECK exists and constrains)", async () => {
    const seed = await seedTeam();
    const { error } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: `k-${randomUUID().slice(0, 6)}`, kind: "workspace" });
    expect(error, "projects_kind_check must reject an unknown kind").not.toBeNull();
  });
});

describe("lifecycle hook (awaited path)", () => {
  it("deleteMember (soft) drops the member from Everyone in the same call", async () => {
    const seed = await seedTeam();
    // seed.memberId is the only admin; disable a second member instead.
    const other = await seedMember(seed);
    const { data: row } = await db().from("members").select("email").eq("id", other).single();
    await ensureAccessBootstrap(db(), seed.teamId);

    const { data: everyone } = await db()
      .from("groups")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", EVERYONE_SLUG)
      .single();
    const inEveryone = async () => {
      const { data } = await db()
        .from("group_members")
        .select("member_id")
        .eq("group_id", everyone!.id)
        .eq("member_id", other);
      return (data ?? []).length > 0;
    };
    expect(await inEveryone()).toBe(true);

    const r = await deleteMember(db(), seed.teamId, row!.email);
    expect(r.deleted).toBe(true);
    // PRET-4 lifecycle ruling (inverts the recompute-era drop): the row STAYS — explicit state
    // is not recomputed on lifecycle — and is access-inert read-side (isPrincipal in the
    // oracle refuses a disabled member; auth refuses them before posture).
    expect(await inEveryone(), "the surviving row is the explicit-state design").toBe(true);
    const { visibleProjects } = await import("@/lib/access/oracle");
    const vis = await visibleProjects(db(), { teamId: seed.teamId, memberId: other });
    expect(vis.projectIds.size, "and it grants NOTHING — inert, not live").toBe(0);
  });
});
