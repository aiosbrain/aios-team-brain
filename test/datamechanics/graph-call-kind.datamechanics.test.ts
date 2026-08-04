import { describe, expect, it } from "vitest";
import { recordLlmUsage } from "@/lib/costs/llm-usage";
import {
  getGraphSpendByCallKind,
  getGraphSpendByCallKindAndModel,
  getSpendSlices,
  getSpendTotalUsd,
} from "@/lib/metrics/llm-spend";
import { db, seedTeam } from "./helpers";

/**
 * GRAPHCOST-5 — the ledger dimension that makes graph spend attributable.
 * Spec: 2-work/specs/graph-call-kind-attribution.md.
 *
 * This tier because the claims are about what a real Postgres aggregate returns: that `''` and
 * `'unknown'` stay two groups (they mean opposite things), and that adding the column changes no
 * existing total.
 */

const ADMIN = { isAdmin: true as const, memberId: null };

async function usage(
  teamId: string,
  callKind: string | undefined,
  costUsd: number,
  source = "graph",
  model = "qwen/qwen3.7-plus"
) {
  await recordLlmUsage(db(), {
    teamId,
    source: source as "graph",
    provider: "openrouter",
    model,
    inputTokens: 1000,
    outputTokens: 100,
    costUsd,
    estimated: false,
    callKind,
  });
}

describe("graph spend by call kind (real Postgres)", () => {
  it("groups spend by the prompt that made the call", async () => {
    const seed = await seedTeam();
    await usage(seed.teamId, "extract_nodes", 1);
    await usage(seed.teamId, "extract_nodes", 2);
    await usage(seed.teamId, "node_attributes", 0.5);
    await usage(seed.teamId, "dedupe_edges", 0.25);

    const slices = await getGraphSpendByCallKind(db(), seed.teamId, 30, ADMIN);
    const byKind = Object.fromEntries(slices.map((s) => [s.callKind, s]));
    expect(byKind.extract_nodes.costUsd).toBeCloseTo(3, 5);
    expect(byKind.extract_nodes.calls).toBe(2);
    expect(byKind.node_attributes.costUsd).toBeCloseTo(0.5, 5);
    expect(byKind.dedupe_edges.costUsd).toBeCloseTo(0.25, 5);
    expect(slices[0]?.callKind).toBe("extract_nodes"); // ordered by spend
  });

  it("keeps '' (pre-instrumentation history) DISTINCT from 'unknown' (the drift alarm)", async () => {
    const seed = await seedTeam();
    await usage(seed.teamId, undefined, 5); // a row written before this shipped → ''
    await usage(seed.teamId, "unknown", 3); // classified, matched nothing → prompts have drifted

    const slices = await getGraphSpendByCallKind(db(), seed.teamId, 30, ADMIN);
    const kinds = slices.map((s) => s.callKind).sort();
    expect(kinds).toEqual(["", "unknown"]);
    const byKind = Object.fromEntries(slices.map((s) => [s.callKind, s.costUsd]));
    expect(byKind[""]).toBeCloseTo(5, 5);
    expect(byKind.unknown).toBeCloseTo(3, 5);

    // The contrast that makes the point: the generic slice reader folds them into one group by
    // design (correct for model/provider), which is exactly why this read is not that one.
    const folded = await getSpendSlices(db(), seed.teamId, 30, "model", ADMIN);
    expect(folded.length).toBeGreaterThan(0);
  });

  it("scopes to source='graph' — an embeddings row is not a graph call kind", async () => {
    const seed = await seedTeam();
    await usage(seed.teamId, "extract_nodes", 2);
    await usage(seed.teamId, undefined, 7, "embeddings");

    const slices = await getGraphSpendByCallKind(db(), seed.teamId, 30, ADMIN);
    expect(slices.map((s) => s.callKind)).toEqual(["extract_nodes"]);
    expect(slices.reduce((n, s) => n + s.costUsd, 0)).toBeCloseTo(2, 5);
  });

  it("AC4 — adding the dimension changes no existing total", async () => {
    const seed = await seedTeam();
    await usage(seed.teamId, "extract_nodes", 1.5);
    await usage(seed.teamId, undefined, 2.5);
    await usage(seed.teamId, undefined, 4, "embeddings");

    // The pre-existing readers must see exactly what they always did: `source` is untouched and the
    // new column is invisible to them.
    expect(await getSpendTotalUsd(db(), seed.teamId, 30, ADMIN)).toBeCloseTo(8, 5);
    const bySource = Object.fromEntries(
      (await getSpendSlices(db(), seed.teamId, 30, "source", ADMIN)).map((s) => [s.key, s.cost_usd])
    );
    expect(bySource.graph).toBeCloseTo(4, 5);
    expect(bySource.embeddings).toBeCloseTo(4, 5);
  });

  it("a team's kinds are its own", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await usage(a.teamId, "extract_nodes", 1);
    await usage(b.teamId, "dedupe_nodes", 9);

    const slices = await getGraphSpendByCallKind(db(), a.teamId, 30, ADMIN);
    expect(slices.map((s) => s.callKind)).toEqual(["extract_nodes"]);
  });
});

/**
 * GRAPHCOST-7 — the read that VERIFIES small-model routing. Without it, "did the cheap model
 * actually serve those calls?" is unanswerable, and a routing change nobody can verify is a routing
 * change nobody should make.
 */
describe("graph spend by call kind AND model (real Postgres)", () => {
  it("separates the same prompt served by two different models — worked vs did nothing", async () => {
    const seed = await seedTeam();
    // The shape after routing is enabled: the fan-out on the cheap model, extraction on the strong one.
    await usage(seed.teamId, "node_attributes", 0.2, "graph", "cheap/small");
    await usage(seed.teamId, "node_attributes", 0.1, "graph", "cheap/small");
    await usage(seed.teamId, "extract_nodes", 1.0, "graph", "big/extract");

    const rows = await getGraphSpendByCallKindAndModel(db(), seed.teamId, 30, ADMIN);
    const key = (k: string, m: string) => rows.find((r) => r.callKind === k && r.model === m);
    expect(key("node_attributes", "cheap/small")?.calls).toBe(2);
    expect(key("node_attributes", "cheap/small")?.costUsd).toBeCloseTo(0.3, 5);
    expect(key("extract_nodes", "big/extract")?.costUsd).toBeCloseTo(1.0, 5);
    // The failure this read has to catch: routing believed-on but the strong model still serving.
    expect(key("node_attributes", "big/extract")).toBeUndefined();
  });

  it("keeps '' distinct from 'unknown' here too", async () => {
    const seed = await seedTeam();
    await usage(seed.teamId, undefined, 1, "graph", "m");
    await usage(seed.teamId, "unknown", 2, "graph", "m");
    const kinds = (await getGraphSpendByCallKindAndModel(db(), seed.teamId, 30, ADMIN))
      .map((r) => r.callKind)
      .sort();
    expect(kinds).toEqual(["", "unknown"]);
  });
});
