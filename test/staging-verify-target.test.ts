import { describe, expect, it, vi } from "vitest";
import { importerPreflight, runImporter, verifyStagingTarget } from "../scripts/staging-ops/importer.mjs";

/**
 * M1 — THE NAMED ACTIVATION COMMAND NOW MEASURES THE DESTINATION IT PROMISES.
 *
 * `docs/OPS.md` and `scripts/dm-network-attached.sh` both told an operator to run a command against
 * the live staging service and confirm the destination check passes on Railway's own private
 * network. They named `importer verify`, which verifies and pins a source BUNDLE: its preflight
 * deliberately omits the runtime/provider pins and its maintenance adapter is null, so it could not
 * perform that check at all. `verifyPostgresDestination` was reachable only from install, bootstrap
 * and replacement — every one of which goes on to drain staging.
 *
 * `verify-target` is that proof with a caller of its own, and the properties below are what make it
 * a proof rather than a green light: it MEASURES (no skip-when-unpinned branch), it mutates nothing,
 * and it never prints the connection string it was given.
 */

const PASSWORD = "sup3rs3cret-pg-pw";

const ENV = {
  STAGING_OPS_ROLE: "importer",
  STAGING_OPS_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  RAILWAY_ENVIRONMENT_ID: "env-staging",
  STAGING_OPS_ENVIRONMENT_ID: "env-staging",
  RAILWAY_PROJECT_ID: "project-1",
  RAILWAY_STAGING_MAINTENANCE_TOKEN: "maintenance-token",
  STAGING_APP_SERVICE_ID: "svc-app",
  STAGING_GRAPHITI_SERVICE_ID: "svc-graphiti",
  STAGING_IMPORTER_SERVICE_ID: "svc-importer",
  STAGING_IMPORTER_SERVICE_INSTANCE_ID: "inst-importer",
  STAGING_IMPORTER_DEPLOYMENT_ID: "dep-importer",
  STAGING_POSTGRES_SERVICE_ID: "svc-pg",
  STAGING_POSTGRES_SERVICE_INSTANCE_ID: "inst-pg",
  STAGING_POSTGRES_DEPLOYMENT_ID: "dep-pg",
  STAGING_POSTGRES_HOST: "staging-pg.railway.internal",
  STAGING_POSTGRES_DATABASE: "brain",
  DATABASE_URL: `postgres://app:${PASSWORD}@staging-pg.railway.internal:5432/brain`,
  NEO4J_URL: "bolt://staging-neo4j.railway.internal:7687",
} as unknown as NodeJS.ProcessEnv;

/** The lock-owning session, answering the ONE read the live peer check performs. */
const liveClient = (row: Record<string, unknown> = {}) => ({
  connectionParameters: { host: "staging-pg.railway.internal", port: 5432, database: "brain", user: "app" },
  connection: { stream: { remoteAddress: "10.0.0.7" } },
  query: vi.fn(async () => ({
    rows: [{ database: "brain", server_address: "10.0.0.7", server_port: 5432, backend_pid: 41, ...row }],
  })),
});

/** Every lifecycle verb the importer has, so "nothing was mutated" is asserted over all of them. */
const stubMaintenance = (over: Record<string, unknown> = {}) => ({
  assertPinnedPostgresTarget: vi.fn(async (target: { hostname: string; port: number; database: string }, pins: Record<string, string>) => ({
    projectId: pins.projectId, environmentId: pins.environmentId,
    serviceId: pins.serviceId, serviceInstanceId: pins.serviceInstanceId, deploymentId: pins.deploymentId,
    importerServiceId: pins.importerServiceId, importerServiceInstanceId: pins.importerServiceInstanceId,
    importerDeploymentId: pins.importerDeploymentId,
    hostname: target.hostname, port: target.port, database: target.database,
    currentMatchesDeployment: true, importerReferenceBound: true,
  })),
  stopAndVerifyAll: vi.fn(),
  deployApp: vi.fn(),
  listActiveDeployments: vi.fn(),
  readDeployment: vi.fn(),
  tokenIdentity: vi.fn(),
  assertPinnedRunnerConfiguration: vi.fn(),
  ...over,
});

const MUTATING = ["stopAndVerifyAll", "deployApp"] as const;

describe("M1 — verify-target measures the pinned destination and changes nothing", () => {
  it("returns the measured live and provider outcome", async () => {
    const client = liveClient();
    const maintenance = stubMaintenance();

    const result = await verifyStagingTarget({ client, maintenance, env: ENV });

    expect(result).toMatchObject({
      status: "target-verified",
      // The local harness has no provider to measure; only this value is the activation evidence.
      proof: "provider-measured",
      target: { hostname: "staging-pg.railway.internal", port: 5432, database: "brain", username: "app" },
      live: { database: "brain", serverAddress: "10.0.0.7", serverPort: 5432, backendPid: 41 },
      provider: { projectId: "project-1", environmentId: "env-staging", serviceId: "svc-pg", importerDeploymentId: "dep-importer" },
    });
    // The provider read happened against THIS run's pins, not against defaults it invented.
    expect(maintenance.assertPinnedPostgresTarget).toHaveBeenCalledTimes(1);
    expect(maintenance.assertPinnedPostgresTarget.mock.calls[0][1]).toMatchObject({
      projectId: "project-1", environmentId: "env-staging", serviceId: "svc-pg",
      serviceInstanceId: "inst-pg", deploymentId: "dep-pg", hostname: "staging-pg.railway.internal",
      database: "brain", importerServiceId: "svc-importer",
    });
  });

  it("performs exactly one read on the lock-owning session and no mutation anywhere", async () => {
    // The whole reason this action can be handed to an operator before activation: it is the same
    // verifier the drain path runs, without the drain path. A single SELECT, and not one lifecycle
    // verb — anything else would make a "read-only check" the first half of a maintenance window.
    const client = liveClient();
    const maintenance = stubMaintenance();

    await verifyStagingTarget({ client, maintenance, env: ENV });

    expect(client.query).toHaveBeenCalledTimes(1);
    const sql = String(client.query.mock.calls[0][0]);
    expect(sql).toMatch(/^SELECT\b/);
    expect(sql, "the destination check issued something other than a read").not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|BEGIN|TRUNCATE|ALTER)\b/i);
    for (const verb of MUTATING) {
      expect(maintenance[verb], `verify-target called maintenance.${verb}`).not.toHaveBeenCalled();
    }
  });

  it("never returns the connection string it was given", async () => {
    // This value is printed by the CLI (`console.log(JSON.stringify(result))`), so a target object
    // carrying `connectionString` would put the staging Postgres password in a log line.
    const result = await verifyStagingTarget({ client: liveClient(), maintenance: stubMaintenance(), env: ENV });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(result.target).not.toHaveProperty("connectionString");
  });

  it("REFUSES when the provider evidence does not match the pins, and mutates nothing on the way out", async () => {
    // The proof half. A verifier that swallowed this and returned a verdict would be exactly the
    // "conditionally skip the proof and return green" shape this action must not have.
    const client = liveClient();
    const maintenance = stubMaintenance({
      assertPinnedPostgresTarget: vi.fn(async () => { throw new Error("provider Postgres evidence differs from the pinned project/environment/service-instance/deployment identity"); }),
    });

    await expect(verifyStagingTarget({ client, maintenance, env: ENV })).rejects.toThrow(/differs from the pinned/);
    for (const verb of MUTATING) expect(maintenance[verb]).not.toHaveBeenCalled();
  });

  it("REFUSES when the live backend is not the canonical database target", async () => {
    // The other measurement, and the one the dm-network lane exists for: the socket peer must equal
    // the server's own address. A NAT'd or redirected destination fails here.
    const client = liveClient({ server_address: "172.18.0.1" });
    const maintenance = stubMaintenance();

    await expect(verifyStagingTarget({ client, maintenance, env: ENV }))
      .rejects.toThrow(/live lock-owning Postgres backend differs/);
    for (const verb of MUTATING) expect(maintenance[verb]).not.toHaveBeenCalled();
  });
});

describe("M1 — verify-target's preflight requires its own dependencies and nothing else", () => {
  // `STAGING_OPS_ENVIRONMENT_ID` and `RAILWAY_ENVIRONMENT_ID` are deliberately absent from this
  // table: `assertRunnerRole` refuses them first, with its own message, before any action branch.
  it.each([
    "RAILWAY_PROJECT_ID",
    "RAILWAY_STAGING_MAINTENANCE_TOKEN",
    "STAGING_APP_SERVICE_ID",
    "STAGING_GRAPHITI_SERVICE_ID",
    "STAGING_IMPORTER_SERVICE_ID",
    "STAGING_IMPORTER_SERVICE_INSTANCE_ID",
    "STAGING_IMPORTER_DEPLOYMENT_ID",
    "STAGING_POSTGRES_SERVICE_ID",
    "STAGING_POSTGRES_SERVICE_INSTANCE_ID",
    "STAGING_POSTGRES_DEPLOYMENT_ID",
    "STAGING_POSTGRES_HOST",
    "STAGING_POSTGRES_DATABASE",
  ])("refuses when %s is absent rather than measuring without it", async (name) => {
    await expect(importerPreflight({ ...ENV, [name]: "" } as NodeJS.ProcessEnv, "verify-target"))
      .rejects.toThrow(`${name} is required`);
  });

  it("does NOT require source-object, tester, origin or rollback-signing configuration", async () => {
    // `ENV` deliberately carries no bundle keys, no object-store settings, no tester credentials and
    // no staging origin. Demanding them would make the read-only destination check unavailable
    // exactly when an operator needs it — before the rest of the system has been provisioned — and
    // the adjudication names each of them as unrelated to this measurement.
    for (const unrelated of [
      "EXPORTER_SIGNING_PUBLIC_KEY", "IMPORTER_ENCRYPTION_PRIVATE_KEY", "ROLLBACK_SIGNING_PRIVATE_KEY",
      "STAGING_TESTER_CREDENTIALS_JSON", "STAGING_ORIGIN", "STAGING_HEALTH_TOKEN",
      "STAGING_COMPARISON_KEY_BASE64", "STAGING_SOURCE_BUCKET",
    ]) {
      expect((ENV as Record<string, string | undefined>)[unrelated], `${unrelated} leaked into the fixture`).toBeUndefined();
    }
    await expect(importerPreflight(ENV, "verify-target")).resolves.toBe(true);
  });
});

describe("M1 — the CLI actually dispatches the action", () => {
  it("routes `verify-target` to its own preflight, before it opens any database connection", async () => {
    // Real dispatch through `runImporter`, and the refusal identifies WHICH branch it reached: an
    // unrecognised action fails with the action-list message below, and the destination preflight
    // runs before `new pg.Client(...)`, so this rejection is evidence of the wiring rather than of a
    // failed connection.
    await expect(runImporter({ ...ENV, STAGING_POSTGRES_HOST: "" } as NodeJS.ProcessEnv, ["verify-target"]))
      .rejects.toThrow("STAGING_POSTGRES_HOST is required");
  });

  it("still refuses an action that is not in the CLI's set", async () => {
    await expect(runImporter(ENV, ["verify-targets"]))
      .rejects.toThrow(/importer action must be install-ops, verify, verify-target, install/);
  });
});
