#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const token = process.env.LOCAL_MAINTENANCE_TOKEN;
const environmentId = process.env.STAGING_OPS_ENVIRONMENT_ID ?? "staging-local";
const appServiceId = process.env.STAGING_APP_SERVICE_ID ?? "app-local";
const graphitiServiceId = process.env.STAGING_GRAPHITI_SERVICE_ID ?? "graphiti-local";
const runnerServiceId = process.env.STAGING_IMPORTER_SERVICE_ID ?? "importer-local";
const imageDigest = process.env.STAGING_IMPORTER_IMAGE_DIGEST;
const initialCommit = process.env.LOCAL_INITIAL_COMMIT ?? "0".repeat(40);
let branchHead = process.env.LOCAL_STAGING_HEAD ?? initialCommit;
let runtimeMode = process.env.LOCAL_INITIAL_DATA_MODE ?? "legacy-pg-only";
if (!token || !imageDigest) throw new Error("local maintenance token and importer image digest are required");
const deployments = new Map();

function spawnDeployment(serviceId, commitSha = null, { mode = "copy-ready" } = {}) {
  const id = randomUUID();
  const command = serviceId === appServiceId
    ? JSON.parse(process.env.LOCAL_APP_COMMAND_JSON ?? `["${process.execPath}","-e","setInterval(() => {}, 1000)"]`)
    : [process.execPath, "-e", "setInterval(() => {}, 1000)"];
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, STAGING_DATA_MODE: mode, RAILWAY_GIT_COMMIT_SHA: commitSha ?? "" } });
  const deployment = { id, serviceId, environmentId, status: "DEPLOYING", meta: { commitHash: commitSha, createdAt: new Date().toISOString() }, child };
  child.once("spawn", () => { deployment.status = "SUCCESS"; });
  child.once("exit", (code) => { deployment.status = code === 0 || child.killed ? "REMOVED" : "CRASHED"; }); deployments.set(id, deployment); return deployment;
}
spawnDeployment(appServiceId, initialCommit, { mode: runtimeMode });
spawnDeployment(graphitiServiceId);

function json(res, status, value) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function stopChild(deployment) {
  if (deployment.child.exitCode != null) return;
  const exited = new Promise((resolve) => deployment.child.once("exit", resolve));
  deployment.child.kill("SIGTERM");
  await exited;
}
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}` && req.url !== "/api/health") return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://local");
  if (url.pathname === "/identity") return json(res, 200, { environmentId });
  if (url.pathname === "/branch-head" && req.method === "GET") return json(res, 200, { commit: branchHead });
  if (url.pathname === "/branch-head" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (!/^[0-9a-f]{40}$/i.test(body.commit)) return json(res, 400, { error: "invalid branch head" });
    branchHead = body.commit; return json(res, 200, { commit: branchHead });
  }
  if (url.pathname === "/runtime-mode" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (!new Set(["legacy-pg-only", "copy-ready"]).has(body.mode)) return json(res, 400, { error: "invalid runtime mode" });
    runtimeMode = body.mode; return json(res, 200, { mode: runtimeMode });
  }
  if (url.pathname === "/inject-deployment" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (body.serviceId !== appServiceId && body.serviceId !== graphitiServiceId) return json(res, 400, { error: "service is not pinned" });
    return json(res, 200, { id: spawnDeployment(body.serviceId, body.commitSha ?? null).id });
  }
  if (url.pathname === `/services/${runnerServiceId}`) return json(res, 200, { serviceId: runnerServiceId, imageDigest, branch: null, automaticDeployments: false });
  if (url.pathname === "/deployments") return json(res, 200, { deployments: [...deployments.values()].filter((d) => d.serviceId === url.searchParams.get("serviceId") && d.child.exitCode == null).map(({ child: _child, ...d }) => d) });
  const dep = url.pathname.match(/^\/deployments\/([^/]+)(?:\/(stop))?$/);
  if (dep) {
    const deployment = deployments.get(dep[1]); if (!deployment) return json(res, 404, { error: "missing" });
    if (dep[2] && req.method === "POST") await stopChild(deployment);
    const { child: _child, ...body } = deployment; return json(res, 200, body);
  }
  if (url.pathname === "/deploy" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (body.serviceId !== appServiceId || !/^[0-9a-f]{40}$/i.test(body.commitSha)) return json(res, 400, { error: "invalid deploy" });
    for (const deployment of deployments.values()) if (deployment.serviceId === appServiceId) await stopChild(deployment);
    return json(res, 200, { id: spawnDeployment(appServiceId, body.commitSha, { mode: runtimeMode }).id });
  }
  if (url.pathname === "/api/health") {
    const app = [...deployments.values()].find((d) => d.serviceId === appServiceId && d.child.exitCode == null);
    return app ? json(res, 202, { ok: false, booted: true, commit: app.meta.commitHash }) : json(res, 503, { ok: false });
  }
  return json(res, 404, { error: "not found" });
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
function stop() { for (const deployment of deployments.values()) if (deployment.child.exitCode == null) deployment.child.kill("SIGTERM"); server.close(); }
process.once("SIGTERM", stop); process.once("SIGINT", stop);
