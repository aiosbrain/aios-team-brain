import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Spec: a channel-scoped question ("what did we decide in #growth") must retrieve that channel's
 * Slack threads.
 *
 * The scope is matched against a path's 2nd segment, which worked only while Slack keyed its paths on
 * the channel NAME. Keying them on the immutable channel ID (so a rename can't re-key every thread
 * into duplicate items) makes that segment opaque — and the readable name moves to
 * `frontmatter.channel`. Without matching that too, a "#channel" question silently returns ZERO Slack
 * items: worse than a miss, because `parseChannelScope` STRIPS the channel word from the query, so it
 * doesn't even survive as a content term. Real Postgres — the observable outcome is what retrieval
 * returns.
 */
describe("channel-scoped retrieval with ID-keyed Slack paths (real Postgres)", () => {
  it("finds a thread by its channel NAME even though the path is keyed on the channel ID", async () => {
    const seed = await seedTeam();
    const ts = `171890${Math.floor(Math.random() * 100000)}.000100`;

    // Exactly the shape the connector now writes: opaque id segment, readable name in frontmatter.
    await ingest(seed, {
      path: `slack/c0b8v119g4d/${ts}.md`,
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "# growth thread\n\nAlice: we decided to sunset the legacy pricing page.",
      frontmatter: { source: "slack", channel: "growth", channel_id: "C0B8V119G4D", title: "pricing decision" },
    });
    // A same-team thread in ANOTHER channel — the scope must exclude it.
    await ingest(seed, {
      path: `slack/c0other0000/${ts}.md`,
      project: "slack",
      kind: "transcript",
      access: "team",
      body: "# random thread\n\nBob: we decided to order more coffee.",
      frontmatter: { source: "slack", channel: "random", channel_id: "C0OTHER0000", title: "coffee decision" },
    });

    const ctx = await retrieve(db(), seed.teamId, "team", "what did we decide in #growth");
    const paths = ctx.sources.map((s) => s.path);

    expect(paths.some((p) => p.includes("c0b8v119g4d"))).toBe(true); // the scoped channel IS reachable
    expect(paths.some((p) => p.includes("c0other0000"))).toBe(false); // and the scope still excludes others
  });

  it("still scopes a source whose path segment IS the readable name (linear/github)", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      path: `linear/aio/AIO-${randomUUID().slice(0, 6)}.md`,
      project: "linear-aio",
      kind: "deliverable",
      access: "team",
      body: "Ticket: migrate the billing webhooks.",
      frontmatter: { source: "linear", identifier: "AIO-1", source_ts: new Date().toISOString() },
    });

    // No frontmatter.channel here — the name must still resolve via the path segment (unchanged path).
    const ctx = await retrieve(db(), seed.teamId, "team", "what is happening in the aio channel");
    expect(ctx.sources.some((s) => s.path.includes("linear/aio/"))).toBe(true);
  });
});
