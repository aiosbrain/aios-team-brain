/**
 * The sole Railway lifecycle API owner. It is unavailable to app code and accepts only an exact
 * environment-scoped project token plus two pinned staging services. No database service operation
 * or arbitrary GraphQL document is exposed.
 */
export const RAILWAY_OPERATIONS = Object.freeze([
  "deploymentStop",
  "deploymentCancel",
  "deploymentRestart",
  "serviceInstanceDeployV2",
]);

const API = "https://backboard.railway.com/graphql/v2";
const TERMINAL_STOPPED = new Set(["REMOVED", "SKIPPED", "FAILED", "CRASHED"]);
const CANCELABLE = new Set(["INITIALIZING", "WAITING", "QUEUED", "BUILDING", "DEPLOYING", "NEEDS_APPROVAL"]);
const STOPPABLE = new Set(["SUCCESS", "SLEEPING"]);
const POLL_ONLY = new Set(["REMOVING"]);
export const DEPLOYMENT_STATUSES = Object.freeze(["BUILDING", "CRASHED", "DEPLOYING", "FAILED", "INITIALIZING", "NEEDS_APPROVAL", "QUEUED", "REMOVED", "REMOVING", "SKIPPED", "SLEEPING", "SUCCESS", "WAITING"]);
const KNOWN_STATUS = new Set(DEPLOYMENT_STATUSES);

export const DOCUMENTS = Object.freeze({
  preflight: `query StagingMaintenancePreflight {
    projectToken { projectId environmentId }
    __type(name: "Mutation") { fields { name } }
  }`,
  deployment: `query StagingMaintenanceDeployment($id: String!) {
    deployment(id: $id) { id serviceId environmentId status meta }
  }`,
  deployments: `query StagingMaintenanceDeployments($input: DeploymentListInput!, $after: String, $first: Int!) {
    deployments(input: $input, after: $after, first: $first) {
      edges { node { id serviceId environmentId status createdAt meta } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  serviceInstance: `query StagingMaintenanceServiceInstance($projectId: String!, $environmentId: String!, $serviceId: String!) {
    serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
      serviceId source { image repo }
    }
    serviceInstanceAutoDeployStatus(environmentId: $environmentId, projectId: $projectId, serviceId: $serviceId) { enabled canEnable reason }
  }`,
  deploymentStop: `mutation StagingMaintenanceStop($id: String!) { deploymentStop(id: $id) }`,
  deploymentCancel: `mutation StagingMaintenanceCancel($id: String!) { deploymentCancel(id: $id) }`,
  deploymentRestart: `mutation StagingMaintenanceRestart($id: String!) { deploymentRestart(id: $id) }`,
  serviceInstanceDeployV2: `mutation StagingMaintenanceDeploy($environmentId: String!, $serviceId: String!, $commitSha: String!) {
    serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId, commitSha: $commitSha)
  }`,
});

function validateDeployment(row, { environmentId, serviceId }) {
  if (!row || typeof row.id !== "string" || row.environmentId !== environmentId || row.serviceId !== serviceId || !KNOWN_STATUS.has(row.status)) {
    throw new Error("Railway deployment enumeration returned malformed, unknown-status, or cross-target data");
  }
  return row;
}

export async function readAllDeployments(owner, serviceId, { maxPages = 20, pageSize = 100 } = {}) {
  const rows = []; let after = null; const cursors = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const data = await owner.call(DOCUMENTS.deployments, { input: { projectId: owner.projectId, environmentId: owner.environmentId, serviceId }, after, first: pageSize });
    const connection = data?.deployments;
    if (!connection || !Array.isArray(connection.edges) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== "boolean") throw new Error("Railway deployments pagination response is malformed");
    for (const edge of connection.edges) rows.push(validateDeployment(edge?.node, { environmentId: owner.environmentId, serviceId }));
    if (!connection.pageInfo.hasNextPage) return rows;
    const next = connection.pageInfo.endCursor;
    if (typeof next !== "string" || !next || next === after || cursors.has(next)) throw new Error("Railway deployments pagination cursor did not advance");
    cursors.add(next); after = next;
  }
  throw new Error("Railway deployments pagination exceeded its bounded page limit");
}

function assertPinnedRunnerFacts(data, serviceId, expectedImageDigest) {
  const instance = data?.serviceInstance;
  const autoDeploy = data?.serviceInstanceAutoDeployStatus;
  const image = String(instance?.source?.image ?? "");
  if (!instance || instance.serviceId !== serviceId || !image.endsWith(`@${expectedImageDigest}`) || instance.source?.repo) throw new Error("runner must use the pinned digest with no repository source");
  if (!autoDeploy || typeof autoDeploy.enabled !== "boolean" || autoDeploy.enabled !== false) throw new Error("runner automatic deployments must be read-back disabled");
  return { serviceId, imageDigest: expectedImageDigest, automaticDeployments: false };
}

export class RailwayRunnerInspector {
  constructor({ projectId, environmentId, serviceId, token, fetchImpl = fetch, apiUrl = API }) {
    for (const [name, value] of Object.entries({ projectId, environmentId, serviceId, token })) if (!String(value ?? "").trim()) throw new Error(`${name} is required`);
    this.projectId = projectId; this.environmentId = environmentId; this.serviceId = serviceId; this.token = token; this.fetch = fetchImpl; this.apiUrl = apiUrl; this.preflightPromise = null;
  }
  async call(document, variables = {}) {
    const response = await this.fetch(this.apiUrl, { method: "POST", redirect: "error", headers: { "Project-Access-Token": this.token, "Content-Type": "application/json" }, body: JSON.stringify({ query: document, variables }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    if (!response.ok || body?.errors?.length) throw new Error(`Railway runner inspection refused (${response.status})`);
    return body.data;
  }
  async preflight() {
    if (!this.preflightPromise) this.preflightPromise = this.call(DOCUMENTS.preflight).then((data) => {
      if (data?.projectToken?.projectId !== this.projectId || data?.projectToken?.environmentId !== this.environmentId) throw new Error("runner inspection token identity mismatch");
      return true;
    });
    return this.preflightPromise;
  }
  async assertPinned(expectedImageDigest) {
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(expectedImageDigest ?? ""))) throw new Error("immutable runner image digest is required");
    await this.preflight();
    const data = await this.call(DOCUMENTS.serviceInstance, { projectId: this.projectId, environmentId: this.environmentId, serviceId: this.serviceId });
    return { projectId: this.projectId, environmentId: this.environmentId, ...assertPinnedRunnerFacts(data, this.serviceId, expectedImageDigest) };
  }
  async measureSuccessfulDeployment(serviceId) {
    await this.preflight();
    const deployments = (await readAllDeployments(this, serviceId)).filter((row) => row.status === "SUCCESS");
    const commits = new Set(deployments.map((row) => row.meta?.commitHash ?? row.meta?.commitSha).filter(Boolean));
    if (commits.size !== 1) throw new Error("source application has no unambiguous currently serving commit identity");
    const current = deployments.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
    const commit = current?.meta?.commitHash ?? current?.meta?.commitSha;
    if (!current || !/^[0-9a-f]{40}$/i.test(String(commit ?? ""))) throw new Error("could not measure a successful source application deployment commit");
    return { deploymentId: current.id, commit, serviceId };
  }
}

export class RailwayMaintenance {
  constructor({ projectId, environmentId, appServiceId, graphitiServiceId, token, fetchImpl = fetch, apiUrl = API }) {
    for (const [name, value] of Object.entries({ projectId, environmentId, appServiceId, graphitiServiceId, token })) {
      if (!String(value ?? "").trim()) throw new Error(`${name} is required`);
    }
    this.projectId = projectId;
    this.environmentId = environmentId;
    this.appServiceId = appServiceId;
    this.graphitiServiceId = graphitiServiceId;
    this.token = token;
    this.fetch = fetchImpl;
    this.apiUrl = apiUrl;
    this.preflightPromise = null;
  }

  async call(document, variables = {}) {
    const response = await this.fetch(this.apiUrl, {
      method: "POST",
      redirect: "error",
      headers: { "Project-Access-Token": this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || body?.errors?.length) throw new Error(`Railway maintenance API refused (${response.status})`);
    return body.data;
  }

  async preflight() {
    if (!this.preflightPromise) this.preflightPromise = this.call(DOCUMENTS.preflight).then((data) => {
      const identity = data?.projectToken;
      if (identity?.projectId !== this.projectId) throw new Error("Railway project token belongs to the wrong project");
      if (identity?.environmentId !== this.environmentId) throw new Error("Railway project token belongs to the wrong environment");
      const fields = data?.__type?.fields;
      if (!Array.isArray(fields)) throw new Error("Railway mutation schema introspection returned no fields");
      const names = new Set(fields.map((field) => field.name));
      const missing = RAILWAY_OPERATIONS.filter((name) => !names.has(name));
      if (missing.length) throw new Error(`Railway mutation schema is incompatible: missing ${missing.join(", ")}`);
      return true;
    });
    return this.preflightPromise;
  }

  async tokenIdentity() {
    await this.preflight();
    return { projectId: this.projectId, environmentId: this.environmentId };
  }

  assertPinnedService(serviceId) {
    if (serviceId !== this.appServiceId && serviceId !== this.graphitiServiceId) {
      throw new Error("Railway maintenance operation refused for a service outside the pinned app/Graphiti allowlist");
    }
  }

  async readDeployment(id) {
    await this.preflight();
    const deployment = (await this.call(DOCUMENTS.deployment, { id }))?.deployment;
    if (!deployment || deployment.id !== id || deployment.environmentId !== this.environmentId || !KNOWN_STATUS.has(deployment.status)) throw new Error("Railway deployment readback identity/status mismatch");
    this.assertPinnedService(deployment.serviceId);
    return deployment;
  }

  async stopDeployment({ deploymentId, serviceId, status }) {
    await this.preflight();
    this.assertPinnedService(serviceId);
    if (POLL_ONLY.has(status)) return this.readDeployment(deploymentId);
    const operation = CANCELABLE.has(status) ? "deploymentCancel" : STOPPABLE.has(status) ? "deploymentStop" : null;
    if (!operation) throw new Error(`Railway deployment status ${String(status)} has no safe stop transition`);
    const data = await this.call(DOCUMENTS[operation], { id: deploymentId });
    if (data?.[operation] !== true) {
      // An unknown result is never retried blind: reconcile from readback first.
      const reconciled = await this.readDeployment(deploymentId);
      if (!TERMINAL_STOPPED.has(reconciled.status)) throw new Error(`${operation} returned an unknown result and readback is still ${reconciled.status}`);
      return reconciled;
    }
    const observed = await this.readDeployment(deploymentId);
    return observed;
  }

  async stopAndVerifyDeployments(deploymentIds) {
    if (!Array.isArray(deploymentIds) || deploymentIds.length < 1) throw new Error("exact staging deployment IDs are required");
    const stopped = [];
    for (const id of deploymentIds) {
      const before = await this.readDeployment(id);
      if (TERMINAL_STOPPED.has(before.status)) stopped.push(before);
      else stopped.push(await this.stopDeployment({ deploymentId: id, serviceId: before.serviceId, status: before.status }));
    }
    if (stopped.some((deployment) => !TERMINAL_STOPPED.has(deployment.status))) throw new Error("not all pinned staging deployments were read-back verified stopped");
    return stopped;
  }

  async listActiveDeployments(serviceId) {
    await this.preflight(); this.assertPinnedService(serviceId);
    const rows = await readAllDeployments(this, serviceId);
    return rows.filter((deployment) => !TERMINAL_STOPPED.has(deployment.status));
  }

  async stopAndVerifyAll({ timeoutMs = 120_000, pollMs = 1_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    const deadline = Date.now() + timeoutMs; const observed = new Set(); const requested = new Set();
    while (Date.now() <= deadline) {
      const active = (await Promise.all([this.listActiveDeployments(this.appServiceId), this.listActiveDeployments(this.graphitiServiceId)])).flat();
      if (active.length === 0) {
        return { environmentId: this.environmentId, services: [this.appServiceId, this.graphitiServiceId], stopped: true, observedDeploymentIds: [...observed].sort(), measuredAt: new Date().toISOString() };
      }
      for (const deployment of active) {
        observed.add(deployment.id);
        if (!requested.has(deployment.id) && !POLL_ONLY.has(deployment.status)) {
          await this.stopDeployment({ deploymentId: deployment.id, serviceId: deployment.serviceId, status: deployment.status });
          requested.add(deployment.id);
        }
      }
      await sleep(pollMs);
    }
    throw new Error("not all current app/Graphiti deployments stopped within the bounded deadline");
  }

  async assertPinnedRunnerConfiguration(serviceId, expectedImageDigest) {
    if (!serviceId || !/^sha256:[0-9a-f]{64}$/i.test(String(expectedImageDigest ?? ""))) throw new Error("runner service and immutable image digest are required");
    await this.preflight();
    const data = await this.call(DOCUMENTS.serviceInstance, { projectId: this.projectId, environmentId: this.environmentId, serviceId });
    return assertPinnedRunnerFacts(data, serviceId, expectedImageDigest);
  }

  async deployApp(commitSha) {
    await this.preflight();
    if (!/^[0-9a-f]{40}$/i.test(String(commitSha))) throw new Error("app deployment requires an exact 40-character commit SHA");
    const data = await this.call(DOCUMENTS.serviceInstanceDeployV2, {
      environmentId: this.environmentId,
      serviceId: this.appServiceId,
      commitSha,
    });
    const id = data?.serviceInstanceDeployV2;
    if (typeof id !== "string" || !id) throw new Error("Railway app deployment returned no deployment ID");
    return id;
  }

  async restartPinnedGraphiti({ deploymentId, recordedImageIdentity }) {
    if (!recordedImageIdentity) throw new Error("recorded Graphiti image/build identity is required");
    const before = await this.readDeployment(deploymentId);
    if (before.serviceId !== this.graphitiServiceId || before.meta?.imageDigest !== recordedImageIdentity) throw new Error("Graphiti deployment identity differs from the recorded immutable build");
    const data = await this.call(DOCUMENTS.deploymentRestart, { id: deploymentId });
    if (data?.deploymentRestart !== true) throw new Error("Graphiti restart returned an unknown result");
    return true;
  }
}
