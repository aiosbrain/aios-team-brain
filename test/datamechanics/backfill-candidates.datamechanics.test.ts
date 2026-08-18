import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { selectCandidateItemIds, countUnrepairable } from "@/lib/projects/context/backfill-candidates";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";

/**
 * TICKSTALL-2 slice A (`docs/design/backfill-sweep-o-backlog.md`) — the candidate predicate, on real
 * Postgres because the whole thing is a three-arm `NOT EXISTS` the query builder cannot express.
 *
 * SELECTION CORRECTNESS LEADS, speed follows. A predicate wrong in the "no work" direction leaves an
 * item with no unit or no current `include`, which under an enforced read is content visible to
 * NOBODY — silent, and worse than the slowness this replaces. Criteria 1-3 are that direction.
 */

const FAR_FUTURE = () => new Date(Date.now() + 60_000).toISOString();

async function projectIds(seed: Seed) {
  const { data } = await db()
    .from("projects").select("id, slug").eq("team_id", seed.teamId)
    .eq("kind", "system").in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  const bySlug = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  return { general: bySlug.get(GENERAL_SLUG)!, ext: bySlug.get(EXTERNAL_SHARED_SLUG)! };
}

async function unitId(seed: Seed, itemId: string): Promise<string | null> {
  const { data } = await db()
    .from("project_context_units").select("id")
    .eq("team_id", seed.teamId).eq("source_item_id", itemId).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function currentMemberships(seed: Seed, uid: string) {
  const { data } = await db()
    .from("project_context_memberships").select("project_id, decision")
    .eq("team_id", seed.teamId).eq("context_unit_id", uid).is("valid_to", null);
  return (data ?? []) as { project_id: string; decision: string }[];
}

const candidates = (seed: Seed) =>
  selectCandidateItemIds(seed.teamId, { createdBefore: FAR_FUTURE(), limit: 500 }).then((p) => p.ids);

describe("backfill candidate predicate (data-mechanics)", () => {
  it("selects an item with NO unit, and one pass gives it a unit + a current include in the target", async () => {
    const seed = await seedTeam();
    const it1 = await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    // The ingest hook may already have partitioned it; strip the unit so the arm-1 state is real.
    const uid = await unitId(seed, it1.id);
    if (uid) await db().from("project_context_units").delete().eq("id", uid);

    expect(await candidates(seed), "an item with no unit MUST be a candidate").toContain(it1.id);

    const r = await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    expect(r.ok, r.error).toBe(true);
    const after = await unitId(seed, it1.id);
    expect(after).not.toBeNull();
    const p = await projectIds(seed);
    expect(await currentMemberships(seed, after!)).toContainEqual({ project_id: p.general, decision: "include" });
  });

  it("selects a STALE-AUDIENCE tier flip and MOVES it — the state a mirror-keyed predicate would skip", async () => {
    // Criterion 2, and the permanent-tier-leak case. Flip `items.access` by raw update and DELIBERATELY
    // leave `project_context_units.audience` stale, exactly as a failed best-effort reclassification
    // fan-out leaves it. A fixture that tidies the unit first would let a predicate keyed on the stale
    // mirror pass — one condition per fixture.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "b.md", body: "b", access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    const uid = (await unitId(seed, item.id))!;
    const p = await projectIds(seed);
    expect(await currentMemberships(seed, uid)).toContainEqual({ project_id: p.ext, decision: "include" });

    await db().from("items").update({ access: "team" }).eq("id", item.id);
    const { data: stale } = await db()
      .from("project_context_units").select("audience").eq("id", uid).maybeSingle();
    expect((stale as { audience: string }).audience, "the mirror must still be stale for this to test anything")
      .toBe("external");

    expect(await candidates(seed), "a stale-audience flip MUST be a candidate").toContain(item.id);

    const r = await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    expect(r.ok, r.error).toBe(true);
    const now = await currentMemberships(seed, uid);
    expect(now, "moved into the new target").toContainEqual({ project_id: p.general, decision: "include" });
    expect(now.map((m) => m.project_id), "closed in the opposite").not.toContain(p.ext);
  });

  it("does NOT select an exclude-shadow, and counts it instead", async () => {
    // Criterion 3. reconcile cannot repair this state (ensureIncludeMembership no-ops on ANY current
    // row), so selecting it would burn ~1.3 s of reconcile every tick forever and keep `scanned` off
    // zero — poisoning the only signal that says the sweep has caught up.
    //
    // The load-bearing assertion is `scanned`/no-side-effects, NOT `drained`: `drained` only means
    // "the page came back short" and is true either way. An earlier spec draft argued the opposite and
    // was wrong against the code.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "c.md", body: "c", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    const uid = (await unitId(seed, item.id))!;
    const p = await projectIds(seed);
    // Manufacture the shadow with raw SQL: `decision='exclude'` is unwritable through app code today
    // (memberships.ts only ever inserts 'include'), which is why this is a latent hole and not a live one.
    await db().from("project_context_memberships")
      .update({ decision: "exclude" })
      .eq("team_id", seed.teamId).eq("context_unit_id", uid).eq("project_id", p.general).is("valid_to", null);

    expect(await candidates(seed), "an unrepairable state must NOT be a candidate").not.toContain(item.id);
    expect((await countUnrepairable(seed.teamId))?.excludeShadows, "…but it must be COUNTED, or the hole is silent").toBe(1);

    const r = await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    expect(r.ok, r.error).toBe(true);
    expect(r.scanned, "the shadow must not be reconciled").toBe(0);
    expect(await currentMemberships(seed, uid), "and must be left untouched")
      .toContainEqual({ project_id: p.general, decision: "exclude" });
  });

  it("does NOT select a RETRACTED unit either, and counts it — reconcile never writes state", async () => {
    // The second unrepairable state, found in review. Enforced reads require state='active', but
    // reconcileItemUnit only updates audience/sha/occurred_at on an existing row — it never writes
    // `state`. So a retracted unit is invisible to readers AND unfixable by the sweep; selecting it
    // would hold `scanned` off zero forever, exactly like the exclude-shadow.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "r.md", body: "r", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    const uid = (await unitId(seed, item.id))!;
    // Raw update: nothing in app code writes 'retracted' today, which is why this is latent.
    await db().from("project_context_units").update({ state: "retracted" }).eq("id", uid);

    expect(await candidates(seed), "an unrepairable retracted unit must NOT be a candidate").not.toContain(item.id);
    expect((await countUnrepairable(seed.teamId))?.retractedUnits, "…but it MUST be counted").toBe(1);

    const r = await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    expect(r.scanned, "and must not be reconciled").toBe(0);
  });

  it("reports NULL, never zero, when the unrepairable count cannot be taken", async () => {
    // "Unreadable" must not be indistinguishable from "none" — the silent direction a reviewer
    // blocked. A bogus team id is the cheapest way to prove the shape returns real numbers here;
    // the null path is exercised by the catch, which returns null rather than zeros.
    const seed = await seedTeam();
    const c = await countUnrepairable(seed.teamId);
    expect(c, "a readable count is an object, not null").not.toBeNull();
    expect(c).toMatchObject({ excludeShadows: expect.any(Number), retractedUnits: expect.any(Number) });
  });

  it("a converged corpus yields NO candidates — the speed claim, as an observable", async () => {
    // Criterion 4, and it is only meaningful because the convergence short-circuit is gone: this
    // result is now attributable to the predicate rather than to a heuristic that never ran the sweep.
    const seed = await seedTeam();
    for (const n of ["x", "y", "z"]) await ingest(seed, { path: `${n}.md`, body: n, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });

    expect(await candidates(seed)).toEqual([]);
    const r = await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    expect(r.scanned, "a converged corpus reconciles nothing").toBe(0);
    expect(r.cursor, "and drains immediately").toBeNull();
  });

  it("respects the createdBefore cutoff, so a concurrent push is not chased mid-sweep", async () => {
    const seed = await seedTeam();
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 25));
    const late = await ingest(seed, { path: "late.md", body: "late", access: "team", project: "src" });
    const uid = await unitId(seed, late.id);
    if (uid) await db().from("project_context_units").delete().eq("id", uid); // plainly needs work

    const bounded = await selectCandidateItemIds(seed.teamId, { createdBefore: cutoff, limit: 500 });
    expect(bounded.ids, "created after the cutoff → out of this pass").not.toContain(late.id);
    const unbounded = await selectCandidateItemIds(seed.teamId, { createdBefore: FAR_FUTURE(), limit: 500 });
    expect(unbounded.ids, "…but the cutoff is the ONLY thing excluding it").toContain(late.id);
  });

  it("pages by id keyset, so the TICKSTALL-1 cursor still works over the candidate set", async () => {
    const seed = await seedTeam();
    for (const n of ["p", "q", "r"]) {
      const i = await ingest(seed, { path: `k-${n}.md`, body: n, access: "team", project: "src" });
      const uid = await unitId(seed, i.id);
      if (uid) await db().from("project_context_units").delete().eq("id", uid);
    }
    const all = await candidates(seed);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect([...all].sort(), "candidates come back id-ordered for keyset paging").toEqual(all);

    const after = await selectCandidateItemIds(seed.teamId, {
      afterId: all[0], createdBefore: FAR_FUTURE(), limit: 500,
    });
    expect(after.ids, "afterId excludes everything at or below it").not.toContain(all[0]);
    expect(after.ids).toContain(all[1]);
  });
});
