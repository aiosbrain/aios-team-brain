import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import type { SlackMessage } from "@/lib/ingest/sources/slack";
import { projectSlackMessageEvidence } from "@/lib/ingest/sources/slack-message-evidence";
import {
  bumpSlackIdentityGeneration,
  readSlackTeamGenerations,
  reconcileCompleteSlackThreadEvidence,
  type CompleteSlackThreadEvidence,
} from "@/lib/ingest/slack-message-ledger";
import { db, ingest, seedTeam, type Seed } from "./helpers";

const WORKSPACE = "T0LEDGER";
const CHANNEL = "C0LEDGER";
const ROOT = "1718900000.000100";
const REPLY = "1718900000.000101";
const NOW = new Date("2024-06-21T00:00:00Z");
const USERS = { U1: { isBot: false, isAppUser: false } };

let raw: Client | null = null;
async function sql(): Promise<Client> {
  if (!raw) {
    raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
  }
  return raw;
}
afterAll(async () => { if (raw) await raw.end(); });

const tx = <T>(fn: (session: TransactionSession) => Promise<T>) =>
  transactionCapability(db()).transaction(fn);

async function item(seed: Seed, name: string): Promise<string> {
  return (await ingest(seed, { path: `slack/${WORKSPACE}/${CHANNEL}/${name}.md`, body: name, access: "team" })).id;
}

function snapshot(
  teamId: string,
  itemId: string,
  messages: readonly SlackMessage[] = [
    { ts: ROOT, user: "U1", text: "root" },
    { ts: REPLY, thread_ts: ROOT, user: "U1", text: "reply" },
  ],
  over: Partial<CompleteSlackThreadEvidence> = {}
): CompleteSlackThreadEvidence {
  const workspaceId = over.workspaceId ?? WORKSPACE;
  const channelId = over.channelId ?? CHANNEL;
  return {
    teamId, itemId, workspaceId, channelId, rootTs: ROOT, complete: true,
    projection: projectSlackMessageEvidence(messages, {
      scope: { workspaceId, channelId }, now: NOW, users: USERS,
    }),
    ...over,
  };
}

async function rows(teamId: string) {
  const c = await sql();
  return (await c.query<{
    workspace_id: string; message_ts: string; occurred_at: string | null;
    deleted: boolean; last_seen_generation: string; source_hash: string;
  }>(`select workspace_id, message_ts,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
            (deleted_at is not null) as deleted, last_seen_generation::text, source_hash
       from slack_messages where team_id=$1 order by workspace_id, message_ts`, [teamId])).rows;
}

describe("inactive Slack message ledger reconciliation", () => {
  it("preserves exact Slack identities and microsecond instants; identical revisits do not churn generation", async () => {
    const seed = await seedTeam(); const itemId = await item(seed, "exact");
    expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId)))
      .toEqual({ dataGeneration: "0", identityGeneration: "0" });
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, itemId))))
      .toEqual({ changed: true, dataGeneration: "1" });
    expect(await rows(seed.teamId)).toMatchObject([
      { message_ts: ROOT, occurred_at: "2024-06-20T16:13:20.000100Z", last_seen_generation: "1" },
      { message_ts: REPLY, occurred_at: "2024-06-20T16:13:20.000101Z", last_seen_generation: "1" },
    ]);
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, itemId))))
      .toEqual({ changed: false, dataGeneration: "1" });
    expect((await rows(seed.teamId)).map((r) => r.last_seen_generation)).toEqual(["1", "1"]);
  });

  it("bumps once for changed evidence, definite deletion, and restoration; preserves deletion audit", async () => {
    const seed = await seedTeam(); const itemId = await item(seed, "change");
    const full = snapshot(seed.teamId, itemId);
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, full));
    const changed = snapshot(seed.teamId, itemId, [
      { ts: ROOT, user: "U1", text: "root" },
      { ts: REPLY, thread_ts: ROOT, user: "U1", text: "edited reply" },
    ]);
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, changed)))
      .toEqual({ changed: true, dataGeneration: "2" });
    const rootOnly = snapshot(seed.teamId, itemId, [{ ts: ROOT, user: "U1", text: "root" }]);
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, rootOnly)))
      .toEqual({ changed: true, dataGeneration: "3" });
    expect(await rows(seed.teamId)).toMatchObject([
      { message_ts: ROOT, deleted: false, last_seen_generation: "3" },
      { message_ts: REPLY, deleted: true, last_seen_generation: "2" },
    ]);
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, rootOnly)))
      .toEqual({ changed: false, dataGeneration: "3" });
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, changed)))
      .toEqual({ changed: true, dataGeneration: "4" });
    expect(await rows(seed.teamId)).toMatchObject([
      { message_ts: ROOT, deleted: false, last_seen_generation: "4" },
      { message_ts: REPLY, deleted: false, last_seen_generation: "4" },
    ]);
  });

  it("bumps when a directory verdict changes even though raw source hashes do not", async () => {
    const seed = await seedTeam(); const itemId = await item(seed, "classification");
    const classified = snapshot(seed.teamId, itemId);
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, classified));
    const before = await rows(seed.teamId);
    const unclassified: CompleteSlackThreadEvidence = {
      ...classified,
      projection: projectSlackMessageEvidence([
        { ts: ROOT, user: "U1", text: "root" },
        { ts: REPLY, thread_ts: ROOT, user: "U1", text: "reply" },
      ], { scope: { workspaceId: WORKSPACE, channelId: CHANNEL }, now: NOW }),
    };
    expect(unclassified.projection.messages.map((row) => row.sourceHash))
      .toEqual(before.map((row) => row.source_hash));
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, unclassified)))
      .toEqual({ changed: true, dataGeneration: "2" });
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, unclassified)))
      .toEqual({ changed: false, dataGeneration: "2" });
  });

  it("refuses partial and inconsistent projections before making deletion marks", async () => {
    const seed = await seedTeam(); const itemId = await item(seed, "partial");
    const full = snapshot(seed.teamId, itemId);
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, full));
    const rootOnly = snapshot(seed.teamId, itemId, [{ ts: ROOT, user: "U1", text: "root" }]);
    for (const invalid of [
      { ...rootOnly, complete: false },
      { ...rootOnly, projection: { ...rootOnly.projection, unidentifiableCount: 1 } },
      { ...rootOnly, projection: { ...rootOnly.projection, messages: [] } },
      { ...rootOnly, projection: { ...rootOnly.projection, messages: [{ ...rootOnly.projection.messages[0], rootTs: REPLY }] } },
    ]) {
      await expect(tx((s) => reconcileCompleteSlackThreadEvidence(s, invalid as CompleteSlackThreadEvidence)))
        .rejects.toThrow();
    }
    expect((await rows(seed.teamId)).map((r) => r.deleted)).toEqual([false, false]);
    expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId)))
      .toEqual({ dataGeneration: "1", identityGeneration: "0" });
  });

  it("rolls back messages and generation with the caller's transaction", async () => {
    const seed = await seedTeam(); const itemId = await item(seed, "rollback");
    await expect(tx(async (s) => {
      await reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, itemId));
      throw new Error("abort caller");
    })).rejects.toThrow("abort caller");
    expect(await rows(seed.teamId)).toEqual([]);
    expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId)))
      .toEqual({ dataGeneration: "0", identityGeneration: "0" });
  });

  it("isolates tenants and refuses an item from another team or a competing thread binding", async () => {
    const a = await seedTeam(); const b = await seedTeam();
    const aItem = await item(a, "a"); const bItem = await item(b, "b");
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, snapshot(a.teamId, aItem)));
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, snapshot(b.teamId, bItem)));
    expect((await rows(a.teamId)).length).toBe(2);
    expect((await rows(b.teamId)).length).toBe(2);
    await expect(tx((s) => reconcileCompleteSlackThreadEvidence(s, snapshot(a.teamId, bItem))))
      .rejects.toThrow("requested team");
    await expect(tx((s) => reconcileCompleteSlackThreadEvidence(s,
      snapshot(a.teamId, aItem, [{ ts: ROOT, user: "U1", text: "root" }], { workspaceId: "T0OTHER" })
    ))).rejects.toThrow("already bound");
    expect(await tx((s) => readSlackTeamGenerations(s, a.teamId)))
      .toEqual({ dataGeneration: "1", identityGeneration: "0" });
  });

  it("advances last-seen to the current team generation on a later identical revisit", async () => {
    const seed = await seedTeam(); const firstItem = await item(seed, "first");
    const secondItem = await item(seed, "second");
    const first = snapshot(seed.teamId, firstItem);
    const second = snapshot(seed.teamId, secondItem, undefined, { workspaceId: "T0SECOND" });
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, first));
    await tx((s) => reconcileCompleteSlackThreadEvidence(s, second));
    expect(await tx((s) => reconcileCompleteSlackThreadEvidence(s, first)))
      .toEqual({ changed: false, dataGeneration: "2" });
    expect((await rows(seed.teamId)).filter((row) => row.workspace_id === WORKSPACE)
      .map((row) => row.last_seen_generation)).toEqual(["2", "2"]);
  });

  it("serializes concurrent identical publishers so only one bumps the team", async () => {
    const seed = await seedTeam(); const itemId = await item(seed, "race");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let firstWritten!: () => void;
    const written = new Promise<void>((resolve) => { firstWritten = resolve; });
    const first = tx(async (s) => {
      const result = await reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, itemId));
      firstWritten();
      await hold;
      return result;
    });
    try {
      await written;
      let secondPid!: (pid: number) => void;
      const pidReady = new Promise<number>((resolve) => { secondPid = resolve; });
      const second = tx(async (s) => {
        const pid = await s.executeSql<{ pid: number }>("select pg_backend_pid() as pid");
        secondPid(pid.rows[0].pid);
        return reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, itemId));
      });
      const pid = await pidReady;
      const c = await sql();
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await c.query<{ blockers: number[] }>(
          "select pg_blocking_pids($1::integer) as blockers", [pid]
        );
        if (result.rows[0].blockers.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      release();
      const results = await Promise.all([first, second]);
      expect(results).toEqual([
        { changed: true, dataGeneration: "1" },
        { changed: false, dataGeneration: "1" },
      ]);
      expect(await rows(seed.teamId)).toHaveLength(2);
    } finally { release(); }
  });

  it("serializes competing items for one thread and refuses the losing binding", async () => {
    const seed = await seedTeam(); const firstItem = await item(seed, "winner");
    const secondItem = await item(seed, "loser");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let firstWritten!: () => void;
    const written = new Promise<void>((resolve) => { firstWritten = resolve; });
    const first = tx(async (s) => {
      const result = await reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, firstItem));
      firstWritten();
      await hold;
      return result;
    });
    try {
      await written;
      let secondPid!: (pid: number) => void;
      const pidReady = new Promise<number>((resolve) => { secondPid = resolve; });
      const second = tx(async (s) => {
        const pid = await s.executeSql<{ pid: number }>("select pg_backend_pid() as pid");
        secondPid(pid.rows[0].pid);
        return reconcileCompleteSlackThreadEvidence(s, snapshot(seed.teamId, secondItem));
      }).then((value) => ({ value, error: null as Error | null }),
        (error: Error) => ({ value: null, error }));
      const pid = await pidReady;
      const c = await sql();
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await c.query<{ blockers: number[] }>(
          "select pg_blocking_pids($1::integer) as blockers", [pid]
        );
        if (result.rows[0].blockers.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      release();
      expect(await first).toEqual({ changed: true, dataGeneration: "1" });
      const loser = await second;
      expect(loser.value).toBeNull();
      expect(loser.error?.message).toContain("thread is already bound");
      expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId)))
        .toEqual({ dataGeneration: "1", identityGeneration: "0" });
    } finally { release(); }
  });

  it("keeps identity generation separate, and propagates an indexed read failure", async () => {
    const seed = await seedTeam();
    expect(await tx((s) => bumpSlackIdentityGeneration(s, seed.teamId))).toBe("1");
    expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId)))
      .toEqual({ dataGeneration: "0", identityGeneration: "1" });
    await expect(tx(async (s) => {
      await s.executeSql("set local search_path to pg_catalog");
      await readSlackTeamGenerations(s, seed.teamId);
    })).rejects.toMatchObject({ code: "42P01" });
  });
});
