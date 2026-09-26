import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { runSql } from "@/lib/db/pg/pool";
import { readSlackWorkspaceObservationRows } from "@/lib/identity/slack-workspace-observation-rows";
import { seedTeam } from "./helpers";

beforeAll(async () => {
  const { rows } = await runSql<{ name: string | null }>(
    `select to_regclass('public.slack_workspace_observations')::text as name`
  );
  if (!rows[0]?.name) throw new Error("slack_workspace_observations is missing from the test schema");
});

async function observe(teamId: string, integrationId: string, workspaceId: string) {
  const { rows } = await runSql<{ id: string }>(
    `insert into slack_workspace_observations (team_id, integration_id, workspace_id)
     values ($1, $2, $3) returning id`,
    [teamId, integrationId, workspaceId]
  );
  return rows[0].id;
}

describe("inactive Slack workspace observation snapshot on real Postgres", () => {
  it("isolates teams and retains rotated workspaces after integration deletion", async () => {
    const team = await seedTeam();
    const other = await seedTeam();
    const integrationId = randomUUID();
    const otherIntegrationId = randomUUID();
    await runSql(
      `insert into integrations (id, team_id, type, name)
       values ($1, $2, 'slack', 'rotated'), ($3, $4, 'slack', 'other')`,
      [integrationId, team.teamId, otherIntegrationId, other.teamId]
    );
    const firstId = await observe(team.teamId, integrationId, "TROTATED1");
    const secondId = await observe(team.teamId, integrationId, "TROTATED2");
    await observe(other.teamId, otherIntegrationId, "TOTHER");
    await runSql(`delete from integrations where id = $1`, [integrationId]);

    const rows = await readSlackWorkspaceObservationRows(team.teamId, { pageSize: 1 });
    expect(rows).toEqual([
      { id: firstId, teamId: team.teamId, integrationId, workspaceId: "TROTATED1",
        firstObservedAt: expect.any(String), provenanceKind: "auth_test" },
      { id: secondId, teamId: team.teamId, integrationId, workspaceId: "TROTATED2",
        firstObservedAt: expect.any(String), provenanceKind: "auth_test" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(rows.every((row) => Number.isFinite(Date.parse(row.firstObservedAt)))).toBe(true);
    expect(rows.every((row) => Object.keys(row).length === 6)).toBe(true);
    expect((await readSlackWorkspaceObservationRows(other.teamId)).map((row) => row.workspaceId)).toEqual(["TOTHER"]);
  });

  it("exhausts more than the default page size with tied timestamps", async () => {
    const team = await seedTeam();
    const integrationId = randomUUID();
    await runSql(
      `insert into slack_workspace_observations
         (team_id, integration_id, workspace_id, first_observed_at)
       select $1::uuid, $2::uuid, 'T' || n::text, '2026-09-19T12:00:00Z'::timestamptz
         from generate_series(1, 519) n`,
      [team.teamId, integrationId]
    );
    const expected = (await runSql<{ id: string }>(
      `select id from slack_workspace_observations where team_id = $1 order by id`, [team.teamId]
    )).rows.map((row) => row.id);

    const rows = await readSlackWorkspaceObservationRows(team.teamId);
    expect(rows).toHaveLength(519);
    expect(rows.map((row) => row.id)).toEqual(expected);
    expect(new Set(rows.map((row) => row.id)).size).toBe(519);
    expect(new Set(rows.map((row) => row.firstObservedAt)).size).toBe(1);
  });

  it("holds one snapshot when another connection inserts after the first page", async () => {
    const team = await seedTeam();
    const integrationId = randomUUID();
    const originalIds = [
      await observe(team.teamId, integrationId, "TA"),
      await observe(team.teamId, integrationId, "TB"),
      await observe(team.teamId, integrationId, "TC"),
    ];
    let inserted = 0;
    const rows = await readSlackWorkspaceObservationRows(team.teamId, {
      pageSize: 1,
      afterPage: async (pageNumber) => {
        if (pageNumber !== 1) return;
        await observe(team.teamId, integrationId, "TNEW");
        inserted++;
      },
    });
    expect(inserted).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(originalIds.sort());
    expect((await readSlackWorkspaceObservationRows(team.teamId)).map((row) => row.workspaceId)).toContain("TNEW");
  });

  it("rejects invalid arguments, a later query failure, and writes inside the read-only transaction", async () => {
    const team = await seedTeam();
    for (const badTeamId of ["", "not-a-uuid", null]) {
      await expect(readSlackWorkspaceObservationRows(badTeamId as string)).rejects.toThrow("invalid team ID");
    }
    for (const pageSize of [0, -1, 1.5, 513, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readSlackWorkspaceObservationRows(team.teamId, { pageSize })).rejects.toThrow("invalid page size");
    }
    const integrationId = randomUUID();
    await observe(team.teamId, integrationId, "TA");
    await observe(team.teamId, integrationId, "TB");
    let pages = 0;
    await expect(readSlackWorkspaceObservationRows(team.teamId, {
      pageSize: 1,
      afterPage: async (pageNumber, query) => {
        pages = pageNumber;
        if (pageNumber === 1) await query("select * from aio_1170_missing_observation_page");
      },
    })).rejects.toThrow();
    expect(pages).toBe(1);

    await expect(readSlackWorkspaceObservationRows(team.teamId, {
      pageSize: 1,
      afterPage: async (_pageNumber, query) => {
        await query(
          `insert into slack_workspace_observations (team_id, integration_id, workspace_id)
           values ($1, $2, 'TMUSTNOTWRITE')`, [team.teamId, integrationId]
        );
      },
    })).rejects.toMatchObject({ code: "25006" });
    expect((await readSlackWorkspaceObservationRows(team.teamId)).map((row) => row.workspaceId))
      .toEqual(expect.arrayContaining(["TA", "TB"]));
    expect((await runSql<{ id: string }>(
      `select id from slack_workspace_observations where workspace_id = 'TMUSTNOTWRITE'`
    )).rows).toEqual([]);
  });
});
