import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * BUILD-FAILING GUARD: `graph_episodes.first_seen_at` exists in BOTH `schema.sql` and a migration.
 *
 * This is the failure it prevents, and it is silent in the worst possible way. `schema.sql` is
 * `create table if not exists`, so editing the table body is a **no-op on a database that already has
 * the table** (`postgres/migrations/README.md`). Meanwhile the data-mechanics tier and CI both load
 * from ZERO — `npm run db:test:up` — so a column added only to `schema.sql` is present in every test
 * and absent in prod.
 *
 * The consequence here is not a missing column: `readLedger` selects `min(first_seen_at)`, so on prod
 * the statement would ERROR, the read would return `unreadable`, and the whole extraction probe would
 * go permanently quiet — with every test green, and nothing anywhere saying the alarm had stopped
 * working. That is precisely the self-disarming class this probe was built to end, arriving through
 * its own deploy. Found by spec review (STALLSCOPE-1 draft 2) rather than in prod, which is the point.
 *
 * Pinned as a NAME + DEFINITION match rather than by running a database, so it fails in the unit tier
 * where the cost of the mistake is a red build instead of a dead alarm.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COLUMN = "first_seen_at";
const TABLE = "graph_episodes";

describe(`guard: ${TABLE}.${COLUMN} is in schema.sql AND a migration`, () => {
  const schema = readFileSync(path.join(ROOT, "postgres", "schema.sql"), "utf8");
  const migrationsDir = path.join(ROOT, "postgres", "migrations");
  // SQL comments stripped before matching: review pointed out that a migration consisting only of a
  // COMMENTED-OUT `alter table … add column` satisfied both assertions below, which is the
  // "satisfiable by a comment about the thing" failure this repo keeps hitting. The prose in these
  // files is long and deliberate, so this is not hypothetical.
  const stripSql = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: stripSql(readFileSync(path.join(migrationsDir, f), "utf8")) }));

  it("schema.sql declares the column inside the graph_episodes table body", () => {
    const start = schema.indexOf(`create table if not exists ${TABLE} (`);
    expect(start, `${TABLE} is gone from schema.sql — this guard is stale, not passing`).toBeGreaterThan(-1);
    const body = schema
      .slice(start, schema.indexOf("\n);", start))
      .replace(/--[^\n]*/g, ""); // same reason as the migrations: a comment must not satisfy this
    expect(body).toContain(COLUMN);
    // The DEFAULT is what makes it set-once-able: the row-creating INSERT never names the column, so
    // without a default it would be null on every new row and the age gate would never arm.
    expect(body).toMatch(new RegExp(`${COLUMN}\\s+timestamptz\\s+not null\\s+default\\s+now\\(\\)`, "i"));
  });

  it("a migration adds it to an EXISTING database — the half prod actually depends on", () => {
    const adds = migrations.filter((m) =>
      new RegExp(`alter\\s+table\\s+${TABLE}\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+${COLUMN}`, "i").test(m.sql)
    );
    expect(
      adds.map((m) => m.file),
      `no migration adds ${TABLE}.${COLUMN}; schema.sql alone is a NO-OP on prod's existing table, ` +
        `so the ledger read would error there and the stall probe would go silently dead`
    ).not.toEqual([]);
  });

  it("the migration's definition matches schema.sql's, so from-zero and catch-up agree", () => {
    const add = migrations.find((m) => m.sql.includes(`add column if not exists ${COLUMN}`));
    expect(add).toBeDefined();
    // Same type, same nullability, same default. A migration that says `timestamptz` while schema.sql
    // says `timestamptz not null default now()` gives a from-zero DB and a caught-up DB two different
    // shapes — and the dm tier, which only ever loads from zero, would never notice.
    expect(add!.sql).toMatch(new RegExp(`${COLUMN}\\s+timestamptz\\s+not null\\s+default\\s+now\\(\\)`, "i"));
    // Replay-safe: every migration file re-runs on every deploy.
    expect(add!.sql).toContain("add column if not exists");
  });
});

/**
 * SET-ONCE, guarded at the write sites (review L5).
 *
 * The data-mechanics tier proves the column survives the writes that exist TODAY. It cannot prove a
 * future payload won't start naming it — and the whole contract is "no write path names this column",
 * which is a property of the source, not of a run. Same shape as the repo's other single-writer guards.
 *
 * `reconcile.ts` is in scope for a second reason: it used to DELETE a never-landed row, which destroyed
 * the clock by destroying the row. It now parks the row on the `''` sentinel instead, and this scan is
 * what would catch a revert to `delete()` on that path.
 */
describe(`guard: no production write path names ${COLUMN}`, () => {
  const SCAN = ["lib", "app", "scripts"];
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) files.push(full);
    }
  };
  for (const d of SCAN) walk(path.join(ROOT, d));

  it("no insert/upsert/update payload and no raw SQL sets it", () => {
    const offenders = files
      .map((f) => ({ rel: path.relative(ROOT, f), src: readFileSync(f, "utf8") }))
      // The producer READS it; that is the point. Everything else must not write it.
      .filter((f) => f.rel !== path.join("lib", "graph", "extraction-health.ts"))
      .filter(
        (f) =>
          new RegExp(`\\.\\s*(insert|upsert|update)\\s*\\(\\s*\\{[^)]*${COLUMN}`, "s").test(f.src) ||
          new RegExp(`set\\s+${COLUMN}`, "i").test(f.src)
      )
      .map((f) => f.rel);
    expect(
      offenders,
      `these write ${COLUMN}, which breaks the set-once contract the stall probe's age gate rests on: ` +
        offenders.join(", ")
    ).toEqual([]);
  });

  it("reconcile re-queues by parking on the sentinel, not by deleting the row", () => {
    // Deleting destroys the row identity and with it the clock — during a dead-extractor outage this
    // path recycles rows every grace window, so each re-creation re-stamped `first_seen_at`. Detection
    // survived only on an accident of the defaults (the re-queue cap being below the episode floor),
    // and raising that cap is the DOCUMENTED response to throttling, which a dead extractor produces.
    const src = readFileSync(path.join(ROOT, "lib", "graph", "reconcile.ts"), "utf8");
    expect(src).not.toMatch(/from\("graph_episodes"\)\s*\n?\s*\.delete\(\)\s*\n?\s*\.eq\("id", row\.id\);\s*\n\s*reQueued\+\+/);
    expect(src).toContain('.update({ content_sha256: "" }).eq("id", row.id);');
  });
});
