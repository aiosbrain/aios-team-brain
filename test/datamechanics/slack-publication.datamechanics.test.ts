import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { ingestItem } from "@/lib/ingest";
import { invalidateSlackNamespaceGate, prepareNewSlackChannelNamespace } from "@/lib/ingest/slack-namespace-gate";
import { readSlackTeamGenerations } from "@/lib/ingest/slack-message-ledger";
import { slackBindingRef, lockSlackSelection } from "@/lib/ingest/slack-source-binding";
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import { slackPublicationOption } from "@/lib/ingest/slack-publication";
import { claimSlackThread, checkpointSlackThread, enqueueSlackThread, writeSlackThreadSnapshot, type SlackThreadClaim } from "@/lib/ingest/slack-thread-state";
import { normalizeThread } from "@/lib/ingest/sources/slack-normalize";
import { parseSlackTimestamp } from "@/lib/ingest/sources/slack-message-evidence";
import { scopedSlackItemPath } from "@/lib/ingest/sources/slack-namespace";
import type { SlackMessage } from "@/lib/ingest/sources/slack";
import { db, seedTeam, transactionSessionDecoratedDb } from "./helpers";
import { authTestBody, channelInfoBody, disableSlackIntegration, fakeSlack, historyBody, seedSlackIntegration, setSlackChannelIds, slackJson } from "./slack-source-helpers";

const WORKSPACE = "T0SOURCE1";
const CHANNEL = "C0PUB1170";
const ROOT = "1718900000.000100";
const REPLY = "1718900000.000101";
const USERS = { U1: { displayName: "Person One", isBot: false, isAppUser: false } };
const ROOT_MESSAGE: SlackMessage = { ts: ROOT, user: "U1", text: "root" };
const REPLY_MESSAGE: SlackMessage = { ts: REPLY, thread_ts: ROOT, user: "U1", text: "reply" };

let raw: Client;
beforeAll(async () => {
  raw = new Client({ connectionString: process.env.DATABASE_URL });
  await raw.connect();
});
afterAll(async () => { await raw?.end(); });
const tx = <T>(fn: (s: TransactionSession) => Promise<T>) => transactionCapability(db()).transaction(fn);

async function fixture(messages: SlackMessage[] = [ROOT_MESSAGE, REPLY_MESSAGE], complete = true) {
  const seed = await seedTeam();
  const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: "xoxb-synthetic-publication" });
  const fake = fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: "A0SOURCE1" })),
    "conversations.info": () => slackJson(channelInfoBody(CHANNEL)),
    "conversations.history": () => slackJson(historyBody({ messages: [] })),
  });
  const discovered = await discoverSlackSource({ db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null });
  expect(discovered.binding?.state).toBe("verified");
  // Isolated fixture: no legacy worker exists, satisfying the readiness producer's activation precondition.
  const gate = await tx((s) => prepareNewSlackChannelNamespace(s, { teamId: seed.teamId, rawChannelId: CHANNEL }));
  expect(gate.outcome).toBe("ready");
  if (gate.outcome !== "ready") throw new Error("fixture namespace not ready");
  const selection = await tx((s) => lockSlackSelection(s, { teamId: seed.teamId, integrationId, envToken: () => null }));
  if (selection.outcome !== "current") throw new Error("fixture selection not current");
  const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: ROOT };
  await tx((s) => enqueueSlackThread(s, scope));
  const acquired = await tx((s) => claimSlackThread(s, scope, { leaseMs: 900_000 }));
  if (!acquired) throw new Error("fixture claim refused");
  const written = await tx(async (s) => {
    const result = await writeSlackThreadSnapshot(s, acquired, {
      messages, complete, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (result !== "written") throw new Error("fixture snapshot refused");
    return checkpointSlackThread(s, acquired, { pageCursor: null, snapshotGeneration: 1 });
  });
  expect(written.outcome).toBe("checkpointed");
  const claim: SlackThreadClaim = { ...acquired, snapshotGeneration: 1 };
  const option = slackPublicationOption({ claim, binding: slackBindingRef(selection.selection),
    namespaceRevision: gate.gate.revision, channelName: "general", users: USERS });
  const normalized = normalizeThread({ root: messages[0], replies: messages.slice(1) }, {
    channelId: CHANNEL, channelName: "general", users: { U1: "Person One" }, project: "slack",
  });
  const payload = { ...normalized, path: scopedSlackItemPath(WORKSPACE, CHANNEL, ROOT),
    frontmatter: { ...normalized.frontmatter, workspace_id: WORKSPACE, source_ts: parseSlackTimestamp(ROOT)!.iso } };
  const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
  return { seed, integrationId, claim, option, payload, auth };
}

async function rows(teamId: string) {
  const result = await raw.query(`select message_ts, eligible, exclusion_reason, deleted_at,
      last_seen_generation::text as last_seen_generation from slack_messages
      where team_id=$1 order by message_ts`, [teamId]);
  return result.rows;
}
async function counts(teamId: string) {
  const result = await raw.query(`select
      (select count(*)::int from items where team_id=$1 and path=$2) as items,
      (select count(*)::int from item_versions v join items i on i.id=v.item_id where i.team_id=$1 and i.path=$2) as versions,
      (select count(*)::int from slack_sync_threads where team_id=$1) as jobs,
      (select count(*)::int from slack_thread_snapshots where team_id=$1) as snapshots`,
    [teamId, scopedSlackItemPath(WORKSPACE, CHANNEL, ROOT)]);
  return result.rows[0];
}

async function restage(f: Awaited<ReturnType<typeof fixture>>, messages: SlackMessage[] = [ROOT_MESSAGE, REPLY_MESSAGE]) {
  await tx((s) => enqueueSlackThread(s, f.claim.scope));
  const next = await tx((s) => claimSlackThread(s, f.claim.scope, { leaseMs: 900_000 }));
  if (!next) throw new Error("next claim refused");
  await tx(async (s) => {
    expect(await writeSlackThreadSnapshot(s, next, { messages, complete: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).toBe("written");
    expect((await checkpointSlackThread(s, next, { pageCursor: null, snapshotGeneration: 1 })).outcome)
      .toBe("checkpointed");
  });
  return { ...next, snapshotGeneration: 1 };
}

function payloadFor(messages: SlackMessage[]) {
  const normalized = normalizeThread({ root: messages[0], replies: messages.slice(1) }, {
    channelId: CHANNEL, channelName: "general", users: { U1: "Person One" }, project: "slack",
  });
  return { ...normalized, path: scopedSlackItemPath(WORKSPACE, CHANNEL, ROOT),
    frontmatter: { ...normalized.frontmatter, workspace_id: WORKSPACE, source_ts: parseSlackTimestamp(ROOT)!.iso } };
}

describe("inactive Slack publication in the existing ingest transaction", () => {
  it("reserves canonical scoped paths across projects before project or pointer writes", async () => {
    const f = await fixture();
    const projects = () => raw.query(`select id,slug,graph_group_id,last_synced_at from projects
      where team_id=$1 and slug in ('foreign', 'slack') order by slug`, [f.seed.teamId]);
    const before = (await projects()).rows;
    for (const candidate of [{ ...f.payload, project: "foreign" }, f.payload]) {
      await expect(ingestItem(db(), f.auth, candidate, "team"))
        .rejects.toThrow(/canonical scoped Slack paths require internal Slack publication/);
      expect((await projects()).rows).toEqual(before);
      expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, versions: 0, jobs: 1, snapshots: 1 });
    }
  });

  it("keeps legacy Slack and unrelated project paths writable through ordinary ingest", async () => {
    const f = await fixture();
    const legacy = { ...f.payload, path: `slack/${CHANNEL.toLowerCase()}/${ROOT}.md` };
    const unrelated = { ...f.payload, project: "foreign", path: `notes/thread-${ROOT}.md` };
    expect(await ingestItem(db(), f.auth, legacy, "team"))
      .toMatchObject({ status: "created" });
    expect(await ingestItem(db(), f.auth, unrelated, "team"))
      .toMatchObject({ status: "created" });
    const stored = await raw.query(`select p.slug,i.path,p.graph_group_id from items i
      join projects p on p.id=i.project_id where i.team_id=$1 order by p.slug`, [f.seed.teamId]);
    expect(stored.rows).toMatchObject([
      { slug: "foreign", path: unrelated.path, graph_group_id: expect.any(String) },
      { slug: "slack", path: legacy.path, graph_group_id: expect.any(String) },
    ]);
  });

  it("publishes a changed item with exact ledger rows, generation and queue acknowledgement", async () => {
    const f = await fixture();
    expect(await ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option))
      .toMatchObject({ status: "created" });
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 1, versions: 1, jobs: 0, snapshots: 0 });
    expect(await rows(f.seed.teamId)).toMatchObject([
      { message_ts: ROOT, eligible: true, exclusion_reason: null, last_seen_generation: "1" },
      { message_ts: REPLY, eligible: true, exclusion_reason: null, last_seen_generation: "1" },
    ]);
    expect((await tx((s) => readSlackTeamGenerations(s, f.seed.teamId))).dataGeneration).toBe("1");
  });

  it("publishes an unchanged body and a changed eligibility verdict without adding a version", async () => {
    const f = await fixture();
    await ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option);
    const reclassified = slackPublicationOption({ ...f.option, claim: await restage(f),
      users: { U1: { ...USERS.U1, isBot: true } } });
    expect(await ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", reclassified))
      .toMatchObject({ status: "unchanged" });
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 1, versions: 1, jobs: 0, snapshots: 0 });
    expect(await rows(f.seed.teamId)).toMatchObject([
      { message_ts: ROOT, eligible: false, exclusion_reason: "bot_identity", last_seen_generation: "2" },
      { message_ts: REPLY, eligible: false, exclusion_reason: "bot_identity", last_seen_generation: "2" },
    ]);
    expect((await tx((s) => readSlackTeamGenerations(s, f.seed.teamId))).dataGeneration).toBe("2");
    const identical = slackPublicationOption({ ...reclassified, claim: await restage(f) });
    expect(await ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", identical))
      .toMatchObject({ status: "unchanged" });
    expect((await tx((s) => readSlackTeamGenerations(s, f.seed.teamId))).dataGeneration).toBe("2");
    expect(await counts(f.seed.teamId)).toMatchObject({ versions: 1, jobs: 0, snapshots: 0 });
  });

  it("updates an existing item from a new complete snapshot and acknowledges only after ledger reconciliation", async () => {
    const f = await fixture();
    await ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option);
    const edited = [{ ...ROOT_MESSAGE, text: "edited root" }, REPLY_MESSAGE];
    const option = slackPublicationOption({ ...f.option, claim: await restage(f, edited) });
    expect(await ingestItem(db(), f.auth, payloadFor(edited), "team", { authorMemberId: null }, "team", option))
      .toMatchObject({ status: "updated" });
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 1, versions: 2, jobs: 0, snapshots: 0 });
    expect((await tx((s) => readSlackTeamGenerations(s, f.seed.teamId))).dataGeneration).toBe("2");
    expect(await rows(f.seed.teamId)).toMatchObject([
      { message_ts: ROOT, last_seen_generation: "2" },
      { message_ts: REPLY, last_seen_generation: "2" },
    ]);
  });

  it.each([
    ["expired lease", `update slack_sync_threads set lease_expires_at=clock_timestamp()-interval '1 second' where team_id=$1`],
    ["expired snapshot", `update slack_thread_snapshots set expires_at=clock_timestamp()-interval '1 second' where team_id=$1`],
  ])("refuses %s before item or acknowledgement", async (_name, sql) => {
    const f = await fixture();
    await raw.query(sql, [f.seed.teamId]);
    await expect(ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option)).rejects.toThrow();
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, versions: 0, jobs: 1, snapshots: 1 });
    expect(await rows(f.seed.teamId)).toEqual([]);
  });

  it("refuses an incomplete staged generation", async () => {
    const f = await fixture([ROOT_MESSAGE, REPLY_MESSAGE], false);
    await expect(ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option)).rejects.toThrow();
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, jobs: 1, snapshots: 1 });
  });

  it("refuses a claim for another staged generation", async () => {
    const f = await fixture();
    const wrong = slackPublicationOption({ ...f.option,
      claim: { ...f.claim, snapshotGeneration: f.claim.snapshotGeneration + 1 } });
    await expect(ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", wrong)).rejects.toThrow();
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, jobs: 1, snapshots: 1 });
  });

  it("refuses a reclaimed owner even when the new owner has the same staged generation", async () => {
    const f = await fixture();
    await raw.query(`update slack_sync_threads set lease_expires_at=clock_timestamp()-interval '1 second'
      where team_id=$1`, [f.seed.teamId]);
    const newer = await tx((s) => claimSlackThread(s, f.claim.scope, { leaseMs: 900_000 }));
    expect(newer?.leaseGeneration).toBe(f.claim.leaseGeneration + 1);
    await expect(ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option)).rejects.toThrow();
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, jobs: 1, snapshots: 1 });
  });

  it.each(["public_revoked", "integration_disabled", "channel_deselected", "binding_revoked", "binding_revision", "wrong_gate_revision", "namespace_invalidated"] as const)(
    "refuses %s without acknowledging", async (caseName) => {
      const f = await fixture();
      let option = f.option;
      if (caseName === "public_revoked") {
        await raw.query(`update slack_sync_channels set public_state='private' where team_id=$1`, [f.seed.teamId]);
      } else if (caseName === "integration_disabled") {
        await disableSlackIntegration(f.seed, f.integrationId);
      } else if (caseName === "channel_deselected") {
        await setSlackChannelIds(f.seed, []);
      } else if (caseName === "binding_revoked") {
        await raw.query(`update slack_integration_bindings set state='blocked',error_code='test_block'
          where team_id=$1`, [f.seed.teamId]);
      } else if (caseName === "binding_revision") {
        await raw.query(`update slack_integration_bindings set config_revision=repeat('a',64) where team_id=$1`, [f.seed.teamId]);
      } else if (caseName === "wrong_gate_revision") {
        option = slackPublicationOption({ ...f.option, namespaceRevision: f.option.namespaceRevision + 1 });
      } else {
        await tx((s) => invalidateSlackNamespaceGate(s, { teamId: f.seed.teamId, rawChannelId: CHANNEL }, "test_block"));
      }
      await expect(ingestItem(db(), f.auth, f.payload, "team", { authorMemberId: null }, "team", option)).rejects.toThrow();
      expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, jobs: 1, snapshots: 1 });
    }
  );

  it("rolls back the item/version/ledger and leaves the job pending on a ledger sink error", async () => {
    const f = await fixture();
    const faulty = transactionSessionDecoratedDb(db(), (s) => ({ ...s,
      executeSql: async (sql, params) => {
        if (/insert into slack_messages/i.test(sql)) throw new Error("injected ledger failure");
        return s.executeSql(sql, params);
      },
    }));
    await expect(ingestItem(faulty, f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option))
      .rejects.toThrow("injected ledger failure");
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, versions: 0, jobs: 1, snapshots: 1 });
    expect(await rows(f.seed.teamId)).toEqual([]);
  });

  it("rolls back item and ledger when final queue acknowledgement fails", async () => {
    const f = await fixture();
    const faulty = transactionSessionDecoratedDb(db(), (s) => ({ ...s,
      executeSql: async (sql, params) => {
        if (/delete from slack_sync_threads t/i.test(sql)) throw new Error("injected acknowledgement failure");
        return s.executeSql(sql, params);
      },
    }));
    await expect(ingestItem(faulty, f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option))
      .rejects.toThrow("injected acknowledgement failure");
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, versions: 0, jobs: 1, snapshots: 1 });
    expect(await rows(f.seed.teamId)).toEqual([]);
    expect((await tx((s) => readSlackTeamGenerations(s, f.seed.teamId))).dataGeneration).toBe("0");
  });

  it("rolls back item and ledger if the lease expires after the initial lock but before acknowledgement", async () => {
    const f = await fixture();
    const expiring = transactionSessionDecoratedDb(db(), (s) => ({ ...s,
      executeSql: async (sql, params) => {
        if (/delete from slack_sync_threads t/i.test(sql)) {
          await s.executeSql(`update slack_sync_threads set lease_expires_at=clock_timestamp()-interval '1 second'
            where team_id=$1 and workspace_id=$2 and channel_id=$3 and root_ts=$4`,
          [f.seed.teamId, WORKSPACE, CHANNEL, ROOT]);
        }
        return s.executeSql(sql, params);
      },
    }));
    await expect(ingestItem(expiring, f.auth, f.payload, "team", { authorMemberId: null }, "team", f.option))
      .rejects.toThrow(/refused/);
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, versions: 0, jobs: 1, snapshots: 1 });
    expect(await rows(f.seed.teamId)).toEqual([]);
  });

  it("rejects spoofed path and frontmatter before any item write", async () => {
    const f = await fixture();
    for (const payload of [
      { ...f.payload, path: `slack/${WORKSPACE}/C0OTHER/${ROOT}.md` },
      { ...f.payload, frontmatter: { ...f.payload.frontmatter, workspace_id: "T0OTHER" } },
      { ...f.payload, body: "forged body" },
    ]) {
      await expect(ingestItem(db(), f.auth, payload, "team", { authorMemberId: null }, "team", f.option)).rejects.toThrow();
    }
    expect(await counts(f.seed.teamId)).toMatchObject({ items: 0, jobs: 1, snapshots: 1 });
  });
});
