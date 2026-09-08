import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pairedDumpArguments, transformedAuthUserProjection, transformedGraphEpisodeProjection } from "./pg-sanitize.mjs";
import { loadSchema } from "../pg-load-schema.mjs";
import { SCRUBBED_PG_ENV } from "../staging-refresh-decision.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import { OPERATION_TIMEOUT_DEFAULT_MS, remainingBudgetMs } from "./operation-deadline.mjs";

const SNAPSHOT = /^[0-9A-Fa-f:-]+$/;

/**
 * Control state that must OUTLIVE a restore, and is therefore excluded from destructive
 * enumeration (H1). `staging_marker` is deliberately absent from `postgres/schema.sql` and every
 * migration, so nothing recreates it: neither a production archive (which never contained it) nor
 * `loadSchema`. A cleanup that drops "all public tables" therefore deletes the discriminator that
 * `lib/env/staging-marker.ts` reads and `lib/graph/projection-window.ts` uses to refuse
 * production-shaped projection — and its ABSENCE reads as `false`, not as an error.
 *
 * `staging_ops` is a separate schema and is never touched by a `public`-only restore.
 */
export const PRESERVED_PUBLIC_TABLES = Object.freeze(["staging_marker"]);

async function run(command, args, options = {}, execImpl) {
  const env = { ...(options.env ?? process.env) };
  for (const name of SCRUBBED_PG_ENV) delete env[name];
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_DEFAULT_MS;
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  const signal = options.signal;
  try {
    if (execImpl) {
      return await execImpl(command, args, { maxBuffer: 16 * 1024 * 1024, ...options, timeout: timeoutMs, killSignal: "SIGKILL", signal, env });
    }
    return await runBoundedProcess(command, args, { maxBuffer: 16 * 1024 * 1024, timeoutMs, terminateGraceMs, signal, env, cwd: options.cwd });
  }
  catch (error) {
    throw Object.assign(new Error(`${command} failed: ${String(error?.stderr || error?.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]").slice(0, 500)}`, { cause: error }), {
      code: error?.code, terminationConfirmed: error?.terminationConfirmed === true, transient: error?.transient === true,
    });
  }
}

/** Hold the source snapshot transaction until both pg_dump and transformed COPY have finished. */
export async function capturePairedPostgres({
  client, databaseUrl, directory, execImpl, pgDump = "pg_dump", psql = "psql", captureSnapshotFacts,
  operationTimeoutMs = OPERATION_TIMEOUT_DEFAULT_MS, terminateGraceMs = 2_000, budget = null,
}) {
  const remaining = (label) => remainingBudgetMs(budget, operationTimeoutMs, label);
  remaining("Postgres capture transaction");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true)", [`${remaining("Postgres capture configuration")}ms`]);
    remaining("Postgres snapshot export");
    const snap = await client.query("SELECT pg_export_snapshot() AS snapshot");
    const snapshot = snap.rows[0]?.snapshot;
    if (!SNAPSHOT.test(String(snapshot ?? ""))) throw new Error("Postgres exported an invalid snapshot identifier");
    // Authorization, partition and schema/build facts must be read by this same transaction;
    // a follow-up connection could observe a different access state than the dump snapshot.
    remaining("Postgres snapshot policy reads");
    const snapshotFacts = captureSnapshotFacts ? await captureSnapshotFacts(client) : undefined;
    remaining("Postgres authentication projection");
    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='auth_users' ORDER BY ordinal_position");
    const projection = transformedAuthUserProjection(cols.rows.map((row) => row.column_name));
    remaining("Postgres graph projection");
    const graphCols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='graph_episodes' ORDER BY ordinal_position");
    const graphProjection = transformedGraphEpisodeProjection(graphCols.rows.map((row) => row.column_name));
    const archive = path.join(directory, "postgres.dump");
    const auth = path.join(directory, "auth_users.csv");
    const graphLedger = path.join(directory, "graph_episodes.csv");
    const controller = new AbortController();
    const commandOptions = { timeoutMs: remaining("Postgres capture subprocesses"), terminateGraceMs, signal: controller.signal };
    const tasks = [
      run(pgDump, [...pairedDumpArguments(snapshot, archive), databaseUrl], commandOptions, execImpl),
      run(psql, ["-X", "--quiet", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; COPY (SELECT ${projection} FROM public.auth_users) TO STDOUT WITH (FORMAT csv, HEADER true); COMMIT;`], commandOptions, execImpl)
        .then(({ stdout }) => writeFile(auth, stdout, { mode: 0o600 })),
      run(psql, ["-X", "--quiet", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; COPY (SELECT ${graphProjection} FROM public.graph_episodes) TO STDOUT WITH (FORMAT csv, HEADER true); COMMIT;`], commandOptions, execImpl)
        .then(({ stdout }) => writeFile(graphLedger, stdout, { mode: 0o600 })),
    ].map((task) => task.catch((error) => { controller.abort(error); throw error; }));
    // Do not enter ROLLBACK while a sibling pg_dump/psql is still using the exported snapshot.
    const settled = await Promise.allSettled(tasks);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    remaining("Postgres capture commit");
    await client.query("COMMIT");
    return { archive, transformed: { auth_users: auth, graph_episodes: graphLedger }, snapshot, snapshotFacts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Capture the complete staging database for importer-owned rollback; never used by exporter. */
export async function captureRollbackPostgres({ client, databaseUrl, directory, execImpl, pgDump = "pg_dump", operationTimeoutMs = OPERATION_TIMEOUT_DEFAULT_MS, terminateGraceMs = 2_000, budget = null, signal }) {
  const remaining = (label) => remainingBudgetMs(budget, operationTimeoutMs, label);
  remaining("rollback capture transaction");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true)", [`${remaining("rollback capture configuration")}ms`]);
    remaining("rollback snapshot export");
    const snap = await client.query("SELECT pg_export_snapshot() AS snapshot");
    const snapshot = snap.rows[0]?.snapshot;
    if (!SNAPSHOT.test(String(snapshot ?? ""))) throw new Error("Postgres exported an invalid rollback snapshot identifier");
    const archive = path.join(directory, "postgres.dump");
    await run(pgDump, ["--format=custom", "--schema=public", `--snapshot=${snapshot}`, `--file=${archive}`, databaseUrl], { timeoutMs: remaining("rollback archive capture"), terminateGraceMs, signal }, execImpl);
    remaining("rollback capture commit");
    await client.query("COMMIT");
    return { archive, snapshot };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// ── Archive TOC filtering ──────────────────────────────────────────────────────────────────────
//
// `pg_restore --clean --section=pre-data` cannot be used: FK drops live in POST-data, so a pre-data
// clean leaves them behind and the replay fails on dependency errors (measured: 86 of them against
// PG18). The replacement is an explicit enumerate-and-drop below, which means the archive must no
// longer be asked to recreate objects that survive — the `public` schema itself, and (for a staging
// rollback archive) the preserved marker table.

const TOC_ENTRY = /^(\d+);\s+(\d+)\s+(\d+)\s+(.*)$/;

/**
 * Structurally drop `SCHEMA public` and its COMMENT/ACL entries from a `pg_restore -l` listing, plus
 * any entry naming a preserved table. Everything else keeps its original order, which is the order
 * pg_restore depends on.
 *
 * @param {string} listing raw `pg_restore --list` output
 * @param {{ omitTables?: readonly string[] }} options
 */
export function filterRestoreList(listing, { omitTables = [] } = {}) {
  const omitted = [];
  const kept = [];
  for (const line of String(listing).split("\n")) {
    const match = TOC_ENTRY.exec(line.trim());
    if (!match) { kept.push(line); continue; }
    const rest = match[4];
    const isSchemaObject = /^SCHEMA\s+-\s+public\b/.test(rest) || /^(COMMENT|ACL)\s+-\s+SCHEMA\s+public\b/.test(rest);
    const namesPreserved = omitTables.some((table) => new RegExp(`(?:^|\\s)${escapeRegExp(table)}(?:\\s|$)`).test(rest));
    if (isSchemaObject || namesPreserved) { omitted.push(rest); continue; }
    kept.push(line);
  }
  return { text: `${kept.join("\n").replace(/\n+$/, "")}\n`, omitted };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeFilteredList({ archive, directory, name, omitTables, execImpl, pgRestore, operationTimeoutMs, terminateGraceMs, signal }) {
  const { stdout } = await run(pgRestore, ["--list", archive], { timeoutMs: operationTimeoutMs, terminateGraceMs, signal }, execImpl);
  const filtered = filterRestoreList(stdout, { omitTables });
  const listPath = path.join(directory, name);
  await writeFile(listPath, filtered.text, { mode: 0o600 });
  return { listPath, omitted: filtered.omitted };
}

// ── Destructive cleanup ────────────────────────────────────────────────────────────────────────

/**
 * "Not owned by an installed extension." Keyed on (classid, objid) — `objid` alone is only unique
 * within its catalog, and this predicate is the single thing standing between the cleanup and
 * dropping an extension's own objects (citext's type, pgvector's operators).
 */
const notExtensionOwned = (catalog, oid) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

const RELATIONS_SQL = `
  SELECT c.relname AS name, c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind::text = ANY($1::text[])
     AND NOT c.relispartition
     AND ${notExtensionOwned("pg_class", "c.oid")}
   ORDER BY c.relname`;

const FUNCTIONS_SQL = `
  SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS ident,
         p.prokind::text AS kind
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
     AND ${notExtensionOwned("pg_proc", "p.oid")}
   ORDER BY 1`;

const TYPES_SQL = `
  SELECT format('%I.%I', n.nspname, t.typname) AS ident
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typtype IN ('e','d')
     AND ${notExtensionOwned("pg_type", "t.oid")}
   ORDER BY 1`;

const quoted = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Reset THIS session's aborted transaction, and report whether it worked.
 *
 * A loader/restore failure inside a transaction leaves the connection in Postgres' aborted state:
 * every subsequent statement on it fails with `25P02 current transaction is aborted, commands
 * ignored until end of transaction block` — measured against PG18 with a deliberately failing
 * transactional migration, where the next thing to break was the recovery path's own
 * `readMarkerSnapshot`. So the reset has to come BEFORE any journal, advisory-lock or marker SQL,
 * not only inside the destructive cleanup.
 *
 * Deliberately just `ROLLBACK`, on the SAME backend:
 *   - `DISCARD ALL` would drop the session advisory locks the whole fence is built on,
 *   - reconnecting would drop them too and change the backend PID the stop-proof is bound to,
 *   - `pg_advisory_unlock_all` would release another holder's fence.
 * A `ROLLBACK` outside a transaction is a no-op warning, so this is safe to call defensively.
 *
 * It returns a verdict instead of throwing because the CALLER's decision depends on it: a session
 * that cannot be reset cannot perform a rollback, and must never be reported as having done one.
 */
export async function resetSessionTransactionState(client) {
  try {
    await client.query("ROLLBACK");
    return { status: "reset" };
  } catch (error) {
    return { status: "reset-failed", detail: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
}

/**
 * Read the preserved marker's exact identity and contents so its survival can be VERIFIED — not
 * assumed — after the restore. Returns null when the target has no marker (production shape).
 */
export async function readMarkerSnapshot(client, table = "staging_marker") {
  const present = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
  if (present.rows[0]?.present !== true) return null;
  const rows = await client.query(`SELECT * FROM public.${quoted(table)}`);
  return { table, rows: rows.rows, columns: rows.fields.map((field) => field.name) };
}

/**
 * The bounded destructive step. Runs in ONE transaction on the caller's exclusive-lock-owning
 * client, drops only the enumerated non-extension `public` application objects, and uses RESTRICT
 * throughout so a dependency outside that set REFUSES instead of cascading into something the
 * importer never enumerated (`staging_ops`, extensions, the preserved marker).
 *
 * A single quoted DROP TABLE over the WHOLE surviving set is what makes internal FK order a
 * non-problem: Postgres resolves ordering within one statement.
 */
export async function cleanPublicApplicationObjects(client, { preserve = PRESERVED_PUBLIC_TABLES } = {}) {
  const keep = new Set(preserve);
  // Explicit boundary before the transaction: a previous injected loader run leaves this session's
  // own temporary objects behind (migration 20260725180000 creates `temporary view slack_repath`),
  // and a temp view over an application table blocks the DROP under RESTRICT on the SECOND restore
  // through the same client. Resolve any failed transaction state first, then discard exactly this
  // session's temporary namespace — never DISCARD ALL, which would drop the advisory locks the
  // whole fence depends on.
  await client.query("ROLLBACK").catch(() => {});
  await client.query("DISCARD TEMP");

  await client.query("BEGIN");
  try {
    const dropped = { views: [], tables: [], sequences: [], functions: [], types: [] };

    const views = (await client.query(RELATIONS_SQL, [["v", "m"]])).rows.filter((row) => !keep.has(row.name));
    const plainViews = views.filter((row) => row.kind === "v").map((row) => `public.${quoted(row.name)}`);
    const matViews = views.filter((row) => row.kind === "m").map((row) => `public.${quoted(row.name)}`);
    if (matViews.length) await client.query(`DROP MATERIALIZED VIEW ${matViews.join(", ")} RESTRICT`);
    if (plainViews.length) await client.query(`DROP VIEW ${plainViews.join(", ")} RESTRICT`);
    dropped.views = views.map((row) => row.name);

    const tables = (await client.query(RELATIONS_SQL, [["r", "p", "f"]])).rows.filter((row) => !keep.has(row.name));
    if (tables.length) await client.query(`DROP TABLE ${tables.map((row) => `public.${quoted(row.name)}`).join(", ")} RESTRICT`);
    dropped.tables = tables.map((row) => row.name);

    // REQUERY after the tables are gone. A cached inventory taken beforehand still lists the
    // identity-owned sequences that the table DROP has just removed automatically, and dropping
    // those again fails the whole transaction.
    const sequences = (await client.query(RELATIONS_SQL, [["S"]])).rows.filter((row) => !keep.has(row.name));
    if (sequences.length) await client.query(`DROP SEQUENCE ${sequences.map((row) => `public.${quoted(row.name)}`).join(", ")} RESTRICT`);
    dropped.sequences = sequences.map((row) => row.name);

    const functions = (await client.query(FUNCTIONS_SQL)).rows;
    for (const row of functions) await client.query(`DROP ${row.kind === "p" ? "PROCEDURE" : "FUNCTION"} ${row.ident} RESTRICT`);
    dropped.functions = functions.map((row) => row.ident);

    const types = (await client.query(TYPES_SQL)).rows;
    if (types.length) await client.query(`DROP TYPE ${types.map((row) => row.ident).join(", ")} RESTRICT`);
    dropped.types = types.map((row) => row.ident);

    await client.query("COMMIT");
    return dropped;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * H1 verification: prove the marker survived with its intended contents before anything boots.
 *
 * Re-materialisation is a repair of last resort and is gated on INDEPENDENTLY verified staging
 * identity — the pinned environment/service facts the importer already measures — because planting
 * a staging marker on a database whose identity is unproven is exactly the failure this
 * discriminator exists to prevent. A source archive that tries to SUPPLY a marker is rejected
 * upstream by the TOC filter, so the table is never written from copied data.
 */
export async function assertMarkerPreserved(client, snapshot, { verifiedStagingTarget = false } = {}) {
  if (!snapshot) return { status: "absent-before-restore" };
  const after = await readMarkerSnapshot(client, snapshot.table);
  // Row ORDER is not part of the contents: `select *` has no defined order, and a difference in it
  // is not a difference in what the marker says.
  const contents = (rows) => rows.map((row) => JSON.stringify(row)).sort().join("\n");
  if (after) {
    if (contents(after.rows) !== contents(snapshot.rows)) {
      throw new Error(`${snapshot.table} survived the restore with different contents; refusing to boot on an ambiguous staging discriminator`);
    }
    return { status: "preserved" };
  }
  if (!verifiedStagingTarget) {
    throw new Error(`${snapshot.table} did not survive the restore and this target's staging identity is not independently verified; refusing to create it`);
  }
  // Re-materialisation reproduces the ONE shape this repo creates. A marker with any other shape is
  // reported rather than silently reshaped into something that reads the same but is not the same.
  if (snapshot.columns.length !== 1 || snapshot.columns[0] !== "note") {
    throw new Error(`${snapshot.table} has an unrecognised shape (${snapshot.columns.join(", ")}); refusing to re-create it from a guess`);
  }
  await client.query(`CREATE TABLE public.${quoted(snapshot.table)}(note text PRIMARY KEY)`);
  for (const row of snapshot.rows) {
    await client.query(`INSERT INTO public.${quoted(snapshot.table)}(note) VALUES ($1) ON CONFLICT DO NOTHING`, [row.note ?? ""]);
  }
  return { status: "rematerialised" };
}

// ── Section-wise install ───────────────────────────────────────────────────────────────────────

async function replaceFromArchive({
  client, databaseUrl, archive, directory, listName, omitTables,
  execImpl, pgRestore, betweenDataAndPostData, verifiedStagingTarget,
  operationTimeoutMs = OPERATION_TIMEOUT_DEFAULT_MS, terminateGraceMs = 2_000, budget = null, signal,
}) {
  const remaining = (label) => remainingBudgetMs(budget, operationTimeoutMs, label);
  // Defensive entry reset. A REPEATED restore through this same client — the rollback that follows
  // a failed refresh, or a daemon's second tick — can arrive with the connection still in the
  // aborted state left by whatever failed, and the very first statement here is a marker read. The
  // cleanup below resets again before its own transaction; both are needed, because the marker read
  // happens first and is the statement PG18 was measured failing on.
  remaining("restore session reset");
  const entry = await resetSessionTransactionState(client);
  if (entry.status !== "reset") {
    throw new Error(`the restore session could not be reset before reading the staging marker (${entry.detail}); refusing to restore through an unusable connection`);
  }
  remaining("restore marker snapshot");
  const marker = await readMarkerSnapshot(client);
  const { listPath } = await writeFilteredList({ archive, directory, name: listName, omitTables, execImpl, pgRestore, operationTimeoutMs: remaining("restore archive listing"), terminateGraceMs, signal });
  remaining("restore destructive cleanup");
  await cleanPublicApplicationObjects(client);
  await run(pgRestore, [`--use-list=${listPath}`, "--section=pre-data", "--dbname", databaseUrl, archive], { timeoutMs: remaining("restore pre-data"), terminateGraceMs, signal }, execImpl);
  await run(pgRestore, [`--use-list=${listPath}`, "--section=data", "--dbname", databaseUrl, archive], { timeoutMs: remaining("restore data"), terminateGraceMs, signal }, execImpl);
  if (betweenDataAndPostData) await betweenDataAndPostData();
  await run(pgRestore, [`--use-list=${listPath}`, "--section=post-data", "--dbname", databaseUrl, archive], { timeoutMs: remaining("restore post-data"), terminateGraceMs, signal }, execImpl);
  remaining("restore marker verification");
  return assertMarkerPreserved(client, marker, { verifiedStagingTarget });
}

/** Section-wise install. The caller owns an exclusive lock on this exact connected client. */
export async function restorePairedPostgres({
  client, databaseUrl, directory, cwd = process.cwd(), env = process.env,
  execImpl, pgRestore = "pg_restore", psql = "psql", verifiedStagingTarget = false,
  operationTimeoutMs = OPERATION_TIMEOUT_DEFAULT_MS, terminateGraceMs = 2_000, budget = null, signal,
}) {
  const archive = path.join(directory, "postgres.dump");
  const auth = path.join(directory, "auth_users.csv");
  const graphLedger = path.join(directory, "graph_episodes.csv");
  const marker = await replaceFromArchive({
    client, databaseUrl, archive, directory, listName: "restore.list",
    // A SOURCE archive never legitimately contains the staging marker. Filtering it is belt and
    // braces against a bundle that tries to supply one; the values themselves are never trusted.
    omitTables: PRESERVED_PUBLIC_TABLES,
    execImpl, pgRestore, verifiedStagingTarget, operationTimeoutMs, terminateGraceMs, budget, signal,
    betweenDataAndPostData: async () => {
      // Projected data must land BEFORE post-data FK constraints, on the same target.
      await run(psql, ["-X", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `\\copy public.auth_users from '${auth.replaceAll("'", "''")}' with (format csv, header true)`], { timeoutMs: remainingBudgetMs(budget, operationTimeoutMs, "restore authentication projection"), terminateGraceMs, signal }, execImpl);
      await run(psql, ["-X", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `\\copy public.graph_episodes from '${graphLedger.replaceAll("'", "''")}' with (format csv, header true)`], { timeoutMs: remainingBudgetMs(budget, operationTimeoutMs, "restore graph ledger projection"), terminateGraceMs, signal }, execImpl);
    },
  });
  remainingBudgetMs(budget, operationTimeoutMs, "copy-ready schema load");
  await loadSchema({ cwd, databaseUrl, env: { ...env, STAGING_DATA_MODE: "copy-ready" }, connectedClient: client });
  return { marker };
}

export async function restoreRollbackPostgres({
  client, databaseUrl, directory, cwd = process.cwd(), env = process.env,
  execImpl, pgRestore = "pg_restore", verifiedStagingTarget = false,
  operationTimeoutMs = OPERATION_TIMEOUT_DEFAULT_MS, terminateGraceMs = 2_000, budget = null, signal,
}) {
  const archive = path.join(directory, "postgres.dump");
  const marker = await replaceFromArchive({
    client, databaseUrl, archive, directory, listName: "rollback.list",
    // A ROLLBACK archive IS a staging dump, so it does contain the marker. One policy for both
    // paths: the LIVE marker is the preserved object and the archive's copy is structurally
    // omitted, so the restore can neither duplicate it nor clean it.
    omitTables: PRESERVED_PUBLIC_TABLES,
    execImpl, pgRestore, verifiedStagingTarget, operationTimeoutMs, terminateGraceMs, budget, signal,
  });
  remainingBudgetMs(budget, operationTimeoutMs, "rollback schema load");
  await loadSchema({ cwd, databaseUrl, env: { ...env, STAGING_DATA_MODE: env.STAGING_DATA_MODE ?? "copy-ready" }, connectedClient: client });
  return { marker };
}
