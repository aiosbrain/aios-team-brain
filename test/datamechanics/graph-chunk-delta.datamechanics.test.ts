import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  projectItemsToGraph,
  CHUNK_CHARS,
  CHUNK_MAX_CHARS,
  MAX_EPISODE_CHUNKS,
  CHUNK_CONFIG,
  chunkContent,
  chunkContentLegacy,
  chunkContentUnderConfig,
} from "@/lib/graph/project";
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
/**
 * How many characters of a body the CURRENT chunker actually delivers. Under byte offsets this was the
 * constant `CHUNK_CHARS * MAX_EPISODE_CHUNKS`; under `cdc1` chunk sizes vary, so the covered extent is
 * a property of the body and must be ASKED rather than computed. (`CHUNK_MAX_CHARS * MAX_EPISODE_CHUNKS`
 * is the ceiling — the smallest body length guaranteed to exceed the cap.)
 */
const covered = (b: string): number => chunkContent(b).reduce((n, c) => n + c.length, 0);
/** The smallest body guaranteed to be clipped by the cap, whatever the boundaries fall out as. */
const OVER_CAP_CHARS = CHUNK_MAX_CHARS * MAX_EPISODE_CHUNKS + 10_000;

/**
 * A deterministic prose-shaped body of `n` chars, distinct per `marker`.
 *
 * Prose-shaped rather than `"[a-block-0]" + "x".repeat(120)` because content-defined boundaries are a
 * function of the CONTENT: a body of long identical runs is hash-quiet, which is a real shape (tables,
 * code fences) but a terrible default for a fixture whose point is "an ordinary document". Deterministic
 * so a chunk boundary can never move between two runs of the same test.
 */
function body(n: number, marker = "a"): string {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
  let s = 0;
  for (let i = 0; i < marker.length; i++) s = (Math.imul(s, 31) + marker.charCodeAt(i)) >>> 0;
  const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  let out = "";
  for (let i = 0; out.length < n; i++) {
    const parts = [`[${marker}-block-${i}]`];
    const len = Math.floor(rand() * 14) + 6;
    for (let w = 0; w < len; w++) parts.push(words[Math.floor(rand() * words.length)]);
    out += parts.join(" ") + (rand() < 0.15 ? ".\n\n" : ". ");
  }
  return out.slice(0, n);
}

/** Insert `text` at `at`, shifting everything after it — the edit byte offsets cannot survive. */
function insertAt(text: string, at: number, inserted: string): string {
  return text.slice(0, at) + inserted + text.slice(at);
}

/** Replace `len` chars at `at` WITHOUT changing the length, so no later chunk boundary shifts. */
function editInPlace(text: string, at: number, replacement: string): string {
  return text.slice(0, at) + replacement + text.slice(at + replacement.length);
}

/**
 * Same-length edit in the MIDDLE of chunk `k`, as the current chunker actually cuts it.
 *
 * Under byte offsets `CHUNK_CHARS + 100` was a fine way to say "inside chunk 1". Under `cdc1` the
 * boundaries are content-defined, so the position must be derived from the chunking rather than
 * assumed — and the midpoint specifically, because the gear hash's ~32-unit window means an edit
 * NEAR a boundary can legitimately move it, which would make these fixtures about realignment when
 * they are about the delta.
 */
function editInsideChunk(text: string, k: number, replacement: string): string {
  const chunks = chunkContent(text);
  if (k >= chunks.length) throw new Error(`fixture has ${chunks.length} chunks, cannot edit chunk ${k}`);
  const start = chunks.slice(0, k).reduce((n, c) => n + c.length, 0);
  return editInPlace(text, start + Math.floor(chunks[k].length / 2), replacement);
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
    const v1 = body(OVER_CAP_CHARS);
    const path = "github/repo/docs/ARCHITECTURE.md";
    const fm = { source: "github" };

    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    expect(first.pushedEpisodes).toHaveLength(MAX_EPISODE_CHUNKS);
    await expectLedgerContained(seed.teamId, first);
    const afterFirst = await ledgerRow(seed.teamId);

    // Edit ONLY past the cap — the extracted prefix is byte-identical, so there is nothing to re-extract.
    // The covered extent is ASKED of the chunker, not computed: under `cdc1` it is a property of this
    // body. `+1_000` clears the gear hash's ~32-unit window with room to spare.
    const capReach = covered(v1);
    expect(capReach, "fixture must actually be clipped by the cap").toBeLessThan(v1.length - 2_000);
    const v2 = editInPlace(v1, capReach + 1_000, "EDITED-BEYOND-THE-CAP");
    expect(v2.slice(0, capReach)).toBe(v1.slice(0, capReach));
    expect(chunkContent(v2), "the delivered chunks must be byte-identical").toEqual(chunkContent(v1));
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
    expect(first.pushedEpisodes).toHaveLength(chunkContent(v1).length);
    expect(chunkContent(v1).length, "fixture must be multi-chunk").toBeGreaterThanOrEqual(3);

    // Same-length edit in the middle of chunk index 1 → chunks 0 and 2 are byte-identical.
    const v2 = editInsideChunk(v1, 1, "MIDDLE-CHUNK-EDITED");
    expect(chunkContent(v2).length, "a mid-chunk same-length edit must not move a boundary").toBe(
      chunkContent(v1).length
    );
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

  it("AC4 — a pre-feature ledger row converges by ONE FULL RE-PUSH (AIO-808 inverted the contract)", async () => {
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

    // INVERTED BY AIO-808. This used to assert a free backfill: record the current config's hashes
    // without pushing. That branch is deleted, because its premise — "an identical body means these
    // are the chunks we pushed" — was only ever valid inside one config era (its own comment said so),
    // and raising MAX_EPISODE_CHUNKS ended that era. Worse, for a pre-ledger row OVER the old cap it
    // would have blessed tail hashes for chunks present in the graph in no form at all — silent,
    // permanent loss that reconcile cannot see.
    //
    // The contract now: an unattestable config converges via ONE full re-push. That is the
    // self-hosted upgrade path from pre-GRAPHCOST-1, and this test is what stops someone
    // "restoring" the backfill later without confronting the hazard above.
    const expected = chunkContent(text).length;
    expect(expected, "fixture must actually have chunks to push").toBeGreaterThan(0);
    expect(second.pushedEpisodes, "an unattestable config re-pushes, it does not bless").toHaveLength(expected);
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_shas).toEqual(chunkContent(text).map(sha));
    expect(after?.chunk_config).toBe(CHUNK_CONFIG); // and converges to the current era
    expect(after?.projected_at, "a real push bumps the stamp").not.toBe(before?.projected_at);
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

    expect(fake.pushedEpisodes).toHaveLength(chunkContent(text).length);
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

    const v2 = editInsideChunk(v1, 1, "ONE-MESSAGE-EDITED");
    await ingest(seed, { kind: "transcript", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // No delta for a source whose superseded bodies must not survive: every chunk re-pushed.
    expect(fake.pushedEpisodes).toHaveLength(chunkContent(v2).length);
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

    const v2 = editInsideChunk(v1, 1, "EDIT-WHILE-CLEANUP-PENDING");
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes).toHaveLength(chunkContent(v2).length);
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
    expect(row?.chunk_shas?.length).toBe(chunkContent(text).length);

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
    expect(fake.pushedEpisodes).toHaveLength(chunkContent(text).length);
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

    const v2 = editInsideChunk(v1, 1, "EDIT-AFTER-CONFIG-CHANGE");
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes).toHaveLength(chunkContent(v2).length);
  });
});

/**
 * AIO-808 — raising MAX_EPISODE_CHUNKS must deliver the newly-admitted TAIL to items whose bodies have
 * not changed, and must NOT re-push anything else.
 *
 * The whole feature turns on a distinction the first two spec drafts got wrong: the unchanged-content
 * skip and the delta predicate ask different questions. These two tests are what separate a correct
 * build from a plausible one. The tail test fails a compatibility-only skip (all over-cap items keep
 * skipping, no tail lands). The count-only mutant needs its OWN case — AC11 does not catch it, though
 * this comment used to claim so: AC11 edits the body, so the sha term fails before either new term is
 * consulted. Hence the third test below. Do not "simplify" any of them.
 */
describe("chunk-cap raise (AIO-808)", () => {
  it("an over-cap item whose body never changed receives ONLY its tail", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/huge.md";
    const fm = { source: "github" };
    // A body well past a 16-chunk cap, against a ledger written under that cap.
    const big = body(CHUNK_MAX_CHARS * 20, "h");
    const OLD_CAP = 16;
    const oldConfig = `cdc1-${CHUNK_CHARS}-1250-${CHUNK_MAX_CHARS}-${OLD_CAP}`;

    await ingest(seed, { kind: "deliverable", path, body: big, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });

    // Rewrite the ledger to the pre-raise state: the first 16 chunks, recorded under the smaller cap.
    // PIPEFF-3 note — this fixture had to move from `2500x16` to a CDC config with a small cap: the
    // cap-grow path is now only reachable WITHIN one algorithm, and a legacy→CDC transition is a
    // different case entirely (it goes through completeness, tested below). The claim under test is
    // unchanged: a cap raise appends, it never rewrites.
    const row = await ledgerRow(seed.teamId);
    const underOldCap = chunkContentUnderConfig(big, oldConfig) ?? [];
    expect(underOldCap).toHaveLength(OLD_CAP);
    await db()
      .from("graph_episodes")
      .update({ chunk_shas: underOldCap.map(sha), chunk_config: oldConfig })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    // Same body, byte for byte — only the cap has moved.
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const pushed = fake.pushes.flatMap((p) => p.episodes);
    const expectedTail = chunkContent(big).length - OLD_CAP;
    expect(expectedTail, "fixture must actually straddle the old cap").toBeGreaterThan(0);
    expect(pushed.length, "exactly the tail, nothing re-pushed").toBe(expectedTail);
    // Identity, not just arity: a build that pushed chunks 0..3 instead of the tail would satisfy a
    // count-only assertion while putting the wrong content in the graph.
    expect(pushed.map((e) => e.content)).toEqual(chunkContent(big).slice(OLD_CAP));
    // And the ledger converges to the current config with the full set recorded.
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_config).toBe(CHUNK_CONFIG);
    expect(after?.chunk_shas?.length).toBe(OLD_CAP + expectedTail);
  });

  it("a stale config with MATCHING counts still re-pushes — the count-only mutant's killer", async () => {
    // Kills a skip that drops the compatibility term and keeps only `owesChunks`. The fixture makes
    // the counts EQUAL by construction (the real pushed shas are left in place) while the stored
    // config claims different CHUNK_CHARS — so boundaries moved, every stored hash is stale, and the
    // only correct answer is a full re-push. A count-only skip sees "owes nothing" and skips,
    // stranding the item on boundaries that no longer exist.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/count-match.md";
    const fm = { source: "github" };
    const text = body(CHUNK_CHARS * 3, "m");

    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    const row = await ledgerRow(seed.teamId);
    await db()
      .from("graph_episodes")
      .update({ chunk_config: `cdc1-${CHUNK_CHARS * 2}-1250-${CHUNK_MAX_CHARS}-${MAX_EPISODE_CHUNKS}` }) // different TARGET, same cap
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    // Assert the state the CODE WILL READ, re-fetched after the mutation — not a capture taken before
    // it. A stale capture would still read "counts match" if someone later added `chunk_shas` to that
    // update, silently converting this into an owes-driven test that no longer catches its own mutant
    // while every assertion stayed green.
    const staged = await ledgerRow(seed.teamId);
    expect(staged?.chunk_shas?.length, "counts must MATCH, or this tests the count term instead").toBe(
      chunkContent(text).length
    );
    expect(staged?.content_sha256, "body must be untouched, or the sha term short-circuits like AC11").toBe(
      sha(text)
    );

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const pushed = fake.pushes.flatMap((p) => p.episodes);
    expect(pushed.length, "untrustworthy boundaries ⇒ full re-push, not a skip").toBe(chunkContent(text).length);
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
    const small = body(CHUNK_CHARS * 3, "s"); // multi-chunk, and complete under any cap ≥ its count

    await ingest(seed, { kind: "transcript", path, body: small, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    const row = await ledgerRow(seed.teamId);
    const staleConfig = `cdc1-${CHUNK_CHARS}-1250-${CHUNK_MAX_CHARS}-16`; // stale cap, item owes nothing
    await db()
      .from("graph_episodes")
      .update({ chunk_config: staleConfig })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);
    expect((chunkContentUnderConfig(small, staleConfig) ?? []).length, "fixture must fit the stale cap")
      .toBeLessThan(16);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushes.flatMap((p) => p.episodes), "a complete item owes nothing").toEqual([]);
    expect(fake.listCalls, "and must not be dragged through the retract-delete path").toEqual([]);
  });
});

/**
 * PIPEFF-3 / AIO-826 — content-defined chunking.
 *
 * ⚠️ THE FIRST TEST BELOW IS **THE GATE**, and the spec says so in as many words: the pure-function
 * churn table "stays green while the projector re-pushes everything, because it never touches the push
 * layer. That is the 'pin the call site, not just the function' failure this repo has already paid for."
 * A CDC implementation whose `chunkConfigDeltaCompatible` returns false for `stored === current` — which
 * the shipped `/^(\d+)x(\d+)$/` parser did — makes every insertion edit a full re-push while every unit
 * test in `test/graph-cdc.test.ts` passes. Only a spy on the graph client can see that.
 *
 * The rest are the lazy rollout: an unchanged item keeps its existing chunking forever (no ~$76 burst),
 * EXCEPT where its stored chunking never covered the whole body — which un-strands the CHUNKCAP-1
 * population as a deliberate, priced side effect.
 */
describe("content-defined chunking (PIPEFF-3)", () => {
  /** A body already stored under the CDC config, projected once. Returns everything a test needs. */
  async function seedCdcItem(marker: string, chars: number, path: string) {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const fm = { source: "github" };
    const v1 = body(chars, marker);
    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    const first = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    return { seed, slug, fm, v1, first, path };
  }

  it("THE GATE — a 33-char insertion near the top of a CDC-stored item sends ≤ 3 episodes", async () => {
    const { seed, slug, fm, v1, first, path } = await seedCdcItem("g", 50_000, "github/repo/docs/churn.md");
    const chunkCount = chunkContent(v1).length;
    expect(chunkCount, "fixture must be the ~20-chunk shape the acceptance table is stated over")
      .toBeGreaterThanOrEqual(15);
    expect(first.pushedEpisodes).toHaveLength(chunkCount);
    const before = await ledgerRow(seed.teamId);
    expect(before?.chunk_config, "the item must be stored under the CDC config").toBe(CHUNK_CONFIG);

    // The edit the whole lever exists for. Under byte offsets this shifted every boundary after it and
    // re-extracted all 21 chunks (measured, docs/design/content-defined-chunking.md).
    const v2 = insertAt(v1, 1_200, "insertion of exactly thirty three");
    expect(v2.length - v1.length).toBe(33);
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });

    const second = new FakeGraphiti();
    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });

    expect(second.pushedEpisodes.length, "≤ 3 of ~20 — the spec's acceptance").toBeLessThanOrEqual(3);
    expect(second.pushedEpisodes.length, "…and it must actually push the changed chunk").toBeGreaterThan(0);
    expect(res.episodes).toBe(second.pushedEpisodes.length);
    // Every episode sent is a real chunk of v2 — a build that "saved" by sending stale content would
    // satisfy the count alone.
    const v2Chunks = new Set(chunkContent(v2));
    for (const e of second.pushedEpisodes) expect(v2Chunks.has(e.content)).toBe(true);
    // …and the ledger now describes v2's chunking in full, every hash of which the graph has received.
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_shas).toEqual(chunkContent(v2).map(sha));
    const bothPasses = new FakeGraphiti();
    bothPasses.pushes = [...first.pushes, ...second.pushes];
    await expectLedgerContained(seed.teamId, bothPasses);
  });

  it("THE GATE, negative control — the same edit under BYTE OFFSETS would have re-pushed everything", async () => {
    // Without this the gate above could pass on a fixture where the insertion happened to be cheap
    // under either algorithm, and would then be measuring nothing. Pure arithmetic, no DB.
    const v1 = body(50_000, "g");
    const v2 = insertAt(v1, 1_200, "insertion of exactly thirty three");
    const legacyBefore = new Set(chunkContentLegacy(v1, CHUNK_CHARS, MAX_EPISODE_CHUNKS));
    const legacyChurn = chunkContentLegacy(v2, CHUNK_CHARS, MAX_EPISODE_CHUNKS).filter(
      (c) => !legacyBefore.has(c)
    ).length;
    expect(legacyChurn, "the insertion cascade must be real for this fixture").toBeGreaterThanOrEqual(15);
  });

  it("LAZY ROLLOUT — a legacy-chunked item whose body never changed is left completely alone", async () => {
    // The ~$76 question. `chunkConfigDeltaCompatible` says false (different algorithms), so without the
    // completeness case every one of the 2,267 items would full-re-push on the first tick after deploy,
    // re-extracting the same text under different boundaries for zero new information.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/legacy-era.md";
    const fm = { source: "github" };
    const text = body(30_000, "L");

    // A row exactly as the byte-offset era left it: legacy config AND legacy hashes.
    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    const legacyConfig = `${CHUNK_CHARS}x40`;
    const legacyChunks = chunkContentUnderConfig(text, legacyConfig) ?? [];
    expect(legacyChunks.length, "fixture must be complete under the legacy cap").toBeLessThan(40);
    expect(legacyChunks.join("")).toBe(text);
    await db()
      .from("graph_episodes")
      .update({ chunk_shas: legacyChunks.map(sha), chunk_config: legacyConfig })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);
    const staged = await ledgerRow(seed.teamId);
    expect(staged?.chunk_config).toBe(legacyConfig);
    expect(chunkContent(text), "…and CDC really does chunk it differently").not.toEqual(legacyChunks);

    const fake = new FakeGraphiti();
    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes, "a complete legacy item re-pushes NOTHING").toEqual([]);
    expect(res.episodes).toBe(0);
    // And the ledger is untouched: the mixed corpus is honest about which algorithm each row holds.
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_config, "the row keeps its legacy chunking indefinitely").toBe(legacyConfig);
    expect(after?.chunk_shas).toEqual(legacyChunks.map(sha));
    expect(after?.projected_at).toBe(staged?.projected_at);
  });

  it("LAZY ROLLOUT — but a legacy item whose body CHANGES re-chunks under CDC, in full", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/legacy-then-edited.md";
    const fm = { source: "github" };
    const v1 = body(30_000, "E");

    await ingest(seed, { kind: "deliverable", path, body: v1, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    const legacyConfig = `${CHUNK_CHARS}x40`;
    await db()
      .from("graph_episodes")
      .update({
        chunk_shas: (chunkContentUnderConfig(v1, legacyConfig) ?? []).map(sha),
        chunk_config: legacyConfig,
      })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    const v2 = insertAt(v1, 1_200, "insertion of exactly thirty three");
    await ingest(seed, { kind: "deliverable", path, body: v2, access: "team", frontmatter: fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // Legacy hashes cannot identify CDC chunks, so this is a full push — once, and then the item is on
    // CDC and every subsequent edit takes the cheap path (the gate above).
    expect(fake.pushedEpisodes).toHaveLength(chunkContent(v2).length);
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_config).toBe(CHUNK_CONFIG);
    expect(after?.chunk_shas).toEqual(chunkContent(v2).map(sha));
  });

  it("THE DAY-ONE BURST — a legacy item CLIPPED at its old cap is NOT complete, and full-re-pushes", async () => {
    // The hole in the loose definition of "complete", and the reason condition (3) exists. Such a row
    // re-chunks under its stored config to exactly `cap` chunks that ALL hash correctly — conditions
    // (1), (2) and (4) pass — while every character past the cap has never entered the graph. Leaving
    // it alone would permanently re-strand exactly the population CHUNKCAP-1 existed to un-strand.
    // Priced in the spec at ~170 episodes / ~$2.50 across the 3 items over the old cap.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/ARCHITECTURE.md";
    const fm = { source: "github" };
    const text = body(CHUNK_CHARS * 60, "C"); // 60 legacy chunks against a stored cap of 40

    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    const legacyConfig = `${CHUNK_CHARS}x40`;
    const clipped = chunkContentUnderConfig(text, legacyConfig) ?? [];
    expect(clipped, "fixture must be CLIPPED, not merely large").toHaveLength(40);
    expect(clipped.join("").length).toBeLessThan(text.length);
    await db()
      .from("graph_episodes")
      .update({ chunk_shas: clipped.map(sha), chunk_config: legacyConfig })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushedEpisodes.length, "an incomplete item re-pushes under CDC").toBe(chunkContent(text).length);
    const after = await ledgerRow(seed.teamId);
    expect(after?.chunk_config).toBe(CHUNK_CONFIG);
    // …and the un-stranding is real: CDC delivers more of this body than the old cap ever did.
    expect(covered(text)).toBeGreaterThan(clipped.join("").length);
  });

  it("CAP SHRINK — a complete item under a LARGER stored cap is left alone (the explicit decision)", async () => {
    // PIPEFF-3 decided this rather than inheriting it: `chunkConfigDeltaCompatible` says "cannot vouch"
    // for a shrunk cap, and a naive third case would then re-push. The orphan tails a shrink creates
    // are not fixed by re-extracting the head either (nothing purges them), so paying for it buys
    // nothing. The helper's comment now says so instead of documenting the opposite.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const path = "github/repo/docs/shrunk.md";
    const fm = { source: "github" };
    const text = body(20_000, "K");
    const wideConfig = `cdc1-${CHUNK_CHARS}-1250-${CHUNK_MAX_CHARS}-${MAX_EPISODE_CHUNKS + 40}`;

    await ingest(seed, { kind: "deliverable", path, body: text, access: "team", frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    await db()
      .from("graph_episodes")
      .update({
        chunk_shas: (chunkContentUnderConfig(text, wideConfig) ?? []).map(sha),
        chunk_config: wideConfig,
      })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(fake.pushedEpisodes).toEqual([]);
    expect((await ledgerRow(seed.teamId))?.chunk_config).toBe(wideConfig);
  });

  /**
   * ONE MUTATION TEST PER ANDed TERM the third case INHERITS (the one-condition-per-fixture rule).
   *
   * Each fixture is a legacy-complete row — i.e. the completeness case says "leave it alone" — with
   * exactly ONE inherited term violated. If that term were dropped from the widened skip, the item
   * would skip and its content would never reach the group it belongs in. Each fixture trips one term
   * and one term only, so a green result names which term is doing the work.
   */
  async function seedLegacyCompleteRow(marker: string, path: string, access: "team" | "external" = "team") {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const fm = { source: "github" };
    const text = body(20_000, marker);
    await ingest(seed, { kind: "deliverable", path, body: text, access, frontmatter: fm });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });
    const row = await ledgerRow(seed.teamId);
    const legacyConfig = `${CHUNK_CHARS}x40`;
    const legacyChunks = chunkContentUnderConfig(text, legacyConfig) ?? [];
    await db()
      .from("graph_episodes")
      .update({ chunk_shas: legacyChunks.map(sha), chunk_config: legacyConfig })
      .eq("team_id", seed.teamId)
      .eq("source_id", row!.source_id);
    return { seed, slug, fm, text, path, row: row!, legacyConfig, legacyChunks };
  }

  it("inherited term: !tierChanged — a reclassified legacy-complete item still pushes to the new group", async () => {
    const f = await seedLegacyCompleteRow("T", "github/repo/docs/tier-flip.md");
    // ONLY the tier changes: same body, same legacy ledger, no pending flag, no sentinel.
    await ingest(f.seed, { kind: "deliverable", path: f.path, body: f.text, access: "external", frontmatter: f.fm });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.seed.teamId, teamSlug: f.slug, client: client(fake) });

    expect(fake.pushedEpisodes.length, "the new group holds none of this item").toBeGreaterThan(0);
    expect(fake.pushes[0]?.groupId).toBe(`${f.slug}_external`);
    expect((await ledgerRow(f.seed.teamId))?.pending_delete_group_id).toBe(`${f.slug}_team`);
  });

  it("inherited term: !purgeBeforeRepush — a legacy-complete item owing a purge on ITS OWN group pushes", async () => {
    const f = await seedLegacyCompleteRow("P", "github/repo/docs/purge-owed.md");
    // ONLY the pending flag is set, pointing at the group we would push to.
    await db()
      .from("graph_episodes")
      .update({ pending_delete_group_id: `${f.slug}_team`, pending_delete_at: new Date().toISOString() })
      .eq("team_id", f.seed.teamId)
      .eq("source_id", f.row.source_id);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.seed.teamId, teamSlug: f.slug, client: client(fake) });

    expect(fake.pushedEpisodes.length, "a purge is owed on the push target — re-push after it").toBeGreaterThan(0);
  });

  it("inherited term: the '' reconcile sentinel — a never-landed legacy-complete item pushes", async () => {
    const f = await seedLegacyCompleteRow("S", "github/repo/docs/never-landed-legacy.md");
    // ONLY the sentinel, reproduced exactly as reconcile leaves it: sha cleared, flag already cleared
    // by its own cleanup loop, chunk_shas intact. Nothing else in the skip can see this state.
    await db()
      .from("graph_episodes")
      .update({ content_sha256: "", pending_delete_group_id: null, pending_delete_at: null })
      .eq("team_id", f.seed.teamId)
      .eq("source_id", f.row.source_id);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: f.seed.teamId, teamSlug: f.slug, client: client(fake) });

    expect(fake.pushedEpisodes.length, "a re-queued row must not be 'left alone' as complete").toBe(
      chunkContent(f.text).length
    );
  });
});
