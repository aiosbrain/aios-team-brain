import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { db, seedTeam } from "./helpers";

// AIO-1171: SQL compatibility precedes public v3 acceptance (AIO-1096). Test-only
// persisted canonical fixtures exercise the existing RPC, never a second writer.
const fixtureBytes = readFileSync(
  "test/fixtures/contract/codebase-payload-1.25-fixtures.json",
);
const fixtures = JSON.parse(fixtureBytes.toString());
const canonical = fixtures.valid.find(
  (f: { name: string }) => f.name === "valid-v3-complete",
).payload.metrics.codebase_health;
const finding = {
  fingerprint: "a".repeat(64),
  check_id: "test_rigor",
  axis: "structure",
  kind: "quality_issue",
  severity: "high",
  evidence_status: "complete",
  remediation_tier: 0,
};
const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
beforeAll(async () => {
  await client.connect();
  await client.query(
    readFileSync(
      "postgres/migrations/20260910060000_codebase_finding_health_v3.sql",
      "utf8",
    ),
  );
});
afterAll(async () => {
  try {
    await client.query(
      functionDefinition(readFileSync("postgres/schema.sql", "utf8")),
    );
  } finally {
    await client.end();
  }
});

function health(
  version: "2" | "3",
  hour: number,
  present = true,
  complete = true,
) {
  const value = structuredClone(canonical);
  value.schema_version = version;
  if (version === "2") delete value.check_coverage;
  value.head_sha = hour.toString(16).padStart(40, "0");
  value.measured_at = `2026-09-01T${String(hour).padStart(2, "0")}:00:00Z`;
  value.findings = present ? [finding] : [];
  if (!complete) {
    value.evidence_status = "partial";
    value.quality_gate = "unknown";
    value.automation_eligible = false;
  }
  return value;
}
async function repository(teamId: string) {
  const { rows } = await client.query(
    "insert into codebases(team_id,slug) values($1,$2) returning id",
    [teamId, randomUUID()],
  );
  return rows[0].id as string;
}
async function persist(
  teamId: string,
  codebaseId: string,
  value: ReturnType<typeof health>,
) {
  const { rows } = await client.query(
    "insert into code_metrics(team_id,codebase_id,head_sha,codebase_health) values($1,$2,$3,$4) returning id",
    [teamId, codebaseId, value.head_sha, JSON.stringify(value)],
  );
  return rows[0].id as string;
}
function reconcile(
  teamId: string,
  codebaseId: string,
  metricsId: string,
  value: ReturnType<typeof health>,
) {
  return db().rpc("reconcile_codebase_findings", {
    p_team_id: teamId,
    p_codebase_id: codebaseId,
    p_metrics_id: metricsId,
    p_health: value,
  });
}
async function snapshot() {
  const findings = await client.query(
    "select * from codebase_findings order by id",
  );
  const events = await client.query(
    "select * from codebase_finding_events order by id",
  );
  return { findings: findings.rows, events: events.rows };
}

describe("health v3 SQL compatibility", () => {
  it("uses exact canonical 1.25 fixture bytes", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "22bc99241032d38578be67a3130af08404efe4588cf678046fb687a00ab91d5a",
    );
    expect(canonical.schema_version).toBe("3");
  });

  it.each(["2", "3"] as const)(
    "v%s detects, reobserves, resolves and reopens with replay idempotence",
    async (version) => {
      const seed = await seedTeam();
      const repo = await repository(seed.teamId);
      const first = health(version, 1);
      const firstId = await persist(seed.teamId, repo, first);
      expect(await reconcile(seed.teamId, repo, firstId, first)).toMatchObject({
        error: null,
        data: { detected: 1 },
      });
      const beforeReplay = await snapshot();
      expect(beforeReplay.findings).toHaveLength(1);
      expect(beforeReplay.events.map((e) => e.event_type)).toEqual([
        "detected",
      ]);
      expect(
        (await reconcile(seed.teamId, repo, firstId, first)).error,
      ).toBeNull();
      expect(await snapshot()).toEqual(beforeReplay);

      for (const [hour, present, complete, expected] of [
        [2, true, true, "observed"],
        [3, false, false, null],
        [4, false, true, "resolved"],
        [5, true, true, "reopened"],
      ] as const) {
        const value = health(version, hour, present, complete);
        const id = await persist(seed.teamId, repo, value);
        const before = await snapshot();
        const result = await reconcile(seed.teamId, repo, id, value);
        expect(result.error).toBeNull();
        const after = await snapshot();
        if (expected)
          expect(
            after.events.filter((e) => e.event_type === expected),
          ).toHaveLength(1);
        else expect(after).toEqual(before);
        expect(
          (await reconcile(seed.teamId, repo, id, value)).error,
        ).toBeNull();
        expect(await snapshot()).toEqual(after);
        expect(
          (
            await client.query(
              "select codebase_health from code_metrics where id=$1",
              [id],
            )
          ).rows[0].codebase_health,
        ).toEqual(value);
      }
      const final = await snapshot();
      expect(final.findings).toHaveLength(1);
      expect(final.findings[0]).toMatchObject({
        status: "reopened",
        occurrence_count: 3,
      });
      expect(final.events).toHaveLength(4);
    },
  );

  it.each([
    ["2", "3"],
    ["3", "2"],
    ["3", "3"],
  ] as const)(
    "older v%s cannot become active after a newer v%s clean scan",
    async (olderVersion, newerVersion) => {
      const seed = await seedTeam();
      const repo = await repository(seed.teamId);
      const newer = health(newerVersion, 5, false);
      const newerId = await persist(seed.teamId, repo, newer);
      expect(
        (await reconcile(seed.teamId, repo, newerId, newer)).error,
      ).toBeNull();
      const older = health(olderVersion, 2);
      const olderId = await persist(seed.teamId, repo, older);
      expect(await reconcile(seed.teamId, repo, olderId, older)).toMatchObject({
        error: null,
        data: { stale: 1, detected: 0 },
      });
      const state = await snapshot();
      expect(state.findings).toHaveLength(1);
      expect(state.findings[0].status).toBe("stale_analysis");
      expect(state.events.map((e) => e.event_type)).toEqual(["stale_analysis"]);
      const newest = health(newerVersion, 6);
      const newestId = await persist(seed.teamId, repo, newest);
      expect(
        await reconcile(seed.teamId, repo, newestId, newest),
      ).toMatchObject({ error: null, data: { reopened: 1 } });
      expect((await snapshot()).findings[0].status).toBe("reopened");
    },
  );

  it("rejects wrong team, codebase, head and changed-object identity without writes", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const repo = await repository(seed.teamId);
    const otherRepo = await repository(other.teamId);
    const value = health("3", 1);
    const id = await persist(seed.teamId, repo, value);
    expect((await reconcile(seed.teamId, repo, id, value)).error).toBeNull();
    const baseline = await snapshot();
    for (const [team, codebase, candidate] of [
      [other.teamId, repo, value],
      [seed.teamId, otherRepo, value],
      [seed.teamId, repo, { ...value, head_sha: "f".repeat(40) }],
      [seed.teamId, repo, { ...value, score_pct: 1 }],
    ] as const) {
      expect(
        (await reconcile(team, codebase, id, candidate)).error?.message,
      ).toContain("metrics identity mismatch");
      expect(await snapshot()).toEqual(baseline);
    }
  });

  it("keeps legacy v1 metrics-only", async () => {
    const seed = await seedTeam();
    const repo = await repository(seed.teamId);
    const value = { ...health("3", 1), schema_version: "1" };
    const id = await persist(seed.teamId, repo, value);
    expect(await reconcile(seed.teamId, repo, id, value)).toMatchObject({
      error: null,
      data: { detected: 0 },
    });
    expect(await snapshot()).toEqual({ findings: [], events: [] });
  });
});

function functionDefinition(source: string) {
  const start = source.indexOf(
    "create or replace function reconcile_codebase_findings(",
  );
  const end = source.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("ledger function missing");
  return source.slice(start, end + 4);
}

it("upgrades the baseline in place, matches bootstrap, and rolls back/reapplies safely", async () => {
  const baseline = functionDefinition(
    readFileSync(
      "postgres/migrations/20260804160000_explainable_debt_decisions.sql",
      "utf8",
    ),
  );
  const migration = readFileSync(
    "postgres/migrations/20260910060000_codebase_finding_health_v3.sql",
    "utf8",
  );
  const bootstrap = functionDefinition(
    readFileSync("postgres/schema.sql", "utf8"),
  );
  const catalog = async () =>
    (
      await client.query(`select p.oid, p.proacl, p.proowner,
    pg_get_functiondef(p.oid) as definition,
    (select jsonb_agg(to_jsonb(d) order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype)
      from pg_depend d where d.objid=p.oid or d.refobjid=p.oid) as dependencies
    from pg_proc p where p.oid='reconcile_codebase_findings(uuid,uuid,uuid,jsonb)'::regprocedure`)
    ).rows[0];
  try {
    await client.query(baseline);
    const before = await catalog();
    const seed = await seedTeam();
    const repo = await repository(seed.teamId);
    const value = health("3", 1);
    const id = await persist(seed.teamId, repo, value);
    expect(await reconcile(seed.teamId, repo, id, value)).toMatchObject({
      error: null,
      data: { detected: 0 },
    });
    expect((await snapshot()).findings).toHaveLength(0);

    await client.query(migration);
    const upgraded = await catalog();
    expect(upgraded.oid).toBe(before.oid);
    expect(upgraded.proacl).toEqual(before.proacl);
    expect(upgraded.proowner).toBe(before.proowner);
    expect(upgraded.dependencies).toEqual(before.dependencies);
    expect(await reconcile(seed.teamId, repo, id, value)).toMatchObject({
      error: null,
      data: { detected: 1 },
    });
    const retained = await snapshot();
    await client.query(bootstrap);
    expect(await catalog()).toEqual(upgraded);

    await client.query(baseline);
    expect(await catalog()).toEqual(before);
    expect(await snapshot()).toEqual(retained);
    const v2 = health("2", 2);
    const v2Id = await persist(seed.teamId, repo, v2);
    expect(await reconcile(seed.teamId, repo, v2Id, v2)).toMatchObject({
      error: null,
      data: { observed: 1 },
    });
    await client.query(migration);
    expect(await catalog()).toEqual(upgraded);
    const v3 = health("3", 3, false);
    const v3Id = await persist(seed.teamId, repo, v3);
    expect(await reconcile(seed.teamId, repo, v3Id, v3)).toMatchObject({
      error: null,
      data: { resolved: 1 },
    });
    expect((await snapshot()).events).toHaveLength(3);
    console.info("AIO-1171 function SHA256", {
      baseline: createHash("sha256").update(before.definition).digest("hex"),
      upgraded: createHash("sha256").update(upgraded.definition).digest("hex"),
    });
  } finally {
    await client.query(migration);
  }
});
