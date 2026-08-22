import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { closeMembershipInto } from "@/lib/projects/context/memberships";
import { reconcileItemUnit } from "@/lib/projects/context/units";

/**
 * AUDITFIX-4 (docs/design/auditfix4-membership-close-read-errors.md §5).
 *
 * THE RULE: `closeMembershipInto` may report success only when the INTENDED FINAL STATE was
 * established — not merely when its read succeeded. Two review rounds were needed to arrive at that
 * wording, and both times the earlier wording admitted a passing implementation that still let a
 * move silently not-move:
 *
 *   round 1 — "capture the SELECT error" leaves the id-keyed UPDATE untouched, so a replaced row
 *             still yields {ok:true, closed:1} with the replacement left current;
 *   round 2 — "must not return {ok:true, closed:1}" is satisfied by {ok:true, closed:0}, which is
 *             the same defect wearing a different number.
 *
 * So every assertion below is on the OUTCOME (the final membership rows, or ok:false), never on a
 * return shape that happens to differ.
 */

async function systemProject(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id")
    .eq("team_id", seed.teamId).eq("kind", "system").eq("slug", slug).single();
  return (data as { id: string }).id;
}
async function unitOf(seed: Seed, itemId: string): Promise<string> {
  const { data } = await db().from("project_context_units").select("id")
    .eq("team_id", seed.teamId).eq("source_item_id", itemId).single();
  return (data as { id: string }).id;
}
async function currentRows(seed: Seed, projectId: string, unitId: string) {
  const { data } = await db().from("project_context_memberships").select("id, decision, mode")
    .eq("team_id", seed.teamId).eq("project_id", projectId).eq("context_unit_id", unitId).is("valid_to", null);
  return (data ?? []) as { id: string; decision: string; mode: string }[];
}
/** Close whatever is current on (project, unit) and plant a fresh current row — the sanctioned
 *  raw-write pattern this repo's EXCLSHADOW/CLOSEMODE suites already use for concurrency shapes. */
async function plant(seed: Seed, projectId: string, unitId: string, decision: string, mode: string): Promise<void> {
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("team_id", seed.teamId).eq("project_id", projectId).eq("context_unit_id", unitId).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId, project_id: projectId, context_unit_id: unitId, decision, mode, method: "manual",
  });
  expect(error, "fixture plant must insert").toBeNull();
}

/** A client whose Nth matching read fails — for injecting an adapter error at ONE call site. */
function clientWithFailingRead(table: string, opts: { skip?: number } = {}) {
  const real = db();
  let seen = 0;
  const skip = opts.skip ?? 0;
  return new Proxy(real as object, {
    get(target, prop, recv) {
      if (prop !== "from") return Reflect.get(target, prop, recv);
      return (name: string) => {
        const q = (target as { from: (n: string) => unknown }).from(name);
        if (name !== table) return q;
        return new Proxy(q as object, {
          get(qt, qp, qr) {
            const v = Reflect.get(qt, qp, qr);
            if (qp !== "then") return typeof v === "function" ? (...a: unknown[]) => {
              const r = (v as (...x: unknown[]) => unknown).apply(qt, a);
              return r === qt ? qr : r;
            } : v;
            // Awaiting the builder: this is the read. Fail it once past `skip`.
            if (seen++ < skip) return v;
            return (res: (x: unknown) => unknown) => res({ data: null, error: { message: "injected read failure" } });
          },
        });
      };
    },
  }) as ReturnType<typeof db>;
}

describe("AUDITFIX-4: a membership move that did not move must not report success", () => {
  it("AC1: a REPLACED current row makes the close report ok:false — not a cheerful zero", async () => {
    // THE case both earlier drafts admitted. The close classifies row A; a concurrent actor closes A
    // and installs an equally-closable row B; the id-keyed update matches nothing — and B is STILL
    // CURRENT afterwards.
    //
    // The interleaving is made deterministic by feeding the close a STALE classification read: the
    // first read returns A (already replaced), which is exactly the state the function would hold
    // had the replacement landed between its read and its write. Planting B and then calling close
    // normally would NOT reproduce this — the close would simply read and close B, which is why the
    // first version of this test was green by construction.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/a.md", body: "a", access: "team", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, "general");
    const unit = await unitOf(seed, item.id);

    const [rowA] = await currentRows(seed, general, unit);
    expect(rowA, "fixture: one current include to classify").toBeTruthy();

    // The replacement happens: A is closed, equally-closable B becomes current.
    await plant(seed, general, unit, "include", "auto");
    const [rowB] = await currentRows(seed, general, unit);
    expect(rowB.id, "fixture: B is a different row").not.toBe(rowA.id);

    // Now hand the close a client whose FIRST membership read yields the stale A.
    let firstRead = true;
    const stale = new Proxy(db() as object, {
      get(t, prop, recv) {
        if (prop !== "from") return Reflect.get(t, prop, recv);
        return (name: string) => {
          const q = (t as { from: (n: string) => unknown }).from(name);
          if (name !== "project_context_memberships") return q;
          return new Proxy(q as object, {
            get(qt, qp, qr) {
              const v = Reflect.get(qt, qp, qr);
              if (qp !== "then") {
                return typeof v === "function"
                  ? (...a: unknown[]) => {
                      const r = (v as (...x: unknown[]) => unknown).apply(qt, a);
                      return r === qt ? qr : r;
                    }
                  : v;
              }
              if (firstRead) {
                firstRead = false;
                return (res: (x: unknown) => unknown) => res({ data: [rowA], error: null });
              }
              return v;
            },
          });
        };
      },
    }) as ReturnType<typeof db>;

    const res = await closeMembershipInto(stale, seed.teamId, unit, general);
    const finalRows = await currentRows(seed, general, unit);

    // THE OUTCOME. B is still current and still closable, so this move did not move.
    expect(finalRows.some((r) => r.id === rowB.id), "B is still current").toBe(true);
    expect(res.ok, "reporting success while a closable row remains current IS the defect").toBe(false);
  });

  it("AC2: a row that BECOMES a protected exclusion between read and write survives", async () => {
    // The reassertion's own criterion. The row must look CLOSABLE when classified and be PROTECTED
    // when written — otherwise the pre-existing classification filter does all the work and the
    // reassertion is never exercised. (M1 proved that: dropping the reassertion did not redden the
    // first version of this test, because its fixture was protected before the read.)
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/b.md", body: "b", access: "team", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, "general");
    const unit = await unitOf(seed, item.id);

    const [live] = await currentRows(seed, general, unit);
    expect(live, "fixture: one current row").toBeTruthy();

    // It is NOW a human's standing exclusion…
    await db().from("project_context_memberships")
      .update({ decision: "exclude", mode: "force_exclude" })
      .eq("team_id", seed.teamId).eq("id", live.id);

    // …but the close is handed a classification read that still shows it as a closable include.
    let firstRead = true;
    const stale = new Proxy(db() as object, {
      get(t, prop, recv) {
        if (prop !== "from") return Reflect.get(t, prop, recv);
        return (name: string) => {
          const q = (t as { from: (n: string) => unknown }).from(name);
          if (name !== "project_context_memberships") return q;
          return new Proxy(q as object, {
            get(qt, qp, qr) {
              const v = Reflect.get(qt, qp, qr);
              if (qp !== "then") {
                return typeof v === "function"
                  ? (...a: unknown[]) => {
                      const r = (v as (...x: unknown[]) => unknown).apply(qt, a);
                      return r === qt ? qr : r;
                    }
                  : v;
              }
              if (firstRead) {
                firstRead = false;
                return (res: (x: unknown) => unknown) =>
                  res({ data: [{ id: live.id, decision: "include", mode: "auto" }], error: null });
              }
              return v;
            },
          });
        };
      },
    }) as ReturnType<typeof db>;

    await closeMembershipInto(stale, seed.teamId, unit, general);

    const rows = await currentRows(seed, general, unit);
    expect(rows.length, "the human's exclusion must SURVIVE the write").toBe(1);
    expect(rows[0].decision, "still an exclude").toBe("exclude");
    expect(rows[0].mode, "still non-auto — CLOSEMODE-1's protection held").toBe("force_exclude");
  });

  it("AC4: a failed classification READ reports ok:false — it must not read as 'nothing to close'", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/c.md", body: "c", access: "team", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, "general");
    const unit = await unitOf(seed, item.id);

    const faulted = clientWithFailingRead("project_context_memberships");
    const res = await closeMembershipInto(faulted, seed.teamId, unit, general);

    expect(res.ok, "a read that failed is not a close that succeeded").toBe(false);
    if (!res.ok) expect(res.error).toMatch(/read failed/);
    // …and the row is untouched, so the sweep still has something to repair.
    expect((await currentRows(seed, general, unit)).length).toBe(1);
  });

  it("AC8: the uncontended move still closes the opposite membership exactly once", async () => {
    // The regression half. A fix that reports failure more often is not automatically better.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/d.md", body: "d", access: "external", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, "general");
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);

    // Widening placement first, then narrow it back — the full round trip through both orders.
    expect((await currentRows(seed, ext, unit)).length, "external item homes to external-shared").toBe(1);

    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    const r = await reconcileItemContext(db(), seed.teamId, item.id);
    expect(r.ok, r.error).toBe(true);

    expect((await currentRows(seed, general, unit)).length, "now current in General").toBe(1);
    expect((await currentRows(seed, ext, unit)), "and NOT current in external-shared").toEqual([]);
  });

  it("AC9b: a STALE items.access read cannot produce a stale placement — the mirror is one statement", async () => {
    // Round 2's blocker, and Fable's HIGH 1 on the first fix for it.
    //
    // A compare-and-set on the UNIT's audience is NOT sufficient: it binds the write to the mirror
    // while the value written comes from an `items` read one statement earlier, so a reconciler
    // holding a stale `items.access` still wins. The mirror now reads `items` INSIDE the update and
    // the caller routes on the RETURNED value, so the placement is bound to the item version that
    // authorized it. This test injects exactly that stale item read.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/e.md", body: "e", access: "team", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const unit = await unitOf(seed, item.id);

    // The reconciler's FIRST read (items) yields a stale `external`; the row really says `team`.
    let itemsRead = true;
    const staleItem = new Proxy(db() as object, {
      get(t, prop, recv) {
        if (prop !== "from") return Reflect.get(t, prop, recv);
        return (name: string) => {
          const q = (t as { from: (n: string) => unknown }).from(name);
          if (name !== "items") return q;
          return new Proxy(q as object, {
            get(qt, qp, qr) {
              const v = Reflect.get(qt, qp, qr);
              if (qp !== "then") {
                return typeof v === "function"
                  ? (...a: unknown[]) => {
                      const r = (v as (...x: unknown[]) => unknown).apply(qt, a);
                      return r === qt ? qr : r;
                    }
                  : v;
              }
              if (itemsRead) {
                itemsRead = false;
                return (res: (x: unknown) => unknown) =>
                  res({
                    data: { id: item.id, access: "external", content_sha256: "stale", work_at: new Date(0).toISOString() },
                    error: null,
                  });
              }
              return v;
            },
          });
        };
      },
    }) as ReturnType<typeof db>;

    const res = await reconcileItemUnit(staleItem, seed.teamId, item.id);

    // THE PROPERTY: the audience the caller routes on is the item's TRUE access, never the stale read.
    expect(res.ok, res.error).toBe(true);
    expect(res.audience, "routes on the item version that authorized it, not the stale read").toBe("team");

    const { data: after } = await db().from("project_context_units").select("audience")
      .eq("team_id", seed.teamId).eq("id", unit).single();
    expect((after as { audience: string }).audience, "and the row itself was not moved to the stale value").toBe("team");
  });

  it("AC5: a NARROWING move whose SECOND write fails leaves DENIAL, not external exposure", async () => {
    // THE PIN for close-before-open (spec §3a). Fable's HIGH 2: without it the entire `if (narrowing)`
    // branch — "the part that actually removes the exposure" — can be deleted with the whole suite
    // green, because every other test either drives the writers directly or asserts an
    // order-insensitive final state.
    //
    // The property is asserted through visibleItemIds, the access primitive, not through the rows:
    // "still externally readable" is the outcome that matters, and a row-level assertion would pass
    // an implementation that merely rearranged the rows.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/g.md", body: "g", access: "external", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    expect((await currentRows(seed, ext, unit)).length, "starts external-shared").toBe(1);

    // A member whose ONLY path to this item is the external-shared grant.
    const { externalMember } = await import("./helpers");
    const outsider = await externalMember(seed);

    const { visibleItemIds } = await import("@/lib/access/enforce");
    const before = await visibleItemIds(db(), { teamId: seed.teamId, memberId: outsider });
    expect(before.ids.has(item.id), "fixture: externally readable before the narrowing").toBe(true);

    // Narrow it, and fault the SECOND write of the move (the open of General).
    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    let inserts = 0;
    const faultSecondWrite = new Proxy(db() as object, {
      get(t, prop, recv) {
        if (prop !== "from") return Reflect.get(t, prop, recv);
        return (name: string) => {
          const q = (t as { from: (n: string) => unknown }).from(name);
          if (name !== "project_context_memberships") return q;
          return new Proxy(q as object, {
            get(qt, qp, qr) {
              const v = Reflect.get(qt, qp, qr);
              if (qp === "insert") {
                inserts++;
                return () =>
                  new Proxy({}, { get: (_x, k) => (k === "then"
                    ? (res: (x: unknown) => unknown) => res({ data: null, error: { message: "injected insert failure" } })
                    : () => new Proxy({}, { get: (_y, k2) => (k2 === "then"
                        ? (res: (x: unknown) => unknown) => res({ data: null, error: { message: "injected insert failure" } })
                        : undefined) })) });
              }
              return typeof v === "function"
                ? (...a: unknown[]) => {
                    const r = (v as (...x: unknown[]) => unknown).apply(qt, a);
                    return r === qt ? qr : r;
                  }
                : v;
            },
          });
        };
      },
    }) as ReturnType<typeof db>;

    const r = await reconcileItemContext(faultSecondWrite, seed.teamId, item.id);
    expect(r.ok, "the move must report failure when its second write fails").toBe(false);
    expect(inserts, "fixture: the open was actually attempted").toBeGreaterThan(0);

    // THE OUTCOME: the external reader must NOT still be able to read it. Under open-then-close the
    // close never runs, the external-shared include survives, and this assertion fails.
    const after = await visibleItemIds(db(), { teamId: seed.teamId, memberId: outsider });
    expect(after.ids.has(item.id), "a failed narrowing must DENY, never leave external exposure").toBe(false);
  });

  it("AC9d: a NARROWING move does not destroy the old membership when the gate cannot answer", async () => {
    // Close-first is only safe if the target's reachability is known BEFORE the close. With the
    // project_groups read faulted, the item must NOT end up in neither project.
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "m/f.md", body: "f", access: "external", project: "mproj" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const general = await systemProject(seed, "general");
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    expect((await currentRows(seed, ext, unit)).length).toBe(1);

    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    const faulted = clientWithFailingRead("project_groups");
    const r = await reconcileItemContext(faulted, seed.teamId, item.id);

    expect(r.ok, "an undetermined gate must refuse, not proceed").toBe(false);
    const inEither =
      (await currentRows(seed, ext, unit)).length + (await currentRows(seed, general, unit)).length;
    expect(inEither, "the item must be in at least one system project — never neither").toBeGreaterThan(0);
  });
});
