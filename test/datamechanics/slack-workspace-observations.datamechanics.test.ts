import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import {
  bindSlackSelection,
  lockSlackSelection,
  recordSlackWorkspaceIdentity,
  slackBindingRef,
  type SlackBindingRef,
} from "@/lib/ingest/slack-source-binding";
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import { db, seedTeam } from "./helpers";
import {
  authTestBody,
  bindingRow,
  closeRawSql,
  elapse,
  fakeSlack,
  rawSql,
  requireSlackSourceTables,
  rotateSlackSecret,
  seedSlackIntegration,
  slackJson,
  workspaceObservationRows,
} from "./slack-source-helpers";

const FIRST = "T0OBSERVED1";
const SECOND = "T0OBSERVED2";
const TOKEN = "xoxb-synthetic-observation";
const ROTATED = "xoxb-synthetic-observation-rotated";
const identity = (workspaceId: string) => ({
  workspaceId,
  botId: "B0OBSERVED1",
  appId: "A0OBSERVED1",
  workspaceUrl: null,
});

const tx = <T>(fn: (session: TransactionSession) => Promise<T>) =>
  transactionCapability(db()).transaction(fn);

async function currentRef(teamId: string, integrationId: string): Promise<SlackBindingRef> {
  return tx(async (session) => {
    const read = await lockSlackSelection(session, { teamId, integrationId, envToken: () => null });
    expect(read.outcome).toBe("current");
    if (read.outcome !== "current") throw new Error("fixture has no current Slack selection");
    await bindSlackSelection(session, read.selection);
    return slackBindingRef(read.selection);
  });
}

async function accept(ref: SlackBindingRef, workspaceId: string) {
  return tx((session) => recordSlackWorkspaceIdentity(session, ref, identity(workspaceId)));
}

async function discoverAuth(teamId: string, integrationId: string, workspaceId: string) {
  const fake = fakeSlack({
    "auth.test": () => slackJson(authTestBody({ team_id: workspaceId, app_id: "A0OBSERVED1" })),
  });
  const result = await discoverSlackSource(
    { db: db(), teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null, maxRequests: 1 }
  );
  expect(fake.countOf("auth.test")).toBe(1);
  expect(result.binding).toMatchObject({ state: "verified", workspaceId });
}

beforeAll(requireSlackSourceTables);
afterAll(closeRawSql);

describe("insert-only Slack workspace observations", () => {
  it("records only the non-secret auth.test fact when the real bootstrap accepts it", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    await discoverAuth(seed.teamId, integrationId, FIRST);

    const observations = await workspaceObservationRows(seed.teamId, integrationId);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      team_id: seed.teamId,
      integration_id: integrationId,
      workspace_id: FIRST,
      provenance_kind: "auth_test",
    });
    expect(observations[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof observations[0]?.first_observed_at).toBe("string");
    expect(Number.isFinite(Date.parse(observations[0]?.first_observed_at as string))).toBe(true);

    const c = await rawSql();
    const columns = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_workspace_observations'
        order by column_name`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "first_observed_at", "id", "integration_id", "provenance_kind", "team_id", "workspace_id",
    ]);
    expect(JSON.stringify(observations)).not.toContain(TOKEN);
  });

  it("replays the same accepted auth.test without changing ID or first observed time", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    const ref = await currentRef(seed.teamId, integrationId);
    expect((await accept(ref, FIRST)).outcome).toBe("written");
    const before = await workspaceObservationRows(seed.teamId, integrationId);

    expect((await accept(ref, FIRST)).outcome).toBe("written");
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual(before);
  });

  it("refuses direct UPDATE and DELETE with a static error, even for a nested DELETE", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    await accept(await currentRef(seed.teamId, integrationId), FIRST);
    const before = await workspaceObservationRows(seed.teamId, integrationId);
    const id = before[0].id as string;
    const c = await rawSql();
    const immutable = { code: "23514", message: "Slack workspace observation is immutable" };

    await expect(c.query(
      `update slack_workspace_observations set workspace_id = $1 where id = $2`,
      [SECOND, id]
    )).rejects.toMatchObject(immutable);
    await expect(c.query(
      `update slack_workspace_observations set first_observed_at = first_observed_at where id = $1`,
      [id]
    )).rejects.toMatchObject(immutable);
    await expect(c.query(
      `delete from slack_workspace_observations where id = $1`, [id]
    )).rejects.toMatchObject(immutable);

    await c.query(`create temporary table observation_delete_probe (id uuid)`);
    await c.query(`create function pg_temp.delete_observation_probe() returns trigger
      language plpgsql as $$ begin
        delete from slack_workspace_observations where id = new.id;
        return new;
      end $$`);
    await c.query(`create trigger observation_delete_probe_trigger before insert
      on observation_delete_probe for each row execute function pg_temp.delete_observation_probe()`);
    await expect(c.query(
      `insert into observation_delete_probe (id) values ($1)`, [id]
    )).rejects.toMatchObject(immutable);
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual(before);
  });

  it("replays the migration without duplicating the guard or changing evidence", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    const ref = await currentRef(seed.teamId, integrationId);
    await accept(ref, FIRST);
    const before = await workspaceObservationRows(seed.teamId, integrationId);
    const c = await rawSql();

    await c.query(readFileSync("postgres/migrations/20260919220000_slack_workspace_observations.sql", "utf8"));
    const guards = await c.query<{ count: string }>(
      `select count(*)::text as count from pg_trigger
        where tgrelid = 'slack_workspace_observations'::regclass
          and tgname = 'slack_workspace_observations_immutable' and not tgisinternal`
    );
    expect(guards.rows[0].count).toBe("1");
    expect((await accept(ref, FIRST)).outcome).toBe("written");
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual(before);
    await expect(c.query(
      `delete from slack_workspace_observations where id = $1`, [before[0].id]
    )).rejects.toMatchObject({ code: "23514", message: "Slack workspace observation is immutable" });
  });

  it("cascades observations on team deletion and keeps another team's evidence", async () => {
    // Raw teams avoid unrelated seedTeam audit rows that independently block team deletion.
    const c = await rawSql();
    const teams = await c.query<{ id: string }>(
      `insert into teams (slug, name) values ($1, 'Cascade'), ($2, 'Survivor') returning id`,
      [`team-${randomUUID().slice(0, 8)}`, `team-${randomUUID().slice(0, 8)}`]
    );
    const [deletedTeam, survivingTeam] = teams.rows.map((row) => row.id);
    const deletedIntegration = randomUUID();
    const survivingIntegration = randomUUID();
    await c.query(
      `insert into slack_workspace_observations (team_id, integration_id, workspace_id)
        values ($1, $2, $3), ($4, $5, $6)`,
      [deletedTeam, deletedIntegration, FIRST, survivingTeam, survivingIntegration, SECOND]
    );
    const survivorBefore = await workspaceObservationRows(survivingTeam);

    await c.query(`delete from teams where id = $1`, [deletedTeam]);
    expect(await workspaceObservationRows(deletedTeam)).toEqual([]);
    expect(await workspaceObservationRows(survivingTeam)).toEqual(survivorBefore);
  });

  it("retains the first workspace after this integration rotates to a second", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    await discoverAuth(seed.teamId, integrationId, FIRST);
    const first = (await workspaceObservationRows(seed.teamId, integrationId))[0];

    await rotateSlackSecret(seed, integrationId, ROTATED);
    await elapse(seed.teamId);
    await discoverAuth(seed.teamId, integrationId, SECOND);

    const observations = await workspaceObservationRows(seed.teamId, integrationId);
    expect(observations.map((row) => row.workspace_id)).toEqual([FIRST, SECOND]);
    expect(observations[0]).toEqual(first);
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({ workspace_id: SECOND });
  });

  it("does not observe a workspace when the revision/fingerprint ref is stale", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    const stale = await currentRef(seed.teamId, integrationId);
    await rotateSlackSecret(seed, integrationId, ROTATED);
    await currentRef(seed.teamId, integrationId);

    expect((await accept(stale, FIRST)).outcome).toBe("stale");
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual([]);
    expect(await bindingRow(seed.teamId, integrationId)).toMatchObject({ state: "pending_auth", workspace_id: null });
  });

  it("rolls back a matched binding update when the observation insert fails", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    const ref = await currentRef(seed.teamId, integrationId);
    const before = await bindingRow(seed.teamId, integrationId);

    await expect(tx(async (session) => recordSlackWorkspaceIdentity(
      {
        ...session,
        executeSql: (sql, params) => {
          if (sql.includes("insert into slack_workspace_observations")) throw new Error("injected observation insert failure");
          return session.executeSql(sql, params);
        },
      },
      ref,
      identity(FIRST)
    ))).rejects.toThrow("injected observation insert failure");

    expect(await bindingRow(seed.teamId, integrationId)).toEqual(before);
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual([]);
  });

  it("removes both binding and observation when the caller transaction rolls back", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });

    await expect(tx(async (session) => {
      const read = await lockSlackSelection(session, {
        teamId: seed.teamId, integrationId, envToken: () => null,
      });
      if (read.outcome !== "current") throw new Error("fixture has no current Slack selection");
      await bindSlackSelection(session, read.selection);
      const result = await recordSlackWorkspaceIdentity(session, slackBindingRef(read.selection), identity(FIRST));
      expect(result.outcome).toBe("written");
      const inside = await session.executeSql<{ workspace_id: string }>(
        `select workspace_id from slack_workspace_observations where team_id = $1 and integration_id = $2`,
        [seed.teamId, integrationId]
      );
      expect(inside.rows).toEqual([{ workspace_id: FIRST }]);
      throw new Error("caller rollback");
    })).rejects.toThrow("caller rollback");

    expect(await bindingRow(seed.teamId, integrationId)).toBeNull();
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual([]);
  });

  it("keeps teams isolated even when a caller presents another team's integration ID", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const aId = await seedSlackIntegration(a, { token: TOKEN });
    const bId = await seedSlackIntegration(b, { token: ROTATED });
    const aRef = await currentRef(a.teamId, aId);
    const bRef = await currentRef(b.teamId, bId);
    expect((await accept(aRef, FIRST)).outcome).toBe("written");
    expect((await accept(bRef, SECOND)).outcome).toBe("written");

    expect((await accept({ ...aRef, teamId: b.teamId }, "T0FORGED1")).outcome).toBe("stale");
    expect((await workspaceObservationRows(a.teamId)).map((row) => row.workspace_id)).toEqual([FIRST]);
    expect((await workspaceObservationRows(b.teamId)).map((row) => row.workspace_id)).toEqual([SECOND]);
  });

  it("survives integration deletion without storing its credential", async () => {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { token: TOKEN });
    await discoverAuth(seed.teamId, integrationId, FIRST);
    const before = await workspaceObservationRows(seed.teamId, integrationId);

    const c = await rawSql();
    await c.query(`delete from integrations where team_id = $1 and id = $2`, [seed.teamId, integrationId]);

    expect(await bindingRow(seed.teamId, integrationId)).toBeNull();
    expect(await workspaceObservationRows(seed.teamId, integrationId)).toEqual(before);
    expect(JSON.stringify(before)).not.toContain(TOKEN);
  });
});
