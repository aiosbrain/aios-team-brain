import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import { diffFingerprints, fingerprint } from "../../scripts/schema-fingerprint.mjs";
import { filterRestoreList } from "../../scripts/staging-ops/pg-paired.mjs";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — MR-02 catalog fidelity for the Slack-owned objects
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §9.3 MR-02, §10 DH-11).
 *
 * WHAT THIS FILE PROVES (three tests):
 *  1. MR-02 FROM-ZERO PARITY. Two scratch databases are built by the REAL loader
 *     (`scripts/pg-load-schema.mjs`):
 *     · one from `postgres/schema.sql` ALONE (the loader with its migrations directory reported
 *       absent);
 *     · one by the full deploy path: `schema.sql`, then every effective migration in the loader's
 *       own lexical order.
 *     Both are read by the repository's catalog fingerprint (`scripts/schema-fingerprint.mjs`).
 *     The fingerprint covers relation, columns (type/default/nullability/identity/generated/
 *     collation, NOT attnum), indexes, constraints, functions (`pg_get_functiondef`) and triggers.
 *     Every line owned by `slack_sync_channels`, `slack_channel_cursor_history_valid(…)` or
 *     `slack_sync_channels_clear_deleted_binding(…)` must be identical. A whitespace-exact second
 *     read also compares the four named CHECKs (`pg_get_constraintdef`, validated) and the
 *     validator's metadata and `prosrc`, because the fingerprint collapses whitespace inside
 *     bodies. Non-vacuity: every accepted identity (8 columns, 4 CHECKs, the validator, the
 *     trigger and its function) must appear on both sides.
 *  2. MR-02 DUMP → RESTORE → REPLAY. The loader-path database is seeded with synthetic rows:
 *     · a populated channel with initialized segments on both lanes, both histories and the
 *       aggregate;
 *     · an idle channel;
 *     · an unrelated queued thread.
 *     It is dumped by the REAL `pg_dump` (`--format=custom --schema=public`, the archive shape
 *     the staging rollback path captures). It is restored by the REAL `pg_restore`
 *     (`--exit-on-error --single-transaction`) into a fresh database, reusing the staging path's
 *     own `filterRestoreList` so the pre-existing `public` schema is not recreated. pg_restore
 *     runs every restore session under an EMPTY search_path: the archive's DDL is asserted to
 *     carry `set_config('search_path', '', false)` and the schema-qualified validator call in the
 *     CHECKs. On a FRESH connection, the restored database must match the source:
 *     · the Slack-owned fingerprint;
 *     · the exact CHECK definitions;
 *     · the validator's metadata and body;
 *     · the whole channel and thread rows (md5 digests only).
 *     Then the EXACT migration file is replayed on another fresh session. It must commit with no
 *     NOTICE, and leave the restored catalog and rows byte-identical.
 *  3. MR-02 / DH-11 "NO NEW MIRROR EXCEPTION": `MIRROR_EXCEPTIONS` in
 *     `scripts/migrate-from-existing.mjs` names no Slack history/segment object. The file is read
 *     as text: importing it would install its SIGINT/SIGTERM handlers in the test worker.
 *
 * MUTATION REACH. Each of these turns a named assertion red:
 *  - drift in the mirrored block or in the from-zero columns: the schema-only build differs from
 *    the loader build, or the migration refuses the drifted catalog and the loader fails;
 *  - drift in a validator attribute or body: the metadata/`prosrc` read, or the guard's refusal;
 *  - drift in a CHECK's text: the exact `pg_get_constraintdef` read, on either test;
 *  - anything a dump or restore loses or re-parses differently: the restored-vs-source reads;
 *  - a non-idempotent replay: the post-replay reads, or the notice capture.
 *
 * COMPLEMENTARY GLOBAL EVIDENCE (not duplicated here): `npm run test:migrate-from-existing`
 * (`--mirror-check`) diffs the WHOLE schema-only and loader fingerprints, under its documented
 * exceptions. `npm run test:migrate-from-existing:sweep` deletes each migration in turn.
 * `check-constraint-dump-roundtrip` re-parses every public CHECK's deparsed text. This file adds
 * the AIO-1170-specific exact reads and the REAL dump/restore those do not perform.
 *
 * TOOLCHAIN. `pg_dump`/`pg_restore` must be on PATH at a major version ≥ the server's (pg_dump
 * refuses a newer server). CI's datamechanics job installs `postgresql-client-16` against the
 * `postgres:16` service. The isolated runner (`scripts/dm-isolated.sh`) runs vitest on the host,
 * so the host needs PostgreSQL ≥ 16 client tools. The test asserts this precondition by name
 * before dumping, so a missing tool fails as a stated precondition, not as evidence. PG* variables
 * are scrubbed from the child environment, and the archive lives in a disposable temp directory
 * removed afterwards.
 *
 * PRIVACY. Rows hold only synthetic cursor/history values, and rows are compared only by md5
 * digest. A failing tool is reported with its exit code and its `error:` lines only, with database
 * URLs redacted and any COPY/row context dropped. The DDL-only script is inspected with `includes`
 * and never printed.
 *
 * NOT CLAIMED: MR-03/MR-04/MR-05/MR-06, runtime behavior, the staging refresh pipeline end to end,
 * and non-Slack objects' dump fidelity (`check-constraint-dump-roundtrip` and the staging specs
 * own those).
 */

const SCRATCH_TIMEOUT = 300_000;
const ROOT = process.cwd();
const MIGRATION_PATH = join(ROOT, "postgres", "migrations", "20261023120000_slack_channel_history_segments.sql");
const MIGRATE_FROM_EXISTING_PATH = join(ROOT, "scripts", "migrate-from-existing.mjs");

const NEW_COLUMNS = [
  "historical_completed_segments_oldest_ts", "historical_cursor_history", "historical_segment_lower_ts",
  "historical_segment_upper_ts", "newest_cursor_history", "newest_request_lower_ts", "newest_segment_lower_ts",
  "newest_segment_upper_ts",
];
const NAMED_CHECKS = [
  "slack_sync_channels_historical_cursor_history_check", "slack_sync_channels_historical_progress_check",
  "slack_sync_channels_newest_cursor_history_check", "slack_sync_channels_newest_progress_check",
];
/** Fingerprint identities (`kind\tident`) that must exist on every side, so no comparison is vacuous. */
const REQUIRED_IDENTS = [
  "relation\tslack_sync_channels",
  ...NEW_COLUMNS.map((column) => `column\tslack_sync_channels.${column}`),
  ...NAMED_CHECKS.map((name) => `constraint\tslack_sync_channels.${name}`),
  "function\tslack_channel_cursor_history_valid(history jsonb)",
  "function\tslack_sync_channels_clear_deleted_binding()",
  "trigger\tslack_sync_channels.slack_sync_channels_clear_deleted_binding",
];

const identOf = (line: string): string => line.split("\t").slice(0, 2).join("\t");
/** The fingerprint lines this block owns or touches: the table's own objects and its two functions. */
const isSlackOwned = (line: string): boolean => {
  const ident = line.split("\t")[1] ?? "";
  return ident === "slack_sync_channels" || ident.startsWith("slack_sync_channels.")
    || ident.startsWith("slack_channel_cursor_history_valid(") || ident.startsWith("slack_sync_channels_clear_deleted_binding(");
};
const missingRequired = (lines: string[]): string[] => {
  const present = new Set(lines.map(identOf));
  return REQUIRED_IDENTS.filter((ident) => !present.has(ident));
};

/**
 * The isolated runner's URL shape, and nothing else: a loopback host, a port that is present and is
 * not the shared 5434 service, and the `app_test` database. The error never prints the URL.
 */
function requireIsolatedTestUrl(raw: string | undefined): string {
  const refuse = (): never => {
    throw new Error("refusing to run: DATABASE_TEST_URL is not the isolated data-mechanics runner's database");
  };
  if (!raw) return refuse();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  if (!loopback || parsed.port === "" || parsed.port === "5434" || parsed.pathname !== "/app_test") return refuse();
  return raw;
}

const execFileAsync = promisify(execFile);
/** A real client tool, PG* scrubbed; failure reports exit code and redacted `error:` lines only. */
async function runTool(tool: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PG")));
  try {
    const { stdout } = await execFileAsync(tool, args, { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 240_000 });
    return stdout;
  } catch (error) {
    const e = (error ?? {}) as { code?: unknown; stderr?: unknown };
    const errors = String(e.stderr ?? "").split("\n")
      .filter((line) => /^(pg_dump|pg_restore): error:/.test(line) && !/COPY|Failing row|line \d+:/i.test(line))
      .map((line) => line.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 300));
    throw new Error(`${tool} failed (exit ${String(e.code)}): ${errors.join(" | ") || "no error line"}`);
  }
}
const toolMajor = async (tool: string): Promise<number | null> => {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(await runTool(tool, ["--version"]));
  return match ? Number(match[1]) : null;
};

/** The whitespace-exact reads the fingerprint's collapsing would blur. */
const exactSlackCatalog = async (client: Client) => ({
  checks: (await client.query(
    `select conname as name, contype::text as kind, pg_catalog.pg_get_constraintdef(oid) as definition, convalidated as validated
       from pg_catalog.pg_constraint
      where conrelid = 'public.slack_sync_channels'::pg_catalog.regclass and conname = any($1::text[])
      order by conname collate "C"`, [NAMED_CHECKS]
  )).rows,
  validator: (await client.query(
    `select p.prokind::text as kind, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
            pg_catalog.format_type(p.prorettype, null) as returns, l.lanname as language,
            p.provolatile::text as volatility, p.proisstrict as strict, p.proparallel::text as parallel,
            p.prosecdef as security_definer, p.proleakproof as leakproof, p.proretset as returns_set,
            p.proconfig as config, p.proargnames as arg_names, p.pronargdefaults::int as arg_defaults,
            p.prosupport::text as support, p.prosrc as source
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and p.proname = 'slack_channel_cursor_history_valid'`
  )).rows,
});
/** Whole channel and thread rows, digested: equality proves byte-identical rows without printing one. */
const rowDigests = async (client: Client) => (await client.query<{ channels: string; threads: string; channel_rows: number; thread_rows: number }>(
  `select (select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(s)::text, '|' order by s.channel_id collate "C")), 'no rows')
             from public.slack_sync_channels s) as channels,
          (select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, '|' order by t.root_ts collate "C")), 'no rows')
             from public.slack_sync_threads t) as threads,
          (select pg_catalog.count(*)::int from public.slack_sync_channels) as channel_rows,
          (select pg_catalog.count(*)::int from public.slack_sync_threads) as thread_rows`
)).rows[0];

describe("AM-F2 + AC-02 history/segment block — mirror-exception fence (MR-02 / DH-11, static)", () => {
  it("MR-02 MIRROR_EXCEPTIONS excuses no Slack history/segment object", () => {
    const source = readFileSync(MIGRATE_FROM_EXISTING_PATH, "utf8");
    const start = source.indexOf("export const MIRROR_EXCEPTIONS = {");
    const end = source.indexOf("\n};", start);
    const block = start >= 0 && end > start ? source.slice(start, end) : "";
    expect({ found: block.length > 0, entries: (block.match(/^\s*"[a-z]+\\t/gm) ?? []).length > 0 },
      "fixture: the MIRROR_EXCEPTIONS allowlist was located and is non-empty").toEqual({ found: true, entries: true });
    expect(/slack_sync_channels|slack_channel_/.test(block), "MIRROR_EXCEPTIONS names a Slack history/segment object").toBe(false);
  });
});

describe("AM-F2 + AC-02 history/segment block — MR-02 catalog fidelity (real Postgres, real loader, real pg_dump/pg_restore)", () => {
  let adminUrl = "";
  const created: string[] = [];
  const urls: Record<"schemaOnly" | "loader", string> = { schemaOnly: "", loader: "" };

  const urlFor = (database: string): string => {
    const target = new URL(adminUrl);
    target.pathname = `/${database}`;
    return target.toString();
  };
  const createScratch = async (role: string): Promise<string> => {
    const name = `slackmr02_${role}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`create database ${name}`);
    } finally {
      await admin.end().catch(() => {});
    }
    created.push(name);
    return urlFor(name);
  };
  /** A FRESH session for every read, so nothing is observed through a session that wrote it. */
  const withClient = async <T,>(url: string, run: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end().catch(() => {});
    }
  };
  const slackFingerprint = (url: string): Promise<string[]> =>
    withClient(url, async (client) => ((await fingerprint(client)) as string[]).filter(isSlackOwned));

  beforeAll(async () => {
    // Refused BEFORE any connection or database creation.
    adminUrl = requireIsolatedTestUrl(process.env.DATABASE_TEST_URL);
    urls.schemaOnly = await createScratch("schema");
    urls.loader = await createScratch("loader");
    const quiet = { log: () => {} };
    // schema.sql ALONE: the real loader with its migrations directory reported absent.
    await loadSchema({ cwd: ROOT, databaseUrl: urls.schemaOnly, logger: quiet, exists: () => false });
    // The deploy path: schema.sql, then every effective migration in the loader's own order.
    await loadSchema({ cwd: ROOT, databaseUrl: urls.loader, logger: quiet });
  }, SCRATCH_TIMEOUT);

  afterAll(async () => {
    if (!adminUrl) return;
    // Cleanup never replaces the primary failure: every step is caught, as the repository precedent does.
    const dropper = new Client({ connectionString: adminUrl });
    await dropper.connect().catch(() => {});
    for (const name of created) await dropper.query(`drop database if exists ${name} with (force)`).catch(() => {});
    await dropper.end().catch(() => {});
  }, SCRATCH_TIMEOUT);

  it("MR-02 schema.sql alone and schema.sql plus every migration have identical Slack-owned catalogs", async () => {
    const schemaOnly = await slackFingerprint(urls.schemaOnly);
    const loader = await slackFingerprint(urls.loader);
    expect({ schemaOnly: missingRequired(schemaOnly), loader: missingRequired(loader) },
      "non-vacuity: every accepted Slack history/segment identity is present on both sides").toEqual({ schemaOnly: [], loader: [] });
    const drift = diffFingerprints(loader, schemaOnly);
    expect({ missingFromSchemaOnly: drift.missing, extraInSchemaOnly: drift.extra },
      `Slack-owned fingerprint drift between schema.sql alone and the loader path:\n${drift.text}`).toEqual({
      missingFromSchemaOnly: [], extraInSchemaOnly: [],
    });
    const exactSchemaOnly = await withClient(urls.schemaOnly, exactSlackCatalog);
    const exactLoader = await withClient(urls.loader, exactSlackCatalog);
    expect({ checks: exactLoader.checks.length, validators: exactLoader.validator.length },
      "non-vacuity: four named CHECKs and one validator on the loader path").toEqual({ checks: 4, validators: 1 });
    expect(exactSchemaOnly, "the four CHECK definitions (whitespace-exact) and the validator's metadata and body are identical on both paths").toEqual(exactLoader);
  }, SCRATCH_TIMEOUT);

  it("MR-02 a real pg_dump → pg_restore under an empty search_path preserves the Slack catalog and rows, and a replay changes nothing", async () => {
    // ── Synthetic population on the loader-path database. ──
    const teamId = "8d4e5f60-7182-4d9e-9fa0-3b4c5d6e7f80";
    await withClient(urls.loader, async (client) => {
      await client.query("set time zone 'UTC'");
      await client.query(`insert into teams (id, slug, name) values ($1, 'mr02-team', 'MR02 Team')`, [teamId]);
      await client.query(
        `insert into public.slack_sync_channels
           (team_id, workspace_id, channel_id, public_state, public_checked_at,
            newest_anchor_ts, newest_lower_ts, newest_request_lower_ts, newest_segment_lower_ts, newest_segment_upper_ts,
            newest_cursor, newest_cursor_history, newest_scan_generation,
            historical_anchor_ts, historical_segment_lower_ts, historical_segment_upper_ts,
            historical_completed_segments_oldest_ts, historical_oldest_seen_ts,
            historical_cursor, historical_cursor_history, historical_scan_generation,
            completed_lower_ts, completed_upper_ts, newest_catchup_upper_ts,
            metadata_attempt_owner, metadata_attempt_generation, attempts, last_error_code,
            last_read_at, due_at, created_at, updated_at)
         values ($1, 'T0MR02CAT1', 'C0MR02ROW01', 'public', '2026-01-01 00:00:00+00',
                 '1718900800.000000', '1718900700.000000', '1718900640.000000', '1718900640.000000', '1718900800.000000',
                 'syn-n-2', $2::jsonb, 4,
                 '1718900500.000000', '0.000000', '1718900300.000000',
                 '1718900350.5', '1718900250.000100',
                 'syn-h-1', $3::jsonb, 3,
                 '1718895000.000000', '1718895100.000000', '1718900900.000000',
                 'metadata-owner-mr02', 3, 2, 'rate_limited',
                 '2026-01-01 12:00:00+00', '2026-01-02 00:00:00+00', '2025-12-31 00:00:00+00', '2026-01-02 03:04:05+00')`,
        [teamId, JSON.stringify(["syn-n-1", "syn-n-2"]), JSON.stringify(["syn-h-1"])]
      );
      await client.query(
        `insert into public.slack_sync_channels (team_id, workspace_id, channel_id, updated_at)
         values ($1, 'T0MR02CAT1', 'C0MR02IDLE1', '2026-01-02 03:04:05+00')`, [teamId]
      );
      await client.query(
        `insert into public.slack_sync_threads (team_id, workspace_id, channel_id, root_ts, due_at, attempts)
         values ($1, 'T0MR02CAT1', 'C0MR02ROW01', '1718900200.000200', '2026-01-09 00:00:00+00', 1)`, [teamId]
      );
    });
    const sourceFingerprint = await slackFingerprint(urls.loader);
    const sourceExact = await withClient(urls.loader, exactSlackCatalog);
    const sourceRows = await withClient(urls.loader, rowDigests);
    expect({ channelRows: sourceRows.channel_rows, threadRows: sourceRows.thread_rows, missing: missingRequired(sourceFingerprint) },
      "non-vacuity: the source holds two channel rows, one thread row and every accepted identity").toEqual({
      channelRows: 2, threadRows: 1, missing: [],
    });

    // ── Toolchain precondition, stated by name. ──
    const serverMajor = await withClient(urls.loader, async (client) =>
      (await client.query<{ major: number }>("select (pg_catalog.current_setting('server_version_num')::int / 10000) as major")).rows[0].major);
    const dumpMajor = await toolMajor("pg_dump");
    const restoreMajor = await toolMajor("pg_restore");
    expect({ pgDumpAtLeastServer: (dumpMajor ?? 0) >= serverMajor, pgRestoreAtLeastServer: (restoreMajor ?? 0) >= serverMajor },
      `toolchain precondition: pg_dump/pg_restore on PATH must be PostgreSQL >= the server's major ${serverMajor}`).toEqual({
      pgDumpAtLeastServer: true, pgRestoreAtLeastServer: true,
    });

    const directory = await mkdtemp(join(tmpdir(), "slack-mr02-"));
    try {
      // ── The REAL dump, in the staging rollback path's archive shape. ──
      const archive = join(directory, "slack-mr02.dump");
      await runTool("pg_dump", ["--format=custom", "--schema=public", `--file=${archive}`, urls.loader]);
      // The restore's DDL (no data): an EMPTY search_path, and the schema-qualified validator in the CHECKs.
      const ddl = await runTool("pg_restore", ["--schema-only", "--file=-", archive]);
      expect({
        emptySearchPath: ddl.includes("SELECT pg_catalog.set_config('search_path', '', false);"),
        // Only a CHECK body renders the call after WHEN; the function's own CREATE does not.
        qualifiedValidator: ddl.includes("WHEN public.slack_channel_cursor_history_valid("),
        namesEveryCheck: NAMED_CHECKS.every((name) => ddl.includes(name)),
      }, "the archive restores under an empty search_path, with the qualified validator and every named CHECK").toEqual({
        emptySearchPath: true, qualifiedValidator: true, namesEveryCheck: true,
      });
      // The staging path's own TOC filter: the fresh database already has `public`.
      const listPath = join(directory, "slack-mr02.list");
      await writeFile(listPath, filterRestoreList(await runTool("pg_restore", ["--list", archive])).text, { mode: 0o600 });

      // ── The REAL restore into a fresh database (citext pre-installed, as schema.sql would). ──
      const restoredUrl = await createScratch("restored");
      await withClient(restoredUrl, async (client) => {
        await client.query("create extension if not exists citext");
      });
      await runTool("pg_restore", [
        "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
        `--use-list=${listPath}`, `--dbname=${restoredUrl}`, archive,
      ]);

      // ── Restored == source, read on fresh sessions. ──
      const restoredFingerprint = await slackFingerprint(restoredUrl);
      const restoreDrift = diffFingerprints(sourceFingerprint, restoredFingerprint);
      expect({ lost: restoreDrift.missing, gained: restoreDrift.extra },
        `Slack-owned fingerprint drift across dump/restore:\n${restoreDrift.text}`).toEqual({ lost: [], gained: [] });
      expect(await withClient(restoredUrl, exactSlackCatalog),
        "the restored CHECK definitions (whitespace-exact) and validator metadata/body equal the source's").toEqual(sourceExact);
      expect(await withClient(restoredUrl, rowDigests), "the restored channel and thread rows are byte-identical to the source's").toEqual(sourceRows);

      // ── Replay the EXACT migration entrypoint on a fresh session of the restored database. ──
      const migration = readFileSync(MIGRATION_PATH, "utf8");
      const replay = await withClient(restoredUrl, async (client) => {
        const notices: string[] = [];
        client.on("notice", (notice: { message?: string }) => notices.push(notice.message ?? ""));
        try {
          await client.query(migration);
          return { outcome: "committed", notices };
        } catch (error) {
          const e = (error ?? {}) as { code?: unknown };
          return { outcome: `refused (${String(e.code)})`, notices };
        }
      });
      expect(replay, "the migration replays over the restored database: committed, no NOTICE or WARNING").toEqual({ outcome: "committed", notices: [] });
      const replayedFingerprint = await slackFingerprint(restoredUrl);
      const replayDrift = diffFingerprints(restoredFingerprint, replayedFingerprint);
      expect({ lost: replayDrift.missing, gained: replayDrift.extra },
        `Slack-owned fingerprint drift caused by the replay:\n${replayDrift.text}`).toEqual({ lost: [], gained: [] });
      expect(await withClient(restoredUrl, exactSlackCatalog), "after replay: CHECK definitions and validator metadata/body unchanged").toEqual(sourceExact);
      expect(await withClient(restoredUrl, rowDigests), "after replay: every channel and thread row byte-identical, updated_at included").toEqual(sourceRows);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }, SCRATCH_TIMEOUT);
});
