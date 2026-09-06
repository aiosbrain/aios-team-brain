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

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Refusal codes. Exported so tests name the layer they are pinning instead of matching prose. */
export const REFUSAL = Object.freeze({
  MISSING_SOURCE: "missing-source-url",
  MISSING_TARGET: "missing-target-url",
  UNSUPPORTED_SCHEME: "unsupported-scheme",
  MULTI_HOST: "multi-host-url",
  UNSAFE_CONNECTION_PARAMS: "unsafe-connection-params",
  SAME_HOST: "same-host",
  NO_MARKER: "no-staging-marker",
  MARKER_UNKNOWN: "staging-marker-unknown",
  SOURCE_IS_STAGING: "source-carries-staging-marker",
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
  "gateway_approvals",
  "gateway_audit_log",
  "gateway_connections",
  "gateway_executions",
  "gateway_resolution_leases",
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
 * returns before it opens the database (pinned by `lib/graph/run.test.ts`).
 *
 * SET, one click USED TO bill real extraction on the whole restored corpus. Since STGENV-3 it does not:
 * on a database carrying `staging_marker`, an unbounded projection is REFUSED unless
 * `GRAPH_PROJECT_WINDOW_DAYS` is set (`lib/graph/projection-window.ts`). Unsetting `GRAPHITI_URL` is
 * still the boundary this list declares — the refusal is the second layer, not a replacement for it.
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

const REFERENCES_RE = /\breferences\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?/i;

/**
 * Tables holding a FOREIGN KEY to `table`. Excluding a parent's DATA while dumping a child's is not a
 * tidy subset — it is a restore that FAILS: `pg_restore` loads the child rows and then cannot create
 * the constraint. With `--single-transaction` the whole refresh rolls back, so the failure is loud
 * rather than corrupting, but staging simply never refreshes again once the child table has a row.
 *
 * Measured 2026-08-20: `gateway_connections` has three dependents (`gateway_executions`,
 * `gateway_resolution_leases`, `gateway_audit_log`) and every one of them holds ZERO rows in prod
 * today — which is exactly why this is computed rather than remembered. A latent break that waits for
 * the gateway subsystem to be used is the kind this spec has already been caught by once.
 */
export function fkDependents(sql, table) {
  const lines = stripSqlComments(sql).split("\n");
  const target = String(table).toLowerCase();
  const out = new Set();
  let current = null;
  for (const line of lines) {
    const created = CREATE_TABLE_RE.exec(line);
    if (created) current = created[1].toLowerCase();
    const altered = ALTER_TABLE_RE.exec(line);
    if (altered) current = altered[1].toLowerCase();
    const ref = REFERENCES_RE.exec(line);
    if (ref && ref[1].toLowerCase() === target && current && current !== target) out.add(current);
  }
  return [...out].sort();
}

/**
 * Dependents of an excluded table that are NOT themselves excluded — i.e. the restore breakage.
 *
 * TRANSITIVE, and that is not theoretical: excluding `gateway_connections` pulls in `gateway_executions`,
 * and `gateway_approvals` hangs off THAT. A one-level check reported a clean closure right up until the
 * three direct dependents were added, and then found a fourth. Walk it to a fixed point or the answer
 * depends on how many rounds someone happened to run.
 */
export function missingFkClosure(sql, excluded = EXCLUDED_TABLE_DATA) {
  const set = new Set(excluded.map((t) => t.toLowerCase()));
  const missing = new Set();
  const queue = [...set];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const table = queue.shift();
    for (const dep of fkDependents(sql, table)) {
      if (!set.has(dep)) missing.add(dep);
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...missing].sort();
}

/** `--exclude-table-data=` arguments, in a stable order so the guard can compare them literally. */
export function excludeTableDataArgs(excluded = EXCLUDED_TABLE_DATA) {
  return [...excluded].sort().map((t) => `--exclude-table-data=${t}`);
}

/**
 * Query parameters a connection URL may carry. An ALLOWLIST, not a denylist, and that direction is the
 * whole point.
 *
 * ── The attack this closes, verified by running it ──────────────────────────────────────────────
 * libpq accepts connection PARAMETERS in a URI's query string, including `hostaddr` — which overrides
 * where the socket actually goes while leaving the hostname for authentication. Measured:
 *
 *     psql "postgresql://u@nonexistent-host-xyz.invalid:5432/db"
 *       → could not translate host name "nonexistent-host-xyz.invalid"
 *     psql "postgresql://u@nonexistent-host-xyz.invalid:5432/db?hostaddr=127.0.0.1"
 *       → connection to server at "127.0.0.1" … role "u" does not exist
 *
 * So a target URL reading `staging-proxy.rlwy.net` can connect to production. That defeats the
 * same-host refusal (the parsed hosts differ) AND the marker refusal — because the operator's one-time
 * `create table staging_marker` runs through the same libpq and would plant the marker ON PRODUCTION,
 * after which a `pg_restore --clean` follows it there. Two layers, one bypass, and the outcome is the
 * catastrophic direction this whole script exists to prevent.
 *
 * A denylist would have to enumerate every libpq parameter that can redirect a connection, forever. The
 * allowlist inverts the default: anything not known-inert is a refusal.
 */
export const ALLOWED_URL_PARAMS = Object.freeze([
  "application_name",
  "connect_timeout",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslrootcert",
]);

/**
 * The libpq environment variables that can redirect or re-authenticate a connection independently of
 * the URL — `PGHOSTADDR` does it with the URL untouched, measured the same way as above. The shell
 * scrubs every one of these before invoking psql/pg_dump/pg_restore; this list is exported so the
 * script and its guard cannot drift apart.
 */
export const SCRUBBED_PG_ENV = Object.freeze([
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGOPTIONS",
  "PGTARGETSESSIONATTRS",
  "PGREQUIRESSL",
  "PGSSLMODE",
]);

/**
 * Refusals about the SHAPE of one connection URL: an unsupported scheme, or any query parameter
 * outside the allowlist above. Returns [] for a URL that cannot be parsed at all — that case is
 * `hostOf`'s missing-url refusal, and reporting both would be one fault wearing two hats.
 */
function refusalsForUrlShape(url, label) {
  const raw = String(url ?? "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }
  const out = [];
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "postgres" && scheme !== "postgresql") {
    out.push({
      code: REFUSAL.UNSUPPORTED_SCHEME,
      reason: `${label} uses the "${scheme}" scheme; only postgres:// and postgresql:// are accepted. A URL this script cannot reason about is a URL it must not hand to pg_restore.`,
    });
  }
  // MULTI-HOST FAILOVER — the half of the routing attack the query-param allowlist does not touch,
  // and a second-order miss in the fix for the first half. libpq accepts a comma-separated host list in
  // the AUTHORITY and tries each in turn until one connects. Verified:
  //   psql "postgresql://u@nonexistent-host-xyz.invalid,127.0.0.1/db"  → fell through to 127.0.0.1
  // A target of `staging…,prod…` therefore passes every check here (the marker read reaches staging and
  // finds its marker) and then, if staging is unreachable when the restore runs, `pg_restore --clean`
  // lands on PRODUCTION. Note the asymmetry that hid it: the port-bearing spelling
  // (`a:1,b:2`) makes `new URL()` throw, so it was already refused as unparseable — while the PORTLESS
  // spelling parses cleanly and was accepted. One shape refused by accident is not a layer.
  if (parsed.hostname.includes(",")) {
    out.push({
      code: REFUSAL.MULTI_HOST,
      reason: `${label} lists more than one host (${parsed.hostname}). libpq tries them in order, so the database this script INSPECTS need not be the one it WRITES. Exactly one host, or no refusal here means anything.`,
    });
  }
  // Our parser and libpq's must see the same string. A fragment is dropped by `new URL()` and handed to
  // libpq as part of the connection string — not a routing risk today, but a divergence between what is
  // validated and what is dialled, which is precisely the class of bug this function exists for.
  if (parsed.hash) {
    out.push({
      code: REFUSAL.UNSAFE_CONNECTION_PARAMS,
      reason: `${label} contains a "#" fragment. This script validates a parsed url while libpq dials the raw string; anything the two read differently is refused rather than reasoned about.`,
    });
  }
  const allowed = new Set(ALLOWED_URL_PARAMS);
  const offending = [...parsed.searchParams.keys()].filter((k) => !allowed.has(k.toLowerCase()));
  if (offending.length > 0) {
    out.push({
      code: REFUSAL.UNSAFE_CONNECTION_PARAMS,
      reason: `${label} carries connection parameter(s) this script will not accept: ${offending.join(", ")}. libpq lets a query parameter such as hostaddr send the connection somewhere other than the hostname says — which would defeat both the same-host and the staging-marker refusals. Allowed: ${ALLOWED_URL_PARAMS.join(", ")}.`,
    });
  }
  return out;
}

/**
 * The host a connection string points at, lowercased, or null when it cannot be parsed. Null is NOT
 * "different from everything": `refusalsForPreflight` treats an unparseable URL as a refusal, because
 * "I could not tell whether these are the same database" must never read as "they differ".
 *
 * A TRAILING DOT is stripped: `example.net.` and `example.net` are the same DNS name, and without this
 * the same-host layer would let that pair through — the marker layer would still catch it, but a
 * defence-in-depth stack whose layers only work together is one this spec explicitly refuses.
 *
 * What this is NOT: proof of the TCP destination. That guarantee comes from `ALLOWED_URL_PARAMS` plus
 * the shell's `SCRUBBED_PG_ENV`; without those two, the hostname is a label rather than an address.
 */
export function hostOf(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
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
  out.push(...refusalsForUrlShape(input?.sourceUrl, "the SOURCE url"));
  out.push(...refusalsForUrlShape(input?.targetUrl, "the TARGET url"));
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
  // The SWAPPED PAIR, which the target-marker check alone cannot see. If the operator once declared a
  // database staging while their shell pointed at production, prod carries the marker permanently and
  // nothing in this repo would ever notice — so a later `--source staging --target prod` passes both
  // the host check (they differ) and the marker check. Reading the marker on the SOURCE catches it from
  // the other side: the source of a legitimate refresh is production, and production has no marker.
  const sourceMarker = input?.sourceMarkerPresent;
  if (sourceMarker === true) {
    out.push({
      code: REFUSAL.SOURCE_IS_STAGING,
      reason: `the SOURCE database carries the "${STAGING_MARKER_TABLE}" table, so it is a staging database. This refresh copies production INTO staging; a staging source means the two urls are swapped, and continuing would restore over the database you meant to read.`,
    });
  } else if (sourceMarker !== false) {
    out.push({
      code: REFUSAL.MARKER_UNKNOWN,
      reason: `could not determine whether the SOURCE has the "${STAGING_MARKER_TABLE}" table. Unknown is a refusal, not a pass.`,
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
 * The message printed after a successful refresh. It names the hazard the exclusion of `graph_episodes`
 * creates — staging's projection ledger is empty, so every restored item looks unprojected and setting
 * `GRAPHITI_URL` would bill real entity extraction for the entire corpus, the ~99%-of-the-LLM-bill path.
 *
 * This USED TO describe the hazard as one the code here was unable to close. Since STGENV-3 it IS closed: an unbounded
 * projection on a database carrying `staging_marker` is REFUSED unless `GRAPH_PROJECT_WINDOW_DAYS` names
 * a bounded window. The message still states the hazard — the operator should know why the refusal
 * exists — but it now also names the variable that lifts it, because the alternative to saying so is an
 * operator who finds the refusal and no way past it.
 */
export function completionMessage({ excluded = EXCLUDED_TABLE_DATA } = {}) {
  return [
    "staging refresh complete.",
    `Excluded table DATA: ${[...excluded].sort().join(", ")}.`,
    "Staging now holds prod-shaped Postgres and NO graph: GRAPHITI_URL and NEO4J_URL are expected to be unset there.",
    "GUARDED (STGENV-3): graph_episodes is empty, so every restored item looks unprojected — setting GRAPHITI_URL here would otherwise bill real extraction for the whole corpus. An unbounded projection on this database is now REFUSED. To project a bounded window instead, set GRAPH_PROJECT_WINDOW_DAYS to a positive number of days (no default, on purpose: the amount is a spending decision). See docs/OPS.md section 11.",
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
    if (refusals.length === 0) {
      console.log(DECISION_ACK);
      return 0;
    }
    for (const r of refusals) console.error(`staging-refresh REFUSED [${r.code}]: ${r.reason}`);
    return 1;
  };

  if (cmd === "preflight") {
    return print(refusalsForPreflight({ sourceUrl: arg("source"), targetUrl: arg("target") }));
  }
  if (cmd === "check") {
    const asBool = (v) => (v === "true" ? true : v === "false" ? false : null);
    const marker = asBool(arg("marker"));
    const sourceMarker = asBool(arg("source-marker"));
    return print(
      decideRefresh({
        sourceUrl: arg("source"),
        targetUrl: arg("target"),
        markerPresent: marker,
        sourceMarkerPresent: sourceMarker,
        clientMajor: Number(arg("client-major")),
        serverMajor: Number(arg("server-major")),
      }).refusals
    );
  }
  if (cmd === "check-url") {
    // For the runbook's one-time marker command: the human's psql call is the only libpq invocation this
    // design cannot wrap, and a poisoned url there plants the marker on PRODUCTION — after which the
    // target-marker refusal passes forever. Chained with `&&`, this makes that step fail closed too.
    return print(refusalsForUrlShape(arg("url"), "the url") .concat(hostOf(arg("url")) ? [] : [{
      code: REFUSAL.MISSING_TARGET,
      reason: "the url is unset or unparseable.",
    }]));
  }
  if (cmd === "scrubbed-env") {
    console.log(SCRUBBED_PG_ENV.join("\n"));
    return 0;
  }
  if (cmd === "exclude-args") {
    console.log(excludeTableDataArgs().join("\n"));
    return 0;
  }
  if (cmd === "completion") {
    console.log(completionMessage());
    return 0;
  }
  console.error("usage: staging-refresh-decision.mjs <preflight|check|check-url|exclude-args|scrubbed-env|completion>");
  return 2;
}

/**
 * Realpath both sides, not a template string. `file://${process.argv[1]}` silently fails to match whenever
 * the path is symlinked or contains a character a URL percent-encodes — node resolves `argv[1]` without
 * realpath while `import.meta.url` follows symlinks and encodes. VERIFIED: run from `/tmp/…` (a symlink
 * to `/private/tmp`) or from a directory with a SPACE in its name, this file printed nothing and exited
 * **0** — every refusal above dead, and the shell reads exit 0 as approval.
 *
 * The comparison is the fix; `ACK` is the reason it cannot silently break again. The shell requires the
 * ack token on stdout, so a CLI that no-ops for ANY future reason produces no token and the refresh
 * stops. "Unknown is a refusal" has to hold at the process boundary too, not only inside it.
 */
export const DECISION_ACK = "staging-refresh: DECISION OK";

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // BOTH sides realpath'd. `pathToFileURL` alone fixes the percent-encoding half and NOT the symlink
    // half — measured: from `/tmp/…` (a symlink to `/private/tmp`) the encoded urls still differ, so the
    // CLI kept no-opping. Two distinct causes, one symptom; fixing the visible one would have looked
    // like a fix and left the refusals dead.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) process.exit(main(process.argv));
