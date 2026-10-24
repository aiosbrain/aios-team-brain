import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { rankedFtsSearch } from "@/lib/query/fts-search";
import { runSql } from "@/lib/db/pg/pool";
import { db, seedTeam, ingest, memberRetrieveEnforce } from "./helpers";

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
  it("reports a channel lookup SQL failure instead of treating it as an empty channel", async () => {
    const seed = await seedTeam();
    await expect(rankedFtsSearch(seed.teamId, "team", "growth", 2, "growth", ["not-a-uuid"]))
      .rejects.toThrow(/Channel scope lookup failed/);
  });

  it("uses every visible exact Slack prefix across ranked FTS and both recency legs", async () => {
    const seed = await seedTeam();
    const ts = `171890${Math.floor(Math.random() * 100000)}.000100`;
    const make = async (path: string, channel: string, body: string, workAt: string) => {
      // Ordinary ingress correctly rejects scoped paths. Change only this isolated test fixture's
      // stored path after creating a legitimate legacy item; production publication remains gated.
      const item = await ingest(seed, {
        path: `slack/fixture${randomUUID().replaceAll("-", "")}/${ts}.md`,
        project: "slack", kind: "transcript", access: "team", body,
        frontmatter: { source: "slack", ...(channel ? { channel } : {}), channel_id: "C111" },
      });
      await runSql("update items set path = $1, work_at = $2 where id = $3", [path, workAt, item.id]);
      return item.id;
    };
    const old = "2023-01-01T00:00:00Z";
    const fresh = "2025-01-01T00:00:00Z";
    const w1 = `slack/w111/c111/${ts}.md`;
    const w2 = `slack/w222/c111/${ts}.md`;
    const oldNamed = `slack/w111/c111/${ts.split(".")[0]}.000101.md`;
    const legacy = `slack/growth/${ts}.md`;
    const otherWorkspace = `slack/growth/c111/${ts}.md`;
    const otherChannel = `slack/w111/c222/${ts}.md`;
    const visible = [
      await make(w1, "growth", "amberfalcon first", old),
      await make(w2, "growth", "amberfalcon second", old),
      await make(oldNamed, "former-growth", "amberfalcon older channel label", old),
      await make(legacy, "", "amberfalcon legacy without channel metadata", old),
    ];
    visible.push(await make(otherWorkspace, "random", "amberfalcon excluded workspace", fresh));
    visible.push(await make(otherChannel, "random", "amberfalcon excluded channel", fresh));
    for (let i = 0; i < 9; i++) {
      await make(`slack/w111/c111/${ts.split(".")[0]}.${String(i + 1).padStart(6, "0")}.md`,
        "growth", "amberfalcon amberfalcon amberfalcon invisible", fresh);
    }
    const view = { visibleItemIds: new Set(visible), principal: "member" as const, graphProjectIds: [] };
    const expected = new Set([w1, w2, oldNamed, legacy]);
    const fts = await rankedFtsSearch(seed.teamId, "team", "amberfalcon", 4, "growth", visible);
    expect(new Set(fts.map((h) => h.path))).toEqual(expected);
    const general = await retrieve(db(), seed.teamId, "team", "latest in #growth", null, view);
    expect(new Set(general.sources.map((s) => s.path))).toEqual(expected);
    // Nine newer non-Slack rows in the same named channel fill general recency's eight slots.
    // The Slack source leg must still recover the older matching Slack identities.
    for (let i = 0; i < 9; i++) {
      const noise = await ingest(seed, {
        path: `linear/growth/NOISE-${randomUUID().slice(0, 8)}.md`,
        project: "linear-growth", kind: "deliverable", access: "team",
        body: `Unrelated vendor update ${i}`,
        frontmatter: { source: "linear", channel: "growth" },
      });
      view.visibleItemIds.add(noise.id);
    }
    const withoutSource = await retrieve(db(), seed.teamId, "team", "latest in #growth", null, view);
    expect(withoutSource.sources.some((item) => item.path.startsWith("slack/"))).toBe(false);
    const source = await retrieve(db(), seed.teamId, "team", "from slack in #growth", null, view);
    expect(new Set(source.sources.filter((s) => s.path.startsWith("slack/")).map((s) => s.path)))
      .toEqual(expected);
  });

  it("preserves the non-Slack frontmatter channel arm for opaque paths", async () => {
    const seed = await seedTeam();
    const path = `linear/opaque/ID-${randomUUID().slice(0, 8)}.md`;
    const item = await ingest(seed, {
      path, project: "linear-opaque", kind: "deliverable", access: "team",
      body: "violetquartz approved the rollout",
      frontmatter: { source: "linear", channel: "growth" },
    });
    const hits = await rankedFtsSearch(seed.teamId, "team", "violetquartz", 10, "growth", [item.id]);
    expect(hits.map((hit) => hit.path)).toContain(path);
    const view = await memberRetrieveEnforce(seed);
    const ctx = await retrieve(db(), seed.teamId, "team", "violetquartz in #growth", null, view);
    expect(ctx.sources.map((source) => source.path)).toContain(path);
  });

  it("keeps direct external FTS calls behind the external posture wall", async () => {
    const seed = await seedTeam();
    const externalPath = "slack/growth/1718900000.000100.md";
    const teamPath = "slack/growth/1718900001.000100.md";
    const external = await ingest(seed, {
      path: externalPath, project: "slack", kind: "transcript", access: "external",
      body: "cobaltbadger external item", frontmatter: { source: "slack", channel: "growth" },
    });
    await ingest(seed, {
      path: teamPath, project: "slack", kind: "transcript", access: "team",
      body: "cobaltbadger team item", frontmatter: { source: "slack", channel: "random" },
    });
    const hits = await rankedFtsSearch(seed.teamId, "external", "cobaltbadger", 10, "growth", null);
    expect(hits.map((hit) => hit.id)).toEqual([external.id]);
  });

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

    const ctx = await retrieve(db(), seed.teamId, "team", "what did we decide in #growth", null, await memberRetrieveEnforce(seed));
    const paths = ctx.sources.map((s) => s.path);

    expect(paths.some((p) => p.includes("c0b8v119g4d"))).toBe(true); // the scoped channel IS reachable
    expect(paths.some((p) => p.includes("c0other0000"))).toBe(false); // and the scope still excludes others
  });

  it("treats a legacy channel underscore as a literal SQL prefix character", async () => {
    const seed = await seedTeam();
    const good = "slack/sales_ops/1718900000.000100.md";
    const wildcardLookalike = "slack/salesXops/1718900000.000100.md";
    for (const [path, channel] of [[good, "sales_ops"], [wildcardLookalike, "random"]]) {
      await ingest(seed, { path, project: "slack", kind: "transcript", access: "team",
        body: "copperotter decision", frontmatter: { source: "slack", channel } });
    }
    const view = await memberRetrieveEnforce(seed);
    const hits = await rankedFtsSearch(seed.teamId, "team", "copperotter", 2, "sales_ops", [...view.visibleItemIds]);
    expect(hits.map((h) => h.path)).toEqual([good]);
    const ctx = await retrieve(db(), seed.teamId, "team", "latest in #sales_ops", null, view);
    expect(ctx.sources.map((s) => s.path)).toEqual([good]);
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
    const ctx = await retrieve(db(), seed.teamId, "team", "what is happening in the aio channel", null, await memberRetrieveEnforce(seed));
    expect(ctx.sources.some((s) => s.path.includes("linear/aio/"))).toBe(true);
  });
});
