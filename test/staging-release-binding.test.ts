import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeDeploymentOrigin,
  observeProductionDeployment,
  probePinnedHealth,
  probeProductionHealth,
  readLatestProductionDeployment,
  readRailwayDeployment,
} from "../scripts/staging-ops/release-controller.mjs";

const SHA = "a".repeat(40);
const railway = (deployment: unknown) => vi.fn(async () => Response.json({ data: { deployment } }));

describe("M3 — Railway's staticUrl is a bare hostname", () => {
  it("normalises a bare host to an https origin", () => {
    expect(normalizeDeploymentOrigin("aios-staging.up.railway.app")).toBe("https://aios-staging.up.railway.app");
  });

  it("accepts an already-absolute https origin", () => {
    expect(normalizeDeploymentOrigin("https://aios-staging.up.railway.app")).toBe("https://aios-staging.up.railway.app");
  });

  it.each([
    ["nothing", ""],
    ["a scheme that is not https", "http://aios-staging.up.railway.app"],
    ["credentials", "https://user:pass@aios-staging.up.railway.app"],
    ["a path", "https://aios-staging.up.railway.app/app"],
    ["a value that is not a host", "not a host"],
  ])("returns null for %s", (_label, value) => {
    expect(normalizeDeploymentOrigin(value)).toBeNull();
  });
});

describe("M3 — candidate deployment evidence is bound to the pinned service and environment", () => {
  const pinned = { deploymentId: "dep-1", token: "t", environmentId: "env-staging", serviceId: "svc-app" };

  it("accepts a deployment in the pinned environment and service", async () => {
    const fetchImpl = railway({ id: "dep-1", status: "SUCCESS", staticUrl: "staging.up.railway.app", environmentId: "env-staging", serviceId: "svc-app", meta: { commitHash: SHA } });
    await expect(readRailwayDeployment({ ...pinned, fetchImpl })).resolves.toEqual({
      id: "dep-1", status: "SUCCESS", url: "https://staging.up.railway.app", commitSha: SHA,
    });
  });

  it("refuses a deployment of another service that happens to carry the same commit", async () => {
    // Without this, "Railway reports a successful deployment of this commit" is satisfied by any
    // service in the account — which is precisely the binding AC-02 exists to make.
    const fetchImpl = railway({ id: "dep-1", status: "SUCCESS", staticUrl: "x.up.railway.app", environmentId: "env-staging", serviceId: "svc-other", meta: { commitHash: SHA } });
    await expect(readRailwayDeployment({ ...pinned, fetchImpl })).rejects.toThrow(/different Railway service/);
  });

  it("refuses a deployment in another environment", async () => {
    const fetchImpl = railway({ id: "dep-1", status: "SUCCESS", staticUrl: "x.up.railway.app", environmentId: "env-production", serviceId: "svc-app", meta: { commitHash: SHA } });
    await expect(readRailwayDeployment({ ...pinned, fetchImpl })).rejects.toThrow(/different Railway environment/);
  });

  it("refuses to read at all without the pinned identity to bind against", async () => {
    await expect(readRailwayDeployment({ deploymentId: "dep-1", token: "t", fetchImpl: vi.fn() }))
      .rejects.toThrow(/pinned staging environment and service IDs are required/);
  });

  it("asks Railway for the binding fields, not just the status", async () => {
    const fetchImpl = railway({ id: "dep-1", status: "SUCCESS", staticUrl: "x.up.railway.app", environmentId: "env-staging", serviceId: "svc-app", meta: {} });
    await readRailwayDeployment({ ...pinned, fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.query).toContain("serviceId");
    expect(body.query).toContain("environmentId");
  });

  it("authenticates the candidate read with Project-Access-Token and no Authorization header", async () => {
    // M2. `RAILWAY_STAGING_READ_TOKEN` is documented in `config/staging-ops/importer.example.env` as
    // an ENVIRONMENT-SCOPED PROJECT token, and that is the header a project token authenticates
    // with. Presented as a Bearer account credential it simply fails to authenticate, and the error
    // reads as "the platform is configured differently than you think" rather than "this client sent
    // the wrong header" — which is why this asserts the ACTUAL request, not the intent.
    const fetchImpl = railway({ id: "dep-1", status: "SUCCESS", staticUrl: "x.up.railway.app", environmentId: "env-staging", serviceId: "svc-app", meta: { commitHash: SHA } });
    await readRailwayDeployment({ ...pinned, fetchImpl });
    const headers = (fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["Project-Access-Token"]).toBe("t");
    // Not merely "the right header is present": the WRONG one must be absent, or a client sending
    // both would satisfy the assertion above while still authenticating as an account credential.
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("authenticates the PRODUCTION reader with its own project token, on the same header kind", async () => {
    // M4. `RAILWAY_PRODUCTION_READ_TOKEN` is now DEFINED — an environment-scoped project token for
    // the production environment — so it authenticates the way every other Railway read here does.
    // While its kind was undefined this reader sent `Authorization: Bearer`, and a token provisioned
    // as the documented kind would have failed to authenticate: AC-03's post-promotion observation
    // could never verify, and every promotion would end `promoted-but-deployment-unverified` after
    // main had already moved.
    const fetchImpl = vi.fn(async () => Response.json({
      data: { deployments: { edges: [{ node: { id: "p1", status: "SUCCESS", staticUrl: "prod.up.railway.app", environmentId: "env-production", serviceId: "svc-app", meta: { commitHash: SHA } } }] } },
    }));
    await readLatestProductionDeployment({ environmentId: "env-production", serviceId: "svc-app", token: "prod-token", fetchImpl });
    const headers = (fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["Project-Access-Token"]).toBe("prod-token");
    // The wrong header must be ABSENT, not merely joined by the right one: a client sending both
    // still authenticates as an account credential wherever the platform prefers it.
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("keeps the two readers on SEPARATE secrets, so one token can never scope both environments", () => {
    // The isolation half of M4, and the reason "align the header" is not the same as "share a
    // token": the production observation and the staging candidate binding read different
    // environments and must hold different environment-scoped credentials. Asserted on the source
    // the controller actually reads, and on the workflow that supplies it.
    const controller = readFileSync("scripts/staging-ops/release-controller.mjs", "utf8");
    expect(controller).toContain("env.RAILWAY_PRODUCTION_READ_TOKEN");
    expect(controller).toContain("env.RAILWAY_STAGING_READ_TOKEN");
    const workflow = readFileSync(".github/workflows/release-controller.yml", "utf8");
    expect(workflow).toContain("RAILWAY_PRODUCTION_READ_TOKEN: ${{ secrets.RAILWAY_PRODUCTION_READ_TOKEN }}");
    expect(workflow).toContain("RAILWAY_STAGING_READ_TOKEN: ${{ secrets.RAILWAY_STAGING_READ_TOKEN }}");
    // …and the kind is written down where an operator provisions it, not only in a code comment.
    const example = readFileSync("config/staging-ops/importer.example.env", "utf8");
    expect(example).toMatch(/RAILWAY_PRODUCTION_READ_TOKEN/);
    expect(example).toMatch(/production[\s\S]{0,400}Project-Access-Token/i);
  });

  it("applies the same binding to the production observation", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      data: { deployments: { edges: [{ node: { id: "p1", status: "SUCCESS", staticUrl: "prod.up.railway.app", environmentId: "env-production", serviceId: "svc-other", meta: { commitHash: SHA } } }] } },
    }));
    await expect(readLatestProductionDeployment({ environmentId: "env-production", serviceId: "svc-app", token: "t", fetchImpl }))
      .rejects.toThrow(/outside the pinned environment\/service/);
  });
});

describe("production health is a DIFFERENT contract from privileged staging health", () => {
  it("sends no staging token to production", async () => {
    // `STAGING_HEALTH_TOKEN` is a staging environment secret. Sending a staging-shaped header to
    // production cannot authenticate anything; it can only turn a healthy deployment into a 401,
    // and through it report a good release as promoted-but-deployment-failed.
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, commit: SHA }, { status: 200 }));
    const health = await probeProductionHealth({ origin: "https://app.example.test", fetchImpl });
    expect(health).toMatchObject({ ok: true, commit: SHA, status: 200 });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({});
  });

  it("refuses to send a literal undefined as a staging health token", async () => {
    // `fetch` stringifies an unset variable into the header, which the app reads as a PRESENTED
    // token and answers 401 — a configuration mistake wearing the costume of an auth failure.
    await expect(probePinnedHealth({ origin: "https://staging.example.test", token: undefined, fetchImpl: vi.fn() }))
      .rejects.toThrow(/staging health token is required/);
  });

  it("still sends the staging token on the privileged staging probe", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, mode: "copy-ready", commit: SHA }, { status: 200 }));
    await probePinnedHealth({ origin: "https://staging.example.test", token: "t".repeat(32), fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers["x-aios-staging-health-token"]).toBe("t".repeat(32));
  });

  it("refuses an off-origin redirect on either contract", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302 }));
    await expect(probeProductionHealth({ origin: "https://app.example.test", fetchImpl: redirect })).rejects.toThrow(/redirected/);
    await expect(probePinnedHealth({ origin: "https://staging.example.test", token: "t".repeat(32), fetchImpl: redirect })).rejects.toThrow(/redirected/);
  });
});

describe("production observation reports separately and never undoes main", () => {
  const deployment = { id: "p1", status: "SUCCESS", url: "https://app.example.test", commitSha: SHA };

  it("verifies when the deployment and its health both name the promoted commit", async () => {
    const result = await observeProductionDeployment({
      expectedSha: SHA,
      readLatest: async () => deployment,
      probeHealth: async () => ({ status: 200, ok: true, commit: SHA }),
      timeoutMs: 50, intervalMs: 1, sleep: async () => {},
    });
    expect(result.status).toBe("verified");
  });

  it("reports UNVERIFIED — not failed — when the probe cannot be performed at all", async () => {
    const result = await observeProductionDeployment({
      expectedSha: SHA,
      readLatest: async () => deployment,
      probeHealth: async () => { throw new Error("no independently verified production domain was supplied"); },
      timeoutMs: 50, intervalMs: 1, sleep: async () => {},
    });
    expect(result.status).toBe("promoted-but-deployment-unverified");
    expect(result.health?.error).toMatch(/verified production domain/);
  });

  it("still reports FAILED when production answers with an error status", async () => {
    const result = await observeProductionDeployment({
      expectedSha: SHA,
      readLatest: async () => deployment,
      probeHealth: async () => ({ status: 503, ok: false }),
      timeoutMs: 50, intervalMs: 1, sleep: async () => {},
    });
    expect(result.status).toBe("promoted-but-deployment-failed");
  });
});
