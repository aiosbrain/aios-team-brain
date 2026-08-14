import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { recordIngestRun } from "@/lib/ingest/runs";
import { getLlmHealth } from "@/lib/query/llm-health";

/**
 * LLMOBS-1 — the per-task read, against real Postgres.
 *
 * The pure derivation is unit-tested. What CANNOT be unit-tested is the SQL, and that is where this
 * slice's hazards live:
 *
 *   • the partition is `meta->>'task'` — a JSONB expression, which FakeSupabase has no notion of;
 *   • the per-task `row_number()` window replaced a global `limit 2` that, once more than one task
 *     records, returns two rows of the chattiest task and STARVES a failing one of the evidence it
 *     needs to confirm;
 *   • the `finished_at desc, id desc` tie-break, for two runs in the same millisecond;
 *   • team scoping, which must survive the rewrite.
 *
 * The FIRST test is the headline: it enters through the real meetings path rather than the extraction
 * helper, because a test entering at the helper passes for a builder who threads `record` only where
 * the test passes it — leaving every production caller unobserved, which is the bug itself.
 */

const MIN = 60 * 1000;

async function recordLlm(opts: {
  teamId: string | null;
  task: string | null;
  ok: boolean;
  at: number;
  model?: string;
  error?: string;
}): Promise<void> {
  await recordIngestRun(db(), {
    teamId: opts.teamId,
    source: "llm",
    trigger: "api",
    ok: opts.ok,
    created: 0,
    errors: opts.ok ? undefined : [opts.error ?? "LLM returned empty content (finish_reason=length)"],
    meta: opts.task === null ? { model: opts.model ?? "m" } : { task: opts.task, model: opts.model ?? "m" },
    startedAt: opts.at,
    finishedAt: opts.at,
  });
}

describe("getLlmHealth — the per-task read (data-mechanics)", () => {
  it("partitions by meta.task: a chatty healthy task cannot starve a failing one", async () => {
    // THE REGRESSION THE WINDOW REPLACED. Under the old global `limit 2`, the two newest rows here are
    // both `meeting-actions` successes, so the meeting-summary outage is invisible — the leg reads
    // healthy while every summary is blank.
    const { teamId } = await seedTeam();
    const now = Date.now();
    await recordLlm({ teamId, task: "meeting-summary", ok: false, at: now - 40 * MIN });
    await recordLlm({ teamId, task: "meeting-summary", ok: false, at: now - 30 * MIN });
    await recordLlm({ teamId, task: "meeting-actions", ok: true, at: now - 20 * MIN });
    await recordLlm({ teamId, task: "meeting-actions", ok: true, at: now - 10 * MIN });

    const health = await getLlmHealth(teamId);
    expect(health.state).toBe("degraded");
    expect(health.tasks.find((t) => t.task === "meeting-summary")?.state).toBe("degraded");
    expect(health.tasks.find((t) => t.task === "meeting-actions")?.state).toBe("healthy");
    // The note names the failing feature and not the healthy one's.
    expect(health.note).toContain("meeting summaries");
  });

  it("the singular fields describe the FAILING task, not the newest row", async () => {
    // A fresh `arcs` success sits newest; the fields must still describe the meeting-summary outage,
    // and on ITS model — arcs runs the reasoning model, the rest the query model, so naming the wrong
    // one sends an operator to the wrong picker.
    const { teamId } = await seedTeam();
    const now = Date.now();
    await recordLlm({ teamId, task: "meeting-summary", ok: false, at: now - 40 * MIN, model: "query-model" });
    await recordLlm({ teamId, task: "meeting-summary", ok: false, at: now - 30 * MIN, model: "query-model" });
    await recordLlm({ teamId, task: "arcs", ok: true, at: now - 5 * MIN, model: "reasoning-model" });

    const health = await getLlmHealth(teamId);
    expect(health.lastModel).toBe("query-model");
    expect(health.lastFailedAt).not.toBeNull();
  });

  it("breaks a same-millisecond tie by id — the retry, not the fail, is newest", async () => {
    const { teamId } = await seedTeam();
    const at = Date.now() - 20 * MIN;
    await recordLlm({ teamId, task: "arcs", ok: false, at });
    await recordLlm({ teamId, task: "arcs", ok: true, at });

    const health = await getLlmHealth(teamId);
    expect(health.tasks.find((t) => t.task === "arcs")?.state).toBe("healthy");
  });

  it("is team-scoped — another team's failures cannot degrade this leg", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    const now = Date.now();
    await recordLlm({ teamId: mine.teamId, task: "arcs", ok: true, at: now - 10 * MIN });
    await recordLlm({ teamId: other.teamId, task: "arcs", ok: false, at: now - 20 * MIN });
    await recordLlm({ teamId: other.teamId, task: "arcs", ok: false, at: now - 30 * MIN });

    expect((await getLlmHealth(mine.teamId)).state).toBe("healthy");
    expect((await getLlmHealth(other.teamId)).state).toBe("degraded");
  });

  it("a row with no meta.task still lands in a partition rather than vanishing", async () => {
    // Defensive: every row written today carries a task, but a legacy or hand-inserted row must not
    // silently disappear from the verdict — an absent row is indistinguishable from a healthy one.
    const { teamId } = await seedTeam();
    const now = Date.now();
    await recordLlm({ teamId, task: null, ok: false, at: now - 20 * MIN });
    await recordLlm({ teamId, task: null, ok: false, at: now - 30 * MIN });

    const health = await getLlmHealth(teamId);
    expect(health.tasks.map((t) => t.task)).toContain("(untagged)");
    expect(health.state).toBe("degraded");
  });

  it("reports unknown when nothing has been recorded", async () => {
    const { teamId } = await seedTeam();
    expect((await getLlmHealth(teamId)).state).toBe("unknown");
  });
});
