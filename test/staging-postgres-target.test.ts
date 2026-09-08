/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restorePairedPostgres } from "../scripts/staging-ops/pg-paired.mjs";
import {
  assertLivePostgresTarget,
  assertProviderPostgresTarget,
  parseCanonicalPostgresTarget,
} from "../scripts/staging-ops/postgres-target.mjs";
import { DOCUMENTS, RAILWAY_OPERATIONS, RailwayMaintenance } from "../scripts/staging-ops/railway-maintenance.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const DATABASE_URL = "postgres://app:pw@postgres.railway.internal:5432/brain";
const target = parseCanonicalPostgresTarget(DATABASE_URL);
const pins = {
  projectId: "project",
  environmentId: "staging",
  serviceId: "postgres-service",
  serviceInstanceId: "postgres-instance-staging",
  deploymentId: "postgres-deployment-staging",
  hostname: "postgres.railway.internal",
  database: "brain",
  importerServiceId: "importer-service",
  importerServiceInstanceId: "importer-instance-staging",
  importerDeploymentId: "importer-deployment-staging",
};

describe("strict canonical Postgres destination", () => {
  it("binds equal service names and hostnames independently by environment identity", () => {
    const evidence = (environmentId: string) => ({
      projectId: "project", environmentId,
      serviceId: "postgres-service", serviceInstanceId: `postgres-instance-${environmentId}`,
      deploymentId: `postgres-deployment-${environmentId}`,
      importerServiceId: "importer-service", importerServiceInstanceId: `importer-instance-${environmentId}`,
      importerDeploymentId: `importer-deployment-${environmentId}`,
      hostname: "postgres.railway.internal", port: 5432, database: "brain",
      currentMatchesDeployment: true, importerReferenceBound: true,
    });
    for (const environmentId of ["staging", "production"]) {
      expect(assertProviderPostgresTarget(evidence(environmentId), target, {
        ...pins, environmentId,
        serviceInstanceId: `postgres-instance-${environmentId}`,
        deploymentId: `postgres-deployment-${environmentId}`,
        importerServiceInstanceId: `importer-instance-${environmentId}`,
        importerDeploymentId: `importer-deployment-${environmentId}`,
      })).toBe(true);
    }
  });

  it.each([
    { family: "IPv4", socketAddress: "::ffff:10.0.0.9", serverAddress: "10.0.0.9" },
    { family: "IPv6", socketAddress: "2001:db8::9", serverAddress: "2001:db8::9" },
  ])("verifies the live lock-owning $family backend using the SQL host address contract", async ({ socketAddress, serverAddress }) => {
    const client = {
      connectionParameters: { host: target.hostname, port: target.port, database: target.database, user: target.username },
      connection: { stream: { remoteAddress: socketAddress } },
      query: vi.fn().mockResolvedValue({ rows: [{ database: "brain", server_address: serverAddress, server_port: 5432, backend_pid: 71 }] }),
    };
    await expect(assertLivePostgresTarget(client, target)).resolves.toMatchObject({
      database: "brain", serverAddress, serverPort: 5432, backendPid: 71,
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("host(inet_server_addr()) AS server_address"));
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("inet_server_addr()::text"));
    await expect(assertLivePostgresTarget({ ...client, connectionParameters: { ...client.connectionParameters, database: "other" } }, target))
      .rejects.toThrow(/client configuration differs/);
    await expect(assertLivePostgresTarget({ ...client, connection: { stream: { remoteAddress: "203.0.113.10" } } }, target))
      .rejects.toThrow(/live lock-owning Postgres backend differs/);
  });

  it.each(["dbname=other", "hostaddr=203.0.113.10", "host=other.railway.internal", "port=6432"])(
    "refuses %s before cleanup or any restore subprocess",
    async (option) => {
      const client = { query: vi.fn() };
      const execImpl = vi.fn();
      await expect(restorePairedPostgres({ client, databaseUrl: `${DATABASE_URL}?${option}`, directory: "/unused", execImpl }))
        .rejects.toThrow(/unsupported connection parameter/);
      expect(client.query).not.toHaveBeenCalled();
      expect(execImpl).not.toHaveBeenCalled();
    },
  );

  it("hands one reconstructed destination to every restore/copy consumer and scrubs libpq overrides", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-pg-target-"));
    roots.push(directory);
    const execImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), on: vi.fn() };
    const raw = `${DATABASE_URL}?sslmode=require&application_name=staging%20importer`;
    await expect(restorePairedPostgres({ client, databaseUrl: raw, directory, execImpl,
      env: { STAGING_OPS_ENVIRONMENT_ID: "stg", RAILWAY_ENVIRONMENT_ID: "stg" } }))
      .rejects.toThrow(/exclusive data-use lock/);
    const expected = parseCanonicalPostgresTarget(raw).connectionString;
    const databaseArguments = execImpl.mock.calls.flatMap(([, args]) => args).filter((arg: unknown) => String(arg).startsWith("postgresql://"));
    expect(databaseArguments.length).toBeGreaterThanOrEqual(5);
    expect(new Set(databaseArguments)).toEqual(new Set([expected]));
    for (const [, , options] of execImpl.mock.calls) {
      expect(options.env.PGHOST).toBeUndefined();
      expect(options.env.PGHOSTADDR).toBeUndefined();
      expect(options.env.PGDATABASE).toBeUndefined();
      expect(options.env.PGSERVICE).toBeUndefined();
    }
  });
});

describe("Railway importer deployment Postgres binding", () => {
  function fixture(overrides: Record<string, unknown> = {}) {
    const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
      const { query, variables } = JSON.parse(String(init.body));
      if (query === DOCUMENTS.preflight) return Response.json({ data: {
        projectToken: { projectId: "project", environmentId: "staging" },
        __type: { fields: RAILWAY_OPERATIONS.map((name) => ({ name })) },
      } });
      if (query === DOCUMENTS.postgresService) {
        const postgres = variables.serviceId === "postgres-service";
        const role = postgres ? "postgres" : "importer";
        return Response.json({ data: { serviceInstance: {
          id: `${role}-instance-staging`, environmentId: "staging", serviceId: `${role}-service`, serviceName: postgres ? "Postgres" : "importer",
          activeDeployments: [{ id: `${role}-deployment-staging`, projectId: "project", environmentId: "staging", serviceId: `${role}-service`, status: "SUCCESS", snapshotId: `${role}-snapshot` }],
          ...overrides,
        } } });
      }
      if (query === DOCUMENTS.privateNetworks) return Response.json({ data: { privateNetworks: [{ publicId: "network", projectId: "project", environmentId: "staging", deletedAt: null }] } });
      if (query === DOCUMENTS.privateEndpoint) return Response.json({ data: { privateNetworkEndpoint: { serviceInstanceId: "postgres-instance-staging", dnsName: "postgres.railway.internal", newDnsName: null, deletedAt: null, syncStatus: "SUCCESS" } } });
      if (query === DOCUMENTS.postgresVariables) return Response.json({ data: { rendered: { DATABASE_URL }, unrendered: { DATABASE_URL: "${{Postgres.DATABASE_URL}}" } } });
      if (query === DOCUMENTS.postgresSnapshot) return Response.json({ data: { deploymentSnapshot: { id: "importer-snapshot", variables: { DATABASE_URL } } } });
      return Response.json({ errors: [{ message: "unexpected document" }] }, { status: 500 });
    });
    return fetchImpl;
  }

  it("requires active service-instance, endpoint, deployment snapshot, and service-reference evidence", async () => {
    const maintenance = new RailwayMaintenance({ projectId: "project", environmentId: "staging", appServiceId: "app", graphitiServiceId: "graph", token: "token", fetchImpl: fixture() });
    await expect(maintenance.assertPinnedPostgresTarget(target, pins)).resolves.toMatchObject({
      serviceInstanceId: "postgres-instance-staging", importerServiceInstanceId: "importer-instance-staging", importerDeploymentId: "importer-deployment-staging",
      hostname: "postgres.railway.internal", database: "brain", currentMatchesDeployment: true, importerReferenceBound: true,
    });
  });

  it("refuses a service instance from another environment even when host and global service ID match", async () => {
    const maintenance = new RailwayMaintenance({ projectId: "project", environmentId: "staging", appServiceId: "app", graphitiServiceId: "graph", token: "token",
      fetchImpl: fixture({ id: "postgres-instance-production" }) });
    await expect(maintenance.assertPinnedPostgresTarget(target, pins)).rejects.toThrow(/service instance differs/);
  });
});
