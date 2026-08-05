import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { projectItemsToGraph, CHUNK_CHARS, MAX_EPISODE_CHUNKS, chunkContent } from "@/lib/graph/project";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * GRAPHCOST-1 — re-extract only the chunks that changed.
 *
 * Spec: 2-work/specs/graph-chunk-delta-projection.md (AIO-735). Written from the acceptance
 * criteria, not from the implementation: on current code AC1/AC2 are RED (16 episodes where the
 * spec requires 0 and 1).
 *
 * Why this tier: the claim is about a ledger round-trip through `graph_episodes` — what a second
 * projection pass does given what the first pass wrote. A stubbed store cannot verify that.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CAP = CHUNK_CHARS * MAX_EPISODE_CHUNKS; // 40,000 by default — everything past this is dropped

/** A body of `n` chars whose every 2,500-char slice is distinct (so chunk hashes don't collide). */
function body(n: number, marker = "a"): string {
  let out = "";
  for (let i = 0; out.length < n; i++) out += `[${marker}-block-${i}]` + "x".repeat(120);
  return out.slice(0, n);
}

/** Replace `len` chars at `at` WITHOUT changing the length, so no later chunk boundary shifts. */
function editInPlace(text: string, at: number, replacement: string): string {
  return text.slice(0, at) + replacement + text.slice(at + replacement.length);
}

async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}

async function ledgerRow(teamId: string) {
  const { data } = await db()
    .from("graph_episodes")
    .select("source_id, group_id, content_sha256, chunk_shas, chunk_config, projected_at, pending_delete_group_id")
    .eq("team_id", teamId)
    .maybeSingle();
  return data as {
    source_id: string;
    group_id: string;
    content_sha256: string;
    chunk_shas: string[] | null;
    chunk_config: string | null;
    projected_at: string;
    pending_delete_group_id: string | null;
  } | null;
}

/**
 * AC3 — the invariant, asserted after EVERY pass in EVERY fixture below: a hash may only be in the
 * ledger if the double actually received that content for that group. This is what detects a chunk
 * skipped as "unchanged" whose episode was never pushed — the one failure mode of the whole change.
 */
async function expectLedgerContained(teamId: string, fake: FakeGraphiti): Promise<void> {
  const { data } = await db()
    .from("graph_episodes")
    .select("group_id, chunk_shas")
    .eq("team_id", teamId);
  for (const row of (data ?? []) as { group_id: string; chunk_shas: string[] | null }[]) {
    const received = new Set(fake.receivedContentFor(row.group_id).map(sha));
    for (const h of row.chunk_shas ?? []) {
      expect(received.has(h), `ledger holds a chunk sha the graph never received (group ${row.group_id})`).toBe(true);
    }
  }
}

describe("per-chunk projection ledger (real Postgres, mocked Graphiti)", () => {
  it("AC1 — an edit beyond the extraction cap pushes nothing and does not claim a push", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const v1 = body(CAP + 5_000);
    const path = "github/repo/docs/ARCHITECTURE.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    expect(first.pushedEpisodes).toHaveLength(MAX_EPISODE_CHUNKS);
    await expectLedgerContained(seed.teamId, first);
    const afterFirst = await ledgerRow(seed.teamId);

    // Edit ONLY past the cap — the extracted prefix is byte-identical, so there is nothing to re-extract.
    const v2 = editInPlace(v1, CAP + 1_000, "EDITED-BEYOND-THE-CAP");
    expect(v2.slice(0, CAP)).toBe(v1.slice(0, CAP));
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });

    const second = new FakeGraphiti();
    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });

    expect(second.pushedEpisodes).toHaveLength(0); // current code: 16
    // `episodes` is the denominator of the per-episode extraction cost metric: it must count what was
    // SENT, not what the item chunks into, or a delta pass makes extraction look cheaper than it is.
    expect(res.episodes).toBe(0);
    expect(res.projected).toBe(0); // nothing was extracted — this pass is not "work" to the probes
    const afterSecond = await ledgerRow(seed.teamId);
    expect(afterSecond?.content_sha256).toBe(sha(v2)); // the body hash IS updated — no re-check next pass
    // AC9: a pass that POSTed nothing must not advance `projected_at`; extraction-health reads it as
    // "when did we last actually push", discriminating the no-POST paths only by their '' sentinel.
    expect(afterSecond?.projected_at).toBe(afterFirst?.projected_at);
  });

  it("AC2/AC3 — editing one chunk re-pushes exactly that chunk, and only that chunk", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const v1 = body(CHUNK_CHARS * 3);
    const path = "github/repo/docs/design.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    expect(first.pushedEpisodes).toHaveLength(3);

    // Same-length edit inside chunk index 1 → chunks 0 and 2 are byte-identical.
    const v2 = editInPlace(v1, CHUNK_CHARS + 100, "MIDDLE-CHUNK-EDITED");
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });

    const second = new FakeGraphiti();
    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });

    expect(second.pushedEpisodes).toHaveLength(1); // current code: 3
    expect(second.pushedEpisodes[0]?.content).toBe(chunkContent(v2)[1]);
    expect(res.episodes).toBe(1); // the cost metric's denominator counts the one chunk sent, not three

    // The ledger now describes v2's chunking, and every hash in it was really pushed at some point.
    const row = await ledgerRow(seed.teamId);
    expect(row?.chunk_shas).toEqual(chunkContent(v2).map(sha));
    const bothPasses = new FakeGraphiti();
    bothPasses.pushes = [...first.pushes, ...second.pushes];
    await expectLedgerContained(seed.teamId, bothPasses);
  });

  it("AC4 — a pre-feature ledger row is backfilled by one pass that pushes nothing", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const text = body(CHUNK_CHARS * 2);
    const path = "github/repo/README.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    const before = await ledgerRow(seed.teamId);

    // Simulate a row written before this column existed: hashes absent, everything else intact.
    await db()
      .from("graph_episodes")
      .update({ chunk_shas: [], chunk_config: "" })
      .eq("team_id", seed.teamId)
      .eq("source_id", before!.source_id);

    const second = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });

    expect(second.pushedEpisodes).toHaveLength(0); // no re-extraction event on deploy
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_shas).toEqual(chunkContent(text).map(sha));
    expect(after?.projected_at).toBe(before?.projected_at); // AC9 again: nothing was pushed
    await expectLedgerContained(seed.teamId, first); // the hashes it recorded were pushed by pass 1
  });

  it("AC5 — a tier change pushes every chunk into the new group, ledger notwithstanding", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const text = body(CHUNK_CHARS * 3);
    const path = "github/repo/docs/tiered.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    // Same body, new tier: nothing about the CONTENT changed, so only the group forces the re-push.
    await ingest(seed, { kind: "deliverable", path, body: text, access: "external", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes).toHaveLength(3);
    expect(fake.pushes[0]?.groupId).toBe(`${slug}_external`);
    const row = await ledgerRow(seed.teamId);
    expect(row?.pending_delete_group_id).toBe(`${slug}_team`); // old group still recorded for cleanup
  });

  it("AC6 — a retractable source (slack) keeps today's delete-then-push-everything behaviour", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const v1 = body(CHUNK_CHARS * 3, "s");
    const path = "slack/eng/thread.md";
    const fm = { source: "slack" };

    await ingest(seed, { kind: "transcript", path, body: v1, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    const v2 = editInPlace(v1, CHUNK_CHARS + 100, "ONE-MESSAGE-EDITED");
    await ingest(seed, { kind: "transcript", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // No delta for a source whose superseded bodies must not survive: all three chunks re-pushed.
    expect(fake.pushedEpisodes).toHaveLength(3);
  });

  it("AC7 — an outstanding cleanup on ANY group forces a full push", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const v1 = body(CHUNK_CHARS * 3, "p");
    const path = "github/repo/docs/pending.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    // A cleanup outstanding on a DIFFERENT group: not `purgeBeforeRepush`, but still outstanding.
    const row = await ledgerRow(seed.teamId);
    await db()
      .from("graph_episodes")
      .update({ pending_delete_group_id: `${slug}_external`, pending_delete_at: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    const v2 = editInPlace(v1, CHUNK_CHARS + 100, "EDIT-WHILE-CLEANUP-PENDING");
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes).toHaveLength(3);
  });

  it("AC10 — a reconcile sentinel row re-pushes everything, even with a full per-chunk ledger", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const text = body(CHUNK_CHARS * 3, "r");
    const path = "github/repo/docs/never-landed.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    expect(row?.chunk_shas?.length).toBe(3);

    // The reachable sentinel state, reproduced exactly rather than approximated. Both writers of
    // `content_sha256 = ''` (project.ts's redaction path, reconcile.ts's never-landed re-queue) also
    // set the pending flag — but reconcile's cleanup loop later CLEARS that flag on a purge it verified
    // (reconcile.ts:387-391) while leaving the sentinel sha in place. What survives is a row whose
    // episodes were purged from the group, whose flag is null, and whose chunk_shas still describe the
    // pre-purge push. Nothing else in the predicate can see that.
    //
    // Fixture note: an earlier version of this test left the pending flag SET, which made it pass with
    // the sentinel term deleted — it was proving AC7's term, not this one. Mutation-checked.
    await db()
      .from("graph_episodes")
      .update({ content_sha256: "", pending_delete_group_id: null, pending_delete_at: null })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // Body unchanged and every hash already in the ledger — a delta that trusted the ledger would push
    // NOTHING here, and the item's content would never reach the graph again while `projected_at`
    // refreshed hourly and the ledger read healthy.
    expect(fake.pushedEpisodes).toHaveLength(3);
  });

  it("AC11 — a chunk-config change invalidates the ledger and pushes everything", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const v1 = body(CHUNK_CHARS * 3, "c");
    const path = "github/repo/docs/config.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    expect(row?.chunk_config).toBeTruthy(); // the config that produced those hashes is recorded

    // The hashes were written under a DIFFERENT chunking. `content_sha256` hashes the whole body and
    // cannot see this, so the config is what makes the ledger's identity complete.
    await db()
      .from("graph_episodes")
      .update({ chunk_config: "1000x64" })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    const v2 = editInPlace(v1, CHUNK_CHARS + 100, "EDIT-AFTER-CONFIG-CHANGE");
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes).toHaveLength(3);
  });
});

/**
 * AIO-808 — raising MAX_EPISODE_CHUNKS must deliver the newly-admitted TAIL to items whose bodies have
 * not changed, and must NOT re-push anything else.
 *
 * The whole feature turns on a distinction the first two spec drafts got wrong: the unchanged-content
 * skip and the delta predicate ask different questions. These two tests are what separate a correct
 * build from a plausible one — the first fails a compatibility-only skip (all over-cap items keep
 * skipping, no tail lands), and AC11 above fails a count-only skip (its fixture keeps real hashes while
 * rewriting the config, so counts match and a count-only skip would skip). Do not "simplify" either.
 */
describe("chunk-cap raise (AIO-808)", () => {
  it("an over-cap item whose body never changed receives ONLY its tail", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/huge.md";
    const fm = { source: "github" };
    // 20 chunks' worth of body against a ledger that was written under a 16-chunk cap.
    const big = body(CHUNK_CHARS * 20, "h");

    await ingest(seed, { kind: "deliverable", path, body: big, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });

    // Rewrite the ledger to the pre-raise state: the first 16 chunks, recorded under "2500x16".
    const row = await ledgerRow(seed.teamId);
    const under16 = chunkContent(big, CHUNK_CHARS, 16);
    await db()
      .from("graph_episodes")
      .update({ chunk_shas: under16.map(sha), chunk_config: `${CHUNK_CHARS}x16` })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    // Same body, byte for byte — only the cap has moved.
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const pushed = fake.pushes.flatMap((p) => p.episodes);
    const expectedTail = chunkContent(big, CHUNK_CHARS, MAX_EPISODE_CHUNKS).length - 16;
    expect(expectedTail, "fixture must actually straddle the old cap").toBeGreaterThan(0);
    expect(pushed.length, "exactly the tail, nothing re-pushed").toBe(expectedTail);
    // And the ledger converges to the current config with the full set recorded.
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_config).toBe(`${CHUNK_CHARS}x${MAX_EPISODE_CHUNKS}`);
    expect(after?.chunk_shas?.length).toBe(16 + expectedTail);
  });

  it("ANTI-FLOOD — a COMPLETE item with a stale config is neither deleted nor re-pushed", async () => {
    // The degenerate build this kills: a skip written as bare `stored !== CHUNK_CONFIG` sends the whole
    // corpus through the push path. For a RETRACTABLE source the retract-delete branch fires before the
    // delta predicate, so every Slack item would get deleteItemEpisodes + a full re-push — unbudgeted,
    // and invisible to every other assertion in this file.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "slack/c123/1782124487.144019.md";
    const fm = { source: "slack" }; // retainSupersededBodies: false — the flood-sensitive path
    const small = body(CHUNK_CHARS * 2, "s"); // 2 chunks: complete under both 16 and 40

    await ingest(seed, { kind: "transcript", path, body: small, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    const row = await ledgerRow(seed.teamId);
    await db()
      .from("graph_episodes")
      .update({ chunk_config: `${CHUNK_CHARS}x16` }) // stale cap, but the item owes nothing
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushes.flatMap((p) => p.episodes), "a complete item owes nothing").toEqual([]);
    expect(fake.listCalls, "and must not be dragged through the retract-delete path").toEqual([]);
  });
});
