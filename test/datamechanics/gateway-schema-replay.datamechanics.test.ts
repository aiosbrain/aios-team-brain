import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const schemaSql = readFileSync(join(ROOT, "postgres", "schema.sql"), "utf8");
const migrationSql = readFileSync(
  join(ROOT, "postgres", "migrations", "20260714090000_gateway_persistence.sql"), "utf8"
);
const approvalMigrationSql = readFileSync(
  join(ROOT, "postgres", "migrations", "20260716120000_gateway_approval_admin.sql"), "utf8"
);
const transportMigrationSql = readFileSync(
  join(ROOT, "postgres", "migrations", "20260714120000_gateway_v110.sql"), "utf8"
);
const gatewayTables = [
  "gateway_service_identities", "gateway_service_credentials", "executor_subject_bindings", "gateway_connections",
  "gateway_resolution_leases", "gateway_executions", "gateway_approvals", "gateway_audit_log",
  "gateway_rate_limits",
];

async function isolatedSchema(run: (client: Client, schema: string) => Promise<void>) {
  const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
  const schema = `gateway_replay_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}", public`);
    await run(client, schema);
  } finally {
    await client.query(`drop schema if exists "${schema}" cascade`);
    await client.end();
  }
}

describe("gateway-schema-replay", () => {
  it("bootstraps from zero and replays the gateway migration idempotently", async () => {
    await isolatedSchema(async (client, schema) => {
      await client.query(schemaSql);
      await client.query(migrationSql);
      await client.query(migrationSql);
      const team = randomUUID();
      await client.query(
        `insert into teams(id,slug,name) values($1,$2,'Replay Team')`,
        [team, `replay-${team.slice(0, 8)}`],
      );
      await client.query(
        `insert into gateway_service_identities(
          team_id,environment,credential_id,credential_hash,credential_version
        ) values($1,'legacy','ICEiIyQlJicoKSorLC0uLw',$2,7)`,
        [team, "a".repeat(64)],
      );
      await client.query(transportMigrationSql);
      await client.query(approvalMigrationSql);
      await client.query(approvalMigrationSql);
      const result = await client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname=$1 and tablename=any($2) order by tablename`,
        [schema, gatewayTables]
      );
      expect(result.rows.map((row) => row.tablename)).toEqual([...gatewayTables].sort());
      const copied = await client.query(
        `select credential_id,version,secret_hash
           from gateway_service_credentials where team_id=$1`,
        [team],
      );
      expect(copied.rows[0]).toEqual({
        credential_id: "ICEiIyQlJicoKSorLC0uLw",
        version: 7,
        secret_hash: "a".repeat(64),
      });
    });
  });

  it("upgrades a pre-gateway schema fixture and remains replay-safe", async () => {
    await isolatedSchema(async (client, schema) => {
      await client.query(`create table teams (id uuid primary key default gen_random_uuid())`);
      await client.query(`create table members (
        id uuid primary key default gen_random_uuid(), team_id uuid not null references teams(id),
        actor_handle text not null default 'actor', role text not null default 'member',
        status text not null default 'active', tier text not null default 'team')`);
      await client.query(migrationSql);
      await client.query(migrationSql);
      await client.query(transportMigrationSql);
      await client.query(transportMigrationSql);
      await client.query(approvalMigrationSql);
      await client.query(approvalMigrationSql);
      const result = await client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname=$1 and tablename=any($2) order by tablename`,
        [schema, gatewayTables]
      );
      expect(result.rows.map((row) => row.tablename)).toEqual([...gatewayTables].sort());
    });
  });

  it("fails legacy credential grammar before copying any digest", async () => {
    await isolatedSchema(async (client) => {
      await client.query(`create table teams (id uuid primary key default gen_random_uuid())`);
      await client.query(`create table members (
        id uuid primary key default gen_random_uuid(), team_id uuid not null references teams(id),
        actor_handle text not null default 'actor', role text not null default 'member',
        status text not null default 'active', tier text not null default 'team')`);
      await client.query(migrationSql);
      const team = randomUUID();
      await client.query(`insert into teams(id) values($1)`, [team]);
      await client.query(
        `insert into gateway_service_identities(
          team_id,environment,credential_id,credential_hash,credential_version
        ) values($1,'legacy','not-canonical','not-a-digest',1)`,
        [team],
      );
      await expect(client.query(approvalMigrationSql)).rejects.toThrow(
        "gateway_service_identity_legacy_preflight",
      );
      const copied = await client.query(
        `select count(*)::int n from pg_tables
          where schemaname=current_schema() and tablename='gateway_service_credentials'`,
      );
      expect(copied.rows[0].n).toBe(0);
    });
  });
});
