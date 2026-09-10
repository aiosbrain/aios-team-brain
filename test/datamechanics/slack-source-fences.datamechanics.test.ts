import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { claimSlackChannelPage } from "@/lib/ingest/slack-channel-state";
import { discoverSlackSource, type SlackSourceDiscoveryResult } from "@/lib/ingest/slack-source-discovery";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, seedTeam, type Seed } from "./helpers";
import {
  agePublicProof,
  authTestBody,
  bindingRow,
  channelInfoBody,
  channelRow,
  closeRawSql,
  elapse,
  fakeSlack,
  historyBody,
  rawSql,
  requireSlackSourceTables,
  rootMessage,
  seedSlackIntegration,
  slackJson,
  threadRootTs,
  type SlackFake,
} from "./slack-source-helpers";

/**
 * AIO-1170 — the three fences that are NOT the history lease, against real Postgres.
 *
 *  1. THE METADATA OBSERVATION FENCE. `conversations.info` is metered per (team, workspace, APP), so
 *     two integrations running two apps in one workspace have two independent allowances and can have
 *     two metadata reads in flight over the same channel at the same time. A rate limit is therefore
 *     not an ordering guarantee: without a channel-scoped attempt fence, an older `public` response
 *     that arrives late overwrites a newer `private` one, and the channel keeps being read after its
 *     privacy was observed.
 *  2. THE FK ACTION. `binding_integration_id` is `on delete set null`, which changes ONE of the two
 *     columns the pair CHECK constrains. Deleting an integration must leave a valid, unbound row with
 *     every certified page intact — not a constraint violation that makes the delete fail.
 *  3. THE SCHEMA REPLAY. Both tables are created with `create table if not exists`, so a column added
 *     to their body is a NO-OP on a database that already has the table. The upgrade block is what
 *     makes a populated older database reach this shape, and it must not disturb what is stored.
 */

const WORKSPACE = "T0SOURCE1";
const CHANNEL = "C0SOURCE1";
const OTHER_CHANNEL = "C0SOURCE2";
const APP_A = "A0SOURCE1";
const APP_B = "A0SOURCE2";
const TOKEN = "xoxb-synthetic-not-a-real-token";
const ROTATED = "xoxb-synthetic-second-app-token";

beforeAll(requireSlackSourceTables);
afterAll(closeRawSql);

function discover(seed: Seed, integrationId: string, fake: SlackFake): Promise<SlackSourceDiscoveryResult> {
  return discoverSlackSource(
    { db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null }
  );
}

/** A pass that binds one app, proves the channel it is asked about, and reads one empty page. */
function warmUp(appId: string, over: Parameters<typeof fakeSlack>[0] = {}): SlackFake {
  return fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: appId })),
    "conversations.info": (call) => slackJson(channelInfoBody(call.params.get("channel") ?? "")),
    "conversations.history": () => slackJson(historyBody({ messages: [] })),
    ...over,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

/** A history page that CONTINUES: one root, more to come, and a cursor to come back with. */
function partialPage(rootTs: string, cursor: string): () => Response {
  return () =>
    slackJson(historyBody({ messages: [rootMessage(rootTs)], hasMore: true, nextCursor: cursor }));
}

// ── 1. the metadata observation fence ────────────────────────────────────────

describe("a channel's public verdict is fenced by the attempt that asked for it", () => {
  it("refuses a LATE public response that a newer private observation has already superseded", async () => {
    const seed = await seedTeam();
    // Two REAL bindings: two integrations, two tokens, two apps, one workspace, one channel. Their
    // `conversations.info` budgets are per-app, so both may legitimately be in flight at once.
    const first = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const second = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: ROTATED, name: "slack-b" });

    await discover(seed, first, warmUp(APP_A));
    await elapse(seed.teamId);
    await discover(seed, second, warmUp(APP_B));
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ public_state: "public" });

    // Both bindings are now due to RE-OBSERVE, which is what makes the overlap reachable at all.
    await agePublicProof(seed.teamId, CHANNEL);
    await elapse(seed.teamId);
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    const started = deferred();
    const release = deferred();
    const contested = fakeSlack({
      "auth.test": () => {
        throw new Error("both bindings are verified; auth.test must not repeat");
      },
      "conversations.info": async (call) => {
        if (call.authorization === `Bearer ${TOKEN}`) {
          // The OLD observation: it started first, and it comes back last.
          started.resolve();
          await release.promise;
          return slackJson(channelInfoBody(CHANNEL));
        }
        return slackJson(channelInfoBody(CHANNEL, { is_private: true }));
      },
      "conversations.history": () => {
        throw new Error("no channel may be read while its public proof is contested");
      },
    });

    // Deterministic interleaving, not a race: A's attempt is committed before B's begins (its
    // request is in flight), and B's whole pass completes before A's response is delivered.
    const late = discover(seed, first, contested);
    await started.promise;
    const privatePass = await discover(seed, second, contested);
    const afterPrivate = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    release.resolve();
    const latePass = await late;

    expect(privatePass.steps.filter((s) => s.stage === "metadata").map((s) => s.category)).toEqual([
      "channel_private",
    ]);
    expect(afterPrivate).toMatchObject({ public_state: "private" });

    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    // The late `public` answer changed NOTHING — not the verdict, and not the time it was made at,
    // which is the field a "refresh the proof we already had" bug would move on its own.
    expect(after?.public_state).toBe("private");
    expect(after?.public_checked_at).toEqual(afterPrivate?.public_checked_at);
    expect(
      latePass.steps.filter((s) => s.stage === "metadata").map((s) => `${s.result}:${s.category ?? ""}`)
    ).toEqual(["refused:metadata_superseded"]);

    // Two attempts were opened and exactly one was accepted; the accepted one released ownership.
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(before?.metadata_attempt_generation) + 2);
    expect(after?.metadata_attempt_owner).toBeNull();
    // Neither pass read a message: the fake's history handler throws, and it was never reached.
    expect(contested.countOf("conversations.history")).toBe(0);
    expect(await threadRootTs(seed.teamId)).toEqual([]);
  });

  it("refuses an in-flight history page whose channel was observed private during the request", async () => {
    const seed = await seedTeam();
    const reader = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const observer = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: ROTATED, name: "slack-b" });

    // A real first scan, left mid-page so the next claim has somewhere to continue from.
    await discover(
      seed,
      reader,
      warmUp(APP_A, {
        "conversations.history": () =>
          slackJson(
            historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "cursor-1" })
          ),
      })
    );
    const seeded = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const rootsBefore = await threadRootTs(seed.teamId);
    expect(rootsBefore).toEqual(["1718900000.000900"]);
    await elapse(seed.teamId);

    // While THIS page is in flight, the other integration observes the channel private — through the
    // real entrypoint answering a real `conversations.info`, not by writing the verdict directly.
    let revokedWhileInFlight = false;
    const revoking = fakeSlack({
      "auth.test": () => {
        throw new Error("the reader binding is verified; auth.test must not repeat");
      },
      "conversations.info": (call) => slackJson(channelInfoBody(call.params.get("channel") ?? "")),
      "conversations.history": async () => {
        await discover(
          seed,
          observer,
          fakeSlack({
            "auth.test": () => slackJson(authTestBody({ app_id: APP_B })),
            "conversations.info": () => slackJson(channelInfoBody(CHANNEL, { is_private: true })),
          })
        );
        revokedWhileInFlight =
          (await channelRow(seed.teamId, WORKSPACE, CHANNEL))?.public_state === "private";
        return slackJson(
          historyBody({ messages: [rootMessage("1718900000.000800")], hasMore: true, nextCursor: "cursor-2" })
        );
      },
    });

    const result = await discover(seed, reader, revoking);

    // The fixture actually produced the revocation — otherwise this whole test is vacuous.
    expect(revokedWhileInFlight).toBe(true);
    expect(result.steps.some((s) => s.stage === "history" && s.result === "refused")).toBe(true);
    // Nothing from the page survived: no root was enqueued and no cursor moved.
    expect(await threadRootTs(seed.teamId)).toEqual(rootsBefore);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.public_state).toBe("private");
    expect(after?.historical_cursor).toBe(seeded?.historical_cursor);
    expect(after?.historical_anchor_ts).toBe(seeded?.historical_anchor_ts);
    expect(after?.completed_lower_ts).toBe(seeded?.completed_lower_ts);
    expect(after?.completed_upper_ts).toBe(seeded?.completed_upper_ts);

    // …and it stays closed: the next wake cannot claim a channel whose proof says private.
    const claim = await tx((session) =>
      claimSlackChannelPage(
        session,
        { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL },
        {
          bindingIntegrationId: observer,
          bindingConfigRevision: String(after?.binding_config_revision),
        }
      )
    );
    expect(claim).toBeNull();
  });
});

// ── 2. deleting an integration ───────────────────────────────────────────────

describe("deleting an integration unbinds the channel without losing it", () => {
  it("clears BOTH binding columns atomically, keeps every frontier, and refuses a stale claim", async () => {
    const seed = await seedTeam();
    // Two integrations coalesced onto ONE channel row, plus an unrelated channel that must not move.
    const shared = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const bound = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-b" });
    const untouched = await seedSlackIntegration(seed, {
      channelIds: [OTHER_CHANNEL],
      token: TOKEN,
      name: "slack-c",
    });

    // The initial anchored scan, left mid-page…
    await discover(seed, shared, warmUp(APP_A, { "conversations.history": partialPage("1718900000.000900", "cursor-1") }));
    await elapse(seed.teamId);
    // …then the OTHER integration rebinds the same coalesced row and leaves the catch-up lane
    // mid-page too, so the delete below has both lanes' progress to preserve.
    await discover(seed, bound, warmUp(APP_A, { "conversations.history": partialPage("1718900000.000850", "cursor-2") }));
    await elapse(seed.teamId);
    await discover(seed, untouched, warmUp(APP_A));

    const sharedBefore = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const otherBefore = await channelRow(seed.teamId, WORKSPACE, OTHER_CHANNEL);
    // The fixture is only meaningful if the row it protects actually carries progress.
    expect(sharedBefore).toMatchObject({ binding_integration_id: bound, public_state: "public" });
    expect(sharedBefore?.historical_cursor).toBe("cursor-1");
    expect(sharedBefore?.newest_cursor).toBe("cursor-2");
    expect(sharedBefore?.historical_anchor_ts).not.toBeNull();
    expect(otherBefore?.binding_integration_id).toBe(untouched);

    // The ACTUAL FK path — a plain delete, not the application's own unbind helper.
    const c = await rawSql();
    await c.query(`delete from integrations where id = $1`, [bound]);

    const sharedAfter = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    // Both halves of the pair are null, and NOTHING else moved — same row id, same frontier, same
    // proof. A `cascade` (or a re-insert) would show up here as a changed id or a missing cursor.
    expect(sharedAfter).toEqual({
      ...sharedBefore,
      binding_integration_id: null,
      binding_config_revision: null,
    });
    // The other channel's row is untouched by a delete that was never about it.
    expect(await channelRow(seed.teamId, WORKSPACE, OTHER_CHANNEL)).toEqual(otherBefore);
    // The deleted integration's own binding row cascaded; the survivors' did not.
    expect(await bindingRow(seed.teamId, bound)).toBeNull();
    expect(await bindingRow(seed.teamId, shared)).not.toBeNull();
    expect(await bindingRow(seed.teamId, untouched)).not.toBeNull();

    // A claim carrying the revision that was valid a moment ago is refused: retained public metadata
    // is not authority, and an unbound row dispatches nothing.
    const stale = await tx((session) =>
      claimSlackChannelPage(
        session,
        { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL },
        {
          bindingIntegrationId: bound,
          bindingConfigRevision: String(sharedBefore?.binding_config_revision),
        }
      )
    );
    expect(stale).toBeNull();

    // …and the surviving integration rebinds the SAME coalesced frontier through the real writer,
    // continuing the scan instead of starting a new one.
    await elapse(seed.teamId);
    const resumed = warmUp(APP_A, {
      "conversations.history": () => slackJson(historyBody({ messages: [rootMessage("1718900000.000800")] })),
    });
    await discover(seed, shared, resumed);

    const rebound = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(rebound?.binding_integration_id).toBe(shared);
    expect(rebound?.binding_config_revision).not.toBeNull();
    expect(resumed.paramsOf("conversations.history")[0].get("cursor")).toBe("cursor-1");
    expect(await threadRootTs(seed.teamId)).toEqual(["1718900000.000800", "1718900000.000900"]);
  });
});

// ── 3. schema replay onto a populated database ───────────────────────────────

describe("the source-owned columns replay onto a populated older database", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const ADDED = ["newest_catchup_upper_ts", "metadata_attempt_owner", "metadata_attempt_generation"];

  function upgradeBlock(): string {
    const schema = readFileSync(join(ROOT, "postgres", "schema.sql"), "utf8");
    const after = schema.split("-- slack-source-upgrade:begin")[1];
    const block = after?.split("-- slack-source-upgrade:end")[0];
    if (!block || block.trim() === "") {
      throw new Error("postgres/schema.sql no longer delimits the slack-source upgrade block");
    }
    return block;
  }

  it("re-adds every column this slice introduced, preserving the progress already stored", async () => {
    const block = upgradeBlock();
    // A positive control on the EXTRACTOR: an empty or mis-sliced block would otherwise let the
    // replay below "pass" by doing nothing at all.
    for (const column of ADDED) expect(block).toContain(column);

    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await discover(
      seed,
      integrationId,
      warmUp(APP_A, {
        "conversations.history": () =>
          slackJson(
            historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "cursor-1" })
          ),
      })
    );
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(before?.historical_cursor).toBe("cursor-1");

    const c = await rawSql();
    const columnsNow = async (): Promise<string[]> => {
      const { rows } = await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'slack_sync_channels'
          order by column_name`
      );
      return rows.map((r) => r.column_name);
    };

    // DDL is transactional in Postgres, so the older shape only ever exists inside this block: a
    // failure rolls the test database back to the current schema rather than leaving it downgraded.
    await c.query("begin");
    try {
      await c.query(
        `alter table slack_sync_channels ${ADDED.map((col) => `drop column ${col}`).join(", ")}`
      );
      const downgraded = await columnsNow();
      for (const column of ADDED) expect(downgraded).not.toContain(column);

      await c.query(block);

      const upgraded = await columnsNow();
      for (const column of ADDED) expect(upgraded).toContain(column);
      const { rows } = await c.query<Record<string, unknown>>(
        `select * from slack_sync_channels where team_id = $1 and channel_id = $2`,
        [seed.teamId, CHANNEL]
      );
      // Every pre-existing value survived the upgrade; the new columns arrive at their defaults.
      expect(rows[0]).toEqual({
        ...before,
        newest_catchup_upper_ts: null,
        metadata_attempt_owner: null,
        metadata_attempt_generation: "0",
      });

      // Replaying the SAME block again is a no-op rather than an error — the property that lets
      // `npm run pg:schema` run against any state.
      await c.query(block);
      expect(await columnsNow()).toEqual(upgraded);
      await c.query("commit");
    } catch (error) {
      await c.query("rollback");
      throw error;
    }
  });
});
