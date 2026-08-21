/**
 * The refuse/allow decision behind `scripts/staging-refresh.sh` — pure, so every refusal is testable
 * without a database (STAGING-1, `docs/design/staging-prod-shaped-data.md`).
 *
 * WHAT THE SCRIPT DOES: copies PRODUCTION's Postgres into STAGING's own Postgres so a branch can be
 * looked at against real data. The catastrophic direction is the reverse — a restore that lands on
 * prod — and `pg_restore --clean` is destructive, so the interesting part of this file is what it
 * REFUSES.
 *
 * ── Why the decision is pure and lives here, not in the shell ───────────────────────────────────
 * A guard written in bash is a guard nothing runs until the day it matters. This repo has been bitten
 * by exactly that: `pr-task-link.yml` shipped a response parser "in a shape it never returns …
 * because it lived in a YAML heredoc that no tier could reach". Every layer below is a pure function
 * over plain values, unit-tested in `test/guards/staging-refresh.test.ts`, and the shell's only job is
 * to gather the values and obey the answer.
 *
 * ── Why refusals are COLLECTED, not short-circuited ─────────────────────────────────────────────
 * `refusalsFor…` return EVERY refusal that applies rather than the first. That is not a nicety: the
 * spec's criterion 5 requires each layer to be provably able to fail ALONE, because a defence-in-depth
 * stack tested only through its outcome lets one layer rot invisibly behind a sibling that happens to
 * catch everything (this repo's "defense-in-depth masks mutations" lesson). Collecting is what makes
 * "input violates exactly this layer → exactly this code" an assertable statement.
 *
 * ── Fail CLOSED on unknowns ─────────────────────────────────────────────────────────────────────
 * A missing marker answer or a missing version reading is a REFUSAL, never a pass. The shell can fail
 * to gather a value for a hundred boring reasons; none of them should end with a `--clean` restore.
 */

/** Refusal codes. Exported so tests name the layer they are pinning instead of matching prose. */
export const REFUSAL = Object.freeze({
  MISSING_SOURCE: "missing-source-url",
  MISSING_TARGET: "missing-target-url",
  SAME_HOST: "same-host",
  NO_MARKER: "no-staging-marker",
  MARKER_UNKNOWN: "staging-marker-unknown",
  PG_CLIENT_TOO_OLD: "pg-client-too-old",
  PG_VERSION_UNKNOWN: "pg-version-unknown",
});

/**
 * The table whose EXISTENCE proves a database is staging. It lives ONLY in staging: never in
 * `postgres/schema.sql`, never in a migration, therefore never in prod and never in the dump archive.
 * That is what makes it survive `pg_restore --clean`, which emits DROP only for objects it is about to
 * recreate — so the marker is a durable precondition rather than a check→restore→re-stamp dance.
 * `test/guards/staging-refresh.test.ts` fails the build the day it appears in the schema, because on
 * that day it enters the archive, gets dropped, and this whole guard silently dies.
 */
export const STAGING_MARKER_TABLE = "staging_marker";

/** The remedy the refusal prints, so the operator is never left guessing how to make the target legal. */
export const STAGING_MARKER_REMEDY = `psql "$STAGING_REFRESH_TARGET_URL" -c 'create table if not exists ${STAGING_MARKER_TABLE} (note text primary key)'`;

/**
 * Tables whose DATA never enters the dump. Two different categories, kept in one set because the
 * script needs one list, but distinguished here because the REASONS are what a future reader has to
 * re-derive:
 *
 *   1. REVERSIBLE SECRETS — a `*_ciphertext` column. Copying these hands staging live outbound
 *      credentials. Enumerated from the schema by `ciphertextTables()` rather than typed here, and
 *      cross-checked by a guard: an earlier draft of this spec excluded `integrations` alone and TWO
 *      more tables existed, one of them (`member_secrets`) holding write-capable Slack user tokens
 *      that `GET /api/v1/me/slack-token` will hand back to an authenticated caller.
 *   2. AN ACTIVITY LEDGER FEEDING AN UNCLEARABLE ALARM — `graph_episodes`. Staging does not run the
 *      graph, so copied ledger rows against an empty local graph drive `deriveExtractionVerdict` to
 *      "stalled", and `getPipelineHealth` then appends a synthetic `graph_extract` leg that is the one
 *      CONFIRMATION-EXEMPT leg in the system — no staleness threshold can ever clear it. A permanently
 *      red "graph extraction is broken" banner, manufactured by our own refresh.
 */
export const EXCLUDED_TABLE_DATA = Object.freeze([
  "gateway_connections",
  "graph_episodes",
  "integrations",
  "member_secrets",
]);

/**
 * The staging variable set the runbook applies, declared HERE so `docs/OPS.md`'s table can be checked
 * against it. Prose and code drifting apart is how a safety step quietly stops being part of the
 * design; the guard compares the two.
 *
 * `GRAPHITI_URL` is the load-bearing one and the reason is not obvious: with `graph_episodes` excluded
 * (above), every restored item looks UNPROJECTED to the projector, and `GRAPH_PROJECT_ENABLED=false`
 * does NOT stop projection — it gates the interval poller only, while the admin "Project to graph now"
 * button calls `runGraphProjection` directly, gated on `GRAPHITI_URL` alone. Unset, the projector
 * returns before it opens the database (pinned by `lib/graph/run.test.ts`). Set, one click bills real
 * extraction on the whole restored corpus.
 */
export const STAGING_VARIABLES = Object.freeze([
  Object.freeze({ name: "GRAPHITI_URL", expected: "unset" }),
  Object.freeze({ name: "NEO4J_URL", expected: "unset" }),
  Object.freeze({ name: "RESEND_API_KEY", expected: "unset" }),
  Object.freeze({ name: "SMTP_URL", expected: "unset" }),
  Object.freeze({ name: "SENTRY_DSN", expected: "unset" }),
  Object.freeze({ name: "NEXT_PUBLIC_SENTRY_DSN", expected: "unset" }),
  // The DSNs are the RUNTIME half. Releases and source maps upload at BUILD time driven by
  // SENTRY_AUTH_TOKEN (next.config.ts:76) — and staging's SENTRY_PROJECT is the same project as
  // production's, so without this line staging stops sending events while its builds keep creating
  // releases in prod's project. SENTRY_ORG/SENTRY_PROJECT are inert without the token and are
  // deliberately not listed: padding a safety list with no-ops is how the load-bearing entry gets lost.
  Object.freeze({ name: "SENTRY_AUTH_TOKEN", expected: "unset" }),
  Object.freeze({ name: "INGEST_POLL_ENABLED", expected: "false" }),
  Object.freeze({ name: "GRAPH_PROJECT_ENABLED", expected: "false" }),
  Object.freeze({ name: "AUTO_FLIP_ENABLED", expected: "false" }),
  Object.freeze({ name: "SEED_DEMO", expected: "false" }),
]);

/**
 * SQL comments are prose, not schema. Stripping them first is what stops a docstring ABOUT a
 * ciphertext column (`postgres/schema.sql` has several, e.g. "DISTINCT from team
 * `integrations.secret_ciphertext`") from being attributed to whichever table block it sits in — which
 * would invent a table name and make the exclusion check fail against a table that does not exist.
 * Same discipline as `pr-work-keys.mjs` refusing to count a work key written inside backticks.
 */
function stripSqlComments(sql) {
  return String(sql ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const CREATE_TABLE_RE = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/i;
const ALTER_TABLE_RE = /^\s*alter\s+table\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/i;
const CIPHERTEXT_COLUMN_RE = /\b([a-z0-9_]*ciphertext)\b/i;

/**
 * Every table owning a column whose name ends in `ciphertext`, found by SCANNING the schema rather
 * than by remembering. Handles both shapes the schema actually uses: a column inside a `create table`
 * body, and `alter table … add column if not exists …_ciphertext` (which is how `integrations` got its
 * column, and is invisible to anyone reading only the create statements).
 *
 * @param {string} sql one or more SQL files, concatenated
 * @returns {string[]} sorted, de-duplicated table names
 */
export function ciphertextTables(sql) {
  const lines = stripSqlComments(sql).split("\n");
  const found = new Set();
  let current = null;
  for (const line of lines) {
    const created = CREATE_TABLE_RE.exec(line);
    if (created) current = created[1].toLowerCase();
    const altered = ALTER_TABLE_RE.exec(line);
    if (altered) current = altered[1].toLowerCase();
    if (CIPHERTEXT_COLUMN_RE.test(line) && current) found.add(current);
  }
  return [...found].sort();
}

/**
 * Ciphertext-bearing tables the script would COPY — i.e. the gap between what the schema has and what
 * the exclusion set covers. Empty is the only acceptable answer; the guard fails the build otherwise,
 * so a new reversible-secret table cannot ship without someone deciding about it.
 *
 * @param {string} sql schema + migrations, concatenated
 * @param {readonly string[]} excluded
 * @returns {string[]}
 */
export function missingCiphertextExclusions(sql, excluded = EXCLUDED_TABLE_DATA) {
  const set = new Set(excluded.map((t) => t.toLowerCase()));
  return ciphertextTables(sql).filter((t) => !set.has(t));
}

/** `--exclude-table-data=` arguments, in a stable order so the guard can compare them literally. */
export function excludeTableDataArgs(excluded = EXCLUDED_TABLE_DATA) {
  return [...excluded].sort().map((t) => `--exclude-table-data=${t}`);
}

/**
 * The host a connection string points at, lowercased, or null when it cannot be parsed. Null is NOT
 * "different from everything": `refusalsForPreflight` treats an unparseable URL as a refusal, because
 * "I could not tell whether these are the same database" must never read as "they differ".
 */
export function hostOf(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/**
 * The layers that need NO connection, so the copy-paste case (both URLs pointing at prod) dies before
 * a socket is opened rather than after a successful login to production.
 *
 * @param {{ sourceUrl?: string|null, targetUrl?: string|null }} input
 * @returns {{ code: string, reason: string }[]}
 */
export function refusalsForPreflight(input) {
  const out = [];
  const sourceHost = hostOf(input?.sourceUrl);
  const targetHost = hostOf(input?.targetUrl);
  if (!sourceHost) {
    out.push({
      code: REFUSAL.MISSING_SOURCE,
      reason:
        "STAGING_REFRESH_SOURCE_URL is unset or unparseable. There is deliberately no default: a default source is how a script that copies FROM production acquires a second, silent opinion about which database that is.",
    });
  }
  if (!targetHost) {
    out.push({
      code: REFUSAL.MISSING_TARGET,
      reason:
        "STAGING_REFRESH_TARGET_URL is unset or unparseable. There is deliberately no default: this URL is the one a `pg_restore --clean` destroys.",
    });
  }
  if (sourceHost && targetHost && sourceHost === targetHost) {
    out.push({
      code: REFUSAL.SAME_HOST,
      reason: `source and target resolve to the same host (${sourceHost}). That is the copy-paste mistake this refusal exists for, and it is checked before any connection is opened.`,
    });
  }
  return out;
}

/**
 * The layers that need a reading from the databases. Every input is REQUIRED; an absent one is its own
 * refusal rather than a skipped check, so a shell that fails to gather a value cannot fail open.
 *
 * @param {{ markerPresent?: boolean|null, clientMajor?: number|null, serverMajor?: number|null }} input
 * @returns {{ code: string, reason: string }[]}
 */
export function refusalsForConnected(input) {
  const out = [];
  const marker = input?.markerPresent;
  if (marker !== true && marker !== false) {
    out.push({
      code: REFUSAL.MARKER_UNKNOWN,
      reason: `could not determine whether the target has the "${STAGING_MARKER_TABLE}" table. Unknown is a refusal, not a pass.`,
    });
  } else if (marker === false) {
    out.push({
      code: REFUSAL.NO_MARKER,
      reason: `the target database has no "${STAGING_MARKER_TABLE}" table, so it has not been declared a staging database. Production does not have this table and never will (it is absent from postgres/schema.sql by design), which is exactly what makes its absence a refusal. To declare a target: ${STAGING_MARKER_REMEDY}`,
    });
  }
  out.push(...pgVersionRefusals(input?.clientMajor, input?.serverMajor));
  return out;
}

/**
 * `pg_dump` aborts when the server's major version exceeds its own. On the machine this was designed
 * on, `pg_dump` on PATH was 14 and both servers were 18 — so the runbook as first written could not
 * have run at all. Refusing with the remedy named beats proceeding: a mismatched client is how you get
 * an archive that restores PARTIALLY, which is worse than one that never existed.
 *
 * A client NEWER than the server is fine and must be ACCEPTED — a refusal that fires on everything
 * would pass every "does it refuse?" test while making the script unusable.
 */
export function pgVersionRefusals(clientMajor, serverMajor) {
  const client = Number(clientMajor);
  const server = Number(serverMajor);
  if (!Number.isInteger(client) || !Number.isInteger(server) || client <= 0 || server <= 0) {
    return [
      {
        code: REFUSAL.PG_VERSION_UNKNOWN,
        reason:
          "could not read both the pg_dump client major version and the server major version. Unknown is a refusal: an unverified client/server pairing is how a partial archive gets made.",
      },
    ];
  }
  if (client < server) {
    return [
      {
        code: REFUSAL.PG_CLIENT_TOO_OLD,
        reason: `pg_dump is major ${client} but the server is major ${server}; pg_dump refuses to dump a newer server. Remedy: brew install postgresql@${server} and re-run with PG_BIN=$(brew --prefix postgresql@${server})/bin, or run the dump inside docker run --rm postgres:${server}.`,
      },
    ];
  }
  return [];
}

/**
 * The whole decision, for tests that need to assert a single input violates a single layer.
 * @returns {{ ok: boolean, refusals: { code: string, reason: string }[] }}
 */
export function decideRefresh(input) {
  const refusals = [...refusalsForPreflight(input), ...refusalsForConnected(input)];
  return { ok: refusals.length === 0, refusals };
}

/**
 * The message printed after a successful refresh. It names a hazard NO CODE HERE CAN CLOSE: the
 * exclusion of `graph_episodes` leaves staging's projection ledger empty, so the day someone sets
 * `GRAPHITI_URL` on staging to "make the graph work", the entire restored corpus looks unprojected and
 * the first tick or admin click starts paying for real entity extraction — the ~99%-of-the-LLM-bill
 * path. Stated where the person who would do it is looking, because the alternative is discovering it
 * on an invoice.
 */
export function completionMessage({ excluded = EXCLUDED_TABLE_DATA } = {}) {
  return [
    "staging refresh complete.",
    `Excluded table DATA: ${[...excluded].sort().join(", ")}.`,
    "Staging now holds prod-shaped Postgres and NO graph: GRAPHITI_URL and NEO4J_URL are expected to be unset there.",
    "HAZARD, deliberately left open and stated instead: graph_episodes is empty, so if GRAPHITI_URL is ever set on staging, every restored item looks unprojected and projection will bill real extraction for the whole corpus.",
    "Graph-backed surfaces (learning panel, graph-query, semantic retrieval) render empty in staging by design.",
  ].join("\n");
}

/** CLI: `node scripts/staging-refresh-decision.mjs <preflight|check|exclude-args|completion>`. */
function main(argv) {
  const cmd = argv[2];
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const print = (refusals) => {
    if (refusals.length === 0) return 0;
    for (const r of refusals) console.error(`staging-refresh REFUSED [${r.code}]: ${r.reason}`);
    return 1;
  };

  if (cmd === "preflight") {
    return print(refusalsForPreflight({ sourceUrl: arg("source"), targetUrl: arg("target") }));
  }
  if (cmd === "check") {
    const markerRaw = arg("marker");
    const marker = markerRaw === "true" ? true : markerRaw === "false" ? false : null;
    return print(
      decideRefresh({
        sourceUrl: arg("source"),
        targetUrl: arg("target"),
        markerPresent: marker,
        clientMajor: Number(arg("client-major")),
        serverMajor: Number(arg("server-major")),
      }).refusals
    );
  }
  if (cmd === "exclude-args") {
    console.log(excludeTableDataArgs().join("\n"));
    return 0;
  }
  if (cmd === "completion") {
    console.log(completionMessage());
    return 0;
  }
  console.error("usage: staging-refresh-decision.mjs <preflight|check|exclude-args|completion>");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
