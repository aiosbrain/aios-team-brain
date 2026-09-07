import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyConfiguredTopology } from "../scripts/staging-ops/importer.mjs";
import {
  preflightStagingTopology,
  type StagingTopology,
} from "../scripts/staging-ops/config.mjs";

const GOOD: StagingTopology = {
  repositoryDefaultBranch: "staging",
  contributionBranch: "staging",
  staging: {
    projectId: "project-a",
    environmentId: "environment-staging",
    appServiceId: "app-staging",
    graphitiServiceId: "graphiti-staging",
    postgresServiceId: "postgres-staging",
    neo4jServiceId: "neo4j-staging",
    appSourceBranch: "staging",
    postgresHost: "postgres-staging.railway.internal",
    neo4jHost: "neo4j-staging.railway.internal",
    variableReferences: {
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687",
    },
  },
  production: {
    projectId: "project-a",
    environmentId: "environment-production",
    appServiceId: "app-production",
    graphitiServiceId: "graphiti-production",
    postgresServiceId: "postgres-production",
    neo4jServiceId: "neo4j-production",
    appSourceBranch: "main",
    postgresHost: "postgres-production.railway.internal",
    neo4jHost: "neo4j-production.railway.internal",
    variableReferences: {
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      NEO4J_URL: "bolt://${{neo4j.RAILWAY_PRIVATE_DOMAIN}}:7687",
    },
  },
};

describe("staging topology preflight", () => {
  it("accepts the exact staging/main binding with distinct services and internal hosts", () => {
    expect(preflightStagingTopology(GOOD)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["repository default", (x: StagingTopology) => (x.repositoryDefaultBranch = "main")],
    ["staging source", (x: StagingTopology) => (x.staging.appSourceBranch = "main")],
    ["production source", (x: StagingTopology) => (x.production.appSourceBranch = "staging")],
    ["shared Postgres", (x: StagingTopology) => (x.staging.postgresServiceId = x.production.postgresServiceId)],
    ["shared Neo4j", (x: StagingTopology) => (x.staging.neo4jServiceId = x.production.neo4jServiceId)],
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
