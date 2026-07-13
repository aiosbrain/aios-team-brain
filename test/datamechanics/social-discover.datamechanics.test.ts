import { describe, expect, it } from "vitest";
import { discoverOpportunities } from "@/lib/social/discover";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec for content discovery on real Postgres. Derived from the product intent: turn recent brain
 * knowledge into ranked opportunities, one per notable item, tier-correct and idempotent. Proves
 * the observable outcomes — opportunities are created for discover-kind items with enough
 * substance, each inherits its source item's tier (so the §5 evidence→tier invariant holds by
 * construction), trivial/non-discover items are skipped, and a re-run creates nothing new.
 */
const LONG = "x".repeat(220);

describe("content discovery (real Postgres)", () => {
  it("creates tier-correct opportunities for substantial discover-kind items, idempotently", async () => {
    const seed = await seedTeam();
    const a = await ingest(seed, { kind: "deliverable", access: "team", path: "notes/roadmap.md", body: `internal roadmap ${LONG}` });
    const b = await ingest(seed, { kind: "artifact", access: "external", path: "blog/launch.md", body: `public launch ${LONG}` });
    await ingest(seed, { kind: "deliverable", access: "team", path: "notes/tiny.md", body: "too short" }); // trivial → skipped
    await ingest(seed, { kind: "transcript", access: "team", path: "calls/standup.md", body: `meeting ${LONG}` }); // not a discover kind

    const first = await discoverOpportunities(db(), seed.teamId);
    expect(first.scanned).toBe(3); // the two long + the trivial deliverable (transcript is filtered by kind)
    expect(first.created).toBe(2);
    expect(first.skipped).toBe(1);

    const byItem = new Map(first.opportunities.map((o) => [o.evidence[0]?.itemId, o]));
    const oppA = byItem.get(a.id)!;
    const oppB = byItem.get(b.id)!;
    expect(oppA.access).toBe("team"); // inherited from the team item — can't be public
    expect(oppB.access).toBe("external");
    expect(oppA.source_type).toBe("deliverable");
    expect(oppA.novelty_score).toBeGreaterThan(0);
    expect(oppA.status).toBe("discovered");

    // Idempotent: a second run creates nothing new.
    const second = await discoverOpportunities(db(), seed.teamId);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(3);

    const { count } = await db()
      .from("social_opportunities")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(count).toBe(2);
  });

  it("respects the look-back window", async () => {
    const seed = await seedTeam();
    await ingest(seed, { kind: "deliverable", access: "team", path: "notes/d1.md", body: `a note ${LONG}` });
    // A zero-hour window excludes everything (nothing is newer than "now").
    const none = await discoverOpportunities(db(), seed.teamId, { sinceHours: 0, now: new Date(Date.now() + 60_000) });
    expect(none.created).toBe(0);
  });
});
