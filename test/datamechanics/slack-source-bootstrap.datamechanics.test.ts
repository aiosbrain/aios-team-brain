import { afterAll, describe, expect, it } from "vitest";

import { discoverSlackSource, type SlackSourceDiscoveryResult } from "@/lib/ingest/slack-source-discovery";
import { db, seedTeam, type Seed } from "./helpers";
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
  rawSql,
  rootMessage,
  rotateSlackSecret,
  seedSlackIntegration,
  slackJson,
  slackRateLimited,
  threadRootTs,
  threadRows,
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
const TOKEN = "xoxb-synthetic-not-a-real-token";
const ROTATED = "xoxb-synthetic-rotated-token";

afterAll(closeRawSql);

function discover(
  seed: Seed,
  integrationId: string,
  fake: SlackFake,
  over: { envToken?: () => string | null; maxRequests?: number } = {}
): Promise<SlackSourceDiscoveryResult> {
  return discoverSlackSource(
    { db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: over.envToken ?? (() => null), maxRequests: over.maxRequests }
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
        "binding_config_revision",
      ])
    );
  });
});

// ── bootstrap ────────────────────────────────────────────────────────────────

describe("app-identity bootstrap", () => {
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

    // The seed page certifies exactly the interval it covered: [oldest returned, frozen anchor].
    expect(channel?.completed_lower_ts).toBe("1718900000.000100");
    expect(channel?.completed_upper_ts).toBe(channel?.newest_anchor_ts ?? null);
    // …and the lease is not held between wakes.
    expect(channel?.lease_owner).toBeNull();
    expect(channel?.claimed_lane).toBeNull();
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

    await discover(seed, integrationId, first);
    expect(first.countOf("auth.test")).toBe(1);
    expect(first.countOf("bots.info")).toBe(1);
    // ⚠️ NOT ONE CHANNEL REQUEST. App identity is unresolved, so conversations.info/history are not
    // reachable — the metadata-only bootstrap exception grants nothing else.
    expect(first.countOf("conversations.info")).toBe(0);
    expect(first.countOf("conversations.history")).toBe(0);
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
    await discover(seed, integrationId, after);

    // The identity is proved again under the NEW token before anything else is read…
    expect(after.countOf("auth.test")).toBe(1);
    expect(after.calls[0]?.authorization).toBe(`Bearer ${ROTATED}`);
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

    await elapse(seed.teamId);
    const rotated = fullPass();
    await discover(seed, integrationId, rotated, { envToken: () => ROTATED });

    // updated_at cannot see this change; the fingerprint is the only thing that can.
    expect(rotated.countOf("auth.test")).toBe(1);
    const after = await bindingRow(seed.teamId, integrationId);
    expect(after?.token_fingerprint).not.toBe(bound?.token_fingerprint);
    expect(after?.updated_at).not.toEqual(bound?.updated_at);
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
  it("coalesces two integrations that select one channel onto ONE frontier", async () => {
    const seed = await seedTeam();
    const first = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-a" });
    const second = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN, name: "slack-b" });

    await discover(seed, first, fullPass());
    await elapse(seed.teamId);
    await discover(seed, second, fullPass());

    // ONE provider timeline, one row — the key deliberately excludes the integration.
    const rows = await channelRows(seed.teamId);
    expect(rows).toHaveLength(1);
    // Both bindings record the selection, which is how "who selects this channel" is answerable.
    expect((await bindingRow(seed.teamId, first))?.selected_channel_ids).toEqual([CHANNEL]);
    expect((await bindingRow(seed.teamId, second))?.selected_channel_ids).toEqual([CHANNEL]);
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
