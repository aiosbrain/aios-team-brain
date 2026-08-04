import { describe, expect, it } from "vitest";
import type { GraphEpisode } from "@/lib/graph/graphiti-client";
import { projectSlackToGraph, projectItemsToGraph, deleteItemEpisodes, CHUNK_CHARS, MAX_EPISODE_CHUNKS, GROUP_SCAN_DEPTH } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import {
  reconcileProjectedEpisodes,
  LANDED_SCAN_DEPTH,
  GRACE_MS,
  LANDED_GRACE_MS,
  REQUEUE_MAX_PER_PASS,
} from "@/lib/graph/reconcile";
import { purgeItemsByPathPrefix } from "@/lib/ingest/purge";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

// Spec: the projector reads Slack transcripts from the brain and pushes them to Graphiti as
// episodes, idempotently, with tier-scoped group_ids. Verified on real Postgres with a MOCKED
// Graphiti client (no live graph service needed) — we assert the pushes + the graph_episodes state.

/** A minimal episode with a stable name — the only field the cleanup paths key on. */
function ep(name: string): GraphEpisode {
  return { content: "x", timestamp: "2020-01-01T00:00:00Z", sourceDescription: "x", name };
}

/** Age a team's outstanding tier cleanup past reconcile's straggler grace, so a test isolates the
 *  condition it's actually about rather than tripping over "too fresh to declare durable". */
async function backdateCleanup(teamId: string): Promise<void> {
  await db()
    .from("graph_episodes")
    .update({ projected_at: "2020-01-01T00:00:00Z", pending_delete_at: "2020-01-01T00:00:00Z" })
    .eq("team_id", teamId);
}

async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}

describe("Slack → Graphiti projector (real Postgres, mocked Graphiti)", () => {
  it("projects each transcript with a tier-scoped group_id and records state", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "alex shipped the payments service", access: "team" });
    await ingest(seed, { kind: "transcript", path: "slack/client/2.md", body: "kickoff with acme client", access: "external" });

    const fake = new FakeGraphiti();
    const res = await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(res.projected).toBe(2);
    expect(res.skipped).toBe(0);
    const groups = fake.pushes.map((p) => p.groupId).sort();
    expect(groups).toEqual([`${slug}_external`, `${slug}_team`]); // tier encoded in group_id (Graphiti-valid)

    // State recorded for both, keyed by source id.
    const { data: state } = await db().from("graph_episodes").select("source_id, group_id").eq("team_id", seed.teamId);
    expect((state ?? []).length).toBe(2);
  });

  it("is idempotent: a second run re-pushes nothing (unchanged content)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "stable thread", access: "team" });

    const first = new FakeGraphiti();
    await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    expect(first.pushes).toHaveLength(1);

    const second = new FakeGraphiti();
    const res = await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });
    expect(second.pushes).toHaveLength(0); // nothing re-pushed
    expect(res.projected).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it("re-projects when the content changes (content hash differs)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "v1 of the thread", access: "team" });
    await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    // Same path, new body → item updated in place (ingest versions it).
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "v2 — decision reversed", access: "team" });
    const again = new FakeGraphiti();
    const res = await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(again) });
    expect(again.pushes).toHaveLength(1); // changed content re-pushed
    expect(res.projected).toBe(1);
  });
});

// All ingestions (not just Slack) feed the graph: projectItemsToGraph projects every content-bearing
// kind and excludes config kinds (skill/blueprint). Verified on real Postgres with a mocked Graphiti.
describe("projectItemsToGraph — all ingestions (real Postgres, mocked Graphiti)", () => {
  it("projects all content kinds and excludes config kinds (skill)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "slack thread", access: "team" });
    await ingest(seed, { kind: "deliverable", path: "notion/spec.md", body: "product spec", access: "team" });
    await ingest(seed, { kind: "decision", path: "decisions/d1.md", body: "we chose postgres", access: "team" });
    await ingest(seed, { kind: "task", path: "tasks/t1.md", body: "ship the graph", access: "team" });
    await ingest(seed, { kind: "skill", path: "skills/s.md", body: "skill manifest", access: "team" }); // excluded

    const fake = new FakeGraphiti();
    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(res.projected).toBe(4); // transcript + deliverable + decision + task; skill excluded
    expect(fake.pushes).toHaveLength(4);
  });

  // Spec: a large item is CHUNKED into several small episodes (not truncated to one) so each stays
  // under Graphiti's extraction output cap — an oversized episode overflows it and never becomes facts
  // (prod 2026-06/07), so its work would be invisible in the graph + arcs. Chunking preserves content.
  it("chunks an oversized item into ≤ MAX_EPISODE_CHUNKS small episodes so extraction can't overflow", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const huge = "x ".repeat(40_000); // ~80k chars, far beyond one chunk
    await ingest(seed, { kind: "deliverable", path: "notion/huge.md", body: huge, access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushes).toHaveLength(1); // one addEpisodes call for the item…
    const eps = fake.pushes[0].episodes;
    expect(eps.length).toBe(MAX_EPISODE_CHUNKS); // …carrying several chunk episodes, capped
    for (const e of eps) expect(e.content.length).toBeLessThanOrEqual(CHUNK_CHARS); // each fits the extractor
    // Multi-chunk items get the `#k` suffix; each chunk still resolves back to the one item.
    expect(eps[0].name).toMatch(/^items:.+#0$/);
    expect(eps[1].name).toMatch(/^items:.+#1$/);
  });
});

// The runner (lib/graph/run.ts) is the on-ramp the admin action + scheduler call: it resolves the
// team from the DB, then projects. This exercises that team-resolution + aggregation on real Postgres.
describe("runGraphProjection runner (real Postgres, mocked Graphiti)", () => {
  it("resolves the team, projects its transcripts, and is idempotent on re-run", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "alpha thread", access: "team" });
    await ingest(seed, { kind: "transcript", path: "slack/client/2.md", body: "beta thread", access: "external" });

    const fake = new FakeGraphiti();
    const first = await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db() });
    expect(first.configured).toBe(true);
    expect(first.teams).toBe(1);
    expect(first.projected).toBe(2);
    expect(fake.pushes.map((p) => p.groupId).sort()).toEqual([`${slug}_external`, `${slug}_team`]);

    const second = await runGraphProjection({ teamId: seed.teamId, client: client(new FakeGraphiti()), db: db() });
    expect(second.projected).toBe(0);
    expect(second.skipped).toBe(2); // idempotent across the runner too
  });

  it("dates an episode by the item's persisted work_at, and a re-sync tick does NOT re-date it (H4)", async () => {
    // The failure this closes: the projector fell back to `synced_at` for any item the source didn't
    // date, and every 30-minute tick bumps `synced_at`. So a months-old doc was stamped "now" on every
    // pass — flooding the newest-facts pool and pinning arcs about old work at the top of Pulse. The
    // episode's `valid_at` must come from the stored work-time and stay put across re-syncs.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const workedAt = "2026-05-02T08:00:00.000Z";
    await ingest(seed, {
      kind: "artifact",
      path: "commits/abc.md",
      body: "fix the payment retry",
      access: "team",
      frontmatter: { committed_at: workedAt },
    });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(fake.pushes[0].episodes[0].timestamp).toBe(workedAt);

    // A later re-sync tick bumps synced_at corpus-wide. Force the body to change so the item actually
    // re-projects (an unchanged one is skipped, which would pass vacuously).
    await ingest(seed, {
      kind: "artifact",
      path: "commits/abc.md",
      body: "fix the payment retry (amended)",
      access: "team",
      frontmatter: { committed_at: workedAt },
    });
    const second = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });
    expect(second.pushes[0].episodes[0].timestamp).toBe(workedAt); // still the WORK time, not now
  });

  it("dates an UNDATED item by when we first saw it — not by the tick that re-synced it", async () => {
    // The other half of H4: a Linear/Plane deliverable or any doc whose metadata key we don't know has
    // no work-time at all. Falling back to `synced_at` re-dated it on every tick; falling back to
    // first-seen dates it once and leaves it there.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/undated.md", body: "no date anywhere", access: "team" });

    const { data } = await db()
      .from("items")
      .select("created_at")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/undated.md")
      .maybeSingle();
    const firstSeen = new Date((data as { created_at: string | Date }).created_at).toISOString();

    // Age synced_at as a later tick would, then re-project with a changed body.
    await db().from("items").update({ synced_at: new Date().toISOString() }).eq("team_id", seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/undated.md", body: "still no date, edited", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(fake.pushes[0].episodes[0].timestamp).toBe(firstSeen);
  });

  it("re-purges the external arc cache once a tier move has actually left the graph", async () => {
    // The window `lib/ingest`'s purge cannot close on its own: arcs are synthesized from the external
    // Graphiti GROUP, which only this run cleans. Between the ingest-time purge and here, any arc rebuild
    // re-reads the old-tier facts and `commitArcs` stamps that result FRESH — so a cache row can be
    // re-poisoned AFTER the reclassification and outlive the graph heal by a full 4h TTL. The projection
    // run has to invalidate again once the group is clean.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalArcKey = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the client spec", access: "external" });

    const fake = new FakeGraphiti();
    await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db() });
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the client spec", access: "team" });

    // Stand in for the re-poisoning rebuild: a fresh external arc row synthesized from the still-dirty
    // external group after ingest purged it.
    await db()
      .from("arc_cache")
      .upsert(
        {
          team_id: seed.teamId,
          group_key: externalArcKey,
          arcs: JSON.stringify([{ title: "arc built from the retracted spec" }]),
          facts_hash: "h",
          computed_at: new Date().toISOString(),
        },
        { onConflict: "team_id,group_key" }
      );

    const run = await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db() });
    expect(await fake.listEpisodes(externalArcKey)).toHaveLength(0); // group cleaned…

    const { data } = await db()
      .from("arc_cache")
      .select("group_key")
      .eq("team_id", seed.teamId)
      .eq("group_key", externalArcKey)
      .maybeSingle();
    expect(data).toBeNull(); // …and the re-poisoned row went with it
    expect(run.ok).toBe(true);
  });

  it("does NOT purge the external arc cache when the tier move was a WIDENING", async () => {
    // The direction-awareness the ingest side is built on has to hold here too. A team→external move also
    // shuffles episodes between groups, but nothing leaked — the external payload is merely incomplete.
    // Hard-purging would force a cold LLM re-synthesis with no prior for the empty-clobber guard to
    // protect, which is the blank-panel failure mode (2026-07) we deliberately avoid.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalArcKey = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the internal spec", access: "team" });

    const fake = new FakeGraphiti();
    await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db() });
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the internal spec", access: "external" });

    await db()
      .from("arc_cache")
      .upsert(
        {
          team_id: seed.teamId,
          group_key: externalArcKey,
          arcs: JSON.stringify([{ title: "an arc an external viewer may see" }]),
          facts_hash: "h",
          computed_at: new Date().toISOString(),
        },
        { onConflict: "team_id,group_key" }
      );

    await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db() });
    expect(await fake.listEpisodes(externalArcKey)).toHaveLength(1); // episodes moved INTO external…

    const { data } = await db()
      .from("arc_cache")
      .select("group_key")
      .eq("team_id", seed.teamId)
      .eq("group_key", externalArcKey)
      .maybeSingle();
    expect(data).not.toBeNull(); // …and the row survives, to be refreshed on its TTL
  });

  // Spec for audit H2: the runner must PAGE through the whole backlog. Before the fix it re-scanned
  // only the oldest `limit` rows every run, so items beyond that window were never projected.
  it("pages the full backlog beyond a single batch limit (audit H2)", async () => {
    const seed = await seedTeam();
    for (let i = 0; i < 5; i++) {
      await ingest(seed, { kind: "transcript", path: `slack/eng/${i}.md`, body: `thread ${i}`, access: "team" });
      // Stamp strictly-increasing synced_at so the cursor advances deterministically (no ties).
      await db()
        .from("items")
        .update({ synced_at: `2026-06-20T10:0${i}:00Z` })
        .eq("team_id", seed.teamId)
        .eq("path", `slack/eng/${i}.md`);
    }

    const fake = new FakeGraphiti();
    // limit=2: without paging only the oldest 2 ever project; with the cursor all 5 do.
    const res = await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db(), limit: 2 });
    expect(res.projected).toBe(5);
    expect(fake.pushes).toHaveLength(5);
    const { data: state } = await db().from("graph_episodes").select("source_id").eq("team_id", seed.teamId);
    expect((state ?? []).length).toBe(5);
  });
});

// Spec for audit M6: a tier reclassification (e.g. external→team) must not leave the old episode
// searchable in the old Graphiti group forever. Verified on real Postgres with the stateful fake.
describe("tier reclassification cleans up the stale episode (audit M6)", () => {
  it("deletes the episode from the old group when a re-synced item's access tier changes", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    const first = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(first.projected).toBe(1);
    const externalGroup = `${slug}_external`;
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Re-sync the same item, now team-tier (a legitimate access change on re-push — the real `aios
    // push` CLI hashes the whole file incl. frontmatter, so a tier change always changes the sha;
    // the test's `ingest()` helper hashes only `body`, so bump it here to model that honestly).
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, now team-tier", access: "team" });
    const second = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(second.projected).toBe(1);

    // Old group no longer has it; new group does.
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);
    const teamGroup = `${slug}_team`;
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1);

    // graph_episodes reflects the new group.
    const { data: state } = await db()
      .from("graph_episodes")
      .select("group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((state as { group_id: string }).group_id).toBe(teamGroup);
  });
});

// Spec for Pass-1 review B2: the tier-reclassification cleanup must be DURABLE. The projector's inline
// delete is best-effort; if it silently fails (or misses a late-created chunk) and the ledger flips to
// the new group, the old-tier episodes must not stay searchable forever. `pending_delete_group_id`
// records the old group and reconcile retries the purge until the old group is verified empty.
describe("tier reclassification cleanup is durable across a failed inline delete (Pass-1 review B2)", () => {
  it("records the old group as pending-delete and reconcile finishes the purge after an inline delete failure", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    const teamGroup = `${slug}_team`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Reclassify external→team, but the inline delete of the OLD group FAILS (a Graphiti blip).
    fake.failDeletes = true;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, now team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // New group has the episode; the OLD group STILL has it (inline delete failed) — pre-B2 this leaked
    // forever because the ledger flipped group_id and nothing retried.
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // The ledger points at the new group AND records the old group as pending cleanup.
    const { data: row } = await db()
      .from("graph_episodes")
      .select("id, group_id, pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    const r = row as { id: string; group_id: string; pending_delete_group_id: string | null };
    expect(r.group_id).toBe(teamGroup);
    expect(r.pending_delete_group_id).toBe(externalGroup);

    // Age it past the grace so reconcile may finalize (not premature).
    await backdateCleanup(seed.teamId);

    // Graphiti recovers. Pass 1 purges the old-group straggler (leak closed) but keeps the flag…
    fake.failDeletes = false;
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);

    // …and pass 2 confirms the old group empty and clears the flag (converges).
    const pass2 = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(pass2.cleaned).toBe(1);
    const { data: after } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((after as { pending_delete_group_id: string | null }).pending_delete_group_id).toBeNull();
  });

  it("preserves the pending-cleanup flag when the NEW-group episode never lands (re-queue must not drop it)", async () => {
    // The conjunction Fable's review surfaced: the landed-check re-queues a row whose new-group episode
    // never landed (a worker crash — a documented failure mode) by DELETING it. If that row still owed an
    // old-group cleanup, the delete silently loses `pending_delete_group_id` and the projector's re-push
    // starts fresh (tierChanged false → flag null) — the old tier stays searchable forever with nothing
    // to retry it. The re-queue must therefore preserve a flagged row instead of deleting it.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    const item = await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Reclassify external→team with BOTH failures: the old-group delete fails (flag set) AND the
    // new-group episode never materializes (worker crash → the landed-check will want to re-queue).
    fake.failDeletes = true;
    fake.neverLands.add(`items:${item.id}`);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, now team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // Past grace so the landed-check judges it (and would delete the row pre-fix).
    await db()
      .from("graph_episodes")
      .update({ projected_at: "2020-01-01T00:00:00Z" })
      .eq("team_id", seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.reQueued).toBe(1); // still re-queued for re-push…

    // …but the row SURVIVES carrying its cleanup debt (pre-fix this row was deleted → leak forever).
    const { data: row } = await db()
      .from("graph_episodes")
      .select("content_sha256, pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect(row).not.toBeNull();
    const r = row as { content_sha256: string; pending_delete_group_id: string | null };
    expect(r.pending_delete_group_id).toBe(externalGroup); // cleanup still owed + retryable
    expect(r.content_sha256).toBe(""); // sentinel → the projector re-pushes it like a deleted row

    // And once Graphiti recovers, the cleanup actually completes (converges, no permanent leak).
    fake.failDeletes = false;
    fake.neverLands.clear();
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);
  });

  it("a content-only re-projection (same tier) does not clobber a pending-cleanup flag", async () => {
    // The flag's durability rests on the pg upsert only SETting columns present in the payload (the
    // projector omits `pending_delete_group_id` when the tier didn't change). Pin that behavior: a
    // routine content re-push mid-cleanup must not wipe the outstanding cleanup debt.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v1", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    fake.failDeletes = true; // reclassification leaves cleanup owed
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v2 team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // A later ordinary content edit at the SAME tier → re-projection with tierChanged=false.
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v3 same tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const { data } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((data as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(externalGroup);
  });

  it("holds the flag for the FULL cleanup grace — 30 min past the landed grace is still too fresh", async () => {
    // Guards the grace's LENGTH, not just its existence: Graphiti's extraction queue has wedged for far
    // longer than the 5-min landed grace, so a straggler chunk of the pre-reclassification push can land
    // well after the old group first looks empty. Aged to 30 min — past the landed grace, inside the
    // cleanup grace — so sharing the short window (the pre-fix behavior) would go RED here.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    // The inline delete SUCCEEDED here, so the old group already looks empty.

    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    await db()
      .from("graph_episodes")
      .update({ projected_at: thirtyMinAgo, pending_delete_at: thirtyMinAgo })
      .eq("team_id", seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.cleaned).toBe(0); // too fresh to declare durable
    expect(res.pendingCleanups).toBe(1);
    const { data } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((data as { pending_delete_group_id: string | null }).pending_delete_group_id).not.toBeNull();
  });

  it("an ordinary content re-push mid-cleanup does not restart the grace clock", async () => {
    // The grace anchors on `pending_delete_at` (when the cleanup was recorded), not `projected_at`
    // (bumped by EVERY re-push). Anchored on projected_at, an item edited more often than the grace
    // window would keep its flag — and its old-tier episodes' cleanup — outstanding forever.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v1", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = true; // reclassification leaves the cleanup owed
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v2 team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = false;

    await backdateCleanup(seed.teamId); // the cleanup itself is old enough to finalize
    // …but a fresh same-tier content edit re-projects and stamps `projected_at = now`.
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v3 same tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId); // purges the old-group straggler
    const pass2 = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(pass2.cleaned).toBe(1); // converged despite the fresh projected_at
    expect(pass2.pendingCleanups).toBe(0);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);
  });

  it("an item REDACTED to an empty body has its old-tier episodes purged (the skip used to strand them)", async () => {
    // The door B2 didn't cover: `toEpisodes` → [] made the projector `continue` BEFORE it ever read the
    // ledger, so a doc blanked upstream (and reclassified external→team in the same edit) kept its
    // pre-redaction episodes — and the facts extracted from them — searchable in the EXTERNAL group
    // forever, with `pending_delete_group_id` never set and nothing to retry. Same permanent leak,
    // different entrance.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the client-visible spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Redacted upstream: body blanked AND narrowed to team-tier. The inline purge fails (a Graphiti
    // blip), so the durable path is what has to carry it.
    fake.failDeletes = true;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "   ", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const { data: row } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((row as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(externalGroup);

    // Graphiti recovers → the external group is actually emptied, and the cleanup converges.
    fake.failDeletes = false;
    await backdateCleanup(seed.teamId);
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);
    const pass2 = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(pass2.pendingCleanups).toBe(0);
  });

  it("an item whose KIND changes to a non-projectable one has its episodes purged, not stranded", async () => {
    // Same class, third entrance: the projector's kind filter used to drop the row from its query
    // entirely, so a deliverable re-pushed as a `skill` vanished from the projector's view with its
    // episodes — and their extracted facts — left in the graph permanently.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const teamGroup = `${slug}_team`;
    await ingest(seed, { kind: "deliverable", path: "docs/thing.md", body: "content worth extracting", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1);

    await ingest(seed, { kind: "skill", path: "docs/thing.md", body: "now a config manifest", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(await fake.listEpisodes(teamGroup)).toHaveLength(0); // inline purge succeeded
    await backdateCleanup(seed.teamId);
    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.pendingCleanups).toBe(0); // and the flag converges rather than sticking
  });

  it("re-pushing a restored body into a group with an outstanding purge does not silently drop the item", async () => {
    // The hazard the redaction path creates: the pending purge deletes by ITEM ID, so if the body comes
    // back before reconcile finishes, a still-set flag would delete the episodes we just pushed and the
    // item would be absent from the graph while the ledger reported it projected. The projector must
    // purge-then-push and clear the flag when it pushes back into the pending group.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const teamGroup = `${slug}_team`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v1 content", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = true;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "  ", access: "team" }); // redacted
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = false;

    // Restored before reconcile ran.
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v2 restored content", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    await backdateCleanup(seed.teamId);
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    // The restored content is still in the graph — exactly one live episode, not zero.
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1);
  });

  it("keeps the cleanup owed when the purge-before-re-push FAILS (a swallowed error must not clear it)", async () => {
    // The flag is the only retry handle. Clearing it on a purge we merely ATTEMPTED — the delete is
    // best-effort and swallows Graphiti errors — abandons the cleanup silently: the pre-redaction
    // episodes sit in the group forever and `pendingCleanups` reads 0, i.e. the exact false-clear this
    // mechanism exists to prevent, one layer in.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const teamGroup = `${slug}_team`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v1 secret content", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = true;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "  ", access: "team" }); // redacted
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // Body restored while Graphiti is STILL refusing deletes → the purge-then-re-push purge fails.
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v2 sanitized", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const { data } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((data as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(teamGroup);

    // And it converges once Graphiti recovers: reconcile purges, the sentinel re-queue re-pushes.
    fake.failDeletes = false;
    await backdateCleanup(seed.teamId);
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    await backdateCleanup(seed.teamId);
    const last = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(last.pendingCleanups).toBe(0);
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1); // only the sanitized content survives
  });

  it("does not judge a row younger than the PROJECTION INTERVAL (H7's feedback loop)", async () => {
    // The amplifier. The grace was 5 minutes against a queue whose drain rate is LLM-bound: a backlog
    // deeper than that made reconcile read every still-queued episode as "never landed", delete its
    // ledger row, and hand it back to the projector — which re-pushed it, deepening the very backlog
    // that caused the misjudgement. Positive feedback, and a large backfill trips it deterministically.
    //
    // Re-queuing sooner than the projector's own interval buys nothing anyway (the row can't be
    // re-pushed until that tick), so the grace is at least one full projection cycle. That removes the
    // loop for almost no healing latency — "almost" because phase offset can push a genuinely crashed
    // episode to the cycle after next.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.store.clear(); // the group reads empty, exactly as a queued-but-unextracted push does

    // Older than the old 5-min grace, younger than one projection cycle — the window where the loop
    // used to live. Asserted rather than assumed: with a short GRAPH_PROJECT_MINUTES the two graces
    // coincide and there'd be no such window, which would make the test below vacuously green.
    const ageMs = GRACE_MS + 60_000;
    expect(ageMs).toBeGreaterThan(GRACE_MS);
    expect(ageMs).toBeLessThan(LANDED_GRACE_MS);
    const between = new Date(Date.now() - ageMs).toISOString();
    await db().from("graph_episodes").update({ projected_at: between }).eq("team_id", seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.reQueued).toBe(0); // still within one projection cycle — not yet evidence of a crash
    const { data } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId);
    expect((data ?? []).length).toBe(1); // the ledger row survives
  });

  it("THROTTLES re-queues: many absent rows at once is a backlog, not many crashed workers", async () => {
    // The blast-radius cap. One crashed worker loses one episode; a wedged queue or an outage makes
    // EVERY row look absent at once. Re-queuing all of them is what turns an incident into a re-push
    // storm, so a pass that wants to re-queue more than the cap does the cap and reports the rest —
    // the ledger rows survive for the next pass, and nothing is lost.
    // The cap is passed EXPLICITLY rather than read from `REQUEUE_MAX_PER_PASS`. Sizing the fixture off
    // the env-derived constant means the seed count grows with the knob — and a large value turns this
    // into a multi-thousand-row ingest (or, if a mutation sets it to MAX_SAFE_INTEGER, an unbounded
    // loop that times out instead of failing on behaviour). A small explicit cap tests the same branch.
    const cap = 3;
    const overBy = 2;
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    for (let i = 0; i < cap + overBy; i++) {
      await ingest(seed, { kind: "deliverable", path: `docs/d${i}.md`, body: `doc ${i}`, access: "team" });
    }
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.store.clear(); // the whole group reads empty — a wedge, not N independent crashes
    await db()
      .from("graph_episodes")
      .update({ projected_at: "2020-01-01T00:00:00Z" })
      .eq("team_id", seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId, cap);
    expect(res.reQueued).toBe(cap);
    expect(res.requeueThrottled).toBe(overBy); // reported, not silently dropped
    const { data } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId);
    expect((data ?? []).length).toBe(overBy); // the un-judged rows are still there for the next pass

    // …and the DEFAULT path throttles too. Without this the spec above only ever exercises a parameter
    // production never passes: a regression that unbound the default from the constant — or set it to
    // Infinity — would keep every assertion above green while the real call path had no cap at all. So
    // this half runs with NO cap argument and must see the constant bite.
    //
    // Bounding the fixture on the constant is what made the earlier version of this test explode under a
    // MAX_SAFE_INTEGER mutation, so the size is asserted sane BEFORE it's used as a loop bound.
    expect(Number.isInteger(REQUEUE_MAX_PER_PASS)).toBe(true);
    expect(REQUEUE_MAX_PER_PASS).toBeGreaterThanOrEqual(1);
    expect(REQUEUE_MAX_PER_PASS).toBeLessThanOrEqual(1000);
    const fresh = await seedTeam();
    const freshSlug = await teamSlugFor(fresh.teamId);
    for (let i = 0; i < REQUEUE_MAX_PER_PASS + 1; i++) {
      await ingest(fresh, { kind: "deliverable", path: `docs/e${i}.md`, body: `doc ${i}`, access: "team" });
    }
    const fake2 = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: fresh.teamId, teamSlug: freshSlug, client: client(fake2) });
    fake2.store.clear();
    await db()
      .from("graph_episodes")
      .update({ projected_at: "2020-01-01T00:00:00Z" })
      .eq("team_id", fresh.teamId);
    const dflt = await reconcileProjectedEpisodes(db(), client(fake2), fresh.teamId);
    expect(dflt.reQueued).toBe(REQUEUE_MAX_PER_PASS);
    expect(dflt.requeueThrottled).toBe(1); // one over the default cap — pinned, not merely "under it"
  });

  it("a landed-check on a SATURATED group re-queues nothing and reports the saturation", async () => {
    // The landed-check's own window. Reading a full window as "none of these landed" would re-push the
    // WHOLE group every pass — which grows the group, pushes more rows out of the window, and re-pushes
    // more next pass: a self-amplifying loop. Skip the judgement, and never silently (no-silent-caps).
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const teamGroup = `${slug}_team`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    // Bury the item's episode past the landed window with unrelated newer ones.
    await fake.addEpisodes(teamGroup, Array.from({ length: LANDED_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
    await backdateCleanup(seed.teamId); // past the landed grace, so only saturation can hold the verdict

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.saturatedGroups).toBe(1);
    expect(res.reQueued).toBe(0); // NOT judged "never landed"
    const { data } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId);
    expect((data ?? []).length).toBe(1); // and the ledger row survives
  });

  it("deleteItemEpisodes really deletes an item buried under newer episodes (the default window would miss it)", async () => {
    // OUTCOME, not the call parameter: the target is the OLDEST episode in the group and every later
    // episode pushes it further from the window's head. Graphiti's `lastN` returns the most RECENT n, so
    // a shallow scan resolves no uuid and the delete "succeeds" having deleted nothing — the silent
    // no-op that let old-tier facts stay searchable. The deep scan has to actually remove it.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const fake = new FakeGraphiti();
    await fake.addEpisodes(group, [ep("items:abc")]);
    await fake.addEpisodes(group, Array.from({ length: GROUP_SCAN_DEPTH - 2 }, (_, i) => ep(`items:filler-${i}`)));

    // A shallow scan (the pre-fix default) genuinely cannot see it — that's what makes this non-vacuous.
    expect((await fake.listEpisodes(group, 5)).some((e) => e.name === "items:abc")).toBe(false);

    const deleted = await deleteItemEpisodes(client(fake), group, "abc");
    expect(deleted).toBe(1);
    expect((await fake.listEpisodes(group)).some((e) => e.name === "items:abc")).toBe(false);
  });

  it("a SATURATED old-group scan never clears the cleanup flag (not-found is inconclusive, not empty)", async () => {
    // When the scan comes back full, the item's episodes MIGHT be just beyond the window — reading that
    // as "the old group is empty" is the original bug at a larger N. The flag must stay set (and stay
    // observable) rather than declaring a phantom cleanup.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = true; // reclassification leaves the cleanup owed
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = false;

    // The item's own episode is now the OLDEST in the external group; fill the window past capacity so
    // the scan saturates and can no longer see it.
    await fake.addEpisodes(externalGroup, Array.from({ length: GROUP_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
    await backdateCleanup(seed.teamId); // past the grace, so ONLY saturation can hold the flag

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.cleaned).toBe(0);
    expect(res.pendingCleanups).toBe(1); // and it stays visible in the run summary
    const { data } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((data as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(externalGroup);
  });
});

// Spec for audit H3 (Option B): a recorded episode that never actually landed in Graphiti (the
// worker crashed before/while extracting it) must be cleared so the next projector run re-pushes
// it — and one that DID land gets its episode_uuid backfilled, not touched otherwise.
describe("reconcileProjectedEpisodes (audit H3, real Postgres)", () => {
  it("re-queues a recorded episode that never landed, and leaves a landed one alone (backfilling its uuid)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const oldTimestamp = "2020-01-01T00:00:00Z"; // well outside the 5-min grace window

    // "Landed" row: the fake's store actually has this episode.
    const landedItem = await ingest(seed, { kind: "deliverable", path: "docs/landed.md", body: "landed", access: "team" });
    const fake = new FakeGraphiti();
    await fake.addEpisodes(group, [{ content: "landed", timestamp: oldTimestamp, sourceDescription: "x", name: `items:${landedItem.id}` }]);
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: landedItem.id,
      group_id: group, content_sha256: "deadbeef", projected_at: oldTimestamp,
    });

    // "Crashed" row: recorded as projected, but the fake never actually stored it.
    const crashedItem = await ingest(seed, { kind: "deliverable", path: "docs/crashed.md", body: "crashed", access: "team" });
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: crashedItem.id,
      group_id: group, content_sha256: "cafef00d", projected_at: oldTimestamp,
    });

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.confirmed).toBe(1);
    expect(res.reQueued).toBe(1);

    // The landed row survives and now carries the resolved episode_uuid.
    const { data: landedRow } = await db()
      .from("graph_episodes")
      .select("episode_uuid")
      .eq("team_id", seed.teamId)
      .eq("source_id", landedItem.id)
      .maybeSingle();
    expect((landedRow as { episode_uuid: string | null }).episode_uuid).toBeTruthy();

    // The crashed row is gone — a subsequent projector run will treat it as unprojected.
    const { data: crashedRow } = await db()
      .from("graph_episodes")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("source_id", crashedItem.id)
      .maybeSingle();
    expect(crashedRow).toBeNull();

    const reproject = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(reproject.projected).toBeGreaterThanOrEqual(1); // the crashed item gets re-pushed
  });

  it("does not judge a row projected within the grace window (still may be processing)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const item = await ingest(seed, { kind: "deliverable", path: "docs/fresh.md", body: "fresh", access: "team" });
    // Recorded just now, and the fake never stored it — but it's too fresh to judge.
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: item.id,
      group_id: group, content_sha256: "abc123", projected_at: new Date().toISOString(),
    });

    const res = await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);
    expect(res.confirmed).toBe(0);
    expect(res.reQueued).toBe(0); // left alone, not prematurely cleared

    const { data } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId).eq("source_id", item.id).maybeSingle();
    expect(data).not.toBeNull();
  });
});

/**
 * Spec: content PURGED from the brain must leave the graph too, durably.
 *
 * `graph_episodes` has no FK to `items`, so deleting an item on its own strands the ledger row — and,
 * far worse, leaves the extracted facts answering questions in Graphiti with nothing pointing at
 * them. For a private channel or a message the author deleted at the source, a removal that stops at
 * Postgres is not a removal. The purge therefore deletes the episodes inline and leaves a TOMBSTONE
 * (the same `pending_delete_group_id` mechanism the tier cleanup uses) so a Graphiti blip is retried
 * rather than silently abandoned.
 */
describe("purge → graph cleanup (real Postgres, mocked Graphiti)", () => {
  it("retires the episodes and converges — even when the inline delete fails", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const item = await ingest(seed, { kind: "transcript", path: "slack/c0priv/1.md", body: "private thread", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(group)).toHaveLength(1);

    // Purge while Graphiti is blipping: the inline delete fails, so the facts are STILL in the graph.
    fake.failDeletes = true;
    await purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0priv/", "slack channel is private", {
      client: client(fake),
    });
    expect(await fake.listEpisodes(group)).toHaveLength(1); // not gone yet — this is the leak window

    // The item is gone from the brain, but the ledger row SURVIVES carrying the cleanup debt.
    const { data: gone } = await db().from("items").select("id").eq("id", item.id).maybeSingle();
    expect(gone).toBeNull();
    const { data: row } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((row as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(group);

    // Graphiti recovers: reconcile finishes the delete, and once the group is verified empty the
    // tombstone itself is dropped (clearing the flag instead would orphan the row forever — the
    // projector only ever revisits rows whose item still exists).
    fake.failDeletes = false;
    await backdateCleanup(seed.teamId);
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(group)).toHaveLength(0); // facts gone from the graph
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    const { data: after } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId);
    expect(after ?? []).toHaveLength(0); // no orphan ledger row left behind
  });
});

/**
 * Spec: the purge must survive a CONCURRENT projector batch.
 *
 * The projector runs on its own scheduler, so it can already hold an item's body in memory when the
 * ingest tick purges that item. It then re-pushes the content and — via the `purgeBeforeRepush`
 * branch — CLEARS the pending-delete flag. The ledger row afterwards looks perfectly healthy (fresh
 * sha, no flag), the projector never revisits it (its item is gone), and the purged content stays
 * searchable in Graphiti forever with nothing to retry. Flag-based detection can't see this; only
 * orphan-ness can.
 */
describe("purge vs a racing projector (real Postgres, mocked Graphiti)", () => {
  it("re-purges an orphan whose episodes were re-pushed after the item was deleted", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const item = await ingest(seed, { kind: "transcript", path: "slack/c0priv/1.md", body: "private thread", access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    await purgeItemsByPathPrefix(db(), seed.teamId, "slack/c0priv/", "private", { client: client(fake) });
    expect(await fake.listEpisodes(group)).toHaveLength(0);

    // The racing projector lands: it re-pushes the body it still held and clears the flag. Written
    // directly because the projector can no longer reach this item (its row is gone) — this is the
    // exact end state of `projectItemsToGraph`'s `purgeBeforeRepush` branch: `addEpisodes(groupId, …)`
    // followed by the upsert whose `pending` object is `{pending_delete_group_id: null,
    // pending_delete_at: null}`. If that branch's bookkeeping changes, this must change with it.
    await fake.addEpisodes(group, [ep(`items:${item.id}`)]);
    await db()
      .from("graph_episodes")
      .update({ content_sha256: "f".repeat(64), pending_delete_group_id: null, pending_delete_at: null })
      .eq("team_id", seed.teamId);
    expect(await fake.listEpisodes(group)).toHaveLength(1); // private content is BACK in the graph

    // Reconcile notices the row has no item and retires it again.
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(group)).toHaveLength(0);

    // …and converges: once the group is verified empty past the grace, the row goes too.
    await backdateCleanup(seed.teamId);
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    const { data: after } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId);
    expect(after ?? []).toHaveLength(0);
  });

  it("leaves a HEALTHY tier-cleanup row alone (orphan detection must not misfire)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = true;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.failDeletes = false;
    await backdateCleanup(seed.teamId);

    // The item is ALIVE, so this is a tier cleanup, not an orphan: the flag clears and the row STAYS.
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    const { data } = await db()
      .from("graph_episodes")
      .select("group_id, pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect(data).not.toBeNull();
    const r = data as { group_id: string; pending_delete_group_id: string | null };
    expect(r.pending_delete_group_id).toBeNull();
    expect(r.group_id).not.toBe(externalGroup);
  });
});

/**
 * Spec: for a source whose body is a re-render of content the source can RETRACT (Slack), a re-push
 * must REPLACE its episodes, not append to them.
 *
 * `addEpisodes` does not overwrite by name — Graphiti keeps the old episode and the facts extracted
 * from it. So a message deleted in Slack would keep answering questions through the graph after
 * Postgres had forgotten it, on the surface that is actually served. Shrinking past a chunk boundary
 * is worse: the orphan tail episode isn't even overwritten in name.
 */
describe("retractable sources replace their episodes (real Postgres, mocked Graphiti)", () => {
  it("drops the pre-edit episode when a slack thread's body changes", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const fake = new FakeGraphiti();

    await ingest(seed, {
      kind: "transcript", path: "slack/c0pub/1.md", access: "team",
      body: "root\n\n---\n\nsecret reply", frontmatter: { source: "slack" },
    });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(group)).toHaveLength(1);

    // The reply is deleted at the source; the next sync re-renders the thread without it.
    await ingest(seed, {
      kind: "transcript", path: "slack/c0pub/1.md", access: "team",
      body: "root", frontmatter: { source: "slack" },
    });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const after = await fake.listEpisodes(group);
    expect(after).toHaveLength(1); // replaced, not appended
    expect(fake.pushes.at(-1)?.episodes[0].content).toContain("root");
    expect(fake.pushes.at(-1)?.episodes[0].content).not.toContain("secret reply");
  });

  it("records a pending cleanup when the retract-delete FAILS, so it isn't stranded", async () => {
    // `addEpisodes` lands regardless, so a swallowed failure leaves the pre-deletion episode in the
    // graph with a fresh sha on the ledger: the landed check is satisfied by the new push, orphan
    // repair needs the item to be GONE, and no flag was recorded — nothing would ever revisit it, and
    // the retracted text keeps answering questions forever.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const fake = new FakeGraphiti();

    await ingest(seed, {
      kind: "transcript", path: "slack/c0pub/1.md", access: "team",
      body: "root\n\n---\n\nsecret reply", frontmatter: { source: "slack" },
    });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    fake.failDeletes = true; // Graphiti blips exactly when the retract-delete runs
    await ingest(seed, {
      kind: "transcript", path: "slack/c0pub/1.md", access: "team",
      body: "root", frontmatter: { source: "slack" },
    });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const { data: row } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((row as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(group);

    // …and it converges: the next pass retries the delete and only then clears the flag.
    fake.failDeletes = false;
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    const remaining = await fake.listEpisodes(group);
    expect(remaining).toHaveLength(1);
    expect(fake.pushes.at(-1)?.episodes[0].content).not.toContain("secret reply");
  });

  it("keeps appending for an ordinary source (the rule is per-source, not global)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const fake = new FakeGraphiti();

    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", access: "team", body: "v1", frontmatter: { source: "notion" } });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", access: "team", body: "v2", frontmatter: { source: "notion" } });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // Unchanged behaviour: a document's revisions are genuine history, so nothing is retracted.
    expect(await fake.listEpisodes(group)).toHaveLength(2);
  });
});
