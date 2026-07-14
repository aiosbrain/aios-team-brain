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
const gatewayTables = [
  "gateway_service_identities", "executor_subject_bindings", "gateway_connections",
  "gateway_resolution_leases", "gateway_executions", "gateway_approvals", "gateway_audit_log",
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
      const result = await client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname=$1 and tablename=any($2) order by tablename`,
        [schema, gatewayTables]
      );
      expect(result.rows.map((row) => row.tablename)).toEqual([...gatewayTables].sort());
    });
  });

  it("upgrades a pre-gateway schema fixture and remains replay-safe", async () => {
    await isolatedSchema(async (client, schema) => {
      await client.query(`create table teams (id uuid primary key default gen_random_uuid())`);
      await client.query(`create table members (
        id uuid primary key default gen_random_uuid(), team_id uuid not null references teams(id),
        status text not null default 'active', tier text not null default 'team')`);
      await client.query(migrationSql);
      await client.query(migrationSql);
      const result = await client.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname=$1 and tablename=any($2) order by tablename`,
        [schema, gatewayTables]
      );
      expect(result.rows.map((row) => row.tablename)).toEqual([...gatewayTables].sort());
    });
  });
});
