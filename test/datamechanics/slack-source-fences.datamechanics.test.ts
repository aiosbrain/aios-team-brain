import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { claimSlackChannelPage } from "@/lib/ingest/slack-channel-state";
import { markSlackMethodBlocked, type SlackMethodScope } from "@/lib/ingest/slack-method-budget";
import { discoverSlackSource, type SlackSourceDiscoveryResult } from "@/lib/ingest/slack-source-discovery";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, seedTeam, transactionSessionDecoratedDb, type Seed } from "./helpers";
import {
  agePublicProof,
  authTestBody,
  bindingRow,
  channelInfoBody,
  channelRow,
  channelRows,
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
  type Row,
  type SlackFake,
} from "./slack-source-helpers";

/**
 * AIO-1170 — the four fences that are NOT the history lease, against real Postgres.
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
 *  4. RESERVE BEFORE YOU OWN (pre-activation correction PA-1). Opening an attempt is what supersedes
 *     the one before it, so an attempt may be opened only for a request that is actually going to be
 *     sent. A worker whose budget reservation is deferred or blocked sends nothing and must therefore
 *     take nothing — no owner, no generation, no verdict, no error code — or every such wake refuses
 *     a real answer that is still in flight, and with more than one process the proof starves.
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

function discover(
  seed: Seed,
  integrationId: string,
  fake: SlackFake,
  over: { client?: ReturnType<typeof db>; maxRequests?: number } = {}
): Promise<SlackSourceDiscoveryResult> {
  return discoverSlackSource(
    { db: over.client ?? db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null, maxRequests: over.maxRequests }
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
  // ⚠️ FIXTURE CHANGED ON PURPOSE (pre-activation correction PA-2); every assertion is the original.
  // This used two integrations on two apps racing over one BOUND channel. Under PA-2 the second of
  // those stands down while the first is a valid binder, so that overlap can no longer be staged that
  // way. The same two observations are now two passes of the SAME binder: the first response is held,
  // the shared `conversations.info` budget is aged while it is held so the second pass can really
  // reserve, and the two answers are told apart by CALL ORDER — there is only one token now.
  // (Two integrations racing over an UNBOUND channel is still covered, by the PA-1 block below.)
  it("refuses a LATE public response that a newer private observation has already superseded", async () => {
    const seed = await seedTeam();
    const binder = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });

    await discover(seed, binder, warmUp(APP_A));
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ public_state: "public" });

    // The proof is now due to be RE-OBSERVED, which is what makes the overlap reachable at all.
    await agePublicProof(seed.teamId, CHANNEL);
    await elapse(seed.teamId);
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    const started = deferred();
    const release = deferred();
    let observations = 0;
    const contested = fakeSlack({
      "auth.test": () => {
        throw new Error("the binding is verified; auth.test must not repeat");
      },
      "conversations.info": async () => {
        observations += 1;
        if (observations === 1) {
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

    // Deterministic interleaving, not a race: the first attempt is committed before the second begins
    // (its request is in flight), and the second pass completes before the first response is delivered.
    const late = discover(seed, binder, contested);
    await started.promise;
    // ⚠️ CLOCK FIXTURE, while the first response is HELD: both passes meter against one allowance, so
    // without this the second is deferred by the budget and never observes anything.
    await elapse(seed.teamId);
    const privatePass = await discover(seed, binder, contested);
    const afterPrivate = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    release.resolve();
    const latePass = await late;

    // The second pass really reserved and really asked — otherwise nothing below was contested.
    expect(observations).toBe(2);

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

  // ⚠️ FIXTURE CHANGED ON PURPOSE (pre-activation correction PA-2); every assertion is the original.
  // The private observation used to come from a SECOND integration. Under PA-2 that integration stands
  // down while the reader is a valid binder, so the overlapping metadata pass is now the reader's own.
  // Its proof is aged INSIDE the held history handler — not before the outer pass, which must still
  // start with a fresh proof and go straight to history — with the metadata budget available.
  it("refuses an in-flight history page whose channel was observed private during the request", async () => {
    const seed = await seedTeam();
    const reader = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });

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

    // While THIS page is in flight, an overlapping metadata pass observes the channel private —
    // through the real entrypoint answering a real `conversations.info`, not by writing the verdict
    // directly.
    let revokedWhileInFlight = false;
    const observing = fakeSlack({
      "conversations.info": () => slackJson(channelInfoBody(CHANNEL, { is_private: true })),
    });
    const revoking = fakeSlack({
      "auth.test": () => {
        throw new Error("the reader binding is verified; auth.test must not repeat");
      },
      "conversations.info": () => {
        throw new Error("the proof is fresh when the outer pass starts; it must not re-observe");
      },
      "conversations.history": async () => {
        // ⚠️ CLOCK FIXTURE, inside the held handler: only now is the proof past its cadence.
        await agePublicProof(seed.teamId, CHANNEL);
        await discover(seed, reader, observing);
        revokedWhileInFlight =
          (await channelRow(seed.teamId, WORKSPACE, CHANNEL))?.public_state === "private";
        return slackJson(
          historyBody({ messages: [rootMessage("1718900000.000800")], hasMore: true, nextCursor: "cursor-2" })
        );
      },
    });

    const result = await discover(seed, reader, revoking);

    // The fixture actually produced the revocation — otherwise this whole test is vacuous: the outer
    // pass went straight to history, and the nested one asked once and was told `private`.
    expect(revoking.countOf("conversations.info")).toBe(0);
    expect(observing.calls.map((call) => call.method)).toEqual(["conversations.info"]);
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
          bindingIntegrationId: reader,
          bindingConfigRevision: String(after?.binding_config_revision),
        }
      )
    );
    expect(claim).toBeNull();
  });
});

// ── 2. deleting an integration ───────────────────────────────────────────────

describe("deleting an integration unbinds the channel without losing it", () => {
  // ⚠️ FIXTURE CHANGED ON PURPOSE (pre-activation correction PA-2); every assertion is the original.
  // The integration that is deleted used to become the binder by REBINDING a row another integration
  // had proved. Under PA-2 that rebind does not happen while the first binder is valid, so the deleted
  // integration is now the binder from the start and earns both lanes' progress itself. The survivor
  // is verified with a single request, so it has asked nothing about the channel before the delete.
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
    await discover(seed, bound, warmUp(APP_A, { "conversations.history": partialPage("1718900000.000900", "cursor-1") }));
    await elapse(seed.teamId);
    // …then the SAME binder's next wake leaves the catch-up lane mid-page too, so the delete below
    // has both lanes' progress to preserve.
    await discover(seed, bound, warmUp(APP_A, { "conversations.history": partialPage("1718900000.000850", "cursor-2") }));
    await elapse(seed.teamId);
    await discover(seed, shared, identityOnly(APP_A), { maxRequests: 1 });
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
    expect(await threadRootTs(seed.teamId)).toEqual([
      "1718900000.000800",
      "1718900000.000850",
      "1718900000.000900",
    ]);
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

// ── 4. reserve before you own ────────────────────────────────────────────────

/** `beginSlackChannelMetadata`'s statement and no other: the only one that MINTS an attempt owner. */
const OPENS_ATTEMPT = /update\s+slack_sync_channels\s+set\s+metadata_attempt_owner\s*=\s*gen_random_uuid\(\)/i;
/** `reserveSlackMethodSlot`'s grant. A backoff writes `greatest(…)` there, and does not match. */
const GRANTS_SLOT = /update\s+slack_method_budgets\s+set\s+next_permitted_at\s*=\s*clock_timestamp\(\)/i;

type Workers = Awaited<ReturnType<typeof twoWorkers>>;

/** The (team, workspace, APP) allowance every `conversations.info` of one app is metered under. */
function infoScope(seed: Seed, appId: string): SlackMethodScope {
  return { kind: "verified", teamId: seed.teamId, workspaceId: WORKSPACE, appId };
}

/** Binds an app and stops: with ONE request to spend, a pass proves identity and asks about no channel. */
function identityOnly(appId: string): SlackFake {
  return fakeSlack({ "auth.test": () => slackJson(authTestBody({ app_id: appId })) });
}

/**
 * Two verified bindings over ONE channel nobody has observed yet. `siblingApp` is the whole
 * experiment: under the owner's app the two share one `conversations.info` allowance, so whichever
 * asks second is DEFERRED; under its own app the sibling has its own allowance and is GRANTED.
 */
async function twoWorkers(
  siblingApp: string
): Promise<{ seed: Seed; owner: string; sibling: string; before: Row }> {
  const seed = await seedTeam();
  const owner = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
  const sibling = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: ROTATED, name: "slack-b" });
  await discover(seed, owner, identityOnly(APP_A), { maxRequests: 1 });
  await discover(seed, sibling, identityOnly(siblingApp), { maxRequests: 1 });

  const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
  if (!before) throw new Error("fixture: the identity passes should have created the channel row");
  // The fixture is only meaningful from a row no attempt has touched: every owner and generation
  // asserted below is then the work of the passes under test, and of nothing before them.
  expect(before).toMatchObject({
    public_state: "unknown",
    binding_integration_id: null,
    metadata_attempt_owner: null,
    metadata_attempt_generation: "0",
    last_error_code: null,
  });
  return { seed, owner, sibling, before };
}

/** A request the test holds open: it says when it is in flight, and answers (or fails) on release. */
function held(respond: () => Response): {
  handler: () => Promise<Response>;
  started: Promise<void>;
  release: () => void;
} {
  const started = deferred();
  const gate = deferred();
  return {
    handler: async () => {
      started.resolve();
      await gate.promise;
      return respond();
    },
    started: started.promise,
    release: gate.resolve,
  };
}

/**
 * Wait until a pass has its request IN FLIGHT. Raced against the pass itself, so one that ends
 * without ever sending it fails here, by name, instead of hanging on a signal nobody will raise.
 */
async function inFlight(started: Promise<void>, pass: Promise<unknown>): Promise<void> {
  await Promise.race([
    started,
    pass.then(() => {
      throw new Error("fixture: the pass ended without sending the request this test holds open");
    }),
  ]);
}

/** One app's `conversations.info` bucket, whole, plus whether its slot is spent right now. */
async function infoBucket(seed: Seed, appId: string): Promise<Row | null> {
  const c = await rawSql();
  const { rows } = await c.query<Row>(
    `select b.*, b.next_permitted_at > clock_timestamp() as spent
       from slack_method_budgets b
      where b.team_id = $1 and b.scope_kind = 'verified' and b.workspace_id = $2 and b.app_id = $3
        and b.method = 'conversations.info'`,
    [seed.teamId, WORKSPACE, appId]
  );
  return rows[0] ?? null;
}

/**
 * RESERVE BEFORE YOU OWN, read while a request is in flight. Granting a slot and opening an attempt
 * each stamp `updated_at` from the database clock, and nothing else writes either row before the
 * request leaves — so `true` means the attempt that owns the channel right now was opened AFTER its
 * own `conversations.info` slot was granted. `null` means there is no bucket: nothing was reserved.
 */
async function ownedAfterReserving(seed: Seed, appId: string): Promise<boolean | null> {
  const c = await rawSql();
  const { rows } = await c.query<{ owned_after: boolean }>(
    `select c.updated_at > b.updated_at as owned_after
       from slack_sync_channels c
       join slack_method_budgets b
         on b.team_id = c.team_id and b.workspace_id = c.workspace_id
      where c.team_id = $1 and c.channel_id = $2
        and b.scope_kind = 'verified' and b.app_id = $3 and b.method = 'conversations.info'`,
    [seed.teamId, CHANNEL, appId]
  );
  return rows[0]?.owned_after ?? null;
}

/**
 * A durable block on one app's `conversations.info` bucket, written by the budget's OWN writer: the
 * state a 429 with an unrepresentable `Retry-After` leaves behind for every later caller of that
 * shared allowance, including one in another process. It is a fact about the bucket, not the channel.
 */
async function blockInfoBucket(seed: Seed, appId: string): Promise<void> {
  await tx((session) =>
    markSlackMethodBlocked(session, infoScope(seed, appId), "conversations.info", "retry_after_unrepresentable")
  );
}

function metadataSteps(result: SlackSourceDiscoveryResult): string[] {
  return result.steps.filter((s) => s.stage === "metadata").map((s) => `${s.result}:${s.category ?? ""}`);
}

describe("a metadata attempt is opened only for a request that is actually sent (PA-1)", () => {
  /**
   * THE STARVATION, as a deterministic interleaving rather than a race: the owner's request is held
   * in flight, the sibling's whole pass runs to completion, and only then is the owner's answer
   * delivered. The sibling is refused by the BUDGET — the owner's grant spent the allowance they
   * share — so it sends nothing. Opening an attempt for that nothing is what used to refuse the one
   * real answer when it landed.
   */
  it.each([
    { sibling: "the same integration in a second process", pick: (w: Workers) => w.owner },
    { sibling: "a second integration on the same app", pick: (w: Workers) => w.sibling },
  ])("lets the in-flight answer land when $sibling is DEFERRED by the budget (AC-PA-01)", async ({ pick }) => {
    const workers = await twoWorkers(APP_A);
    const { seed, before } = workers;

    const info = held(() => slackJson(channelInfoBody(CHANNEL)));
    const answering = fakeSlack({
      "conversations.info": info.handler,
      "conversations.history": () => slackJson(historyBody({ messages: [] })),
    });
    // No handler at all: anything the deferred worker sends is recorded here, and then throws.
    const silent = fakeSlack({});

    const late = discover(seed, workers.owner, answering);
    await inFlight(info.started, late);
    const owned = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const deferredPass = await discover(seed, pick(workers), silent);
    const afterSibling = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const bucket = await infoBucket(seed, APP_A);
    info.release();
    const ownerPass = await late;
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    // ⚠️ THE CALL-SITE PIN. The criterion starts from an owner that HAS begun an attempt while its
    // response is pending: committed, and visible to another connection, before any answer exists.
    // A metadata stage that stops handing the transport its `beforeSend` hook opens no attempt at
    // this point (and one that opens it only once the answer is back has not opened it yet), so this
    // is the assertion that reddens when that argument is deleted.
    expect(owned?.metadata_attempt_owner).toEqual(expect.any(String));
    expect(Number(owned?.metadata_attempt_generation)).toBe(Number(before.metadata_attempt_generation) + 1);
    expect(owned?.public_state).toBe("unknown");

    // The sibling was refused by the budget, said so, and sent nothing…
    expect(bucket).toMatchObject({ spent: true, blocked_reason: null });
    expect(silent.calls).toEqual([]);
    expect(deferredPass.outcome).toBe("deferred");
    const deferredSteps = deferredPass.steps.filter((s) => s.stage === "metadata");
    expect(deferredSteps).toEqual([
      expect.objectContaining({
        method: "conversations.info",
        result: "deferred",
        category: "budget_deferred",
        channelId: CHANNEL,
      }),
    ]);
    // …carrying the deadline the owner's grant persisted, never one it made up.
    expect(new Date(String(deferredSteps[0]?.nextPermittedAt)).getTime()).toBe(
      new Date(bucket?.next_permitted_at as Date).getTime()
    );

    // …so it TOOK nothing: the same owner, the same generation, no error code — and, compared whole,
    // not one column of the row moved while the owner's request was out.
    expect(afterSibling?.metadata_attempt_owner).toBe(owned?.metadata_attempt_owner);
    expect(afterSibling?.metadata_attempt_generation).toBe(owned?.metadata_attempt_generation);
    expect(afterSibling?.last_error_code).toBeNull();
    expect(afterSibling).toEqual(owned);

    // The one answer that WAS asked for is therefore the one that lands, under the one attempt that
    // was ever opened.
    expect(metadataSteps(ownerPass)).toEqual(["ok:"]);
    expect(after).toMatchObject({
      public_state: "public",
      binding_integration_id: workers.owner,
      metadata_attempt_owner: null,
    });
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(before.metadata_attempt_generation) + 1);
  });

  /**
   * The same rule with ONE process and no contention at all. A wake proves one channel and that
   * spends the app's `conversations.info` slot for a minute, so every wake inside that minute is
   * deferred when it turns to the next channel. Each of them used to bump that channel's generation
   * and write `budget_deferred` onto it — channel state manufactured from a budget fact.
   */
  it("leaves a channel it could not ask about untouched, and proves it on a later wake (PA-1, deferred)", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, {
      channelIds: [CHANNEL, OTHER_CHANNEL],
      token: TOKEN,
    });

    await discover(seed, integrationId, warmUp(APP_A));
    const pending = (await channelRows(seed.teamId)).find((row) => row.public_state === "unknown");
    if (!pending) throw new Error("fixture: one selected channel should still be unproved after the first wake");
    const pendingId = String(pending.channel_id);

    const silent = fakeSlack({});
    const waiting = await discover(seed, integrationId, silent);

    expect(silent.calls).toEqual([]);
    expect(waiting.steps.filter((s) => s.stage === "metadata")).toEqual([
      expect.objectContaining({ result: "deferred", category: "budget_deferred", channelId: pendingId }),
    ]);
    // Still unproved, still unowned, generation still zero, no error code: the WHOLE row.
    expect(await channelRow(seed.teamId, WORKSPACE, pendingId)).toEqual(pending);

    // …and it is still due: once the minute has passed, the next wake asks about exactly this one.
    await elapse(seed.teamId);
    const later = warmUp(APP_A);
    await discover(seed, integrationId, later);

    expect(later.paramsOf("conversations.info").map((p) => p.get("channel"))).toEqual([pendingId]);
    const proved = await channelRow(seed.teamId, WORKSPACE, pendingId);
    expect(proved).toMatchObject({ public_state: "public", metadata_attempt_owner: null });
    // ONE attempt in the channel's whole life — the wake that could not ask did not count as one.
    expect(Number(proved?.metadata_attempt_generation)).toBe(Number(pending.metadata_attempt_generation) + 1);
  });

  /**
   * The mirror of the first test with ONE thing changed: the sibling runs its own app, so it has its
   * own allowance and its reservation is granted. Now it must supersede, and the fence must still
   * refuse the answer it overtook — PA-1 narrows WHEN an attempt is opened, not what one means.
   */
  it("still lets a GRANTED sibling supersede, and refuses the answer it overtook (AC-PA-02)", async () => {
    const { seed, owner, sibling, before } = await twoWorkers(APP_B);

    const info = held(() => slackJson(channelInfoBody(CHANNEL)));
    const overtaken = fakeSlack({
      "conversations.info": info.handler,
      "conversations.history": () => {
        throw new Error("no channel may be read on an answer that was overtaken");
      },
    });
    const seen: { row: Row | null; followedItsGrant: boolean | null } = { row: null, followedItsGrant: null };
    const granted = fakeSlack({
      "conversations.info": async () => {
        // Read while THIS request is in flight, from a connection outside the app pool.
        seen.row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
        seen.followedItsGrant = await ownedAfterReserving(seed, APP_B);
        return slackJson(channelInfoBody(CHANNEL, { is_private: true }));
      },
    });

    const late = discover(seed, owner, overtaken);
    await inFlight(info.started, late);
    const owned = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const grantedPass = await discover(seed, sibling, granted);
    const afterSibling = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    info.release();
    const latePass = await late;
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    expect(owned?.metadata_attempt_owner).toEqual(expect.any(String));
    // The sibling's request really went out, and while it was out the channel was ITS: a different
    // owner, one generation on from the attempt it overtook.
    expect(granted.countOf("conversations.info")).toBe(1);
    expect(seen.row?.metadata_attempt_owner).toEqual(expect.any(String));
    expect(seen.row?.metadata_attempt_owner).not.toBe(owned?.metadata_attempt_owner);
    expect(Number(seen.row?.metadata_attempt_generation)).toBe(Number(owned?.metadata_attempt_generation) + 1);
    // ⚠️ SUPERSESSION IS WHAT A GRANT BUYS. The sibling took the channel only after its own slot was
    // granted — not before asking, which is the order that lets a worker with nothing to send
    // overtake one with a request in flight.
    expect(seen.followedItsGrant).toBe(true);

    expect(metadataSteps(grantedPass)).toEqual(["blocked:channel_private"]);
    expect(afterSibling).toMatchObject({
      public_state: "private",
      binding_integration_id: sibling,
      metadata_attempt_owner: null,
    });

    // The ordering fence is intact: the overtaken `public` answer changed nothing at all.
    expect(metadataSteps(latePass)).toEqual(["refused:metadata_superseded"]);
    expect(after).toEqual(afterSibling);
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(before.metadata_attempt_generation) + 2);
    expect(overtaken.countOf("conversations.history")).toBe(0);
  });

  /**
   * Two attempts in flight at once (two apps, two allowances), and the OLDER request dies in
   * transport. Its worker must hand back what it opened and nothing else: the newer attempt still
   * owns the channel, and its answer still lands.
   */
  it("releases only its OWN attempt when a request fails in transport (AC-PA-03)", async () => {
    const { seed, owner, sibling, before } = await twoWorkers(APP_B);

    const cut = held(() => {
      throw new Error("socket hang up");
    });
    const failing = fakeSlack({ "conversations.info": cut.handler });
    const info = held(() => slackJson(channelInfoBody(CHANNEL)));
    const answering = fakeSlack({
      "conversations.info": info.handler,
      "conversations.history": () => slackJson(historyBody({ messages: [] })),
    });

    const older = discover(seed, owner, failing);
    await inFlight(cut.started, older);
    const olderFollowedItsGrant = await ownedAfterReserving(seed, APP_A);
    const newer = discover(seed, sibling, answering);
    await inFlight(info.started, newer);
    const whileNewerInFlight = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    cut.release();
    const failedPass = await older;
    const afterFailure = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    info.release();
    const newerPass = await newer;
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    // The attempt this failure has to release is one PA-1 says may exist: opened for a request whose
    // slot had already been granted.
    expect(olderFollowedItsGrant).toBe(true);
    expect(whileNewerInFlight?.metadata_attempt_owner).toEqual(expect.any(String));
    expect(Number(whileNewerInFlight?.metadata_attempt_generation)).toBe(
      Number(before.metadata_attempt_generation) + 2
    );

    // The dead request is reported as the blip it was, and it released NOTHING that was not its own:
    // the newer owner, its generation and every other column are exactly as they were.
    expect(metadataSteps(failedPass)).toEqual(["delayed:network_error"]);
    expect(afterFailure).toEqual(whileNewerInFlight);

    // …so the newer answer lands under the ownership it never lost.
    expect(metadataSteps(newerPass)).toEqual(["ok:"]);
    expect(after).toMatchObject({
      public_state: "public",
      binding_integration_id: sibling,
      metadata_attempt_owner: null,
    });
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(before.metadata_attempt_generation) + 2);
  });

  it("leaves no owner and no verdict behind when its only request fails in transport (AC-PA-03)", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await discover(seed, integrationId, warmUp(APP_A));
    // BASELINE AFTER THE FIXTURE: ageing moves the very column under assertion.
    await agePublicProof(seed.teamId, CHANNEL);
    await elapse(seed.teamId);
    const proved = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(proved).toMatchObject({ public_state: "public", metadata_attempt_owner: null });

    const seen: { row: Row | null; followedItsGrant: boolean | null } = { row: null, followedItsGrant: null };
    const flaky = warmUp(APP_A, {
      "conversations.info": async () => {
        seen.row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
        seen.followedItsGrant = await ownedAfterReserving(seed, APP_A);
        throw new Error("socket hang up");
      },
    });

    const result = await discover(seed, integrationId, flaky);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    // A slot was granted, an attempt was opened FOR that request, and the request went out once.
    expect(flaky.countOf("conversations.info")).toBe(1);
    expect(seen.row?.metadata_attempt_owner).toEqual(expect.any(String));
    expect(Number(seen.row?.metadata_attempt_generation)).toBe(Number(proved?.metadata_attempt_generation) + 1);
    expect(seen.followedItsGrant).toBe(true);

    // The request died, so its attempt is handed back: nobody owns the channel…
    expect(metadataSteps(result)).toEqual(["delayed:network_error"]);
    expect(after?.metadata_attempt_owner).toBeNull();
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(proved?.metadata_attempt_generation) + 1);
    // …and a blip is not evidence: the verdict, its time and its binding are the ones already held.
    expect(after?.public_state).toBe("public");
    expect(after?.public_checked_at).toEqual(proved?.public_checked_at);
    expect(after?.binding_integration_id).toBe(proved?.binding_integration_id);
    expect(after?.binding_config_revision).toBe(proved?.binding_config_revision);
    // The provider may well have counted that request. The slot stays spent.
    expect(await infoBucket(seed, APP_A)).toMatchObject({ spent: true, blocked_reason: null });
  });

  /**
   * The hook itself fails: the slot is granted, and the statement that opens the attempt throws. No
   * request may leave without an attempt to order its answer by, the failure must surface rather
   * than read as a blip, and the slot that was reserved first is not handed back.
   */
  it("sends nothing when opening the attempt fails, and disturbs nobody else's (AC-PA-03)", async () => {
    const { seed, owner, sibling, before } = await twoWorkers(APP_B);

    const info = held(() => slackJson(channelInfoBody(CHANNEL)));
    const answering = fakeSlack({
      "conversations.info": info.handler,
      "conversations.history": () => slackJson(historyBody({ messages: [] })),
    });
    const silent = fakeSlack({});
    const broken = transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: (async (text: string, params?: unknown[]) => {
        if (OPENS_ATTEMPT.test(text)) throw new Error("forced attempt-open failure");
        return session.executeSql(text, params);
      }) as TransactionSession["executeSql"],
    }));

    const late = discover(seed, owner, answering);
    await inFlight(info.started, late);
    const owned = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const failure = await discover(seed, sibling, silent, { client: broken }).then(
      () => null,
      (error: unknown) => error
    );
    const afterFailure = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const siblingBucket = await infoBucket(seed, APP_B);
    info.release();
    const ownerPass = await late;
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    // NOTHING IS SWALLOWED: a hook failure rejects. It is not a transport outcome to classify, and
    // certainly not a transient one to shrug off.
    expect(failure).toMatchObject({ message: expect.stringMatching(/forced attempt-open failure/) });
    expect(silent.calls).toEqual([]);
    // ⚠️ THE SLOT WAS RESERVED FIRST, AND IT STAYS SPENT. A failure after the grant is never a refund
    // — and a bucket that does not exist at all means the attempt was opened before anything was
    // reserved, which is the order this correction removes.
    expect(siblingBucket).toMatchObject({ spent: true, blocked_reason: null });

    // No channel state: the owner in flight is still the owner, at the same generation, and not one
    // other column moved.
    expect(afterFailure).toEqual(owned);
    expect(metadataSteps(ownerPass)).toEqual(["ok:"]);
    expect(after).toMatchObject({
      public_state: "public",
      binding_integration_id: owner,
      metadata_attempt_owner: null,
    });
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(before.metadata_attempt_generation) + 1);
  });

  /**
   * The hook's one ABORT: the channel row is gone by the time the slot is granted. There is nothing
   * to open an attempt on, so there is nothing to send — the request is dropped before it leaves,
   * with the slot consumed. The row is removed from a second connection at the instant of the grant,
   * which is the latest moment it can vanish and still be the hook's to discover.
   */
  it("sends nothing when the channel row is gone by the time the slot is granted (AC-PA-03)", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await discover(seed, integrationId, identityOnly(APP_A), { maxRequests: 1 });
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ public_state: "unknown" });

    const seen = { vanished: 0 };
    const racing = transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: (async (text: string, params?: unknown[]) => {
        const result = await session.executeSql(text, params);
        if (GRANTS_SLOT.test(text) && params?.includes("conversations.info") && result.rows.length === 1) {
          const c = await rawSql();
          const gone = await c.query(
            `delete from slack_sync_channels where team_id = $1 and channel_id = $2`,
            [seed.teamId, CHANNEL]
          );
          seen.vanished += gone.rowCount ?? 0;
        }
        return result;
      }) as TransactionSession["executeSql"],
    }));
    const silent = fakeSlack({});

    // A vanished row ends the stage, as it always has. It is not a failed pass.
    const result = await discover(seed, integrationId, silent, { client: racing });

    // The fixture really removed the row at the grant — otherwise everything below is vacuous.
    expect(seen.vanished).toBe(1);
    expect(silent.countOf("conversations.info")).toBe(0);
    expect(silent.calls).toEqual([]);
    expect(await infoBucket(seed, APP_A)).toMatchObject({ spent: true, blocked_reason: null });
    // No channel state: nothing recreated the row, and no verdict was claimed for it.
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toBeNull();
    expect(
      result.steps.filter((s) => s.stage === "metadata" && (s.result === "ok" || s.result === "blocked"))
    ).toEqual([]);
  });

  /**
   * A BLOCKED bucket is a durable fact about a shared provider allowance: zero HTTP, no deadline,
   * and nothing whatsoever about the channel. It used to be written onto the channel as a definitive
   * `unverifiable` verdict — superseding, on the way, whoever really had a request in flight.
   */
  it("takes nothing from an in-flight owner when the bucket is BLOCKED (AC-PA-03b)", async () => {
    const { seed, owner, sibling, before } = await twoWorkers(APP_A);

    const info = held(() => slackJson(channelInfoBody(CHANNEL)));
    const answering = fakeSlack({
      "conversations.info": info.handler,
      "conversations.history": () => slackJson(historyBody({ messages: [] })),
    });
    const silent = fakeSlack({});

    const late = discover(seed, owner, answering);
    await inFlight(info.started, late);
    const owned = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    // Some OTHER caller of the shared allowance is told to stop while the owner's request is out.
    await blockInfoBucket(seed, APP_A);
    const bucketBefore = await infoBucket(seed, APP_A);
    const blockedPass = await discover(seed, sibling, silent);
    const afterSibling = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const bucketAfter = await infoBucket(seed, APP_A);
    info.release();
    const ownerPass = await late;
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    expect(owned?.metadata_attempt_owner).toEqual(expect.any(String));
    expect(silent.calls).toEqual([]);

    // The block stays VISIBLE — in the pass outcome, in its step report, and on the bucket…
    expect(blockedPass.outcome).toBe("blocked");
    const blockedSteps = blockedPass.steps.filter((s) => s.stage === "metadata");
    expect(blockedSteps).toEqual([
      expect.objectContaining({
        method: "conversations.info",
        result: "blocked",
        category: "retry_after_unrepresentable",
        channelId: CHANNEL,
      }),
    ]);
    // …with no retry time, because a block is not a cooldown waiting to expire…
    expect(blockedSteps[0]?.nextPermittedAt).toBeUndefined();
    expect(bucketAfter?.blocked_reason).toBe("retry_after_unrepresentable");
    // …and a denial reserves nothing: the bucket is exactly as the block left it.
    expect(bucketAfter).toEqual(bucketBefore);

    // …and NOT on the channel: still unproved (never `unverifiable`), no error code, the same owner
    // at the same generation — the whole row, unchanged.
    expect(afterSibling?.public_state).toBe("unknown");
    expect(afterSibling?.last_error_code).toBeNull();
    expect(afterSibling?.metadata_attempt_owner).toBe(owned?.metadata_attempt_owner);
    expect(afterSibling?.metadata_attempt_generation).toBe(owned?.metadata_attempt_generation);
    expect(afterSibling).toEqual(owned);

    // The request that was already out is answered, and its answer is applied.
    expect(metadataSteps(ownerPass)).toEqual(["ok:"]);
    expect(after).toMatchObject({
      public_state: "public",
      binding_integration_id: owner,
      metadata_attempt_owner: null,
    });
    expect(Number(after?.metadata_attempt_generation)).toBe(Number(before.metadata_attempt_generation) + 1);
  });

  it("does not turn a proved channel `unverifiable` because the bucket is BLOCKED (AC-PA-03b)", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await discover(seed, integrationId, warmUp(APP_A));
    // Aged past its cadence, so the proof is genuinely due for a re-check the bucket then refuses.
    await agePublicProof(seed.teamId, CHANNEL);
    await elapse(seed.teamId);
    await blockInfoBucket(seed, APP_A);
    const proved = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const bucketBefore = await infoBucket(seed, APP_A);
    expect(proved).toMatchObject({ public_state: "public", metadata_attempt_owner: null });
    expect(bucketBefore?.blocked_reason).toBe("retry_after_unrepresentable");

    const fake = warmUp(APP_A, {
      "conversations.info": () => {
        throw new Error("a blocked bucket must never reach the network");
      },
    });
    const result = await discover(seed, integrationId, fake);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    expect(fake.countOf("conversations.info")).toBe(0);
    expect(result.outcome).toBe("blocked");
    expect(metadataSteps(result)).toEqual(["blocked:retry_after_unrepresentable"]);
    expect(await infoBucket(seed, APP_A)).toEqual(bucketBefore);

    // The public state stays as it WAS. A budget marker is not an observation of the channel, so the
    // verdict, its time, its binding, its generation and its error code are the ones already held.
    expect(after?.public_state).toBe("public");
    expect(after?.public_checked_at).toEqual(proved?.public_checked_at);
    expect(after?.binding_integration_id).toBe(proved?.binding_integration_id);
    expect(after?.binding_config_revision).toBe(proved?.binding_config_revision);
    expect(after?.metadata_attempt_owner).toBeNull();
    expect(after?.metadata_attempt_generation).toBe(proved?.metadata_attempt_generation);
    expect(after?.last_error_code).toBe(proved?.last_error_code);
  });
});
