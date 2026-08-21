import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXCLUDED_TABLE_DATA,
  REFUSAL,
  STAGING_MARKER_TABLE,
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

/** Every .ts/.tsx file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

/** An input that violates NOTHING — the baseline every single-layer test perturbs by exactly one field. */
const VALID = Object.freeze({
  sourceUrl: "postgresql://u:p@prod-proxy.rlwy.net:33781/railway",
  targetUrl: "postgresql://u:p@staging-proxy.rlwy.net:41999/railway",
  markerPresent: true,
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
    // `integrations.secret_ciphertext` is added this way in the real schema. A scanner that only read
    // create-table bodies would miss it and pass, while copying live connector credentials.
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
    const hits = sourceFiles(join(ROOT, "lib"))
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
    const sameHost = { ...VALID, targetUrl: "postgresql://u:p@prod-proxy.rlwy.net:33781/railway" };
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
    const allBad = { sourceUrl: "", targetUrl: "", markerPresent: null, clientMajor: 14, serverMajor: 18 };
    expect(codes(decideRefresh(allBad).refusals)).toEqual(
      [REFUSAL.MISSING_SOURCE, REFUSAL.MISSING_TARGET, REFUSAL.MARKER_UNKNOWN, REFUSAL.PG_CLIENT_TOO_OLD].sort()
    );
  });

  it("keeps the connected layers reachable on their own", () => {
    expect(codes(refusalsForConnected({ markerPresent: true, clientMajor: 14, serverMajor: 18 }))).toEqual([
      REFUSAL.PG_CLIENT_TOO_OLD,
    ]);
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
    }
  });

  it("never passes the pg_restore flag that would recreate the database", () => {
    // `--create` drops and recreates the target database, which takes the staging marker with it —
    // and the marker is the only thing distinguishing a legal target from production.
    expect(code).not.toMatch(/--create\b/);
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

  it("prints a completion message naming the hazard no code here can close", () => {
    const msg = completionMessage();
    expect(msg).toMatch(/GRAPHITI_URL/);
    expect(msg).toMatch(/graph_episodes is empty/);
    expect(msg).toMatch(/bill real extraction/);
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
    const documented = new Map<string, string>();
    // `[A-Z0-9_]+`, with the digits: the first spelling of this pattern was `[A-Z_]+` and silently
    // skipped `NEO4J_URL` — the row's absence read as agreement rather than as drift. The
    // exact-set comparison below is what turned that into a failure instead of a quiet pass.
    for (const m of section.matchAll(/^\|\s*`([A-Z0-9_]+)`\s*\|\s*(unset|`false`)\s*\|/gm)) {
      documented.set(m[1], m[2] === "unset" ? "unset" : "false");
    }
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
