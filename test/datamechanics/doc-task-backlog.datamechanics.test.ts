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

/**
 * Spec: a doc is only ever scored against ITS OWN worker's tasks.
 *
 * `candidatesFor` restricts candidates to the doc's worker, and the run must respect that per DOC, not
 * per batch. A single call built from the first doc's author would score everyone else's docs against
 * THAT person's tasks — the exact cross-assignment the restriction exists to stop, made worse by it.
 */
describe("doc→task inference: never scores across people (real Postgres)", () => {
  beforeEach(() => completeTextOrNull.mockReset());

  it("a worker whose call FAILS keeps their links and is re-asked; the others still settle", async () => {
    // One call per worker means one worker's provider timeout must not settle the batch. If it did,
    // the prune (batch-scoped) would delete that worker's existing links AND `markScored` would record
    // their docs, so a transient blip would eat a person's links permanently.
    const { seed } = await seedTeamWithTask();
    const { data: other } = await db().from("members").insert({
      team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Other Person",
      actor_handle: `o-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
    }).select("id").single();
    const otherId = (other as { id: string }).id;
    const { data: proj } = await db().from("projects").select("id").eq("team_id", seed.teamId).limit(1).single();
    await db().from("tasks").insert({
      team_id: seed.teamId, project_id: (proj as { id: string }).id, row_key: "AIO-902",
      title: "Other Person's ticket about widgets", status: "in_progress", assignee: "Other Person",
      origin: "sync", audience: "team",
    });
    await keylessDoc(seed, "mine");
    const theirs = await keylessDoc(seed, "theirs");
    await db().from("items").update({ member_id: otherId }).eq("id", theirs.id);
    await db().from("item_versions").update({ member_id: otherId }).eq("item_id", theirs.id);

    // The OTHER person's call fails; the seed member's succeeds with no match.
    completeTextOrNull.mockImplementation(async (args?: { prompt?: string }) =>
      (args?.prompt ?? "").includes("theirs") ? null : JSON.stringify({ matches: [] })
    );
    await runDocTaskInference(db(), seed.teamId, { maxDocs: 10 });

    const scored = async (itemId: string) => {
      const { data } = await db().from("doc_task_inference").select("item_id").eq("item_id", itemId);
      return (data ?? []).length > 0;
    };
    expect(await scored(theirs.id)).toBe(false); // failed worker → re-asked next run
  });

  it("offers each worker only their OWN tasks, in separate calls", async () => {
    const { seed } = await seedTeamWithTask(); // task AIO-900 assigned to "Tester" (the seed member)
    // A second person with their own task and their own doc.
    const { data: other } = await db().from("members").insert({
      team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Other Person",
      actor_handle: `o-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
    }).select("id").single();
    const otherId = (other as { id: string }).id;
    const { data: proj } = await db().from("projects").select("id").eq("team_id", seed.teamId).limit(1).single();
    await db().from("tasks").insert({
      team_id: seed.teamId, project_id: (proj as { id: string }).id, row_key: "AIO-901",
      title: "Other Person's ticket about widgets", status: "in_progress", assignee: "Other Person", origin: "sync", audience: "team",
    });

    await keylessDoc(seed, "my doc");
    const theirs = await keylessDoc(seed, "their doc");
    // Credit runs through the attribution oracle (`item_versions`), not raw `items.member_id` — so the
    // version's author is what decides whose backlog this doc is scored against.
    await db().from("items").update({ member_id: otherId }).eq("id", theirs.id);
    await db().from("item_versions").update({ member_id: otherId }).eq("item_id", theirs.id);

    completeTextOrNull.mockResolvedValue(JSON.stringify({ matches: [] }));
    await runDocTaskInference(db(), seed.teamId, { maxDocs: 10 });

    // TWO calls, one per worker — and neither prompt may contain the other person's task title.
    const prompts = completeTextOrNull.mock.calls.map((c: unknown[]) => (c[0] as { prompt: string }).prompt);
    expect(prompts.length).toBe(2);
    // The prompt carries synthetic `D1`/`T1` refs, never real ids (the hallucination defence), so the
    // calls are identified by the doc TITLES they describe.
    const mineCall = prompts.find((p: string) => p.includes("my doc"));
    const theirsCall = prompts.find((p: string) => p.includes("their doc"));
    expect(mineCall).toBeDefined();
    expect(theirsCall).toBeDefined();
    expect(mineCall).not.toContain("Other Person's ticket about widgets"); // never offered a teammate's ticket
    expect(theirsCall).not.toContain("The task"); // …and vice versa
  });
});

describe("doc→task inference: links accumulate across batches (real Postgres)", () => {
  beforeEach(() => completeTextOrNull.mockReset());

  it("the batch CAP bites, and the next run accumulates rather than replacing", async () => {
    // BOTH docs exist up front, so `maxDocs: 1` is load-bearing: the cap is what leaves one for the
    // next run. (Seeding them one-per-run would pass with no cap at all, testing nothing about the
    // batch-rotation interaction this whole redesign is about.)
    const { seed } = await seedTeamWithTask();
    const a = await keylessDoc(seed, "backlog doc one");
    const b = await keylessDoc(seed, "backlog doc two");
    answerMatchingOfferedDocs();

    const run1 = await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });
    expect(run1.skipped).toBeUndefined(); // it really ran — not a cooldown/no-llm short-circuit
    expect(run1.linked).toBe(1);
    const afterFirst = await llmLinkedItemIds(seed.teamId);
    expect(afterFirst).toHaveLength(1); // the CAP bit: only one of the two was scored

    await clearCooldown(seed.teamId);
    const run2 = await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });
    expect(run2.skipped).toBeUndefined();
    expect(run2.linked).toBe(1); // the OTHER doc — the batch rotated

    // BOTH links must exist. A team-wide prune leaves only the second — and because the first doc is
    // recorded as scored, it is never re-asked, so its link never comes back.
    expect(await llmLinkedItemIds(seed.teamId)).toEqual([a.id, b.id].sort());
  });

  it("a batch the model DECLINES leaves earlier links intact", async () => {
    const { seed } = await seedTeamWithTask();
    const kept = await keylessDoc(seed, "linked doc");
    answerMatchingOfferedDocs();
    const run1 = await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });
    expect(run1.skipped).toBeUndefined();
    expect(await llmLinkedItemIds(seed.teamId)).toEqual([kept.id]);

    await keylessDoc(seed, "unmatchable doc");
    await clearCooldown(seed.teamId);
    completeTextOrNull.mockResolvedValue(JSON.stringify({ matches: [] })); // no match — the normal case

    const run2 = await runDocTaskInference(db(), seed.teamId, { maxDocs: 1 });
    expect(run2.skipped).toBeUndefined(); // it asked, and the answer was "none"
    expect(run2.linked).toBe(0);

    // An all-declined batch inserts nothing; it must also delete nothing outside itself.
    expect(await llmLinkedItemIds(seed.teamId)).toEqual([kept.id]);
  });
});
