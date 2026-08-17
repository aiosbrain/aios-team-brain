import { describe, expect, it } from "vitest";
import { projectItemsToGraph } from "@/lib/graph/project";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

// Spec: docs/design/reconcile-partial-chunks.md — acceptance criteria 4 and 5.
//
// RECONCILE-1 increment 1 is MEASUREMENT ONLY. A partially-landed item (some chunks present, some
// missing) must be COUNTED and must keep today's verdict exactly: still `confirmed`, NOT re-queued.
// Enforcing today would make the graph worse in three ways recorded in the spec, so these tests exist
// as much to prove the measurement did NOT smuggle in enforcement as to prove it counts.

/** A body long enough that the projector chunks it into several episodes. */
const longBody = (marker: string) => `${marker} `.repeat(4000);

async function backdatePastGrace(teamId: string): Promise<void> {
  await db().from("graph_episodes").update({ projected_at: "2020-01-01T00:00:00Z" }).eq("team_id", teamId);
}

describe("reconcile — partial multi-chunk loss (measurement only)", () => {
  it("COUNTS a partially-landed item without changing its verdict", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    const slug = seed.teamSlug;

    await ingest(seed, { kind: "deliverable", path: "docs/big.md", body: longBody("alpha"), access: "team" });
    const { data: itemRow } = await db()
      .from("items")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/big.md")
      .maybeSingle();
    const itemId = (itemRow as { id: string }).id;

    // Simulate the OBSERVED failure: the worker dies partway, so one chunk never materialises while
    // its siblings do. (Live case: a 502 at chunk #33 of docs/ARCHITECTURE.md.)
    fake.neverLands.add(`items:${itemId}#1`);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // The ledger must genuinely be multi-chunk, else this test proves nothing about the partial case.
    const { data: before } = await db()
      .from("graph_episodes")
      .select("chunk_shas, content_sha256")
      .eq("team_id", seed.teamId)
      .eq("source_id", itemId)
      .maybeSingle();
    const b = before as { chunk_shas: string[]; content_sha256: string };
    expect(b.chunk_shas.length).toBeGreaterThan(1);
    const shaBefore = b.content_sha256;
    expect(shaBefore).not.toBe(""); // not already parked on the re-push sentinel

    await backdatePastGrace(seed.teamId);
    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);

    // MEASURED…
    expect(res.partialItems).toBe(1);
    expect(res.partialDetail.sample[0]).toMatchObject({ itemId });
    expect(res.partialDetail.sample[0].missing).toContain(`items:${itemId}#1`);

    // …and the VERDICT IS UNCHANGED. One present chunk still confirms the item, exactly as before.
    expect(res.confirmed).toBe(1);
    expect(res.reQueued).toBe(0);

    const { data: after } = await db()
      .from("graph_episodes")
      .select("content_sha256")
      .eq("team_id", seed.teamId)
      .eq("source_id", itemId)
      .maybeSingle();
    // The sentinel is what triggers a re-push. Measurement must not write it.
    expect((after as { content_sha256: string }).content_sha256).toBe(shaBefore);
  });

  it("does NOT count a fully-landed item as partial", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    await ingest(seed, { kind: "deliverable", path: "docs/whole.md", body: longBody("beta"), access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await backdatePastGrace(seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.partialItems).toBe(0);
    expect(res.confirmed).toBeGreaterThan(0);
    expect(res.reQueued).toBe(0);
  });

  it("does NOT count a FULLY-missing item as partial — that class reconcile already re-queues", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    await ingest(seed, { kind: "deliverable", path: "docs/gone.md", body: longBody("gamma"), access: "team" });
    const { data: itemRow } = await db()
      .from("items")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/gone.md")
      .maybeSingle();
    const itemId = (itemRow as { id: string }).id;

    // Every chunk fails to land → the existing "never landed" path owns it, not the new counter.
    for (let i = 0; i < 40; i++) fake.neverLands.add(`items:${itemId}#${i}`);
    fake.neverLands.add(`items:${itemId}`);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await backdatePastGrace(seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.partialItems).toBe(0); // "none", not "partial"
    expect(res.reQueued).toBe(1); // today's behaviour for this class, unchanged
  });
});
