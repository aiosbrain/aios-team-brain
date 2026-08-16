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
// `withLlmPass` is a pass-through here: this file is about the batching/linking behaviour, and the
// pass contract has its own tests. It must still be present — the module is mocked wholesale, so a
// missing export is a hard failure rather than a fallback to the real implementation.
vi.mock("@/lib/llm/complete", () => ({
  completeTextOrNull,
  withLlmPass: (_init: unknown, body: (p: unknown) => Promise<unknown>) =>
    body({ calls: 0, failures: 0, model: null, firstError: null, startedAt: Date.now(), done: false }),
  failLlmPassBeforeFirstCall: () => {},
}));
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
    //
    // The discriminating parts, learned the hard way — an earlier version of this test asserted only
    // "the failed worker is unscored", which is ALSO true of the broken code (an empty `links` array
    // short-circuits before the prune), so it was green on the bug:
    //   1. the SUCCEEDING worker returns a real match, so `links` is non-empty and the old code falls
    //      through to the batch-wide prune + markScored;
    //   2. a pre-existing llm edge for the FAILING worker must SURVIVE — the half that loses user data;
    //   3. the succeeding worker IS scored — a positive control, so a run that silently did nothing
    //      (cooldown, no-llm, a throw) cannot pass.
    const { seed, taskId } = await seedTeamWithTask();
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
    const mine = await keylessDoc(seed, "mine");
    const theirs = await keylessDoc(seed, "theirs");
    await db().from("items").update({ member_id: otherId }).eq("id", theirs.id);
    await db().from("item_versions").update({ member_id: otherId }).eq("item_id", theirs.id);

    // An edge the failing worker already has — this is what a batch-wide prune would destroy.
    await db().from("task_evidence").insert({
      team_id: seed.teamId, task_id: taskId, item_id: theirs.id, method: "llm", confidence: 0.9,
    });

    // The OTHER person's call fails; the seed member's succeeds WITH A MATCH.
    completeTextOrNull.mockImplementation(async (args?: { prompt?: string }) =>
      (args?.prompt ?? "").includes("theirs")
        ? null
        : JSON.stringify({ matches: [{ doc: "D1", task: "T1", confidence: 0.95, why: "r" }] })
    );
    await runDocTaskInference(db(), seed.teamId, { maxDocs: 10 });

    const scored = async (itemId: string) => {
      const { data } = await db().from("doc_task_inference").select("item_id").eq("item_id", itemId);
      return (data ?? []).length > 0;
    };
    expect(await scored(mine.id)).toBe(true); // positive control: the run really did work
    expect(await scored(theirs.id)).toBe(false); // failed worker → re-asked next run
    // …and their existing edge is intact. This is the assertion that goes red on a batch-wide prune.
    expect(await llmLinkedItemIds(seed.teamId)).toContain(theirs.id);
  });

  it("gives each worker their OWN tasks FIRST, in separate calls", async () => {
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

    // TWO calls, one per worker. Per-worker matters even though candidates are no longer restricted:
    // the ORDER is per-worker ("own tasks first"), so a single call built from one author's ranking
    // would hand everyone else a prompt ranked for the wrong person.
    const prompts = completeTextOrNull.mock.calls.map((c: unknown[]) => (c[0] as { prompt: string }).prompt);
    expect(prompts.length).toBe(2);
    // The prompt carries synthetic `D1`/`T1` refs, never real ids (the hallucination defence), so the
    // calls are identified by the doc TITLES they describe.
    const mineCall = prompts.find((p: string) => p.includes("my doc"));
    const theirsCall = prompts.find((p: string) => p.includes("their doc"));
    expect(mineCall).toBeDefined();
    expect(theirsCall).toBeDefined();
    // A teammate's ticket IS offered — a doc about someone else's work is a real case, and the card
    // now names the owner so the association is legible. What must hold is the ORDER: your own first.
    const ownFirst = (prompt: string, own: string, other: string) =>
      prompt.indexOf(own) >= 0 && (prompt.indexOf(other) < 0 || prompt.indexOf(own) < prompt.indexOf(other));
    expect(ownFirst(mineCall!, "The task", "Other Person's ticket about widgets")).toBe(true);
    expect(ownFirst(theirsCall!, "Other Person's ticket about widgets", "The task")).toBe(true);
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
