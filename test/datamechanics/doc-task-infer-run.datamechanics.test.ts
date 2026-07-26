import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runDocTaskInference, DOC_TASK_INFER_SOURCE } from "@/lib/dashboard/doc-task-infer-run";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * Spec for the LLM doc→task pass's SPEND GATES, against real Postgres.
 *
 * The pass is offered two triggers — the ingest scheduler tick (every 30 min) and the timeline's
 * background rebuild (i.e. a page view) — and neither cadence is one you want to pay a model at. The
 * gates below are what make that safe, so they are asserted on the observable outcome (what the pass
 * returns, and what it records) rather than by reading the implementation.
 *
 * The model is never reached in this tier: a seeded team has no answering model configured, so the
 * `no-llm` short-circuit fires. That is itself one of the gates, and it means these tests can prove the
 * ORDER of the gates — a cooldown that only worked *after* key resolution would still spend on a team
 * that has keys.
 */

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString();

async function keylessDoc(seed: Seed) {
  return ingest(seed, {
    kind: "deliverable", path: `2-work/${randomUUID()}.md`, access: "team",
    body: "prose about some work", frontmatter: { source: "", title: "A design doc", updated: recentIso },
  });
}

/** A prior run of this leg, as `recordIngestRun` writes it — the shared clock for both triggers. */
async function priorRun(seed: Seed, opts: { agoMs: number; ok?: boolean; inputsHash?: string }) {
  const at = new Date(Date.now() - opts.agoMs).toISOString();
  const { error } = await db().from("ingest_runs").insert({
    team_id: seed.teamId, source: DOC_TASK_INFER_SOURCE, trigger: "scheduler",
    ok: opts.ok ?? true, meta: opts.inputsHash ? { inputs_hash: opts.inputsHash } : {},
    started_at: at, finished_at: at,
  });
  if (error) throw new Error(`ingest_runs insert failed: ${error.message}`);
}

describe("doc→task inference — spend gates (real Postgres)", () => {
  it("a run within the cooldown does nothing — and does so BEFORE resolving keys or scanning items", async () => {
    const seed = await seedTeam();
    await keylessDoc(seed);
    await priorRun(seed, { agoMs: 60_000 }); // one minute ago

    // `cooldown`, not `no-llm`: the cheapest gate must be the FIRST one. If key resolution came first,
    // a team WITH a model configured would pay every tick despite having just run.
    expect(await runDocTaskInference(db(), seed.teamId)).toEqual({ scored: 0, linked: 0, skipped: "cooldown" });
  });

  it("past the cooldown it proceeds to the next gate (here: no model configured → still spends nothing)", async () => {
    const seed = await seedTeam();
    await keylessDoc(seed);
    await priorRun(seed, { agoMs: 30 * 3_600_000 }); // 30h ago — well past the 12h default

    // Non-vacuous counterpart to the test above: the cooldown really did release, and the NEXT gate held.
    expect(await runDocTaskInference(db(), seed.teamId)).toEqual({ scored: 0, linked: 0, skipped: "no-llm" });
  });

  it("a FAILED run still starts the cooldown — a broken provider must not be retried every tick", async () => {
    const seed = await seedTeam();
    await keylessDoc(seed);
    await priorRun(seed, { agoMs: 60_000, ok: false });

    expect((await runDocTaskInference(db(), seed.teamId)).skipped).toBe("cooldown");
  });

  it("with no history at all it runs (a first run must never be gated by a clock that doesn't exist yet)", async () => {
    const seed = await seedTeam();
    await keylessDoc(seed);

    expect((await runDocTaskInference(db(), seed.teamId)).skipped).toBe("no-llm");
  });

  it("another team's run does not gate this one — the clock is per team", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    await keylessDoc(mine);
    await priorRun(other, { agoMs: 60_000 });

    expect((await runDocTaskInference(db(), mine.teamId)).skipped).toBe("no-llm");
  });
});
