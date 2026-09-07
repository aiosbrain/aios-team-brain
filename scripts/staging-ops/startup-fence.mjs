#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { shouldUseSsl } from "../pg-load-schema.mjs";
import { acquireDataUseLock, assertBootAdmission } from "./journal.mjs";
import { spawnOwnedWorkload } from "./owned-workload.mjs";
import { emitReceipt } from "./receipts.mjs";

export function copyFenceRequired(env = process.env) {
  return env.STAGING_DATA_MODE === "copy-ready";
}

export async function acquireStartupFence({ env = process.env, createClient = (config) => new Client(config) } = {}) {
  if (!copyFenceRequired(env)) return null;
  if (!env.DATABASE_URL) throw new Error("copy-mode startup fence requires DATABASE_URL");
  if (!env.STAGING_OPS_ENVIRONMENT_ID || env.STAGING_OPS_ENVIRONMENT_ID !== env.RAILWAY_ENVIRONMENT_ID) {
    throw new Error("copy-mode startup fence environment identity mismatch");
  }
  const client = createClient({
    connectionString: env.DATABASE_URL,
    ssl: shouldUseSsl(env.DATABASE_URL, env) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    // Acquire the shared lock BEFORE reading, and keep this connection alive for the child's whole
    // lifetime: that ordering is what closes the startup TOCTOU (a refresh cannot take the exclusive
    // lock between our read and the child starting).
    await acquireDataUseLock(client, "shared", true);
    // Shared with the schema loader (B1) so predeploy and startup can never disagree about whether
    // this exact process is the deployment the refresh selected.
    const journal = await assertBootAdmission(client, env, "copy-mode startup");
    return { client, journal };
  } catch (error) {
    await Promise.resolve(client.end()).catch(() => {});
    throw error;
  }
}

/**
 * Supervise the payload through the SAME owned-workload lifecycle the controller uses.
 *
 * Two things this now gets right that a `child.kill()` could not:
 *
 *  - **The payload is a chain** (`npm` → `next`), so signalling the immediate child left the Next
 *    process holding `0.0.0.0:3000` after the wrapper had exited — measured in runtime 5 as an
 *    `EADDRINUSE` on the very next deployment. The workload owns a process group and is stopped as
 *    a unit, with bounded grace, escalation limited to that group, and verified completion.
 *  - **Every path converges here.** Ordinary exit, `SIGTERM`/`SIGINT`, and a lost database
 *    connection all run the one idempotent cleanup instead of three improvised ones.
 *
 * THE LOCK IS HELD UNTIL THE WORKLOAD IS GONE, not until npm exits. Releasing it when the wrapper
 * exits would drop the fence while a Next process was still serving from the copied dataset. The
 * one exception is a lost connection: the lock is already unavailable then, so the workload is
 * terminated promptly and no claim is made that the fence still protects anything.
 */
export async function supervise(command, { env = process.env, createClient, spawnImpl = spawn, platform = process.platform } = {}) {
  if (!Array.isArray(command) || command.length === 0) throw new Error("startup fence requires a child command");
  const fence = await acquireStartupFence({ env, createClient });
  let workload;
  try {
    workload = spawnOwnedWorkload({ command, env, label: "startup-fence-payload", spawnImpl, platform });
  } catch (error) {
    // Refusing to supervise must not leave the fence's connection open.
    await Promise.resolve(fence?.client.end()).catch(() => {});
    throw error;
  }

  let cleanup = null;
  /** Idempotent, and the ONLY place the lock is released. */
  const shutdown = async (reason) => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const stopped = await workload.stop({ graceMs: 5_000, verifyMs: 2_000 }).catch((error) => ({ stopped: false, reason: String(error?.message ?? error).slice(0, 120) }));
      // AFTER the workload is gone, never before.
      await Promise.resolve(fence?.client.end()).catch(() => {});
      emitReceipt("fence-shutdown", { reason, stopped: Boolean(stopped?.stopped), stopReason: stopped?.reason ?? null, heldLockUntilStopped: reason !== "database-connection-lost" });
      return stopped;
    })();
    return cleanup;
  };

  // A lost connection means the shared lock is ALREADY gone. Terminate promptly; do not pretend the
  // fence is still protective, and do not wait for a graceful exit that has nothing fencing it.
  fence?.client.on?.("error", () => { void shutdown("database-connection-lost"); });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void shutdown(signal); });

  const outcome = await workload.completion;
  if (outcome.kind === "spawn-failed") {
    await shutdown("spawn-failed");
    throw Object.assign(new Error(`startup fence payload failed to spawn (${outcome.errorCode})`), { code: outcome.errorCode });
  }
  // The wrapper exiting is the START of cleanup, not the end of it: descendants may still be alive.
  await shutdown("payload-exited");
  return { code: outcome.code ?? (outcome.signal ? 1 : 0), signal: outcome.signal };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const separator = process.argv.indexOf("--");
  const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
  supervise(command).then(({ code }) => { process.exitCode = code; }).catch((error) => {
    console.error(`startup fence refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
