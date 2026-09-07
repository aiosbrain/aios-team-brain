/** Local acceptance adapter. It queries a controller that owns and measures real child processes. */
export class LocalMaintenance {
  constructor({ baseUrl, token, environmentId, appServiceId, graphitiServiceId, fetchImpl = fetch }) {
    for (const [name, value] of Object.entries({ baseUrl, token, environmentId, appServiceId, graphitiServiceId })) if (!String(value ?? "").trim()) throw new Error(`${name} is required`);
    this.baseUrl = baseUrl; this.token = token; this.environmentId = environmentId; this.appServiceId = appServiceId; this.graphitiServiceId = graphitiServiceId; this.fetch = fetchImpl;
  }
  async call(path, init = {}) {
    const response = await this.fetch(new URL(path, this.baseUrl), { ...init, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
    const body = await response.json(); if (!response.ok) throw new Error(`local maintenance refused (${response.status})`); return body;
  }
  async preflight() { const identity = await this.call("/identity"); if (identity.environmentId !== this.environmentId) throw new Error("local controller environment mismatch"); return true; }
  async tokenIdentity() { await this.preflight(); return { projectId: "local", environmentId: this.environmentId }; }
  assertPinnedService(serviceId) { if (serviceId !== this.appServiceId && serviceId !== this.graphitiServiceId) throw new Error("local maintenance service is outside the pinned allowlist"); }
  async listActiveDeployments(serviceId) { this.assertPinnedService(serviceId); return (await this.call(`/deployments?serviceId=${encodeURIComponent(serviceId)}`)).deployments; }
  async readDeployment(id) { const deployment = await this.call(`/deployments/${encodeURIComponent(id)}`); this.assertPinnedService(deployment.serviceId); return deployment; }
  async readStagingHead() { const body = await this.call("/branch-head"); if (!FULL_SHA.test(body.commit)) throw new Error("local controller returned an invalid staging head"); return body.commit; }
  async stopDeployment({ deploymentId, serviceId }) { this.assertPinnedService(serviceId); return this.call(`/deployments/${encodeURIComponent(deploymentId)}/stop`, { method: "POST" }); }
  async stopAndVerifyAll({ timeoutMs = 30_000, pollMs = 100, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    const deadline = Date.now() + timeoutMs; const observed = new Set();
    while (Date.now() <= deadline) {
      const active = (await Promise.all([this.listActiveDeployments(this.appServiceId), this.listActiveDeployments(this.graphitiServiceId)])).flat();
      if (!active.length) return { environmentId: this.environmentId, services: [this.appServiceId, this.graphitiServiceId], stopped: true, observedDeploymentIds: [...observed].sort(), measuredAt: new Date().toISOString() };
      for (const deployment of active) { observed.add(deployment.id); await this.stopDeployment({ deploymentId: deployment.id, serviceId: deployment.serviceId }); }
      await sleep(pollMs);
    }
    throw new Error("local app/Graphiti child processes did not stop within the bounded deadline");
  }
  async deployApp(commitSha) { if (!FULL_SHA.test(commitSha)) throw new Error("local app deployment requires an exact commit"); return (await this.call("/deploy", { method: "POST", body: JSON.stringify({ serviceId: this.appServiceId, commitSha }) })).id; }
  async assertPinnedRunnerConfiguration(serviceId, digest) { const config = await this.call(`/services/${encodeURIComponent(serviceId)}`); if (config.imageDigest !== digest || config.branch != null || config.automaticDeployments !== false) throw new Error("local runner configuration is not immutable"); return config; }
}
const FULL_SHA = /^[0-9a-f]{40}$/i;
