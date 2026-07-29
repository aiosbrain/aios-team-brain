#!/usr/bin/env node
/**
 * bootstrap.mjs — make `docker compose up` produce a brain you can actually log into.
 *
 * Runs once per container start, before the server. Idempotent by construction: the schema
 * loader is already safe to re-run, and seeding is skipped when a team exists, so `up`,
 * `restart`, and `up` again on a persisted volume all behave.
 *
 * The seeded demo member is created through `scripts/admin.ts create-member`, not by a raw
 * insert, because that is the only path that also SETS A PASSWORD. Seeded rows alone have no
 * credential, and this image runs NODE_ENV=production where magic-link mail is dropped
 * without a transport — so without this step the stack would come up with nothing to log in
 * with. Skip the whole demo with SEED_DEMO=false.
 */
import { spawnSync } from "node:child_process";
import pg from "pg";
import { shouldUseSsl } from "../scripts/pg-load-schema.mjs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("bootstrap: DATABASE_URL is required");
  process.exit(1);
}

const DEMO_EMAIL = process.env.DEMO_EMAIL || "admin@demo.local";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "aios-demo-password";
const WAIT_TIMEOUT_MS = Number(process.env.DB_WAIT_TIMEOUT_MS || 60_000);

const ssl = shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : undefined;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: "/app" });
  if (r.status !== 0) {
    console.error(`bootstrap: \`${cmd} ${args.join(" ")}\` exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compose's healthcheck already gates on pg_isready; this covers the gap between the
 *  server accepting connections and the database being ready to answer. */
async function waitForDatabase() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: DATABASE_URL, ssl, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      await sleep(1000);
    }
  }
  console.error(`bootstrap: database unreachable after ${WAIT_TIMEOUT_MS}ms — ${lastErr?.message ?? lastErr}`);
  process.exit(1);
}

async function teamCount() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl });
  await client.connect();
  try {
    const { rows } = await client.query("select count(*)::int as n from teams");
    return rows[0].n;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log("▶ waiting for postgres…");
  await waitForDatabase();

  console.log("▶ loading schema (idempotent; also applies migrations)…");
  run("node", ["scripts/pg-load-schema.mjs"]);

  if (process.env.SEED_DEMO === "false") {
    console.log("▶ SEED_DEMO=false — skipping demo data");
    return;
  }

  if ((await teamCount()) > 0) {
    console.log("▶ existing data found — skipping seed");
  } else {
    console.log("▶ seeding the Northwind demo team…");
    run("npx", ["tsx", "--conditions", "react-server", "scripts/seed-demo.ts"]);

    console.log("▶ creating a demo admin you can log in as…");
    run("npx", [
      "tsx", "--conditions", "react-server", "scripts/admin.ts",
      "create-member", DEMO_EMAIL,
      "--name", "Demo Admin", "--handle", "demo",
      "--role", "admin", "--team", "demo",
      "--password", DEMO_PASSWORD,
      "--upsert",
    ]);
  }

  const url = process.env.APP_URL || "http://localhost:3000";
  console.log(
    ["", "─".repeat(58), "  AIOS Team Brain is starting", "", `  URL       ${url}`,
     `  Login     ${DEMO_EMAIL}`, `  Password  ${DEMO_PASSWORD}`, "",
     "  Demo data: Northwind Robotics. Set SEED_DEMO=false for an empty brain.",
     "─".repeat(58), ""].join("\n")
  );
}

main().catch((err) => {
  console.error("bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
