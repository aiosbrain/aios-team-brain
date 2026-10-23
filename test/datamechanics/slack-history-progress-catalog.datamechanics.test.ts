import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import { diffFingerprints, fingerprint } from "../../scripts/schema-fingerprint.mjs";
import { filterRestoreList } from "../../scripts/staging-ops/pg-paired.mjs";
import { createIsolatedScratchDatabase } from "./slack-history-isolated-url";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — MR-02 catalog fidelity for the Slack-owned objects
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §9.3 MR-02, §10 DH-11).
 *
 * PLACEMENT: this sibling is the Astra-approved Packet 5 placement amendment, for MR-02 ONLY. It does
 * not complete MR-06 (held until PR743 staging) and does not widen production scope.
 *
 * ISOLATION: every scratch database is created only after the shared `DATABASE_TEST_URL` guard
 * (`./slack-history-isolated-url.ts`, tested by `test/slack-history-isolated-url.test.ts`) accepts
 * the URL: the isolated local runner, or CI's `postgres:5432` service under `GITHUB_ACTIONS=true`.
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
 *     Every Slack-owned line must be identical: every relation, column, index, constraint,
 *     trigger, function, enum, domain or sequence whose identity starts with `slack_` (so every
 *     `slack_*` table, not only `slack_sync_channels`, and every `slack_*` function and type). A
 *     whitespace-exact second
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
 *     Then two replays run, each on fresh sessions, and each must leave the restored Slack
 *     fingerprint, the exact reads and the row digests byte-identical:
 *     · the EXACT migration file, which must commit with no NOTICE;
 *     · the deploy loader (`loadSchema`: `schema.sql`, then every migration). Its notices are not
 *       asserted, because `schema.sql`'s own `if not exists` DDL is allowed to notice.
 *  3. MR-02 / DH-11 "NO NEW MIRROR EXCEPTION": `MIRROR_EXCEPTIONS` in
 *     `scripts/migrate-from-existing.mjs` holds EXACTLY its five current keys (three indexes and two
 *     CHECKs, none Slack-owned). Any added, removed or renamed key, Slack or not, fails here and
 *     needs review. The file is read as text: importing it would install its SIGINT/SIGTERM
 *     handlers in the test worker.
 *
 * MUTATION REACH, stated by design and NOT measured by a mutation harness. These are the
 * assertions intended to catch each class:
 *  - drift between the mirrored block or from-zero columns and the migration: test 1's
 *    fingerprint diff or exact reads, or a refusal that fails the loader build in `beforeAll`;
 *  - drift in a validator attribute or body, or in a CHECK's text: test 1's exact reads;
 *  - a dump or restore that loses or re-parses an object or row: test 2's restored-vs-source reads;
 *  - a non-idempotent replay: test 2's post-replay reads, or its migration-replay notice capture.
 *
 * COMPLEMENTARY GLOBAL EVIDENCE (not duplicated here): `npm run test:migrate-from-existing`
 * (`--mirror-check`) diffs the WHOLE schema-only and loader fingerprints, under its documented
 * exceptions. `npm run test:migrate-from-existing:sweep` deletes each migration in turn.
 * `check-constraint-dump-roundtrip` re-parses every public CHECK's deparsed text. This file adds
 * the AIO-1170-specific exact reads and the REAL dump/restore those do not perform.
 *
 * TOOLCHAIN. The round trip needs pg_dump and pg_restore of EXACTLY the server's major:
 *  - an older pg_dump refuses to dump the newer server;
 *  - a newer one writes session settings the older server rejects on restore (PostgreSQL 18
 *    tools against a 16 server fail on `transaction_timeout`).
 * Neither failure is product evidence. Selection, in order:
 *  1. Host pairs, after `scripts/staging-refresh.sh`'s discipline:
 *     · `PG_BIN` when set is the ONLY host candidate (an explicit pin is honored or refused, and
 *       never silently overridden);
 *     · otherwise each PATH directory, in PATH order;
 *     · then the installed Homebrew keg of exactly the server's major
 *       (`/opt/homebrew/opt/postgresql@<major>/bin`, or `/usr/local/opt/...`).
 *     A host candidate qualifies only if ONE directory holds both tools and both report exactly
 *     the server's major. A mismatched pair (PATH 14, Homebrew 18) is recorded and skipped, never
 *     used. Host discovery is offline: two directory listings, no download, no install.
 *  2. Otherwise, unless `PG_BIN` pins the host, the client tools INSIDE the isolated data-mechanics
 *     container that owns `DATABASE_TEST_URL`. It is identified only from the runner's own facts:
 *     · exactly ONE running container publishes the URL's host port as `->5432/tcp`
 *       (`scripts/dm-isolated.sh` uses `-p 0:5432`);
 *     · it has the runner's `aios-dm-<8 hex>` name shape (no worktree hash assumed);
 *     · its image is `postgres:<major>`;
 *     · its cluster `system_identifier` equals the one read through `DATABASE_TEST_URL`;
 *     · its own `pg_dump` and `pg_restore` both report exactly the server's major.
 *     Any ambiguity or mismatch refuses this route. Its proof is still a REAL custom-format
 *     `pg_dump` and a REAL `pg_restore`, run by `docker exec` against the SAME scratch databases
 *     through the container's own loopback (`127.0.0.1:5432`):
 *     · the archive is written into a private `mkdir -m 700` directory inside that container;
 *     · the filtered TOC list is written on the host and `docker cp`'d in;
 *     · the directory is removed in `finally`.
 *     Nothing in the archive is edited or stripped.
 * CI's datamechanics job has `postgresql-client-16` on PATH against the `postgres:16` service, so
 * the PATH pair remains its first successful route. If no route qualifies, a named precondition
 * fails. It lists every host directory that held BOTH tools, with their majors (a directory missing
 * either tool is skipped silently), and every container fact checked (count, name, image, booleans
 * and majors); never URLs or credentials. PG* variables are scrubbed from every child environment, and
 * the host temp directory is removed afterwards.
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
/**
 * Every Slack-owned fingerprint line. Every fingerprint identity is either a top-level name
 * (relation, function `name(args)`, enum, domain, sequence) or `table.object` (column, index,
 * constraint, trigger, policy), so one `slack_` prefix selects every `slack_*` relation with its
 * dependents, every `slack_*` function and every `slack_*` type.
 */
const isSlackOwned = (line: string): boolean => (line.split("\t")[1] ?? "").startsWith("slack_");
/** `scripts/migrate-from-existing.mjs` `MIRROR_EXCEPTIONS`, key for key, exactly as its source spells them. */
const EXPECTED_MIRROR_EXCEPTION_KEYS = [
  "index\\tchat_messages.chat_messages_search_idx",
  "index\\tgraph_episodes.graph_episodes_pending_delete_idx",
  "index\\titems.items_team_work_at_idx",
  "constraint\\tmembers.members_kind_check",
  "constraint\\tprojects.projects_kind_check",
];
const missingRequired = (lines: string[]): string[] => {
  const present = new Set(lines.map(identOf));
  return REQUIRED_IDENTS.filter((ident) => !present.has(ident));
};

const execFileAsync = promisify(execFile);
/**
 * A real process (a host client tool, or `docker`), PG* scrubbed from its environment. Failure
 * reports a bounded label, the exit code and the redacted `error:` lines only: never a URL, never
 * COPY/row context.
 */
async function runTool(tool: string, args: string[], label = tool): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PG")));
  try {
    const { stdout } = await execFileAsync(tool, args, { env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 240_000 });
    return stdout;
  } catch (error) {
    const e = (error ?? {}) as { code?: unknown; stderr?: unknown };
    const errors = String(e.stderr ?? "").split("\n")
      .filter((line) => /^(pg_dump|pg_restore|psql): error:|^Error( response from daemon)?:/.test(line) && !/COPY|Failing row|line \d+:/i.test(line))
      .map((line) => line.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted database URL]").slice(0, 300));
    throw new Error(`${label} failed (exit ${String(e.code)}): ${errors.join(" | ") || "no error line"}`);
  }
}
/** The PostgreSQL major a `--version` invocation reports, or null if it cannot be read. */
const toolMajor = async (tool: string, prefix: string[] = []): Promise<number | null> => {
  try {
    const match = /\(PostgreSQL\)\s+(\d+)/.exec(await runTool(tool, [...prefix, "--version"]));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

/** One pg_dump/pg_restore PAIR from a single bin directory, with both reported majors. */
interface PgClientPair {
  bin: string;
  source: string;
  dumpMajor: number;
  restoreMajor: number;
}
const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
/**
 * Candidate HOST bin directories, in the order they are tried, after `scripts/staging-refresh.sh`'s
 * client discipline:
 *  - `PG_BIN` when set is an explicit pin and the ONLY candidate (never silently overridden);
 *  - else every PATH directory, in PATH order;
 *  - else the INSTALLED Homebrew keg of EXACTLY the server's major (`/opt/homebrew/opt` or
 *    `/usr/local/opt`, `postgresql@<server major>`).
 * Bounded and offline: two directory listings, no download, no install, no network.
 */
function candidateBins(serverMajor: number): Array<{ bin: string; source: string }> {
  const pinned = process.env.PG_BIN;
  if (pinned) return [{ bin: pinned, source: "PG_BIN" }];
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((bin) => ({ bin, source: "PATH" }));
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(prefix);
    } catch {
      continue;
    }
    const majors = entries
      .map((entry) => /^postgresql@(\d+)$/.exec(entry))
      .flatMap((match) => (match ? [Number(match[1])] : []))
      .filter((major) => major === serverMajor);
    for (const major of majors) candidates.push({ bin: join(prefix, `postgresql@${major}`, "bin"), source: `Homebrew postgresql@${major}` });
  }
  return candidates;
}
/**
 * The FIRST candidate directory holding BOTH executables whose reported majors are BOTH exactly the
 * server's. EXACT, not ≥: a newer pg_dump emits session settings an older server rejects on restore
 * (PostgreSQL 17+ archives carry `transaction_timeout`, which a 16 server refuses), and an older one
 * refuses to dump. A mismatched pair is recorded and skipped, never used. `examined` lists every
 * pair inspected (directory and majors only), for the precondition's failure message.
 */
async function resolvePgClients(serverMajor: number): Promise<{ pair: PgClientPair | null; examined: string[] }> {
  const examined: string[] = [];
  const seen = new Set<string>();
  for (const { bin, source } of candidateBins(serverMajor)) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    if (!isExecutable(join(bin, "pg_dump")) || !isExecutable(join(bin, "pg_restore"))) continue;
    const dumpMajor = await toolMajor(join(bin, "pg_dump"));
    const restoreMajor = await toolMajor(join(bin, "pg_restore"));
    examined.push(`${source} ${bin}: pg_dump ${dumpMajor ?? "unreadable"}, pg_restore ${restoreMajor ?? "unreadable"}`);
    if (dumpMajor === serverMajor && restoreMajor === serverMajor) {
      return { pair: { bin, source, dumpMajor, restoreMajor }, examined };
    }
  }
  return { pair: null, examined };
}

/**
 * The isolated data-mechanics container that OWNS `DATABASE_TEST_URL`, found only from the
 * runner's own facts and refused on any ambiguity. Every check must hold:
 *  - exactly ONE running container publishes the URL's loopback host port as `->5432/tcp`
 *    (`scripts/dm-isolated.sh` runs `-p 0:5432`);
 *  - its name has the runner's shape (`aios-dm-<8 hex>`), with no worktree hash assumed;
 *  - its image is `postgres:<server major>`;
 *  - its cluster `system_identifier`, read inside it, equals the one read through
 *    `DATABASE_TEST_URL` (the SAME server, not a look-alike);
 *  - its own `pg_dump` and `pg_restore` both report exactly the server's major.
 * `facts` is a bounded record (counts, container name, image, booleans, majors) for the
 * precondition message. It never holds a URL or a credential.
 */
async function discoverIsolatedContainer(
  adminUrl: string, serverMajor: number, hostSystemId: string,
): Promise<{ container: { id: string; name: string } | null; facts: string[] }> {
  const facts: string[] = [];
  const port = new URL(adminUrl).port;
  let listing = "";
  try {
    listing = await runTool("docker", ["ps", "--filter", "status=running", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}"], "docker ps");
  } catch {
    facts.push("isolated container: docker unavailable");
    return { container: null, facts };
  }
  const publishes = new RegExp(`(?:^|[\\s,])[^\\s,]*:${port}->5432/tcp(?=$|[\\s,])`);
  const matches = listing.split("\n").filter(Boolean).map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 4 && publishes.test(columns[3]));
  facts.push(`isolated container: ${matches.length} running container(s) publish host port ${port} as 5432/tcp`
    + (matches.length ? ` (${matches.slice(0, 5).map((columns) => columns[1]).join(", ")})` : ""));
  if (matches.length !== 1) return { container: null, facts };
  const [id, name, image] = matches[0];
  const runnerNamed = /^aios-dm-[0-9a-f]{8}$/.test(name);
  const exactImage = image === `postgres:${serverMajor}`;
  facts.push(`${name}: runner-named ${runnerNamed}, image postgres:${serverMajor} ${exactImage}`);
  if (!runnerNamed || !exactImage) return { container: null, facts };
  const inside = inContainerUrl(adminUrl);
  const containerSystemId = (await runTool("docker",
    ["exec", id, "psql", "-X", "-tA", "-c", "select system_identifier::text from pg_catalog.pg_control_system()", inside],
    `psql in ${name}`).catch(() => "")).trim();
  const sameCluster = containerSystemId !== "" && containerSystemId === hostSystemId;
  facts.push(`${name}: same cluster as DATABASE_TEST_URL ${sameCluster}`);
  if (!sameCluster) return { container: null, facts };
  const dumpMajor = await toolMajor("docker", ["exec", id, "pg_dump"]);
  const restoreMajor = await toolMajor("docker", ["exec", id, "pg_restore"]);
  facts.push(`${name}: pg_dump ${dumpMajor ?? "unreadable"}, pg_restore ${restoreMajor ?? "unreadable"}`);
  if (dumpMajor !== serverMajor || restoreMajor !== serverMajor) return { container: null, facts };
  return { container: { id, name }, facts };
}
/** The same database as the container itself reaches it: its own loopback on the server port. */
function inContainerUrl(hostUrl: string): string {
  const url = new URL(hostUrl);
  url.hostname = "127.0.0.1";
  url.port = "5432";
  return url.toString();
}

/** The selected REAL pg_dump/pg_restore pair, wherever it runs. */
interface PgClients {
  /** Bounded identity for messages: the directory or container name, and the major. */
  identity: string;
  run(tool: "pg_dump" | "pg_restore", args: string[]): Promise<string>;
  /** A scratch database's URL as the tools must use it. */
  url(hostUrl: string): string;
  /** Where the tools read and write a disposable artifact. */
  path(name: string): string;
  /** Make the host-written file `hostFile` readable by the tools at `path(name)`. */
  stage(hostFile: string, name: string): Promise<void>;
  /** Remove every artifact the tools wrote outside the host temp directory. */
  cleanup(): Promise<void>;
}
const hostClients = (pair: PgClientPair, hostDirectory: string): PgClients => ({
  identity: `${pair.source} ${pair.bin} (PostgreSQL ${pair.dumpMajor})`,
  run: (tool, args) => runTool(join(pair.bin, tool), args, tool),
  url: (hostUrl) => hostUrl,
  path: (name) => join(hostDirectory, name),
  stage: async () => {},
  cleanup: async () => {},
});
/** The container route: archive and list live in a private directory inside that exact container. */
async function containerClients(container: { id: string; name: string }, serverMajor: number): Promise<PgClients> {
  const workdir = `/tmp/slack-mr02-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await runTool("docker", ["exec", container.id, "mkdir", "-m", "700", workdir], `mkdir in ${container.name}`);
  return {
    identity: `isolated container ${container.name} (PostgreSQL ${serverMajor})`,
    run: (tool, args) => runTool("docker", ["exec", container.id, tool, ...args], `${tool} in ${container.name}`),
    url: inContainerUrl,
    path: (name) => `${workdir}/${name}`,
    stage: async (hostFile, name) => {
      await runTool("docker", ["cp", hostFile, `${container.id}:${workdir}/${name}`], `docker cp into ${container.name}`);
    },
    cleanup: async () => {
      await runTool("docker", ["exec", container.id, "rm", "-rf", workdir], `cleanup in ${container.name}`).catch(() => "");
    },
  };
}

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
  it("MR-02 MIRROR_EXCEPTIONS holds exactly its five current keys, none Slack-owned", () => {
    const source = readFileSync(MIGRATE_FROM_EXISTING_PATH, "utf8");
    const start = source.indexOf("export const MIRROR_EXCEPTIONS = {");
    const end = source.indexOf("\n};", start);
    const block = start >= 0 && end > start ? source.slice(start, end) : "";
    expect(block.length > 0, "fixture: the MIRROR_EXCEPTIONS allowlist was located").toBe(true);
    // Every key line is `  "<kind>\t<ident>":`; values are concatenated strings on later lines.
    const keys = [...block.matchAll(/^\s*"([a-z]+\\t[^"]+)":/gm)].map((match) => match[1]);
    expect(keys, "MIRROR_EXCEPTIONS keys changed: a new exception needs review, and none may excuse a Slack-owned object").toEqual(EXPECTED_MIRROR_EXCEPTION_KEYS);
    expect(keys.some((key) => key.split("\\t")[1]?.startsWith("slack_")), "a mirror exception excuses a Slack-owned object").toBe(false);
  });
});

describe("AM-F2 + AC-02 history/segment block — MR-02 catalog fidelity (real Postgres, real loader, real pg_dump/pg_restore)", () => {
  let adminUrl = "";
  const created: string[] = [];
  const urls: Record<"schemaOnly" | "loader", string> = { schemaOnly: "", loader: "" };

  /** Every scratch database goes through the shared guard, which refuses before any connection. */
  const createScratch = async (role: string): Promise<string> => {
    const name = `slackmr02_${role}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const scratch = await createIsolatedScratchDatabase(name);
    adminUrl = scratch.adminUrl;
    created.push(name);
    return scratch.url;
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
    // An EXACT-major host pair first (PG_BIN, else PATH, else the Homebrew keg); else, unless PG_BIN
    // pins the host, the exact-major client inside the isolated container that owns DATABASE_TEST_URL.
    const { pair, examined } = await resolvePgClients(serverMajor);
    const facts = [...examined];
    const directory = await mkdtemp(join(tmpdir(), "slack-mr02-"));
    let clients: PgClients | null = null;
    try {
      if (pair) {
        clients = hostClients(pair, directory);
      } else if (process.env.PG_BIN) {
        facts.push("PG_BIN pins the host toolchain, so the isolated-container client is not considered");
      } else {
        const hostSystemId = await withClient(adminUrl, async (client) =>
          (await client.query<{ id: string }>("select system_identifier::text as id from pg_catalog.pg_control_system()")).rows[0].id);
        const { container, facts: containerFacts } = await discoverIsolatedContainer(adminUrl, serverMajor, hostSystemId);
        facts.push(...containerFacts);
        if (container) clients = await containerClients(container, serverMajor);
      }
      expect({ exactMajorPair: clients !== null },
        `toolchain precondition: pg_dump AND pg_restore of EXACTLY the server's PostgreSQL major ${serverMajor}, from one host bin `
        + `directory (PG_BIN, else PATH, else installed Homebrew postgresql@${serverMajor}) or from the isolated container that owns `
        + `DATABASE_TEST_URL. Examined: ${facts.join("; ") || "no directory held both tools"}`).toEqual({ exactMajorPair: true });
      const tools = clients as PgClients;

      // ── The REAL dump, in the staging rollback path's archive shape, by the selected pair. ──
      const archive = tools.path("slack-mr02.dump");
      await tools.run("pg_dump", ["--format=custom", "--schema=public", `--file=${archive}`, tools.url(urls.loader)]);
      // The restore's DDL (no data): an EMPTY search_path, and the schema-qualified validator in the CHECKs.
      const ddl = await tools.run("pg_restore", ["--schema-only", "--file=-", archive]);
      expect({
        emptySearchPath: ddl.includes("SELECT pg_catalog.set_config('search_path', '', false);"),
        // Only a CHECK body renders the call after WHEN; the function's own CREATE does not.
        qualifiedValidator: ddl.includes("WHEN public.slack_channel_cursor_history_valid("),
        namesEveryCheck: NAMED_CHECKS.every((name) => ddl.includes(name)),
      }, "the archive restores under an empty search_path, with the qualified validator and every named CHECK").toEqual({
        emptySearchPath: true, qualifiedValidator: true, namesEveryCheck: true,
      });
      // The staging path's own TOC filter: the fresh database already has `public`. The filtered
      // list is written on the host, then staged where the selected pg_restore can read it.
      const hostListPath = join(directory, "slack-mr02.list");
      await writeFile(hostListPath, filterRestoreList(await tools.run("pg_restore", ["--list", archive])).text, { mode: 0o600 });
      await tools.stage(hostListPath, "slack-mr02.list");

      // ── The REAL restore into a fresh database (citext pre-installed, as schema.sql would). ──
      const restoredUrl = await createScratch("restored");
      await withClient(restoredUrl, async (client) => {
        await client.query("create extension if not exists citext");
      });
      await tools.run("pg_restore", [
        "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
        `--use-list=${tools.path("slack-mr02.list")}`, `--dbname=${tools.url(restoredUrl)}`, archive,
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

      // ── Replay the DEPLOY LOADER over the restored database: schema.sql, then every migration. ──
      await loadSchema({ cwd: ROOT, databaseUrl: restoredUrl, logger: { log: () => {} } });
      const loaderReplayDrift = diffFingerprints(restoredFingerprint, await slackFingerprint(restoredUrl));
      expect({ lost: loaderReplayDrift.missing, gained: loaderReplayDrift.extra },
        `Slack-owned fingerprint drift caused by the deploy-loader replay:\n${loaderReplayDrift.text}`).toEqual({ lost: [], gained: [] });
      expect(await withClient(restoredUrl, exactSlackCatalog), "after the deploy-loader replay: CHECK definitions and validator metadata/body unchanged").toEqual(sourceExact);
      expect(await withClient(restoredUrl, rowDigests), "after the deploy-loader replay: every channel and thread row byte-identical, updated_at included").toEqual(sourceRows);
    } finally {
      // The container route's private directory first, then the host temp directory; neither
      // cleanup can replace the primary failure.
      await clients?.cleanup().catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }, SCRATCH_TIMEOUT);
});
