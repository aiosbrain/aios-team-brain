import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { ensureIncludeMembership } from "@/lib/projects/context/memberships";
import { countUnrepairable, selectCandidateItemIds } from "@/lib/projects/context/backfill-candidates";
import { visibleItemIds } from "@/lib/access/enforce";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import type { DbClient } from "@/lib/db/types";

// EXCLSHADOW-1 ACs (docs/design/exclshadow1-repair.md): the exclude-shadow — a current
// exclude in the item's target SYSTEM project — stops masquerading as convergence and, for
// mode='auto' ONLY, is repaired close-first. Explicit excludes are an operator's recorded
// decision (classification invariant 3) and are never auto-repaired. Shadows are planted by
// raw SQL — the single writer cannot mint them.

async function unitOf(seed: Seed, itemId: string): Promise<string> {
  const { data } = await db().from("project_context_units").select("id").eq("team_id", seed.teamId).eq("source_item_id", itemId).single();
  return data!.id as string;
}

async function systemProject(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("kind", "system").eq("slug", slug).single();
  return data!.id as string;
}

/** Close the current row on (project, unit) and plant a current EXCLUDE of the given mode. */
async function plantShadow(seed: Seed, projectId: string, unitId: string, mode: string): Promise<void> {
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("team_id", seed.teamId).eq("project_id", projectId).eq("context_unit_id", unitId).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId, project_id: projectId, context_unit_id: unitId,
    decision: "exclude", mode, method: "manual",
  });
  expect(error).toBeNull();
}

const currentRows = async (seed: Seed, projectId: string, unitId: string) => {
  const { data } = await db().from("project_context_memberships")
    .select("id, decision, mode, method")
    .eq("team_id", seed.teamId).eq("project_id", projectId).eq("context_unit_id", unitId).is("valid_to", null);
  return (data ?? []) as { id: string; decision: string; mode: string; method: string }[];
};

const visOf = async (seed: Seed) => {
  const v = await visibleItemIds(db(), { teamId: seed.teamId, memberId: seed.memberId });
  expect(v.error).toBeFalsy();
  return v.ids;
};

describe("EXCLSHADOW-1 — the auto exclude-shadow repairs; explicit excludes survive every automatic run", () => {
  it("round trip: auto shadow → item dark → one reconcile repairs close-first (method pinned) → item visible; idempotent; the FORCE shadow refuses loudly and stays; close-first is index-forced; no-widening still refuses first", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "a.md", body: "shadowed body", access: "team", project: "src" });
    const forced = await ingest(seed, { path: "b.md", body: "forced body", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, GENERAL_SLUG);
    const unit = await unitOf(seed, item.id);
    const forcedUnit = await unitOf(seed, forced.id);

    expect((await visOf(seed)).has(item.id), "pre-state: included and visible").toBe(true);

    // The AUTO shadow: dark to everyone, then repaired by ONE reconcile.
    await plantShadow(seed, general, unit, "auto");
    expect((await visOf(seed)).has(item.id), "the shadow makes the item invisible to the enforced read").toBe(false);
    const r = await reconcileItemContext(db(), seed.teamId, item.id);
    expect(r.ok).toBe(true);
    const after = await currentRows(seed, general, unit);
    expect(after.length, "exactly one current row (the index invariant)").toBe(1);
    expect(after[0].decision).toBe("include");
    expect(after[0].method, "the repair is legible in the table's own history").toBe("exclude_shadow_repair");
    expect((await visOf(seed)).has(item.id), "repaired → visible again").toBe(true);

    // Idempotent: a second pass changes nothing.
    const repairedId = after[0].id;
    expect((await reconcileItemContext(db(), seed.teamId, item.id)).ok).toBe(true);
    const again = await currentRows(seed, general, unit);
    expect(again.length).toBe(1);
    expect(again[0].id, "the second pass did not touch the repaired row").toBe(repairedId);

    // The FORCE shadow: an operator's recorded decision — refused LOUDLY, never repaired,
    // never a silent created:false success (classification invariant 3).
    await plantShadow(seed, general, forcedUnit, "force_exclude");
    const rf = await reconcileItemContext(db(), seed.teamId, forced.id);
    expect(rf.ok, "an explicit exclude is a loud refusal, not convergence").toBe(false);
    const forcedRows = await currentRows(seed, general, forcedUnit);
    expect(forcedRows.length).toBe(1);
    expect(forcedRows[0].decision, "the explicit exclude SURVIVES the automatic run").toBe("exclude");
    expect((await visOf(seed)).has(forced.id), "and the item stays dark — deliberate invisibility is an explicit act").toBe(false);

    // ORDER: the partial index refuses an include beside the current exclude — close-first is
    // mechanism, not convention.
    const { error: collision } = await db().from("project_context_memberships").insert({
      team_id: seed.teamId, project_id: general, context_unit_id: forcedUnit,
      decision: "include", mode: "auto", method: "ingestion_project",
    });
    expect(collision, "pcm_current_idx refuses a second current row").toBeTruthy();

    // No-widening still gates FIRST: a team-audience unit refused from the external-visible
    // project before any probe/repair could run.
    const extShared = await systemProject(seed, EXTERNAL_SHARED_SLUG);
    const nw = await ensureIncludeMembership(db(), seed.teamId, { projectId: extShared, contextUnitId: unit });
    expect(nw.ok).toBe(false);
    expect(nw.refused, "the tier gate refuses before the shadow machinery").toBe(true);
  });

  it("writer-direct arms: an initiative-project exclude is never repaired (kind scope); the race-loser converges only on an include", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "c.md", body: "initiative body", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const unit = await unitOf(seed, item.id);

    // KIND scope, direct (the design round's H1 — through reconcile the target is always a
    // system project, so this arm must call the writer itself).
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `init-${randomUUID().slice(0, 8)}`, name: "I", kind: "initiative" }).select("id").single();
    const initiative = proj!.id as string;
    await db().from("project_context_memberships").insert({
      team_id: seed.teamId, project_id: initiative, context_unit_id: unit,
      decision: "exclude", mode: "auto", method: "manual",
    });
    const r = await ensureIncludeMembership(db(), seed.teamId, { projectId: initiative, contextUnitId: unit });
    expect(r.ok, "a non-system exclude gets the loud refusal, not a repair").toBe(false);
    const rows = await currentRows(seed, initiative, unit);
    expect(rows.length).toBe(1);
    expect(rows[0].decision, "the initiative exclude is untouched (a curation surface)").toBe("exclude");

    // RACE-LOSER branch (H2): make the FIRST probe miss via a wrapping client, so the real
    // insert collides with a concurrently-planted exclude and the loser must branch on what
    // it finds — converged ONLY on an include; an exclude is the same loud refusal.
    const general = await systemProject(seed, GENERAL_SLUG);
    await plantShadow(seed, general, unit, "force_exclude");
    let intercepted = false;
    const real = db();
    const raceDb = {
      from(table: string) {
        const chain = real.from(table);
        if (table === "project_context_memberships" && !intercepted) {
          // Intercept ONLY the first probe select — return "no current row" so the code
          // proceeds to the insert, which then really collides with the planted exclude.
          const origSelect = chain.select.bind(chain);
          return {
            ...chain,
            select: (...args: unknown[]) => {
              intercepted = true;
              const q = (origSelect as (...a: unknown[]) => unknown)(...args) as Record<string, unknown>;
              const stub = {
                eq: () => stub,
                is: () => stub,
                maybeSingle: async () => ({ data: null, error: null }),
              };
              void q;
              return stub;
            },
          };
        }
        return chain;
      },
    } as unknown as DbClient;
    const loser = await ensureIncludeMembership(raceDb, seed.teamId, { projectId: general, contextUnitId: unit });
    expect(loser.ok, "the race-loser must not read a racing exclude as convergence").toBe(false);
    expect(loser.created).not.toBe(false);
    const finalRows = await currentRows(seed, general, unit);
    expect(finalRows.length).toBe(1);
    expect(finalRows[0].decision, "the planted exclude survives the race").toBe("exclude");
  });

  it("the sweep: auto shadows are selected and healed; force shadows and retracted units stay carved out and counted (strict zero when clean)", async () => {
    const seed = await seedTeam();
    const auto = await ingest(seed, { path: "d.md", body: "auto body", access: "team", project: "src" });
    const force = await ingest(seed, { path: "e.md", body: "force body", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, GENERAL_SLUG);
    await plantShadow(seed, general, await unitOf(seed, auto.id), "auto");
    await plantShadow(seed, general, await unitOf(seed, force.id), "force_exclude");

    const page = await selectCandidateItemIds(seed.teamId, { limit: 100 });
    expect(page.ids, "the AUTO shadow is selectable (the slice-A carve-out inverted)").toContain(auto.id);
    expect(page.ids, "the FORCE shadow stays carved out (unrepairable by design)").not.toContain(force.id);

    const counts = await countUnrepairable(seed.teamId);
    expect(counts, "the count must be readable, not error-null").not.toBeNull();
    expect(counts!.excludeShadows, "only the UNREPAIRABLE (explicit) shadow is counted").toBe(1);
    expect(counts!.retractedUnits).toBe(0);

    // Heal the auto shadow through the sweep's own reconcile, then the counter is STRICTLY
    // zero once the force shadow is manually resolved (raw close — the operator path).
    expect((await reconcileItemContext(db(), seed.teamId, auto.id)).ok).toBe(true);
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId).eq("project_id", general).eq("context_unit_id", await unitOf(seed, force.id)).is("valid_to", null);
    expect((await reconcileItemContext(db(), seed.teamId, force.id)).ok).toBe(true);
    const clean = await countUnrepairable(seed.teamId);
    expect(clean).toEqual({ excludeShadows: 0, retractedUnits: 0 });
  });
});
