import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  EXCLUDED_TABLE_DATA,
  REFUSAL,
  STAGING_MARKER_TABLE,
  DECISION_ACK,
  SCRUBBED_PG_ENV,
  ALLOWED_URL_PARAMS,
  fkDependents,
  missingFkClosure,
  STAGING_VARIABLES,
  ciphertextTables,
  completionMessage,
  decideRefresh,
  excludeTableDataArgs,
  hostOf,
  missingCiphertextExclusions,
  pgVersionRefusals,
  refusalsForConnected,
  refusalsForPreflight,
} from "../../scripts/staging-refresh-decision.mjs";

/**
 * STAGING-1 — `scripts/staging-refresh.sh` copies PRODUCTION's Postgres into STAGING's own Postgres.
 * Spec: `docs/design/staging-prod-shaped-data.md`, acceptance criteria 1–14.
 *
 * These assertions are derived from the SPEC, not from the implementation. The thing being guarded is
 * a script whose failure mode is "restores over production", which no test can observe after the fact
 * — so every layer below is asserted to fail ON ITS OWN. A defence-in-depth stack tested only through
 * its outcome lets one layer rot invisibly behind a sibling that happens to catch everything, which is
 * this repo's "defense-in-depth masks mutations" lesson.
 *
 * Two of these guards exist because a review round found the design wrong, and they encode the reason
 * rather than the fix:
 *   - the `*_ciphertext` SCAN exists because a draft excluded `integrations` alone while asserting the
 *     category, and two more tables existed;
 *   - the confirmation-exemption count exists because excluding `graph_episodes` is only correct while
 *     the alarm it feeds remains unclearable — if a second unclearable alarm is ever hardcoded, someone
 *     has to answer whether ITS ledger needs excluding too.
 */

const ROOT = join(__dirname, "..", "..");
const SCRIPT_PATH = join(ROOT, "scripts", "staging-refresh.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const SCHEMA = readFileSync(join(ROOT, "postgres", "schema.sql"), "utf8");
const MIGRATIONS_DIR = join(ROOT, "postgres", "migrations");
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");
const ALL_SQL = `${SCHEMA}\n${MIGRATIONS}`;

/** Shell lines with whole-line comments removed — so a guard can scan for a FLAG without a comment
 *  that merely names the flag either satisfying it or tripping it. */
function shellCode(script: string): string {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** TypeScript with comments removed. `//` is only treated as a comment at line start or after
 *  whitespace, so a `https://` inside a string is not mistaken for one. */
function tsCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "\n").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * Lines invoking a libpq client WITHOUT the environment scrub in front of it. Written as a function so
 * the test can prove it fires on a known-bad sample before trusting its silence on the real script.
 */
function unscrubbedCalls(script: string): string[] {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    // No non-quote prefix class here: the first spelling used `[^\w"]`, which can never match a token
    // that STARTS with a quote — so `"$PG_RESTORE" …` at line start was invisible and the detector
    // reported clean. Caught by the known-bad sample below, which is the only reason this comment exists.
    // Binary NAMES as well as the variable spellings, symmetrically: `psql` was matched by name while
    // pg_dump/pg_restore were matched only as `"$PG_DUMP"`/`"$PG_RESTORE"`, so a future edit invoking a
    // literal `pg_restore …` — the most dangerous binary of the three — would have walked past.
    .filter((line) => /(?:\bpsql\b|\bpg_dump\b|\bpg_restore\b|"\$PG_DUMP"|"\$PG_RESTORE")/.test(line))
    // An ASSIGNMENT names the binary, it does not run it (`PG_DUMP="$PG_BIN/pg_dump"`) — but only when
    // the line is NOTHING BUT an assignment. `VAR=x psql …` is a command with an env prefix, and the
    // first spelling of this filter (`^\s*[A-Z_]+=`) swallowed exactly that shape: a hole opened by the
    // fix for a false positive, which is the usual way one arrives.
    .filter((line) => !/^\s*[A-Z_]+=("[^"]*"|\S*)\s*$/.test(line))
    // A `[[ -n "$PG_DUMP" ]]` test REFERENCES the binary, it does not run it — flagging it was the
    // detector's other failure direction, found the same way as the first: by running it on real input.
    .filter((line) => !line.includes("[["))
    .filter((line) => !line.includes("PG_SCRUB[@]"))
    .map((line) => line.trim());
}

/** Every .ts/.tsx file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

/**
 * An input that violates NOTHING — the baseline every single-layer test perturbs by exactly one field.
 *
 * The urls carry NO userinfo on purpose. Written as `postgresql://u:p@host/db` they are indistinguishable
 * to a secret scanner from a real hardcoded credential, and a repo that trains its readers to skim past
 * "it's only a test fixture" has taught them the wrong reflex. Nothing here reads the userinfo: every
 * refusal under test keys on scheme, host, or query parameters.
 */
const VALID = Object.freeze({
  sourceUrl: "postgresql://prod-proxy.rlwy.net:33781/railway",
  targetUrl: "postgresql://staging-proxy.rlwy.net:41999/railway",
  markerPresent: true,
  sourceMarkerPresent: false, // production has no staging marker
  clientMajor: 18,
  serverMajor: 18,
});

const codes = (refusals: { code: string }[]) => refusals.map((r) => r.code).sort();

describe("staging-refresh — the exclusion CATEGORY (criteria 1, 2, 10)", () => {
  it("excludes the data of every table in the real schema that carries a *_ciphertext column", () => {
    expect(missingCiphertextExclusions(ALL_SQL)).toEqual([]);
  });

  it("is NON-VACUOUS: the scan finds the three known ciphertext tables by name", () => {
    // Without this, a pattern that matched nothing would report "nothing missing" and read as a clean
    // bill of health — the failure this repo has already shipped once ("a parser that matches nothing
    // reports zero"). The names are asserted exactly: a scan that found FOUR things, or the wrong
    // three, is not the check it claims to be.
    expect(ciphertextTables(ALL_SQL)).toEqual([
      "gateway_connections",
      "integrations",
      "member_secrets",
    ]);
  });

  it("REPORTS a newly added ciphertext table as missing — the reason this is a scan and not a list", () => {
    const future = `${ALL_SQL}\ncreate table if not exists webhook_targets (\n  id uuid primary key,\n  signing_ciphertext text not null\n);\n`;
    expect(ciphertextTables(future)).toContain("webhook_targets");
    expect(missingCiphertextExclusions(future)).toEqual(["webhook_targets"]);
  });

  it("finds a ciphertext column added by ALTER TABLE, not just one declared inside CREATE TABLE", () => {
    // The real schema uses BOTH shapes for `integrations.secret_ciphertext` — declared in the create-table
    // body AND re-applied by an `alter … add column if not exists` (the migration-mirror pattern), so a
    // create-only scanner would not miss THAT one. The gap this closes is the next column that arrives by
    // migration alone, which is the documented way to add a column to an existing table in this repo.
    // (An earlier version of this comment claimed the create-only scanner would miss `integrations`
    // today. It would not; the claim was wrong and the test is still worth having.)
    const sql = `create table if not exists plain (id uuid primary key);\nalter table widgets add column if not exists secret_ciphertext text;`;
    expect(ciphertextTables(sql)).toEqual(["widgets"]);
  });

  it("does not invent a table from a COMMENT that merely mentions a ciphertext column", () => {
    const sql = [
      "create table if not exists innocent (",
      "  id uuid primary key",
      ");",
      "-- DISTINCT from team `integrations.secret_ciphertext` (team-scoped): prose, not schema.",
      "/* another_ciphertext mentioned in a block comment */",
    ].join("\n");
    expect(ciphertextTables(sql)).toEqual([]);
  });

  it("excludes graph_episodes — the ledger that feeds the one alarm no threshold can clear", () => {
    expect(EXCLUDED_TABLE_DATA).toContain("graph_episodes");
    expect(excludeTableDataArgs()).toContain("--exclude-table-data=graph_episodes");
  });

  it("keeps that reason live: exactly ONE hardcoded confirmation exemption exists under lib/, on graph_extract", () => {
    // The observable is a LITERAL `failureClass: "confirmed"`. Ordinary confirmed failures are legion
    // and legitimate, but they are DERIVED — `classifyFailure(...)` into a variable — so they cannot
    // match. Only an exemption someone hardcodes can. That distinction is what makes this guard
    // neither vacuous (it matches one thing today) nor noisy (refactoring the derived path cannot red
    // it). If a second exemption appears, whoever added it must answer whether the ledger feeding it
    // also needs excluding from the staging dump.
    const hits = [...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))]
      .map((f) => ({ file: f, src: tsCode(readFileSync(f, "utf8")) }))
      .filter((f) => /failureClass:\s*"confirmed"/.test(f.src));
    expect(hits.map((h) => h.file.replace(`${ROOT}/`, ""))).toEqual(["lib/ingest/pipeline-health.ts"]);
    const src = hits[0].src;
    expect(src.match(/failureClass:\s*"confirmed"/g)).toHaveLength(1);
    // …and it belongs to the graph_extract leg, not to something else that drifted into the file.
    const exemptBlock = src.slice(src.lastIndexOf("legs.push(", src.indexOf('failureClass: "confirmed"')));
    expect(exemptBlock).toContain('source: "graph_extract"');
  });
});

describe("staging-refresh — the refusals, each proven to fail ALONE (criteria 3, 4, 5, 12)", () => {
  it("accepts the valid baseline — a check that refuses everything proves nothing", () => {
    expect(decideRefresh(VALID)).toEqual({ ok: true, refusals: [] });
  });

  it("REFUSES a target with no staging marker, and names the marker and the remedy", () => {
    const { ok, refusals } = decideRefresh({ ...VALID, markerPresent: false });
    expect(ok).toBe(false);
    expect(codes(refusals)).toEqual([REFUSAL.NO_MARKER]);
    expect(refusals[0].reason).toContain(STAGING_MARKER_TABLE);
    expect(refusals[0].reason).toContain("create table if not exists");
  });

  it("REFUSES when the marker is UNKNOWN — an unreadable answer is not a pass", () => {
    expect(codes(decideRefresh({ ...VALID, markerPresent: null }).refusals)).toEqual([
      REFUSAL.MARKER_UNKNOWN,
    ]);
  });

  it("REFUSES same-host INDEPENDENTLY of the marker — the copy-paste case dies on its own", () => {
    // Marker present, versions fine: the ONLY violation is that both URLs point at the same database.
    // Asserted as the exact refusal set, so this can never pass because some other layer caught it.
    const sameHost = { ...VALID, targetUrl: "postgresql://prod-proxy.rlwy.net:33781/railway" };
    expect(codes(decideRefresh(sameHost).refusals)).toEqual([REFUSAL.SAME_HOST]);
    // And it is a PREFLIGHT refusal, i.e. reachable with no database reading at all.
    expect(codes(refusalsForPreflight(sameHost))).toEqual([REFUSAL.SAME_HOST]);
  });

  it("REFUSES a missing source URL alone, and a missing target URL alone", () => {
    expect(codes(decideRefresh({ ...VALID, sourceUrl: "" }).refusals)).toEqual([REFUSAL.MISSING_SOURCE]);
    expect(codes(decideRefresh({ ...VALID, targetUrl: undefined }).refusals)).toEqual([
      REFUSAL.MISSING_TARGET,
    ]);
  });

  it("treats an UNPARSEABLE url as missing, never as 'different from the other one'", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(codes(decideRefresh({ ...VALID, targetUrl: "not a url" }).refusals)).toEqual([
      REFUSAL.MISSING_TARGET,
    ]);
  });

  it("REFUSES a pg_dump older than the server, names the remedy, and ACCEPTS equal or newer", () => {
    const [refusal] = pgVersionRefusals(14, 18);
    expect(refusal.code).toBe(REFUSAL.PG_CLIENT_TOO_OLD);
    expect(refusal.reason).toContain("postgresql@18");
    expect(pgVersionRefusals(18, 18)).toEqual([]);
    expect(pgVersionRefusals(19, 18)).toEqual([]);
    expect(pgVersionRefusals(null, 18)[0].code).toBe(REFUSAL.PG_VERSION_UNKNOWN);
    expect(pgVersionRefusals(18, NaN)[0].code).toBe(REFUSAL.PG_VERSION_UNKNOWN);
  });

  it("reports EVERY violated layer at once, so one layer cannot mask another", () => {
    const allBad = { sourceUrl: "", targetUrl: "", markerPresent: null, sourceMarkerPresent: null, clientMajor: 14, serverMajor: 18 };
    expect(codes(decideRefresh(allBad).refusals)).toEqual(
      [
        REFUSAL.MISSING_SOURCE,
        REFUSAL.MISSING_TARGET,
        REFUSAL.MARKER_UNKNOWN,
        REFUSAL.MARKER_UNKNOWN, // target and source are separate readings, separately unknown
        REFUSAL.PG_CLIENT_TOO_OLD,
      ].sort()
    );
  });

  it("keeps the connected layers reachable on their own", () => {
    expect(
      codes(refusalsForConnected({ markerPresent: true, sourceMarkerPresent: false, clientMajor: 14, serverMajor: 18 }))
    ).toEqual([REFUSAL.PG_CLIENT_TOO_OLD]);
  });
});

describe("staging-refresh — the URL is not the destination (criteria 17, 18)", () => {
  // VERIFIED BY RUNNING IT, not inferred: libpq honours `hostaddr` from a URI query string AND from
  // the ambient environment, so a URL reading `staging-proxy…` can open a socket to production.
  //   psql "postgresql://u@nonexistent-host-xyz.invalid:5432/db"                 → DNS failure
  //   psql "postgresql://u@nonexistent-host-xyz.invalid:5432/db?hostaddr=127.0.0.1" → reached 127.0.0.1
  //   PGHOSTADDR=127.0.0.1 psql "postgresql://u@nonexistent-host-xyz.invalid…"     → reached 127.0.0.1
  // That defeats same-host (the parsed hosts differ) and the marker (the one-time create runs through
  // the same libpq, so the marker gets planted on prod). Two layers, one bypass.
  it("REFUSES a url carrying hostaddr — the parameter that moves the socket", () => {
    const poisoned = { ...VALID, targetUrl: `${VALID.targetUrl}?hostaddr=10.0.0.9` };
    expect(codes(decideRefresh(poisoned).refusals)).toEqual([REFUSAL.UNSAFE_CONNECTION_PARAMS]);
    expect(decideRefresh(poisoned).refusals[0].reason).toMatch(/hostaddr/);
  });

  it("is an ALLOWLIST: an unknown parameter is refused even though it is not hostaddr", () => {
    // The direction is the point. A denylist would have to enumerate every libpq parameter that can
    // redirect a connection, forever; this refuses anything not known-inert.
    expect(codes(decideRefresh({ ...VALID, sourceUrl: `${VALID.sourceUrl}?service=prod` }).refusals)).toEqual([
      REFUSAL.UNSAFE_CONNECTION_PARAMS,
    ]);
    expect(codes(decideRefresh({ ...VALID, sourceUrl: `${VALID.sourceUrl}?options=-csearch_path%3Devil` }).refusals)).toEqual([
      REFUSAL.UNSAFE_CONNECTION_PARAMS,
    ]);
  });

  it("ACCEPTS the inert parameters an operator actually needs — a refusal that fires on everything is not a check", () => {
    expect(ALLOWED_URL_PARAMS).toContain("sslmode");
    expect(decideRefresh({ ...VALID, targetUrl: `${VALID.targetUrl}?sslmode=require&connect_timeout=10` }).ok).toBe(true);
  });

  it("REFUSES a non-postgres scheme", () => {
    expect(codes(decideRefresh({ ...VALID, targetUrl: "https://evil.example/db" }).refusals)).toEqual([
      REFUSAL.UNSUPPORTED_SCHEME,
    ]);
    expect(decideRefresh({ ...VALID, targetUrl: "postgres://u:p@staging.example/db" }).ok).toBe(true);
  });

  it("treats a TRAILING DOT as the same host — the same-host layer must work alone", () => {
    // `example.net.` and `example.net` are one DNS name. The marker layer would also catch this pair,
    // which is exactly why it needed its own test: a layer that only works with help is not a layer.
    expect(hostOf("postgresql://h.example.net./db")).toBe("h.example.net");
    expect(
      codes(refusalsForPreflight({ sourceUrl: "postgresql://h.example.net/db", targetUrl: "postgresql://h.example.net./db" }))
    ).toEqual([REFUSAL.SAME_HOST]);
  });

  it("REFUSES a multi-host url — the half the query-param allowlist does not touch", () => {
    // libpq tries a comma-separated host list in order, verified:
    //   psql "postgresql://u@nonexistent-host-xyz.invalid,127.0.0.1/db" → fell through to 127.0.0.1
    // So `staging…,prod…` passes the marker read (it reaches staging) and a later restore can land on
    // production if staging is briefly unreachable. Note WHY this was missed: the port-bearing spelling
    // makes `new URL()` throw and was refused by accident, while the portless one parsed cleanly.
    expect(codes(decideRefresh({ ...VALID, targetUrl: "postgresql://staging.example,prod.example/db" }).refusals)).toEqual([
      REFUSAL.MULTI_HOST,
    ]);
    // The accidentally-refused spelling must still be refused, but that is not what proves the layer.
    expect(decideRefresh({ ...VALID, targetUrl: "postgresql://a.example:1,b.example:2/db" }).ok).toBe(false);
  });

  it("REFUSES a url whose parsed form and raw form differ (a fragment)", () => {
    expect(codes(decideRefresh({ ...VALID, targetUrl: "postgresql://staging.example/db#x" }).refusals)).toEqual([
      REFUSAL.UNSAFE_CONNECTION_PARAMS,
    ]);
  });

  it("gives the runbook's one-time marker command the same url armour, chained to fail closed", () => {
    const decision = join(ROOT, "scripts", "staging-refresh-decision.mjs");
    const poisoned = spawnSync(process.execPath, [decision, "check-url", "--url", "postgresql://staging.example/db?hostaddr=1.2.3.4"], { encoding: "utf8" });
    expect(poisoned.status).toBe(1);
    expect(poisoned.stdout).not.toContain(DECISION_ACK);
    const clean = spawnSync(process.execPath, [decision, "check-url", "--url", "postgresql://staging.example/db"], { encoding: "utf8" });
    expect(clean.status).toBe(0);
    const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
    const section = ops.slice(ops.indexOf("## 11. Staging refresh"));
    expect(section).toMatch(/check-url --url "\$STAGING_REFRESH_TARGET_URL" && \\/);
  });

  it("scrubs the libpq environment for every call, and the script uses the module's list", () => {
    // PGHOSTADDR redirects with the URL untouched, so the allowlist above is only half the fix.
    expect(SCRUBBED_PG_ENV).toContain("PGHOSTADDR");
    expect(SCRUBBED_PG_ENV).toContain("PGSERVICE");
    const script = shellCode(SCRIPT);
    expect(script).toMatch(/scrubbed-env/); // the list comes FROM the module — one owner, no drift
    // Every libpq invocation goes through the scrub: no bare psql/pg_dump/pg_restore call.
    // The detector is applied to a KNOWN-BAD sample first. A scan that matches nothing reports a clean
    // bill of health identically to a scan that found nothing wrong, and this repo has shipped that
    // exact failure before — so the pattern proves it can fire before it is trusted to say "clean".
    expect(unscrubbedCalls('  raw="$(psql -X "$url" -tAc "select 1")"')).not.toEqual([]);
    expect(unscrubbedCalls('"$PG_RESTORE" --clean --dbname "$TARGET_URL" "$DUMP"')).not.toEqual([]);
    expect(unscrubbedCalls('"${PG_SCRUB[@]}" "$PG_RESTORE" --clean --dbname "$T" "$D"')).toEqual([]);
    expect(unscrubbedCalls('if [[ -n "$PG_DUMP" && -x "$PG_DUMP" ]]; then')).toEqual([]); // a test, not a call
    expect(unscrubbedCalls('  PG_DUMP="$PG_BIN/pg_dump"')).toEqual([]); // an assignment, not a call
    expect(unscrubbedCalls('pg_restore --clean --dbname "$TARGET_URL" "$DUMP"')).not.toEqual([]); // literal binary
    expect(unscrubbedCalls('DATABASE_URL="$T" psql -X -c "select 1"')).not.toEqual([]); // env prefix is not an assignment
    expect(unscrubbedCalls(script)).toEqual([]);
    expect(script).toMatch(/PG_SCRUB\[@\]\}" psql -X/);
    expect(script).toMatch(/PG_SCRUB\[@\]\}" "\$PG_DUMP"/);
    expect(script).toMatch(/PG_SCRUB\[@\]\}" "\$PG_RESTORE"/);
  });

  it("scrubs the post-restore schema replay too, so the guard has no exception", () => {
    // node-postgres ignores PGHOSTADDR and this runs after the destructive step, so it is uniformity
    // rather than a fix — but an unpinned uniformity change is one silent edit from being an exception,
    // and an exception makes the guard's silence mean "everything except that one".
    expect(shellCode(SCRIPT)).toMatch(/DATABASE_URL="\$TARGET_URL" "\$\{PG_SCRUB\[@\]\}" npm/);
  });

  it("REFUSES if the scrub list itself comes back empty", () => {
    expect(shellCode(SCRIPT)).toMatch(/scrub list came back EMPTY/);
  });

  it("asks the one-time marker command in the runbook to carry the same armour", () => {
    // The marker is created by a HUMAN running psql. If that call can be redirected, the marker lands
    // on production and every later refusal reads a database it never inspected.
    const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
    const section = ops.slice(ops.indexOf("## 11. Staging refresh"));
    const marker = section.slice(section.indexOf("create table if not exists staging_marker") - 600, section.indexOf("create table if not exists staging_marker") + 200);
    expect(marker).toMatch(/-u PGHOSTADDR/);
    expect(marker).toMatch(/psql -X/);
  });

  it("restores inside ONE transaction, so a failure leaves staging as it was", () => {
    // Without it, a restore that dies halfway has already committed its drops: staging serves a
    // half-dropped, half-restored database and the completion warning never prints.
    expect(shellCode(SCRIPT)).toMatch(/--single-transaction\s+--clean\s+--if-exists\s+--no-owner/);
  });
});

describe("staging-refresh — the swapped pair and the FK closure (criteria 20, 21)", () => {
  it("REFUSES when the SOURCE carries the staging marker — the swap the target check cannot see", () => {
    // If production ever acquired the marker by accident (an operator declaring staging with the target
    // variable mis-set), the target check passes for a swapped pair FOREVER and nothing notices. Read
    // the marker from the other side: a legitimate source is production, and production has no marker.
    const swapped = { ...VALID, sourceMarkerPresent: true };
    expect(codes(decideRefresh(swapped).refusals)).toEqual([REFUSAL.SOURCE_IS_STAGING]);
    expect(decideRefresh(swapped).refusals[0].reason).toMatch(/swapped/);
  });

  it("REFUSES when the SOURCE marker is unreadable — unknown is a refusal on both sides", () => {
    expect(codes(decideRefresh({ ...VALID, sourceMarkerPresent: null }).refusals)).toEqual([
      REFUSAL.MARKER_UNKNOWN,
    ]);
  });

  it("excludes the FK-dependent CLOSURE of every excluded table, transitively", () => {
    // Excluding a parent's data while dumping a child's is not a subset — it is a restore that fails at
    // constraint creation. Measured: gateway_connections has three dependents and gateway_approvals
    // hangs off one of THEM, so a one-level check reported clean until the three were added.
    expect(missingFkClosure(ALL_SQL)).toEqual([]);
  });

  it("is NON-VACUOUS about the closure: dropping one dependent reports it", () => {
    const partial = EXCLUDED_TABLE_DATA.filter((t) => t !== "gateway_executions");
    expect(missingFkClosure(ALL_SQL, partial)).toContain("gateway_executions");
    expect(fkDependents(ALL_SQL, "gateway_connections")).toContain("gateway_executions");
  });

  it("does not claim a dependency that is not there", () => {
    // graph_episodes deliberately has NO foreign key to items (docs/OPS.md §10 depends on that), so a
    // scanner reporting one would be inventing edges.
    expect(fkDependents(ALL_SQL, "graph_episodes")).toEqual([]);
  });
});

describe("staging-refresh — the decision CLI cannot approve by silence (criterion 22)", () => {
  it("refuses from a symlinked path and a path containing a space", () => {
    // VERIFIED as a live bug before it was fixed: the entry guard compared `file://${process.argv[1]}`
    // to import.meta.url, so from /tmp (a symlink to /private/tmp) or a directory with a space, main()
    // never ran — no output, exit 0 — and the shell reads exit 0 as approval. Realpath BOTH sides:
    // pathToFileURL alone fixes only the percent-encoding half.
    const dir = mkdtempSync(join(tmpdir(), "staging refresh guard "));
    const copy = join(dir, "decision.mjs");
    copyFileSync(join(ROOT, "scripts", "staging-refresh-decision.mjs"), copy);
    const res = spawnSync(process.execPath, [copy, "preflight", "--source", "", "--target", ""], {
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/REFUSED/);
    expect(res.stdout).not.toContain(DECISION_ACK);
  });

  it("prints a positive ack when it allows, and the shell REQUIRES that ack", () => {
    const res = spawnSync(
      process.execPath,
      [
        join(ROOT, "scripts", "staging-refresh-decision.mjs"),
        "preflight",
        "--source",
        "postgresql://a.example/db",
        "--target",
        "postgresql://b.example/db",
      ],
      { encoding: "utf8" }
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(DECISION_ACK);
    // The shell must not treat exit 0 alone as approval — silence is the failure this pins.
    const script = shellCode(SCRIPT);
    expect(script).toContain(DECISION_ACK);
    expect(script).toMatch(/produced no verdict/);
    // …and every decision call goes through the ack-checking wrapper, not bare `node "$DECIDE"`.
    const bare = [...script.matchAll(/^\s*node "\$DECIDE" (preflight|check)/gm)];
    expect(bare).toEqual([]);
  });
});

describe("staging-refresh — what the SCRIPT may and may not contain (criteria 6, 8, 9, 11, 14)", () => {
  const code = shellCode(SCRIPT);

  it("has no DEFAULT for either connection URL", () => {
    // `${VAR:-}` — an EMPTY fallback — is required under `set -u` so the refusal can be printed with
    // its explanation. A non-empty default is the thing being forbidden: a default source is a second
    // silent opinion about which database production is, and a default target is what gets destroyed.
    for (const name of ["STAGING_REFRESH_SOURCE_URL", "STAGING_REFRESH_TARGET_URL"]) {
      const defaults = [...code.matchAll(new RegExp(`\\$\\{${name}:-([^}]*)\\}`, "g"))].map((m) => m[1]);
      expect(defaults.length).toBeGreaterThan(0); // it IS read — otherwise this test guards nothing
      expect(defaults.every((d) => d.trim() === "")).toBe(true);
      // `:=` ASSIGNS a default and would sail past the check above, which only reads the `:-` form.
      expect(code).not.toMatch(new RegExp(`\\$\\{${name}:=`));
    }
  });

  it("never passes the pg_restore flag that would recreate the database", () => {
    // `--create` drops and recreates the target database, which takes the staging marker with it —
    // and the marker is the only thing distinguishing a legal target from production.
    expect(code).not.toMatch(/--create\b/);
    expect(code).not.toMatch(/\s-C\b/); // the short spelling does the same thing and read as clean
  });

  it("uses exactly the restore flags docs/OPS.md §Restore documents", () => {
    expect(code).toMatch(/--clean\s+--if-exists\s+--no-owner/);
    const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
    expect(ops).toContain("--clean --if-exists --no-owner");
  });

  it("replays the schema from a plain shell, NOT through the Railway CLI", () => {
    // `scripts/pg-load-schema.mjs` calls assertServiceIdentity before it connects: off-Railway that
    // no-ops, but under `railway run` it REFUSES, because Railway injects a non-AIOS service name.
    // docs/OPS.md §Restore says to use a Railway shell and is wrong for this case.
    expect(code).toMatch(/run pg:schema/);
    expect(code).not.toMatch(/railway\s+run/);
  });

  it("performs NO Railway mutation of any kind", () => {
    // Not variables, not deploys. A script that can set variables can point staging at production —
    // and the obvious future convenience edit ("have it set the staging flags for you") is exactly
    // the one this forbids.
    expect(code).not.toMatch(/\brailway\b/);
  });

  it("never sets a mail provider", () => {
    for (const name of ["RESEND_API_KEY", "SMTP_URL"]) {
      expect(code).not.toMatch(new RegExp(`${name}\\s*=`));
    }
  });

  it("uses no bash-4-only builtin — the operator's macOS shell is bash 3.2 (criterion 15)", () => {
    // `mapfile` was the first spelling of the exclusion-argument read, and on bash 3.2 it does not
    // exist — so the script would have aborted at the DUMP step, i.e. after connecting to production,
    // with a "command not found". Same shape as the pg_dump major-version trap: a toolchain fact that
    // turns a correct design into a runbook nobody trusts. Verified: /usr/bin/env bash here is 3.2.57.
    for (const builtin of [/\bmapfile\b/, /\breadarray\b/, /declare\s+-A\b/, /\$\{[A-Za-z_]+,,\}/]) {
      expect(code).not.toMatch(builtin);
    }
  });

  it("REFUSES rather than dumping everything if the exclusion list comes back empty", () => {
    // Fail-closed on the one output whose emptiness is indistinguishable from "nothing to exclude":
    // an empty list is a valid-looking `pg_dump` invocation that copies every reversible-secret table.
    expect(code).toMatch(/EXCLUDE_ARGS\[@\]\}\s*-eq\s*0/);
    expect(code).toMatch(/REFUSED: the exclusion list came back EMPTY/);
  });

  it("removes the dump on every exit path", () => {
    // The dump holds prod items, member emails and api-key hashes. Left in /tmp it is a copy of
    // production with no expiry, created by a script whose whole subject is not leaking production.
    expect(code).toMatch(/trap cleanup EXIT/);
    expect(code).toMatch(/rm -f "\$DUMP_FILE"/);
  });

  it("prints a completion message naming the hazard AND the refusal that now closes it (STGENV-3)", () => {
    // This guard used to assert the message called the hazard one "no code here can close". Code here
    // does close it now, so the assertion moved with the behaviour rather than being left pinning a
    // sentence that is no longer true — a guard that outlives its claim is how a doc quietly starts
    // lying while the build stays green.
    const msg = completionMessage();
    expect(msg).toMatch(/GRAPHITI_URL/);
    expect(msg).toMatch(/graph_episodes is empty/);
    expect(msg).toMatch(/bill real extraction/);
    // The refusal, and the ONE variable that lifts it — an operator who hits the refusal with no way
    // past it is a worse outcome than the hazard was.
    expect(msg).toMatch(/REFUSED/);
    expect(msg).toMatch(/GRAPH_PROJECT_WINDOW_DAYS/);
    // ...and no promise of a default, which is the whole point of there not being one.
    expect(msg).not.toMatch(/default(s)? to \d/i);
    expect(code).toMatch(/completion/); // and the script actually prints it
  });
});

describe("staging-refresh — the durable marker and the runbook (criteria 7, 13)", () => {
  it("fails the build if staging_marker ever enters the schema or a migration", () => {
    // The marker survives `pg_restore --clean` only because the archive does not contain it. The day
    // it ships to prod it enters the dump, the restore drops it, and the refusal above silently stops
    // protecting anything. Keyed on the INVARIANT (absent from what prod runs), not on a filename.
    expect(SCHEMA).not.toMatch(new RegExp(`\\b${STAGING_MARKER_TABLE}\\b`));
    expect(MIGRATIONS).not.toMatch(new RegExp(`\\b${STAGING_MARKER_TABLE}\\b`));
  });

  it("keeps docs/OPS.md's staging variable table in step with the script's declared list", () => {
    // A DOCUMENTATION-DRIFT guard, and labelled as one: the real state lives in Railway, so the
    // runbook also requires a `railway variables` read-back. What this catches is a variable quietly
    // dropping out of the prose while the design still depends on it.
    const ops = readFileSync(join(ROOT, "docs", "OPS.md"), "utf8");
    const section = ops.slice(ops.indexOf("## 11. Staging refresh"));
    // Parse EVERY env-var row, not only the well-formed ones. A Map built from matches alone can
    // equal the declared set while a second, contradictory row for the same variable sits beside it —
    // the human reads the wrong one and the guard is still green.
    // `[A-Z0-9_]+`, with the digits: the first spelling of this pattern was `[A-Z_]+` and silently
    // skipped `NEO4J_URL` — the row's absence read as agreement rather than as drift.
    const rows = [...section.matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|([^|]*)\|/gm)].map((m) => ({
      name: m[1],
      expected: m[2].trim(),
    }));
    expect(rows.length).toBe(STAGING_VARIABLES.length);
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...new Set(names)]); // no variable documented twice
    for (const row of rows) {
      expect(["unset", "`false`"]).toContain(row.expected); // no free-text expectation
    }
    const documented = new Map(rows.map((r) => [r.name, r.expected === "unset" ? "unset" : "false"]));
    const declared = new Map(STAGING_VARIABLES.map((v) => [v.name, v.expected]));
    expect([...documented.entries()].sort()).toEqual([...declared.entries()].sort());
  });

  it("declares GRAPHITI_URL unset — the boundary, not GRAPH_PROJECT_ENABLED", () => {
    // GRAPH_PROJECT_ENABLED=false gates the interval poller only; the admin action and the
    // graph-window battery script both call runGraphProjection directly. Unsetting GRAPHITI_URL is
    // what makes all three inert, which `lib/graph/run.test.ts` pins behaviourally.
    const graphiti = STAGING_VARIABLES.find((v) => v.name === "GRAPHITI_URL");
    expect(graphiti?.expected).toBe("unset");
    const flag = STAGING_VARIABLES.find((v) => v.name === "GRAPH_PROJECT_ENABLED");
    expect(flag?.expected).toBe("false");
  });
});
