import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pairedDumpArguments, transformedAuthUserProjection, transformedGraphEpisodeProjection } from "./pg-sanitize.mjs";
import { loadSchema } from "../pg-load-schema.mjs";
import { SCRUBBED_PG_ENV } from "../staging-refresh-decision.mjs";

const exec = promisify(execFile);
const SNAPSHOT = /^[0-9A-Fa-f:-]+$/;

async function run(command, args, options = {}, execImpl = exec) {
  const env = { ...(options.env ?? process.env) };
  for (const name of SCRUBBED_PG_ENV) delete env[name];
  try { return await execImpl(command, args, { maxBuffer: 16 * 1024 * 1024, ...options, env }); }
  catch (error) { throw new Error(`${command} failed: ${String(error?.stderr ?? error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]").slice(0, 500)}`); }
}

/** Hold the source snapshot transaction until both pg_dump and transformed COPY have finished. */
export async function capturePairedPostgres({ client, databaseUrl, directory, execImpl, pgDump = "pg_dump", psql = "psql", captureSnapshotFacts }) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snap = await client.query("SELECT pg_export_snapshot() AS snapshot");
    const snapshot = snap.rows[0]?.snapshot;
    if (!SNAPSHOT.test(String(snapshot ?? ""))) throw new Error("Postgres exported an invalid snapshot identifier");
    // Authorization, partition and schema/build facts must be read by this same transaction;
    // a follow-up connection could observe a different access state than the dump snapshot.
    const snapshotFacts = captureSnapshotFacts ? await captureSnapshotFacts(client) : undefined;
    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='auth_users' ORDER BY ordinal_position");
    const projection = transformedAuthUserProjection(cols.rows.map((row) => row.column_name));
    const graphCols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='graph_episodes' ORDER BY ordinal_position");
    const graphProjection = transformedGraphEpisodeProjection(graphCols.rows.map((row) => row.column_name));
    const archive = path.join(directory, "postgres.dump");
    const auth = path.join(directory, "auth_users.csv");
    const graphLedger = path.join(directory, "graph_episodes.csv");
    await Promise.all([
      run(pgDump, [...pairedDumpArguments(snapshot, archive), databaseUrl], {}, execImpl),
      run(psql, ["-X", "--quiet", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; COPY (SELECT ${projection} FROM public.auth_users) TO STDOUT WITH (FORMAT csv, HEADER true); COMMIT;`], {}, execImpl)
        .then(({ stdout }) => import("node:fs/promises").then(({ writeFile }) => writeFile(auth, stdout, { mode: 0o600 }))),
      run(psql, ["-X", "--quiet", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; COPY (SELECT ${graphProjection} FROM public.graph_episodes) TO STDOUT WITH (FORMAT csv, HEADER true); COMMIT;`], {}, execImpl)
        .then(({ stdout }) => import("node:fs/promises").then(({ writeFile }) => writeFile(graphLedger, stdout, { mode: 0o600 }))),
    ]);
    await client.query("COMMIT");
    return { archive, transformed: { auth_users: auth, graph_episodes: graphLedger }, snapshot, snapshotFacts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Capture the complete staging database for importer-owned rollback; never used by exporter. */
export async function captureRollbackPostgres({ client, databaseUrl, directory, execImpl, pgDump = "pg_dump" }) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snap = await client.query("SELECT pg_export_snapshot() AS snapshot");
    const snapshot = snap.rows[0]?.snapshot;
    if (!SNAPSHOT.test(String(snapshot ?? ""))) throw new Error("Postgres exported an invalid rollback snapshot identifier");
    const archive = path.join(directory, "postgres.dump");
    await run(pgDump, ["--format=custom", "--schema=public", `--snapshot=${snapshot}`, `--file=${archive}`, databaseUrl], {}, execImpl);
    await client.query("COMMIT");
    return { archive, snapshot };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Section-wise install. The caller owns an exclusive lock on this exact connected client. */
export async function restorePairedPostgres({ client, databaseUrl, directory, cwd = process.cwd(), env = process.env, execImpl, pgRestore = "pg_restore", psql = "psql" }) {
  const archive = path.join(directory, "postgres.dump");
  const auth = path.join(directory, "auth_users.csv");
  const graphLedger = path.join(directory, "graph_episodes.csv");
  await run(pgRestore, ["--clean", "--if-exists", "--section=pre-data", "--dbname", databaseUrl, archive], {}, execImpl);
  await run(pgRestore, ["--section=data", "--dbname", databaseUrl, archive], {}, execImpl);
  await run(psql, ["-X", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `\\copy public.auth_users from '${auth.replaceAll("'", "''")}' with (format csv, header true)`], {}, execImpl);
  await run(psql, ["-X", databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `\\copy public.graph_episodes from '${graphLedger.replaceAll("'", "''")}' with (format csv, header true)`], {}, execImpl);
  await run(pgRestore, ["--section=post-data", "--dbname", databaseUrl, archive], {}, execImpl);
  await loadSchema({ cwd, databaseUrl, env: { ...env, STAGING_DATA_MODE: "copy-ready" }, connectedClient: client });
}

export async function restoreRollbackPostgres({ client, databaseUrl, directory, cwd = process.cwd(), env = process.env, execImpl, pgRestore = "pg_restore" }) {
  const archive = path.join(directory, "postgres.dump");
  await run(pgRestore, ["--clean", "--if-exists", "--section=pre-data", "--dbname", databaseUrl, archive], {}, execImpl);
  await run(pgRestore, ["--section=data", "--dbname", databaseUrl, archive], {}, execImpl);
  await run(pgRestore, ["--section=post-data", "--dbname", databaseUrl, archive], {}, execImpl);
  await loadSchema({ cwd, databaseUrl, env: { ...env, STAGING_DATA_MODE: env.STAGING_DATA_MODE ?? "copy-ready" }, connectedClient: client });
}
