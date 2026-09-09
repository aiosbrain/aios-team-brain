import { emitReceipt } from "./receipts.mjs";
import { isNonRetryableRefusal, nonRetryableRefusal } from "./maintenance-refusal.mjs";

/**
 * WHICH request, and for HOW LONG. Runtime 4 reported "bootstrap timed out" without naming the
 * operation: maintenance calls carry a 10-second timeout, object-store requests have their own
 * deadlines, and the health poll swallows fetch timeouts — so the message was consistent with at
 * least three different failures. This records the PATH and the DURATION of every maintenance call
 * that fails or runs long, and nothing else: no bodies, no headers, no token, no arguments.
 *
 * `emitReceipt` refuses credential-shaped fields, so this cannot become a leak by accident.
 */
const SLOW_CALL_MS = 1_000;

/** Local acceptance adapter. It queries a controller that owns and measures real child processes. */
export class LocalMaintenance {
  constructor({ baseUrl, token, environmentId, appServiceId, graphitiServiceId, fetchImpl = fetch }) {
    for (const [name, value] of Object.entries({ baseUrl, token, environmentId, appServiceId, graphitiServiceId })) if (!String(value ?? "").trim()) throw new Error(`${name} is required`);
    this.baseUrl = baseUrl; this.token = token; this.environmentId = environmentId; this.appServiceId = appServiceId; this.graphitiServiceId = graphitiServiceId; this.fetch = fetchImpl;
  }
  async call(path, init = {}) {
    // The PATH ONLY — never the URL, which carries the base host, and never the init, which carries
    // the body. A query string is dropped for the same reason.
    const route = String(path).split("?")[0];
    const started = Date.now();
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), { ...init, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      const durationMs = Date.now() - started;
      if (!response.ok) {
        emitReceipt("maintenance-call", { route, method: init.method ?? "GET", status: response.status, durationMs, outcome: "refused" });
        throw new Error(`local maintenance refused (${response.status}) on ${route} after ${durationMs}ms`);
      }
      if (durationMs >= SLOW_CALL_MS) emitReceipt("maintenance-call", { route, method: init.method ?? "GET", status: response.status, durationMs, outcome: "slow" });
      return body;
    } catch (error) {
      const durationMs = Date.now() - started;
      // A timeout and a refusal are different failures and used to read identically upstream. The
      // name (`TimeoutError`/`AbortError`) is the discriminator, and it is not sensitive.
      if (!(error instanceof Error) || !error.message.startsWith("local maintenance refused")) {
        emitReceipt("maintenance-call", { route, method: init.method ?? "GET", status: null, durationMs, outcome: "failed", errorName: error?.name ?? "Error" });
        throw new Error(`local maintenance call to ${route} failed after ${durationMs}ms (${error?.name ?? "Error"})`, { cause: error });
      }
      throw error;
    }
  }
  async preflight() { const identity = await this.call("/identity"); if (identity.environmentId !== this.environmentId) throw new Error("local controller environment mismatch"); return true; }
  async tokenIdentity() { await this.preflight(); return { projectId: "local", environmentId: this.environmentId }; }
  assertPinnedService(serviceId) { if (serviceId !== this.appServiceId && serviceId !== this.graphitiServiceId) throw nonRetryableRefusal("local maintenance service is outside the pinned allowlist"); }
  async listActiveDeployments(serviceId) { this.assertPinnedService(serviceId); return (await this.call(`/deployments?serviceId=${encodeURIComponent(serviceId)}`)).deployments; }
  async readDeployment(id) { const deployment = await this.call(`/deployments/${encodeURIComponent(id)}`); this.assertPinnedService(deployment.serviceId); return deployment; }
  async readStagingHead() { const body = await this.call("/branch-head"); if (!FULL_SHA.test(body.commit)) throw new Error("local controller returned an invalid staging head"); return body.commit; }
  async stopDeployment({ deploymentId, serviceId }) { this.assertPinnedService(serviceId); return this.call(`/deployments/${encodeURIComponent(deploymentId)}/stop`, { method: "POST" }); }
  /**
   * A FAILED STOP REQUEST IS NOT AN OUTCOME — see `maintenance-refusal.mjs`.
   *
   * The controller answers `409 stop-unverified` while containment is still finishing, and this loop
   * used to let that throw escape on the FIRST attempt, ending the whole refresh, even though it
   * re-lists and re-requests every `pollMs` inside its own bounded deadline and the very next pass
   * would have observed the workload gone (measured: 7,049 ms into the initial bootstrap stop).
   *
   * The success condition is UNCHANGED and is still the listing: `active.length === 0`. Absorbing a
   * request failure cannot manufacture a stop, only give the next poll a chance to observe one.
   */
  async stopAndVerifyAll({ timeoutMs = 30_000, pollMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    const deadline = Date.now() + timeoutMs; const observed = new Set();
    let attempts = 0;
    let lastStopFailure = null;
    while (Date.now() <= deadline) {
      const active = (await Promise.all([this.listActiveDeployments(this.appServiceId), this.listActiveDeployments(this.graphitiServiceId)])).flat();
      if (!active.length) return { environmentId: this.environmentId, services: [this.appServiceId, this.graphitiServiceId], stopped: true, observedDeploymentIds: [...observed].sort(), measuredAt: new Date().toISOString() };
      for (const deployment of active) {
        observed.add(deployment.id);
        attempts += 1;
        try {
          await this.stopDeployment({ deploymentId: deployment.id, serviceId: deployment.serviceId });
          lastStopFailure = null;
        } catch (error) {
          // Identity/state refusals cannot become false by waiting; surface them immediately.
          if (isNonRetryableRefusal(error)) throw error;
          lastStopFailure = error;
          emitReceipt("stop-request-retrying", {
            deploymentId: deployment.id, serviceId: deployment.serviceId, attempts,
            reason: String(error?.message ?? error).slice(0, 160),
          });
        }
      }
      await sleep(pollMs);
    }
    // The timeout still names the last request failure, so a deadline reached because every stop was
    // refused does not read as "the children simply took too long".
    throw new Error(`local app/Graphiti child processes did not stop within the bounded deadline${lastStopFailure ? `; last stop request failed: ${String(lastStopFailure.message ?? lastStopFailure).slice(0, 160)}` : ""}`);
  }
  async deployApp(commitSha) { if (!FULL_SHA.test(commitSha)) throw new Error("local app deployment requires an exact commit"); return (await this.call("/deploy", { method: "POST", body: JSON.stringify({ serviceId: this.appServiceId, commitSha }) })).id; }
  async assertPinnedRunnerConfiguration(serviceId, digest) { const config = await this.call(`/services/${encodeURIComponent(serviceId)}`); if (config.imageDigest !== digest || config.branch != null || config.automaticDeployments !== false) throw new Error("local runner configuration is not immutable"); return config; }
}
const FULL_SHA = /^[0-9a-f]{40}$/i;
