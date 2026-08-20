import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { runSql } from "@/lib/db/pg/pool";
import { projectItemsToGraph, ProjectionAbortError } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import { FakeGraphiti, client } from "./fake-graphiti";
import type { DbClient } from "@/lib/db/types";

// TICKFIT-2 ACs (docs/design/tickfit2-graph-delta.md): the batched ledger read — ONE
// graph_episodes select per page replaces the per-item probe (the stage's entire measured
// 10.5-minute cost), under the page-snapshot contract; rows determinized by group_id (fixing
// the previously-undefined fan-out budget order); a failed batch read falls back per-page,
// VISIBLY, and the counter survives the abort merge.

/** Wrap the db so graph_episodes selects are observable/controllable: `mode.countBatch`
 *  counts page-batch reads (the `.in("source_id", …)` shape); `mode.failBatch` fails them;
 *  `mode.failProbeFor` fails the PER-ROW probe (`.eq("source_id", id)`) for one item. */
function wrapDb(mode: { countBatch?: { n: number }; failBatch?: boolean; failProbeFor?: string }): DbClient {
  const real = db();
  const failThenable = { then: (res: (v: unknown) => void) => res({ data: null, error: { message: "induced ledger read failure" } }) };
  const proxyChain = (chain: Record<string, unknown>): unknown =>
    new Proxy(chain, {
      get(target, prop, receiver) {
        if (prop === "in") {
          return (col: string, vals: unknown[]) => {
            if (col === "source_id") {
              if (mode.failBatch) return failThenable;
              if (mode.countBatch) mode.countBatch.n++;
            }
            return proxyChain((target.in as (c: string, v: unknown[]) => Record<string, unknown>)(col, vals));
          };
        }
        if (prop === "eq") {
          return (col: string, val: unknown) => {
            if (col === "source_id" && mode.failProbeFor && val === mode.failProbeFor) return failThenable;
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

    // Converged page, batched: exactly ONE graph_episodes batch read for 5 items.
    const counter = { n: 0 };
    const counted = await projectItemsToGraph(wrapDb({ countBatch: counter }), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });
    expect(counted.scanned).toBe(5);
    expect(counted.skipped).toBe(5);
    expect(counter.n, "the ROUND-TRIP pin: one batched read per page, zero per-item probes").toBe(1);

    // Forced fallback: the batch read fails → per-item probes complete the page correctly,
    // visibly, and the summary is otherwise identical (the trace-equivalence pin).
    const fallback = await projectItemsToGraph(wrapDb({ failBatch: true }), { teamId: seed.teamId, teamSlug: "t", client: client(fake) });
    expect(fallback.probeFallbackPages, "the fallback is counted, never silent").toBe(1);
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
    for (const attempt of [1, 2]) {
      const pushesBefore = fake.pushes.filter((p) => groups.includes(p.groupId)).length;
      const s = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: "t", client: client(fake), fanoutPushBudget: 1 });
      const newPushes = fake.pushes.filter((p) => groups.includes(p.groupId)).slice(pushesBefore);
      expect(newPushes.length, `attempt ${attempt}: budget 1 serves exactly one group`).toBeGreaterThanOrEqual(1);
      expect(newPushes[0].groupId, `attempt ${attempt}: the sorted-first group wins, deterministically`).toBe("g-aaa");
      expect(s.fanoutThrottled).toBeGreaterThanOrEqual(1);
      // Reset g-aaa to stale so the next attempt replays the same contest.
      await db().from("graph_episodes").update({ content_sha256: "stale" }).eq("team_id", seed.teamId).eq("source_id", item.id).eq("group_id", "g-aaa");
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
