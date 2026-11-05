import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveMigrationSql,
  effectiveReplayPlan,
  gitBlobId,
  REPLAY_PLAN_VERSION,
  REPLAY_STEP_SUPERSESSIONS,
  REPLAY_SUPERSESSIONS,
  replayStepMarker,
  SUPERSESSION_MARKER,
} from "../../scripts/migration-replay-plan.mjs";

/**
 * The replay-supersession contract (`scripts/migration-replay-plan.mjs`).
 *
 * Spec. `pg:schema` replays every migration on every deploy. Six shipped migrations re-add an
 * enumerated CHECK with the value set of their own write date; AIO-1167 widened both constraints
 * (`integrations.type` gained `gdrive`, `project_context_memberships.method` gained
 * `gdrive_claim`). Replaying the shipped files verbatim would reject the first live row using a new
 * value and abort the release — and editing them, the old remedy, rewrites history a deployed
 * database was built from.
 *
 * So: the shipped files stay byte-identical, and the effective plan omits ONLY their obsolete
 * CHECK statements. Everything asserted here follows from those two sentences:
 *   1. history is pinned — the six files are exactly the blobs staging shipped;
 *   2. the omission is exact — the obsolete statements go, every other statement stays;
 *   3. the plan fails CLOSED — with the owner in the replay, a changed file, a misordered owner, or
 *      an owner that no longer defines the constraint throws instead of replaying something nobody
 *      reviewed. (A set WITHOUT the owner is a historical release state and replays verbatim.);
 *   4. the deploy loader and the upgrade lane both execute this plan, not the raw files.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MIG_DIR = join(ROOT, "postgres", "migrations");

const SHIPPED = [
  ["20260624120000_ai_provider_integration_types.sql", "3ea048a1d704be9e1a498497664140e39b664478"],
  ["20260710140000_integrations_openrouter_type.sql", "9969210286f77337874392f5bfc997b9e6c381ca"],
  ["20260711160000_publishing.sql", "df904104accb01a48688a40b22f1dc6922e054b4"],
  ["20260725160000_integrations_notion_type.sql", "9210c61e92cce6d8e24c90cb7bc9e16624639087"],
  ["20260817090000_integrations_clickup_type.sql", "8a35a8befbd9062c99a63a77b871aa64561bdf21"],
  ["20260820150000_pcm_method_exclude_shadow_repair.sql", "903eb2afd4ccc5470f67d40b5de117c0520d2801"],
] as const;

const read = (name: string): string => readFileSync(join(MIG_DIR, name), "utf8");

function rawMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: read(f) }));
}

/** Statements with comments and blank lines dropped — "what would run", for exact comparison. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("replay plan: shipped history is pinned", () => {
  it("is contract version 1 and covers exactly the six shipped migrations", () => {
    expect(REPLAY_PLAN_VERSION).toBe(1);
    expect(REPLAY_SUPERSESSIONS.map((entry) => [entry.migration, entry.gitBlob])).toEqual(SHIPPED.map((s) => [...s]));
  });

  it.each(SHIPPED)("%s is byte-identical to the blob staging shipped", (name, blob) => {
    // The pin is the git blob id, so it can be checked against history directly:
    //   git rev-parse c5e832c2:postgres/migrations/<name>
    expect(gitBlobId(read(name)), `${name} was edited — widen in a new migration instead`).toBe(blob);
  });

  it("gitBlobId is git's own blob hash, not a lookalike", () => {
    // `git hash-object` of the empty file and of "hello\n" — fixed points anyone can reproduce.
    expect(gitBlobId("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobId("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it.each(SHIPPED)("%s still contains its obsolete definition exactly once", (name) => {
    const sql = read(name);
    for (const entry of REPLAY_SUPERSESSIONS.filter((e) => e.migration === name)) {
      expect(sql.split(entry.obsoleteSql)).toHaveLength(2);
      // …and that text really is a narrower definition of the named constraint.
      expect(entry.obsoleteSql).toContain(`add constraint ${entry.constraint}`);
      expect(entry.obsoleteSql).not.toMatch(/'gdrive'|'gdrive_claim'/);
    }
  });
});

describe("replay plan: the omission is exact", () => {
  it.each(SHIPPED)("%s replays every statement except the obsolete CHECK", (name) => {
    const raw = read(name);
    const { sql, superseded } = effectiveMigrationSql(name, raw);
    expect(superseded).toHaveLength(1);
    const removed = statements(superseded[0].obsoleteSql);
    expect(removed).toHaveLength(2); // the drop and the re-add, nothing more
    const before = statements(raw);
    const after = statements(sql);
    expect(after).toEqual(before.filter((s) => !removed.includes(s)));
    expect(before.length - after.length).toBe(2);
    expect(sql).toContain(SUPERSESSION_MARKER);
    expect(sql).not.toMatch(new RegExp(`add constraint ${superseded[0].constraint}`, "i"));
    expect(sql).not.toMatch(new RegExp(`drop constraint if exists ${superseded[0].constraint}`, "i"));
  });

  it("the mixed-purpose publishing migration keeps its column and table", () => {
    const { sql } = effectiveMigrationSql("20260711160000_publishing.sql", read("20260711160000_publishing.sql"));
    expect(sql).toContain("alter table social_settings add column if not exists publish_dry_run");
    expect(sql).toContain("create table if not exists social_publications");
    expect(sql).toContain("create index if not exists social_publications_variant_idx");
    // Its OTHER enumerated check (the publication status, inline in the create table) is untouched.
    expect(sql).toContain("check (status in ('scheduled', 'publishing', 'published', 'failed', 'cancelled'))");
  });

  it("a migration with no supersession is returned unchanged, by identity", () => {
    const owner = "20260922090000_integrations_gdrive_type.sql";
    const raw = read(owner);
    const { sql, superseded } = effectiveMigrationSql(owner, raw);
    expect(sql).toBe(raw);
    expect(superseded).toEqual([]);
  });

  it("the real plan changes exactly the six files (and the one data-step file) and leaves each constraint with one definer", () => {
    const raw = rawMigrations();
    const plan = effectiveReplayPlan(raw);
    expect(plan.map((step) => step.name)).toEqual(raw.map((m) => m.name)); // nothing skipped, order kept
    const changed = plan.filter((step, i) => step.sql !== raw[i].sql).map((step) => step.name);
    expect(changed).toEqual([...SHIPPED.map(([name]) => name), ...REPLAY_STEP_SUPERSESSIONS.map((e) => e.migration)]);
    for (const constraint of ["integrations_type_check", "project_context_memberships_method_check"]) {
      const definers = plan.filter((step) => new RegExp(`add\\s+constraint\\s+${constraint}\\b`, "i").test(step.sql));
      expect(definers.map((step) => step.name), `${constraint} must replay from its owner alone`).toHaveLength(1);
    }
  });
});

describe("replay plan: fails closed (mutants)", () => {
  const pcm = "20260820150000_pcm_method_exclude_shadow_repair.sql";
  const owner = "20260922130000_gdrive_audience_claims.sql";
  const entry = REPLAY_SUPERSESSIONS.find((e) => e.migration === pcm)!;
  /** A two-file replay with a caller-supplied manifest, so each rule is mutated in isolation. */
  const shippedSql = `-- shipped\n${entry.obsoleteSql}\ncreate index if not exists keep_me on t (c);\n`;
  const ownerSql = "alter table project_context_memberships add constraint project_context_memberships_method_check\n  check (method in ('a','gdrive_claim'));\n";
  const manifest = [{ ...entry, migration: "001_shipped.sql", gitBlob: gitBlobId(shippedSql), supersededBy: "002_owner.sql" }];
  const set = (shipped = shippedSql, owned = ownerSql) => [
    { name: "001_shipped.sql", sql: shipped },
    { name: "002_owner.sql", sql: owned },
  ];

  it("the unmutated fixture is accepted (so each refusal below is the mutation's doing)", () => {
    const plan = effectiveReplayPlan(set(), manifest);
    expect(plan[0].sql).toContain("create index if not exists keep_me");
    expect(plan[0].sql).not.toContain("add constraint");
    expect(plan[1].sql).toBe(ownerSql);
  });

  it("an EDITED shipped migration is refused, even when the edit is the 'helpful' widening", () => {
    const widened = shippedSql.replace("'exclude_shadow_repair'", "'exclude_shadow_repair','gdrive_claim'");
    expect(() => effectiveReplayPlan(set(widened), manifest)).toThrow(/has changed .* immutable/);
  });

  it("obsolete text that is absent, or present twice, is refused rather than passed through", () => {
    const twice = `${shippedSql}${entry.obsoleteSql}\n`;
    const twiceManifest = [{ ...manifest[0], gitBlob: gitBlobId(twice) }];
    expect(() => effectiveReplayPlan(set(twice), twiceManifest)).toThrow(/exactly once \(found 2\)/);
    const absent = "-- shipped\ncreate index if not exists keep_me on t (c);\n";
    const absentManifest = [{ ...manifest[0], gitBlob: gitBlobId(absent) }];
    expect(() => effectiveReplayPlan(set(absent), absentManifest)).toThrow(/exactly once \(found 0\)/);
  });

  it("a HISTORICAL set — one that predates the owner — replays verbatim and is not pin-checked", () => {
    // The production loader is also handed prior release states (scripts/debt-intake-migration-proof.mjs
    // feeds one through it). Their files differ across history and have no owner to defer to, so the
    // supersession is not in force there: refusing them would break every upgrade proof.
    const [shipped] = set();
    expect(effectiveReplayPlan([shipped], manifest)).toEqual([{ name: shipped.name, sql: shippedSql, superseded: [] }]);
    const earlier = { name: shipped.name, sql: "-- an earlier revision of the same file\nselect 1;\n" };
    expect(effectiveReplayPlan([earlier], manifest)).toEqual([{ ...earlier, superseded: [] }]);
    // The real manifest, the real files, minus their owners: all six replay exactly as shipped.
    const withoutOwners = rawMigrations().filter((m) => !REPLAY_SUPERSESSIONS.some((e) => e.supersededBy === m.name));
    const plan = effectiveReplayPlan(withoutOwners);
    expect(plan.map((step) => step.sql)).toEqual(withoutOwners.map((m) => m.sql));
    expect(plan.every((step) => step.superseded.length === 0)).toBe(true);
  });

  it("…but with the owner present the same edited file IS refused (the pin is in force)", () => {
    const earlier = "-- an earlier revision of the same file\nselect 1;\n";
    expect(() => effectiveReplayPlan(set(earlier), manifest)).toThrow(/has changed .* immutable/);
  });

  it("an owner that sorts BEFORE the superseded file is refused", () => {
    const early = [{ ...manifest[0], supersededBy: "000_owner.sql" }];
    const reordered = [{ name: "000_owner.sql", sql: ownerSql }, set()[0]];
    expect(() => effectiveReplayPlan(reordered, early)).toThrow(/must replay AFTER/);
  });

  it("an owner that no longer (re-)adds the constraint is refused", () => {
    expect(() => effectiveReplayPlan(set(shippedSql, "select 1;\n"), manifest)).toThrow(/does not \(re-\)add/);
  });

  it("an owner that is itself superseded for the same constraint is refused", () => {
    const ownerShipped = `${entry.obsoleteSql}\n`;
    const chained = [
      manifest[0],
      { ...entry, migration: "002_owner.sql", gitBlob: gitBlobId(ownerShipped), supersededBy: "003_newer.sql" },
    ];
    const three = [set()[0], { name: "002_owner.sql", sql: ownerShipped }, { name: "003_newer.sql", sql: ownerSql }];
    expect(() => effectiveReplayPlan(three, chained)).toThrow(/is itself superseded/);
  });

  it("the real owners exist, sort after every file they supersede, and carry the widened value", () => {
    const names = rawMigrations().map((m) => m.name);
    for (const e of REPLAY_SUPERSESSIONS) {
      expect(names).toContain(e.supersededBy);
      expect(names.indexOf(e.supersededBy)).toBeGreaterThan(names.indexOf(e.migration));
      const widened = e.constraint === "integrations_type_check" ? "'gdrive'" : "'gdrive_claim'";
      expect(read(e.supersededBy)).toContain(widened);
    }
    expect(owner).toBe(entry.supersededBy);
  });
});

/**
 * DATA-STEP supersession (AIO-1167, paired staging restore).
 *
 * Spec. `20260922130000_gdrive_audience_claims.sql` fails legacy Drive visibility closed by
 * deleting "every Drive item's context unit whose item has no active claim". A sanitized staging
 * restore does not carry the claim tables, so on that database the statement selects EVERY copied
 * Drive unit and the schema replay deleted the claim-authorized memberships of every copied
 * document. The replay plan omits that one selection (with nothing selected, the rest of the block
 * is inert) and `20260922135000_gdrive_legacy_context_suppression.sql` owns the step with a
 * predicate that:
 *   · never reads a claim table — so it means the same thing with or without them;
 *   · still selects every LEGACY unit (active, never placed by a claim) — fail-closed adoption;
 *   · never selects a unit a claim placed, nor a retracted (pending-cleanup) one.
 * The real-Postgres proof is the populated replay in `scripts/migrate-from-existing.mjs` and
 * `test/datamechanics/gdrive-paired-restore.datamechanics.test.ts`.
 */
describe("replay plan: a superseded data step", () => {
  const [entry] = REPLAY_STEP_SUPERSESSIONS;
  const raw = () => read(entry.migration);
  const owner = () => read(entry.supersededBy);

  it("is exactly one step, pinned to the file as it stands", () => {
    expect(REPLAY_STEP_SUPERSESSIONS).toHaveLength(1);
    expect(entry).toMatchObject({
      migration: "20260922130000_gdrive_audience_claims.sql",
      step: "gdrive_legacy_context_suppression",
      supersededBy: "20260922135000_gdrive_legacy_context_suppression.sql",
    });
    expect(gitBlobId(raw()), `${entry.migration} was edited — change the step in its owner instead`).toBe(entry.gitBlob);
    expect(raw().split(entry.obsoleteSql)).toHaveLength(2);
    // The obsolete statement is the claim-dependent selection, and nothing else.
    expect(statements(entry.obsoleteSql)).toHaveLength(1);
    expect(entry.obsoleteSql).toContain("gdrive_item_claims");
    expect(entry.obsoleteSql).toMatch(/^insert into gdrive_suppressed_units/);
  });

  it("omits that one statement and replays every other statement of the file, CHECK included", () => {
    const { sql, superseded } = effectiveMigrationSql(entry.migration, raw());
    expect(superseded).toEqual([entry]);
    const removed = statements(entry.obsoleteSql);
    expect(statements(sql)).toEqual(statements(raw()).filter((s) => !removed.includes(s)));
    expect(statements(raw()).length - statements(sql).length).toBe(1);
    expect(sql).toContain(`${SUPERSESSION_MARKER} ${entry.step}`);
    // It is still the owner of the widened method CHECK, and still creates its tables.
    expect(sql).toContain("'exclude_shadow_repair','gdrive_claim'");
    expect(sql).toContain("create table if not exists gdrive_item_claims");
    // With nothing selected the destructive delete in that file has nothing to delete.
    expect(sql).toContain("create temp table gdrive_suppressed_units");
    expect(sql).not.toContain("insert into gdrive_suppressed_units");
  });

  it("its claimed-tier update is replay-idempotent: only a row whose tier DIFFERS is written, under the unchanged active same-team claim condition", () => {
    // This file replays on every deploy. Unpredicated, the update rewrote every claimed item each
    // time — a new `updated_at` and row version for unchanged content, which every
    // `updated_at`-based incremental pull then re-emits.
    const tierUpdate = "update items i set access='external', updated_at=now() "
      + "where i.access is distinct from 'external' "
      + "and exists (select 1 from gdrive_item_claims c where c.team_id=i.team_id and c.item_id=i.id and c.active)";
    const itemUpdates = (sql: string) => statements(sql).filter((s) => /^update (public\.)?items\b/.test(s));
    expect(itemUpdates(raw())).toEqual([tierUpdate]);
    // The supersession removes the legacy selection and nothing of this statement.
    expect(itemUpdates(effectiveMigrationSql(entry.migration, raw()).sql)).toEqual([tierUpdate]);
    // No other statement of the file writes `items`, so nothing else can re-date a claimed row.
    expect(statements(raw()).filter((s) => /\b(insert into|delete from)\s+(public\.)?items\b/.test(s))).toEqual([]);
  });

  it("the owner declares the step, replays after it, and never reads a claim table", () => {
    const names = rawMigrations().map((m) => m.name);
    expect(names.indexOf(entry.supersededBy)).toBeGreaterThan(names.indexOf(entry.migration));
    expect(owner()).toContain(`-- ${replayStepMarker(entry.step)}`);
    const executable = statements(owner()).join(";\n");
    expect(executable).not.toMatch(/gdrive_item_claims|gdrive_item_claim_projects|gdrive_connection_authority|\bintegrations\b/);
    // Legacy = an ACTIVE Drive unit no claim ever placed. Both halves are load-bearing.
    expect(executable).toContain("i.frontmatter->>'source'='gdrive'");
    expect(executable).toContain("u.state='active'");
    expect(executable).toMatch(/not exists \( select 1 from project_context_memberships m where [^)]*m\.method='gdrive_claim' \)/);
    expect(executable).toContain("delete from project_context_units u where u.id in (select unit_id from gdrive_legacy_units)");
    // The suppression still owns the epoch/cache barrier for the teams it touched.
    expect(executable).toContain("update team_authorization_epochs e set epoch=e.epoch+1");
    expect(executable).toContain("delete from arc_cache");
    expect(executable).toContain("delete from work_timeline_cache");
  });

  describe("fails closed (mutants)", () => {
    const stepSql = `-- carrier\n${entry.obsoleteSql}\ncreate index if not exists keep_me on t (c);\n`;
    const ownerSql = `-- ${replayStepMarker(entry.step)}\nselect 1;\n`;
    const manifest = [{ ...entry, migration: "001_step.sql", gitBlob: gitBlobId(stepSql), supersededBy: "002_owner.sql" }];
    const set = (carrier = stepSql, owned = ownerSql) => [
      { name: "001_step.sql", sql: carrier },
      { name: "002_owner.sql", sql: owned },
    ];

    it("the unmutated fixture is accepted", () => {
      const plan = effectiveReplayPlan(set(), manifest);
      expect(plan[0].sql).not.toContain("insert into gdrive_suppressed_units");
      expect(plan[0].sql).toContain("create index if not exists keep_me");
      expect(plan[1].sql).toBe(ownerSql);
    });

    it("an owner that does not declare the step is refused", () => {
      expect(() => effectiveReplayPlan(set(stepSql, "select 1;\n"), manifest)).toThrow(/does not declare ownership of gdrive_legacy_context_suppression/);
    });

    it("an owner that sorts before the carrier is refused", () => {
      const early = [{ ...manifest[0], supersededBy: "000_owner.sql" }];
      expect(() => effectiveReplayPlan([{ name: "000_owner.sql", sql: ownerSql }, set()[0]], early)).toThrow(/must replay AFTER/);
    });

    it("an edited carrier is refused, and a carrier without the statement is refused", () => {
      expect(() => effectiveReplayPlan(set(`${stepSql}-- touched\n`), manifest)).toThrow(/has changed .* immutable/);
      const absent = "-- carrier\ncreate index if not exists keep_me on t (c);\n";
      expect(() => effectiveReplayPlan(set(absent), [{ ...manifest[0], gitBlob: gitBlobId(absent) }])).toThrow(/exactly once \(found 0\)/);
    });

    it("a set WITHOUT the owner is a historical release state: the carrier replays verbatim", () => {
      const historical = rawMigrations().filter((m) => m.name !== entry.supersededBy);
      const step = effectiveReplayPlan(historical).find((s) => s.name === entry.migration)!;
      expect(step.sql).toBe(raw());
      expect(step.superseded).toEqual([]);
    });
  });
});

describe("replay plan: both replay paths execute it", () => {
  // Source pins, because a plan nothing calls is the failure this repo keeps re-learning: delete the
  // call from the loader and every assertion above stays green while the deploy replays raw history.
  const loader = readFileSync(join(ROOT, "scripts", "pg-load-schema.mjs"), "utf8");
  const lane = readFileSync(join(ROOT, "scripts", "migrate-from-existing.mjs"), "utf8");

  it("pg-load-schema.mjs executes plan steps, and no longer queries a raw migration file", () => {
    expect(loader).toContain('import { effectiveReplayPlan } from "./migration-replay-plan.mjs"');
    expect(loader).toMatch(/const plan = effectiveReplayPlan\(/);
    expect(loader).toMatch(/for \(const step of plan\) \{\s*await client\.query\(step\.sql\);/);
    expect(loader).not.toMatch(/client\.query\(readFile\(path\.join\(migDir/);
  });

  it("migrate-from-existing.mjs builds currentSources from the same plan", () => {
    expect(lane).toContain('import { effectiveReplayPlan, REPLAY_STEP_SUPERSESSIONS, REPLAY_SUPERSESSIONS } from "./migration-replay-plan.mjs"');
    expect(lane).toMatch(/export function currentSources\(\) \{\s*const raw = currentRawSources\(\);[\s\S]*?effectiveReplayPlan\(raw\.migrations\)/);
  });

  it("the lane runs the populated replay with the upgrades, including its negative control", () => {
    expect(lane).toMatch(/const r = await runPopulatedReplay\(priorRef, opts\)/);
    expect(lane).toMatch(/refused\.code !== "23514"/);
    // The rows come from a test fixture (the single-writer guard forbids substrate DML in scripts/),
    // and the fixture really does use BOTH widened values — otherwise the replay proves nothing.
    expect(lane).toContain('path.join(ROOT, "test", "fixtures", "migration-replay-populated.sql")');
    const fixture = readFileSync(join(ROOT, "test", "fixtures", "migration-replay-populated.sql"), "utf8");
    expect(fixture).toMatch(/insert into integrations \(team_id, type, name\)\s+select id, 'gdrive'/);
    expect(fixture).toMatch(/insert into project_context_memberships[\s\S]*'gdrive_claim'/);
    // …and the three Drive context shapes the data-step supersession is about, with no claim rows:
    // a claim-placed unit, a legacy generic one, and a retracted pending-cleanup one.
    expect(fixture.match(/"source":"gdrive"/g)).toHaveLength(3);
    expect(fixture).toMatch(/'ingestion_project'/);
    expect(fixture).toMatch(/'retracted'/);
    expect(fixture).not.toMatch(/gdrive_item_claims/);
    expect(lane).toMatch(/for \(const entry of REPLAY_STEP_SUPERSESSIONS\) \{[\s\S]*?await client\.query\(raw\.get\(entry\.migration\)\);[\s\S]*?await client\.query\("rollback"\)/);
    expect(lane).toMatch(/drive\.claimed !== 1 \|\| drive\.legacy !== 0 \|\| drive\.retracted !== 1/);
  });

  it("the loader, given the real tree, sends the effective SQL to the database", async () => {
    // Behavioural, not textual: run the real loader against a recording client and read what it sent.
    const { loadSchema } = await import("../../scripts/pg-load-schema.mjs");
    const sent: string[] = [];
    const client = { query: async (sql: string) => { sent.push(sql); return { rows: [] }; }, connect: async () => {}, end: async () => {} };
    await loadSchema({
      cwd: ROOT,
      databaseUrl: "postgres://unused/unused",
      env: {},
      createClient: () => client,
      logger: { log: () => {} },
    });
    const replayed = sent.join("\n");
    for (const e of [...REPLAY_SUPERSESSIONS, ...REPLAY_STEP_SUPERSESSIONS]) expect(replayed).not.toContain(e.obsoleteSql);
    expect(sent.filter((sql) => sql.includes(SUPERSESSION_MARKER))).toHaveLength(6 + REPLAY_STEP_SUPERSESSIONS.length);
    // The data step reached the database from its replay-safe owner, after the file it supersedes.
    const superseding = sent.findIndex((sql) => sql.includes("insert into gdrive_legacy_units(unit_id,team_id)"));
    const superseded = sent.findIndex((sql) => sql.includes("create temp table gdrive_suppressed_units"));
    expect(superseded).toBeGreaterThan(-1);
    expect(superseding).toBeGreaterThan(superseded);
    expect(replayed).toContain("'notion','gdrive','clickup'");
    expect(replayed).toContain("'exclude_shadow_repair','gdrive_claim'");
    // The mixed-purpose migration's other statements reached the database.
    expect(replayed).toContain("alter table social_settings add column if not exists publish_dry_run");
  });
});
