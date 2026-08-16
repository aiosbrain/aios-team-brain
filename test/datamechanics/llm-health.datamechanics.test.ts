import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getLlmHealth } from "@/lib/query/llm-health";

// Spec (answering-model observability): the shared completion primitive records each LLM outcome to
// ingest_runs(source='llm'); getLlmHealth reads the most recent one so a broken answering model shows
// as "degraded" on the dashboard instead of silently blanking Learning. This is the leg that was
// missing when a reasoning model returned empty output.

describe("LLM answering-model health (data-mechanics)", () => {
  it("reports unknown when nothing has been recorded", async () => {
    const seed = await seedTeam();
    const h = await getLlmHealth(seed.teamId);
    expect(h.state).toBe("unknown");
  });

  it("reports degraded with the model + a reasoning-model hint after an empty-output failure", async () => {
    const seed = await seedTeam();
    await recordIngestRun(db(), {
      teamId: seed.teamId,
      source: "llm",
      trigger: "api",
      ok: false,
      errors: ["LLM returned empty content (model=qwen/qwen3.7-plus, finish_reason=length)"],
      meta: { model: "qwen/qwen3.7-plus", task: "arcs" },
      startedAt: Date.now() - 100,
    });

    // A SECOND failure, because since BANNERFLAP-1 one row is not an outage — it is `unstable`, and
    // `degraded` (with the actionable note) requires the failure to repeat. The point of THIS test is
    // the reasoning-model hint, not the threshold, so the fixture is raised to the level that still
    // exercises it rather than the assertion being lowered to whatever the code now returns.
    await recordIngestRun(db(), {
      teamId: seed.teamId,
      source: "llm",
      trigger: "api",
      ok: false,
      errors: ["LLM returned empty content (model=qwen/qwen3.7-plus, finish_reason=length)"],
      meta: { model: "qwen/qwen3.7-plus", task: "arcs" },
      startedAt: Date.now() - 50,
    });

    const h = await getLlmHealth(seed.teamId);
    expect(h.state).toBe("degraded");
    expect(h.lastModel).toBe("qwen/qwen3.7-plus");
    expect(h.lastFailedAt).not.toBeNull();
    expect(h.note).toContain("qwen/qwen3.7-plus");
    expect(h.note).toMatch(/reasoning model/i); // the actionable "pick a non-reasoning model" hint
  });

  it("a LONE failure is unstable, not degraded, and carries no alarming note (BANNERFLAP-1)", async () => {
    // The control for the fixture change above: it proves the second row is what promotes the state,
    // so the test above cannot pass merely because a failure was recorded at all.
    const seed = await seedTeam();
    await recordIngestRun(db(), {
      teamId: seed.teamId,
      source: "llm",
      trigger: "api",
      ok: false,
      errors: ["LLM returned empty content (model=qwen/qwen3.7-plus, finish_reason=length)"],
      meta: { model: "qwen/qwen3.7-plus", task: "arcs" },
      startedAt: Date.now() - 100,
    });

    const h = await getLlmHealth(seed.teamId);
    expect(h.state).toBe("unstable");
    expect(h.lastError).toContain("empty content"); // recorded and visible
    expect(h.note).toBeUndefined(); // but no red paragraph for a blip
  });

  it("reports healthy after a later successful run (recovery flips the state)", async () => {
    const seed = await seedTeam();
    await recordIngestRun(db(), {
      teamId: seed.teamId,
      source: "llm",
      trigger: "api",
      ok: false,
      errors: ["boom"],
      meta: { model: "m", task: "arcs" },
      startedAt: Date.now() - 2000,
    });
    await recordIngestRun(db(), {
      teamId: seed.teamId,
      source: "llm",
      trigger: "api",
      ok: true,
      meta: { model: "m", task: "arcs" },
      startedAt: Date.now() - 100,
    });

    const h = await getLlmHealth(seed.teamId);
    expect(h.state).toBe("healthy");
    expect(h.lastOkAt).not.toBeNull();
  });

  it("is team-scoped — another team's failure doesn't degrade this one", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    await recordIngestRun(db(), {
      teamId: other.teamId,
      source: "llm",
      trigger: "api",
      ok: false,
      errors: ["boom"],
      meta: { model: "m", task: "arcs" },
      startedAt: Date.now() - 100,
    });
    expect((await getLlmHealth(mine.teamId)).state).toBe("unknown");
  });
});
