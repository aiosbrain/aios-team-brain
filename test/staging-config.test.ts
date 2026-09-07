import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyConfiguredTopology } from "../scripts/staging-ops/importer.mjs";
import {
  preflightStagingTopology,
  type StagingTopology,
} from "../scripts/staging-ops/config.mjs";

/**
 * The MEASURED production shape, which the previous per-role distinctness rule refused outright:
 * one project, two environments, and the SAME global service IDs on both sides. A Railway service
 * ID names a service definition, not a deployment of it — the same service is deployed into every
 * environment of its project — so requiring the IDs to differ demanded duplicate resources and
 * rejected a correctly isolated topology with four errors.
 */
const GOOD: StagingTopology = {
  repositoryDefaultBranch: "staging",
  contributionBranch: "staging",
  staging: {
    projectId: "project-a",
    environmentId: "environment-staging",
    appServiceId: "service-app",
    graphitiServiceId: "service-graphiti",
    postgresServiceId: "service-postgres",
    neo4jServiceId: "service-neo4j",
    appSourceBranch: "staging",
    // Railway's private DNS is environment-scoped, so identical names on both sides address
    // different databases. Neither identical nor distinct names are evidence either way.
    postgresHost: "postgres.railway.internal",
    neo4jHost: "neo4j.railway.internal",
    variableReferences: {
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687",
    },
  },
  production: {
    projectId: "project-a",
    environmentId: "environment-production",
    appServiceId: "service-app",
    graphitiServiceId: "service-graphiti",
    postgresServiceId: "service-postgres",
    neo4jServiceId: "service-neo4j",
    appSourceBranch: "main",
    postgresHost: "postgres.railway.internal",
    neo4jHost: "neo4j.railway.internal",
    variableReferences: {
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687",
    },
  },
};

describe("staging topology preflight", () => {
  it("accepts one project with two environments sharing global service IDs", () => {
    expect(preflightStagingTopology(GOOD)).toEqual({ ok: true, errors: [] });
  });

  it("still accepts genuinely separate projects and services", () => {
    // The correction widens what is accepted; it must not narrow it. A two-project topology is
    // also isolated and must keep passing.
    const separate = structuredClone(GOOD);
    separate.production.projectId = "project-b";
    for (const role of ["appServiceId", "graphitiServiceId", "postgresServiceId", "neo4jServiceId"] as const) {
      separate.production[role] = `${separate.production[role]}-b`;
    }
    expect(preflightStagingTopology(separate)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["repository default", (x: StagingTopology) => (x.repositoryDefaultBranch = "main")],
    ["staging source", (x: StagingTopology) => (x.staging.appSourceBranch = "main")],
    ["production source", (x: StagingTopology) => (x.production.appSourceBranch = "staging")],
    // The identity that must differ is the ENVIRONMENT: one environment holding both sides is the
    // topology where staging and production genuinely share a database.
    ["shared environment", (x: StagingTopology) => (x.staging.environmentId = x.production.environmentId)],
    // Role aliasing inside ONE environment. Not implied by the environment check: both sides can
    // have distinct environments while a side pins two incompatible roles to one instance, which
    // means at least one of them is not the service the preflight believes it is.
    ["Postgres aliased to Neo4j", (x: StagingTopology) => (x.staging.neo4jServiceId = x.staging.postgresServiceId)],
    ["app aliased to Graphiti", (x: StagingTopology) => (x.production.graphitiServiceId = x.production.appServiceId)],
    ["missing staging environment", (x: StagingTopology) => (x.staging.environmentId = "")],
    ["missing production project", (x: StagingTopology) => (x.production.projectId = "")],
    ["public target host", (x: StagingTopology) => (x.staging.neo4jHost = "neo4j.example.com")],
    ["wrong variable reference", (x: StagingTopology) => (x.staging.variableReferences.DATABASE_URL = "postgres://literal")],
  ])("refuses %s drift without echoing connection strings", (_name, mutate) => {
    const fixture = structuredClone(GOOD);
    mutate(fixture);
    const result = preflightStagingTopology(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).not.toContain("postgres://literal");
  });

  it("compares the whole instance tuple, so an aliasing report names both roles", () => {
    const fixture = structuredClone(GOOD);
    fixture.staging.neo4jServiceId = fixture.staging.postgresServiceId;
    const { errors } = preflightStagingTopology(fixture);
    expect(errors).toContain("staging postgresServiceId and neo4jServiceId resolve to the same service instance");
    // ...and it does NOT complain about the production side, whose identical global IDs are fine.
    expect(errors.filter((e: string) => e.startsWith("production"))).toEqual([]);
  });
});

describe("the topology check has a caller, and an unsupplied check is not a passed one", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  const withFile = (topology: unknown) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "staging-topology-"));
    roots.push(root);
    const file = path.join(root, "topology.json");
    writeFileSync(file, JSON.stringify(topology));
    return file;
  };

  it("verifies a supplied facts document, reading no variable values and calling no provider", () => {
    const file = withFile(GOOD);
    expect(verifyConfiguredTopology({ STAGING_TOPOLOGY_FILE: file } as NodeJS.ProcessEnv))
      .toEqual({ status: "verified", file });
  });

  it("reports NOT SUPPLIED rather than silently passing when nothing is configured", () => {
    expect(verifyConfiguredTopology({} as NodeJS.ProcessEnv).status).toBe("not-supplied");
  });

  it("refuses a supplied document that drifts", () => {
    const drifted = structuredClone(GOOD);
    drifted.staging.appSourceBranch = "main";
    expect(() => verifyConfiguredTopology({ STAGING_TOPOLOGY_FILE: withFile(drifted) } as NodeJS.ProcessEnv))
      .toThrow(/staging topology preflight refused/);
  });
});
