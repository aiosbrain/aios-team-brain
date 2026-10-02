import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, sha, transactionDecoratedDb, type Seed } from "./helpers";
import { ingestItem } from "@/lib/ingest";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { ensureIncludeMembership } from "@/lib/projects/context/memberships";
import { ensureAccessBootstrap, GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import { canSeeItem } from "@/lib/access/enforce";
import { createMember } from "@/lib/admin/members";
import type { DbClient } from "@/lib/db/types";

/**
 * TIERRET-1 AC-09 — `noWideningGate` is REPLACED (not deleted) by a target-integrity gate in the
 * same authoritative membership writer and its ingest/reconcile preflights:
 *   · ordinary/initiative targets: no audience veto — a TEAM unit may enter an initiative granted
 *     to the actual builtin External group (the membership grant is the sharing act);
 *   · protected targets (`isProtectedProject`): exact routing from the LOCKED `items.access`
 *     (team → General, external → external-shared) AND every grant sanctioned; anything else —
 *     including an unsanctioned custom/singleton grant on external-shared during a WIDENING push —
 *     is a settled `system-integrity` refusal with no mutation;
 *   · read errors stay errors (never settled refusals, never success).
 * Concurrency/rollback/human-exclusion survival is the AUDITFIX-13 suite's job
 * (item-context-serialization), revised to the new reason; one agreement check is repeated here.
 *
 * RED-FIRST: written before the implementation; baseline recorded in the handoff ACCEPTANCE.md.
 */

async function sys(seed: Seed) {
  const { data } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId).eq("kind", "system").in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  const by = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  return { general: by.get(GENERAL_SLUG)!, externalShared: by.get(EXTERNAL_SHARED_SLUG)! };
}

async function builtinGroup(seed: Seed, slug: "everyone" | "external"): Promise<string> {
  const { data } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", slug).eq("is_builtin", true).single();
  return (data as { id: string }).id;
}

/** RAW forbidden edge — the grant writer refuses system grants, which is exactly why a census exists. */
async function plantEdge(seed: Seed, projectId: string, groupId: string): Promise<void> {
  const { error } = await db().from("project_groups").insert({ team_id: seed.teamId, project_id: projectId, group_id: groupId });
  expect(error, "forbidden-edge fixture must insert").toBeNull();
}

async function currentIncludes(seed: Seed, itemId: string): Promise<string[]> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("team_id", seed.teamId).eq("source_item_id", itemId).maybeSingle();
  if (!unit) return [];
  const { data } = await db()
    .from("project_context_memberships")
    .select("project_id")
    .eq("team_id", seed.teamId)
    .eq("context_unit_id", (unit as { id: string }).id)
    .eq("decision", "include")
    .is("valid_to", null);
  return ((data ?? []) as { project_id: string }[]).map((r) => r.project_id).sort();
}

async function unitOf(seed: Seed, itemId: string): Promise<string> {
  const u = await reconcileItemUnit(db(), seed.teamId, itemId);
  expect(u.ok, u.error).toBe(true);
  return u.unitId!;
}

async function converged(): Promise<Seed> {
  const seed = await seedTeam();
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  return seed;
}

async function externalOnlyHuman(seed: Seed): Promise<string> {
  const m = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Ext", actorHandle: `e-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
  await db().from("members").update({ status: "active" }).eq("id", m.id);
  return m.id;
}

describe("TIERRET-1 AC-09 — ordinary/initiative targets carry no audience veto", () => {
  it("a TEAM-labelled unit enters an initiative granted to the actual builtin External group", async () => {
    const seed = await converged();
    const item = await ingest(seed, { path: "plan.md", body: "team plan", access: "team", project: "src" });
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `shared-${randomUUID().slice(0, 6)}`, name: "Shared", kind: "initiative" }).select("id").single();
    const initiative = (proj as { id: string }).id;
    const g = await grantProjectToGroup(db(), seed.teamId, initiative, await builtinGroup(seed, "external"), seed.memberId);
    expect(g.ok, g.error).toBe(true);

    const r = await ensureIncludeMembership(db(), seed.teamId, { projectId: initiative, contextUnitId: await unitOf(seed, item.id) });
    expect(r, "the membership grant is the sharing act — no label veto on an ordinary target").toMatchObject({ ok: true, created: true });
    const ext = await externalOnlyHuman(seed);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: ext }, item.id), "the External group's grant now serves it").toBe(true);
  });
});

describe("TIERRET-1 AC-09 — protected targets: exact routing from the locked item", () => {
  it("team → external-shared is a settled system-integrity refusal with no row written", async () => {
    const seed = await converged();
    const item = await ingest(seed, { path: "t.md", body: "t", access: "team", project: "src" });
    const s = await sys(seed);
    const r = await ensureIncludeMembership(db(), seed.teamId, { projectId: s.externalShared, contextUnitId: await unitOf(seed, item.id) });
    expect(r).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(await currentIncludes(seed, item.id)).not.toContain(s.externalShared);
  });

  it("external → General is refused too (the old gate only vetoed team units)", async () => {
    const seed = await converged();
    const item = await ingest(seed, { path: "e.md", body: "e", access: "external", project: "src" });
    const s = await sys(seed);
    const r = await ensureIncludeMembership(db(), seed.teamId, { projectId: s.general, contextUnitId: await unitOf(seed, item.id) });
    expect(r).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(await currentIncludes(seed, item.id)).not.toContain(s.general);
  });

  it("an unknown target is refused without mutation", async () => {
    const seed = await converged();
    const item = await ingest(seed, { path: "u.md", body: "u", access: "team", project: "src" });
    const r = await ensureIncludeMembership(db(), seed.teamId, { projectId: randomUUID(), contextUnitId: await unitOf(seed, item.id) });
    expect(r).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(await currentIncludes(seed, item.id)).toEqual([]);
  });

  it("a grants READ ERROR on a protected target is an ERROR (not a settled refusal, not success)", async () => {
    const seed = await converged();
    const item = await ingest(seed, { path: "r.md", body: "r", access: "team", project: "src" });
    const s = await sys(seed);
    const unitId = await unitOf(seed, item.id);
    const failing = transactionDecoratedDb(db(), (bound: DbClient) => ({
      from(t: string) {
        if (t !== "project_groups") return bound.from(t);
        const broken = {
          select: () => broken,
          eq: () => broken,
          in: () => broken,
          then: (res: (v: unknown) => unknown) => res({ data: null, error: { message: "grants unreadable" } }),
        };
        return broken as unknown as ReturnType<DbClient["from"]>;
      },
      rpc: bound.rpc.bind(bound),
    } as DbClient));
    const r = await ensureIncludeMembership(failing, seed.teamId, { projectId: s.general, contextUnitId: unitId });
    expect(r.ok).toBe(false);
    expect(r.refused, "an unreadable grant set is an error, never a settled refusal").not.toBe(true);
    expect(r.error).toMatch(/system-integrity/);
    expect(await currentIncludes(seed, item.id)).toEqual([]);
  });
});

describe("TIERRET-1 AC-09 — protected targets with an UNSANCTIONED grant refuse in both directions (N2)", () => {
  it("General with a forbidden CUSTOM grant: backfill refuses the team item atomically", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const vendors = await createGroup(db(), seed.teamId, `vendors-${randomUUID().slice(0, 6)}`, "Vendors", seed.memberId);
    await plantEdge(seed, s.general, vendors.groupId!);
    const item = await ingest(seed, { path: "g.md", body: "g", access: "team", project: "src" });
    const r = await backfillTeamContext(db(), seed.teamId);
    expect(r.ok, "a forbidden edge on the target is a refusal the sweep must surface").toBe(false);
    expect(r.error).toMatch(/system-integrity/);
    expect(await currentIncludes(seed, item.id), "nothing placed into the corrupted General").not.toContain(s.general);
  });

  it("General with the builtin External edge (A13-08 shape): the narrowing push rolls back", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "n.md", body: "n", access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await plantEdge(seed, s.general, await builtinGroup(seed, "external"));
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    await expect(
      ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "t", frontmatter: {}, path: "n.md", body: "n", content_sha256: sha("n") }, "team", undefined, "team")
    ).rejects.toThrow(/system-integrity/);
    const { data } = await db().from("items").select("access").eq("id", item.id).single();
    expect((data as { access: string }).access, "the refused narrowing rolled back").toBe("external");
    expect(await currentIncludes(seed, item.id)).toEqual([s.externalShared]);
  });

  it("external-shared with a forbidden custom grant: the team→external WIDENING push rolls back", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "w.md", body: "w", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    expect(await currentIncludes(seed, item.id)).toEqual([s.general]);
    const vendors = await createGroup(db(), seed.teamId, `vendors-${randomUUID().slice(0, 6)}`, "Vendors", seed.memberId);
    await plantEdge(seed, s.externalShared, vendors.groupId!);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    await expect(
      ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "t", frontmatter: {}, path: "w.md", body: "w", content_sha256: sha("w") }, "external", undefined, "team")
    ).rejects.toThrow(/system-integrity/);
    const { data } = await db().from("items").select("access").eq("id", item.id).single();
    expect((data as { access: string }).access, "widening refused: label unchanged").toBe("team");
    expect(await currentIncludes(seed, item.id), "membership unchanged").toEqual([s.general]);
  });

  it("external-shared with a forbidden SINGLETON (person) grant refuses widening too", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "p.md", body: "p", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const { data: single } = await db().from("groups").insert({ team_id: seed.teamId, slug: `person-${randomUUID().slice(0, 8)}`, name: "Person", is_builtin: false, person_member_id: seed.memberId }).select("id").single();
    await plantEdge(seed, s.externalShared, (single as { id: string }).id);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    await expect(
      ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "t", frontmatter: {}, path: "p.md", body: "p", content_sha256: sha("p") }, "external", undefined, "team")
    ).rejects.toThrow(/system-integrity/);
    expect(await currentIncludes(seed, item.id)).toEqual([s.general]);
  });

  it("a CLEAN team keeps converging both directions (positive control for the stricter gate)", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "ok.md", body: "ok", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    await ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "t", frontmatter: {}, path: "ok.md", body: "ok", content_sha256: sha("ok") }, "external", undefined, "team");
    expect(await currentIncludes(seed, item.id)).toEqual([s.externalShared]);
    await ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "t", frontmatter: {}, path: "ok.md", body: "ok", content_sha256: sha("ok") }, "team", undefined, "team");
    expect(await currentIncludes(seed, item.id)).toEqual([s.general]);
  });
});

/**
 * Code review 1 LOW-2 — spec §3: "Existing reconciliation may re-copy a stale unit audience from that
 * locked item inside the same transaction; otherwise a mismatching mirror is refused before membership
 * mutation." The writer used to READ the mirror and ignore it, so a stale mirror on an ordinary target
 * (or the reverse direction on a protected one) still mutated membership.
 */
describe("TIERRET-1 AC-09 — a mismatching unit mirror is refused before membership mutation (LOW-2)", () => {
  async function initiativeOf(seed: Seed): Promise<string> {
    const { data } = await db().from("projects").insert({ team_id: seed.teamId, slug: `mm-${randomUUID().slice(0, 6)}`, name: "MM", kind: "initiative" }).select("id").single();
    return (data as { id: string }).id;
  }
  async function plantMirror(seed: Seed, unitId: string, audience: "team" | "external"): Promise<void> {
    const { error } = await db().from("project_context_units").update({ audience }).eq("team_id", seed.teamId).eq("id", unitId);
    expect(error, "mirror-drift fixture must apply").toBeNull();
  }

  it.each([
    { item: "team" as const, mirror: "external" as const },
    { item: "external" as const, mirror: "team" as const },
  ])("a $item item with a stale $mirror mirror is refused (system-integrity) on an ORDINARY target, with no membership written; a matching mirror is then admitted", async ({ item: access, mirror }) => {
    const seed = await converged();
    const item = await ingest(seed, { path: `mm-${access}.md`, body: `mm ${access}`, access, project: "src" });
    const initiative = await initiativeOf(seed);
    const unitId = await unitOf(seed, item.id); // reconciles the mirror first — the drift is planted after
    await plantMirror(seed, unitId, mirror);

    const refused = await ensureIncludeMembership(db(), seed.teamId, { projectId: initiative, contextUnitId: unitId });
    expect(refused).toMatchObject({ ok: false, refused: true, refusalReason: "system-integrity" });
    expect(await currentIncludes(seed, item.id), "no membership mutation on a mismatching mirror").not.toContain(initiative);

    // Matching control: the unit writer re-copies the mirror from the locked item → admitted.
    await unitOf(seed, item.id);
    expect(await ensureIncludeMembership(db(), seed.teamId, { projectId: initiative, contextUnitId: unitId })).toMatchObject({ ok: true, created: true });
    expect(await currentIncludes(seed, item.id)).toContain(initiative);
  });

  it("reconciliation, which re-copies the mirror inside its own transaction, still converges a stale mirror to the routed system project", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "mm-reconcile.md", body: "mm reconcile", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const unitId = await unitOf(seed, item.id);
    await plantMirror(seed, unitId, "external");

    const r = await reconcileItemContext(db(), seed.teamId, item.id);
    expect(r.ok, r.error).toBe(true);
    const { data: unit } = await db().from("project_context_units").select("audience").eq("id", unitId).single();
    expect((unit as { audience: string }).audience, "the mirror was refreshed from the locked item").toBe("team");
    expect(await currentIncludes(seed, item.id)).toContain(s.general);
    expect(await currentIncludes(seed, item.id)).not.toContain(s.externalShared);
  });
});

describe("TIERRET-1 AC-09 — concurrent flips/reconcile still agree after commit", () => {
  it("racing access flips and reconciles leave item, unit and exactly one routed system include in agreement", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "race.md", body: "race", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const push = (access: "team" | "external") =>
      ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "t", frontmatter: {}, path: "race.md", body: "race", content_sha256: sha("race") }, access, undefined, "team").catch(() => null);
    await Promise.all([push("external"), reconcileItemContext(db(), seed.teamId, item.id), push("team"), reconcileItemContext(db(), seed.teamId, item.id), push("external")]);
    await reconcileItemContext(db(), seed.teamId, item.id); // idempotent retry converges

    const { data: it } = await db().from("items").select("access").eq("id", item.id).single();
    const access = (it as { access: "team" | "external" }).access;
    const { data: unit } = await db().from("project_context_units").select("audience").eq("source_item_id", item.id).single();
    expect((unit as { audience: string }).audience, "unit mirrors the locked item").toBe(access);
    const includes = (await currentIncludes(seed, item.id)).filter((p) => p === s.general || p === s.externalShared);
    expect(includes, "exactly the routed system project").toEqual([access === "team" ? s.general : s.externalShared]);
  });
});

describe("TIERRET-1 AC-09 — the ordinary-target widening is visible ONLY through the grant", () => {
  it("a team item in an External-granted initiative is NOT published into General merely because External can reach the initiative", async () => {
    const seed = await converged();
    const s = await sys(seed);
    const item = await ingest(seed, { path: "only.md", body: "only", access: "team", project: "src" });
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `ini-${randomUUID().slice(0, 6)}`, name: "Ini", kind: "initiative" }).select("id").single();
    const initiative = (proj as { id: string }).id;
    const g = await createGroup(db(), seed.teamId, `cl-${randomUUID().slice(0, 6)}`, "Clients", seed.memberId);
    const ext = await externalOnlyHuman(seed);
    expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, ext, seed.memberId)).ok).toBe(true);
    expect((await grantProjectToGroup(db(), seed.teamId, initiative, g.groupId!, seed.memberId)).ok).toBe(true);
    // Fixture custom placement: close the automatic home, include into the initiative.
    await backfillTeamContext(db(), seed.teamId);
    const unitId = await unitOf(seed, item.id);
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unitId).is("valid_to", null);
    expect((await ensureIncludeMembership(db(), seed.teamId, { projectId: initiative, contextUnitId: unitId })).ok).toBe(true);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: ext }, item.id)).toBe(true);
    expect(await currentIncludes(seed, item.id), "never routed into a system project by the custom placement").toEqual([initiative]);
    expect(await currentIncludes(seed, item.id)).not.toContain(s.externalShared);
  });
});
