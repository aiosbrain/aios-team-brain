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

  // EXCLSHADOW-1 RE-SPECIFICATION: this arm pinned "an exclude-shadow is unrepairable, so it
  // is never selected" — that contract SPLIT. An EXPLICIT (force/manual mode) exclude keeps
  // exactly the old behavior (unselectable + counted + untouched — classification invariant
  // 3); an AUTOMATIC one is now repairable and IS selected and healed by the sweep. Both
  // directions pinned; the deep repair mechanics live in exclude-shadow-repair.dm.
  it("selects and HEALS an auto exclude-shadow; an explicit one stays unselected, counted, untouched", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "c.md", body: "c", access: "team", project: "src" });
    const forcedItem = await ingest(seed, { path: "c2.md", body: "c2", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    const uid = (await unitId(seed, item.id))!;
    const fuid = (await unitId(seed, forcedItem.id))!;
    const p = await projectIds(seed);
    // Manufacture both shadows with raw SQL (`decision='exclude'` is unwritable through app code).
    await db().from("project_context_memberships")
      .update({ decision: "exclude" }) // mode stays 'auto' — the repairable class
      .eq("team_id", seed.teamId).eq("context_unit_id", uid).eq("project_id", p.general).is("valid_to", null);
    await db().from("project_context_memberships")
      .update({ decision: "exclude", mode: "force_exclude" })
      .eq("team_id", seed.teamId).eq("context_unit_id", fuid).eq("project_id", p.general).is("valid_to", null);

    const selected = await candidates(seed);
    expect(selected, "the AUTO shadow is repairable → selected").toContain(item.id);
    expect(selected, "the EXPLICIT shadow is an operator's decision → never selected").not.toContain(forcedItem.id);
    expect((await countUnrepairable(seed.teamId))?.excludeShadows, "only the unrepairable one is counted").toBe(1);

    const r = await backfillTeamContext(db(), seed.teamId, { createdBefore: FAR_FUTURE() });
    expect(r.ok, r.error).toBe(true);
    expect(r.scanned, "exactly the auto shadow was reconciled").toBe(1);
    expect(await currentMemberships(seed, uid), "the auto shadow HEALED to an include")
      .toContainEqual({ project_id: p.general, decision: "include" });
    expect(await currentMemberships(seed, fuid), "the explicit shadow left untouched")
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

    // …and counted PER ITEM, not per membership row. The count left-joins memberships, so a plain
    // count(*) multiplies: give this unit a second (closed) membership and a row-count would say 2.
    // A one-membership fixture is green either way — the mutation that reverts count(distinct i.id)
    // SURVIVED until this existed.
    const p2 = await projectIds(seed);
    await db().from("project_context_memberships").insert({
      team_id: seed.teamId, project_id: p2.ext, context_unit_id: uid,
      decision: "include", valid_to: new Date().toISOString(),
    });
    expect((await countUnrepairable(seed.teamId))?.retractedUnits, "one ITEM, not one row per membership").toBe(1);

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

  it("a candidate BELOW a legacy cursor waits for the first DRAIN, even with a truncation between", async () => {
    // Criterion 6. A cursor written by the old full-corpus walk still filters `id > afterId`, so a
    // candidate sorting below it is invisible until a pass drains and resets. The bound is "until the
    // first drain", NOT "one tick" — a truncation persists the cursor and extends the wait, which is
    // why this fixture forces one rather than assuming a small corpus hides the difference.
    const seed = await seedTeam();
    const made: string[] = [];
    for (const n of ["a", "b", "c", "d"]) {
      const i = await ingest(seed, { path: `lc-${n}.md`, body: n, access: "team", project: "src" });
      const uid = await unitId(seed, i.id);
      if (uid) await db().from("project_context_units").delete().eq("id", uid);
      made.push(i.id);
    }
    const all = await candidates(seed);
    expect(all.length).toBeGreaterThanOrEqual(4);

    // A legacy cursor sitting ABOVE the lowest candidate.
    const legacy = all[1];
    const below = all[0];
    const above = await selectCandidateItemIds(seed.teamId, {
      afterId: legacy, createdBefore: FAR_FUTURE(), limit: 500,
    });
    expect(above.ids, "the low candidate is invisible while the legacy cursor stands").not.toContain(below);
    expect(above.ids.length, "…but the ones above it are still served").toBeGreaterThan(0);

    // A truncated pass keeps the cursor — the wait is not over after one tick.
    const trunc = await selectCandidateItemIds(seed.teamId, {
      afterId: legacy, createdBefore: FAR_FUTURE(), limit: 1,
    });
    expect(trunc.ids.length).toBe(1);
    expect(trunc.ids, "still not the low one").not.toContain(below);

    // Once a pass DRAINS (short page → cursor reset), the next pass sees the whole set again.
    const drainedPage = await selectCandidateItemIds(seed.teamId, {
      afterId: all[all.length - 1], createdBefore: FAR_FUTURE(), limit: 500,
    });
    expect(drainedPage.ids, "the drain page is short, which is what resets the cursor").toEqual([]);
    const afterReset = await selectCandidateItemIds(seed.teamId, {
      afterId: null, createdBefore: FAR_FUTURE(), limit: 500,
    });
    expect(afterReset.ids, "and then the low candidate is covered").toContain(below);
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
