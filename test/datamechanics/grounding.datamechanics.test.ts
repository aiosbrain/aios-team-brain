import { beforeEach, describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam, type Seed } from "./helpers";

// Spec (stay-quiet): retrieve() reports `grounded` — true when query-specific search (FTS/semantic)
// matched, false when the only sources are recency padding. The answer layer uses this to abstain
// instead of confabulating. Verified on real Postgres.

let seed: Seed;

describe("retrieve grounding signal (real Postgres)", () => {
  beforeEach(async () => {
    seed = await seedTeam();
    await ingest(seed, { kind: "deliverable", path: "deliverables/auth.md", body: "Authentication redesign: passwordless magic links replace the password flow.", access: "team" });
    // a few unrelated docs so recency always returns something (the padding the signal must see past)
    for (let i = 0; i < 3; i++) {
      await ingest(seed, { kind: "deliverable", path: `deliverables/misc-${i}.md`, body: `Office logistics note ${i}: parking, wifi, lunch schedule.`, access: "team" });
    }
  });

  it("grounded=true when the question matches a document", async () => {
    const ctx = await retrieve(db(), seed.teamId, "team", "passwordless authentication magic links");
    expect(ctx.grounded).toBe(true);
    expect(ctx.sources.some((s) => s.path === "deliverables/auth.md")).toBe(true);
  });

  it("grounded=false for an off-topic question (only recency padding, no real match)", async () => {
    const ctx = await retrieve(db(), seed.teamId, "team", "quarterly gross margin forecast for the Tokyo subsidiary");
    expect(ctx.grounded).toBe(false);
    // recency still returns the recent items as background — that's exactly what the signal guards against
    expect(ctx.sources.length).toBeGreaterThan(0);
  });
});
