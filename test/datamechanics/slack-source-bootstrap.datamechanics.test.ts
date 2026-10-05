import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { deleteIntegration, upsertIntegration } from "@/lib/integrations/manage";
import { dueSlackChannels } from "@/lib/ingest/slack-channel-state";
// A namespace import ON PURPOSE: PA-2's validity read is named by member access below, so before it
// exists the tests that call it fail there, by name, rather than the whole file failing to link.
import * as slackBinding from "@/lib/ingest/slack-source-binding";
import { discoverSlackSource, type SlackSourceDiscoveryResult } from "@/lib/ingest/slack-source-discovery";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { decryptSecret } from "@/lib/secrets/crypto";
import { db, seedTeam, transactionSessionDecoratedDb, type Seed } from "./helpers";
import {
  agePublicProof,
  authTestBody,
  bindingRow,
  botsInfoBody,
  channelInfoBody,
  channelRow,
  channelRows,
  closeRawSql,
  disableSlackIntegration,
  elapse,
  fakeSlack,
  historyBody,
  integrationRow,
  rawSql,
  requireSlackSourceTables,
  rootMessage,
  rotateSlackSecret,
  seedSlackIntegration,
  setSlackChannelIds,
  slackJson,
  slackRateLimited,
  threadRootTs,
  threadRows,
  type Row,
  type SlackFake,
} from "./slack-source-helpers";

/**
 * AIO-1170 — the internal Slack SOURCE-DISCOVERY entrypoint, from a real `integrations` row to
 * durable roots, against real Postgres with an injected provider.
 *
 * WHAT THIS FILE PROVES: that app identity is BOOTSTRAPPED rather than asserted — auth.test, then
 * bots.info for exactly the bot auth.test named, resumable across the 1/min budget — that no channel
 * is read before that identity is bound, that a channel needs its own public proof, and that a token
 * or config change invalidates the binding before any further source read.
 *
 * WHAT IT DOES NOT PROVE: publication, identity/credit, timeline output, purge, namespace migration
 * or live activation. Nothing here writes an item.
 *
 * ⚠️ NO FIXTURE MINTS A VERIFIED STATE. Every `verified` binding and every `public` channel in this
 * file is reached by the real entrypoint answering fixture responses. A `seed a verified channel`
 * helper would make each of these assertions pass without the code under test doing anything.
 */

const WORKSPACE = "T0SOURCE1";
const OTHER_WORKSPACE = "T0SOURCE2";
const APP = "A0SOURCE1";
const BOT = "B0SOURCE1";
const CHANNEL = "C0SOURCE1";
const OTHER_CHANNEL = "C0SOURCE2";
const TOKEN = "xoxb-synthetic-not-a-real-token";
const ROTATED = "xoxb-synthetic-rotated-token";

beforeAll(requireSlackSourceTables);
afterAll(closeRawSql);

function discover(
  seed: Seed,
  integrationId: string,
  fake: SlackFake,
  over: {
    client?: ReturnType<typeof db>;
    envToken?: () => string | null;
    maxRequests?: number;
    metadataIntervalMs?: number;
  } = {}
): Promise<SlackSourceDiscoveryResult> {
  return discoverSlackSource(
    { db: over.client ?? db(), teamId: seed.teamId, integrationId },
    {
      fetchImpl: fake.impl,
      envToken: over.envToken ?? (() => null),
      maxRequests: over.maxRequests,
      metadataIntervalMs: over.metadataIntervalMs,
    }
  );
}

/** Every handler a fully successful pass needs, with `auth.test` already carrying an `app_id`. */
function fullPass(over: Parameters<typeof fakeSlack>[0] = {}): SlackFake {
  return fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: APP })),
    "conversations.info": (call) => slackJson(channelInfoBody(call.params.get("channel") ?? "")),
    "conversations.history": () =>
      slackJson(historyBody({ messages: [rootMessage("1718900000.000200"), rootMessage("1718900000.000100")] })),
    ...over,
  });
}

function categories(result: SlackSourceDiscoveryResult, stage: string): string[] {
  return result.steps.filter((s) => s.stage === stage).map((s) => `${s.result}:${s.category ?? ""}`);
}

// ── the stored shape ─────────────────────────────────────────────────────────

describe("the columns this slice may own", () => {
  it("binds an integration to an app identity, and stores no token plaintext", async () => {
    const c = await rawSql();
    const { rows } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_integration_bindings'
        order by column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "app_checked_at",
      "app_id",
      "auth_checked_at",
      "bot_id",
      // The two cache-validity stamps. The fingerprint is a HASH — never the token, and never a key
      // anything is scoped or named by.
      "config_revision",
      "created_at",
      "due_at",
      "error_code",
      "id",
      "integration_id",
      "selected_channel_ids",
      "state",
      "team_id",
      "token_fingerprint",
      "updated_at",
      "workspace_id",
      "workspace_url",
    ]);
  });

  it("stores channel PROGRESS, and no message content", async () => {
    const c = await rawSql();
    const { rows } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_sync_channels'
        order by column_name`
    );
    const columns = rows.map((r) => r.column_name);
    // A body/text/message column here would be staging wearing a cursor's clothes — and staged
    // content has purge rules this table has none of.
    expect(columns.filter((name) => /text|body|message|token|secret/.test(name))).toEqual([]);
    // The certified interval is SEPARATE from both lanes' progress; that separation is the table's
    // whole reason to exist, so it is asserted as a column fact.
    expect(columns).toEqual(
      expect.arrayContaining([
        "completed_lower_ts",
        "completed_upper_ts",
        "newest_catchup_upper_ts",
        "newest_anchor_ts",
        "newest_cursor",
        "newest_scan_generation",
        "historical_anchor_ts",
        "historical_cursor",
        "historical_scan_generation",
        "historical_floor_reached",
        "claimed_lane",
        "next_lane",
        "lease_owner",
        "lease_generation",
        "lease_expires_at",
        "public_state",
        "metadata_attempt_owner",
        "metadata_attempt_generation",
        "binding_config_revision",
      ])
    );
  });
});

// ── bootstrap ────────────────────────────────────────────────────────────────

describe("app-identity bootstrap", () => {
  it("returns the blocked binding written after an auth.test refusal", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fakeSlack({ "auth.test": () => slackJson({ ok: false, error: "invalid_auth" }) });

    const result = await discover(seed, integrationId, fake);

    expect(result.outcome).toBe("blocked");
    expect(categories(result, "auth")).toEqual(["blocked:invalid_auth"]);
    expect(result.binding).toMatchObject({ state: "blocked", errorCode: "invalid_auth" });
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({ state: "blocked", error_code: "invalid_auth" });
    expect(fake.calls.map((call) => call.method)).toEqual(["auth.test"]);
  });

  it("binds from auth.test's own app_id, reads the channel, and enqueues its roots", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fullPass();

    const result = await discover(seed, integrationId, fake);

    // auth.test carried the app, so the bots.info fallback is not reached at all.
    expect(fake.countOf("bots.info")).toBe(0);
    expect(fake.countOf("auth.test")).toBe(1);
    expect(fake.countOf("conversations.info")).toBe(1);
    expect(fake.countOf("conversations.history")).toBe(1);
    expect(result.outcome).toBe("progressed");

    const binding = await bindingRow(seed.teamId, integrationId);
    expect(binding).toMatchObject({
      state: "verified",
      workspace_id: WORKSPACE,
      app_id: APP,
      bot_id: BOT,
      workspace_url: "https://acme.slack.com/",
      selected_channel_ids: [CHANNEL],
      error_code: null,
    });

    const channel = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(channel).toMatchObject({ public_state: "public", binding_integration_id: integrationId });
    expect(channel?.public_checked_at).not.toBeNull();

    // Every top-level root on the page became durable pending work, under the SCOPED identity.
    expect(await threadRootTs(seed.teamId)).toEqual(["1718900000.000100", "1718900000.000200"]);

    // This terminal initial page certifies [oldest returned, EXACT request.latest].
    expect(channel?.completed_lower_ts).toBe("1718900000.000100");
    const request = fake.paramsOf("conversations.history")[0];
    expect(request.get("latest")).toMatch(/^[0-9]+\.[0-9]{6}$/);
    expect(channel?.completed_upper_ts).toBe(request.get("latest"));
    expect(request.get("oldest")).toBeNull();
    expect(channel?.newest_anchor_ts).toBeNull();
    expect(channel?.historical_anchor_ts).toBeNull();
    expect(channel?.historical_cursor).toBeNull();
    // …and the lease is not held between wakes.
    expect(channel?.lease_owner).toBeNull();
    expect(channel?.claimed_lane).toBeNull();
  });

  it("keeps valid workspace and app identity when the optional workspace URL is invalid", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fullPass({
      "auth.test": () => slackJson(authTestBody({ app_id: APP, url: "https://user:secret@acme.slack.com/" })),
    });

    const result = await discover(seed, integrationId, fake);

    expect(result.outcome).toBe("progressed");
    expect(result.binding).toMatchObject({ state: "verified", workspaceId: WORKSPACE, appId: APP, workspaceUrl: null });
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({
      state: "verified",
      workspace_id: WORKSPACE,
      app_id: APP,
      workspace_url: null,
    });
    expect(fake.countOf("conversations.history")).toBe(1);
  });

  it("falls back to bots.info for EXACTLY the bot auth.test named", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fullPass({
      "auth.test": () => slackJson(authTestBody()), // no app_id
      "bots.info": () => slackJson(botsInfoBody()),
    });

    await discover(seed, integrationId, fake);

    expect(fake.paramsOf("bots.info").map((p) => p.get("bot"))).toEqual([BOT]);
    // The SAME token as auth.test — the fallback is not a second credential.
    const botsCall = fake.calls.find((c) => c.method === "bots.info");
    expect(botsCall?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({
      state: "verified",
      app_id: APP,
      bot_id: BOT,
    });
  });

  it("resumes a DELAYED bots.info without re-running auth.test", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const first = fakeSlack({
      "auth.test": () => slackJson(authTestBody()),
      "bots.info": () => slackRateLimited("1"),
    });

    const delayed = await discover(seed, integrationId, first);
    expect(first.countOf("auth.test")).toBe(1);
    expect(first.countOf("bots.info")).toBe(1);
    // ⚠️ NOT ONE CHANNEL REQUEST. App identity is unresolved, so conversations.info/history are not
    // reachable — the metadata-only bootstrap exception grants nothing else.
    expect(first.countOf("conversations.info")).toBe(0);
    expect(first.countOf("conversations.history")).toBe(0);
    expect(delayed.binding).toMatchObject({ state: "pending_app", botId: BOT, errorCode: "rate_limited" });
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({ state: "pending_app", bot_id: BOT });

    await elapse(seed.teamId);
    const second = fullPass({
      "auth.test": () => {
        throw new Error("auth.test must not repeat merely because a LATER method was delayed");
      },
      "bots.info": () => slackJson(botsInfoBody()),
    });
    await discover(seed, integrationId, second);

    expect(second.countOf("auth.test")).toBe(0);
    expect(second.countOf("bots.info")).toBe(1);
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({ state: "verified", app_id: APP });
  });

  it("refuses to bind a mismatched, deleted or app-less bot, and reads no channel", async () => {
    const cases: { bot: Record<string, unknown>; category: string }[] = [
      { bot: { id: "B0OTHER99" }, category: "bot_mismatch" },
      { bot: { deleted: true }, category: "bot_deleted" },
      { bot: { app_id: undefined }, category: "missing_app_id" },
    ];
    for (const { bot, category } of cases) {
      const seed = await seedTeam();
      const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
      const fake = fakeSlack({
        "auth.test": () => slackJson(authTestBody()),
        "bots.info": () => slackJson(botsInfoBody(bot)),
      });

      const result = await discover(seed, integrationId, fake);

      expect(categories(result, "app")).toEqual([`blocked:${category}`]);
      expect(result.outcome).toBe("blocked");
      expect(fake.countOf("conversations.info")).toBe(0);
      expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({
        state: "blocked",
        app_id: null,
        error_code: category,
      });
      // Fail-closed, and nothing invented: no channel state was created for an unbound app.
      expect(await channelRows(seed.teamId)).toEqual([]);
    }
  });

  it("names users:read when bots.info reports missing_scope", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fakeSlack({
      "auth.test": () => slackJson(authTestBody()),
      "bots.info": () => slackJson({ ok: false, error: "missing_scope" }),
    });

    const result = await discover(seed, integrationId, fake);

    const step = result.steps.find((s) => s.stage === "app");
    expect(step).toMatchObject({ result: "blocked", category: "missing_scope" });
    expect(result.binding).toMatchObject({ state: "blocked", botId: BOT, errorCode: "missing_scope" });
    // The operator-facing half of a fail-closed diagnostic: which scope actually unblocks it.
    expect(step?.detail).toContain("users:read");
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({ state: "blocked" });
  });

  it("refuses a token whose auth.test establishes no workspace or bot identity", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fakeSlack({
      "auth.test": () => slackJson({ ok: true, url: "https://acme.slack.com/", user_id: "U1" }),
    });

    const result = await discover(seed, integrationId, fake);

    expect(categories(result, "auth")).toEqual(["blocked:missing_workspace_id"]);
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({
      state: "blocked",
      workspace_id: null,
    });
  });
});

// ── channel metadata ─────────────────────────────────────────────────────────

describe("channel public proof", () => {
  it("uses the configured metadata observation cadence", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await discover(seed, integrationId, fullPass());
    await agePublicProof(seed.teamId, CHANNEL); // seven days old
    await elapse(seed.teamId);

    const withinCadence = fullPass({
      "auth.test": () => { throw new Error("the binding is already verified"); },
      "conversations.info": () => { throw new Error("the 14-day cadence should reuse this proof"); },
    });
    await discover(seed, integrationId, withinCadence, { metadataIntervalMs: 14 * 24 * 60 * 60 * 1000 });
    expect(withinCadence.countOf("conversations.info")).toBe(0);

    await elapse(seed.teamId);
    const defaultCadence = fullPass({
      "auth.test": () => { throw new Error("the binding is already verified"); },
    });
    await discover(seed, integrationId, defaultCadence);
    expect(defaultCadence.countOf("conversations.info")).toBe(1);
  });

  it("blocks discovery for a private channel, and dispatches no history", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fullPass({
      "conversations.info": () => slackJson(channelInfoBody(CHANNEL, { is_private: true })),
    });

    const result = await discover(seed, integrationId, fake);

    expect(fake.countOf("conversations.history")).toBe(0);
    expect(categories(result, "metadata")).toEqual(["blocked:channel_private"]);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ public_state: "private" });
    // No purge, no deletion, no item work: this slice only refuses to READ further.
    expect(await threadRootTs(seed.teamId)).toEqual([]);
  });

  it("refuses a channel the response does not identify as the one asked about", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const fake = fullPass({
      "conversations.info": () => slackJson(channelInfoBody("C0DIFFERENT")),
    });

    const result = await discover(seed, integrationId, fake);

    expect(categories(result, "metadata")).toEqual(["blocked:channel_identity_mismatch"]);
    expect(fake.countOf("conversations.history")).toBe(0);
  });

  it("keeps a valid public proof across a TRANSIENT metadata failure, and never invents one", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });

    // Pass 1: prove it public.
    await discover(seed, integrationId, fullPass());
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ public_state: "public" });

    // Pass 2: the proof is past its TTL, so it is genuinely re-checked — and the recheck 429s. The
    // ageing is what makes this non-vacuous: a fresh proof is reused and the handler never fires.
    // BASELINE AFTER THE FIXTURE, never before it: ageing moves the very column under assertion.
    await agePublicProof(seed.teamId, CHANNEL);
    await elapse(seed.teamId);
    const proved = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const flaky = fullPass({ "conversations.info": () => slackRateLimited("1") });
    await discover(seed, integrationId, flaky);
    expect(flaky.countOf("conversations.info")).toBe(1);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.public_state).toBe("public");
    // The proof is not evidence that expired: neither the verdict nor its time was rewritten.
    expect(after?.public_checked_at).toEqual(proved?.public_checked_at);
    // …and the channel is still readable under the surviving proof.
    expect(flaky.countOf("conversations.history")).toBe(1);

    // …and a channel that was NEVER proved stays closed under the same transient failure.
    const other = await seedTeam();
    const otherIntegration = await seedSlackIntegration(other, { channelIds: [CHANNEL], token: TOKEN });
    const neverProved = fullPass({ "conversations.info": () => slackRateLimited("1") });
    await discover(other, otherIntegration, neverProved);
    expect(await channelRow(other.teamId, WORKSPACE, CHANNEL)).toMatchObject({ public_state: "unknown" });
    expect(neverProved.countOf("conversations.history")).toBe(0);
  });
});

// ── binding validity ─────────────────────────────────────────────────────────

describe("token and config changes invalidate the binding", () => {
  it("re-bootstraps after a SAVED-token rotation, preserving the certified frontier", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await discover(seed, integrationId, fullPass());
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(before?.completed_upper_ts).not.toBeNull();

    await rotateSlackSecret(seed, integrationId, ROTATED);
    await elapse(seed.teamId);

    const after = fullPass();
    // Spend this wake on the new binding and its public proof. A subsequent history request may
    // legitimately extend completed_upper_ts, so inspect preservation before that next read.
    await discover(seed, integrationId, after, { maxRequests: 2 });

    // The identity is proved again under the NEW token before anything else is read…
    expect(after.countOf("auth.test")).toBe(1);
    expect(after.calls[0]?.authorization).toBe(`Bearer ${ROTATED}`);
    expect(after.countOf("conversations.info")).toBe(1);
    expect(after.countOf("conversations.history")).toBe(0);
    // …and the pages we already read are not thrown away.
    const channel = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(channel?.completed_lower_ts).toBe(before?.completed_lower_ts);
    expect(channel?.completed_upper_ts).toBe(before?.completed_upper_ts);
  });

  it("detects an ENV-token rotation, which leaves integrations.updated_at untouched", async () => {
    const seed = await seedTeam();
    // No saved secret: the env fallback is the effective token, exactly as run.ts resolves it.
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL] });
    await discover(seed, integrationId, fullPass(), { envToken: () => TOKEN });
    const bound = await bindingRow(seed.teamId, integrationId);
    expect(bound).toMatchObject({ state: "verified" });
    const beforeRow = await integrationRow(integrationId);

    await elapse(seed.teamId);
    const rotated = fullPass();
    await discover(seed, integrationId, rotated, { envToken: () => ROTATED });

    // ⚠️ THE INTEGRATION ROW DID NOT MOVE — which is exactly why the fingerprint exists. A
    // revision built from `updated_at` alone cannot see an env rotation at all.
    expect((await integrationRow(integrationId))?.updated_at).toEqual(beforeRow?.updated_at);
    expect(rotated.countOf("auth.test")).toBe(1);
    const after = await bindingRow(seed.teamId, integrationId);
    expect(after?.token_fingerprint).not.toBe(bound?.token_fingerprint);
    expect(after?.config_revision).toBe(bound?.config_revision);
  });

  it("reports a disabled selection as inactive, with zero provider requests", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    await disableSlackIntegration(seed, integrationId);
    const fake = fakeSlack({});

    const result = await discover(seed, integrationId, fake);

    expect(result.outcome).toBe("inactive");
    expect(fake.calls).toEqual([]);
  });

  it("reports a selection with no effective token as a blocked configuration", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL] });
    const fake = fakeSlack({});

    const result = await discover(seed, integrationId, fake, { envToken: () => null });

    expect(result.outcome).toBe("blocked");
    expect(categories(result, "selection")).toEqual(["blocked:no_token"]);
    expect(fake.calls).toEqual([]);
  });
});

// ── scoping ──────────────────────────────────────────────────────────────────

describe("channel state is scoped, and shared where the provider shares it", () => {
  // ⚠️ EXTENDED ON PURPOSE (pre-activation correction PA-2, AC-PA-04). The one-row and two-selection
  // assertions are the original ones. What is added is what coalescing has to mean for the PROVIDER:
  // the channel is proved once and bound once, however many passes the two integrations run.
  it("coalesces two integrations that select one channel onto ONE frontier, proved once and bound once (AC-PA-04)", async () => {
    const seed = await seedTeam();
    const first = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const second = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-b" });

    const proving = fullPass();
    await discover(seed, first, proving);
    const bound = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    const sibling = fullPass();
    const stoodDown = await discover(seed, second, sibling);

    // ONE provider timeline, one row — the key deliberately excludes the integration.
    const rows = await channelRows(seed.teamId);
    expect(rows).toHaveLength(1);
    // Both bindings record the selection, which is how "who selects this channel" is answerable.
    expect((await bindingRow(seed.teamId, first))?.selected_channel_ids).toEqual([CHANNEL]);
    expect((await bindingRow(seed.teamId, second))?.selected_channel_ids).toEqual([CHANNEL]);

    // The second integration proved its OWN identity and asked nothing about the channel…
    expect(sibling.calls.map((call) => call.method)).toEqual(["auth.test"]);
    expect(categories(stoodDown, "metadata")).toEqual(["skipped:bound_to_valid_integration"]);
    // …so the frontier still belongs to the integration that proved it, at the revision it proved it.
    expect(rows[0]).toMatchObject({
      binding_integration_id: first,
      binding_config_revision: bound?.binding_config_revision,
    });

    // Later wakes change none of that: the binder is inside its cadence, the sibling still stands down.
    await elapse(seed.teamId);
    const binderAgain = fullPass();
    await discover(seed, first, binderAgain);
    await elapse(seed.teamId);
    const siblingAgain = fullPass();
    await discover(seed, second, siblingAgain);
    expect(siblingAgain.calls).toEqual([]);
    expect(
      [proving, sibling, binderAgain, siblingAgain].reduce((sum, fake) => sum + fake.countOf("conversations.info"), 0)
    ).toBe(1);
    expect(await channelRows(seed.teamId)).toHaveLength(1);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({
      binding_integration_id: first,
      binding_config_revision: bound?.binding_config_revision,
    });
  });

  it("keeps the same raw channel id independent across workspaces", async () => {
    const seed = await seedTeam();
    const here = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-here" });
    const there = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: ROTATED, name: "slack-there" });

    await discover(seed, here, fullPass());
    await elapse(seed.teamId);
    await discover(
      seed,
      there,
      fullPass({ "auth.test": () => slackJson(authTestBody({ app_id: APP, team_id: OTHER_WORKSPACE })) })
    );

    const rows = await channelRows(seed.teamId);
    expect(rows.map((r) => r.workspace_id)).toEqual([WORKSPACE, OTHER_WORKSPACE]);
    // Two frontiers, two thread scopes: a channel id is not unique across installations.
    const threads = await threadRows(seed.teamId);
    expect(new Set(threads.map((t) => t.workspace_id))).toEqual(new Set([WORKSPACE, OTHER_WORKSPACE]));
  });
});

// ── a coalesced channel is read only by its binder ───────────────────────────

/**
 * AIO-1170 pre-activation correction PA-2.
 *
 * Two enabled integrations selecting one channel share one frontier row. The integration recorded in
 * `binding_integration_id` (the BINDER) is the only one that reads it; the other STANDS DOWN — no
 * metadata reservation or attempt, no `conversations.info`, no history, no rebind — for as long as
 * four stored facts hold about the binder: its integration is enabled, its binding is verified, its
 * CURRENT config still selects the channel, and its binding's workspace is the row's workspace. When
 * any of them fails, the other integration proves the channel and takes the binding at once.
 *
 * ⚠️ FIXTURE RULE, AND ITS FOUR NAMED EXCEPTIONS. Every verified binding, public proof and scan
 * position here is earned through the real entrypoint. Four FAULT states cannot be produced by any
 * product writer and are injected with raw SQL, each marked where it happens and only AFTER the
 * channel's proof and progress were earned: (1) a binder with no binding row, (2) a binder id that
 * belongs to another team, (3) a binder id that is not a Slack integration, (4) a binder whose
 * stored secret cannot be decrypted.
 */

/** The stand-down diagnostic, verbatim. It is static: nothing in it comes from a provider or a row. */
const STAND_DOWN_DETAIL = "Another enabled, verified Slack integration selects this channel in this workspace.";
function standDown(channelId = CHANNEL): Record<string, unknown> {
  return {
    stage: "metadata",
    result: "skipped",
    category: "bound_to_valid_integration",
    detail: STAND_DOWN_DETAIL,
    channelId,
  };
}

/** The columns a takeover may NOT move: what has been read, and where each scan stands. */
const ACCEPTED_PROGRESS = [
  "historical_cursor",
  "newest_cursor",
  "historical_scan_generation",
  "newest_scan_generation",
  "historical_anchor_ts",
  "historical_oldest_seen_ts",
  "historical_floor_reached",
  "completed_lower_ts",
  "completed_upper_ts",
  "newest_catchup_upper_ts",
  "last_read_at",
] as const;

function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

/** Proves an integration's identity and stops: with ONE request to spend it asks about no channel. */
function identityOnly(): SlackFake {
  return fakeSlack({ "auth.test": () => slackJson(authTestBody({ app_id: APP })) });
}

/** A first history page that CONTINUES: stored partial historical progress, with a cursor to resume. */
const PARTIAL_FIRST_PAGE = {
  "conversations.history": () =>
    slackJson(historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "cursor-1" })),
};

/**
 * Two integrations of one app selecting one channel. The BINDER runs a full pass (identity, public
 * proof, one history page); the SIBLING is verified with a single request, so it has asked nothing
 * about the channel — under the old rule as well as the new one. Budgets are aged at the end.
 */
async function coalesced(binderPass: Parameters<typeof fakeSlack>[0] = {}): Promise<{
  seed: Seed;
  binder: string;
  sibling: string;
  binderResult: SlackSourceDiscoveryResult;
}> {
  const seed = await seedTeam();
  const binder = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
  const sibling = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-b" });
  const binderResult = await discover(seed, binder, fullPass(binderPass));
  await discover(seed, sibling, identityOnly(), { maxRequests: 1 });
  expect(await bindingRow(seed.teamId, sibling)).toMatchObject({ state: "verified", workspace_id: WORKSPACE });
  expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ binding_integration_id: binder });
  await elapse(seed.teamId);
  return { seed, binder, sibling, binderResult };
}

/** The same, with the binder's scan left mid-page: `next_lane = 'newest'`, no live lease. */
async function coalescedWithPartialProgress(): ReturnType<typeof coalesced> {
  const fixture = await coalesced(PARTIAL_FIRST_PAGE);
  const row = await channelRow(fixture.seed.teamId, WORKSPACE, CHANNEL);
  expect(row).toMatchObject({
    public_state: "public",
    historical_cursor: "cursor-1",
    next_lane: "newest",
    lease_owner: null,
  });
  expect(row?.historical_anchor_ts).not.toBeNull();
  return fixture;
}

/** The scope PA-2's validity read is asked about: one binder, one channel row. */
function binderScope(seed: Seed, integrationId: string, over: Record<string, string> = {}): Record<string, string> {
  return { teamId: seed.teamId, integrationId, workspaceId: WORKSPACE, channelId: CHANNEL, ...over };
}
function binderIsValid(scope: Record<string, string>): Promise<boolean> {
  return tx((session) => (slackBinding as unknown as {
    isSlackBinderValid(session: TransactionSession, scope: Record<string, string>): Promise<boolean>;
  }).isSlackBinderValid(session, scope));
}

/**
 * THE TAKEOVER, as AC-PA-06 states it. With ONE request to spend, a verified sibling sends exactly
 * one `conversations.info` and no history; the binding becomes the sibling's at its current revision;
 * everything already read stays read. The pass is not a metadata-only transition — the reader may
 * claim and release a lane it then cannot afford to send — so scheduling bookkeeping is free to move
 * and an unset newest bound may be initialized. From `next_lane = 'newest'` that claim hands the turn
 * to the historical lane, which is what makes the last step deterministic: the next history request
 * carries the SAVED cursor under the SAVED anchor.
 */
async function expectTakeoverPreservingProgress(
  seed: Seed,
  sibling: string,
  opts: { frontiers?: number } = {}
): Promise<void> {
  const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
  if (!before) throw new Error("fixture: the shared channel row is missing");
  expect(before).toMatchObject({ historical_cursor: "cursor-1", next_lane: "newest", lease_owner: null });

  await elapse(seed.teamId);
  const proof = fullPass({
    "auth.test": () => {
      throw new Error("the sibling is already verified; auth.test must not repeat");
    },
    "conversations.history": () => {
      throw new Error("one request allowance sends no history");
    },
  });
  const result = await discover(seed, sibling, proof, { maxRequests: 1 });

  expect(proof.calls.map((call) => `${call.method}:${call.params.get("channel")}`)).toEqual([
    `conversations.info:${CHANNEL}`,
  ]);
  expect(categories(result, "metadata")).toEqual(["ok:"]);
  expect(categories(result, "history")).toEqual(["skipped:invocation_budget"]);

  const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
  const siblingBinding = await bindingRow(seed.teamId, sibling);
  expect(after).toMatchObject({
    public_state: "public",
    binding_integration_id: sibling,
    binding_config_revision: siblingBinding?.config_revision,
  });
  expect(await channelRows(seed.teamId)).toHaveLength(opts.frontiers ?? 1);
  for (const column of ACCEPTED_PROGRESS) {
    expect(after?.[column], `${column} must survive the takeover`).toEqual(before[column]);
  }
  // A newest bound that was already initialized is progress too; an unset one may be initialized.
  for (const column of ["newest_anchor_ts", "newest_lower_ts"]) {
    if (before[column] !== null) expect(after?.[column], column).toEqual(before[column]);
  }
  // The no-send claim/release passed the turn on and left no lease behind.
  expect(after).toMatchObject({ next_lane: "historical", lease_owner: null });

  await elapse(seed.teamId);
  const resumed = fullPass({
    "auth.test": () => {
      throw new Error("the sibling is already verified; auth.test must not repeat");
    },
    "conversations.history": () =>
      slackJson(historyBody({ messages: [rootMessage("1718900000.000800")], hasMore: true, nextCursor: "cursor-2" })),
  });
  await discover(seed, sibling, resumed);

  expect(resumed.countOf("conversations.info")).toBe(0);
  const [request] = resumed.paramsOf("conversations.history");
  expect(request?.get("cursor")).toBe("cursor-1");
  expect(request?.get("latest")).toBe(before.historical_anchor_ts);
}

describe("a coalesced channel is read only by its binder (PA-2)", () => {
  it("stands a warmed sibling down with the static diagnostic, idle, and leaves the row untouched (AC-PA-04b)", async () => {
    const { seed, binder, sibling } = await coalesced();

    for (let wake = 0; wake < 3; wake++) {
      // Read per wake: the clock fixture at the end of each one moves `due_at`, and only that.
      const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      expect(row).toMatchObject({ binding_integration_id: binder, public_state: "public" });
      // No handler at all: any request the sibling makes is recorded here, and then throws.
      const silent = fakeSlack({});
      const result = await discover(seed, sibling, silent);

      expect(silent.calls).toEqual([]);
      // EXACTLY this step and no other: static detail, the channel, and no `method` — nothing was asked.
      expect(result.steps).toStrictEqual([standDown()]);
      // Standing down is not deferred work. Nothing is owed by this integration for this channel.
      expect(result.outcome).toBe("idle");
      expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toEqual(row);
      await elapse(seed.teamId);
    }

    // The BINDER's cadence is still the existing predicate's: nothing inside it, once past it.
    const inside = fullPass();
    await discover(seed, binder, inside);
    expect(inside.countOf("auth.test")).toBe(0);
    expect(inside.countOf("conversations.info")).toBe(0);
    await agePublicProof(seed.teamId, CHANNEL);
    await elapse(seed.teamId);
    const due = fullPass();
    await discover(seed, binder, due);
    expect(due.paramsOf("conversations.info").map((p) => p.get("channel"))).toEqual([CHANNEL]);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ binding_integration_id: binder });
  });

  it("skips a validly foreign-bound channel and still proves the next candidate, on one allowance (AC-PA-04c)", async () => {
    const seed = await seedTeam();
    const binder = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const sibling = await seedSlackIntegration(seed, {
      channelIds: [CHANNEL, OTHER_CHANNEL],
      token: TOKEN,
      name: "slack-b",
    });
    await discover(seed, binder, fullPass());
    await discover(seed, sibling, identityOnly(), { maxRequests: 1 });
    await elapse(seed.teamId);

    // The fixture is only meaningful if the foreign-bound channel really IS the first candidate.
    const order = await tx((session) =>
      dueSlackChannels(session, {
        teamId: seed.teamId,
        workspaceId: WORKSPACE,
        channelIds: [CHANNEL, OTHER_CHANNEL],
      })
    );
    expect(order.map((state) => state.scope.channelId)).toEqual([CHANNEL, OTHER_CHANNEL]);
    const shared = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(shared).toMatchObject({ binding_integration_id: binder });

    const proof = fullPass({
      "auth.test": () => {
        throw new Error("the sibling is already verified; auth.test must not repeat");
      },
    });
    const result = await discover(seed, sibling, proof, { maxRequests: 1 });

    // The ONE request this pass could afford went to the channel it may actually prove.
    expect(proof.calls.map((call) => `${call.method}:${call.params.get("channel")}`)).toEqual([
      `conversations.info:${OTHER_CHANNEL}`,
    ]);
    expect(
      result.steps.filter((s) => s.stage === "metadata").map((s) => `${s.result}:${s.category ?? ""}:${s.channelId}`)
    ).toEqual([`skipped:bound_to_valid_integration:${CHANNEL}`, `ok::${OTHER_CHANNEL}`]);
    // The skipped channel cost neither an allowance nor a metadata attempt: its row did not move.
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toEqual(shared);
    expect(await channelRow(seed.teamId, WORKSPACE, OTHER_CHANNEL)).toMatchObject({
      public_state: "public",
      binding_integration_id: sibling,
    });
  });

  it("lets the binder re-prove once after its own config change; the sibling asks nothing and does not rebind (AC-PA-05)", async () => {
    const { seed, binder, sibling } = await coalesced();
    const boundAt = (await bindingRow(seed.teamId, binder))?.config_revision;

    // THE ORDER IS THE TEST: the binder finishes its bootstrap and its proof BEFORE the sibling runs.
    await setSlackChannelIds(seed, [CHANNEL, OTHER_CHANNEL], "slack-a");
    const reproof = fullPass();
    await discover(seed, binder, reproof);
    expect(reproof.countOf("auth.test")).toBe(1);
    expect(reproof.paramsOf("conversations.info").map((p) => p.get("channel"))).toEqual([CHANNEL]);
    const rebound = (await bindingRow(seed.teamId, binder))?.config_revision;
    expect(rebound).not.toBe(boundAt);

    await elapse(seed.teamId);
    const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(row).toMatchObject({ binding_integration_id: binder, binding_config_revision: rebound });
    const silent = fakeSlack({});
    const result = await discover(seed, sibling, silent);
    expect(silent.calls).toEqual([]);
    expect(result.steps).toStrictEqual([standDown()]);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toEqual(row);
  });

  it("takes a channel from a binder left `pending_app`, and the former binder does not take it back (AC-PA-05b)", async () => {
    const seed = await seedTeam();
    const binder = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const sibling = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-b" });
    // Both identities need the `bots.info` fallback, and that allowance is ONE per workspace. That is
    // what makes a real deferral reachable below without moving any clock by hand.
    const viaBotsInfo = (over: Parameters<typeof fakeSlack>[0] = {}): SlackFake =>
      fullPass({
        "auth.test": () => slackJson(authTestBody()),
        "bots.info": () => slackJson(botsInfoBody()),
        ...over,
      });

    await discover(seed, binder, viaBotsInfo());
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ binding_integration_id: binder });
    await elapse(seed.teamId);

    // The sibling is verified — spending the workspace's `bots.info` slot — and stands down.
    const warm = viaBotsInfo();
    await discover(seed, sibling, warm);
    expect(warm.calls.map((call) => call.method)).toEqual(["auth.test", "bots.info"]);
    expect(await bindingRow(seed.teamId, sibling)).toMatchObject({ state: "verified", app_id: APP });
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ binding_integration_id: binder });

    // The binder's config changes. Its reboot gets through `auth.test` and is DEFERRED at `bots.info`,
    // inside the minute the sibling just spent: a real deferral, never sent.
    await setSlackChannelIds(seed, [CHANNEL, OTHER_CHANNEL], "slack-a");
    const reboot = fakeSlack({ "auth.test": () => slackJson(authTestBody()) });
    const rebooting = await discover(seed, binder, reboot);
    expect(reboot.calls.map((call) => call.method)).toEqual(["auth.test"]);
    expect(categories(rebooting, "app")).toEqual(["deferred:budget_deferred"]);
    expect(await bindingRow(seed.teamId, binder)).toMatchObject({ state: "pending_app" });
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ binding_integration_id: binder });

    // A binder that is not verified is not valid: the sibling, with budget, proves and takes the row.
    const takeover = viaBotsInfo({
      "auth.test": () => {
        throw new Error("the sibling is already verified; auth.test must not repeat");
      },
    });
    await discover(seed, sibling, takeover);
    expect(takeover.countOf("bots.info")).toBe(0);
    expect(takeover.paramsOf("conversations.info").map((p) => p.get("channel"))).toEqual([CHANNEL]);
    const taken = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(taken).toMatchObject({
      public_state: "public",
      binding_integration_id: sibling,
      binding_config_revision: (await bindingRow(seed.teamId, sibling))?.config_revision,
    });

    // The former binder finishes its bootstrap — and finds a valid binder that is not itself.
    await elapse(seed.teamId);
    const finishing = viaBotsInfo({
      "auth.test": () => {
        throw new Error("`pending_app` resumes at bots.info; auth.test must not repeat");
      },
    });
    const finished = await discover(seed, binder, finishing);
    expect(finishing.countOf("bots.info")).toBe(1);
    expect(await bindingRow(seed.teamId, binder)).toMatchObject({ state: "verified" });
    // ZERO requests about the shared channel, of any method…
    expect(finishing.calls.filter((call) => call.params.get("channel") === CHANNEL)).toEqual([]);
    expect(finished.steps).toContainEqual(standDown());
    // …and the binding stays where the takeover put it.
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({
      binding_integration_id: sibling,
      binding_config_revision: taken?.binding_config_revision,
    });
  });

  it("keeps the sibling standing down after a binder config edit the binder has not yet acted on (AC-PA-05c)", async () => {
    const { seed, binder, sibling } = await coalesced();
    const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const boundAt = (await bindingRow(seed.teamId, binder))?.config_revision;

    // The binder's config is edited, keeping the channel. The binder has NOT run: its binding is still
    // verified, at the OLD revision, in the same workspace.
    await setSlackChannelIds(seed, [CHANNEL, OTHER_CHANNEL], "slack-a");
    expect(await bindingRow(seed.teamId, binder)).toMatchObject({
      state: "verified",
      workspace_id: WORKSPACE,
      config_revision: boundAt,
    });

    // A revision mismatch alone admits nobody.
    const silent = fakeSlack({});
    const result = await discover(seed, sibling, silent);
    expect(silent.calls).toEqual([]);
    expect(result.steps).toStrictEqual([standDown()]);
    expect(result.outcome).toBe("idle");
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toEqual(row);

    // Then the binder runs, through its bootstrap, and re-proves exactly once at its new revision.
    const reproof = fullPass();
    await discover(seed, binder, reproof);
    expect(reproof.countOf("auth.test")).toBe(1);
    expect(reproof.paramsOf("conversations.info").map((p) => p.get("channel"))).toEqual([CHANNEL]);
    const rebound = (await bindingRow(seed.teamId, binder))?.config_revision;
    expect(rebound).not.toBe(boundAt);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({
      binding_integration_id: binder,
      binding_config_revision: rebound,
    });
  });

  // ── AC-PA-06: an invalid binder is taken over at once ──────────────────────
  // PRESERVATION GUARDS. Takeover is what the code already did for EVERY foreign binding, so these may
  // pass before PA-2 as well as after. Their job is to stay green, and to go red when one of the four
  // validity conditions is dropped (the mutation each case names).

  it.each([
    {
      binderIs: "disabled",
      mutation: "condition 1 (enabled)",
      invalidate: async (seed: Seed, binder: string) => {
        await disableSlackIntegration(seed, binder);
      },
    },
    {
      binderIs: "deleted",
      mutation: "the unbound first-proof path",
      invalidate: async (seed: Seed, binder: string) => {
        await deleteIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, binder);
      },
    },
    {
      binderIs: "no longer selecting the channel (its cached selection not yet refreshed)",
      mutation: "condition 3 (current selection)",
      invalidate: async (seed: Seed, binder: string) => {
        await setSlackChannelIds(seed, [OTHER_CHANNEL], "slack-a");
        // The binder has not run, so its binding row still CACHES the old selection.
        expect((await bindingRow(seed.teamId, binder))?.selected_channel_ids).toEqual([CHANNEL]);
      },
    },
    {
      binderIs: "without a binding row",
      mutation: "the missing-binding existence check",
      invalidate: async (seed: Seed, binder: string) => {
        // NAMED FIXTURE EXCEPTION 1 — raw SQL. No product writer deletes a binding row while its
        // integration lives. Injected only after the proof and the partial scan were earned.
        const c = await rawSql();
        await c.query(`delete from slack_integration_bindings where team_id = $1 and integration_id = $2`, [
          seed.teamId,
          binder,
        ]);
        expect(await bindingRow(seed.teamId, binder)).toBeNull();
      },
    },
    {
      binderIs: "`pending_auth`",
      mutation: "condition 2 (verified)",
      invalidate: async (seed: Seed, binder: string) => {
        await rotateSlackSecret(seed, binder, ROTATED);
        await discover(seed, binder, fakeSlack({ "auth.test": () => slackRateLimited("1") }));
        expect(await bindingRow(seed.teamId, binder)).toMatchObject({ state: "pending_auth" });
      },
    },
    {
      binderIs: "`blocked`",
      mutation: "condition 2 (verified)",
      invalidate: async (seed: Seed, binder: string) => {
        await rotateSlackSecret(seed, binder, ROTATED);
        await discover(seed, binder, fakeSlack({ "auth.test": () => slackJson({ ok: false, error: "invalid_auth" }) }));
        expect(await bindingRow(seed.teamId, binder)).toMatchObject({ state: "blocked" });
      },
    },
  ])("takes over from a binder that is $binderIs, keeping what was read (AC-PA-06; mutation: $mutation)", async ({ invalidate }) => {
    const { seed, binder, sibling } = await coalescedWithPartialProgress();
    await invalidate(seed, binder);
    await expectTakeoverPreservingProgress(seed, sibling);
  });

  // ── AC-PA-06b: the validity read itself ────────────────────────────────────

  it("answers the validity question from stored facts, in lock-free, token-free, team-scoped SQL (AC-PA-06b)", async () => {
    const { seed, binder } = await coalesced();
    const statements: { sql: string; params: unknown[] }[] = [];
    // A RECORDING session around the real one: the helper is called on its own, so nothing here is a
    // pass's legitimate read of its OWN integration row.
    const recording = transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: (async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params: params ?? [] });
        return session.executeSql(sql, params);
      }) as TransactionSession["executeSql"],
    }));
    const scope = binderScope(seed, binder);

    const valid = await transactionCapability(recording).transaction((session) =>
      (slackBinding as unknown as {
        isSlackBinderValid(session: TransactionSession, scope: Record<string, string>): Promise<boolean>;
      }).isSlackBinderValid(session, scope)
    );

    expect(valid).toBe(true);
    expect(statements.length).toBeGreaterThan(0);
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i);
      expect(sql).not.toMatch(/secret_ciphertext|token_fingerprint/i);
    }
    const read = statements.find(({ sql }) => /slack_integration_bindings/i.test(sql));
    expect(read, "the read joins the binder's binding").toBeDefined();
    // Scoped to THIS team and THIS recorded binder — never an unscoped lookup by id.
    expect(read?.params).toEqual(expect.arrayContaining([seed.teamId, binder]));
    expect(read?.sql).toMatch(/type\s*=\s*'slack'/i);
    // The binding is joined on BOTH halves of its key.
    const on = /join\s+slack_integration_bindings[\s\S]*?\bon\b([\s\S]*?)\bwhere\b/i.exec(read?.sql ?? "")?.[1] ?? "";
    expect(on).toMatch(/team_id/i);
    expect(on).toMatch(/integration_id/i);
  });

  it("is valid only while all four stored facts hold, and never for a row its scope does not match (AC-PA-06b)", async () => {
    const { seed, binder } = await coalesced();
    const other = await seedTeam();

    expect(await binderIsValid(binderScope(seed, binder))).toBe(true);
    // Condition 4: the binding's workspace is not this row's workspace.
    expect(await binderIsValid(binderScope(seed, binder, { workspaceId: OTHER_WORKSPACE }))).toBe(false);
    // Condition 3: the binder's current config does not select this channel.
    expect(await binderIsValid(binderScope(seed, binder, { channelId: OTHER_CHANNEL }))).toBe(false);
    // No such integration, and the right integration asked about under the WRONG team: no scoped row.
    expect(await binderIsValid(binderScope(seed, "7c9e6679-7425-40de-944b-e07fc1f90ae7"))).toBe(false);
    expect(await binderIsValid(binderScope(other, binder))).toBe(false);
    // Condition 1, changed through the product writer: disabling leaves the binding row verified.
    await disableSlackIntegration(seed, binder);
    expect(await bindingRow(seed.teamId, binder)).toMatchObject({ state: "verified" });
    expect(await binderIsValid(binderScope(seed, binder))).toBe(false);
  });

  it("stands down cleanly behind a valid binder whose stored secret cannot be decrypted (AC-PA-06b)", async () => {
    const { seed, binder, sibling } = await coalescedWithPartialProgress();
    // NAMED FIXTURE EXCEPTION 4 — raw SQL. No product writer stores a secret it cannot decrypt.
    // Injected only after the binder's public proof AND its partial scan were earned.
    const c = await rawSql();
    await c.query(`update integrations set secret_ciphertext = 'not-a-ciphertext' where id = $1`, [binder]);
    // The fault is real: the value does not decrypt, and the binder's OWN pass now rejects on it —
    // before it can touch its binding, which therefore stays verified.
    expect(() => decryptSecret("not-a-ciphertext")).toThrow();
    await expect(discover(seed, binder, fakeSlack({}))).rejects.toThrow();
    expect(await bindingRow(seed.teamId, binder)).toMatchObject({ state: "verified" });
    const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    if (!row) throw new Error("fixture: the shared channel row is missing");
    expect(row).toMatchObject({ binding_integration_id: binder, historical_cursor: "cursor-1", next_lane: "newest" });

    // The sibling never needed that secret. A validity read that decrypted it would reject here.
    const silent = fakeSlack({});
    const result = await discover(seed, sibling, silent);

    expect(silent.calls).toEqual([]);
    expect(result.steps).toStrictEqual([standDown()]);
    expect(result.outcome).toBe("idle");
    // The binder's partial scan is exactly where it left it — named column by column, then whole.
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    for (const column of ACCEPTED_PROGRESS) {
      expect(after?.[column], `${column} must survive the stand-down`).toEqual(row[column]);
    }
    expect(after).toEqual(row);
  });

  it("rejects the pass when the validity read FAILS: an error is never 'invalid', and never a takeover (AC-PA-06b)", async () => {
    const { seed, sibling } = await coalesced();
    const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    // The one statement that reads another integration's row together with its binding. The pass's
    // reads of its OWN selection name only one of the two tables.
    const failing = transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: (async (sql: string, params?: unknown[]) => {
        if (/slack_integration_bindings/i.test(sql) && /\b(from|join)\s+integrations\b/i.test(sql)) {
          throw new Error("forced binder-validity failure");
        }
        return session.executeSql(sql, params);
      }) as TransactionSession["executeSql"],
    }));
    const answering = fullPass();

    await expect(discover(seed, sibling, answering, { client: failing })).rejects.toThrow(
      /forced binder-validity failure/
    );

    expect(answering.calls).toEqual([]);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toEqual(row);
  });

  /**
   * A binder id that belongs to ANOTHER TEAM. The foreign integration is made as valid as it can be —
   * enabled, verified in the same workspace id, selecting the same channel id — so the only thing that
   * makes it invalid for this row is the team scope of the lookup.
   */
  async function withCrossTeamBinder(): Promise<{ seed: Seed; sibling: string; foreign: Seed; foreignBinder: string }> {
    const { seed, sibling } = await coalescedWithPartialProgress();
    const foreign = await seedTeam();
    const foreignBinder = await seedSlackIntegration(foreign, { channelIds: [CHANNEL], token: TOKEN });
    await discover(foreign, foreignBinder, fullPass());
    expect(await bindingRow(foreign.teamId, foreignBinder)).toMatchObject({
      state: "verified",
      workspace_id: WORKSPACE,
      selected_channel_ids: [CHANNEL],
    });
    // NAMED FIXTURE EXCEPTION 2 — raw SQL. No product writer records another team's integration as a
    // channel's binder. Injected only after this team's proof and partial scan were earned.
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels set binding_integration_id = $3 where team_id = $1 and channel_id = $2`,
      [seed.teamId, CHANNEL, foreignBinder]
    );
    return { seed, sibling, foreign, foreignBinder };
  }

  it("does not let another team's otherwise-valid integration hold this team's channel (AC-PA-06b)", async () => {
    const { seed, foreign, foreignBinder } = await withCrossTeamBinder();
    // Under its OWN team it is a perfectly valid binder: nothing but the team scope refuses it here.
    expect(await binderIsValid(binderScope(foreign, foreignBinder))).toBe(true);
    expect(await binderIsValid(binderScope(seed, foreignBinder))).toBe(false);
  });

  it("takes over from a cross-team binder id through the ordinary proof path (AC-PA-06b)", async () => {
    const { seed, sibling } = await withCrossTeamBinder();
    await expectTakeoverPreservingProgress(seed, sibling);
  });

  it("takes over from a binder id that is not a Slack integration (AC-PA-06b)", async () => {
    const { seed, sibling } = await coalescedWithPartialProgress();
    const { id: notSlack } = await upsertIntegration(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId },
      { type: "github", name: "not-slack", config: {} }
    );
    // NAMED FIXTURE EXCEPTION 3 — raw SQL. No product writer records a non-Slack integration as a
    // channel's binder. Injected only after the proof and the partial scan were earned.
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels set binding_integration_id = $3 where team_id = $1 and channel_id = $2`,
      [seed.teamId, CHANNEL, notSlack]
    );

    await expectTakeoverPreservingProgress(seed, sibling);
  });

  // ── AC-PA-06c: the decided limitation ──────────────────────────────────────

  /**
   * Whether a channel is READABLE is a property of a token, and nothing records which integration's
   * token can read which channel. A valid binder that is refused a history read therefore stays the
   * binder. The refusal is visible — on the row and in the binder's pass — and the sibling makes no
   * inference from it. Closing this needs per-integration reachability state (a schema change).
   */
  describe("a valid binder whose token cannot read the channel keeps it (AC-PA-06c)", () => {
    interface Limitation {
      binder: string;
      sibling: string;
      standing: Row | null;
      siblingPasses: { calls: SlackFake["calls"]; result: SlackSourceDiscoveryResult }[];
      after: Row | null;
    }
    const TEST_TIMEOUT_MS = 30_000;

    /** The whole fixture AND its preconditions. It throws like any fixture; `limitation()` is what tames that. */
    async function runLimitation(): Promise<Limitation> {
      const { seed, binder, sibling } = await coalesced();
      const refusing = fullPass({
        "conversations.history": () => slackJson({ ok: false, error: "not_in_channel" }),
      });
      const refusal = await discover(seed, binder, refusing);
      // Read BEFORE any later write could replace it: channel errors are current state, not history.
      const refused = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      // PRECONDITIONS: a valid binder really was refused the read, the refusal is reported on its own
      // pass, and it is persisted on the row it still binds.
      expect(categories(refusal, "history")).toEqual(["delayed:not_in_channel"]);
      expect(refused).toMatchObject({
        binding_integration_id: binder,
        public_state: "public",
        last_error_code: "not_in_channel",
      });

      // Every budget is available again, so standing down below is a decision and not a deferral. The
      // clock fixture moves `due_at`, which is why the baseline is read after it.
      await elapse(seed.teamId);
      const standing = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      expect(standing).toMatchObject({ binding_integration_id: binder, last_error_code: "not_in_channel" });
      const siblingPasses: Limitation["siblingPasses"] = [];
      for (let wake = 0; wake < 2; wake++) {
        // A provider that WOULD answer this sibling — so that a future fix has something to take over with.
        const answering = fullPass();
        siblingPasses.push({ result: await discover(seed, sibling, answering), calls: answering.calls });
      }
      return { binder, sibling, standing, siblingPasses, after: await channelRow(seed.teamId, WORKSPACE, CHANNEL) };
    }

    /**
     * ⚠️ THE FIXTURE IS A VALUE, NEVER A THROW — and that is the whole point of this shape.
     *
     * `it.fails` inverts its test: ANYTHING that fails inside its lifecycle counts as the failure it
     * expects. A fixture run in a `beforeEach`, or awaited bare in its body, could therefore break —
     * a seed error, a failed precondition, a hang — and the expected-failure test would report green
     * for a reason that has nothing to do with the limitation it pins.
     *
     * So the fixture and its preconditions run ONCE, on first use by EITHER test, and the result is
     * remembered as `{ ok: true, … }` or `{ ok: false, error }`: a rejection becomes `ok: false`. This
     * does not depend on which test runs first, or on both running — whichever asks first pays for it.
     *
     * ⚠️ NOTHING HERE RACES THE FIXTURE. The remembered promise IS the fixture's own, settling only when
     * every database and provider step it started has finished, so a test that has its answer has also
     * seen the fixture drained. There is deliberately no give-up timer beside it: one would hand a test
     * its answer while the fixture was still writing, and the next test's truncation would run under it.
     * A fixture that never settles is left to the test timeout, and to the two hooks below.
     *
     * ISOLATION: the suite truncates the database before every test, so the SECOND test to run finds
     * none of these rows. It does not need them — both tests read only what was captured here.
     */
    type Settled = ({ ok: true } & Limitation) | { ok: false; error: unknown };
    let settled: Promise<Settled> | undefined;
    function limitation(): Promise<Settled> {
      settled ??= runLimitation().then(
        (value): Settled => ({ ok: true, ...value }),
        (error: unknown): Settled => ({ ok: false, error })
      );
      return settled;
    }
    // NO TEST HANDS THE DATABASE ON until the fixture has settled. In the ordinary case that is already
    // true and both hooks cost nothing. If a test was TIMED OUT while the fixture was still running,
    // the `afterEach` waits it out BEFORE the next test's suite-wide truncation can start — this hook
    // runs after each test here, timed out or not, and ahead of the next test's `beforeEach`.
    afterEach(async () => {
      await settled;
    });
    // The same wait once more, outside any test's lifecycle. A hook failing inside an `it.fails` test
    // is inverted along with the test; this one is not, so a fixture that NEVER settles is red for the
    // suite whatever the inverted test below made of its own timeout.
    afterAll(async () => {
      await settled;
    });

    it("persists the refusal, reports it on the binder's pass, and the sibling stands down every time", async () => {
      const scenario = await limitation();
      // In an ORDINARY test a fixture or precondition failure is simply a failure, with its own message.
      if (!scenario.ok) throw scenario.error;

      for (const pass of scenario.siblingPasses) {
        expect(pass.calls).toEqual([]);
        expect(pass.result.steps).toStrictEqual([standDown()]);
        expect(pass.result.outcome).toBe("idle");
      }
      // Binding, refusal and frontier are exactly as the binder's refused read left them.
      expect(scenario.after).toEqual(scenario.standing);
    }, TEST_TIMEOUT_MS);

    // EXPECTED TO FAIL, on purpose and for ONE reason: the single assertion below. When reachability
    // is recorded per integration and a sibling that CAN read the channel takes it, this flips red —
    // which is the signal to delete the limitation, not to delete this test.
    it.fails("is taken over by the sibling whose token could read it (AC-PA-06c: not solved)", async () => {
      const scenario = await limitation();
      // NOT an assertion. A fixture that failed must not be mistaken for the failure this test
      // expects: returning makes the inverted test FAIL, loudly, for want of anything to invert.
      if (!scenario.ok) return;
      expect(scenario.after?.binding_integration_id).toBe(scenario.sibling);
    }, TEST_TIMEOUT_MS);
  });

  // ── AC-PA-06d: a non-public verdict is not an invalid binder ───────────────

  it.each([
    {
      verdict: "private",
      category: "channel_private",
      answer: () => slackJson(channelInfoBody(CHANNEL, { is_private: true })),
    },
    {
      verdict: "unverifiable",
      category: "channel_not_found",
      answer: () => slackJson({ ok: false, error: "channel_not_found" }),
    },
  ])("keeps a valid binder whose verdict is $verdict: the sibling stands down and reads nothing (AC-PA-06d)", async ({ verdict, category, answer }) => {
    const { seed, binder, sibling, binderResult } = await coalesced({ "conversations.info": answer });
    // The binder's verdict and category are on its own pass report and on the row.
    expect(categories(binderResult, "metadata")).toEqual([`blocked:${category}`]);

    for (let wake = 0; wake < 2; wake++) {
      // Read per wake: the clock fixture at the end of each one moves `due_at`, and only that.
      const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      expect(row).toMatchObject({
        public_state: verdict,
        binding_integration_id: binder,
        last_error_code: category,
      });
      // This provider would call the channel PUBLIC for the sibling. Public status is not a validity
      // input: the binder is still enabled, verified, selecting the channel, in this workspace.
      const answering = fullPass();
      const result = await discover(seed, sibling, answering);

      expect(answering.calls).toEqual([]);
      expect(result.steps).toStrictEqual([standDown()]);
      expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toEqual(row);
      await elapse(seed.teamId);
    }
    expect(await threadRootTs(seed.teamId)).toEqual([]);
  });

  // ── AC-PA-06e: a binder that moved workspace ───────────────────────────────
  // PRESERVATION GUARD (mutation: condition 4, workspace equality). The binder is enabled, verified
  // and still selects the channel id — in ANOTHER workspace. It must not hold the frontier it left.

  it("takes W1's frontier from a binder that rebooted into W2, and leaves W2's frontier alone (AC-PA-06e)", async () => {
    const { seed, binder, sibling } = await coalescedWithPartialProgress();
    await rotateSlackSecret(seed, binder, ROTATED);
    const moved = fullPass({
      "auth.test": () => slackJson(authTestBody({ app_id: APP, team_id: OTHER_WORKSPACE })),
    });
    await discover(seed, binder, moved);
    expect(await bindingRow(seed.teamId, binder)).toMatchObject({
      state: "verified",
      workspace_id: OTHER_WORKSPACE,
      selected_channel_ids: [CHANNEL],
    });
    // W1's row still NAMES it, and it is the binder of a separate frontier in W2.
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({ binding_integration_id: binder });
    const elsewhere = await channelRow(seed.teamId, OTHER_WORKSPACE, CHANNEL);
    expect(elsewhere).toMatchObject({ public_state: "public", binding_integration_id: binder });

    await expectTakeoverPreservingProgress(seed, sibling, { frontiers: 2 });

    // W2's frontier is exactly as it was. (`due_at` aside: the takeover's clock fixture is team-wide.)
    const settled = (row: Row | null) => ({ ...row, due_at: null });
    expect(settled(await channelRow(seed.teamId, OTHER_WORKSPACE, CHANNEL))).toEqual(settled(elsewhere));
  });
});
