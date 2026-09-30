import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import {
  invalidateSlackNamespaceGate,
  lockReadySlackNamespaceGate,
  prepareNewSlackChannelNamespace,
} from "@/lib/ingest/slack-namespace-gate";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import {
  authTestBody, channelInfoBody, closeRawSql, fakeSlack, historyBody,
  rawSql, seedSlackIntegration, setSlackChannelIds, slackJson,
} from "./slack-source-helpers";

const CHANNEL = "C0NEWGATE";
const WORKSPACE = "T0SOURCE1";
const TOKEN = "xoxb-synthetic-readiness";

function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

async function verifiedPublic(seed: Seed): Promise<string> {
  const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
  const fake = fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: "A0SOURCE1" })),
    "conversations.info": () => slackJson(channelInfoBody(CHANNEL)),
    "conversations.history": () => slackJson(historyBody({ messages: [] })),
  });
  const result = await discoverSlackSource(
    { db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null }
  );
  expect(result.binding?.state).toBe("verified");
  const c = await rawSql();
  const publicRow = await c.query(
    `select public_state from slack_sync_channels where team_id = $1 and channel_id = $2`,
    [seed.teamId, CHANNEL]
  );
  expect(publicRow.rows).toMatchObject([{ public_state: "public" }]);
  return integrationId;
}

async function proofCount(teamId: string): Promise<number> {
  const c = await rawSql();
  const r = await c.query<{ count: string }>(
    `select count(*)::text as count from slack_namespace_readiness_proofs where team_id = $1`,
    [teamId]
  );
  return Number(r.rows[0].count);
}

async function gate(teamId: string): Promise<Record<string, unknown> | undefined> {
  const c = await rawSql();
  const r = await c.query(
    `select * from slack_channel_migration_gates where team_id = $1 and raw_channel_id = $2`,
    [teamId, CHANNEL]
  );
  return r.rows[0];
}

beforeAll(async () => {
  const c = await rawSql();
  const r = await c.query(
    `select 1 from pg_tables where schemaname = 'public' and tablename = 'slack_namespace_readiness_proofs'`
  );
  if (r.rows.length !== 1) throw new Error("recreate the isolated data-mechanics database to load readiness schema");
});
afterAll(closeRawSql);

describe("inactive new Slack channel namespace producer (real Postgres)", () => {
  it("records one inspectable completed proof and opens only the verified workspace", async () => {
    const seed = await seedTeam();
    const integrationId = await verifiedPublic(seed);
    const scope = { teamId: seed.teamId, rawChannelId: CHANNEL };
    const untrustedExtras = { ...scope, verified: true, workspaceId: "T0FORGED",
      completedRepairId: crypto.randomUUID() };
    const result = await tx((s) => prepareNewSlackChannelNamespace(s, untrustedExtras));
    expect(result.outcome).toBe("ready");
    expect(await proofCount(seed.teamId)).toBe(1);
    const stored = await gate(seed.teamId);
    expect(stored).toMatchObject({ state: "ready", resolved_workspace_ids: [WORKSPACE] });
    const c = await rawSql();
    const proof = await c.query(
      `select * from slack_namespace_readiness_proofs where id = $1`,
      [stored?.completed_repair_id]
    );
    expect(proof.rows[0]).toMatchObject({
      team_id: seed.teamId, raw_channel_id: CHANNEL, workspace_id: WORKSPACE,
      integration_id: integrationId, proof_kind: "new_channel_empty_scan", legacy_rows_found: 0,
    });
    expect(proof.rows[0].public_checked_at).toBeTruthy();
    expect(proof.rows[0].completed_at).toBeTruthy();
    expect(await tx((s) => lockReadySlackNamespaceGate(s, {
      ...scope, workspaceId: WORKSPACE, expectedRevision: 0,
    }))).toMatchObject({ outcome: "locked" });
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, scope))).toEqual({ outcome: "blocked" });
    expect(await proofCount(seed.teamId)).toBe(1);
  });

  it("does not turn an absent source or a caller's plain claims into readiness", async () => {
    const seed = await seedTeam();
    const scope = { teamId: seed.teamId, rawChannelId: CHANNEL,
      verified: true, workspaceId: WORKSPACE, completedRepairId: crypto.randomUUID() };
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, scope))).toEqual({ outcome: "blocked" });
    expect(await gate(seed.teamId)).toMatchObject({ state: "blocked" });
    expect(await proofCount(seed.teamId)).toBe(0);
  });

  it("requires a verified current binding and current selected config revision", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
    const c = await rawSql();
    await c.query(
      `insert into slack_sync_channels
       (team_id, workspace_id, channel_id, binding_integration_id, binding_config_revision,
        public_state, public_checked_at)
       values ($1, $2, $3, $4, repeat('a', 64), 'public', clock_timestamp())`,
      [seed.teamId, WORKSPACE, CHANNEL, integrationId]
    );
    const scope = { teamId: seed.teamId, rawChannelId: CHANNEL };
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, scope))).toEqual({ outcome: "blocked" });
    expect(await proofCount(seed.teamId)).toBe(0);

    const good = await seedTeam();
    await verifiedPublic(good);
    await setSlackChannelIds(good, ["C0DIFFERENT"]);
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, {
      teamId: good.teamId, rawChannelId: CHANNEL,
    }))).toEqual({ outcome: "blocked" });
    expect(await proofCount(good.teamId)).toBe(0);
  });

  it("requires the current public proof even when binding is verified", async () => {
    const seed = await seedTeam();
    await verifiedPublic(seed);
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels set public_state = 'private'
        where team_id = $1 and channel_id = $2`,
      [seed.teamId, CHANNEL]
    );
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, {
      teamId: seed.teamId, rawChannelId: CHANNEL,
    }))).toEqual({ outcome: "blocked" });
    expect(await proofCount(seed.teamId)).toBe(0);
  });

  it("blocks unrelated and unknown legacy Slack rows instead of guessing their provenance", async () => {
    for (const path of [
      "slack/c0newgate/1718900000.000100.md",
      "slack/unrelated/1718900000.000100.md",
      "slack/slug/unknown.md",
    ]) {
      const seed = await seedTeam();
      await verifiedPublic(seed);
      await ingest(seed, {
        path, project: "slack", kind: "transcript", access: "team", body: "historical",
        frontmatter: { source: "slack", channel_id: "C0OTHER" },
      });
      expect(await tx((s) => prepareNewSlackChannelNamespace(s, {
        teamId: seed.teamId, rawChannelId: CHANNEL,
      }))).toEqual({ outcome: "blocked" });
      expect(await proofCount(seed.teamId)).toBe(0);
    }
  });

  it("refuses ambiguous workspace proofs and an already scoped channel", async () => {
    const seed = await seedTeam();
    await verifiedPublic(seed);
    const c = await rawSql();
    await c.query(
      `insert into slack_sync_channels (team_id, workspace_id, channel_id)
       values ($1, 'T0SECOND', $2)`,
      [seed.teamId, CHANNEL]
    );
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, {
      teamId: seed.teamId, rawChannelId: CHANNEL,
    }))).toEqual({ outcome: "blocked" });

    const other = await seedTeam();
    await verifiedPublic(other);
    const legacy = await ingest(other, {
      path: "slack/legacy/1718900000.000100.md", project: "slack",
      kind: "transcript", access: "team", body: "already scoped",
      frontmatter: { source: "slack", workspace_id: WORKSPACE, channel_id: CHANNEL },
    });
    // Ordinary ingest correctly refuses canonical scoped Slack paths. Simulate a historical row
    // that predates that ingress guard so readiness still verifies the blocked condition.
    await c.query(
      `update items set path = $1 where team_id = $2 and id = $3`,
      ["slack/t0source1/c0newgate/1718900000.000100.md", other.teamId, legacy.id]
    );
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, {
      teamId: other.teamId, rawChannelId: CHANNEL,
    }))).toEqual({ outcome: "blocked" });
  });

  it("keeps one team's legacy paths out of another team's proof", async () => {
    const owner = await seedTeam();
    const other = await seedTeam();
    await verifiedPublic(other);
    await ingest(owner, {
      path: "slack/general/1718900000.000100.md", project: "slack", kind: "transcript",
      access: "team", body: "other team", frontmatter: { source: "slack" },
    });
    expect((await tx((s) => prepareNewSlackChannelNamespace(s, {
      teamId: other.teamId, rawChannelId: CHANNEL,
    }))).outcome).toBe("ready");
  });

  it("rolls proof and gate back with the caller's transaction", async () => {
    const seed = await seedTeam();
    await verifiedPublic(seed);
    let outcome: string | undefined;
    await tx(async (s) => {
      outcome = (await prepareNewSlackChannelNamespace(s, {
        teamId: seed.teamId, rawChannelId: CHANNEL,
      })).outcome;
      throw new Error("rollback");
    }).catch(() => {});
    expect(outcome).toBe("ready");
    expect(await gate(seed.teamId)).toBeUndefined();
    expect(await proofCount(seed.teamId)).toBe(0);
  });

  it("serializes invalidation behind a ready write and preserves the completed proof", async () => {
    const seed = await seedTeam();
    await verifiedPublic(seed);
    const scope = { teamId: seed.teamId, rawChannelId: CHANNEL };
    let release!: () => void;
    let started!: (pid: number) => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<number>((resolve) => { started = resolve; });
    const producer = tx(async (s) => {
      expect((await prepareNewSlackChannelNamespace(s, scope)).outcome).toBe("ready");
      const pid = await s.executeSql<{ pid: number }>("select pg_backend_pid() as pid");
      started(pid.rows[0].pid);
      await hold;
    });
    const producerPid = await ready;
    let invalidatorPid!: number;
    const invalidator = tx(async (s) => {
      const pid = await s.executeSql<{ pid: number }>("select pg_backend_pid() as pid");
      invalidatorPid = pid.rows[0].pid;
      return invalidateSlackNamespaceGate(s, scope, "workspace_changed");
    });
    const c = await rawSql();
    let observed = false;
    try {
      for (let i = 0; i < 100; i++) {
        if (invalidatorPid) {
          const r = await c.query<{ pids: number[] }>("select pg_blocking_pids($1) as pids", [invalidatorPid]);
          if (r.rows[0].pids.includes(producerPid)) { observed = true; break; }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
    }
    await producer;
    const invalidated = await invalidator;
    expect(observed).toBe(true);
    expect(invalidated).toMatchObject({ state: "blocked", revision: 1 });
    expect(await proofCount(seed.teamId)).toBe(1);
    expect(await gate(seed.teamId)).toMatchObject({ state: "blocked", completed_repair_id: null });
  }, 20_000);

  it("blocks a second-workspace INSERT after the candidate count until readiness commits", async () => {
    const seed = await seedTeam();
    await verifiedPublic(seed);
    const scope = { teamId: seed.teamId, rawChannelId: CHANNEL };
    let release!: () => void;
    let signalReady!: (pid: number) => void;
    let signalFailure!: (error: unknown) => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<number>((resolve, reject) => {
      signalReady = resolve;
      signalFailure = reject;
    });
    const producer = tx(async (s) => {
      try {
        expect((await prepareNewSlackChannelNamespace(s, scope)).outcome).toBe("ready");
        const result = await s.executeSql<{ pid: number }>("select pg_backend_pid() as pid");
        signalReady(result.rows[0].pid);
        await hold;
      } catch (error) {
        signalFailure(error);
        throw error;
      }
    });
    producer.catch(signalFailure);

    const contender = new Client({ connectionString: process.env.DATABASE_URL });
    let connected = false;
    let insertion: Promise<unknown> | undefined;
    let observedBlock = false;
    try {
      const producerPid = await ready;
      await contender.connect();
      connected = true;
      const pid = (await contender.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      insertion = contender.query(
        `insert into slack_sync_channels (team_id, workspace_id, channel_id)
         values ($1, 'T0SECOND', $2)`,
        [seed.teamId, CHANNEL]
      );
      insertion.catch(() => {});
      const observer = await rawSql();
      for (let i = 0; i < 150; i++) {
        const r = await observer.query<{ pids: number[] }>("select pg_blocking_pids($1) as pids", [pid]);
        if (r.rows[0].pids.includes(producerPid)) { observedBlock = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
      const settled = await Promise.allSettled([producer, insertion ?? Promise.resolve()]);
      if (connected) await contender.end();
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    }
    expect(observedBlock).toBe(true);
    const c = await rawSql();
    const candidates = await c.query(
      `select workspace_id from slack_sync_channels where team_id = $1 and channel_id = $2 order by workspace_id`,
      [seed.teamId, CHANNEL]
    );
    expect(candidates.rows).toEqual([{ workspace_id: "T0SECOND" }, { workspace_id: WORKSPACE }]);
    expect(await gate(seed.teamId)).toMatchObject({ state: "ready", resolved_workspace_ids: [WORKSPACE] });
    expect(await tx((s) => lockReadySlackNamespaceGate(s, {
      ...scope, workspaceId: "T0SECOND", expectedRevision: 0,
    }))).toEqual({ outcome: "refused" });
    await tx((s) => invalidateSlackNamespaceGate(s, scope, "workspace_changed"));
    expect(await tx((s) => prepareNewSlackChannelNamespace(s, scope))).toEqual({ outcome: "blocked" });
    expect(await gate(seed.teamId)).toMatchObject({ state: "blocked", resolved_workspace_ids: [] });
    expect(await proofCount(seed.teamId)).toBe(1);
  }, 20_000);

  it("recounts candidates after waiting on discovery's integration-before-channel lock order", async () => {
    const seed = await seedTeam();
    const integrationId = await verifiedPublic(seed);
    const scope = { teamId: seed.teamId, rawChannelId: CHANNEL };
    const discovery = new Client({ connectionString: process.env.DATABASE_URL });
    await discovery.connect();
    let producer: Promise<Awaited<ReturnType<typeof prepareNewSlackChannelNamespace>>> | undefined;
    let committed = false;
    try {
      await discovery.query("begin");
      const blockerPid = (await discovery.query<{ pid: number }>(
        `select pg_backend_pid() as pid from integrations where team_id = $1 and id = $2 for update`,
        [seed.teamId, integrationId]
      )).rows[0].pid;
      let signal!: (pid: number) => void;
      let signalFailure!: (error: unknown) => void;
      const started = new Promise<number>((resolve, reject) => {
        signal = resolve;
        signalFailure = reject;
      });
      producer = tx(async (s) => {
        try {
          const pid = await s.executeSql<{ pid: number }>("select pg_backend_pid() as pid");
          signal(pid.rows[0].pid);
          return await prepareNewSlackChannelNamespace(s, scope);
        } catch (error) {
          signalFailure(error);
          throw error;
        }
      });
      producer.catch(signalFailure);
      const producerPid = await started;
      const observer = await rawSql();
      let observedIntegrationWait = false;
      for (let i = 0; i < 150; i++) {
        const r = await observer.query<{ pids: number[] }>(
          "select pg_blocking_pids($1) as pids", [producerPid]
        );
        if (r.rows[0].pids.includes(blockerPid)) { observedIntegrationWait = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedIntegrationWait).toBe(true);
      // The same transaction that owns the integration lock can still INSERT a second workspace.
      // If readiness had taken channel TABLE SHARE before integration, this would deadlock.
      await discovery.query(
        `insert into slack_sync_channels (team_id, workspace_id, channel_id)
         values ($1, 'T0SECOND', $2)`,
        [seed.teamId, CHANNEL]
      );
      await discovery.query("commit");
      committed = true;
      expect(await producer).toEqual({ outcome: "blocked" });
      expect(await gate(seed.teamId)).toMatchObject({ state: "blocked" });
      expect(await proofCount(seed.teamId)).toBe(0);
    } finally {
      if (!committed) await discovery.query("rollback");
      await discovery.end();
      if (producer) await producer.catch(() => {});
    }
  }, 20_000);

  it("replays schema and additive migration over completed proof without losing identity", async () => {
    const seed = await seedTeam();
    await verifiedPublic(seed);
    await tx((s) => prepareNewSlackChannelNamespace(s, { teamId: seed.teamId, rawChannelId: CHANNEL }));
    const before = await gate(seed.teamId);
    const schema = readFileSync(join(import.meta.dirname, "..", "..", "postgres", "schema.sql"), "utf8");
    const sql = readFileSync(join(import.meta.dirname, "..", "..", "postgres", "migrations",
      "20260919175000_slack_namespace_readiness_proofs.sql"), "utf8");
    const c = await rawSql();
    await c.query(schema);
    await c.query(sql);
    await c.query(schema);
    await c.query(sql);
    expect(await gate(seed.teamId)).toEqual(before);
    expect(await proofCount(seed.teamId)).toBe(1);
  });
});
