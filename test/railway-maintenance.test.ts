/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_STATUSES,
  DOCUMENTS,
  RailwayMaintenance,
  RailwayRunnerInspector,
  RAILWAY_OPERATIONS,
  readAllDeployments,
} from "../scripts/staging-ops/railway-maintenance.mjs";

const config = {
  projectId: "project",
  environmentId: "staging-env",
  appServiceId: "app-service",
  graphitiServiceId: "graph-service",
};

function api(responses: any[]) {
  const calls: any[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: any) => {
    calls.push(init);
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
}

const schema = { fields: RAILWAY_OPERATIONS.map((name) => ({ name })) };
const preflight = (projectId = "project", environmentId = "staging-env") => ({
  data: { projectToken: { projectId, environmentId }, __type: schema },
});
const page = (nodes: any[], hasNextPage = false, endCursor: string | null = null) => ({ data: { deployments: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor } } } });
const dep = (id: string, serviceId: string, status: string, commit = "a".repeat(40)) => ({ id, serviceId, environmentId: "staging-env", status, createdAt: "2026-09-07T00:00:00Z", meta: { commitHash: commit } });

describe("staging-only Railway lifecycle adapter", () => {
  it("authenticates only as the exact environment-scoped project token", async () => {
    const fake = api([preflight()]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await maintenance.preflight();
    expect(fake.calls[0].headers).toMatchObject({ "Project-Access-Token": "secret" });
    expect(fake.calls[0].headers.Authorization).toBeUndefined();
  });

  it.each([
    [{ projectId: "other", environmentId: "staging-env" }, /project/i],
    [{ projectId: "project", environmentId: "production-env" }, /environment/i],
  ])("refuses a wrong token identity before lifecycle mutation", async (identity, message) => {
    const fake = api([{ data: { projectToken: identity, __type: schema } }]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await expect(maintenance.stopDeployment({ deploymentId: "dep", serviceId: "app-service", status: "SUCCESS" })).rejects.toThrow(message);
    expect(fake.calls).toHaveLength(1);
  });

  it("permits only pinned app/Graphiti services and the documented operation allowlist", async () => {
    expect(RAILWAY_OPERATIONS).toEqual(["deploymentStop", "deploymentCancel", "deploymentRestart", "serviceInstanceDeployV2"]);
    const fake = api([preflight()]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await expect(maintenance.stopDeployment({ deploymentId: "dep", serviceId: "postgres-service", status: "SUCCESS" })).rejects.toThrow(/pinned/i);
    expect(fake.calls).toHaveLength(1);
  });

  it("uses schema-valid source and auto-deploy fields and refuses unknown auto-deploy state", async () => {
    expect(DOCUMENTS.serviceInstance).not.toMatch(/automaticDeployments|source\s*\{[^}]*branch/);
    expect(DOCUMENTS.serviceInstance).toContain("serviceInstanceAutoDeployStatus");
    const good = api([preflight(), { data: { serviceInstance: { serviceId: "app-service", source: { image: `runner@sha256:${"a".repeat(64)}`, repo: null } }, serviceInstanceAutoDeployStatus: { enabled: false, canEnable: true, reason: null } } }]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: good.fetchImpl });
    await expect(maintenance.assertPinnedRunnerConfiguration("app-service", `sha256:${"a".repeat(64)}`)).resolves.toMatchObject({ automaticDeployments: false });
    const unknown = api([preflight(), { data: { serviceInstance: { serviceId: "app-service", source: { image: `runner@sha256:${"a".repeat(64)}`, repo: null } }, serviceInstanceAutoDeployStatus: null } }]);
    await expect(new RailwayMaintenance({ ...config, token: "secret", fetchImpl: unknown.fetchImpl }).assertPinnedRunnerConfiguration("app-service", `sha256:${"a".repeat(64)}`)).rejects.toThrow(/automatic/i);
  });

  it("classifies the complete measured deployment enum and paginates before declaring a stopped set", async () => {
    expect(DEPLOYMENT_STATUSES).toEqual(["BUILDING", "CRASHED", "DEPLOYING", "FAILED", "INITIALIZING", "NEEDS_APPROVAL", "QUEUED", "REMOVED", "REMOVING", "SKIPPED", "SLEEPING", "SUCCESS", "WAITING"]);
    const fake = api([preflight(), page([dep("old", "app-service", "REMOVED")], true, "cursor-1"), page([dep("live", "app-service", "SUCCESS")])]);
    const rows = await new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl }).listActiveDeployments("app-service");
    expect(rows.map((row: any) => row.id)).toEqual(["live"]);
    const vars = fake.calls.slice(1).map((call) => JSON.parse(call.body).variables);
    expect(vars).toEqual([
      { input: { projectId: "project", environmentId: "staging-env", serviceId: "app-service" }, after: null, first: 100 },
      { input: { projectId: "project", environmentId: "staging-env", serviceId: "app-service" }, after: "cursor-1", first: 100 },
    ]);
  });

  it.each([
    [page([dep("x", "app-service", "FUTURE")]), /unknown-status/],
    [page([dep("x", "graph-service", "SUCCESS")]), /cross-target/],
    [{ data: { deployments: { edges: [], pageInfo: null } } }, /malformed/],
    [page([], true, null), /cursor/],
  ])("fails closed on malformed deployment pagination %#", async (response, message) => {
    const fake = api([preflight(), response]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await expect(maintenance.listActiveDeployments("app-service")).rejects.toThrow(message);
  });

  it("refuses a repeated pagination cursor", async () => {
    const fake = api([preflight(), page([], true, "same"), page([], true, "same")]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await expect(maintenance.listActiveDeployments("app-service")).rejects.toThrow(/cursor/);
  });

  it("fails closed on page-two corruption and bounded page exhaustion", async () => {
    const corrupt = api([page([], true, "one"), { data: { deployments: null } }]);
    await expect(readAllDeployments({ call: async (...args: any[]) => {
      const response = await corrupt.fetchImpl("x", { body: JSON.stringify(args) }); return (await response.json()).data;
    }, projectId: "project", environmentId: "staging-env" }, "app-service", { maxPages: 2 })).rejects.toThrow(/malformed/);
    const endless = { projectId: "project", environmentId: "staging-env", call: vi.fn()
      .mockResolvedValueOnce(page([], true, "one").data)
      .mockResolvedValueOnce(page([], true, "two").data) };
    await expect(readAllDeployments(endless, "app-service", { maxPages: 2 })).rejects.toThrow(/bounded page limit/);
  });

  it("polls REMOVING without repeating a mutation and cancels NEEDS_APPROVAL", async () => {
    const removing = api([
      preflight(),
      page([dep("removing", "app-service", "REMOVING")]), page([]),
      page([]), page([]),
    ]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: removing.fetchImpl });
    await expect(maintenance.stopAndVerifyAll({ pollMs: 0, sleep: async () => {} })).resolves.toMatchObject({ stopped: true });
    expect(removing.calls.map((call) => JSON.parse(call.body).query).some((query) => query.includes("mutation StagingMaintenance"))).toBe(false);

    const approval = api([preflight(), { data: { deploymentCancel: true } }, { data: { deployment: dep("approval", "app-service", "REMOVED") } }]);
    await new RailwayMaintenance({ ...config, token: "secret", fetchImpl: approval.fetchImpl }).stopDeployment({ deploymentId: "approval", serviceId: "app-service", status: "NEEDS_APPROVAL" });
    expect(JSON.parse(approval.calls[1].body).query).toContain("deploymentCancel");
  });

  it("refuses ambiguous concurrently successful source commits after complete pagination", async () => {
    const fake = api([preflight(), page([dep("one", "source", "SUCCESS", "a".repeat(40)), dep("two", "source", "SUCCESS", "b".repeat(40))])]);
    const inspector = new RailwayRunnerInspector({ projectId: "project", environmentId: "staging-env", serviceId: "runner", token: "secret", fetchImpl: fake.fetchImpl });
    await expect(inspector.measureSuccessfulDeployment("source")).rejects.toThrow(/unambiguous/);
  });

  it("uses stop for running and cancel for building deployments, then requires stopped readback", async () => {
    const fake = api([
      preflight(),
      { data: { deploymentStop: true } },
      { data: { deployment: { id: "run", serviceId: "app-service", environmentId: "staging-env", status: "REMOVED", meta: {} } } },
      { data: { deploymentCancel: true } },
      { data: { deployment: { id: "build", serviceId: "graph-service", environmentId: "staging-env", status: "REMOVED", meta: {} } } },
    ]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await maintenance.stopDeployment({ deploymentId: "run", serviceId: "app-service", status: "SUCCESS" });
    await maintenance.stopDeployment({ deploymentId: "build", serviceId: "graph-service", status: "BUILDING" });
    const bodies = fake.calls.map((call) => JSON.parse(call.body).query);
    expect(bodies.some((q) => q.includes("deploymentStop"))).toBe(true);
    expect(bodies.some((q) => q.includes("deploymentCancel"))).toBe(true);
  });

  it("deploys only the pinned app service at an exact commit SHA", async () => {
    const fake = api([
      preflight(),
      { data: { serviceInstanceDeployV2: "new-deployment" } },
    ]);
    const maintenance = new RailwayMaintenance({ ...config, token: "secret", fetchImpl: fake.fetchImpl });
    await expect(maintenance.deployApp("short")).rejects.toThrow(/40-character/i);
    await expect(maintenance.deployApp("a".repeat(40))).resolves.toBe("new-deployment");
    const vars = JSON.parse(fake.calls.at(-1).body).variables;
    expect(vars).toEqual({ environmentId: "staging-env", serviceId: "app-service", commitSha: "a".repeat(40) });
  });
});
