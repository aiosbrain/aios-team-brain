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
 *
 * The demo is DEFAULT-ON for a laptop and OPT-IN for anything with a public address: on a
 * production build whose APP_URL is not localhost it seeds only for an explicit SEED_DEMO=true,
 * because the demo login is documented in this public repo. See `scripts/setup/deploy-policy.mjs`
 * for that decision and for TEAM_SLUG normalisation.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { shouldUseSsl } from "../scripts/pg-load-schema.mjs";
import { credentialPlan, credentialSummary } from "../scripts/setup/credential-plan.mjs";
import { demoSeedDecision, normalizeTeamSlug } from "../scripts/setup/deploy-policy.mjs";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("bootstrap: DATABASE_URL is required");
  process.exit(1);
}

const DEMO = demoSeedDecision(process.env);
const DEMO_EMAIL = process.env.DEMO_EMAIL || "admin@demo.local";
// The documented demo password is a convenience for a laptop, and a published credential
// anywhere else. If an operator opts the demo INTO a production deploy with a public URL, they
// get a generated one instead — printed once, like every other first-boot secret here.
const DEMO_PASSWORD =
  process.env.DEMO_PASSWORD || (DEMO.publicProduction ? randomBytes(12).toString("base64url") : "aios-demo-password");
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

/**
 * Generate AUTH_SECRET / SECRETS_KEY on first boot and persist them, so no fake secret has
 * to be committed to the repo (the secret scanner is right to reject one, and a committed
 * "dev" key is the kind of thing that gets copied into a real deploy).
 *
 * Persisted, not per-boot, because both must be STABLE: a rotating SECRETS_KEY orphans every
 * connector token already encrypted with the old one, and a rotating AUTH_SECRET invalidates
 * every session cookie on each restart. Values supplied by the environment always win and are
 * never written to disk.
 *
 * Written as a shell-sourceable file: bootstrap runs as a child process, so it cannot mutate
 * the environment of the server the entrypoint goes on to exec — the entrypoint sources this.
 */
function ensureDevSecrets() {
  const file = process.env.DEV_SECRETS_FILE;
  if (!file) return;

  const existing = existsSync(file) ? parseShellEnv(readFileSync(file, "utf8")) : {};
  const resolved = {
    AUTH_SECRET: process.env.AUTH_SECRET || existing.AUTH_SECRET || randomBytes(32).toString("hex"),
    // Exactly 32 bytes — AES-256-GCM. `npm run doctor` fails a key of any other width.
    SECRETS_KEY: process.env.SECRETS_KEY || existing.SECRETS_KEY || randomBytes(32).toString("base64"),
  };

  const fromEnv = Boolean(process.env.AUTH_SECRET && process.env.SECRETS_KEY);
  if (!fromEnv) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `AUTH_SECRET='${resolved.AUTH_SECRET}'\nSECRETS_KEY='${resolved.SECRETS_KEY}'\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(
      Object.keys(existing).length
        ? "▶ reusing the generated dev secrets from the appdata volume"
        : "▶ generated AUTH_SECRET + SECRETS_KEY (persisted to the appdata volume)"
    );
  }
  Object.assign(process.env, resolved);
}

/** Reads back only what ensureDevSecrets writes: KEY='value', one per line. */
function parseShellEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)='(.*)'$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Does this email already have a usable login? Drives whether we set a password at all. */
async function hasCredential(email) {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select 1 from auth_users where lower(email) = lower($1) and password_hash is not null limit 1",
      [email]
    );
    return rows.length > 0;
  } catch {
    // A missing table means the schema load didn't take; treat as "no credential" and let the
    // admin.ts call surface the real error rather than masking it here.
    return false;
  } finally {
    await client.end();
  }
}

/** Run a command, capturing output instead of inheriting it. */
function runQuiet(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: "/app" });
  if (r.status !== 0) {
    console.error(r.stdout ?? "");
    console.error(r.stderr ?? "");
    console.error(`bootstrap: \`${cmd} ${args.join(" ")}\` exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
  return r.stdout ?? "";
}

/** Best-effort variant: logs a failure and CONTINUES — for steps whose failure must never kill
 *  the boot (PRET-2 review Low 1: a die() inside the spawned command would otherwise become a
 *  restart loop, the deploy-policy incident class; the scheduler pass is the retry). */
function runSoft(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: "/app" });
  if (r.stdout) console.log(r.stdout.trimEnd());
  if (r.status !== 0) {
    console.error(r.stderr ?? "");
    console.error(`bootstrap: \`${cmd} ${args.join(" ")}\` exited ${r.status} — continuing (best-effort step)`);
  }
  return r.stdout ?? "";
}

/**
 * Create the operator's own team + admin, idempotently.
 *
 * PASSWORD STABILITY IS THE WHOLE DIFFICULTY, and the obvious fix is wrong.
 *
 * This runs on EVERY container start, so re-provisioning the credential each time would reset the
 * login on every `docker compose up` — including over a password the user later changed in Admin.
 * That is the same rotate-on-rerun failure the Railway provisioner was just fixed for, and worse
 * here because a restart is routine rather than deliberate.
 *
 * The trap: omitting `--password` does NOT skip setting one. `scripts/admin.ts` does
 * `flags.password || randomPassword()`, so `create-member` ALWAYS writes a credential — dropping
 * the flag just installs a random password nobody ever sees, locking the user out completely.
 * (Measured: the stored hash changed across a restart while this function reported "unchanged".)
 *
 * So the credential decision has to be made BEFORE deciding whether to run `create-member` at all —
 * see `credentialPlan`. Once an account has a password, we touch nothing.
 */
async function provisionRealTeam() {
  const url = process.env.APP_URL || "http://localhost:3000";
  const typed = String(process.env.TEAM_SLUG ?? "").trim();
  const email = process.env.ADMIN_EMAIL;
  if (!email) {
    console.error("bootstrap: TEAM_SLUG was set without ADMIN_EMAIL — there would be no way to log in");
    process.exit(1);
  }

  // TEAM_SLUG arrives from a deploy form with no validation, so "Acme Corp" is the obvious
  // thing to type — and `createTeam` rejects it, which used to mean die() → restart loop →
  // failed deployment over a half-provisioned database. Normalise, then SAY SO: the slug is in
  // every URL the operator is about to bookmark.
  const { slug, changed } = normalizeTeamSlug(typed);
  if (!slug) {
    console.error(
      `bootstrap: TEAM_SLUG='${typed}' contains no letters or digits, so there is no name to give this team — ` +
        `set TEAM_SLUG to something like 'acme-corp' and redeploy`
    );
    process.exit(1);
  }
  if (changed) {
    console.log(
      [
        `⚠ TEAM_SLUG '${typed}' is not a valid slug (lowercase letters, digits and dashes only).`,
        `  Using '${slug}' instead — this is the team's permanent address: ${url}/t/${slug}`,
        `  Set TEAM_SLUG=${slug} in your deploy variables so it can never change under you.`,
      ].join("\n")
    );
  }
  // The display name keeps what the operator typed; only the URL had to be sanitised.
  const name = process.env.TEAM_NAME || (changed ? typed : slug);
  const adminName = process.env.ADMIN_NAME || email.split("@")[0];

  console.log(`▶ ensuring team ${slug} and admin ${email}…`);
  // Idempotent by construction: `createTeam` returns the existing row for a known slug.
  runQuiet("npx", ["tsx", "--conditions", "react-server", "scripts/admin.ts", "create-team", slug, "--name", name]);

  const plan = credentialPlan({
    hasCredential: await hasCredential(email),
    adminPassword: process.env.ADMIN_PASSWORD,
  });

  if (plan.action === "create") {
    runQuiet("npx", [
      "tsx", "--conditions", "react-server", "scripts/admin.ts",
      "create-member", email,
      "--name", adminName,
      "--handle", adminName.toLowerCase().replace(/\W+/g, ""),
      "--role", "admin", "--team", slug,
      "--password", plan.password,
      "--upsert",
    ]);
  }

  console.log(
    ["", "─".repeat(58), `  ${name} is ready`, "", `  URL       ${url}/t/${slug}`, `  Login     ${email}`,
     credentialSummary({ password: plan.password, supplied: Boolean(process.env.ADMIN_PASSWORD) }),
     "", "  Next: Admin → Integrations to connect Slack / GitHub / Linear.",
     "─".repeat(58), ""].join("\n")
  );
}

async function main() {
  ensureDevSecrets();

  console.log("▶ waiting for postgres…");
  await waitForDatabase();

  console.log("▶ loading schema (idempotent; also applies migrations)…");
  run("node", ["scripts/pg-load-schema.mjs"]);

  // A REAL install: the operator's own team, not the Northwind demo. Without this, the only local
  // path that produced something you could log into was the demo — `SEED_DEMO=false` returned here
  // with a running app, an empty database, no team, no member and no printed credentials, which is
  // a stack you cannot get into. `npm run setup`'s local target sets these.
  if (process.env.TEAM_SLUG) {
    await provisionRealTeam();
    return;
  }

  if (!DEMO.seed) {
    if (DEMO.reason === "disabled") {
      console.log(`▶ SEED_DEMO=${process.env.SEED_DEMO} — skipping demo data (no team and no login are created)`);
      return;
    }
    // reason === "opt-in-required": a production build on a non-local URL. Seeding here would
    // publish a team with a documented password to whoever finds the address first.
    const url = process.env.APP_URL || "";
    console.log(
      [
        "",
        "─".repeat(58),
        `  Skipping the demo seed — this deploy is served at ${url}`,
        "",
        "  The demo team ships a documented login (admin@demo.local), which must not be",
        "  reachable from the internet. Nothing has been created, so there is no login yet.",
        "",
        "  To provision YOUR team and admin (recommended):",
        "    set TEAM_SLUG, TEAM_NAME, ADMIN_EMAIL (optionally ADMIN_PASSWORD) and redeploy.",
        "  To seed the demo here anyway:",
        "    set SEED_DEMO=true (a demo password is then generated, not the documented one).",
        "─".repeat(58),
        "",
      ].join("\n")
    );
    return;
  }

  const seededNow = (await teamCount()) === 0;
  if (!seededNow) {
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

    // PRET-2: seed → drain → gated flip, one path (the seed writes via ingestItem, which
    // bypasses the items route's reconcile hook — the flip's own drain partitions those rows).
    // Best-effort: a refusal/deferral here is surfaced by the command and retried by the
    // scheduler pass; the boot never fails on it.
    console.log("▶ auto-flipping the demo team to enforcing (gated — refuses rather than bricks)…");
    runSoft("npx", ["tsx", "--conditions", "react-server", "scripts/admin.ts", "auto-flip", "demo"]);
  }

  // Only reached when the demo actually owns this database. Printing demo credentials after a real
  // install advertised a login (admin@demo.local) that was never created.
  //
  // The password line has to track what this boot actually DID. DEMO_PASSWORD is generated per
  // process on a public production deploy, so printing it on a restart that skipped seeding
  // would advertise a password nobody can log in with.
  const url = process.env.APP_URL || "http://localhost:3000";
  const generated = DEMO.publicProduction && !process.env.DEMO_PASSWORD;
  // "unchanged" is a claim about a credential that exists, so ASK. A boot that seeded the team
  // but died before create-member leaves rows with no login; reporting that as "still works" sends
  // the operator to a login screen that can never let them in — and a generated password from that
  // first boot is gone (it is per-process), so silence would be the second wrong answer.
  const passwordLine = seededNow
    ? generated
      ? `  Password  ${DEMO_PASSWORD}   ← generated for this deploy, shown only now`
      : `  Password  ${DEMO_PASSWORD}`
    : (await hasCredential(DEMO_EMAIL))
      ? "  Password  unchanged — the demo login from the first boot still works"
      : `  Password  NOT SET — ${DEMO_EMAIL} has no credential. Wipe the database and start again, ` +
        `or set TEAM_SLUG + ADMIN_EMAIL to provision a real team.`;
  console.log(
    ["", "─".repeat(58), "  AIOS Team Brain is starting", "", `  URL       ${url}`,
     `  Login     ${DEMO_EMAIL}`, passwordLine, "",
     "  Demo data: Northwind Robotics. Set SEED_DEMO=false for an empty brain.",
     "─".repeat(58), ""].join("\n")
  );
}

main().catch((err) => {
  console.error("bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
