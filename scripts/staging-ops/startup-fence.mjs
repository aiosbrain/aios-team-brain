#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { shouldUseSsl } from "../pg-load-schema.mjs";
import { acquireDataUseLock, readJournal } from "./journal.mjs";

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
    await acquireDataUseLock(client, "shared", true);
    const journal = await readJournal(client);
    const exactBoot = journal.state === "booting" && /^[0-9a-f]{40}$/i.test(journal.catchup_commit ?? "") && journal.catchup_commit === env.RAILWAY_GIT_COMMIT_SHA;
    if ((!journal.run_id || journal.state !== "ready") && !exactBoot) throw new Error(`copy-mode startup refused while refresh state is ${journal.state}`);
    return { client, journal };
  } catch (error) {
    await Promise.resolve(client.end()).catch(() => {});
    throw error;
  }
}

export async function supervise(command, { env = process.env, createClient, spawnImpl = spawn } = {}) {
  if (!Array.isArray(command) || command.length === 0) throw new Error("startup fence requires a child command");
  const fence = await acquireStartupFence({ env, createClient });
  const child = spawnImpl(command[0], command.slice(1), { stdio: "inherit", env });
  let finishing = false;
  const failClosed = () => {
    if (!finishing) child.kill("SIGTERM");
  };
  fence?.client.on?.("error", failClosed);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      finishing = true;
      await fence?.client.end().catch(() => {});
      resolve({ code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const separator = process.argv.indexOf("--");
  const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
  supervise(command).then(({ code }) => { process.exitCode = code; }).catch((error) => {
    console.error(`startup fence refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
