import { describe, expect, it } from "vitest";
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
