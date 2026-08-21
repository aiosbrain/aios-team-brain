import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { runSql, getPool } from "@/lib/db/pg/pool";
import { GRAPH_PROJECTION_LOCK_NS } from "@/lib/graph/walk-lock";
import { projectItemsToGraph, ProjectionAbortError } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import { FakeGraphiti, client } from "./fake-graphiti";
import type { DbClient } from "@/lib/db/types";

// TICKFIT-2 ACs (docs/design/tickfit2-graph-delta.md): the batched ledger read — ONE
// graph_episodes select per page replaces the per-item probe (the stage's entire measured
// 10.5-minute cost), under the page-snapshot contract; rows determinized by group_id (fixing
// the previously-undefined fan-out budget order); a failed batch read falls back per-page,
// VISIBLY, and the counter survives the abort merge.

type Counts = { batches: number; probes: number };

/** Wrap the db so graph_episodes selects are observable/controllable: `mode.count` counts
 *  page-batch reads (the `.in("source_id", …)` shape) AND per-item probes (the `.eq("source_id",
 *  id)` shape) separately — "zero per-item probes" must be ASSERTED, not implied by the batch count
 *  (Fable diff review M3: ignoring the prefetch and probing anyway left the batch count at 1);
 *  `mode.failBatch` fails batch reads; `mode.failProbeFor` fails the per-row probe for one item;
 *  `mode.descBatch` serves the batch's rows in DESCENDING group_id order, so the projector's own
 *  group_id sort is the ONLY thing that can make the lexicographically-first group win (M4: with
 *  rows served in whatever order the planner picks, removing the sort could survive). */
function wrapDb(mode: { count?: Counts; failBatch?: boolean; failProbeFor?: string; descBatch?: boolean }): DbClient {
  const real = db();
  const failThenable = { then: (res: (v: unknown) => void) => res({ data: null, error: { message: "induced ledger read failure" } }) };
  const descThenable = (chain: Record<string, unknown>) => ({
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      (chain as unknown as PromiseLike<{ data: { group_id: string }[] | null; error: unknown }>).then((r) => {
        const data = r.data ? [...r.data].sort((a, b) => (a.group_id < b.group_id ? 1 : a.group_id > b.group_id ? -1 : 0)) : r.data;
        res({ ...r, data });
      }, rej),
  });
  const proxyChain = (chain: Record<string, unknown>): unknown =>
    new Proxy(chain, {
      get(target, prop, receiver) {
        if (prop === "in") {
          return (col: string, vals: unknown[]) => {
            if (col === "source_id") {
              if (mode.failBatch) return failThenable;
              if (mode.count) mode.count.batches++;
              if (mode.descBatch) return descThenable((target.in as (c: string, v: unknown[]) => Record<string, unknown>)(col, vals));
            }
            return proxyChain((target.in as (c: string, v: unknown[]) => Record<string, unknown>)(col, vals));
          };
        }
        if (prop === "eq") {
          return (col: string, val: unknown) => {
            if (col === "source_id") {
              if (mode.failProbeFor && val === mode.failProbeFor) return failThenable;
              if (mode.count) mode.count.probes++;
            }
            return proxyChain((target.eq as (c: string, v: unknown) => Record<string, unknown>)(col, val));
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return {
    from(table: string) {
      const chain = real.from(table);
      if (table !== "graph_episodes") return chain;
      return new Proxy(chain as unknown as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (prop === "select") {
            return (...args: unknown[]) => proxyChain((target.select as (...a: unknown[]) => Record<string, unknown>)(...args));
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  } as unknown as DbClient;
}

async function seedCorpus(seed: Seed, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await ingest(seed, { kind: "transcript", path: `t/${i}.md`, body: `transcript body number ${i}`, access: "team", project: "src" });
  }
}

describe("TICKFIT-2 — the batched ledger read (real Postgres, mocked Graphiti)", () => {
  it("a converged page costs ONE ledger read (not one per item); batched and forced-fallback passes are trace-equivalent; the fallback is visible", async () => {
    const seed = await seedTeam();
    await seedCorpus(seed, 5);
    const fake = new FakeGraphiti();
    // First pass: project everything (populates the ledger).
    const first = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });
    expect(first.projected).toBe(5);
    expect(first.probeFallbackPages).toBe(0);

    // Converged page, batched: exactly ONE graph_episodes batch read for 5 items, and ZERO
    // per-item probes (both halves asserted — AC1).
    const count: Counts = { batches: 0, probes: 0 };
    const counted = await projectItemsToGraph(wrapDb({ count }), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });
    expect(counted.scanned).toBe(5);
    expect(counted.skipped).toBe(5);
    expect(count.batches, "the ROUND-TRIP pin: one batched read per page").toBe(1);
    expect(count.probes, "…and zero per-item probes").toBe(0);

    // Forced fallback: the batch read fails → per-item probes (one per item) complete the page
    // correctly, visibly, and the summary is otherwise identical (the trace-equivalence pin).
    const fbCount: Counts = { batches: 0, probes: 0 };
    const fallback = await projectItemsToGraph(wrapDb({ failBatch: true, count: fbCount }), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });
    expect(fallback.probeFallbackPages, "the fallback is counted, never silent").toBe(1);
    expect(fbCount.probes, "the fallback is today's exact shape: one probe per item").toBe(5);
    const strip = (s: Record<string, unknown>) => {
      const { probeFallbackPages, ...rest } = s;
      void probeFallbackPages;
      return rest;
    };
    expect(strip(fallback as unknown as Record<string, unknown>)).toEqual(strip(counted as unknown as Record<string, unknown>));
  });

  it("fan-out budget order is DETERMINIZED by group_id (previously undefined): with budget 1, the lexicographically first group receives the push — twice", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "transcript", path: "t/f.md", body: "fanned transcript body", access: "team", project: "src" });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    await backfillTeamContext(db(), seed.teamId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });

    // Two initiative projects with graph groups, BOTH holding a current include membership of
    // the item's unit (the push side requires the group in the item's ACTIVE target set);
    // two ARMED (deferred=false) fan-out ledger rows with STALE shas — both want a push;
    // budget 1 can serve only one.
    const { data: unit } = await db().from("project_context_units").select("id").eq("team_id", seed.teamId).eq("source_item_id", item.id).single();
    const groups = ["g-aaa", "g-bbb"];
    for (const g of groups) {
      const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `i-${g}-${randomUUID().slice(0, 6)}`, name: g, kind: "initiative" }).select("id").single();
      await runSql("update projects set graph_group_id = $1 where id = $2", [g, proj!.id as string]);
      await db().from("project_context_memberships").insert({
        team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id as string,
        decision: "include", mode: "auto", method: "manual",
      });
      await db().from("graph_episodes").insert({
        team_id: seed.teamId, source_table: "items", source_id: item.id, group_id: g,
        content_sha256: "stale", chunk_shas: [], chunk_config: "2500x40", deferred: false,
      });
    }
    // The batch rows are served g-bbb FIRST (descBatch): only the projector's sort can make
    // g-aaa win, so removing the sort is guaranteed red on BOTH attempts regardless of the planner.
    for (const attempt of [1, 2]) {
      const pushesBefore = fake.pushes.filter((p) => groups.includes(p.groupId)).length;
      const s = await projectItemsToGraph(wrapDb({ descBatch: true }), { teamId: seed.teamId, teamSlug: "t", client: client(fake), fanoutPushBudget: 1 });
      const newPushes = fake.pushes.filter((p) => groups.includes(p.groupId)).slice(pushesBefore);
      expect(newPushes.length, `attempt ${attempt}: budget 1 serves exactly one group`).toBeGreaterThanOrEqual(1);
      expect(newPushes[0].groupId, `attempt ${attempt}: the sorted-first group wins, deterministically`).toBe("g-aaa");
      expect(s.fanoutThrottled).toBeGreaterThanOrEqual(1);
      // Reset g-aaa to stale so the next attempt replays the same contest.
      await db().from("graph_episodes").update({ content_sha256: "stale" }).eq("team_id", seed.teamId).eq("source_id", item.id).eq("group_id", "g-aaa");
    }
  });

  it("a team whose projection lease another instance holds is SKIPPED and COUNTED, nothing walked; once released the same run projects (Codex diff review H1 — the deploy-overlap twin)", async () => {
    const seed = await seedTeam();
    await seedCorpus(seed, 3);
    const fake = new FakeGraphiti();
    // The "other instance": a separate session holding the team's advisory lease.
    const twin = await getPool().connect();
    try {
      const { rows } = await twin.query<{ ok: boolean }>("select pg_try_advisory_lock($1::int, hashtext($2::text)) as ok", [GRAPH_PROJECTION_LOCK_NS, seed.teamId]);
      expect(rows[0].ok).toBe(true);

      const lockedOut = await runGraphProjection({ teamId: seed.teamId, client: client(fake) });
      expect(lockedOut.lockedOut, "the lock-out is counted, never silent").toBe(1);
      expect(lockedOut.scanned, "nothing walked under a held lease").toBe(0);
      expect(lockedOut.projected).toBe(0);
      expect(fake.pushes.length, "NO push can race the holder — that is the whole point").toBe(0);
      expect(lockedOut.ok).toBe(true); // a lock-out is a skip, not an error

      await twin.query("select pg_advisory_unlock($1::int, hashtext($2::text))", [GRAPH_PROJECTION_LOCK_NS, seed.teamId]);
    } finally {
      twin.release();
    }
    const after = await runGraphProjection({ teamId: seed.teamId, client: client(fake) });
    expect(after.lockedOut).toBe(0);
    expect(after.projected, "released → the same corpus projects").toBe(3);
    // And the runner RELEASED its own lease: the twin can take it again.
    const probe = await getPool().connect();
    try {
      const { rows } = await probe.query<{ ok: boolean }>("select pg_try_advisory_lock($1::int, hashtext($2::text)) as ok", [GRAPH_PROJECTION_LOCK_NS, seed.teamId]);
      expect(rows[0].ok, "the runner's lease is released after the pass (a leaked session lock would lock the team out forever)").toBe(true);
      await probe.query("select pg_advisory_unlock($1::int, hashtext($2::text))", [GRAPH_PROJECTION_LOCK_NS, seed.teamId]);
    } finally {
      probe.release();
    }
  });

  it("an aborted run still reports its fallbacks (the runner merge pin): batch fails AND one per-row probe fails → ok:false with probeFallbackPages ≥ 1", async () => {
    const seed = await seedTeam();
    await seedCorpus(seed, 3);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });
    const { data: anyItem } = await db().from("items").select("id").eq("team_id", seed.teamId).limit(1).single();

    // The page's batch read fails (fallback engaged), then one item's per-row probe fails →
    // ProjectionAbortError carrying the partial summary WITH the fallback counter.
    const wrapped = wrapDb({ failBatch: true, failProbeFor: anyItem!.id as string });
    await expect(projectItemsToGraph(wrapped, { teamId: seed.teamId, teamSlug: "t", client: client(fake) })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProjectionAbortError && e.partial.probeFallbackPages === 1
    );

    // And through the RUNNER: the abort merge carries the counter into the run summary.
    const summary = await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: wrapped });
    expect(summary.ok).toBe(false);
    expect(summary.probeFallbackPages, "the abort merge must not under-report fallbacks").toBeGreaterThanOrEqual(1);
  });
});
