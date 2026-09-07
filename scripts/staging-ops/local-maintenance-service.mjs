#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { emitReceipt } from "./receipts.mjs";

/**
 * CHILD-PROCESS LIFECYCLE DIAGNOSTICS (accepted scope, `runtime-fourth-adjudication.md`).
 *
 * Runtime 4 got past the connection termination and then timed out in bootstrap, with the recovery
 * child observed `CRASHED`. `CRASHED` here describes THIS controller's tracked child, not the Next
 * process or the container — and the controller recorded nothing else: no PID, no exit code, no
 * signal, no spawn error, and no evidence that a stop ever completed. The chain is
 * controller → startup fence → npm → Next, and `stopChild` signals only the immediate child and
 * then waits with no internal deadline, so a stalled stop and a surviving listener are both
 * consistent with what was observed. None of that is established; these receipts are what would
 * establish it.
 *
 * Identities only — deployment id, service id, PID, exit code, signal, durations. Never the command,
 * never its arguments, never the environment: the redactor's masking is not comprehensive for
 * arbitrary environment dumps, so none is produced.
 */

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
  const deployment = { id, serviceId, environmentId, status: "DEPLOYING", meta: { commitHash: commitSha, createdAt: new Date().toISOString() }, child, lifecycle: { pid: null, spawnedAt: null, exitCode: null, exitSignal: null, exitedAt: null, spawnError: null } };
  const startedAt = Date.now();
  child.once("spawn", () => {
    // `SUCCESS` is assigned ON SPAWN, not on application readiness — the adjudication called this
    // out, and the receipt says so in the same breath so nothing downstream reads it as "ready".
    deployment.status = "SUCCESS";
    deployment.lifecycle.pid = child.pid ?? null;
    deployment.lifecycle.spawnedAt = new Date().toISOString();
    emitReceipt("deployment-spawned", { deploymentId: id, serviceId, pid: child.pid ?? null, mode, statusMeans: "process spawned, NOT application readiness" });
  });
  child.once("error", (error) => {
    deployment.lifecycle.spawnError = error?.code ?? error?.name ?? "Error";
    emitReceipt("deployment-spawn-failed", { deploymentId: id, serviceId, errorCode: deployment.lifecycle.spawnError });
  });
  child.once("exit", (code, signal) => {
    deployment.status = code === 0 || child.killed ? "REMOVED" : "CRASHED";
    Object.assign(deployment.lifecycle, { exitCode: code, exitSignal: signal ?? null, exitedAt: new Date().toISOString() });
    emitReceipt("deployment-exited", {
      deploymentId: id, serviceId, pid: deployment.lifecycle.pid, status: deployment.status,
      exitCode: code, exitSignal: signal ?? null, killedByUs: Boolean(child.killed), lifetimeMs: Date.now() - startedAt,
    });
  });
  deployments.set(id, deployment); return deployment;
}
spawnDeployment(appServiceId, initialCommit, { mode: runtimeMode });
spawnDeployment(graphitiServiceId);

function json(res, status, value) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function stopChild(deployment) {
  if (deployment.child.exitCode != null) return;
  // DID THE STOP COMPLETE? The wait has no internal deadline, so a stop that never returns is
  // indistinguishable from one that returned instantly — which is exactly the ambiguity in the
  // runtime-4 evidence. The signal is unchanged and the wait is still unbounded (changing either
  // would be the speculative lifecycle fix this pass must not make); what is added is a record of
  // when it started, when it finished, and what the child did.
  const startedAt = Date.now();
  emitReceipt("deployment-stop-requested", { deploymentId: deployment.id, serviceId: deployment.serviceId, pid: deployment.child.pid ?? null, signal: "SIGTERM" });
  const exited = new Promise((resolve) => deployment.child.once("exit", (code, signal) => resolve({ code, signal })));
  deployment.child.kill("SIGTERM");
  const outcome = await exited;
  emitReceipt("deployment-stop-completed", {
    deploymentId: deployment.id, serviceId: deployment.serviceId, pid: deployment.lifecycle?.pid ?? null,
    exitCode: outcome?.code ?? null, exitSignal: outcome?.signal ?? null, durationMs: Date.now() - startedAt,
  });
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
