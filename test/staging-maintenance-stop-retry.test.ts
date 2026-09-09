/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { LocalMaintenance } from "../scripts/staging-ops/local-maintenance.mjs";
import { DOCUMENTS, RAILWAY_OPERATIONS, RailwayMaintenance } from "../scripts/staging-ops/railway-maintenance.mjs";

/**
 * A SEQUENTIAL 409 MUST NOT END THE REFRESH.
 *
 * Measured in the paired CI run: the initial bootstrap stop returned `409 stop-unverified` after
 * 7,049 ms — the controller refuses to report a stop it cannot verify, which is correct — and the
 * request threw straight out of `stopAndVerifyAll`. That loop re-lists and re-requests every
 * `pollMs` inside its own bounded deadline, so the very next pass would have observed the workload
 * gone; instead one transient refusal failed the whole operation, before capture.
 *
 * These rows pin three distinct properties, because a single "it eventually succeeds" test would be
 * satisfied by a loop that ignored errors entirely:
 *   1. a 409 followed by a success is retried and the operation completes;
 *   2. a 409 that NEVER clears still fails — at the deadline, naming the last request failure, so a
 *      permanently refused stop cannot be read as "the children just took a while";
 *   3. an identity refusal (a service outside the pinned allowlist) is surfaced IMMEDIATELY and is
 *      never retried, because it cannot become false by waiting.
 *
 * The success condition itself is untouched: the LISTING is the sole arbiter of "stopped", so
 * absorbing a failed request cannot manufacture a stop.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const localConfig = {
  baseUrl: "http://127.0.0.1:59999/",
  token: "maintenance-token",
  environmentId: "staging-env",
  appServiceId: "app-service",
  graphitiServiceId: "graph-service",
};

/**
 * A controller that answers the stop with a scripted sequence of statuses and only goes quiet once a
 * stop has actually succeeded — so "the listing came back empty" is caused by the successful stop
 * and not by the fixture being helpful.
 */
function localController({ stopStatuses, serviceId = "app-service" }: { stopStatuses: number[]; serviceId?: string }) {
  let stopped = false;
  const routes: string[] = [];
  const fetchImpl = vi.fn(async (url: URL, init: any) => {
    routes.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/deployments") {
      const asked = url.searchParams.get("serviceId");
      const deployments = asked === "app-service" && !stopped ? [{ id: "d1", serviceId, status: "SUCCESS" }] : [];
      return json(200, { deployments });
    }
    if (/^\/deployments\/[^/]+\/stop$/.test(url.pathname)) {
      const status = stopStatuses.length > 1 ? stopStatuses.shift()! : stopStatuses[0];
      if (status === 200) stopped = true;
      return json(status, status === 200 ? { id: "d1", serviceId, status: "REMOVED" } : { error: "stop-unverified" });
    }
    return json(404, { error: `unexpected route ${url.pathname}` });
  });
  return { fetchImpl, stopAttempts: () => routes.filter((route) => route.endsWith("/stop")).length };
}

describe("local controller — a refused stop request is retried within the bounded deadline", () => {
  it("completes when a 409 is followed by a successful stop", async () => {
    const controller = localController({ stopStatuses: [409, 200] });
    const maintenance = new LocalMaintenance({ ...localConfig, fetchImpl: controller.fetchImpl });

    await expect(maintenance.stopAndVerifyAll({ pollMs: 0, sleep: async () => {} }))
      .resolves.toMatchObject({ stopped: true, observedDeploymentIds: ["d1"] });

    // Exactly the retry: the first attempt was refused, the second was made and accepted.
    expect(controller.stopAttempts()).toBe(2);
  });

  it("still fails at the deadline when the 409 never clears, and names the last request failure", async () => {
    // The inverse. Without this row, "retry" would be indistinguishable from "ignore the error and
    // eventually claim success".
    const controller = localController({ stopStatuses: [409] });
    const maintenance = new LocalMaintenance({ ...localConfig, fetchImpl: controller.fetchImpl });

    await expect(maintenance.stopAndVerifyAll({ timeoutMs: 60, pollMs: 10 }))
      .rejects.toThrow(/did not stop within the bounded deadline; last stop request failed:.*409/);
    expect(controller.stopAttempts()).toBeGreaterThan(1);
  });

  it("surfaces an unpinned-service refusal immediately, without requesting any stop", async () => {
    // Non-retryable: this is a statement about identity, not timing. Retrying it to the deadline
    // would replace a correct fast refusal with a hang and a worse message.
    const controller = localController({ stopStatuses: [200], serviceId: "someone-elses-service" });
    const maintenance = new LocalMaintenance({ ...localConfig, fetchImpl: controller.fetchImpl });

    await expect(maintenance.stopAndVerifyAll({ timeoutMs: 5_000, pollMs: 10 }))
      .rejects.toThrow(/outside the pinned allowlist/);
    expect(controller.stopAttempts(), "an unpinned deployment was asked to stop").toBe(0);
  });
});

/** The same three properties through the Railway adapter, whose stop is a GraphQL mutation. */
function railwayApi({ stopStatuses, serviceId = "app-service" }: { stopStatuses: number[]; serviceId?: string }) {
  let stopped = false;
  let stopAttempts = 0;
  const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
    const { query, variables } = JSON.parse(String(init.body));
    if (query === DOCUMENTS.preflight) {
      return json(200, {
        data: {
          projectToken: { projectId: "project", environmentId: "staging-env" },
          __type: { fields: RAILWAY_OPERATIONS.map((name: string) => ({ name })) },
        },
      });
    }
    if (query === DOCUMENTS.deployments) {
      const asked = variables?.input?.serviceId;
      const nodes = asked === "app-service" && !stopped
        ? [{ id: "d1", serviceId, environmentId: "staging-env", status: "SUCCESS", createdAt: "2026-09-07T00:00:00Z", meta: {} }]
        : [];
      return json(200, { data: { deployments: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query === DOCUMENTS.deploymentStop) {
      stopAttempts += 1;
      const status = stopStatuses.length > 1 ? stopStatuses.shift()! : stopStatuses[0];
      if (status !== 200) return json(status, { errors: [{ message: "stop-unverified" }] });
      stopped = true;
      return json(200, { data: { deploymentStop: true } });
    }
    if (query === DOCUMENTS.deployment) {
      return json(200, { data: { deployment: { id: variables.id, serviceId, environmentId: "staging-env", status: "REMOVED", meta: {} } } });
    }
    return json(500, { errors: [{ message: `unexpected document` }] });
  });
  return { fetchImpl, stopAttempts: () => stopAttempts };
}

const railwayConfig = {
  projectId: "project",
  environmentId: "staging-env",
  appServiceId: "app-service",
  graphitiServiceId: "graph-service",
  token: "project-token",
};

describe("Railway adapter — the same bounded retry", () => {
  it("completes when a 409 is followed by a successful stop", async () => {
    const api = railwayApi({ stopStatuses: [409, 200] });
    const maintenance = new RailwayMaintenance({ ...railwayConfig, fetchImpl: api.fetchImpl });

    await expect(maintenance.stopAndVerifyAll({ pollMs: 0, sleep: async () => {} }))
      .resolves.toMatchObject({ stopped: true, observedDeploymentIds: ["d1"] });
    expect(api.stopAttempts()).toBe(2);
  });

  it("still fails at the deadline when the 409 never clears, and names the last request failure", async () => {
    const api = railwayApi({ stopStatuses: [409] });
    const maintenance = new RailwayMaintenance({ ...railwayConfig, fetchImpl: api.fetchImpl });

    await expect(maintenance.stopAndVerifyAll({ timeoutMs: 60, pollMs: 10 }))
      .rejects.toThrow(/stopped within the bounded deadline; last stop request failed:.*409/);
    expect(api.stopAttempts()).toBeGreaterThan(1);
  });

  it("surfaces a status with no safe stop transition immediately", async () => {
    // `REMOVING` is poll-only and is never asked to stop, so the non-retryable case here is a status
    // the adapter refuses to transition at all.
    const api = railwayApi({ stopStatuses: [200] });
    const maintenance = new RailwayMaintenance({ ...railwayConfig, fetchImpl: api.fetchImpl });

    await expect(maintenance.stopDeployment({ deploymentId: "d1", serviceId: "app-service", status: "UNKNOWNISH" }))
      .rejects.toThrow(/has no safe stop transition/);
    expect(api.stopAttempts()).toBe(0);
  });
});
