import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * M9 beyond the two query routes.
 *
 * `resolveAnsweringKeys` throws `copied-staging-no-spend` whenever the central policy denies spend.
 * That is the right BACKSTOP and the wrong first encounter: every eager caller below resolved keys
 * before deciding anything, so a copied staging deployment answered a generic 500 (arcs, arc
 * recompute), a red server action naming nothing (meetings, social, attribution), a queue of
 * recorded FAILED ingest runs (the scheduler's meeting-notes backfill), a permanently degraded LLM
 * health pass (timeline summaries), or a trail of variants marked `failed` as though the model had
 * produced something unusable (social generation).
 */

describe("the shared disabled-feature vocabulary", () => {
  it("is enabled outside copy scope and disabled inside it", async () => {
    const { modelFeaturesEnabled } = await import("@/lib/staging/model-features");
    expect(modelFeaturesEnabled("background")).toBe(true);
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    expect(modelFeaturesEnabled("background")).toBe(false);
    expect(modelFeaturesEnabled("interactive-query")).toBe(false);
  });

  it("names an unimplemented budgeted opt-in distinctly from a plain default", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    const { modelFeatureVerdict } = await import("@/lib/staging/model-features");
    expect(modelFeatureVerdict("interactive-query").posture).toBe("disabled");
    vi.stubEnv("STAGING_QUERY_LLM_ENABLED", "true");
    vi.stubEnv("STAGING_QUERY_LLM_BUDGET_USD", "5");
    const verdict = modelFeatureVerdict("interactive-query");
    expect(verdict.posture).toBe("unsupported-budgeted-mode");
    expect(verdict.enabled).toBe(false);
    expect(verdict.message).toContain("staging-budgeted-interactive-query-unsupported");
  });

  it("returns an action-shaped result, not a thrown error", async () => {
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    const { modelDisabledResult, MODEL_DISABLED_CODE } = await import("@/lib/staging/model-features");
    expect(modelDisabledResult("background")).toMatchObject({ ok: false, code: MODEL_DISABLED_CODE });
  });
});

describe("the arcs panel degrades to its cached rows instead of failing", () => {
  it("synthesizes nothing and warms nothing when there is no model", async () => {
    // `null` keys is the explicit no-model signal. The observable is that neither the inline
    // synthesis nor the background warm is attempted — a queue of refreshes that must fail is not
    // a degradation, and each one would have been a provider call this deployment forbids.
    const readArcCache = vi.fn(async () => null);
    const getArcs = vi.fn();
    const schedulePartitionRefresh = vi.fn(() => true);
    vi.doMock("@/lib/graph/arc-cache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/arc-cache")>()),
      readArcCache, arcTtlMs: () => 1000,
    }));
    vi.doMock("@/lib/graph/arcs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/arcs")>()),
      getArcs, schedulePartitionRefresh,
    }));
    vi.doMock("@/lib/graph/extraction-health", () => ({ latestPushByGroup: async () => new Map() }));

    const { getFusedArcs } = await import("@/lib/graph/arc-fusion");
    const panel = await getFusedArcs({} as never, "team", "slug", ["one", "two"], null);
    expect(getArcs).not.toHaveBeenCalled();
    expect(schedulePartitionRefresh).not.toHaveBeenCalled();
    expect(panel).toMatchObject({ arcs: [], warmScheduled: 0, covered: 0, total: 2 });
  });

  it("still synthesizes and warms when a model IS available", async () => {
    // The negative control for the case above: without it, "did nothing" would be
    // indistinguishable from a mock that was never wired up.
    const readArcCache = vi.fn(async () => null);
    const getArcs = vi.fn(async () => ({ arcs: [], freshness: { computedAt: Date.now(), degraded: false, stale: false } }));
    const schedulePartitionRefresh = vi.fn(() => true);
    vi.doMock("@/lib/graph/arc-cache", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/arc-cache")>()),
      readArcCache, arcTtlMs: () => 1000,
    }));
    vi.doMock("@/lib/graph/arcs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/arcs")>()),
      getArcs, schedulePartitionRefresh,
    }));
    vi.doMock("@/lib/graph/extraction-health", () => ({ latestPushByGroup: async () => new Map() }));

    const { getFusedArcs } = await import("@/lib/graph/arc-fusion");
    await getFusedArcs({} as never, "team", "slug", ["one", "two"], {} as never);
    expect(getArcs).toHaveBeenCalledTimes(1);
    expect(schedulePartitionRefresh).toHaveBeenCalled();
  });
});

/**
 * The remaining callers are server actions, a route and two background loops. Reaching their gate
 * at runtime needs a session, a team, membership and (for the loops) a scheduler tick, so what is
 * pinned here is the ORDERING in the source — which is the whole correction, and which is stated as
 * an inequality because "the gate exists somewhere in the file" is exactly what was already true of
 * the throw it replaces.
 */
describe("every eager caller decides BEFORE it resolves keys", () => {
  const callers = [
    { path: "app/api/brain/arcs/route.ts", gate: "modelFeatureVerdict()", after: '"not a member of this team"' },
    { path: "app/api/brain/arcs/recompute/route.ts", gate: "modelFeatureVerdict()", after: '"not a member of this team"' },
    { path: "app/t/[team]/meetings/actions.ts", gate: 'modelFeaturesEnabled("background")', after: '"not a member of this team"' },
    { path: "app/t/[team]/social/actions.ts", gate: 'modelFeaturesEnabled("background")', after: '"admins only"' },
    { path: "app/t/[team]/admin/attribution/actions.ts", gate: 'modelFeaturesEnabled("background")', after: '"admins only"' },
    { path: "lib/dashboard/timeline-summary.ts", gate: 'modelFeaturesEnabled("background")', after: null },
    { path: "lib/ingest/scheduler.ts", gate: 'modelFeaturesEnabled("background")', after: null },
    { path: "lib/social/generate.ts", gate: 'modelFeaturesEnabled("background")', after: null },
  ];

  for (const caller of callers) {
    it(`${caller.path} gates before its first eager resolution`, () => {
      const source = readFileSync(caller.path, "utf8");
      const gate = source.indexOf(caller.gate);
      expect(gate, `${caller.path} has no gate`).toBeGreaterThan(-1);
      // The FIRST resolution CALL in the file is the one that must be preceded — the import
      // statement is not a call, so the pattern requires an argument.
      const resolver = source.search(/resolve(?:Answering|Provider)Keys\(\s*(?:db|admin|adminClient)/);
      expect(resolver, `${caller.path} resolves no keys`).toBeGreaterThan(-1);
      expect(gate, `${caller.path} resolves keys before deciding`).toBeLessThan(resolver);
    });

    if (caller.after) {
      it(`${caller.path} gates AFTER its authorization check`, () => {
        // A refusal placed before authorization would tell an unauthenticated caller what mode this
        // deployment runs in.
        const source = readFileSync(caller.path, "utf8");
        expect(source.indexOf(caller.gate)).toBeGreaterThan(source.indexOf(caller.after!));
      });
    }
  }

  it("substitutes no placeholder credential anywhere it degrades", () => {
    // "No model" must never become "a model with an empty key", which would fall through to the
    // process environment on the transports that read it.
    for (const caller of callers) {
      const source = readFileSync(caller.path, "utf8");
      expect(source, caller.path).not.toMatch(/keys\s*=\s*\{\s*\}/);
      expect(source, caller.path).not.toMatch(/apiKey:\s*""/);
    }
  });
});
