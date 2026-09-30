import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { storedScopedSlackThreads } from "@/lib/ingest/slack-cleanup";
import { PgClient } from "@/lib/db/pg/client";

const WORKSPACE = "T0ONE";
const OTHER_WORKSPACE = "T0TWO";
const CHANNEL = "C0PUB";
const SIBLING = "C0PUB2";
const GONE = "1790000000.000100";
const LIVE = "1780000000.000100";

async function row(
  seed: Seed, path: string, ts: string,
  frontmatter: Record<string, unknown> = {}, kind = "transcript"
) {
  // Seed the pre-existing DB shape through test-only mutation after ordinary item creation.
  const item = await ingest(seed, {
    path: `fixture/${randomUUID()}.md`, project: "slack", kind: "transcript", access: "team",
    body: `body ${ts}`, frontmatter: {},
  });
  const { error } = await db().from("items").update({
    path,
    kind,
    frontmatter: {
      source: "slack", workspace_id: WORKSPACE, channel_id: CHANNEL, ts, ...frontmatter,
    },
  }).eq("team_id", seed.teamId).eq("id", item.id);
  if (error) throw new Error(error.message);
  return item.id;
}

describe("scoped Slack stored-thread read (real Postgres, inactive)", () => {
  it("returns only exact canonical paths for the requested team, workspace, and channel", async () => {
    const seed = await seedTeam();
    const own = await row(seed, `slack/t0one/c0pub/${GONE}.md`, GONE);
    await row(seed, `slack/t0two/c0pub/${GONE}.md`, GONE, { workspace_id: OTHER_WORKSPACE });
    await row(seed, `slack/t0one/c0pub2/${GONE}.md`, GONE, { channel_id: SIBLING });
    await row(seed, `slack/t0one/c0pub/${GONE}.md/extra`, GONE);
    await row(seed, "slack/t0one/c0pub/not-a-ts.md", GONE);
    await row(seed, `slack/T0ONE/c0pub/${LIVE}.md`, LIVE);
    await row(seed, `slack/c0pub/${GONE}.md`, GONE);
    await row(seed, `slack/old-display/${GONE}.md`, GONE);
    const anotherTeam = await seedTeam();
    await row(anotherTeam, `slack/t0one/c0pub/${LIVE}.md`, LIVE);

    expect(await storedScopedSlackThreads(db(), seed.teamId, WORKSPACE, CHANNEL))
      .toEqual([{ id: own, ts: GONE }]);
    expect(await storedScopedSlackThreads(db(), anotherTeam.teamId, WORKSPACE, CHANNEL))
      .toHaveLength(1);
    expect(await storedScopedSlackThreads(db(), seed.teamId, WORKSPACE, SIBLING))
      .toHaveLength(1);
    expect(await storedScopedSlackThreads(db(), seed.teamId, OTHER_WORKSPACE, CHANNEL))
      .toHaveLength(1);
  });

  it("excludes canonical paths whose Slack metadata or item kind disagrees", async () => {
    const seed = await seedTeam();
    const own = await row(seed, `slack/t0one/c0pub/${GONE}.md`, GONE);
    await row(seed, `slack/t0one/c0pub/${LIVE}.md`, LIVE, { source: "github" });
    await row(seed, "slack/t0one/c0pub/1780000000.000101.md", "1780000000.000101", {
      workspace_id: OTHER_WORKSPACE,
    });
    await row(seed, "slack/t0one/c0pub/1780000000.000102.md", "1780000000.000102", {
      channel_id: SIBLING,
    });
    await row(seed, "slack/t0one/c0pub/1780000000.000103.md", "1780000000.000104");
    await row(seed, "slack/t0one/c0pub/1780000000.000105.md", "1780000000.000105", {}, "artifact");

    expect(await storedScopedSlackThreads(db(), seed.teamId, WORKSPACE, CHANNEL))
      .toEqual([{ id: own, ts: GONE }]);
  });

  it("surfaces lookup errors instead of treating them as an empty channel", async () => {
    const faulted = new PgClient({
      executor: async () => { throw new Error("injected scoped lookup failure"); },
    });
    await expect(storedScopedSlackThreads(faulted, randomUUID(), WORKSPACE, CHANNEL))
      .rejects.toThrow(/slack scoped stored-thread read: injected scoped lookup failure/);
  });
});
