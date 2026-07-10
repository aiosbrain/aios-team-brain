import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { retrieve } from "@/lib/query/retrieve";
import { indexItem, indexPendingItems, resetDenseIndexProbe } from "@/lib/query/dense-index";
import { db, ingest, seedTeam } from "./helpers";

/**
 * End-to-end proof of the optional dense (pgvector) retrieval leg: write → chunk → embed → store →
 * vector search → RRF-fuse into sources. Self-skips unless PGVECTOR_TEST is set (needs the pgvector
 * schema + the embeddings stub), so the default stock-Postgres CI is unaffected. Run it with:
 *   npm run db:test:vector:up && npm run test:datamechanics:vector
 *
 * Embeddings are a DETERMINISTIC concept stub (one-hot over shared keywords) so the test proves the
 * PLUMBING mechanically without a real model: a query sharing a concept with a doc — but NO stemmed
 * term overlap the keyword FTS would catch — is surfaced only by the dense leg.
 */

const live = process.env.PGVECTOR_TEST ? describe : describe.skip;

const CONCEPTS = ["auth", "login", "password", "latency", "catering", "parking", "credential"];
/** 1536-dim one-hot over concept keywords a text contains; cosine ≈ shared-concept overlap. */
function embedText(text: string): number[] {
  const v = new Array(1536).fill(0);
  const lc = text.toLowerCase();
  CONCEPTS.forEach((c, i) => {
    if (lc.includes(c)) v[(i * 211 + 7) % 1536] = 1;
  });
  v[1535] = 0.01; // avoid an all-zero vector (cosine NaN) for concept-free fillers
  return v;
}

live("dense retrieval (real pgvector + stub embeddings)", () => {
  let server: Server;

  beforeAll(async () => {
    resetDenseIndexProbe(); // the pgvector table exists in this run — re-probe availability
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let input: string | string[] = [];
        try {
          input = (JSON.parse(body || "{}") as { input?: string | string[] }).input ?? [];
        } catch {
          input = [];
        }
        const arr = Array.isArray(input) ? input : [input];
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: arr.map((t) => ({ embedding: embedText(t) })) }));
      });
    });
    await new Promise<void>((r) => server.listen(8799, "127.0.0.1", () => r()));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("surfaces a semantic match the keyword FTS misses, fused into the sources", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      path: "deliverables/auth.md",
      body: "We shipped auth: a passwordless login flow replacing the old system.",
      access: "team",
    });
    await ingest(seed, { path: "deliverables/lunch.md", body: "Catering options for the team lunch.", access: "team" });
    await ingest(seed, { path: "deliverables/parking.md", body: "Visitor parking is in lot C; register at reception.", access: "team" });

    // Index via the batch path the ingest scheduler uses (pending-items query → chunk → embed → store).
    const batch = await indexPendingItems();
    expect(batch.skipped).toBe(false); // dense IS available here (pgvector + EMBEDDINGS_URL set)
    expect(batch.indexed).toBeGreaterThanOrEqual(3);
    // Idempotent: a second pass re-embeds nothing (unchanged content hashes).
    expect((await indexPendingItems()).indexed).toBe(0);

    // "authentication credentials" shares the `auth` concept with the doc, but its stemmed terms
    // (authent/credential) don't overlap the doc's tokens (auth/passwordless/login) → FTS misses it.
    const ctx = await retrieve(db(), seed.teamId, "team", "authentication credentials");
    const paths = ctx.sources.map((s) => s.path);
    expect(paths).toContain("deliverables/auth.md");
    expect(ctx.grounded).toBe(true);
  });

  it("does NOT ground on a far nearest-neighbor for an absent topic (distance floor)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "deliverables/auth.md", body: "We shipped auth: a passwordless login flow.", access: "team" });
    await ingest(seed, { path: "deliverables/lunch.md", body: "Catering options for the team lunch.", access: "team" });
    await ingest(seed, { path: "deliverables/parking.md", body: "Visitor parking is in lot C.", access: "team" });
    expect((await indexPendingItems()).skipped).toBe(false);

    // "latency" is a concept NONE of the docs embed, and its terms don't keyword-match either, so the
    // nearest chunk is orthogonal (cosine dist ~1). WITHOUT the floor, dense would still return it and
    // flip grounded=true (false grounding — the bug). With the floor it's excluded → grounded stays
    // false, so the answer layer abstains instead of confabulating from an irrelevant nearest-neighbor.
    const ctx = await retrieve(db(), seed.teamId, "team", "what is causing the high latency?");
    expect(ctx.grounded).toBe(false);
    // Recency padding still returns background items — exactly what grounded=false guards against.
    expect(ctx.sources.length).toBeGreaterThan(0);
  });

  it("does not leak team chunks to an external-tier caller", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      path: "deliverables/secret-auth.md",
      body: "Internal auth credentials rotation runbook (team only).",
      access: "team",
    });
    const { data: items } = await db()
      .from("items")
      .select("id, team_id, body, access, content_sha256")
      .eq("team_id", seed.teamId);
    for (const it of (items ?? []) as Array<{ id: string; team_id: string; body: string; access: "team" | "external"; content_sha256: string }>) {
      await indexItem({ id: it.id, teamId: it.team_id, body: it.body, access: it.access, contentSha256: it.content_sha256 });
    }
    const ctx = await retrieve(db(), seed.teamId, "external", "authentication credentials");
    expect(ctx.sources.map((s) => s.path)).not.toContain("deliverables/secret-auth.md");
  });
});
