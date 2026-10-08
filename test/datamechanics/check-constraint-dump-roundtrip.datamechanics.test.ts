import { Client } from "pg";
import { describe, expect, it } from "vitest";

/**
 * SPEC: a staging refresh replays a `pg_dump` of the source, then compares the INSTALLED catalog's
 * fingerprint against the digest the bundle declared (scripts/staging-ops/build-identity.mjs,
 * `assertInstalledSchemaMatches`). `pg_dump` writes every CHECK as `pg_get_constraintdef` TEXT and the
 * restore RE-PARSES that text, so a constraint whose deparsed text does not survive its own reparse makes
 * the installed catalog differ from the source's — and the refresh refuses.
 *
 * The concrete way to write one: a `BETWEEN` on the LEFT of an `AND` (`length(x) between 8 and 128 and
 * x !~ '...'`). Analysis expands BETWEEN into a nested `(a AND b)` that the outer AND keeps nested, the
 * dump prints it, and the reparse sees an explicit AND on the left and FLATTENS it to `a AND b AND c`.
 * It reads identically to a human, so only a catalog-level check can see it — and the paired-refresh CI
 * job did, on the Slack lease-owner constraints (PR 714), which staging did not yet have.
 *
 * So this walks EVERY CHECK constraint in `public` rather than the two that failed: the property is about
 * the schema, and the next nested BETWEEN would otherwise ship green and fail only a refresh.
 */
describe("CHECK constraints survive a dump → restore reparse", () => {
  it("deparses every public CHECK to identical text after re-parsing it", async () => {
    const raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    try {
      await raw.query("begin");
      const { rows: checks } = await raw.query<{ tbl: string; conname: string; def: string }>(`
        select c.relname as tbl, k.conname, pg_get_constraintdef(k.oid) as def
          from pg_constraint k
          join pg_class c on c.oid = k.conrelid
          join pg_namespace n on n.oid = c.relnamespace
         where k.contype = 'c' and n.nspname = 'public' and c.relkind = 'r'
         order by c.relname, k.conname
      `);
      // Non-vacuity: a schema this size with an empty walk would pass without checking anything.
      expect(checks.length).toBeGreaterThan(50);

      const divergent: string[] = [];
      let probe = 0;
      for (const { tbl, conname, def } of checks) {
        const scratch = `rt_probe_${probe++}`;
        // Same columns and types, none of the constraints: the only CHECK on the scratch table is the
        // one being re-parsed from its own deparsed text, exactly as restore would.
        await raw.query(`create temp table ${scratch} (like public."${tbl}")`);
        await raw.query(`alter table ${scratch} add constraint rt_probe ${def}`);
        const { rows } = await raw.query<{ def: string }>(
          `select pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = '${scratch}'::regclass and conname = 'rt_probe'`,
        );
        if (rows[0]?.def !== def) divergent.push(`${tbl}.${conname}\n    dumped:   ${def}\n    reparsed: ${rows[0]?.def}`);
      }

      expect(divergent, `CHECKs whose text changes when a dump is restored:\n${divergent.join("\n")}`).toEqual([]);
    } finally {
      await raw.query("rollback").catch(() => undefined);
      await raw.end();
    }
  });
});
