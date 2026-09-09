#!/usr/bin/env node
import { createServer } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { randomUUID } from "node:crypto";
import { emitReceipt } from "./receipts.mjs";
import { spawnOwnedWorkload } from "./owned-workload.mjs";

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
/** The address the supervised app binds. Read, never guessed, and never used to kill anything. */
const appPort = Number(process.env.LOCAL_APP_PORT ?? 3000);
let branchHead = process.env.LOCAL_STAGING_HEAD ?? initialCommit;
let runtimeMode = process.env.LOCAL_INITIAL_DATA_MODE ?? "legacy-pg-only";
if (!token || !imageDigest) throw new Error("local maintenance token and importer image digest are required");
const deployments = new Map();

/**
 * A deployment is ALIVE only while it has no terminal outcome. The previous test was
 * `child.exitCode == null`, which is still null for a SIGNAL-terminated child — so PID 18, which
 * had exited on SIGTERM, was listed as active, a second stop was requested for it, and that stop
 * waited 10,007 ms for an exit event that had already fired. `exitCode` alone can never answer this
 * question; a settled terminal outcome can.
 */
const isActive = (deployment) => deployment.workload.terminal() === null;

/** The wire shape: never the workload handle, never a command, never an environment. */
const publicView = ({ workload: _workload, ...rest }) => rest;

function spawnDeployment(serviceId, commitSha = null, { mode = "copy-ready" } = {}) {
  const id = randomUUID();
  const command = serviceId === appServiceId
    ? JSON.parse(process.env.LOCAL_APP_COMMAND_JSON ?? `["${process.execPath}","-e","setInterval(() => {}, 1000)"]`)
    : [process.execPath, "-e", "setInterval(() => {}, 1000)"];
  const startedAt = Date.now();
  const deployment = {
    id, serviceId, environmentId, status: "DEPLOYING",
    meta: { commitHash: commitSha, createdAt: new Date().toISOString() },
    lifecycle: { pid: null, pgid: null, spawnedAt: null, exitCode: null, exitSignal: null, exitedAt: null, spawnError: null, stopped: null, stopReason: null },
  };
  // Spawned into its OWN process group, so the whole chain (fence → npm → Next) can be stopped as a
  // unit. Killing the immediate child is what left a Next descendant holding :3000 and made the
  // replacement deployment fail with EADDRINUSE.
  const workload = spawnOwnedWorkload({
    command, label: `deployment:${serviceId}`,
    env: { ...process.env, STAGING_DATA_MODE: mode, RAILWAY_GIT_COMMIT_SHA: commitSha ?? "" },
  });
  deployment.workload = workload;
  deployment.lifecycle.pid = workload.pid;
  deployment.lifecycle.pgid = workload.pgid;

  workload.child.once("spawn", () => {
    // `SUCCESS` is assigned ON SPAWN, not on application readiness — the receipt says so in the
    // same breath so nothing downstream reads it as a health claim.
    deployment.status = "SUCCESS";
    deployment.lifecycle.spawnedAt = new Date().toISOString();
    emitReceipt("deployment-spawned", { deploymentId: id, serviceId, pid: workload.pid, pgid: workload.pgid, mode, statusMeans: "process spawned, NOT application readiness" });
  });

  // ONE settlement, from the primitive's terminal outcome — numeric exit, signal exit and spawn
  // failure all land here, and each maps to a status rather than being inferred from a null.
  void workload.completion.then((outcome) => {
    Object.assign(deployment.lifecycle, { exitCode: outcome.code, exitSignal: outcome.signal, exitedAt: new Date().toISOString(), spawnError: outcome.errorCode });
    if (outcome.kind === "spawn-failed") {
      deployment.status = "FAILED";
      emitReceipt("deployment-spawn-failed", { deploymentId: id, serviceId, errorCode: outcome.errorCode });
      return;
    }
    // "We asked it to stop" is `stopRequested`, recorded when we ask. `child.killed` is
    // signal-REQUEST metadata and was never proof of anything.
    deployment.status = outcome.code === 0 || deployment.stopRequested ? "REMOVED" : "CRASHED";
    emitReceipt("deployment-exited", {
      deploymentId: id, serviceId, pid: workload.pid, status: deployment.status,
      exitCode: outcome.code, exitSignal: outcome.signal, stopRequested: Boolean(deployment.stopRequested),
      lifetimeMs: Date.now() - startedAt,
    });
  });

  deployments.set(id, deployment); return deployment;
}
spawnDeployment(appServiceId, initialCommit, { mode: runtimeMode });
spawnDeployment(graphitiServiceId);

function json(res, status, value) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
/**
 * Stop the OWNED WORKLOAD — not merely the tracked child.
 *
 * Idempotent and concurrency-safe by construction: `workload.stop()` reuses one in-flight operation
 * and an already-terminal workload returns immediately, so the repeat-stop hang is not "less likely"
 * here, it is unreachable. Total handling stays inside the caller's 10 s HTTP timeout: 5 s grace +
 * 2 s verification, escalation included.
 *
 * An unverifiable cleanup is an explicit FAILURE. The controller must not report a completed stop,
 * and must not start a replacement, on the strength of a signal it merely delivered.
 */
async function stopChild(deployment) {
  const startedAt = Date.now();
  deployment.stopRequested = true;
  emitReceipt("deployment-stop-requested", { deploymentId: deployment.id, serviceId: deployment.serviceId, pid: deployment.lifecycle.pid, pgid: deployment.lifecycle.pgid, signal: "SIGTERM" });
  // The app workload may itself be the startup-fence supervisor. Escalating the OUTER group would
  // kill that healthy lock holder while its separately owned payload group survived. App shutdown
  // therefore asks the fence to clean up and verifies its exit, but never SIGKILLs around it.
  const outcome = await deployment.workload.stop({ graceMs: 5_000, verifyMs: 2_000, escalate: deployment.serviceId !== appServiceId });
  deployment.lifecycle.stopped = outcome.stopped;
  deployment.lifecycle.stopReason = outcome.reason;
  emitReceipt("deployment-stop-completed", {
    deploymentId: deployment.id, serviceId: deployment.serviceId, pid: deployment.lifecycle.pid,
    pgid: deployment.lifecycle.pgid, stopped: outcome.stopped, reason: outcome.reason,
    escalated: outcome.escalated, exitCode: deployment.lifecycle.exitCode,
    exitSignal: deployment.lifecycle.exitSignal, durationMs: Date.now() - startedAt,
  });
  if (!outcome.stopped) throw new Error(`owned workload for deployment ${deployment.id} could not be verified stopped (${outcome.reason})`);
  return outcome;
}

/**
 * Is the app's address actually free again?
 *
 * "The tracked child exited" did not establish this — that is precisely what runtime 5 measured, and
 * a replacement spawned on that assumption died with `EADDRINUSE`. The question is asked by BINDING
 * the address, which answers only about availability: nothing is enumerated, and nothing is killed
 * for holding it. An occupied port is reported, and whoever holds it is left alone.
 */
async function addressAvailable(port, host = "0.0.0.0", timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const free = await new Promise((resolve) => {
      const probe = createProbeServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (free || Date.now() >= deadline) return free;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  // ONE liveness test everywhere (`isActive`). Listing used `exitCode == null`, which reports a
  // SIGTERM-terminated child as alive and is what produced the second, hanging stop request.
  if (url.pathname === "/deployments") return json(res, 200, { deployments: [...deployments.values()].filter((d) => d.serviceId === url.searchParams.get("serviceId") && isActive(d)).map(publicView) });
  const dep = url.pathname.match(/^\/deployments\/([^/]+)(?:\/(stop))?$/);
  if (dep) {
    const deployment = deployments.get(dep[1]); if (!deployment) return json(res, 404, { error: "missing" });
    if (dep[2] && req.method === "POST") {
      // A stop that cannot be VERIFIED is a refusal, not a 200 — reporting completion would let the
      // caller start a replacement into an address the old workload still holds.
      try { await stopChild(deployment); }
      catch (error) { return json(res, 409, { error: "stop-unverified", detail: String(error?.message ?? error).slice(0, 200), deployment: publicView(deployment) }); }
    }
    return json(res, 200, publicView(deployment));
  }
  if (url.pathname === "/deploy" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (body.serviceId !== appServiceId || !/^[0-9a-f]{40}$/i.test(body.commitSha)) return json(res, 400, { error: "invalid deploy" });
    // REPLACEMENT IS A STOP FIRST. Every active app workload must be verifiably gone AND its
    // address free before a successor is spawned — the measured failure was a replacement started
    // 10 s after a "completed" stop, into a port a surviving Next descendant still held.
    for (const deployment of deployments.values()) {
      if (deployment.serviceId !== appServiceId || !isActive(deployment)) continue;
      try { await stopChild(deployment); }
      catch (error) { return json(res, 409, { error: "stop-unverified", detail: String(error?.message ?? error).slice(0, 200) }); }
    }
    if (!(await addressAvailable(appPort))) {
      // Whoever holds it is NOT killed: we did not start it, so it is not ours to stop. The refusal
      // is explicit, and the replacement is not spawned into a port that is already taken.
      emitReceipt("deploy-refused", { serviceId: appServiceId, reason: "address-in-use", port: appPort });
      return json(res, 409, { error: "address-in-use", port: appPort, detail: `${appPort} is still bound after the previous workload was stopped` });
    }
    return json(res, 200, { id: spawnDeployment(appServiceId, body.commitSha, { mode: runtimeMode }).id });
  }
  if (url.pathname === "/api/health") {
    const app = [...deployments.values()].find((d) => d.serviceId === appServiceId && isActive(d));
    return app ? json(res, 202, { ok: false, booted: true, commit: app.meta.commitHash }) : json(res, 503, { ok: false });
  }
  return json(res, 404, { error: "not found" });
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");

/**
 * Controller shutdown goes through the SAME lifecycle machinery as every other stop — a second,
 * improvised implementation is how the two defects above came to differ from each other. It is
 * awaited, so the controller does not exit while its owned workloads are still being terminated.
 */
let shuttingDown = null;
function stop() {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    const results = await Promise.allSettled([...deployments.values()].filter(isActive).map((deployment) => stopChild(deployment)));
    const unverified = results.filter((r) => r.status === "rejected").length;
    emitReceipt("controller-shutdown", { stopped: results.length - unverified, unverified });
    server.close();
  })();
  return shuttingDown;
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
