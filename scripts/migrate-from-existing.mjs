/**
 * migrate-from-existing — the lane that makes every migration observable.
 *
 * WHY THIS EXISTS
 * `scripts/pg-load-schema.mjs` loads `postgres/schema.sql` first and then replays every file in
 * `postgres/migrations/` in lexical order, with no applied-tracking table. On a FRESH database
 * `schema.sql` already creates every object in its final shape, so every migration that follows is
 * a no-op. `npm run db:test:up` — and the `pg:schema` step in CI — run exactly that fresh-DB path,
 * which means a from-zero build CANNOT OBSERVE AN ADDITIVE MIGRATION AT ALL. Delete
 * `20260724130000_transcript_evidence_rows.sql` and the whole suite stays green.
 *
 * The fix is not one more per-migration guard. It is to load a PRIOR schema state (a real released
 * tag, straight out of git — no fixture files to maintain), apply the CURRENT `schema.sql` + all
 * migrations forward exactly as a deploy would, and assert the result is structurally identical to
 * a from-zero build. That single assertion covers every migration at once, including the ~14
 * backfill/data migrations no static guard can ever reach, and it fails when someone forgets a
 * migration entirely — which is the real failure mode.
 *
 * MODES
 *   (default)        upgrade every `--tags` release state forward; assert == from-zero. Also
 *                    asserts a second full replay is a no-op (idempotence).
 *   --mirror-check   assert `schema.sql` ALONE already produces the from-zero fingerprint, i.e.
 *                    every migration is mirrored into `schema.sql` as `postgres/migrations/README.md`
 *                    requires. Any object only a migration creates is a red build.
 *   --deletion-sweep the exhaustive form of --mirror-check: rebuild from zero 75 times, each time
 *                    omitting ONE migration, and assert the fingerprint never moves. ~4 minutes, so
 *                    this one is NIGHTLY, not per-PR.
 *
 * SCRATCH DATABASES, NOT SCRATCH SCHEMAS
 * `create schema` + `set search_path` is not enough here. `schema.sql` opens with
 * `create extension if not exists citext`, which is database-scoped and lands wherever it already
 * lives, and the enum/domain types it creates then resolve through `search_path` rather than being
 * owned by the scratch schema — so a scratch-schema build silently shares types with `public` and
 * the fingerprint stops meaning what it says. Each build therefore gets its OWN database on the
 * same server, created and dropped by this script. Nothing touches the caller's database, so this
 * is safe to run against the shared test Postgres.
 *
 * Usage:
 *   DATABASE_TEST_URL=postgres://app:app@localhost:5434/app_test node scripts/migrate-from-existing.mjs
 *   … --tags v0.9.0,v0.10.0 --mirror-check --deletion-sweep --keep
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { fingerprint, diffFingerprints } from "./schema-fingerprint.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Tags whose schema state we upgrade forward. Every one must exist in git. */
export const DEFAULT_TAGS = ["v0.7.0", "v0.8.0", "v0.9.0", "v0.10.0"];

/**
 * Objects a migration creates that `postgres/schema.sql` deliberately does not mirror, each with the
 * reason it cannot be. This is an escape hatch for a DOCUMENTED decision (every entry is also
 * commented at the corresponding site in schema.sql), not a place to park a real drift: anything not
 * listed here that only a migration creates is a red build.
 *
 * Three of these are structurally unmirrorable, and it is the same mechanism every time.
 * `pg-load-schema.mjs` runs schema.sql BEFORE the migrations. On an existing database the
 * `create table if not exists` is a no-op, so the column a migration adds does not exist yet when
 * schema.sql runs — and a bare `create index if not exists` on a not-yet-existing column is a hard
 * error, not a skip. So the index can only live in the migration that adds its column first. The
 * two CHECK constraints are a different, deliberate call: the migrations README requires an
 * enumerated CHECK to be a NAMED drop-and-re-add so it stays replay-repairable (the 2026-07-13
 * `integrations_type_check` incident), and that named form belongs in exactly one place.
 *
 * Keys are `kind\tident` prefixes of a fingerprint line.
 * @type {Record<string,string>}
 */
export const MIRROR_EXCEPTIONS = {
  "index\tchat_messages.chat_messages_search_idx":
    "GIN index on chat_messages.search, a column added by 20260707130000. schema.sql's create-table " +
    "is a no-op on an existing DB, so the column isn't there yet when schema.sql runs (noted inline " +
    "in schema.sql beside chat_turn_runs).",
  "index\tgraph_episodes.graph_episodes_pending_delete_idx":
    "Partial index on graph_episodes.pending_delete_group_id, added by 20260724180000 — same " +
    "column-does-not-exist-yet ordering (noted inline in schema.sql beside graph_episodes).",
  "index\titems.items_team_work_at_idx":
    "Index on items(team_id, work_at desc); work_at is added by 20260726090000 — same ordering " +
    "(noted inline in schema.sql beside the items table).",
  "constraint\tmembers.members_kind_check":
    "Named drop-and-re-add CHECK owned by 20260809120000 so widening the value set stays " +
    "replay-repairable (migrations README). schema.sql adds the column and points at the migration.",
  "constraint\tprojects.projects_kind_check":
    "Named drop-and-re-add CHECK owned by 20260809150000, same reason.",
};

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The current working-tree schema + migrations, in the order `pg-load-schema.mjs` applies them. */
export function currentSources() {
  const migDir = path.join(ROOT, "postgres", "migrations");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  return {
    schema: readFileSync(path.join(ROOT, "postgres", "schema.sql"), "utf8"),
    migrations: files.map((f) => ({
      name: f, sql: readFileSync(path.join(migDir, f), "utf8"),
    })),
  };
}

/** The same pair as of a released tag — a prior schema state, for free, out of git history. */
export function sourcesAtTag(tag) {
  const listed = git(["ls-tree", "-r", "--name-only", tag, "postgres/migrations/"])
    .split("\n").filter((f) => f.endsWith(".sql")).sort();
  return {
    schema: git(["show", `${tag}:postgres/schema.sql`]),
    migrations: listed.map((f) => ({ name: path.basename(f), sql: git(["show", `${tag}:${f}`]) })),
  };
}

function adminUrl() {
  const url = process.env.DATABASE_TEST_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_TEST_URL (or DATABASE_URL) is required");
  return url;
}

/** Point a base connection string at a different database on the same server. */
export function urlForDatabase(base, dbName) {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withAdmin(fn) {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

const scratchName = (label) =>
  `mfe_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24)}_${randomBytes(4).toString("hex")}`;

/**
 * Create a scratch database, hand its connection URL to `fn`, drop it afterwards.
 * @param {string} label @param {(url: string) => Promise<any>} fn
 */
async function withScratchDb(label, fn, { keep = false } = {}) {
  const name = scratchName(label);
  await withAdmin(async (admin) => { await admin.query(`create database "${name}"`); });
  try {
    return await fn(urlForDatabase(adminUrl(), name));
  } finally {
    if (keep) console.log(`  (kept scratch database ${name})`);
    else await withAdmin(async (admin) => {
      await admin.query(`drop database if exists "${name}" with (force)`);
    });
  }
}

/** Open a connection to a scratch database, run `fn`, close it. */
async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/**
 * Apply a schema + migration set exactly the way the deploy-time loader does — ONE FRESH SESSION
 * per pass, because that is what a deploy is. It matters: `20260725180000_slack_paths_by_channel_id`
 * creates a `temporary view`, which is session-scoped and would collide on a second pass reusing the
 * same connection. Sharing a session would invent a failure the rollout path cannot have.
 */
export async function applyPass(url, sources, { skip = new Set(), schemaOnly = false } = {}) {
  await withClient(url, async (client) => {
    await client.query(sources.schema);
    if (schemaOnly) return;
    for (const m of sources.migrations) {
      if (skip.has(m.name)) continue;
      try {
        await client.query(m.sql);
      } catch (err) {
        throw new Error(`migration ${m.name} failed: ${err.message}`);
      }
    }
  });
}

/** Fingerprint a scratch database on its own connection. */
async function fingerprintDb(url) {
  return withClient(url, (client) => fingerprint(client));
}

/** True when a fingerprint line is NOT covered by a documented mirror exception. */
const excepted = (line) => !Object.keys(MIRROR_EXCEPTIONS).some((k) => line.startsWith(k));

const ms = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

async function buildFromZero(opts) {
  const current = currentSources();
  return withScratchDb("from_zero", async (url) => {
    await applyPass(url, current, opts);
    return fingerprintDb(url);
  }, opts);
}

/** @returns {{failures: string[], report: string[]}} */
async function runUpgrades(tags, baseline, opts) {
  const failures = [];
  const report = [];
  const current = currentSources();
  for (const tag of tags) {
    const started = Date.now();
    const prior = sourcesAtTag(tag);
    const result = await withScratchDb(`from_${tag}`, async (url) => {
      // 1. Materialize the database as it stood at that release.
      await applyPass(url, prior);
      // 2. Roll the CURRENT deploy forward over it — schema.sql then every migration, in order.
      await applyPass(url, current);
      const after = await fingerprintDb(url);
      // 3. Replay the whole deploy a second time: a rollout happens on every deploy, so a
      //    non-idempotent file must fail here rather than on the next release.
      await applyPass(url, current);
      const replayed = await fingerprintDb(url);
      return { after, replayed };
    }, opts);

    const drift = diffFingerprints(baseline, result.after);
    if (drift.missing.length || drift.extra.length) {
      failures.push(
        `upgrade from ${tag} (${prior.migrations.length} migrations at tag) does not match a from-zero build:\n${drift.text}`,
      );
    }
    const replay = diffFingerprints(result.after, result.replayed);
    if (replay.missing.length || replay.extra.length) {
      failures.push(`replaying the deploy over the ${tag} upgrade is not idempotent:\n${replay.text}`);
    }
    report.push(`  ✓ ${tag} → current: ${result.after.length} objects, idempotent (${ms(started)})`);
  }
  return { failures, report };
}

/** Cheap form of the deletion sweep: does `schema.sql` alone already produce the full shape? */
async function runMirrorCheck(baseline, opts) {
  const started = Date.now();
  const schemaOnly = await buildFromZero({ ...opts, schemaOnly: true });
  const { missing, extra } = diffFingerprints(baseline, schemaOnly);
  const unmirrored = missing.filter(excepted);
  const stale = extra.filter(excepted);
  const failures = [];
  if (unmirrored.length) {
    failures.push(
      `postgres/schema.sql does not mirror ${unmirrored.length} object(s) that only a migration creates ` +
      `(postgres/migrations/README.md: \"Mirror the change into postgres/schema.sql\"):\n` +
      unmirrored.map((l) => `  - ${l}`).join("\n"),
    );
  }
  if (stale.length) {
    failures.push(
      `postgres/schema.sql still creates ${stale.length} object(s) a migration later removes or ` +
      `redefines — a from-zero build and a deployed database would disagree:\n` +
      stale.map((l) => `  + ${l}`).join("\n"),
    );
  }
  return { failures, report: [`  ✓ mirror-check: schema.sql vs schema.sql+migrations (${ms(started)})`] };
}

/**
 * The exhaustive meta-guard the mirror-check approximates: every migration, deleted one at a time,
 * must leave the from-zero fingerprint UNCHANGED — the machine-checkable form of the migrations
 * README's "mirror the change into postgres/schema.sql". Nightly only (~76 full loads).
 *
 * One nuance the naive form gets wrong. A migration that `create or replace`s a function an EARLIER
 * migration also defines is legitimately observable from zero: delete it and the older body wins,
 * because migrations replay in order after schema.sql. That is not a mirroring failure — schema.sql
 * may hold the current body perfectly well. So a drift is a FAILURE only when the object is missing
 * from a `schema.sql`-alone build too; when schema.sql does have it, the drift is reported as a
 * REDEFINITION CHAIN: a note that the object's live shape depends on a migration being the last
 * writer, and that deleting it would silently revert production.
 */
async function runDeletionSweep(baseline, opts) {
  const { migrations } = currentSources();
  const failures = [];
  const notes = [];
  const started = Date.now();
  const schemaOnly = new Set(await buildFromZero({ ...opts, schemaOnly: true }));
  const identOf = (line) => line.split("\t").slice(0, 2).join("\t");
  // Idents whose CURRENT definition schema.sql already produces on its own — mirrored, by definition.
  const mirrored = new Set([...schemaOnly].filter((l) => baseline.includes(l)).map(identOf));

  for (const m of migrations) {
    const fp = await withScratchDb(`del_${m.name.slice(0, 14)}`, async (url) => {
      await applyPass(url, currentSources(), { skip: new Set([m.name]) });
      return fingerprintDb(url);
    }, opts);
    const drift = diffFingerprints(baseline, fp);
    const lines = [...drift.missing, ...drift.extra].filter(excepted);
    const unmirrored = lines.filter((l) => !mirrored.has(identOf(l)));
    const chained = [...new Set(lines.filter((l) => mirrored.has(identOf(l))).map(identOf))];
    if (unmirrored.length) {
      failures.push(
        `deleting ${m.name} changes the from-zero shape — it is not mirrored into schema.sql:\n` +
        unmirrored.slice(0, 20).map((l) => `  ${l.slice(0, 400)}`).join("\n"),
      );
    } else if (chained.length) {
      notes.push(`    ${m.name} is the last writer of: ${chained.map((i) => i.replace("\t", " ")).join(", ")}`);
    }
  }
  const report = [`  ✓ deletion sweep: ${migrations.length} migrations (${ms(started)})`];
  if (notes.length) {
    report.push("    redefinition chains (mirrored in schema.sql, but an older migration would win if deleted):");
    report.push(...notes);
  }
  return { failures, report };
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const opts = { keep: flag("keep") };
  const tags = flag("mirror-only") || flag("deletion-sweep-only")
    ? []
    : value("tags", DEFAULT_TAGS.join(",")).split(",").filter(Boolean);

  const known = new Set(git(["tag"]).split("\n").filter(Boolean));
  for (const tag of tags) if (!known.has(tag)) throw new Error(`unknown git tag: ${tag}`);

  const t0 = Date.now();
  const baseline = await buildFromZero(opts);
  const report = [`  ✓ from-zero baseline: ${baseline.length} catalog objects (${ms(t0)})`];
  const failures = [];

  if (tags.length) {
    const r = await runUpgrades(tags, baseline, opts);
    failures.push(...r.failures); report.push(...r.report);
  }
  if (flag("mirror-check") || flag("mirror-only")) {
    const r = await runMirrorCheck(baseline, opts);
    failures.push(...r.failures); report.push(...r.report);
  }
  if (flag("deletion-sweep") || flag("deletion-sweep-only")) {
    const r = await runDeletionSweep(baseline, opts);
    failures.push(...r.failures); report.push(...r.report);
  }

  console.log(report.join("\n"));
  if (failures.length) {
    console.error(`\n✗ migrate-from-existing: ${failures.length} failure(s)\n`);
    for (const f of failures) console.error(`${f}\n`);
    return 1;
  }
  console.log(`✓ migrate-from-existing passed in ${ms(t0)}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error("migrate-from-existing failed:", err?.stack || err);
    process.exit(1);
  });
}
