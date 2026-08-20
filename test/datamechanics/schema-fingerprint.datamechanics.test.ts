import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
// @ts-expect-error — pure-node .mjs helper (no tsx in the deploy image), no .d.ts by design.
import { fingerprint, diffFingerprints } from "../../scripts/schema-fingerprint.mjs";

/**
 * Non-vacuity guard for the catalog fingerprint that `scripts/migrate-from-existing.mjs` compares.
 *
 * The whole migrate-from-existing lane is exactly as trustworthy as this fingerprint: if it silently
 * failed to read enum ORDER, or constraints BY NAME, the lane would be green while blind — which is
 * the same failure the lane exists to fix, one level up. So each thing the fingerprint claims to
 * cover is proved here to actually move the fingerprint when it changes.
 *
 * Enum sort order is called out specifically: `order by status` reads `enumsortorder`, not the
 * label text, so two enums with the same labels in a different order are NOT the same database.
 * Constraint names are called out because the static scan this lane replaces never looked at them,
 * and missed `members_kind_check` and `projects_kind_check` entirely.
 */
async function inScratchSchema(run: (client: Client, schema: string) => Promise<void>) {
  const client = new Client({ connectionString: process.env.DATABASE_TEST_URL });
  const schema = `fp_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}"`);
    await run(client, schema);
  } finally {
    await client.query(`drop schema if exists "${schema}" cascade`);
    await client.end();
  }
}

const find = (lines: string[], prefix: string) => lines.filter((l: string) => l.startsWith(prefix));

describe("schema fingerprint", () => {
  it("reads columns, named constraints, indexes and enum labels in enum sort order", async () => {
    await inScratchSchema(async (client, schema) => {
      await client.query(`create type fp_status as enum ('backlog','ready','done')`);
      await client.query(`create table fp_items (
        id uuid primary key default gen_random_uuid(),
        title text not null,
        status fp_status not null default 'backlog',
        note text,
        constraint fp_items_title_check check (length(title) > 0))`);
      await client.query(`create index fp_items_status_idx on fp_items (status)`);

      const fp = await fingerprint(client, schema);

      expect(find(fp, "column\tfp_items.title")).toEqual([
        "column\tfp_items.title\ttext null=false default=- identity=- generated=- collation=default",
      ]);
      // Nullability and defaults are part of the shape, not decoration.
      expect(find(fp, "column\tfp_items.note")[0]).toContain("null=true");
      expect(find(fp, "column\tfp_items.status")[0]).toContain("default='backlog'::fp_status");
      // BY NAME — the gap that let two CHECK constraints hide from the previous static scan.
      expect(find(fp, "constraint\tfp_items.fp_items_title_check")).toHaveLength(1);
      expect(find(fp, "index\tfp_items.fp_items_status_idx")).toHaveLength(1);
      expect(find(fp, "enum\tfp_status")).toEqual(["enum\tfp_status\tbacklog,ready,done"]);
    });
  });

  it("distinguishes two enums whose labels match but whose SORT ORDER does not", async () => {
    let ordered = "";
    let reordered = "";
    await inScratchSchema(async (client, schema) => {
      await client.query(`create type fp_order as enum ('a','c')`);
      await client.query(`alter type fp_order add value 'b' after 'c'`);
      ordered = find(await fingerprint(client, schema), "enum\tfp_order")[0];
    });
    await inScratchSchema(async (client, schema) => {
      await client.query(`create type fp_order as enum ('a','c')`);
      await client.query(`alter type fp_order add value 'b' before 'c'`);
      reordered = find(await fingerprint(client, schema), "enum\tfp_order")[0];
    });
    expect(ordered).toBe("enum\tfp_order\ta,c,b");
    expect(reordered).toBe("enum\tfp_order\ta,b,c");
    expect(ordered).not.toBe(reordered); // same label SET, different database
  });

  it("ignores physical column order, because a migration can only append", async () => {
    // schema.sql writes a column in its natural place; `alter table … add column` puts it last.
    // Both are correct, so attnum must not be part of the fingerprint — otherwise the lane would
    // report a false difference on literally every additive migration and be useless.
    let declared: string[] = [];
    let appended: string[] = [];
    await inScratchSchema(async (client, schema) => {
      await client.query(`create table fp_cols (a int, b int, c int)`);
      declared = find(await fingerprint(client, schema), "column\tfp_cols.");
    });
    await inScratchSchema(async (client, schema) => {
      await client.query(`create table fp_cols (a int, c int)`);
      await client.query(`alter table fp_cols add column b int`);
      appended = find(await fingerprint(client, schema), "column\tfp_cols.");
    });
    expect(appended).toEqual(declared);
  });

  it("diffFingerprints names the object that moved, in both directions", async () => {
    await inScratchSchema(async (client, schema) => {
      await client.query(`create table fp_diff (id int)`);
      const before = await fingerprint(client, schema);
      await client.query(`alter table fp_diff add column added_later text not null default 'x'`);
      await client.query(`alter table fp_diff drop column id`);
      const after = await fingerprint(client, schema);

      const { missing, extra } = diffFingerprints(before, after);
      expect(missing.some((l: string) => l.startsWith("column\tfp_diff.id"))).toBe(true);
      expect(extra.some((l: string) => l.startsWith("column\tfp_diff.added_later"))).toBe(true);
      // …and an unchanged database produces no diff at all (the assertion the lane relies on).
      expect(diffFingerprints(after, after)).toMatchObject({ missing: [], extra: [] });
    });
  });
});
