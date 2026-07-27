import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * Spec: the doc→task pass ACCUMULATES links across batches.
 *
 * The pass caps each run at `MAX_DOCS` and now records what it scored per item, so successive runs walk
 * a backlog. That only works if a run replaces its OWN batch's links: while the batch was a fixed
 * newest-N slice a team-wide `method='llm'` prune was a true replace, but rotating batches make it a
 * wipe — run 2 deletes run 1's links, run 1's docs are recorded as scored so they are never re-asked,
 * and coverage caps at one batch forever. With unlinked evidence omitted from the card, those docs go
 * INVISIBLE rather than merely unlinked, which is the same "quietly stopped pass = lost data" failure
 * the per-item redesign exists to prevent.
 *
 * Asserted on the observable outcome — the surviving `task_evidence` rows after a second run.
 */

const { completeTextOrNull } = vi.hoisted(() => ({ completeTextOrNull: vi.fn() }));
vi.mock("@/lib/llm/complete", () => ({ completeTextOrNull }));
// A configured model, so the pass reaches the batching/prune logic instead of short-circuiting.
vi.mock("@/lib/dashboard/timeline-summary", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  llmConfigured: () => true,
}));
vi.mock("@/lib/query/answering", () => ({ resolveAnsweringKeys: vi.fn(async () => ({ openrouterKey: "k" })) }));

const { runDocTaskInference } = await import("@/lib/dashboard/doc-task-infer-run");

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString();

async function keylessDoc(seed: Seed, title: string) {
  return ingest(seed, {
    kind: "deliverable", path: `2-work/${randomUUID()}.md`, access: "team",
    body: `prose about ${title}`, frontmatter: { source: "", title, updated: recentIso },
  });
}

async function seedTeamWithTask(): Promise<{ seed: Seed; taskId: string }> {
  const seed = await seedTeam();
  const { data: proj } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "P" })
    .select("id")
    .single();
  await db().from("tasks").insert({
    team_id: seed.teamId, project_id: (proj as { id: string }).id, row_key: "AIO-900",
    title: "The task", status: "in_progress", assignee: "Tester", origin: "sync", audience: "team",
  });
  const { data: task } = await db().from("tasks").select("id").eq("team_id", seed.teamId).eq("row_key", "AIO-900").maybeSingle();
  return { seed, taskId: (task as { id: string }).id };
}

/** Clear the cooldown so a second run in the same test is allowed. */
async function clearCooldown(teamId: string) {
  await db().from("ingest_runs").delete().eq("team_id", teamId);
}

async function llmLinkedItemIds(teamId: string): Promise<string[]> {
  const { data } = await db().from("task_evidence").select("item_id").eq("team_id", teamId).eq("method", "llm");
  return ((data ?? []) as { item_id: string }[]).map((r) => r.item_id).sort();
}

/** The model answers with the synthetic `D<n>` refs the prompt offered, matching whichever doc it saw. */
function answerMatchingOfferedDocs(): void {
  completeTextOrNull.mockImplementation(async (args?: { prompt?: string }) => {
    const prompt = args?.prompt ?? "";
    const refs = [...prompt.matchAll(/\b(D\d+)\b/g)].map((m) => m[1]);
    const unique = [...new Set(refs)];
    return JSON.stringify({
      matches: unique.map((ref) => ({ doc: ref, task: "T1", confidence: 0.95, why: "matches" })),
    });
  });
}

describe("doc→task inference: links accumulate across batches (real Postgres)", () => {
  beforeEach(() => completeTextOrNull.mockReset());

  it("a later batch does NOT wipe an earlier batch's links", async () => {
    const { seed } = await seedTeamWithTask();
    const first = await keylessDoc(seed, "batch one doc");
    answerMatchingOfferedDocs();

    // Run 1 — cap the batch at 1 so the second doc is left for the next run.
    await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });
    const afterFirst = await llmLinkedItemIds(seed.teamId);
    expect(afterFirst).toEqual([first.id]); // non-vacuous: run 1 really linked something

    // A second doc arrives and is scored by the NEXT run.
    const second = await keylessDoc(seed, "batch two doc");
    await clearCooldown(seed.teamId);
    await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });

    // BOTH links must exist. A team-wide prune leaves only the second — and because the first doc is
    // recorded as scored, it is never re-asked, so its link never comes back.
    expect(await llmLinkedItemIds(seed.teamId)).toEqual([first.id, second.id].sort());
  });

  it("a batch the model DECLINES leaves earlier links intact", async () => {
    const { seed } = await seedTeamWithTask();
    const kept = await keylessDoc(seed, "linked doc");
    answerMatchingOfferedDocs();
    await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });
    expect(await llmLinkedItemIds(seed.teamId)).toEqual([kept.id]);

    await keylessDoc(seed, "unmatchable doc");
    await clearCooldown(seed.teamId);
    completeTextOrNull.mockResolvedValue(JSON.stringify({ matches: [] })); // no match — the normal case

    await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });

    // An all-declined batch inserts nothing; it must also delete nothing outside itself.
    expect(await llmLinkedItemIds(seed.teamId)).toEqual([kept.id]);
  });
});
