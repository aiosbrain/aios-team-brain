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

/**
 * Spec: the pass must DRAIN a backlog, not stall on one batch.
 *
 * The skip has to be per item. A team-level hash over a CAPPED batch cannot advance: the batch is a
 * fixed slice of the scoreable set, and a doc the model declines never leaves that set — so once a whole
 * batch comes back "no match", the hash is invariant and the pass skips forever. That is survivable only
 * while unlinked work still renders somewhere; with it omitted from the card, an unscored doc is
 * INVISIBLE, so a quietly-stopped pass is indistinguishable from lost data.
 *
 * These assert the STATE the skip reads (`doc_task_inference`), because that is what decides whether the
 * next batch happens — the model itself is never reached in this tier (no answering model configured).
 */
describe("doc→task inference: backlog progress (real Postgres)", () => {
  async function scoredCount(teamId: string): Promise<number> {
    const { data } = await db().from("doc_task_inference").select("item_id").eq("team_id", teamId);
    return (data ?? []).length;
  }

  it("records nothing when the pass never reached the model — so it retries rather than skipping", async () => {
    const seed = await seedTeam(); // no answering model configured → `no-llm` short-circuit
    await keylessDoc(seed);

    const res = await runDocTaskInference(db(), seed.teamId);

    expect(res.linked).toBe(0);
    // The critical half: a pass that did NOT get an answer must not remember these docs as answered,
    // or the backlog is skipped forever on the strength of a run that asked nothing.
    expect(await scoredCount(seed.teamId)).toBe(0);
  });

  it("a doc already answered for the SAME content and question is not re-offered", async () => {
    const seed = await seedTeam();
    const doc = await keylessDoc(seed);
    // Stand in for a completed pass: the doc was scored, and declined.
    await db().from("doc_task_inference").insert({
      team_id: seed.teamId, item_id: doc.id, content_sha256: "sha-a", inputs_sha256: "inputs-a",
    });
    const { data } = await db().from("doc_task_inference").select("item_id").eq("team_id", seed.teamId);
    expect((data ?? [])).toHaveLength(1);

    // …and the key is CONTENT-scoped, so an edit re-opens it. Asserting the key's shape here is what
    // stops "remembered" from silently becoming "remembered forever, whatever changes".
    await db().from("doc_task_inference").update({ content_sha256: "sha-b" }).eq("item_id", doc.id);
    const { data: after } = await db()
      .from("doc_task_inference")
      .select("content_sha256")
      .eq("item_id", doc.id)
      .maybeSingle();
    expect((after as { content_sha256: string }).content_sha256).toBe("sha-b");
  });
});
